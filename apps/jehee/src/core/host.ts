// Core runtime host for Jehee: manages storage lifecycle, the single-entry root conversation, busy-turn steering,
// crash recovery, and hot-swappable memory providers on top of pi-durable. Kept 100% Web/Edge portable (no node:sqlite
// or child_process imports) so the exact same class powers both Node 24 and Cloudflare Workers Durable Objects.

import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage, ImageContent, Models } from "@earendil-works/pi-ai";
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
	type Tx,
	UsageDoc,
	UserEntry,
	type Wake,
} from "@earendil-works/pi-durable";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { ChannelRoute } from "../channels/contract.ts";
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
import {
	type AvailableModelEntry,
	appendHeldNotificationInState,
	cloneModelRef,
	createEmptyHeldNotificationsState,
	drainHeldNotificationsInState,
	HeldNotificationsDoc,
	listHeldNotificationsFromState,
	type ModelStatusSummary,
	parseModelRefSpec,
	RuntimeModelDoc,
	readRuntimeModelOverride,
} from "../governance/durable-store.ts";
import {
	computeNextQuietEndMs,
	type HeldProactiveMessage,
	isWithinQuietHours,
	type QuietHoursWindow,
} from "../governance/quiet-gate.ts";
import type { JeheeMcpOptions, McpReconnectReport } from "../mcp/contract.ts";
import { createMcpBundle, type JeheeMcpBundle } from "../mcp/extension.ts";
import { McpConnectorHub } from "../mcp/hub.ts";
import {
	createOutboundMediaExtension,
	JEHEE_MEDIA_EXTENSION_NAME,
	type OutboundMediaDeliveryResult,
	type OutboundMediaPayload,
} from "../media/extension.ts";
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
import type {
	DirectNotifyListener,
	RoutineCreateInput,
	RoutineCreateResult,
	RoutineDeleteResult,
	RoutineItem,
	RoutineRunOutcome,
} from "../routines/contract.ts";
import { LastRouteDoc, RoutineDoc } from "../routines/durable-store.ts";
import {
	createRoutineSchedulerTask,
	createRoutineSchedulerTracker,
	createRoutinesExtension,
	dispatchRoutineExecution,
	type RoutineSchedulerTaskToken,
	type RoutineSchedulerTracker,
	syncRoutineSchedulerInTx,
} from "../routines/extension.ts";
import {
	cloneRoutineItem,
	createEmptyRoutineStoreState,
	createRoutineInState,
	DEFAULT_UTC_OFFSET_MINUTES,
	deleteRoutineInState,
	listRoutinesFromState,
} from "../routines/scheduler.ts";
import {
	appendPersistedTrace,
	buildPersistedTraceInput,
	type PersistedTraceEntry,
	TraceDoc,
} from "../telemetry/durable-store.ts";
import { JeheeTraceRecorder, startJeheeMemorySpan } from "../telemetry/recorder.ts";
import {
	type CreateWebExtensionOptions,
	type CreateWebSearchToolOptions,
	createWebExtension,
	JEHEE_WEB_EXTENSION_NAME,
} from "../web/extension.ts";
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
	/** Fixed local UTC offset in minutes (default `480` = `+08:00`) for clock anchor and daily/weekly routines. */
	readonly utcOffsetMinutes?: number;
	/** Explicit toggle for eager routine tools (`routine_create`/`routine_list`/`routine_delete`). Defaults to enabled when atomic memory or handoff is mounted. */
	readonly enableRoutines?: boolean;
	/** Explicit toggle for eager `web_fetch` tool. Defaults to enabled when routines, atomic memory, or handoff is mounted. */
	readonly enableWebFetch?: boolean;
	/** Optional configuration overrides for the built-in `"jehee.web"` (`web_fetch`) extension. */
	readonly webFetch?: CreateWebExtensionOptions;
	/** Optional live `web_search` configuration (TinyFish TinySearch) mounted inside `"jehee.web"`. */
	readonly webSearch?: CreateWebSearchToolOptions;
	/** Explicit toggle for eager `send_media` tool. Defaults to enabled when routines, atomic memory, or handoff is mounted. */
	readonly enableMedia?: boolean;
	/** Optional quiet-hours window used by the durable scheduler to compute automatic quiet-end flush wakeups. */
	readonly quietHours?: QuietHoursWindow;
	/** Optional retry backoff (ms) for failed quiet-hours auto-flush attempts (defaults to 60_000 ms). */
	readonly quietFlushRetryBackoffMs?: number;
	readonly mcp?: JeheeMcpOptions;
	readonly workshop?: JeheeWorkshopOptions;
	readonly extensions?: readonly Extension[];
	readonly telemetry?: TelemetryContext;
	/** Optional trace recorder whose settled turns are persisted into SQLite `TraceDoc` (created automatically when `telemetry` is omitted). */
	readonly traceRecorder?: JeheeTraceRecorder;
	readonly cwd?: string;
	readonly env?: HarnessOptions["env"];
	readonly now?: () => number;
	readonly onWake?: (wake: Wake) => void;
	/** Whether `JeheeHost.open` immediately resumes durable background tasks (default `true`). Pass `false` when wiring `ChannelGateway` listeners before calling `host.resume()`. */
	readonly autoResume?: boolean;
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
	readonly images?: readonly ImageContent[];
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

/** Listener notified when a background workshop report or agent routine triggers a main-conversation reply. */
export type ProactiveReplyListener = (
	replyText: string,
	answerEntryId: EntryId,
	options?: { readonly urgency?: "normal" | "urgent" },
) => void | Promise<void>;

/** Listener notified by the durable scheduler when quiet hours end and held notifications are due for automatic flush. */
export type QuietFlushListener = (nowMs: number, context: Context) => void | Promise<void>;

/** Optional metadata provided when registering a quiet-hours auto-flush listener on `JeheeHost`. */
export type QuietFlushSubscriptionOptions = {
	readonly quietHours?: QuietHoursWindow;
};

/** Channel-layer callback delivering a validated outbound photo or document emitted by `send_media`. */
export type OutboundMediaHandler = (
	payload: OutboundMediaPayload,
	context: Context,
) => Promise<OutboundMediaDeliveryResult>;

/** Outcome of hot-swapping the active runtime model via `JeheeHost.setModel`. */
export type SetModelResult =
	| {
			readonly ok: true;
			readonly model: ModelRef;
			readonly previous: ModelRef;
			readonly updatedAtMs: number;
	  }
	| {
			readonly ok: false;
			readonly reason: "invalid_format" | "unknown_provider" | "unknown_model";
			readonly message: string;
	  };

/** Outcome of resetting the active runtime model back to the startup default via `JeheeHost.resetModel`. */
export type ResetModelResult = {
	readonly ok: true;
	readonly model: ModelRef;
	readonly wasOverride: boolean;
};

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
	readonly #activeModelHolder: { current: ModelRef };
	readonly #telemetry: TelemetryContext | undefined;
	readonly #traceRecorder: JeheeTraceRecorder | undefined;
	readonly #proactiveListeners: Set<ProactiveReplyListener>;
	readonly #directNotifyListeners: Set<DirectNotifyListener>;
	readonly #approvalListeners: Set<ApprovalRequestListener>;
	readonly #quietFlushListeners: Set<QuietFlushListener>;
	readonly #quietHoursHolder: { current: QuietHoursWindow | undefined; nextHintMs: number | undefined };
	readonly #initialQuietHours: QuietHoursWindow | undefined;
	readonly #outboundMediaHandler: { current: OutboundMediaHandler | undefined };
	readonly #mcpOptions: JeheeMcpOptions | undefined;
	readonly #mcpState: { hub: McpConnectorHub | undefined; bundle: JeheeMcpBundle | undefined };
	readonly #removedOnRoot: readonly Extension[] | undefined;
	#mcpReconnectChain: Promise<unknown> = Promise.resolve();
	readonly #now: () => number;
	readonly #utcOffsetMinutes: number;
	readonly #memoryHolder: { current: MemoryProvider | undefined };
	readonly #handoffPolicy: HandoffPolicy;
	readonly #compactionTracker: { lastTaskId: TaskId<CompactionResult> | undefined };
	readonly #consolidatorTask: MemoryConsolidatorTaskToken;
	readonly #routineSchedulerTask: RoutineSchedulerTaskToken;
	readonly #routineTracker: RoutineSchedulerTracker;
	readonly #onRootTurnCompleted: (conversationId: ConversationId, context: Context) => Promise<void>;

	private constructor(
		harness: Harness,
		registry: Registry,
		root: Conversation,
		models: Models,
		defaultModel: ModelRef,
		activeModelHolder: { current: ModelRef },
		telemetry: TelemetryContext | undefined,
		traceRecorder: JeheeTraceRecorder | undefined,
		memoryHolder: { current: MemoryProvider | undefined },
		handoffPolicy: HandoffPolicy,
		compactionTracker: { lastTaskId: TaskId<CompactionResult> | undefined },
		consolidatorTask: MemoryConsolidatorTaskToken,
		routineSchedulerTask: RoutineSchedulerTaskToken,
		routineTracker: RoutineSchedulerTracker,
		onRootTurnCompleted: (conversationId: ConversationId, context: Context) => Promise<void>,
		proactiveListeners: Set<ProactiveReplyListener>,
		directNotifyListeners: Set<DirectNotifyListener>,
		approvalListeners: Set<ApprovalRequestListener>,
		quietFlushListeners: Set<QuietFlushListener>,
		quietHoursHolder: { current: QuietHoursWindow | undefined; nextHintMs: number | undefined },
		initialQuietHours: QuietHoursWindow | undefined,
		outboundMediaHandler: { current: OutboundMediaHandler | undefined },
		mcpOptions: JeheeMcpOptions | undefined,
		mcpState: { hub: McpConnectorHub | undefined; bundle: JeheeMcpBundle | undefined },
		removedOnRoot: readonly Extension[] | undefined,
		now: () => number,
		utcOffsetMinutes: number,
	) {
		this.#harness = harness;
		this.#registry = registry;
		this.#root = root;
		this.#models = models;
		this.#defaultModel = defaultModel;
		this.#activeModelHolder = activeModelHolder;
		this.#telemetry = telemetry;
		this.#traceRecorder = traceRecorder;
		this.#memoryHolder = memoryHolder;
		this.#handoffPolicy = handoffPolicy;
		this.#compactionTracker = compactionTracker;
		this.#consolidatorTask = consolidatorTask;
		this.#routineSchedulerTask = routineSchedulerTask;
		this.#routineTracker = routineTracker;
		this.#onRootTurnCompleted = onRootTurnCompleted;
		this.#proactiveListeners = proactiveListeners;
		this.#directNotifyListeners = directNotifyListeners;
		this.#approvalListeners = approvalListeners;
		this.#quietFlushListeners = quietFlushListeners;
		this.#quietHoursHolder = quietHoursHolder;
		this.#initialQuietHours = initialQuietHours;
		this.#outboundMediaHandler = outboundMediaHandler;
		this.#mcpOptions = mcpOptions;
		this.#mcpState = mcpState;
		this.#removedOnRoot = removedOnRoot;
		this.#now = now;
		this.#utcOffsetMinutes = utcOffsetMinutes;
	}

	/** Opens storage, connects MCP servers, installs extensions and memory, initializes the root conversation, and resumes tasks. */
	static async open(options: JeheeHostOptions, context: Context): Promise<JeheeHost> {
		const storage: Storage = options.storage.kind === "memory" ? new MemoryStorage() : options.storage.storage;
		const registry = createRegistry();
		const proactiveListeners = new Set<ProactiveReplyListener>();
		const directNotifyListeners = new Set<DirectNotifyListener>();
		const approvalListeners = new Set<ApprovalRequestListener>();
		const quietFlushListeners = new Set<QuietFlushListener>();
		const quietHoursHolder: { current: QuietHoursWindow | undefined; nextHintMs: number | undefined } = {
			current: options.quietHours,
			nextHintMs: undefined,
		};
		const outboundMediaHandler: { current: OutboundMediaHandler | undefined } = { current: undefined };
		const mcpState: { hub: McpConnectorHub | undefined; bundle: JeheeMcpBundle | undefined } = {
			hub: undefined,
			bundle: undefined,
		};
		const activeModelHolder: { current: ModelRef } = { current: cloneModelRef(options.defaultModel) };
		const nowFn = options.now ?? Date.now;
		const utcOffsetMinutes = options.utcOffsetMinutes ?? DEFAULT_UTC_OFFSET_MINUTES;
		const traceRecorder =
			options.traceRecorder ?? (options.telemetry === undefined ? new JeheeTraceRecorder() : undefined);
		const effectiveTelemetry = options.telemetry ?? traceRecorder?.telemetry;
		const memoryHolder: { current: MemoryProvider | undefined } = { current: options.memory };
		const handoffPolicy = resolveHandoffPolicy(options.handoff);
		const compactionTracker: { lastTaskId: TaskId<CompactionResult> | undefined } = { lastTaskId: undefined };
		const consolidatorTask = createMemoryConsolidatorTask({
			getAtomic: () => memoryHolder.current?.atomic,
			defaultModel: options.defaultModel,
			...(effectiveTelemetry !== undefined ? { telemetry: effectiveTelemetry } : {}),
		});
		const routineTracker = createRoutineSchedulerTracker();
		const routineSchedulerTask = createRoutineSchedulerTask({
			getUtcOffsetMinutes: () => utcOffsetMinutes,
			getTelemetry: () => effectiveTelemetry,
			tracker: routineTracker,
			onDirectNotify: async (event) => {
				for (const listener of directNotifyListeners) {
					await listener(event);
				}
			},
			onAgentProactiveReply: async (replyText, answerEntryId, urgency) => {
				for (const listener of proactiveListeners) {
					await listener(replyText, answerEntryId, { urgency });
				}
			},
		});
		let harnessRef: Harness | undefined;
		let rootRef: Conversation | undefined;
		const computeNextQuietFlushAtMs = async (nowMs: number, tx?: Tx): Promise<number | undefined> => {
			if (quietFlushListeners.size === 0) return undefined;
			const doc =
				tx !== undefined
					? await tx.doc(HeldNotificationsDoc)
					: await harnessRef?.snapshot(HeldNotificationsDoc, BACKGROUND_CONTEXT);
			if (doc === undefined || doc.items.length === 0) {
				quietHoursHolder.nextHintMs = undefined;
				return undefined;
			}
			const hasQuietHeld = doc.items.some((item) => item.reason === "quiet_hours");
			if (!hasQuietHeld) {
				quietHoursHolder.nextHintMs = undefined;
				return undefined;
			}
			if (quietHoursHolder.current !== undefined) {
				return isWithinQuietHours(nowMs, quietHoursHolder.current)
					? computeNextQuietEndMs(quietHoursHolder.current, nowMs)
					: nowMs;
			}
			if (quietHoursHolder.nextHintMs !== undefined) {
				return quietHoursHolder.nextHintMs;
			}
			return nowMs;
		};
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
					defaultModel: activeModelHolder.current,
					now: nowFn,
					...(effectiveTelemetry !== undefined ? { telemetry: effectiveTelemetry } : {}),
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
				getDefaultModel: () => activeModelHolder.current,
				getModels: () => options.models,
				getNow: nowFn,
				getTelemetry: () => effectiveTelemetry,
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
		const enableRoutineTools =
			options.enableRoutines ?? (options.memory?.atomic !== undefined || options.handoff !== undefined);
		const enableClockAnchor =
			options.enableRoutines ??
			(options.utcOffsetMinutes !== undefined ||
				options.memory?.atomic !== undefined ||
				options.handoff !== undefined);
		registry.install(
			createRoutinesExtension({
				enableRoutineTools,
				enableClockAnchor,
				schedulerTask: routineSchedulerTask,
				getUtcOffsetMinutes: () => utcOffsetMinutes,
				getNow: nowFn,
				isRootConversation: (convId) => rootRef !== undefined && convId === rootRef.id,
				getNextQuietFlushAtMs: computeNextQuietFlushAtMs,
				onQuietFlushDue: async (dueAtMs, ctx) => {
					for (const listener of [...quietFlushListeners]) {
						await listener(dueAtMs, ctx);
					}
				},
				...(options.quietFlushRetryBackoffMs !== undefined
					? { quietFlushRetryBackoffMs: options.quietFlushRetryBackoffMs }
					: {}),
			}),
		);
		const hasCustomWebExtension = (options.extensions ?? []).some((ext) => ext.name === JEHEE_WEB_EXTENSION_NAME);
		if (!hasCustomWebExtension) {
			const enableWebFetch =
				options.enableWebFetch ??
				options.webFetch?.enabled ??
				(options.enableRoutines === true || options.memory?.atomic !== undefined || options.handoff !== undefined);
			const effectiveWebSearch = options.webSearch ?? options.webFetch?.webSearch;
			registry.install(
				createWebExtension({
					...options.webFetch,
					enabled: enableWebFetch,
					...(effectiveWebSearch !== undefined ? { webSearch: effectiveWebSearch } : {}),
				}),
			);
		}
		const hasCustomMediaExtension = (options.extensions ?? []).some((ext) => ext.name === JEHEE_MEDIA_EXTENSION_NAME);
		if (!hasCustomMediaExtension) {
			const enableMedia =
				options.enableMedia ??
				(options.enableRoutines === true || options.memory?.atomic !== undefined || options.handoff !== undefined);
			registry.install(
				createOutboundMediaExtension({
					enabled: enableMedia,
					resolveBlob: (handle) => mcpState.bundle?.blobVault.getBlob(handle),
					deliverMedia: async (payload, ctx) => {
						const handler = outboundMediaHandler.current;
						if (handler === undefined) {
							return { ok: false, reason: "No outbound media handler registered on this host." };
						}
						return handler(payload, ctx);
					},
				}),
			);
		}
		if (options.memory !== undefined) {
			registry.install(createMemoryExtension(options.memory, { onRootTurnCompleted }));
			registry.install(createMemoryToolsExtension(options.memory, consolidatorTask));
		} else {
			registry.install(createMemoryToolsExtension(undefined, consolidatorTask));
		}
		if (options.mcp !== undefined) {
			mcpState.hub = await McpConnectorHub.connect(options.mcp.servers, {
				...(options.mcp.bestEffortConnect === true ? { bestEffort: true } : {}),
			});
			if (mcpState.hub.servers().length > 0) {
				const callerApprovalListener = options.mcp.onApprovalRequested;
				mcpState.bundle = createMcpBundle(mcpState.hub, {
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
				for (const ext of mcpState.bundle.extensions) {
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
					...(effectiveTelemetry !== undefined ? { telemetry: effectiveTelemetry } : {}),
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
			const persistedModelDoc = await harness.snapshot(RuntimeModelDoc, context);
			const persistedOverride = persistedModelDoc?.override;
			const initialActiveModel: ModelRef =
				persistedOverride !== undefined &&
				options.models.getModel(persistedOverride.provider, persistedOverride.modelId) !== undefined
					? cloneModelRef(persistedOverride)
					: cloneModelRef(options.defaultModel);
			activeModelHolder.current = initialActiveModel;
			const removedOnRoot =
				workshopBundle?.sandboxExtension !== undefined ? [workshopBundle.sandboxExtension] : undefined;
			const root = await harness.root(context, {
				agent: {
					model: initialActiveModel,
					instructions: options.instructions,
					cwd: options.cwd,
					...(removedOnRoot !== undefined ? { extensions: { remove: removedOnRoot } } : {}),
				},
			});
			rootRef = root;
			await root.configure(
				{
					model: initialActiveModel,
					...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
					...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
					...(removedOnRoot !== undefined ? { extensions: { remove: removedOnRoot } } : {}),
				},
				context,
			);
			if (options.autoResume !== false) {
				harness.resume();
			}
			return new JeheeHost(
				harness,
				registry,
				root,
				options.models,
				cloneModelRef(options.defaultModel),
				activeModelHolder,
				effectiveTelemetry,
				traceRecorder,
				memoryHolder,
				handoffPolicy,
				compactionTracker,
				consolidatorTask,
				routineSchedulerTask,
				routineTracker,
				onRootTurnCompleted,
				proactiveListeners,
				directNotifyListeners,
				approvalListeners,
				quietFlushListeners,
				quietHoursHolder,
				options.quietHours,
				outboundMediaHandler,
				options.mcp,
				mcpState,
				removedOnRoot,
				nowFn,
				utcOffsetMinutes,
			);
		} catch (error) {
			await mcpState.hub?.close();
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
		return this.#mcpState.hub?.servers().map((server) => server.name) ?? [];
	}

	/** Snapshot of connected MCP servers (with tool counts) and sanitized failed-server diagnostics. */
	getMcpStatus(): McpReconnectReport {
		const hub = this.#mcpState.hub;
		if (hub === undefined) {
			return { connected: [], failed: [] };
		}
		return {
			connected: hub.servers().map((server) => ({
				name: server.name,
				toolCount: server.tools.length,
			})),
			failed: hub.failedServers().map((server) => ({
				name: server.name,
				error: server.error,
			})),
		};
	}

	/**
	 * Safely closes the current MCP bundle, reconnects all configured MCP servers (`bestEffort: true`),
	 * atomically swaps old/new MCP extensions in `Registry` and `AgentDoc`, and refreshes the active `McpBlobVault`.
	 * Concurrent invocations are serialized to avoid registry or transport races.
	 */
	async reconnectMcp(context: Context): Promise<McpReconnectReport> {
		if (this.#mcpOptions === undefined || this.#mcpOptions.servers.length === 0) {
			return { connected: [], failed: [] };
		}
		const run = async (): Promise<McpReconnectReport> => {
			const mcpOptions = this.#mcpOptions!;
			const oldHub = this.#mcpState.hub;
			const oldHandles = this.#mcpState.bundle?.extensionHandles ?? [];

			await oldHub?.close().catch(() => undefined);

			const newHub = await McpConnectorHub.connect(mcpOptions.servers, { bestEffort: true });
			const callerApprovalListener = mcpOptions.onApprovalRequested;
			const newBundle =
				newHub.servers().length > 0
					? createMcpBundle(newHub, {
							...mcpOptions,
							onApprovalRequested: async (ticket) => {
								if (callerApprovalListener !== undefined) {
									await callerApprovalListener(ticket);
								}
								for (const listener of this.#approvalListeners) {
									await listener(ticket);
								}
							},
						})
					: undefined;

			for (const oldHandle of oldHandles) {
				this.#registry.uninstall(oldHandle);
			}
			for (const ext of newBundle?.extensions ?? []) {
				this.#registry.install(ext);
			}

			this.#mcpState.hub = newHub;
			this.#mcpState.bundle = newBundle;

			const extensionChange =
				newBundle !== undefined
					? {
							add: newBundle.extensionHandles,
							...(this.#removedOnRoot !== undefined ? { remove: this.#removedOnRoot } : {}),
						}
					: this.#removedOnRoot !== undefined
						? { remove: this.#removedOnRoot }
						: null;
			await this.#root.configure({ extensions: extensionChange }, context);

			return this.getMcpStatus();
		};

		const chained = this.#mcpReconnectChain.then(run, run);
		this.#mcpReconnectChain = chained.then(
			() => undefined,
			() => undefined,
		);
		return chained;
	}

	/** Returns the active runtime model status (combining persisted `RuntimeModelDoc` override and startup default). */
	async getCurrentModel(context: Context): Promise<ModelStatusSummary> {
		const doc = await this.#harness.snapshot(RuntimeModelDoc, context);
		const override = doc?.override;
		const isValidOverride =
			override !== undefined && this.#models.getModel(override.provider, override.modelId) !== undefined;
		const active = isValidOverride ? cloneModelRef(override) : cloneModelRef(this.#defaultModel);
		return {
			active,
			defaultModel: cloneModelRef(this.#defaultModel),
			isOverride: isValidOverride,
			...(isValidOverride && doc?.updatedAtMs !== undefined ? { updatedAtMs: doc.updatedAtMs } : {}),
			utcOffsetMinutes: this.#utcOffsetMinutes,
		};
	}

	/** Lists chat models registered in `Models` (optionally filtered to a single `provider`). */
	listAvailableModels(provider?: string): readonly AvailableModelEntry[] {
		const trimmed = provider?.trim();
		const models =
			trimmed !== undefined && trimmed.length > 0 ? this.#models.getModels(trimmed) : this.#models.getModels();
		return models.map((model) => ({
			provider: model.provider,
			modelId: model.id,
			...(model.name.length > 0 ? { name: model.name } : {}),
		}));
	}

	/** Validates `"<provider>/<modelId>"`, persists it to `RuntimeModelDoc`, and live-applies it on the root conversation. */
	async setModel(modelSpec: string, context: Context): Promise<SetModelResult> {
		const parsed = parseModelRefSpec(modelSpec);
		if (parsed === undefined) {
			return {
				ok: false,
				reason: "invalid_format",
				message: `模型格式无效 "${modelSpec.trim()}"，请使用 "<provider>/<modelId>" 格式。`,
			};
		}
		if (this.#models.getProvider(parsed.provider) === undefined) {
			const known = this.#models
				.getProviders()
				.map((p) => p.id)
				.join(", ");
			return {
				ok: false,
				reason: "unknown_provider",
				message: `未找到模型提供方 "${parsed.provider}"（已注册：${known || "none"}）。`,
			};
		}
		if (this.#models.getModel(parsed.provider, parsed.modelId) === undefined) {
			return {
				ok: false,
				reason: "unknown_model",
				message: `提供方 "${parsed.provider}" 下不存在模型 "${parsed.modelId}"，请使用 /model list 查看可用列表。`,
			};
		}
		const updatedAtMs = this.#now();
		const previous = await this.#root.commit(async (tx) => {
			const doc = await tx.doc(RuntimeModelDoc);
			const prev = readRuntimeModelOverride(doc) ?? cloneModelRef(this.#defaultModel);
			doc.override = { provider: parsed.provider, modelId: parsed.modelId };
			doc.updatedAtMs = updatedAtMs;
			return prev;
		}, context);
		await this.#root.configure({ model: parsed }, context);
		this.#activeModelHolder.current = cloneModelRef(parsed);
		return {
			ok: true,
			model: cloneModelRef(parsed),
			previous,
			updatedAtMs,
		};
	}

	/** Clears any persisted `RuntimeModelDoc` override and restores the startup `defaultModel` live. */
	async resetModel(context: Context): Promise<ResetModelResult> {
		const wasOverride = await this.#root.commit(async (tx) => {
			const doc = await tx.doc(RuntimeModelDoc);
			const hadOverride = doc.override !== undefined;
			delete doc.override;
			delete doc.updatedAtMs;
			return hadOverride;
		}, context);
		await this.#root.configure({ model: this.#defaultModel }, context);
		this.#activeModelHolder.current = cloneModelRef(this.#defaultModel);
		return {
			ok: true,
			model: cloneModelRef(this.#defaultModel),
			wasOverride,
		};
	}

	/** Registers the channel-layer handler delivering outbound photos/documents produced by `send_media`. */
	onOutboundMedia(handler: OutboundMediaHandler): () => void {
		this.#outboundMediaHandler.current = handler;
		return () => {
			if (this.#outboundMediaHandler.current === handler) {
				this.#outboundMediaHandler.current = undefined;
			}
		};
	}

	/** Persists a deferred proactive notification into `HeldNotificationsDoc` and optionally schedules the quiet-end wake alarm. */
	async appendHeldNotification(
		item: HeldProactiveMessage,
		context: Context,
		quietEndMs?: number,
	): Promise<HeldProactiveMessage> {
		const nowMs = this.#now();
		if (quietEndMs !== undefined) {
			this.#quietHoursHolder.nextHintMs =
				this.#quietHoursHolder.nextHintMs === undefined
					? quietEndMs
					: Math.min(this.#quietHoursHolder.nextHintMs, quietEndMs);
		}
		return this.#root.commit(async (tx) => {
			const doc = await tx.doc(HeldNotificationsDoc);
			const stored = appendHeldNotificationInState(doc, item);
			if (quietEndMs !== undefined) {
				await syncRoutineSchedulerInTx(tx, this.#routineSchedulerTask, nowMs, quietEndMs);
			}
			return stored;
		}, context);
	}

	/** Reads durable held proactive notifications from `HeldNotificationsDoc` (optionally filtered to `routeFilter`). */
	async listHeldNotifications(context: Context, routeFilter?: ChannelRoute): Promise<readonly HeldProactiveMessage[]> {
		const doc = (await this.#harness.snapshot(HeldNotificationsDoc, context)) ?? createEmptyHeldNotificationsState();
		return listHeldNotificationsFromState(doc, routeFilter);
	}

	/** Atomically drains held proactive notifications from `HeldNotificationsDoc` (all routes or `routeFilter`). */
	async drainHeldNotifications(
		context: Context,
		routeFilter?: ChannelRoute,
	): Promise<readonly HeldProactiveMessage[]> {
		return this.#root.commit(async (tx) => {
			const doc = await tx.doc(HeldNotificationsDoc);
			const drained = drainHeldNotificationsInState(doc, routeFilter);
			if (doc.items.length === 0) {
				this.#quietHoursHolder.nextHintMs = undefined;
			}
			return drained;
		}, context);
	}

	/** Subscribes to quiet-window-end auto-flush triggers emitted by the single-flight `RoutineSchedulerTask`. */
	onQuietFlushDue(listener: QuietFlushListener, options?: QuietFlushSubscriptionOptions): () => void {
		this.#quietFlushListeners.add(listener);
		const registeredQuietHours = options?.quietHours;
		if (registeredQuietHours !== undefined && this.#quietHoursHolder.current === undefined) {
			this.#quietHoursHolder.current = registeredQuietHours;
		}
		return () => {
			this.#quietFlushListeners.delete(listener);
			if (registeredQuietHours !== undefined && this.#quietHoursHolder.current === registeredQuietHours) {
				this.#quietHoursHolder.current = this.#initialQuietHours;
			}
		};
	}

	/** Configured fixed local UTC offset in minutes used for clock anchor and routines. */
	get utcOffsetMinutes(): number {
		return this.#utcOffsetMinutes;
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
		const content =
			input.images !== undefined && input.images.length > 0
				? [{ type: "text" as const, text: input.text }, ...input.images]
				: input.text;
		const submission: Submission = await this.#root.submit(
			{
				type: "input",
				content,
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
					await this.#persistSubmissionTrace(submission.id, input.text, false, waitCtx);
					return {
						submissionId: submission.id,
						status: "done",
						answerEntryId: settled.answer,
						replyText,
					};
				}
				await this.#persistSubmissionTrace(submission.id, input.text, true, waitCtx);
				return {
					submissionId: submission.id,
					status: "unanswered",
					reason: settled.status === "unanswered" ? settled.reason : "unexpected_submission_type",
				};
			},
			abort: (abortCtx: Context) => submission.abort(abortCtx),
		};
	}

	async #persistSubmissionTrace(
		submissionId: SubmissionId,
		label: string,
		turnError: boolean,
		context: Context,
	): Promise<void> {
		if (this.#traceRecorder === undefined) return;
		try {
			const trace = await this.#traceRecorder.findTraceBySubmissionId(submissionId);
			if (trace === undefined) return;
			const payload = buildPersistedTraceInput(trace, {
				label,
				recordedAtMs: this.#now(),
				submissionId: Number(submissionId),
				turnError,
			});
			await this.#root.commit(async (tx) => {
				const doc = await tx.doc(TraceDoc);
				appendPersistedTrace(doc, payload);
			}, context);
		} catch {
			// Best-effort observability: never block or fail a user turn due to trace persistence.
		}
	}

	/** Lists recently persisted turn traces from SQLite `TraceDoc`, newest first. */
	async listTraces(context: Context, limit: number = 10): Promise<readonly PersistedTraceEntry[]> {
		const doc = await this.#harness.snapshot(TraceDoc, context);
		if (doc === undefined || doc.entries.length === 0) return [];
		const clamped = Math.max(1, Math.min(50, Math.floor(limit)));
		return [...doc.entries].reverse().slice(0, clamped);
	}

	/** Reads one persisted trace entry by numeric `id`, or the newest trace when `id` is omitted. */
	async getTrace(context: Context, id?: number): Promise<PersistedTraceEntry | undefined> {
		const doc = await this.#harness.snapshot(TraceDoc, context);
		if (doc === undefined || doc.entries.length === 0) return undefined;
		if (id === undefined) return doc.entries.at(-1);
		return doc.entries.find((entry) => entry.id === id);
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

	/** Subscribes to unsolicited main-agent replies produced after background workshop reports or agent routines arrive. */
	onProactiveReply(listener: ProactiveReplyListener): () => void {
		this.#proactiveListeners.add(listener);
		return () => {
			this.#proactiveListeners.delete(listener);
		};
	}

	/** Subscribes to zero-token direct proactive notifications emitted by `direct_notify` routines. */
	onDirectNotify(listener: DirectNotifyListener): () => void {
		this.#directNotifyListeners.add(listener);
		return () => {
			this.#directNotifyListeners.delete(listener);
		};
	}

	/** Creates a durable reminder or recurring routine in `RoutineDoc` and syncs the single-flight scheduler task. */
	async createRoutine(input: RoutineCreateInput, context: Context): Promise<RoutineCreateResult> {
		const nowMs = this.#now();
		return this.#root.commit(async (tx) => {
			const doc = await tx.doc(RoutineDoc);
			const result = createRoutineInState(doc, input, nowMs);
			if (result.ok) {
				await syncRoutineSchedulerInTx(tx, this.#routineSchedulerTask, nowMs);
			}
			return result;
		}, context);
	}

	/** Lists scheduled reminders and recurring routines persisted in `RoutineDoc`. */
	async listRoutines(
		context: Context,
		options?: { readonly includeDisabled?: boolean },
	): Promise<readonly RoutineItem[]> {
		const doc = (await this.#harness.snapshot(RoutineDoc, context)) ?? createEmptyRoutineStoreState();
		return listRoutinesFromState(doc, options?.includeDisabled === true);
	}

	/** Deletes (cancels) a scheduled routine by ID in `RoutineDoc` and syncs the single-flight scheduler task. */
	async deleteRoutine(id: string, context: Context): Promise<RoutineDeleteResult> {
		const nowMs = this.#now();
		return this.#root.commit(async (tx) => {
			const doc = await tx.doc(RoutineDoc);
			const result = deleteRoutineInState(doc, id);
			if (result.ok) {
				await syncRoutineSchedulerInTx(tx, this.#routineSchedulerTask, nowMs);
			}
			return result;
		}, context);
	}

	/** Triggers an existing routine immediately (manual run) without altering its recurring schedule. */
	async runRoutineNow(id: string, context: Context): Promise<RoutineRunOutcome> {
		const trimmed = id.trim();
		const fireAtMs = this.#now();
		const target = await this.#root.commit(async (tx) => {
			const doc = await tx.doc(RoutineDoc);
			const found = Object.hasOwn(doc.items, trimmed) ? doc.items[trimmed] : undefined;
			if (found === undefined) return undefined;
			found.runCount += 1;
			found.lastRunAtMs = fireAtMs;
			found.updatedAtMs = fireAtMs;
			return cloneRoutineItem(found);
		}, context);

		if (target === undefined) {
			return { ok: false, reason: "not_found", id: trimmed };
		}

		const endDispatch = this.#routineTracker.beginDispatch();
		try {
			return await dispatchRoutineExecution(
				{
					item: {
						id: target.id,
						title: target.title,
						mode: target.mode,
						payload: target.payload,
						urgency: target.urgency,
						fireAtMs,
					},
					trigger: "manual",
					utcOffsetMinutes: this.#utcOffsetMinutes,
					telemetry: this.#telemetry ?? context.telemetry,
					getRootConversation: async () => this.#root,
					readAssistantText: async (entryId, ctx) => {
						const ansEntry = await this.#root.commit((tx) => tx.entry(AssistantEntry, entryId), ctx);
						const msg = ansEntry?.model?.[0];
						return msg?.role === "assistant" ? extractAssistantText(msg) : "";
					},
					onDirectNotify: async (event) => {
						for (const listener of this.#directNotifyListeners) {
							await listener(event);
						}
					},
					onAgentProactiveReply: async (replyText, answerEntryId, urgency) => {
						for (const listener of this.#proactiveListeners) {
							await listener(replyText, answerEntryId, { urgency });
						}
					},
				},
				context,
			);
		} finally {
			endDispatch();
		}
	}

	/** Reads the persisted last active owner delivery route (`LastRouteDoc`), if any. */
	async getLastActiveRoute(context: Context): Promise<ChannelRoute | undefined> {
		const doc = await this.#harness.snapshot(LastRouteDoc, context);
		if (doc?.channel === undefined || doc.chatId === undefined) return undefined;
		return { channel: doc.channel, chatId: doc.chatId };
	}

	/** Persists the owner's last active `{ channel, chatId }` delivery route into `LastRouteDoc`. */
	async setLastActiveRoute(route: ChannelRoute, context: Context): Promise<void> {
		const nowMs = this.#now();
		await this.#root.commit(async (tx) => {
			const doc = await tx.doc(LastRouteDoc);
			doc.channel = route.channel;
			doc.chatId = route.chatId;
			doc.updatedAtMs = nowMs;
		}, context);
	}

	/**
	 * Waits until the single-flight routine scheduler finishes its scheduled wave:
	 * - When only `once` routines are scheduled, awaits task termination (`waitForTask`);
	 * - When recurring routines exist, awaits the next firing cycle without hanging on future slots.
	 */
	async waitForRoutineScheduler(context: Context): Promise<void> {
		const state = await this.#harness.snapshot(RoutineDoc, context);
		if (state?.scheduledTaskId === undefined) {
			await this.#routineTracker.waitForCurrentDispatch();
			await this.#root.waitForIdle(context);
			return;
		}
		const enabled = Object.values(state.items).filter((item) => item.enabled && item.nextRunAtMs !== undefined);
		const hasRecurring = enabled.some((item) => item.schedule.kind !== "once");
		if (!hasRecurring) {
			await this.#harness.waitForTask(state.scheduledTaskId as TaskId<null>, context);
			await this.#routineTracker.waitForCurrentDispatch();
			await this.#root.waitForIdle(context);
			return;
		}
		const initialRuns = Object.values(state.items).reduce((sum, item) => sum + item.runCount, 0);
		while (!context.abortSignal?.aborted) {
			await this.#routineTracker.waitForCurrentDispatch();
			const current = await this.#harness.snapshot(RoutineDoc, context);
			const currentRuns = Object.values(current?.items ?? {}).reduce((sum, item) => sum + item.runCount, 0);
			if (current?.scheduledTaskId === undefined || currentRuns > initialRuns) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 15));
		}
		await this.#routineTracker.waitForCurrentDispatch();
		await this.#root.waitForIdle(context);
	}

	/**
	 * Waits until all currently due routine dispatches, quiet-hours auto-flushes, and active foreground/background work
	 * triggered by an alarm have settled, without blocking on future recurring slots or retry backoffs.
	 * Designed for Cloudflare DO `alarm()` `ctx.waitUntil`.
	 */
	async waitForDueRoutines(context: Context): Promise<void> {
		await Promise.resolve();
		const deadline = Date.now() + 25_000;
		while (!context.abortSignal?.aborted && Date.now() < deadline) {
			await this.#routineTracker.waitForCurrentDispatch();
			await this.#root.waitForIdle(context);
			const state = await this.#harness.snapshot(RoutineDoc, context);
			const nowMs = this.#now();
			const wake = this.#harness.wake();
			const hasDueRoutine = Object.values(state?.items ?? {}).some(
				(item) => item.enabled && item.nextRunAtMs !== undefined && item.nextRunAtMs <= nowMs + 250,
			);
			const hasDueWake = wake.at !== undefined && wake.at <= nowMs + 250;
			if (!hasDueRoutine && !hasDueWake && !this.#routineTracker.isDispatching() && !wake.active) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		await this.#routineTracker.waitForCurrentDispatch();
		await this.#root.waitForIdle(context);
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

	/** Closes the underlying Harness, disconnects the active MCP servers, and releases storage locks cleanly. */
	async close(context: Context): Promise<void> {
		try {
			await this.#harness.close(context);
		} finally {
			await this.#mcpState.hub?.close();
		}
	}
}
