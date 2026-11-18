// Core runtime host for Jehee: manages storage lifecycle, the single-entry root conversation, busy-turn steering,
// crash recovery, and hot-swappable memory providers on top of pi-durable. Kept 100% Web/Edge portable (no node:sqlite
// or child_process imports) so the exact same class powers both Node 24 and Cloudflare Workers Durable Objects.

import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	type ConversationId,
	createRegistry,
	type EntryId,
	type Extension,
	Harness,
	type HarnessOptions,
	LiveDoc,
	MemoryStorage,
	type ModelRef,
	type Registry,
	type Storage,
	type Submission,
	type SubmissionId,
	UsageDoc,
	UserEntry,
	type Wake,
} from "@earendil-works/pi-durable";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { JeheeMcpOptions } from "../mcp/contract.ts";
import { createMcpBundle } from "../mcp/extension.ts";
import { McpConnectorHub } from "../mcp/hub.ts";
import { createMemoryExtension } from "../memory/bridge.ts";
import { extractAssistantText, extractUserText, type MemoryProvider } from "../memory/contract.ts";
import { createWorkshopBundle, type WorkshopBundle, WorkshopRegistryDoc } from "../workshop/extension.ts";
import type { InstaBoxClient } from "../workshop/instabox-client.ts";
import type { WorkshopProvisioner } from "../workshop/provisioner.ts";

/** Portable storage backend configuration for JeheeHost. */
export type JeheeStorageConfig = { readonly kind: "memory" } | { readonly kind: "custom"; readonly storage: Storage };

/** Optional cloud workshop configuration attached to JeheeHost. */
export type JeheeWorkshopOptions = {
	readonly client: InstaBoxClient;
	readonly provisioner: WorkshopProvisioner;
};

/** Construction options for opening a JeheeHost instance. */
export type JeheeHostOptions = {
	readonly storage: JeheeStorageConfig;
	readonly models: Models;
	readonly defaultModel: ModelRef;
	readonly instructions?: string;
	readonly memory?: MemoryProvider;
	readonly mcp?: JeheeMcpOptions;
	readonly workshop?: JeheeWorkshopOptions;
	readonly extensions?: readonly Extension[];
	readonly telemetry?: TelemetryContext;
	readonly cwd?: string;
	readonly env?: HarnessOptions["env"];
	readonly now?: () => number;
	readonly onWake?: (wake: Wake) => void;
};

/** Cumulative token, KV-cache hit rate, and spend summary for the root conversation. */
export type JeheeUsageSummary = {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly prefillTokens: number;
	readonly cacheHitRate: number;
	readonly costUsd: number;
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
			readonly answerEntryId: EntryId;
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

/** Listener notified when a background workshop report triggers a main-conversation reply. */
export type ProactiveReplyListener = (replyText: string, answerEntryId: EntryId) => void | Promise<void>;

/** Always-on personal colleague host wrapping a durable Session and its root conversation. */
export class JeheeHost {
	readonly #harness: Harness;
	readonly #registry: Registry;
	readonly #root: Conversation;
	readonly #proactiveListeners: Set<ProactiveReplyListener>;
	readonly #mcpHub: McpConnectorHub | undefined;
	#memoryProvider: MemoryProvider | undefined;

	private constructor(
		harness: Harness,
		registry: Registry,
		root: Conversation,
		memoryProvider: MemoryProvider | undefined,
		proactiveListeners: Set<ProactiveReplyListener>,
		mcpHub: McpConnectorHub | undefined,
	) {
		this.#harness = harness;
		this.#registry = registry;
		this.#root = root;
		this.#memoryProvider = memoryProvider;
		this.#proactiveListeners = proactiveListeners;
		this.#mcpHub = mcpHub;
	}

	/** Opens storage, connects MCP servers, installs extensions and memory, initializes the root conversation, and resumes tasks. */
	static async open(options: JeheeHostOptions, context: Context): Promise<JeheeHost> {
		const storage: Storage = options.storage.kind === "memory" ? new MemoryStorage() : options.storage.storage;
		const registry = createRegistry();
		const proactiveListeners = new Set<ProactiveReplyListener>();
		for (const ext of options.extensions ?? []) {
			registry.install(ext);
		}
		if (options.memory !== undefined) {
			registry.install(createMemoryExtension(options.memory));
		}
		let mcpHub: McpConnectorHub | undefined;
		if (options.mcp !== undefined) {
			mcpHub = await McpConnectorHub.connect(options.mcp.servers);
			const mcpBundle = createMcpBundle(mcpHub, options.mcp);
			for (const ext of mcpBundle.extensions) {
				registry.install(ext);
			}
		}
		let workshopBundle: WorkshopBundle | undefined;
		if (options.workshop !== undefined) {
			workshopBundle = createWorkshopBundle({
				client: options.workshop.client,
				provisioner: options.workshop.provisioner,
				onProactiveReply: async (replyText, answerEntryId) => {
					for (const listener of proactiveListeners) {
						await listener(replyText, answerEntryId);
					}
				},
			});
			registry.install(workshopBundle.orchestratorExtension);
			registry.install(workshopBundle.sandboxExtension);
		}
		try {
			const harness = await Harness.open(
				storage,
				{
					models: options.models,
					registry,
					...(options.telemetry !== undefined ? { telemetry: options.telemetry } : {}),
					...(options.env !== undefined ? { env: options.env } : {}),
					...(options.now !== undefined ? { now: options.now } : {}),
					...(options.onWake !== undefined ? { onWake: options.onWake } : {}),
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
					...(workshopBundle !== undefined ? { extensions: { remove: [workshopBundle.sandboxExtension] } } : {}),
				},
			});
			await root.configure(
				{
					model: options.defaultModel,
					...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
					...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
					...(workshopBundle !== undefined ? { extensions: { remove: [workshopBundle.sandboxExtension] } } : {}),
				},
				context,
			);
			harness.resume();
			return new JeheeHost(harness, registry, root, options.memory, proactiveListeners, mcpHub);
		} catch (error) {
			await mcpHub?.close();
			throw error;
		}
	}

	/** Identifier of the single-entry root conversation. */
	get rootConversationId(): ConversationId {
		return this.#root.id;
	}

	/** Currently mounted memory provider, if any. */
	get memoryProvider(): MemoryProvider | undefined {
		return this.#memoryProvider;
	}

	/** Configured names of currently connected MCP servers (empty when no MCP servers are mounted). */
	get mcpServerNames(): readonly string[] {
		return this.#mcpHub?.servers().map((server) => server.name) ?? [];
	}

	/** Current wake status of the underlying durable scheduler (for Cloudflare Durable Object alarms). */
	wake(): Wake {
		return this.#harness.wake();
	}

	/** Resumes durable task scheduling after an external alarm wake-up. */
	resume(): void {
		this.#harness.resume();
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
						answerEntryId: settled.answer,
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

	/** Whether the root conversation is actively generating or running tools (excludes post-answer `afterRun` cleanup). */
	async isBusy(context: Context): Promise<boolean> {
		const live = await this.#harness.snapshot(LiveDoc, this.#root.id, context);
		return live?.run !== undefined && live.run.afterRun === undefined;
	}

	/** Withdraws queued inputs, aborts active foreground work on the root conversation, and waits until idle. */
	async abort(context: Context): Promise<void> {
		await this.#root.abort(context);
	}

	/** Subscribes to unsolicited main-agent replies produced after background workshop reports arrive. */
	onProactiveReply(listener: ProactiveReplyListener): () => void {
		this.#proactiveListeners.add(listener);
		return () => {
			this.#proactiveListeners.delete(listener);
		};
	}

	/** Waits until all background workshop reporter tasks and the root conversation have completely settled. */
	async waitForWorkshopSettled(context: Context): Promise<void> {
		const workshopState = await this.#harness.snapshot(WorkshopRegistryDoc, this.#root.id, context);
		for (const reporterId of Object.values(workshopState?.reporters ?? {})) {
			await this.#harness.waitForTask(reporterId, context);
		}
		await this.#root.waitForIdle(context);
	}

	/** Waits until the root conversation and its foreground tasks are completely idle (including afterRun hooks). */
	async waitForIdle(context: Context): Promise<void> {
		await this.#root.waitForIdle(context);
	}

	/** Reads cumulative token, KV-cache hit rate, and dollar spend recorded on the root conversation. */
	async getUsageSummary(context: Context): Promise<JeheeUsageSummary> {
		const usageState = await this.#harness.snapshot(UsageDoc, this.#root.id, context);
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let cacheWriteTokens = 0;
		let costUsd = 0;
		for (const usage of Object.values(usageState?.models ?? {})) {
			inputTokens += usage.input;
			outputTokens += usage.output;
			cacheReadTokens += usage.cacheRead;
			cacheWriteTokens += usage.cacheWrite;
			costUsd += usage.cost.total;
		}
		const prefillTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
		return {
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			prefillTokens,
			cacheHitRate: prefillTokens > 0 ? cacheReadTokens / prefillTokens : 0,
			costUsd,
		};
	}

	/** Closes the underlying Harness, disconnects MCP servers, and releases storage locks cleanly. */
	async close(context: Context): Promise<void> {
		try {
			await this.#harness.close(context);
		} finally {
			await this.#mcpHub?.close();
		}
	}
}
