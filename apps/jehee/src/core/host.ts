// Core runtime host for Jehee: manages storage lifecycle, the single-entry root conversation, busy-turn steering,
// crash recovery, and hot-swappable memory providers on top of pi-durable. Kept 100% Web/Edge portable (no node:sqlite
// or child_process imports) so the exact same class powers both Node 24 and Cloudflare Workers Durable Objects.

import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	CompactionEntry,
	type CompactionResult,
	type Conversation,
	type ConversationId,
	type Cursor,
	createRegistry,
	type EntryId,
	type EntryRecord,
	type Extension,
	Harness,
	type HarnessOptions,
	LiveDoc,
	MemoryStorage,
	type ModelRef,
	type Registry,
	ResetEntry,
	type Storage,
	type Submission,
	type SubmissionId,
	type TaskId,
	UsageDoc,
	UserEntry,
	type Wake,
} from "@earendil-works/pi-durable";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { HandoffDoc } from "../context/durable-store.ts";
import { createContextExtension, executeManualWindowHandoff, extractHistoryRecords } from "../context/extension.ts";
import {
	type ContextWindowStatus,
	createEmptyHandoffState,
	estimateActiveContextTokens,
	type HandoffPolicy,
	type HandoffState,
	type HandoffWindowReport,
	type HistoryLookupQuery,
	type HistoryLookupResult,
	lookupHistoryRecords,
	resolveHandoffPolicy,
	shouldTriggerSweetSpotCompaction,
} from "../context/handoff.ts";
import {
	ApprovalDoc,
	type ApprovalRequestListener,
	type ApprovalTicket,
	pruneExpiredTickets,
} from "../governance/approvals.ts";
import type { JeheeMcpOptions } from "../mcp/contract.ts";
import { createMcpBundle } from "../mcp/extension.ts";
import { McpConnectorHub } from "../mcp/hub.ts";
import { createEmptyMemoryStoreState } from "../memory/atomic-memory.ts";
import {
	createMemoryConsolidatorTask,
	createMemoryExtension,
	createMemoryToolsExtension,
	executeMemoryConsolidation,
	type MemoryConsolidatorTaskToken,
	scheduleIdleConsolidationInTx,
} from "../memory/bridge.ts";
import { createEmptyConsolidationState } from "../memory/consolidator.ts";
import {
	extractAssistantText,
	extractUserText,
	type MemoryConsolidationReport,
	type MemoryConsolidationState,
	type MemoryForgetResult,
	type MemoryInspectSnapshot,
	type MemoryProvider,
	type MemoryRestoreResult,
	type MemorySaveInput,
	type MemorySaveResult,
	type MemorySearchHit,
	type MemorySearchQuery,
} from "../memory/contract.ts";
import { MemoryConsolidationDoc, MemoryDoc } from "../memory/durable-store.ts";
import {
	applyPortableMemoryImport,
	buildPortableSnapshot,
	type ExportSnapshotOptions,
	type ImportSnapshotOptions,
	type ImportSnapshotResult,
	type PortableContextSnapshot,
	type PortableDialogueTurn,
} from "../memory/portable-snapshot.ts";
import { startJeheeMemorySpan } from "../telemetry/recorder.ts";
import type { WorkshopExecutionBackend } from "../workshop/backend.ts";
import type { CustomCodingAgentTemplate, WorkshopDriverName } from "../workshop/coding-agent-driver.ts";
import { createWorkshopBundle, type WorkshopBundle, WorkshopRegistryDoc } from "../workshop/extension.ts";
import type { InstaBoxClient } from "../workshop/instabox-client.ts";
import type { WorkshopProvisioner } from "../workshop/provisioner.ts";

/** Portable storage backend configuration for JeheeHost. */
export type JeheeStorageConfig = { readonly kind: "memory" } | { readonly kind: "custom"; readonly storage: Storage };

/** Optional cloud or local Workshop configuration attached to JeheeHost. */
export type JeheeWorkshopOptions = {
	readonly backend?: WorkshopExecutionBackend;
	readonly client?: InstaBoxClient;
	readonly provisioner?: WorkshopProvisioner;
	readonly defaultDriver?: WorkshopDriverName;
	readonly agentModel?: string;
	readonly customTemplate?: CustomCodingAgentTemplate;
	readonly pollIntervalMs?: number;
};

/** Construction options for opening a JeheeHost instance. */
export type JeheeHostOptions = {
	readonly storage: JeheeStorageConfig;
	readonly models: Models;
	readonly defaultModel: ModelRef;
	readonly instructions?: string;
	readonly memory?: MemoryProvider;
	readonly handoff?: Partial<HandoffPolicy>;
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

/** Outcome of resolving (`approve` or `reject`) a durable write-approval ticket on `JeheeHost`. */
export type ResolveApprovalResult =
	| { readonly kind: "none_pending" }
	| { readonly kind: "not_found"; readonly ticketId: string }
	| { readonly kind: "ambiguous"; readonly pending: readonly ApprovalTicket[] }
	| { readonly kind: "already_settled"; readonly ticket: ApprovalTicket }
	| {
			readonly kind: "approved";
			readonly ticket: ApprovalTicket;
			readonly pendingTurn?: JeheePendingTurn;
	  }
	| { readonly kind: "rejected"; readonly ticket: ApprovalTicket };

/** Outcome of inspecting the currently mounted memory provider on `JeheeHost`. */
export type InspectMemoryResult =
	| {
			readonly kind: "atomic";
			readonly snapshot: MemoryInspectSnapshot;
			readonly consolidation: MemoryConsolidationState;
	  }
	| { readonly kind: "static"; readonly providerId: string; readonly corePrompt?: string };

/** Outcome of searching memories on `JeheeHost`. */
export type SearchMemoryResult =
	| { readonly kind: "atomic"; readonly hits: readonly MemorySearchHit[] }
	| { readonly kind: "unsupported"; readonly providerId: string };

/** Outcome of saving a memory item via `JeheeHost`. */
export type HostMemorySaveResult =
	| MemorySaveResult
	| { readonly ok: false; readonly reason: "unsupported"; readonly message: string };

/** Outcome of forgetting a memory item via `JeheeHost`. */
export type HostMemoryForgetResult =
	| MemoryForgetResult
	| { readonly ok: false; readonly reason: "unsupported"; readonly id: string };

/** Outcome of restoring a forgotten memory item via `JeheeHost`. */
export type HostMemoryRestoreResult =
	| MemoryRestoreResult
	| { readonly ok: false; readonly reason: "unsupported"; readonly message: string };

function extractPortableTurns(entries: readonly EntryRecord[]): PortableDialogueTurn[] {
	const turns: PortableDialogueTurn[] = [];
	for (const entry of entries) {
		const firstMsg = entry.model?.[0];
		if (UserEntry.is(entry) && firstMsg?.role === "user") {
			const text = extractUserText(firstMsg).trim();
			if (text.length > 0) {
				turns.push({
					id: String(entry.id),
					role: "user",
					text,
					timestampMs: firstMsg.timestamp,
				});
			}
		} else if (AssistantEntry.is(entry) && firstMsg?.role === "assistant" && firstMsg.stopReason === "stop") {
			const text = extractAssistantText(firstMsg).trim();
			if (text.length > 0) {
				turns.push({
					id: String(entry.id),
					role: "assistant",
					text,
					timestampMs: firstMsg.timestamp,
					model: {
						provider: firstMsg.provider,
						modelId: firstMsg.model,
					},
				});
			}
		} else if ((CompactionEntry.is(entry) || ResetEntry.is(entry)) && firstMsg?.role === "user") {
			const text = extractUserText(firstMsg).trim();
			if (text.length > 0) {
				turns.push({
					id: String(entry.id),
					role: "summary",
					text,
					timestampMs: firstMsg.timestamp,
				});
			}
		}
	}
	return turns;
}

/** Always-on personal colleague host wrapping a durable Session and its root conversation. */
export class JeheeHost {
	readonly #harness: Harness;
	readonly #registry: Registry;
	readonly #root: Conversation;
	readonly #models: Models;
	readonly #defaultModel: ModelRef;
	readonly #telemetry: TelemetryContext | undefined;
	readonly #proactiveListeners: Set<ProactiveReplyListener>;
	readonly #approvalListeners: Set<ApprovalRequestListener>;
	readonly #mcpHub: McpConnectorHub | undefined;
	readonly #now: () => number;
	readonly #memoryHolder: { current: MemoryProvider | undefined };
	readonly #handoffPolicy: HandoffPolicy;
	readonly #compactionTracker: { lastTaskId: TaskId<CompactionResult> | undefined };
	readonly #consolidatorTask: MemoryConsolidatorTaskToken;
	readonly #onRootTurnCompleted: (conversationId: ConversationId, context: Context) => Promise<void>;

	private constructor(
		harness: Harness,
		registry: Registry,
		root: Conversation,
		models: Models,
		defaultModel: ModelRef,
		telemetry: TelemetryContext | undefined,
		memoryHolder: { current: MemoryProvider | undefined },
		handoffPolicy: HandoffPolicy,
		compactionTracker: { lastTaskId: TaskId<CompactionResult> | undefined },
		consolidatorTask: MemoryConsolidatorTaskToken,
		onRootTurnCompleted: (conversationId: ConversationId, context: Context) => Promise<void>,
		proactiveListeners: Set<ProactiveReplyListener>,
		approvalListeners: Set<ApprovalRequestListener>,
		mcpHub: McpConnectorHub | undefined,
		now: () => number,
	) {
		this.#harness = harness;
		this.#registry = registry;
		this.#root = root;
		this.#models = models;
		this.#defaultModel = defaultModel;
		this.#telemetry = telemetry;
		this.#memoryHolder = memoryHolder;
		this.#handoffPolicy = handoffPolicy;
		this.#compactionTracker = compactionTracker;
		this.#consolidatorTask = consolidatorTask;
		this.#onRootTurnCompleted = onRootTurnCompleted;
		this.#proactiveListeners = proactiveListeners;
		this.#approvalListeners = approvalListeners;
		this.#mcpHub = mcpHub;
		this.#now = now;
	}

	/** Opens storage, connects MCP servers, installs extensions and memory, initializes the root conversation, and resumes tasks. */
	static async open(options: JeheeHostOptions, context: Context): Promise<JeheeHost> {
		const storage: Storage = options.storage.kind === "memory" ? new MemoryStorage() : options.storage.storage;
		const registry = createRegistry();
		const proactiveListeners = new Set<ProactiveReplyListener>();
		const approvalListeners = new Set<ApprovalRequestListener>();
		const nowFn = options.now ?? Date.now;
		const memoryHolder: { current: MemoryProvider | undefined } = { current: options.memory };
		const handoffPolicy = resolveHandoffPolicy(options.handoff);
		const compactionTracker: { lastTaskId: TaskId<CompactionResult> | undefined } = { lastTaskId: undefined };
		const consolidatorTask = createMemoryConsolidatorTask({
			getAtomic: () => memoryHolder.current?.atomic,
			defaultModel: options.defaultModel,
			...(options.telemetry !== undefined ? { telemetry: options.telemetry } : {}),
		});
		let harnessRef: Harness | undefined;
		let rootRef: Conversation | undefined;
		const runPreHandoffConsolidation = async (hookCtx: Context): Promise<boolean> => {
			if (rootRef === undefined) return false;
			const atomic = memoryHolder.current?.atomic;
			if (atomic === undefined) return false;
			const report = await executeMemoryConsolidation(
				{
					trigger: "manual",
					conversationId: rootRef.id,
					atomic,
					models: options.models,
					defaultModel: options.defaultModel,
					now: nowFn,
					...(options.telemetry !== undefined ? { telemetry: options.telemetry } : {}),
					commit: (change, ctx) => rootRef!.commit(change, ctx),
				},
				hookCtx,
			);
			return report.status === "ok";
		};
		const onRootTurnCompleted = async (conversationId: ConversationId, hookCtx: Context): Promise<void> => {
			if (rootRef === undefined || conversationId !== rootRef.id) return;
			const atomic = memoryHolder.current?.atomic;
			if (atomic === undefined) return;
			const idleDelayMs = atomic.consolidation.idleDelayMs;
			if (idleDelayMs <= 0) return;
			await rootRef.commit(
				(tx) => scheduleIdleConsolidationInTx(tx, consolidatorTask, nowFn(), idleDelayMs),
				hookCtx,
			);
		};
		const onRootContextAfterRun = async (conversationId: ConversationId, hookCtx: Context): Promise<void> => {
			if (rootRef === undefined || harnessRef === undefined || conversationId !== rootRef.id) return;
			if (handoffPolicy.sweetSpotTokens <= 0) return;
			const live = await harnessRef.snapshot(LiveDoc, rootRef.id, hookCtx);
			const hasRunningCompaction = (live?.compactions?.length ?? 0) > 0;
			const view = await rootRef.context(hookCtx);
			const activeTokens = estimateActiveContextTokens(view.messages);
			const activeDialogueTurns = view.entries.filter(
				(entry) => UserEntry.is(entry) || AssistantEntry.is(entry),
			).length;
			if (
				shouldTriggerSweetSpotCompaction({
					activeTokens,
					activeDialogueTurns,
					policy: handoffPolicy,
					hasRunningCompaction,
				})
			) {
				compactionTracker.lastTaskId = await rootRef.compact(undefined, hookCtx);
			}
		};
		for (const ext of options.extensions ?? []) {
			registry.install(ext);
		}
		registry.install(
			createContextExtension({
				enableHistoryTool: options.memory?.atomic !== undefined || options.handoff !== undefined,
				getPolicy: () => handoffPolicy,
				getDefaultModel: () => options.defaultModel,
				getModels: () => options.models,
				getNow: nowFn,
				getTelemetry: () => options.telemetry,
				isRootConversation: (convId) => rootRef !== undefined && convId === rootRef.id,
				runPreHandoffConsolidation,
				recordAutoCompaction: async (metrics, hookCtx) => {
					if (rootRef === undefined) return;
					await rootRef.commit(async (tx) => {
						const hDoc = await tx.doc(HandoffDoc);
						hDoc.totalCompactions += 1;
						hDoc.lastHandoffAtMs = nowFn();
						hDoc.lastHandoffKind = "auto_compaction";
						hDoc.lastTokensBefore = metrics.tokensBefore;
						if (metrics.summaryPreview !== undefined) {
							hDoc.lastSummaryPreview = metrics.summaryPreview;
						}
					}, hookCtx);
				},
				onRootAfterRun: onRootContextAfterRun,
			}),
		);
		if (options.memory !== undefined) {
			registry.install(createMemoryExtension(options.memory, { onRootTurnCompleted }));
			registry.install(createMemoryToolsExtension(options.memory, consolidatorTask));
		} else {
			registry.install(createMemoryToolsExtension(undefined, consolidatorTask));
		}
		let mcpHub: McpConnectorHub | undefined;
		if (options.mcp !== undefined) {
			mcpHub = await McpConnectorHub.connect(options.mcp.servers, {
				...(options.mcp.bestEffortConnect === true ? { bestEffort: true } : {}),
			});
			if (mcpHub.servers().length > 0) {
				const callerApprovalListener = options.mcp.onApprovalRequested;
				const mcpBundle = createMcpBundle(mcpHub, {
					...options.mcp,
					onApprovalRequested: async (ticket) => {
						if (callerApprovalListener !== undefined) {
							await callerApprovalListener(ticket);
						}
						for (const listener of approvalListeners) {
							await listener(ticket);
						}
					},
				});
				for (const ext of mcpBundle.extensions) {
					registry.install(ext);
				}
			}
		}
		let workshopBundle: WorkshopBundle | undefined;
		if (options.workshop !== undefined) {
			workshopBundle = createWorkshopBundle({
				...(options.workshop.backend !== undefined ? { backend: options.workshop.backend } : {}),
				...(options.workshop.client !== undefined ? { client: options.workshop.client } : {}),
				...(options.workshop.provisioner !== undefined ? { provisioner: options.workshop.provisioner } : {}),
				...(options.workshop.defaultDriver !== undefined ? { defaultDriver: options.workshop.defaultDriver } : {}),
				...(options.workshop.agentModel !== undefined ? { agentModel: options.workshop.agentModel } : {}),
				...(options.workshop.customTemplate !== undefined
					? { customTemplate: options.workshop.customTemplate }
					: {}),
				...(options.workshop.pollIntervalMs !== undefined
					? { pollIntervalMs: options.workshop.pollIntervalMs }
					: {}),
				getCorePrompt: async (convId) => {
					const current = memoryHolder.current;
					if (current === undefined) return undefined;
					if (current.atomic !== undefined && harnessRef !== undefined) {
						const doc = (await harnessRef.snapshot(MemoryDoc, context)) ?? createEmptyMemoryStoreState();
						return current.atomic.renderCoreFromState(doc);
					}
					return current.renderCorePrompt?.(convId);
				},
				onProactiveReply: async (replyText, answerEntryId) => {
					for (const listener of proactiveListeners) {
						await listener(replyText, answerEntryId);
					}
				},
			});
			registry.install(workshopBundle.orchestratorExtension);
			if (workshopBundle.sandboxExtension !== undefined) {
				registry.install(workshopBundle.sandboxExtension);
			}
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
						compaction: {
							enabled: handoffPolicy.sweetSpotTokens > 0,
							keepRecentTokens: handoffPolicy.keepRecentTokens,
						},
					},
				},
				context,
			);
			harnessRef = harness;
			const removedOnRoot =
				workshopBundle?.sandboxExtension !== undefined ? [workshopBundle.sandboxExtension] : undefined;
			const root = await harness.root(context, {
				agent: {
					model: options.defaultModel,
					instructions: options.instructions,
					cwd: options.cwd,
					...(removedOnRoot !== undefined ? { extensions: { remove: removedOnRoot } } : {}),
				},
			});
			rootRef = root;
			await root.configure(
				{
					model: options.defaultModel,
					...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
					...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
					...(removedOnRoot !== undefined ? { extensions: { remove: removedOnRoot } } : {}),
				},
				context,
			);
			harness.resume();
			return new JeheeHost(
				harness,
				registry,
				root,
				options.models,
				options.defaultModel,
				options.telemetry,
				memoryHolder,
				handoffPolicy,
				compactionTracker,
				consolidatorTask,
				onRootTurnCompleted,
				proactiveListeners,
				approvalListeners,
				mcpHub,
				nowFn,
			);
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
		return this.#memoryHolder.current;
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
		this.#memoryHolder.current = provider;
		this.#registry.install(createMemoryExtension(provider, { onRootTurnCompleted: this.#onRootTurnCompleted }));
		this.#registry.install(createMemoryToolsExtension(provider, this.#consolidatorTask));
	}

	/** Inspects the currently mounted memory provider deterministically without invoking an LLM. */
	async inspectMemory(context: Context, recentLimit?: number): Promise<InspectMemoryResult> {
		const provider = this.#memoryHolder.current;
		if (provider?.atomic !== undefined) {
			const doc = (await this.#harness.snapshot(MemoryDoc, context)) ?? createEmptyMemoryStoreState();
			const consolidation =
				(await this.#harness.snapshot(MemoryConsolidationDoc, context)) ?? createEmptyConsolidationState();
			return { kind: "atomic", snapshot: provider.atomic.inspect(doc, recentLimit), consolidation };
		}
		const corePrompt = await provider?.renderCorePrompt?.(String(this.#root.id));
		return {
			kind: "static",
			providerId: provider?.id ?? "none",
			...(corePrompt !== undefined ? { corePrompt } : {}),
		};
	}

	/** Reads the persisted memory consolidation watermark and cumulative counters. */
	async getMemoryConsolidationState(context: Context): Promise<MemoryConsolidationState> {
		return (await this.#harness.snapshot(MemoryConsolidationDoc, context)) ?? createEmptyConsolidationState();
	}

	/** Runs one incremental memory consolidation pass immediately (manual trigger). */
	async consolidateMemory(
		context: Context,
		options?: { readonly force?: boolean },
	): Promise<MemoryConsolidationReport> {
		const atomic = this.#memoryHolder.current?.atomic;
		if (atomic === undefined) {
			return { status: "noop", trigger: "manual", reason: "unsupported", turnsScanned: 0 };
		}
		return executeMemoryConsolidation(
			{
				trigger: "manual",
				...(options?.force !== undefined ? { force: options.force } : {}),
				conversationId: this.#root.id,
				atomic,
				models: this.#models,
				defaultModel: this.#defaultModel,
				now: this.#now,
				...(this.#telemetry !== undefined ? { telemetry: this.#telemetry } : {}),
				commit: (change, ctx) => this.#root.commit(change, ctx),
			},
			context,
		);
	}

	/** Waits until any currently scheduled background idle memory consolidation task has settled. */
	async waitForMemoryConsolidation(context: Context): Promise<void> {
		const state = await this.#harness.snapshot(MemoryConsolidationDoc, context);
		if (state?.scheduledTaskId !== undefined) {
			await this.#harness.waitForTask(state.scheduledTaskId as TaskId<null>, context);
		}
	}

	/** Reads persisted Slice 5D handoff & compaction metrics from `HandoffDoc`. */
	async getHandoffState(context: Context): Promise<HandoffState> {
		return (await this.#harness.snapshot(HandoffDoc, context)) ?? createEmptyHandoffState();
	}

	/** Computes current active window token estimate against sweet-spot budget and persisted handoff counts. */
	async getContextStatus(context: Context): Promise<ContextWindowStatus> {
		const view = await this.#root.context(context);
		const activeTokens = estimateActiveContextTokens(view.messages);
		const handoffState = await this.getHandoffState(context);
		return {
			activeTokens,
			sweetSpotTokens: this.#handoffPolicy.sweetSpotTokens,
			keepRecentTokens: this.#handoffPolicy.keepRecentTokens,
			activeEntries: view.entries.length,
			totalCompactions: handoffState.totalCompactions,
			totalManualHandoffs: handoffState.totalManualHandoffs,
			totalHandoffs: handoffState.totalCompactions + handoffState.totalManualHandoffs,
			...(handoffState.lastHandoffAtMs !== undefined ? { lastHandoffAtMs: handoffState.lastHandoffAtMs } : {}),
			...(handoffState.lastHandoffKind !== undefined ? { lastHandoffKind: handoffState.lastHandoffKind } : {}),
		};
	}

	/** Runs an explicit seamless window handoff: flushes memory consolidation, summarizes active window, and writes `ResetEntry`. */
	async handoffWindow(context: Context, options?: { readonly focus?: string }): Promise<HandoffWindowReport> {
		return executeManualWindowHandoff(
			{
				conversationId: this.#root.id,
				...(options?.focus !== undefined ? { focus: options.focus } : {}),
				policy: this.#handoffPolicy,
				models: this.#models,
				defaultModel: this.#defaultModel,
				now: this.#now,
				...(this.#telemetry !== undefined ? { telemetry: this.#telemetry } : {}),
				isBusy: (ctx) => this.isBusy(ctx),
				readActiveContext: async (ctx) => {
					const view = await this.#root.context(ctx);
					return { entries: view.entries, messages: view.messages };
				},
				runPreHandoffConsolidation: async (ctx) => {
					const report = await this.consolidateMemory(ctx);
					return report.status === "ok";
				},
				resetWithBrief: (brief, ctx) => this.#root.reset(brief, ctx),
				commit: (change, ctx) => this.#root.commit(change, ctx),
			},
			context,
		);
	}

	/** Triggers a manual non-blocking `pi-durable` compaction pass on the root conversation. */
	async compactWindow(context: Context, instructions?: string): Promise<TaskId<CompactionResult>> {
		const taskId = await this.#root.compact(instructions, context);
		this.#compactionTracker.lastTaskId = taskId;
		return taskId;
	}

	/** Waits until foreground `afterRun` hooks and any triggered compaction task have completely settled. */
	async waitForCompaction(context: Context): Promise<void> {
		// Wait for any in-flight generation `afterRun` hook to finish admitting sweet-spot compaction first.
		await this.#root.waitForIdle(context);
		const live = await this.#harness.snapshot(LiveDoc, this.#root.id, context);
		for (const status of live?.compactions ?? []) {
			await this.#harness.waitForTask(status.taskId, context);
		}
		if (this.#compactionTracker.lastTaskId !== undefined) {
			await this.#harness.waitForTask(this.#compactionTracker.lastTaskId, context);
		}
		await this.#root.waitForIdle(context);
	}

	/** Searches or looks up verbatim past turns across all immutable SQLite history past compaction/reset markers. */
	async lookupHistory(query: HistoryLookupQuery, context: Context): Promise<HistoryLookupResult> {
		const entries: EntryRecord[] = [];
		let cursor: Cursor | undefined;
		while (entries.length < 1_000) {
			const page = await this.#root.entries({ order: "descending" }, 200, cursor, context);
			for (const item of page.items) {
				entries.push(item);
				if (entries.length >= 1_000) break;
			}
			if (page.next === undefined) break;
			cursor = page.next;
		}
		entries.reverse();
		return lookupHistoryRecords(extractHistoryRecords(entries), query);
	}

	/** Searches active atomic memories deterministically without invoking an LLM. */
	async searchMemory(query: MemorySearchQuery, context: Context): Promise<SearchMemoryResult> {
		const provider = this.#memoryHolder.current;
		if (provider?.atomic === undefined) {
			return { kind: "unsupported", providerId: provider?.id ?? "none" };
		}
		const doc = (await this.#harness.snapshot(MemoryDoc, context)) ?? createEmptyMemoryStoreState();
		return { kind: "atomic", hits: provider.atomic.search(doc, query) };
	}

	/** Saves or updates an atomic memory item directly in `MemoryDoc`. */
	async saveMemory(input: MemorySaveInput, context: Context): Promise<HostMemorySaveResult> {
		const atomic = this.#memoryHolder.current?.atomic;
		if (atomic === undefined) {
			return {
				ok: false,
				reason: "unsupported",
				message: `Current memory provider "${this.#memoryHolder.current?.id ?? "none"}" does not support atomic memory writes.`,
			};
		}
		return this.#root.commit(async (tx) => {
			const doc = await tx.doc(MemoryDoc);
			return atomic.save(doc, input, this.#now());
		}, context);
	}

	/** Soft-deletes an atomic memory item by ID deterministically without invoking an LLM. */
	async forgetMemory(id: string, context: Context, reason?: string): Promise<HostMemoryForgetResult> {
		const atomic = this.#memoryHolder.current?.atomic;
		if (atomic === undefined) {
			return { ok: false, reason: "unsupported", id: id.trim() };
		}
		return this.#root.commit(async (tx) => {
			const doc = await tx.doc(MemoryDoc);
			return atomic.forget(doc, id, this.#now(), reason);
		}, context);
	}

	/** Restores a previously forgotten atomic memory item by ID deterministically. */
	async restoreMemory(id: string, context: Context): Promise<HostMemoryRestoreResult> {
		const atomic = this.#memoryHolder.current?.atomic;
		if (atomic === undefined) {
			return {
				ok: false,
				reason: "unsupported",
				message: `Current memory provider "${this.#memoryHolder.current?.id ?? "none"}" does not support atomic memory restore.`,
			};
		}
		return this.#root.commit(async (tx) => {
			const doc = await tx.doc(MemoryDoc);
			return atomic.restore(doc, id, this.#now());
		}, context);
	}

	/** Exports a harness- and model-independent portable snapshot of memory and conversation context. */
	async exportPortableSnapshot(context: Context, options?: ExportSnapshotOptions): Promise<PortableContextSnapshot> {
		const scope = options?.transcriptScope ?? "active";
		const telemetry = this.#telemetry ?? context.telemetry;
		return startJeheeMemorySpan(telemetry)("jehee.memory.export", { "snapshot.scope": scope }, async (span) => {
			let entries: EntryRecord[];
			if (scope === "full") {
				entries = [];
				let cursor: Cursor | undefined;
				while (true) {
					const page = await this.#root.entries({ order: "ascending" }, 256, cursor, context);
					entries.push(...page.items);
					if (page.next === undefined) break;
					cursor = page.next;
				}
			} else {
				const view = await this.#root.context(context);
				entries = [...view.entries];
			}
			const turns = extractPortableTurns(entries);

			const provider = this.#memoryHolder.current;
			const atomic = provider?.atomic;
			const memoryState =
				atomic !== undefined
					? ((await this.#harness.snapshot(MemoryDoc, context)) ?? createEmptyMemoryStoreState())
					: undefined;
			const corePrompt =
				atomic !== undefined && memoryState !== undefined
					? atomic.renderCoreFromState(memoryState)
					: await provider?.renderCorePrompt?.(String(this.#root.id));

			const snapshot = buildPortableSnapshot({
				exportedAtMs: this.#now(),
				memoryProviderId: provider?.id ?? "none",
				defaultModel: this.#defaultModel,
				conversationId: String(this.#root.id),
				...(atomic?.seedCorePrompt !== undefined ? { seedCorePrompt: atomic.seedCorePrompt } : {}),
				...(corePrompt !== undefined ? { corePrompt } : {}),
				...(memoryState !== undefined ? { memoryState } : {}),
				scope,
				turns,
				...(options?.includeForgotten !== undefined ? { includeForgotten: options.includeForgotten } : {}),
				...(options?.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
			});
			span.setAttributes({
				"snapshot.memory_count": snapshot.memory.items.length,
				"snapshot.turn_count": snapshot.context.turns.length,
			});
			return snapshot;
		});
	}

	/** Atomically imports a portable snapshot into atomic memory (`MemoryDoc`) and/or the root conversation transcript. */
	async importPortableSnapshot(
		snapshot: PortableContextSnapshot,
		context: Context,
		options?: ImportSnapshotOptions,
	): Promise<ImportSnapshotResult> {
		const mode = options?.mode ?? "merge";
		const includeMemory = options?.includeMemory !== false;
		const includeContext = options?.includeContext !== false;
		const telemetry = this.#telemetry ?? context.telemetry;

		return startJeheeMemorySpan(telemetry)("jehee.memory.import", { "snapshot.mode": mode }, async (span) => {
			const atomic = this.#memoryHolder.current?.atomic;
			const result = await this.#root.commit(async (tx): Promise<ImportSnapshotResult> => {
				const wantsContextWrite = includeContext && (mode === "replace" || snapshot.context.turns.length > 0);
				if (wantsContextWrite) {
					const live = await tx.doc(LiveDoc, this.#root.id);
					if (live.run !== undefined && live.run.afterRun === undefined) {
						return {
							ok: false,
							reason: "host_busy",
							message: "Cannot import conversation context while the root conversation is busy.",
						};
					}
				}

				let memoriesImported = 0;
				let memoriesSkippedDuplicates = 0;
				let memoriesReassignedIds = 0;
				let memoriesSkipped = 0;
				let memoryUnsupported: true | undefined;
				const skippedReasons: string[] = [];
				let memDocSeq: number | undefined;

				if (includeMemory) {
					if (atomic !== undefined) {
						const memDoc = await tx.doc(MemoryDoc);
						const applied = applyPortableMemoryImport(memDoc, snapshot.memory.items, {
							mode,
							maxCoreChars: atomic.maxCoreChars,
							...(atomic.seedCorePrompt !== undefined ? { seedCorePrompt: atomic.seedCorePrompt } : {}),
							...(options?.respectCoreLimit !== undefined ? { respectCoreLimit: options.respectCoreLimit } : {}),
						});
						memoriesImported = applied.imported;
						memoriesSkippedDuplicates = applied.skippedDuplicates;
						memoriesReassignedIds = applied.reassignedIds;
						memoriesSkipped = applied.skippedCoreLimit;
						skippedReasons.push(...applied.skippedReasons);
						memDocSeq = memDoc.seq;
					} else if (snapshot.memory.items.length > 0) {
						memoryUnsupported = true;
						memoriesSkipped = snapshot.memory.items.length;
						skippedReasons.push(
							`Current memory provider "${this.#memoryHolder.current?.id ?? "none"}" does not support atomic memory imports.`,
						);
					}
				}

				let contextTurnsImported = 0;
				let contextResetApplied = false;
				let lastImportedEntryId: EntryId | undefined;
				const nowMs = this.#now();

				if (includeContext) {
					const turns = snapshot.context.turns;
					let startIndex = 0;
					if (mode === "replace") {
						if (turns.length > 0 && turns[0]!.role === "summary") {
							const first = turns[0]!;
							const entry = await tx.appendEntry(ResetEntry, this.#root.id, {
								head: "self",
								model: [{ role: "user", content: first.text, timestamp: first.timestampMs ?? nowMs }],
							});
							lastImportedEntryId = entry.id;
							contextResetApplied = true;
							contextTurnsImported += 1;
							startIndex = 1;
						} else if ((await tx.latestEntryId(this.#root.id)) !== undefined) {
							const entry = await tx.appendEntry(ResetEntry, this.#root.id, { head: "self" });
							lastImportedEntryId = entry.id;
							contextResetApplied = true;
						}
					}

					for (let i = startIndex; i < turns.length; i += 1) {
						const turn = turns[i]!;
						const ts = turn.timestampMs ?? nowMs;
						if (turn.role === "summary") {
							if (mode === "replace") {
								const entry = await tx.appendEntry(ResetEntry, this.#root.id, {
									head: "self",
									model: [{ role: "user", content: turn.text, timestamp: ts }],
								});
								lastImportedEntryId = entry.id;
								contextResetApplied = true;
							} else {
								const entry = await tx.appendEntry(UserEntry, this.#root.id, {
									model: [
										{ role: "user", content: `[Imported Context Summary]\n${turn.text}`, timestamp: ts },
									],
								});
								lastImportedEntryId = entry.id;
							}
							contextTurnsImported += 1;
						} else if (turn.role === "user") {
							const entry = await tx.appendEntry(UserEntry, this.#root.id, {
								model: [{ role: "user", content: turn.text, timestamp: ts }],
							});
							lastImportedEntryId = entry.id;
							contextTurnsImported += 1;
						} else {
							const assistantMsg: AssistantMessage = {
								role: "assistant",
								content: [{ type: "text", text: turn.text }],
								api: "openai-completions",
								provider: turn.model?.provider ?? "portable-import",
								model: turn.model?.modelId ?? "imported",
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
								stopReason: "stop",
								timestamp: ts,
							};
							const entry = await tx.appendEntry(AssistantEntry, this.#root.id, {
								model: [assistantMsg],
							});
							lastImportedEntryId = entry.id;
							contextTurnsImported += 1;
						}
					}
				}

				if (atomic !== undefined && mode === "replace") {
					const cDoc = await tx.doc(MemoryConsolidationDoc);
					if (memDocSeq !== undefined) {
						cDoc.lastConsolidatedMemorySeq = memDocSeq;
					}
					if (lastImportedEntryId !== undefined && memoriesImported > 0) {
						cDoc.lastConsolidatedEntryId = String(lastImportedEntryId);
					} else if (contextResetApplied && lastImportedEntryId === undefined) {
						const latestId = await tx.latestEntryId(this.#root.id);
						if (latestId !== undefined) {
							cDoc.lastConsolidatedEntryId = String(latestId);
						}
					}
				}

				return {
					ok: true,
					mode,
					memoriesImported,
					memoriesSkippedDuplicates,
					memoriesReassignedIds,
					memoriesSkipped,
					...(memoryUnsupported !== undefined ? { memoryUnsupported } : {}),
					contextTurnsImported,
					contextResetApplied,
					skippedReasons,
				};
			}, context);

			if (!result.ok) {
				span.setAttributes({ "snapshot.outcome": result.reason });
				span.setStatus({ status: "error", error: { name: result.reason, message: result.message } });
				return result;
			}
			span.setAttributes({
				"snapshot.memories_imported": result.memoriesImported,
				"snapshot.memories_skipped": result.memoriesSkipped + result.memoriesSkippedDuplicates,
				"snapshot.turns_imported": result.contextTurnsImported,
				"snapshot.outcome": "ok",
			});
			return result;
		});
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

	/** Subscribes to newly created pending write-approval tickets requiring owner confirmation. */
	onApprovalRequested(listener: ApprovalRequestListener): () => void {
		this.#approvalListeners.add(listener);
		return () => {
			this.#approvalListeners.delete(listener);
		};
	}

	/** Lists all unexpired `"pending"` write-approval tickets on the root conversation in chronological order. */
	async listPendingApprovals(context: Context): Promise<readonly ApprovalTicket[]> {
		const doc = await this.#harness.snapshot(ApprovalDoc, this.#root.id, context);
		if (doc === undefined) return [];
		const nowMs = this.#now();
		return Object.values(doc.tickets)
			.filter((t) => t.status === "pending" && t.expiresAtMs > nowMs)
			.sort((a, b) => a.createdAtMs - b.createdAtMs);
	}

	/**
	 * Approves or rejects a pending write-approval ticket in SQLite (`ApprovalDoc`).
	 * When `decision === "approve"` and `resumeOnApprove !== false`, automatically submits an idempotent
	 * continuation turn so the model executes the approved tool call immediately.
	 */
	async resolveApproval(
		input: {
			readonly ticketId?: string;
			readonly decision: "approve" | "reject";
			readonly resumeOnApprove?: boolean;
		},
		context: Context,
	): Promise<ResolveApprovalResult> {
		const explicitId = input.ticketId?.trim();
		const txOutcome = await this.#root.commit(async (tx) => {
			const nowMs = this.#now();
			const doc = await tx.doc(ApprovalDoc, this.#root.id);
			pruneExpiredTickets(doc.tickets, nowMs);

			let target: ApprovalTicket | undefined;
			if (explicitId !== undefined && explicitId.length > 0) {
				target = Object.hasOwn(doc.tickets, explicitId) ? doc.tickets[explicitId] : undefined;
				if (target === undefined) {
					return { kind: "not_found", ticketId: explicitId } as const;
				}
			} else {
				const pending = Object.values(doc.tickets)
					.filter((t) => t.status === "pending")
					.sort((a, b) => a.createdAtMs - b.createdAtMs);
				if (pending.length === 0) {
					return { kind: "none_pending" } as const;
				}
				if (pending.length > 1) {
					return { kind: "ambiguous", pending: pending.map((t) => ({ ...t })) } as const;
				}
				target = pending[0]!;
			}

			if (target.status !== "pending") {
				return { kind: "already_settled", ticket: { ...target } } as const;
			}

			target.status = input.decision === "approve" ? "approved" : "rejected";
			return {
				kind: input.decision === "approve" ? ("approved" as const) : ("rejected" as const),
				ticket: { ...target },
			};
		}, context);

		if (txOutcome.kind !== "approved") {
			return txOutcome;
		}
		if (input.resumeOnApprove === false) {
			return { kind: "approved", ticket: txOutcome.ticket };
		}
		const pendingTurn = await this.submitMessage(
			{
				text: `[Owner Approval Granted] Ticket ${txOutcome.ticket.id} (${txOutcome.ticket.server}/${txOutcome.ticket.tool}) has been approved by the owner. Execute this action now and report the result concisely.`,
				requestId: `approval-resume:${txOutcome.ticket.id}`,
			},
			context,
		);
		return {
			kind: "approved",
			ticket: txOutcome.ticket,
			pendingTurn,
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
