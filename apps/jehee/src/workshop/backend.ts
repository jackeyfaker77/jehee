// Portable execution backend contract for Jehee's Workshop plus the remote InstaBox implementation (100% Web/Edge safe).

import { posix } from "node:path";
import type { InstaBoxClient } from "./instabox-client.ts";
import type { ProvisionedWorkspace, ProvisionWorkspaceRequest, WorkshopProvisioner } from "./provisioner.ts";

/** Directory inside a Workshop worktree holding detached job PID/log/exit files (excluded from Git summaries). */
export const WORKSHOP_META_DIR = ".jehee-workshop";

/** Handle persisted in durable task state for a running background Coding Agent CLI job. */
export type StartedWorkshopJob = {
	readonly jobId: string;
	readonly pid?: number;
};

/** Status returned when polling a detached Coding Agent CLI job. */
export type WorkshopJobPollResult =
	| { readonly state: "running" }
	| {
			readonly state: "finished";
			readonly exitCode: number;
			readonly stdout: string;
			readonly stderr: string;
	  };

/** Request to start a detached non-interactive Coding Agent CLI job inside `workspace`. */
export type StartWorkshopJobRequest = {
	readonly jobId: string;
	readonly argv: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
};

/** Cross-platform Workshop execution backend (implemented by remote `InstaBoxWorkshopBackend` and Node `LocalWorktreeBackend`). */
export interface WorkshopExecutionBackend {
	readonly kind: "instabox" | "local";
	prepareWorkspace(request: ProvisionWorkspaceRequest): Promise<ProvisionedWorkspace>;
	cleanupWorkspace(workspace: ProvisionedWorkspace, idempotencyKey: string): Promise<void>;
	startJob(workspace: ProvisionedWorkspace, request: StartWorkshopJobRequest): Promise<StartedWorkshopJob>;
	pollJob(workspace: ProvisionedWorkspace, job: StartedWorkshopJob): Promise<WorkshopJobPollResult>;
	stopJob(workspace: ProvisionedWorkspace, job: StartedWorkshopJob): Promise<void>;
	inspectGitSummary(workspace: ProvisionedWorkspace): Promise<string | undefined>;
}

/** Filters internal `.jehee-workshop` entries out of `git status --short` output. */
export function filterGitStatusShortLines(rawStatus: string): string[] {
	return rawStatus
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0 && !line.includes(WORKSHOP_META_DIR));
}

/** Formats deterministic `git status --short` and `git diff --stat` output for main-agent verification. */
export function buildGitSummaryBlock(params: {
	readonly branchName?: string;
	readonly statusShort: string;
	readonly diffStat: string;
}): string {
	const statusLines = filterGitStatusShortLines(params.statusShort);
	const cleanDiff = params.diffStat.trim();
	const header = params.branchName ? `[git verification | branch=${params.branchName}]` : "[git verification]";
	if (statusLines.length === 0 && cleanDiff.length === 0) {
		return `${header}\nworking tree clean (0 uncommitted file changes)`;
	}
	const parts = [header];
	if (statusLines.length > 0) {
		parts.push(statusLines.slice(0, 40).join("\n"));
	}
	if (cleanDiff.length > 0) {
		parts.push(cleanDiff);
	}
	return parts.join("\n");
}

const SAFE_JOB_ID = /^[a-zA-Z0-9._-]+$/;

function resolveRemoteJobDir(cwd: string, jobId: string): string {
	if (!SAFE_JOB_ID.test(jobId)) {
		throw new Error(`Invalid workshop jobId "${jobId}"`);
	}
	return posix.join(cwd, WORKSHOP_META_DIR, jobId);
}

/** Remote InstaBox implementation of `WorkshopExecutionBackend` (pure `fetch`, Cloudflare Workers compatible). */
export class InstaBoxWorkshopBackend implements WorkshopExecutionBackend {
	readonly kind = "instabox" as const;
	readonly #client: InstaBoxClient;
	readonly #provisioner: WorkshopProvisioner;
	readonly #defaultRepoPath: string | undefined;

	constructor(options: {
		readonly client: InstaBoxClient;
		readonly provisioner: WorkshopProvisioner;
		readonly defaultRepoPath?: string;
	}) {
		this.#client = options.client;
		this.#provisioner = options.provisioner;
		this.#defaultRepoPath = options.defaultRepoPath;
	}

	/** Underlying `InstaBoxClient` (used when `driver === "builtin"` mounts legacy `sandbox-tools`). */
	get client(): InstaBoxClient {
		return this.#client;
	}

	async prepareWorkspace(request: ProvisionWorkspaceRequest): Promise<ProvisionedWorkspace> {
		const effectiveRepo = request.repoPath?.trim() || this.#defaultRepoPath;
		return this.#provisioner.prepareWorkspace({
			...request,
			...(effectiveRepo !== undefined ? { repoPath: effectiveRepo } : {}),
		});
	}

	async cleanupWorkspace(workspace: ProvisionedWorkspace, idempotencyKey: string): Promise<void> {
		await this.#provisioner.cleanupWorkspace(workspace, idempotencyKey);
	}

	async startJob(workspace: ProvisionedWorkspace, request: StartWorkshopJobRequest): Promise<StartedWorkshopJob> {
		const machine = await this.#client.ensureRunning(workspace.machineId, `start-job:${request.jobId}`);
		const jobDir = resolveRemoteJobDir(workspace.cwd, request.jobId);
		// Pass target argv strictly via OS positional parameters ($3..$N -> "$@") to eliminate shell-quoting hazards.
		const launchScript = [
			'JDIR="$1"',
			'JCWD="$2"',
			"shift 2",
			'mkdir -p "$JDIR"',
			'(cd "$JCWD" && "$@" >"$JDIR/stdout.log" 2>"$JDIR/stderr.log"; EC=$?; printf "%s" "$EC" >"$JDIR/exit.tmp" && mv "$JDIR/exit.tmp" "$JDIR/exit.code") </dev/null >/dev/null 2>&1 &',
			"JPID=$!",
			'printf "%s" "$JPID" >"$JDIR/pid"',
			'printf "%s" "$JPID"',
		].join("; ");

		const res = await this.#client.exec(machine.id, {
			argv: ["sh", "-c", launchScript, "jehee-launch", jobDir, workspace.cwd, ...request.argv],
			cwd: workspace.cwd,
			...(request.env !== undefined ? { envs: request.env } : {}),
		});
		if (res.exitCode !== 0) {
			throw new Error(`Failed to launch workshop CLI job "${request.jobId}": ${res.stderr || res.stdout}`);
		}
		const parsedPid = Number.parseInt(res.stdout.trim(), 10);
		return {
			jobId: request.jobId,
			...(Number.isInteger(parsedPid) && parsedPid > 0 ? { pid: parsedPid } : {}),
		};
	}

	async pollJob(workspace: ProvisionedWorkspace, job: StartedWorkshopJob): Promise<WorkshopJobPollResult> {
		const machine = await this.#client.ensureRunning(workspace.machineId, `poll-job:${job.jobId}`);
		const jobDir = resolveRemoteJobDir(workspace.cwd, job.jobId);
		const checkRes = await this.#client.exec(machine.id, {
			argv: [
				"sh",
				"-c",
				'if [ -f "$1/exit.code" ]; then cat "$1/exit.code"; else printf "RUNNING"; fi',
				"jehee-poll",
				jobDir,
			],
		});
		const marker = checkRes.stdout.trim();
		if (marker === "RUNNING" || marker.length === 0) {
			return { state: "running" };
		}
		const exitCode = Number.parseInt(marker, 10);
		const [outRes, errRes] = await Promise.all([
			this.#client.exec(machine.id, {
				argv: ["sh", "-c", 'tail -c 24576 "$1/stdout.log" 2>/dev/null || true', "jehee-out", jobDir],
			}),
			this.#client.exec(machine.id, {
				argv: ["sh", "-c", 'tail -c 12288 "$1/stderr.log" 2>/dev/null || true', "jehee-err", jobDir],
			}),
		]);
		return {
			state: "finished",
			exitCode: Number.isInteger(exitCode) ? exitCode : 1,
			stdout: outRes.stdout,
			stderr: errRes.stdout,
		};
	}

	async stopJob(workspace: ProvisionedWorkspace, job: StartedWorkshopJob): Promise<void> {
		const machine = await this.#client.ensureRunning(workspace.machineId, `stop-job:${job.jobId}`);
		const jobDir = resolveRemoteJobDir(workspace.cwd, job.jobId);
		const pidArg = job.pid !== undefined ? String(job.pid) : "";
		await this.#client.exec(machine.id, {
			argv: [
				"sh",
				"-c",
				'if [ -n "$1" ]; then kill -TERM -"$1" "$1" 2>/dev/null || true; fi; if [ ! -f "$2/exit.code" ]; then printf "143" >"$2/exit.code"; fi',
				"jehee-stop",
				pidArg,
				jobDir,
			],
		});
	}

	async inspectGitSummary(workspace: ProvisionedWorkspace): Promise<string | undefined> {
		if (workspace.repoPath === undefined) return undefined;
		const machine = await this.#client.ensureRunning(workspace.machineId, `git-summary:${workspace.cwd}`);
		const [statusRes, diffRes] = await Promise.all([
			this.#client.exec(machine.id, {
				argv: ["git", "-C", workspace.cwd, "status", "--short", "--untracked-files=normal"],
			}),
			this.#client.exec(machine.id, {
				argv: ["git", "-C", workspace.cwd, "diff", "--stat"],
			}),
		]);
		if (statusRes.exitCode !== 0) return undefined;
		return buildGitSummaryBlock({
			...(workspace.branchName !== undefined ? { branchName: workspace.branchName } : {}),
			statusShort: statusRes.stdout,
			diffStat: diffRes.stdout,
		});
	}
}
