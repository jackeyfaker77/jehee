// Core runtime host for Jehee: manages storage lifecycle, the single-entry root conversation, busy-turn steering,
// crash recovery, and hot-swappable memory providers on top of pi-durable.

import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	type ConversationId,
	createRegistry,
	type Extension,
	Harness,
	MemoryStorage,
	type ModelRef,
	type Registry,
	type Storage,
	type Submission,
	type SubmissionId,
	UserEntry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createMemoryExtension } from "../memory/bridge.ts";
import { extractAssistantText, extractUserText, type MemoryProvider } from "../memory/contract.ts";

/** Storage backend configuration for JeheeHost. */
export type JeheeStorageConfig = { readonly kind: "memory" } | { readonly kind: "sqlite"; readonly path: string };

/** Construction options for opening a JeheeHost instance. */
export type JeheeHostOptions = {
	readonly storage: JeheeStorageConfig;
	readonly models: Models;
	readonly defaultModel: ModelRef;
	readonly instructions?: string;
	readonly memory?: MemoryProvider;
	readonly extensions?: readonly Extension[];
	readonly cwd?: string;
};

/** Inbound user message delivered to the single-entry root conversation. */
export type JeheeSendInput = {
	readonly text: string;
	readonly requestId?: string;
	readonly whenBusy?: "steer" | "followUp" | "reject";
};

/** Settled outcome of a submitted user turn. */
export type JeheeTurnReply =
	| {
			readonly submissionId: SubmissionId;
			readonly status: "done";
			readonly replyText: string;
	  }
	| {
			readonly submissionId: SubmissionId;
			readonly status: "unanswered";
			readonly reason: string;
	  };

/** Handle for an admitted turn that may still be queued or executing. */
export type JeheePendingTurn = {
	readonly submissionId: SubmissionId;
	wait(context: Context): Promise<JeheeTurnReply>;
	abort(context: Context): Promise<"aborted" | "already_placed" | "settled">;
};

/** Simplified user-visible dialogue entry projected from the immutable transcript. */
export type JeheeHistoryItem = {
	readonly role: "user" | "assistant";
	readonly text: string;
};

/** Always-on personal colleague host wrapping a durable Session and its root conversation. */
export class JeheeHost {
	readonly #harness: Harness;
	readonly #registry: Registry;
	readonly #root: Conversation;
	#memoryProvider: MemoryProvider | undefined;

	private constructor(
		harness: Harness,
		registry: Registry,
		root: Conversation,
		memoryProvider: MemoryProvider | undefined,
	) {
		this.#harness = harness;
		this.#registry = registry;
		this.#root = root;
		this.#memoryProvider = memoryProvider;
	}

	/** Opens storage, installs extensions and memory, initializes or reattaches the root conversation, and resumes pending tasks. */
	static async open(options: JeheeHostOptions, context: Context): Promise<JeheeHost> {
		const storage: Storage =
			options.storage.kind === "memory" ? new MemoryStorage() : await openNodeSqliteStorage(options.storage.path);
		const registry = createRegistry();
		for (const ext of options.extensions ?? []) {
			registry.install(ext);
		}
		if (options.memory !== undefined) {
			registry.install(createMemoryExtension(options.memory));
		}
		const defaultCwd = options.cwd ?? process.cwd();
		const harness = await Harness.open(
			storage,
			{
				models: options.models,
				registry,
				env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? defaultCwd }),
				settings: {
					followUpMode: "all",
					steeringMode: "all",
				},
			},
			context,
		);
		const root = await harness.root(context, {
			agent: {
				model: options.defaultModel,
				instructions: options.instructions,
				cwd: options.cwd,
			},
		});
		await root.configure(
			{
				model: options.defaultModel,
				...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
				...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			},
			context,
		);
		harness.resume();
		return new JeheeHost(harness, registry, root, options.memory);
	}

	/** Identifier of the single-entry root conversation. */
	get rootConversationId(): ConversationId {
		return this.#root.id;
	}

	/** Currently mounted memory provider, if any. */
	get memoryProvider(): MemoryProvider | undefined {
		return this.#memoryProvider;
	}

	/** Hot-swaps the active MemoryProvider in place without dropping conversation history or restarting the host. */
	setMemoryProvider(provider: MemoryProvider): void {
		this.#memoryProvider = provider;
		this.#registry.install(createMemoryExtension(provider));
	}

	/** Durably admits a user message (or returns the existing submission on matching `requestId`) without blocking on completion. */
	async submitMessage(input: JeheeSendInput, context: Context): Promise<JeheePendingTurn> {
		const submission: Submission = await this.#root.submit(
			{
				type: "input",
				content: input.text,
				...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
				...(input.whenBusy !== undefined ? { whenBusy: input.whenBusy } : {}),
			},
			context,
		);
		return {
			submissionId: submission.id,
			wait: async (waitCtx: Context): Promise<JeheeTurnReply> => {
				const settled = await submission.wait(waitCtx);
				if (settled.status === "done" && settled.type === "input") {
					const answerEntry = await this.#root.commit((tx) => tx.entry(AssistantEntry, settled.answer), waitCtx);
					const modelMsg = answerEntry?.model?.[0];
					const replyText = modelMsg?.role === "assistant" ? extractAssistantText(modelMsg) : "";
					return {
						submissionId: submission.id,
						status: "done",
						replyText,
					};
				}
				return {
					submissionId: submission.id,
					status: "unanswered",
					reason: settled.status === "unanswered" ? settled.reason : "unexpected_submission_type",
				};
			},
			abort: (abortCtx: Context) => submission.abort(abortCtx),
		};
	}

	/** Admits a user message and waits for the turn's final answer. */
	async sendMessage(input: JeheeSendInput, context: Context): Promise<JeheeTurnReply> {
		const pending = await this.submitMessage(input, context);
		return pending.wait(context);
	}

	/** Projects visible user and final assistant messages from the active context in chronological order. */
	async getVisibleHistory(context: Context): Promise<readonly JeheeHistoryItem[]> {
		const view = await this.#root.context(context);
		const history: JeheeHistoryItem[] = [];
		for (const entry of view.entries) {
			const firstMsg = entry.model?.[0];
			if (UserEntry.is(entry) && firstMsg?.role === "user") {
				history.push({ role: "user", text: extractUserText(firstMsg) });
			} else if (AssistantEntry.is(entry) && firstMsg?.role === "assistant" && firstMsg.stopReason === "stop") {
				history.push({ role: "assistant", text: extractAssistantText(firstMsg) });
			}
		}
		return history;
	}

	/** Waits until the root conversation and its foreground tasks are completely idle (including afterRun hooks). */
	async waitForIdle(context: Context): Promise<void> {
		await this.#root.waitForIdle(context);
	}

	/** Closes the underlying Harness and releases storage locks cleanly. */
	async close(context: Context): Promise<void> {
		await this.#harness.close(context);
	}
}
