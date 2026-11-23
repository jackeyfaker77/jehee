// Zero-dependency Web-standard client for InstaBox OpenAPI v1 (https://api.instabox.sh/v1), compatible with both
// Cloudflare Workers and Node 24.

/** Sandbox lifecycle state reported by InstaBox `Machine.state`. */
export type InstaBoxMachineState =
	| "creating"
	| "starting"
	| "running"
	| "stopping"
	| "stopped"
	| "suspending"
	| "suspended"
	| "resuming"
	| "deleting"
	| "deleted"
	| "error";

/** Subset of InstaBox's `Machine` resource consumed by Jehee's workshop layer. */
export type InstaBoxMachine = {
	readonly id: string;
	readonly name?: string;
	readonly state: InstaBoxMachineState;
	readonly operationId?: string | null;
};

/** Progress state of an asynchronous InstaBox lifecycle `Operation`. */
export type InstaBoxOperationState = "queued" | "running" | "succeeded" | "failed";

/** InstaBox `Operation` resource returned by `start`, `resume`, `suspend`, and `GET /v1/operations/{id}`. */
export type InstaBoxOperation = {
	readonly id: string;
	readonly machineId: string;
	readonly state: InstaBoxOperationState;
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
	} | null;
};

/** Command execution payload for `POST /v1/machines/{id}/exec`. */
export type InstaBoxExecRequest =
	| {
			readonly cmd: string;
			readonly argv?: never;
			readonly cwd?: string;
			readonly envs?: Readonly<Record<string, string>>;
			readonly timeoutSeconds?: number;
	  }
	| {
			readonly argv: readonly string[];
			readonly cmd?: never;
			readonly cwd?: string;
			readonly envs?: Readonly<Record<string, string>>;
			readonly timeoutSeconds?: number;
	  };

/** Result returned by `POST /v1/machines/{id}/exec`. */
export type InstaBoxExecResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly timedOut: boolean;
	readonly truncated: boolean;
	readonly oomKilled?: boolean;
};

/** Construction options for `InstaBoxClient`. */
export type InstaBoxClientOptions = {
	readonly apiKey: string;
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
	readonly operationWaitParam?: string;
	readonly maxOperationPolls?: number;
};

/** Pure `fetch` client for managing and driving an InstaBox Linux sandbox. */
export class InstaBoxClient {
	readonly #apiKey: string;
	readonly #baseUrl: string;
	readonly #fetch: typeof fetch;
	readonly #waitParam: string;
	readonly #maxPolls: number;

	constructor(options: InstaBoxClientOptions) {
		this.#apiKey = options.apiKey;
		this.#baseUrl = (options.baseUrl ?? "https://api.instabox.sh").replace(/\/+$/, "");
		// Wrap fetch so Cloudflare Workers `globalThis.fetch` is never invoked with `InstaBoxClient` as `this`.
		const customFetch = options.fetchImpl;
		this.#fetch =
			customFetch !== undefined
				? (input, init) => customFetch(input, init)
				: (input, init) => globalThis.fetch(input, init);
		this.#waitParam = options.operationWaitParam ?? "10s";
		this.#maxPolls = options.maxOperationPolls ?? 30;
	}

	/** Fetches the current metadata and lifecycle state of `machineId`. */
	async getMachine(machineId: string): Promise<InstaBoxMachine> {
		const res = await this.#request(`/v1/machines/${encodeURIComponent(machineId)}`, { method: "GET" });
		return (await res.json()) as InstaBoxMachine;
	}

	/** Resumes a paused (`suspended`) sandbox with an idempotency key. */
	async resumeMachine(machineId: string, idempotencyKey: string): Promise<InstaBoxOperation> {
		const res = await this.#request(`/v1/machines/${encodeURIComponent(machineId)}/resume`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": idempotencyKey,
			},
			body: "{}",
		});
		return (await res.json()) as InstaBoxOperation;
	}

	/** Starts a `stopped` (or `suspended`) sandbox with an idempotency key. */
	async startMachine(machineId: string, idempotencyKey: string): Promise<InstaBoxOperation> {
		const res = await this.#request(`/v1/machines/${encodeURIComponent(machineId)}/start`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": idempotencyKey,
			},
			body: "{}",
		});
		return (await res.json()) as InstaBoxOperation;
	}

	/** Polls an operation until it reaches `succeeded` or throws on `failed`. */
	async waitOperation(operationId: string): Promise<InstaBoxOperation> {
		for (let poll = 0; poll < this.#maxPolls; poll++) {
			const res = await this.#request(
				`/v1/operations/${encodeURIComponent(operationId)}?wait=${encodeURIComponent(this.#waitParam)}`,
				{ method: "GET" },
			);
			const op = (await res.json()) as InstaBoxOperation;
			if (op.state === "succeeded") return op;
			if (op.state === "failed") {
				throw new Error(
					`InstaBox operation ${operationId} failed: ${op.error?.code ?? "unknown"} ${op.error?.message ?? ""}`.trim(),
				);
			}
		}
		throw new Error(`InstaBox operation ${operationId} timed out after ${this.#maxPolls} polls`);
	}

	/**
	 * Ensures `machineIdOrName` is in the `running` state, transparently resolving human machine names (e.g. `"achi"`)
	 * to their canonical `m_...` ID before issuing `resume` / `start` mutations (which require canonical IDs).
	 */
	async ensureRunning(machineIdOrName: string, idempotencyPrefix: string): Promise<InstaBoxMachine> {
		const current = await this.getMachine(machineIdOrName);
		const canonicalId = current.id;
		if (current.state === "running") return current;
		if (current.state === "suspended") {
			const op = await this.resumeMachine(canonicalId, `${idempotencyPrefix}:resume`);
			if (op.state !== "succeeded") await this.waitOperation(op.id);
			return this.getMachine(canonicalId);
		}
		if (current.state === "stopped") {
			const op = await this.startMachine(canonicalId, `${idempotencyPrefix}:start`);
			if (op.state !== "succeeded") await this.waitOperation(op.id);
			return this.getMachine(canonicalId);
		}
		if ((current.state === "starting" || current.state === "resuming") && current.operationId) {
			await this.waitOperation(current.operationId);
			return this.getMachine(canonicalId);
		}
		throw new Error(`InstaBox machine ${canonicalId} cannot be woken from state "${current.state}"`);
	}

	/** Executes a shell command or argv program inside a running sandbox. */
	async exec(machineId: string, request: InstaBoxExecRequest): Promise<InstaBoxExecResult> {
		const res = await this.#request(`/v1/machines/${encodeURIComponent(machineId)}/exec`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		});
		return (await res.json()) as InstaBoxExecResult;
	}

	/** Downloads a UTF-8 text file via `GET /v1/machines/{id}/files/content`. */
	async readFileText(machineId: string, absolutePath: string): Promise<string> {
		const res = await this.#request(
			`/v1/machines/${encodeURIComponent(machineId)}/files/content?path=${encodeURIComponent(absolutePath)}`,
			{ method: "GET" },
		);
		return res.text();
	}

	/** Atomically writes a UTF-8 text file via `PUT /v1/machines/{id}/files?parents=true`. */
	async writeFileText(machineId: string, absolutePath: string, content: string): Promise<void> {
		await this.#request(
			`/v1/machines/${encodeURIComponent(machineId)}/files?path=${encodeURIComponent(absolutePath)}&parents=true`,
			{
				method: "PUT",
				headers: { "content-type": "application/octet-stream" },
				body: new TextEncoder().encode(content),
			},
		);
	}

	async #request(pathAndQuery: string, init: RequestInit): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set("x-api-key", this.#apiKey);
		const res = await this.#fetch(`${this.#baseUrl}${pathAndQuery}`, {
			...init,
			headers,
		});
		if (!res.ok) {
			const detail = await res.text();
			throw new Error(`InstaBox API ${init.method ?? "GET"} ${pathAndQuery} failed (${res.status}): ${detail}`);
		}
		return res;
	}
}
