// `pi-durable` extension for Slice 6A proactive routines & user-side local clock anchor:
// - Single-flight `RoutineSchedulerTask` (`background: true`) with `RoutineWakeSignal` for immediate reschedule;
// - Dual dispatch modes: `direct_notify` (zero LLM tokens) and `agent_prompt` (idempotent root turn + `[SILENT]`);
// - Root-only `routine_create`, `routine_list`, `routine_delete` tools (excluded from workshop subagents);
// - `GenerationTask.beforeRequest` hook injecting immutable per-message local clock anchors on user messages (never system prefix).

import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationHandle,
	type ConversationId,
	defineExtension,
	defineSignal,
	defineTask,
	defineTool,
	type EntryId,
	type Extension,
	GenerationTask,
	hook,
	type TaskId,
	type ToolExecutionResult,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { isSilentReplyText, parseUtcOffsetMinutes } from "../governance/quiet-gate.ts";
import { extractAssistantText } from "../memory/contract.ts";
import { startJeheeRoutineSpan } from "../telemetry/recorder.ts";
import type { DirectNotifyEvent, RoutineMode, RoutineRunOutcome, RoutineSchedule, RoutineUrgency } from "./contract.ts";
import { RoutineDoc } from "./durable-store.ts";
import {
	buildRoutineAgentPrompt,
	claimDueRoutinesInState,
	createEmptyRoutineStoreState,
	createRoutineInState,
	deleteRoutineInState,
	findEarliestNextRunAtMs,
	formatLocalClockLine,
	formatLocalDateTime,
	formatScheduleDescription,
	LOCAL_CLOCK_LINE_PREFIX,
	listRoutinesFromState,
	parseIsoTimestampMs,
	parseTimeOfDay,
} from "./scheduler.ts";

/** Fixed extension slot name for Slice 6A routines scheduler, clock anchor, and root tools. */
export const JEHEE_ROUTINES_EXTENSION_NAME = "jehee.routines";

/** Extension handle referencing `"jehee.routines"` for `configure({ extensions: { remove: [...] } })`. */
export const JEHEE_ROUTINES_EXTENSION_HANDLE: Extension = defineExtension({
	name: JEHEE_ROUTINES_EXTENSION_NAME,
});

/** Tool name for creating a one-shot reminder or recurring routine. */
export const ROUTINE_CREATE_TOOL = "routine_create";

/** Tool name for listing scheduled reminders and routines. */
export const ROUTINE_LIST_TOOL = "routine_list";

/** Tool name for cancelling/deleting a scheduled routine by ID. */
export const ROUTINE_DELETE_TOOL = "routine_delete";

/** Durable signal used to wake a sleeping `RoutineSchedulerTask` when an earlier routine is created or cancelled. */
export const RoutineWakeSignal = defineSignal({
	name: "jehee.routines.wake",
	version: 1,
	schema: obj({ reason: str() }),
});

type DispatchItem = {
	readonly id: string;
	readonly title: string;
	readonly mode: RoutineMode;
	readonly payload: string;
	readonly urgency: RoutineUrgency;
	readonly fireAtMs: number;
};

type RoutineSchedulerState =
	| { readonly phase: "wait"; readonly seq: number; readonly quietFlushBackoffUntilMs?: number }
	| {
			readonly phase: "flushQuiet";
			readonly seq: number;
			readonly dueAtMs: number;
	  }
	| {
			readonly phase: "dispatch";
			readonly seq: number;
			readonly items: readonly DispatchItem[];
			readonly index: number;
			readonly quietFlushBackoffUntilMs?: number;
	  };

/** Lightweight in-memory tracker monitoring active routine dispatch cycles (for DO `alarm()` `waitUntil` & test helpers). */
export type RoutineSchedulerTracker = {
	readonly isDispatching: () => boolean;
	readonly beginDispatch: () => () => void;
	readonly waitForCurrentDispatch: () => Promise<void>;
};

/** Creates a `RoutineSchedulerTracker` shared between `RoutineSchedulerTask` and `JeheeHost`. */
export function createRoutineSchedulerTracker(): RoutineSchedulerTracker {
	let activeCount = 0;
	let waiters: Array<() => void> = [];

	return {
		isDispatching: () => activeCount > 0,
		beginDispatch: () => {
			activeCount += 1;
			let ended = false;
			return () => {
				if (ended) return;
				ended = true;
				activeCount = Math.max(0, activeCount - 1);
				if (activeCount === 0 && waiters.length > 0) {
					const toResolve = waiters;
					waiters = [];
					for (const resolve of toResolve) resolve();
				}
			};
		},
		waitForCurrentDispatch: () => {
			if (activeCount === 0) return Promise.resolve();
			return new Promise<void>((resolve) => {
				waiters.push(resolve);
			});
		},
	};
}

function jsonTextResult(payload: Record<string, unknown>, isError: boolean = false): ToolExecutionResult {
	return {
		output: [{ type: "text", text: JSON.stringify(payload) }],
		...(isError ? { isError: true } : {}),
	};
}

/**
 * Attaches an immutable `[Local Time: ...]` text block onto each user message that lacks one,
 * using each message's own `timestamp` (falling back to `fallbackNowMs`).
 * Never mutates system messages, preserving L1 Core prompt prefix and prior-turn KV-cache hits.
 */
export function attachUserClockAnchors(
	messages: readonly Message[],
	utcOffsetMinutes: number,
	fallbackNowMs: number,
): Message[] {
	return messages.map((msg) => {
		if (msg.role !== "user") return msg;
		if (typeof msg.content === "string") {
			if (msg.content.includes(LOCAL_CLOCK_LINE_PREFIX)) return msg;
			const ts = msg.timestamp > 0 ? msg.timestamp : fallbackNowMs;
			const clockLine = formatLocalClockLine(ts, utcOffsetMinutes);
			return {
				...msg,
				content: [
					{ type: "text" as const, text: msg.content },
					{ type: "text" as const, text: clockLine },
				],
			};
		}
		const alreadyHasClock = msg.content.some(
			(block) => block.type === "text" && block.text.includes(LOCAL_CLOCK_LINE_PREFIX),
		);
		if (alreadyHasClock) return msg;
		const ts = msg.timestamp > 0 ? msg.timestamp : fallbackNowMs;
		const clockLine = formatLocalClockLine(ts, utcOffsetMinutes);
		return {
			...msg,
			content: [...msg.content, { type: "text" as const, text: clockLine }],
		};
	});
}

/** Options for dispatching one fired routine item (used by both `RoutineSchedulerTask` and manual `runRoutineNow`). */
export type DispatchRoutineInput = {
	readonly item: DispatchItem;
	readonly trigger: "scheduled" | "manual";
	readonly utcOffsetMinutes: number;
	readonly telemetry?: TelemetryContext;
	readonly getRootConversation: (context: Context) => Promise<Pick<ConversationHandle, "submit">>;
	readonly readAssistantText: (entryId: EntryId, context: Context) => Promise<string>;
	readonly onDirectNotify: (event: DirectNotifyEvent) => void | Promise<void>;
	readonly onAgentProactiveReply: (
		replyText: string,
		answerEntryId: EntryId,
		urgency: RoutineUrgency,
	) => void | Promise<void>;
};

/** Executes one fired routine (`direct_notify` zero-LLM push or idempotent `agent_prompt` root turn with `[SILENT]` handling). */
export async function dispatchRoutineExecution(
	input: DispatchRoutineInput,
	context: Context,
): Promise<RoutineRunOutcome> {
	const { item, trigger } = input;
	const telemetry = input.telemetry ?? context.telemetry;
	const dedupeKey = `routine:${item.id}:${item.fireAtMs}`;

	return startJeheeRoutineSpan(telemetry)(
		"jehee.routine.fire",
		{
			"routine.id": item.id,
			"routine.mode": item.mode,
			"routine.trigger": trigger,
		},
		async (span) => {
			span.setAttributes({ "routine.fire_at_ms": item.fireAtMs });
			try {
				if (item.mode === "direct_notify") {
					await input.onDirectNotify({
						routineId: item.id,
						title: item.title,
						text: item.payload,
						urgency: item.urgency,
						fireAtMs: item.fireAtMs,
						dedupeKey,
					});
					span.setAttributes({ "routine.suppressed_silent": false, "routine.outcome": "ok" });
					return {
						ok: true,
						routineId: item.id,
						title: item.title,
						mode: "direct_notify",
						deliveredText: item.payload,
						fireAtMs: item.fireAtMs,
					};
				}

				const root = await input.getRootConversation(context);
				const promptText = buildRoutineAgentPrompt(item, item.fireAtMs, input.utcOffsetMinutes);
				const submission = await root.submit(
					{
						type: "input",
						content: promptText,
						whenBusy: "followUp",
						requestId: dedupeKey,
					},
					context,
				);
				const settled = await submission.wait(context);
				if (settled.status !== "done" || settled.type !== "input") {
					const reason = settled.status === "unanswered" ? settled.reason : "unexpected_submission_type";
					span.setAttributes({ "routine.suppressed_silent": false, "routine.outcome": "error" });
					span.setStatus({ status: "error", error: { name: "routine_unanswered", message: reason } });
					return {
						ok: false,
						reason: "unanswered",
						routineId: item.id,
						message: reason,
					};
				}

				const replyText = await input.readAssistantText(settled.answer, context);
				if (isSilentReplyText(replyText)) {
					span.setAttributes({ "routine.suppressed_silent": true, "routine.outcome": "silent" });
					return {
						ok: true,
						routineId: item.id,
						title: item.title,
						mode: "agent_prompt",
						suppressedSilent: true,
						replyText: replyText.trim(),
						fireAtMs: item.fireAtMs,
					};
				}

				await input.onAgentProactiveReply(replyText, settled.answer, item.urgency);
				span.setAttributes({ "routine.suppressed_silent": false, "routine.outcome": "ok" });
				return {
					ok: true,
					routineId: item.id,
					title: item.title,
					mode: "agent_prompt",
					suppressedSilent: false,
					replyText,
					fireAtMs: item.fireAtMs,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				span.setAttributes({ "routine.suppressed_silent": false, "routine.outcome": "error" });
				span.setStatus({ status: "error", error: { name: "delivery_error", message } });
				throw error;
			}
		},
	);
}

/** Default backoff (ms) before retrying a failed quiet-hours auto-flush so transient delivery errors never spin-loop. */
export const DEFAULT_QUIET_FLUSH_RETRY_BACKOFF_MS = 60_000;

type QuietFlushHooks = {
	readonly getNextQuietFlushAtMs?: (nowMs: number, tx?: Tx) => Promise<number | undefined>;
	readonly onQuietFlushDue?: (nowMs: number, context: Context) => Promise<void>;
	readonly quietFlushRetryBackoffMs?: number;
};

// WeakMap keyed by the task token allows callers to supply quiet-flush callbacks either on
// `createRoutineSchedulerTask(...)` or on `createRoutinesExtension(...)` without leaking memory.
const quietFlushBindings = new WeakMap<object, QuietFlushHooks>();

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return Math.min(a, b);
}

/** Options for creating the single-flight background `RoutineSchedulerTask`. */
export type CreateRoutineSchedulerTaskOptions = {
	readonly getUtcOffsetMinutes: () => number;
	readonly getTelemetry: () => TelemetryContext | undefined;
	readonly tracker: RoutineSchedulerTracker;
	readonly onDirectNotify: (event: DirectNotifyEvent) => void | Promise<void>;
	readonly onAgentProactiveReply: (
		replyText: string,
		answerEntryId: EntryId,
		urgency: RoutineUrgency,
	) => void | Promise<void>;
	/**
	 * Optional callback returning the next epoch ms when held quiet-hours notifications should auto-flush.
	 * Invoked inside `runtime.commit(tx)` so callers can read `tx.doc(HeldNotificationsDoc)` atomically with sleep/terminal transitions.
	 */
	readonly getNextQuietFlushAtMs?: (nowMs: number, tx?: Tx) => Promise<number | undefined>;
	/** Optional callback invoked when `getNextQuietFlushAtMs(nowMs, tx) <= nowMs` to flush held quiet-hours notifications. */
	readonly onQuietFlushDue?: (nowMs: number, context: Context) => Promise<void>;
	/** Optional retry backoff (ms) when `onQuietFlushDue` or `getNextQuietFlushAtMs` fails transiently. Defaults to 60_000 ms. */
	readonly quietFlushRetryBackoffMs?: number;
};

/** Creates the single-flight background `pi-durable` task sleeping until the earliest routine or quiet-hours flush timestamp. */
export function createRoutineSchedulerTask(options: CreateRoutineSchedulerTaskOptions) {
	const resolveQuietHooks = (): {
		readonly getNextQuietFlushAtMs?: (nowMs: number, tx?: Tx) => Promise<number | undefined>;
		readonly onQuietFlushDue?: (nowMs: number, context: Context) => Promise<void>;
		readonly retryBackoffMs: number;
	} => {
		const bound = quietFlushBindings.get(taskToken);
		const getNextQuietFlushAtMs = bound?.getNextQuietFlushAtMs ?? options.getNextQuietFlushAtMs;
		const onQuietFlushDue = bound?.onQuietFlushDue ?? options.onQuietFlushDue;
		const retryBackoffMs = Math.max(
			50,
			bound?.quietFlushRetryBackoffMs ?? options.quietFlushRetryBackoffMs ?? DEFAULT_QUIET_FLUSH_RETRY_BACKOFF_MS,
		);
		return {
			...(getNextQuietFlushAtMs !== undefined ? { getNextQuietFlushAtMs } : {}),
			...(onQuietFlushDue !== undefined ? { onQuietFlushDue } : {}),
			retryBackoffMs,
		};
	};

	const taskToken = defineTask<{ readonly triggerAtMs: number }, RoutineSchedulerState, null>({
		name: "jehee.routines.scheduler",
		version: 1,
		initial: () => ({ phase: "wait", seq: 0 }),
		phases: {
			wait: async (task, runtime, context) => {
				const myTaskNum = Number(runtime.taskId);
				const { getNextQuietFlushAtMs, onQuietFlushDue, retryBackoffMs } = resolveQuietHooks();

				await runtime.commit(async (tx) => {
					const doc = await tx.doc(RoutineDoc);
					const nowMs = runtime.now();
					const nextSeq = task.state.checkpoint.seq + 1;
					let backoffUntil = task.state.checkpoint.quietFlushBackoffUntilMs;
					let effectiveQuietFlushAt: number | undefined;

					// Only treat quiet-hours auto-flush as actionable when both lookup and flush callbacks are configured.
					if (getNextQuietFlushAtMs !== undefined && onQuietFlushDue !== undefined) {
						try {
							const rawQuietAt = await getNextQuietFlushAtMs(nowMs, tx);
							if (rawQuietAt === undefined) {
								backoffUntil = undefined;
								effectiveQuietFlushAt = undefined;
							} else if (rawQuietAt > nowMs) {
								backoffUntil = undefined;
								effectiveQuietFlushAt = rawQuietAt;
							} else if (backoffUntil !== undefined && nowMs < backoffUntil) {
								// Respect active retry backoff across routine dispatches and alarm wakes.
								effectiveQuietFlushAt = backoffUntil;
							} else {
								backoffUntil = undefined;
								effectiveQuietFlushAt = rawQuietAt;
							}
						} catch (error) {
							// Isolate transient lookup errors so the single-flight scheduler never faults.
							if (runtime.signal.aborted || context.abortSignal?.aborted) {
								throw error;
							}
							backoffUntil = nowMs + retryBackoffMs;
							effectiveQuietFlushAt = backoffUntil;
						}
					} else {
						backoffUntil = undefined;
					}

					// When quiet flush is immediately due, transition to `flushQuiet` so outbound I/O runs outside `tx`.
					if (effectiveQuietFlushAt !== undefined && effectiveQuietFlushAt <= nowMs) {
						doc.scheduledTaskId = myTaskNum;
						delete doc.wakeSignalKey;
						return {
							status: "running",
							checkpoint: { phase: "flushQuiet", seq: nextSeq, dueAtMs: nowMs },
						} as const;
					}

					const earliestRoutineAt = findEarliestNextRunAtMs(doc);
					if (earliestRoutineAt !== undefined && earliestRoutineAt <= nowMs) {
						const claimed = claimDueRoutinesInState(doc, nowMs);
						doc.scheduledTaskId = myTaskNum;
						delete doc.wakeSignalKey;
						if (claimed.length > 0) {
							const batch: DispatchItem[] = claimed.map(({ item, fireAtMs }) => ({
								id: item.id,
								title: item.title,
								mode: item.mode,
								payload: item.payload,
								urgency: item.urgency,
								fireAtMs,
							}));
							const nextAfterClaim = minDefined(findEarliestNextRunAtMs(doc), effectiveQuietFlushAt);
							if (nextAfterClaim !== undefined) {
								doc.scheduledForMs = nextAfterClaim;
							} else {
								delete doc.scheduledForMs;
							}
							return {
								status: "running",
								checkpoint: {
									phase: "dispatch",
									seq: nextSeq,
									items: batch,
									index: 0,
									...(backoffUntil !== undefined ? { quietFlushBackoffUntilMs: backoffUntil } : {}),
								},
							} as const;
						}
					}

					const nextWakeAt = minDefined(findEarliestNextRunAtMs(doc), effectiveQuietFlushAt);
					if (nextWakeAt === undefined) {
						if (doc.scheduledTaskId === myTaskNum) {
							delete doc.scheduledTaskId;
							delete doc.scheduledForMs;
							delete doc.wakeSignalKey;
						}
						return { status: "terminal", outcome: { status: "completed", result: null } } as const;
					}

					const signalKey = `rtn-wake-${myTaskNum}-${nextSeq}`;
					doc.scheduledTaskId = myTaskNum;
					doc.scheduledForMs = nextWakeAt;
					doc.wakeSignalKey = signalKey;
					return {
						status: "sleeping",
						until: nextWakeAt,
						signals: [RoutineWakeSignal.key(signalKey)],
						checkpoint: {
							phase: "wait",
							seq: nextSeq,
							...(backoffUntil !== undefined ? { quietFlushBackoffUntilMs: backoffUntil } : {}),
						},
					} as const;
				}, context);
			},
			flushQuiet: async (task, runtime, context) => {
				const { seq, dueAtMs } = task.state.checkpoint;
				const { getNextQuietFlushAtMs, onQuietFlushDue, retryBackoffMs } = resolveQuietHooks();
				let flushFailed = false;

				if (onQuietFlushDue !== undefined) {
					const endDispatch = options.tracker.beginDispatch();
					try {
						await onQuietFlushDue(dueAtMs, context);
					} catch (error) {
						// Isolate transient delivery errors so the single-flight scheduler never faults.
						if (runtime.signal.aborted || context.abortSignal?.aborted) {
							throw error;
						}
						flushFailed = true;
					} finally {
						endDispatch();
					}
				}

				await runtime.commit(async (tx) => {
					const postNowMs = runtime.now();
					let backoffUntil: number | undefined;
					if (flushFailed) {
						backoffUntil = postNowMs + retryBackoffMs;
					} else if (getNextQuietFlushAtMs !== undefined && onQuietFlushDue !== undefined) {
						try {
							const postQuietAt = await getNextQuietFlushAtMs(postNowMs, tx);
							// If items remain immediately due even after an attempted flush, apply backoff to prevent busy-spin.
							if (postQuietAt !== undefined && postQuietAt <= postNowMs) {
								backoffUntil = postNowMs + retryBackoffMs;
							}
						} catch (error) {
							if (runtime.signal.aborted || context.abortSignal?.aborted) {
								throw error;
							}
							backoffUntil = postNowMs + retryBackoffMs;
						}
					}
					return {
						status: "running",
						checkpoint: {
							phase: "wait",
							seq,
							...(backoffUntil !== undefined ? { quietFlushBackoffUntilMs: backoffUntil } : {}),
						},
					} as const;
				}, context);
			},
			dispatch: async (task, runtime, context) => {
				const { seq, items, index, quietFlushBackoffUntilMs } = task.state.checkpoint;
				const current = items[index];
				if (current === undefined) {
					await runtime.commit(
						() =>
							({
								status: "running",
								checkpoint: {
									phase: "wait",
									seq,
									...(quietFlushBackoffUntilMs !== undefined ? { quietFlushBackoffUntilMs } : {}),
								},
							}) as const,
						context,
					);
					return;
				}

				const endDispatch = options.tracker.beginDispatch();
				try {
					await dispatchRoutineExecution(
						{
							item: current,
							trigger: "scheduled",
							utcOffsetMinutes: options.getUtcOffsetMinutes(),
							...(options.getTelemetry() !== undefined ? { telemetry: options.getTelemetry() } : {}),
							getRootConversation: async (ctx) => (await runtime.conversation(runtime.conversationId, ctx))!,
							readAssistantText: async (entryId, ctx) => {
								const ansEntry = await runtime.entry(AssistantEntry, entryId, ctx);
								const msg = ansEntry?.model?.[0];
								return msg?.role === "assistant" ? extractAssistantText(msg) : "";
							},
							onDirectNotify: options.onDirectNotify,
							onAgentProactiveReply: options.onAgentProactiveReply,
						},
						context,
					);
				} catch (error) {
					// Preserve single-flight scheduler liveness across transient outbound errors; only propagate cancellation.
					if (runtime.signal.aborted || context.abortSignal?.aborted) {
						throw error;
					}
				} finally {
					endDispatch();
				}

				const nextIndex = index + 1;
				await runtime.commit(
					() =>
						nextIndex < items.length
							? ({
									status: "running",
									checkpoint: {
										phase: "dispatch",
										seq,
										items,
										index: nextIndex,
										...(quietFlushBackoffUntilMs !== undefined ? { quietFlushBackoffUntilMs } : {}),
									},
								} as const)
							: ({
									status: "running",
									checkpoint: {
										phase: "wait",
										seq,
										...(quietFlushBackoffUntilMs !== undefined ? { quietFlushBackoffUntilMs } : {}),
									},
								} as const),
					context,
				);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(RoutineDoc);
				if (doc.scheduledTaskId === Number(runtime.taskId)) {
					delete doc.scheduledTaskId;
					delete doc.scheduledForMs;
					delete doc.wakeSignalKey;
				}
				return { status: "terminal", outcome: { status: "aborted" } } as const;
			}, context);
		},
	});
	return taskToken;
}

/** Type alias for the background single-flight routine scheduler durable task token. */
export type RoutineSchedulerTaskToken = ReturnType<typeof createRoutineSchedulerTask>;

/**
 * Ensures the single-flight `RoutineSchedulerTask` is aligned with `RoutineDoc` (and any optional quiet-hours flush
 * wake target `extraWakeAtMs`) inside `tx`:
 * - Creates the background task if enabled routines or `extraWakeAtMs` exist and none is active;
 * - Wakes a sleeping task via `RoutineWakeSignal` if the schedule changed (new earlier routine, cancellation, or held notification).
 */
export async function syncRoutineSchedulerInTx(
	tx: Tx,
	taskToken: RoutineSchedulerTaskToken,
	_nowMs: number,
	extraWakeAtMs?: number,
): Promise<TaskId<null> | undefined> {
	const doc = await tx.doc(RoutineDoc);
	const earliest = minDefined(findEarliestNextRunAtMs(doc), extraWakeAtMs);

	if (doc.scheduledTaskId !== undefined) {
		const existingId = doc.scheduledTaskId as TaskId<null>;
		const existing = await tx.task(existingId);
		if (existing !== undefined && existing.state.status !== "terminal") {
			if (existing.state.status === "sleeping" && doc.wakeSignalKey !== undefined) {
				const wakeKey = doc.wakeSignalKey;
				delete doc.wakeSignalKey;
				await tx.signal(existingId, RoutineWakeSignal, wakeKey, { reason: "reschedule" });
			}
			if (earliest !== undefined) {
				doc.scheduledForMs = earliest;
			} else {
				delete doc.scheduledForMs;
			}
			return existingId;
		}
		// Previous task already terminated; clear stale pointers.
		delete doc.scheduledTaskId;
		delete doc.scheduledForMs;
		delete doc.wakeSignalKey;
	}

	if (earliest === undefined) return undefined;

	const taskId = await tx.createTask(
		taskToken,
		{ triggerAtMs: earliest },
		{ ownership: { kind: "conversation" }, background: true },
	);
	doc.scheduledTaskId = Number(taskId);
	doc.scheduledForMs = earliest;
	return taskId;
}

function buildScheduleFromToolArgs(
	args: {
		readonly scheduleKind: "once" | "daily" | "weekly" | "interval";
		readonly runAt?: string;
		readonly delaySeconds?: number;
		readonly timeOfDay?: string;
		readonly weekday?: number;
		readonly intervalMinutes?: number;
		readonly utcOffset?: string;
	},
	nowMs: number,
	defaultUtcOffsetMinutes: number,
): { readonly ok: true; readonly schedule: RoutineSchedule } | { readonly ok: false; readonly message: string } {
	let utcOffsetMinutes = defaultUtcOffsetMinutes;
	if (args.utcOffset !== undefined && args.utcOffset.trim().length > 0) {
		try {
			utcOffsetMinutes = parseUtcOffsetMinutes(args.utcOffset);
		} catch (err) {
			return { ok: false, message: err instanceof Error ? err.message : String(err) };
		}
	}

	if (args.scheduleKind === "once") {
		if (args.delaySeconds !== undefined) {
			if (!Number.isFinite(args.delaySeconds) || args.delaySeconds <= 0) {
				return { ok: false, message: "delaySeconds must be a positive number." };
			}
			return { ok: true, schedule: { kind: "once", runAtMs: nowMs + Math.round(args.delaySeconds * 1_000) } };
		}
		if (args.runAt !== undefined && args.runAt.trim().length > 0) {
			try {
				const runAtMs = parseIsoTimestampMs(args.runAt, utcOffsetMinutes);
				return { ok: true, schedule: { kind: "once", runAtMs } };
			} catch (err) {
				return { ok: false, message: err instanceof Error ? err.message : String(err) };
			}
		}
		return { ok: false, message: 'scheduleKind="once" requires either `runAt` or `delaySeconds`.' };
	}

	if (args.scheduleKind === "daily") {
		if (args.timeOfDay === undefined) {
			return { ok: false, message: 'scheduleKind="daily" requires `timeOfDay` in "HH:MM" format.' };
		}
		try {
			const { hour, minute } = parseTimeOfDay(args.timeOfDay);
			return { ok: true, schedule: { kind: "daily", hour, minute, utcOffsetMinutes } };
		} catch (err) {
			return { ok: false, message: err instanceof Error ? err.message : String(err) };
		}
	}

	if (args.scheduleKind === "weekly") {
		if (args.timeOfDay === undefined || args.weekday === undefined) {
			return {
				ok: false,
				message: 'scheduleKind="weekly" requires both `weekday` (0=Sun..6=Sat) and `timeOfDay` ("HH:MM").',
			};
		}
		try {
			const { hour, minute } = parseTimeOfDay(args.timeOfDay);
			return { ok: true, schedule: { kind: "weekly", weekday: args.weekday, hour, minute, utcOffsetMinutes } };
		} catch (err) {
			return { ok: false, message: err instanceof Error ? err.message : String(err) };
		}
	}

	// interval
	if (args.intervalMinutes === undefined || !Number.isFinite(args.intervalMinutes) || args.intervalMinutes < 1) {
		return { ok: false, message: 'scheduleKind="interval" requires `intervalMinutes` >= 1.' };
	}
	return {
		ok: true,
		schedule: { kind: "interval", intervalMs: Math.round(args.intervalMinutes * 60_000), anchorMs: nowMs },
	};
}

function createRoutineTools(options: {
	readonly schedulerTask: RoutineSchedulerTaskToken;
	readonly getUtcOffsetMinutes: () => number;
}): readonly ToolRegistration[] {
	const createTool = defineTool({
		name: ROUTINE_CREATE_TOOL,
		description:
			'Schedule a durable one-shot reminder or recurring routine. Use mode="direct_notify" for simple reminders (zero LLM tokens at fire time) and mode="agent_prompt" for periodic checks/briefings that may run tools or reply "[SILENT]" when nothing needs attention.',
		parameters: obj({
			title: str({ description: "Short human-readable name for the reminder or routine." }),
			mode: oneOf(["direct_notify", "agent_prompt"] as const, {
				description: '"direct_notify" pushes payload directly (0 LLM tokens); "agent_prompt" invokes Jehee.',
			}),
			payload: str({ description: "Reminder message text (direct_notify) or task prompt (agent_prompt)." }),
			scheduleKind: oneOf(["once", "daily", "weekly", "interval"] as const),
			runAt: opt(
				str({
					description:
						'For scheduleKind="once": ISO-8601 timestamp (e.g. "2026-11-25T15:00:00+08:00" or local "2026-11-25 15:00").',
				}),
			),
			delaySeconds: opt(
				int({ description: 'For scheduleKind="once": relative delay in seconds from now (e.g. 1800 for 30m).' }),
			),
			timeOfDay: opt(str({ description: 'For "daily"/"weekly": 24-hour local time "HH:MM" (e.g. "09:00").' })),
			weekday: opt(int({ description: 'For "weekly": local day of week 0=Sun, 1=Mon, ..., 6=Sat.' })),
			intervalMinutes: opt(int({ description: 'For "interval": repeat interval in minutes (>= 1).' })),
			utcOffset: opt(str({ description: 'Optional UTC offset override (e.g. "+08:00"). Defaults to host offset.' })),
			urgency: opt(
				oneOf(["normal", "urgent"] as const, {
					description: '"normal" respects quiet hours; "urgent" bypasses quiet hours.',
				}),
			),
		}),
		execute: async (args, api, context) => {
			const nowMs = api.now();
			const defaultOffset = options.getUtcOffsetMinutes();
			const built = buildScheduleFromToolArgs(args, nowMs, defaultOffset);
			if (!built.ok) {
				return jsonTextResult({ ok: false, reason: "invalid_input", message: built.message }, true);
			}
			const created = await api.commit(async (tx) => {
				const doc = await tx.doc(RoutineDoc);
				const res = createRoutineInState(
					doc,
					{
						title: args.title,
						mode: args.mode,
						payload: args.payload,
						schedule: built.schedule,
						...(args.urgency !== undefined ? { urgency: args.urgency } : {}),
					},
					nowMs,
				);
				if (res.ok) {
					await syncRoutineSchedulerInTx(tx, options.schedulerTask, nowMs);
				}
				return res;
			}, context);

			if (!created.ok) {
				return jsonTextResult({ ok: false, reason: created.reason, message: created.message }, true);
			}
			return jsonTextResult({
				ok: true,
				id: created.item.id,
				title: created.item.title,
				mode: created.item.mode,
				schedule: formatScheduleDescription(created.item.schedule),
				nextRunAt:
					created.item.nextRunAtMs !== undefined
						? formatLocalDateTime(created.item.nextRunAtMs, defaultOffset)
						: undefined,
				nextRunAtMs: created.item.nextRunAtMs,
			});
		},
	});

	const listTool = defineTool({
		name: ROUTINE_LIST_TOOL,
		description: "List scheduled reminders and recurring routines persisted in RoutineDoc.",
		parameters: obj({
			includeDisabled: opt(bool({ description: "Include completed or disabled routines (default false)." })),
		}),
		execute: async (args, api, context) => {
			const doc = (await api.snapshot(RoutineDoc, context)) ?? createEmptyRoutineStoreState();
			const items = listRoutinesFromState(doc, args.includeDisabled === true);
			const defaultOffset = options.getUtcOffsetMinutes();
			return jsonTextResult({
				ok: true,
				count: items.length,
				items: items.map((item) => ({
					id: item.id,
					title: item.title,
					mode: item.mode,
					payload: item.payload,
					urgency: item.urgency,
					enabled: item.enabled,
					schedule: formatScheduleDescription(item.schedule),
					runCount: item.runCount,
					...(item.nextRunAtMs !== undefined
						? { nextRunAt: formatLocalDateTime(item.nextRunAtMs, defaultOffset), nextRunAtMs: item.nextRunAtMs }
						: {}),
				})),
			});
		},
	});

	const deleteTool = defineTool({
		name: ROUTINE_DELETE_TOOL,
		description: "Cancel and delete a scheduled reminder or routine by its ID (e.g. rtn_0001).",
		parameters: obj({
			id: str({ description: "Routine ID to delete." }),
		}),
		execute: async (args, api, context) => {
			const nowMs = api.now();
			const deleted = await api.commit(async (tx) => {
				const doc = await tx.doc(RoutineDoc);
				const res = deleteRoutineInState(doc, args.id);
				if (res.ok) {
					await syncRoutineSchedulerInTx(tx, options.schedulerTask, nowMs);
				}
				return res;
			}, context);

			if (!deleted.ok) {
				return jsonTextResult(
					{ ok: false, reason: "not_found", message: `Routine "${deleted.id}" not found.` },
					true,
				);
			}
			return jsonTextResult({
				ok: true,
				id: deleted.item.id,
				title: deleted.item.title,
			});
		},
	});

	return [createTool, listTool, deleteTool];
}

/** Options for wiring the `"jehee.routines"` extension onto `JeheeHost`. */
export type CreateRoutinesExtensionOptions = {
	/** Whether to expose eager `routine_create` / `routine_list` / `routine_delete` tools on root conversation. */
	readonly enableRoutineTools: boolean;
	/** Whether to inject immutable `[Local Time: ...]` anchors onto root user messages in `beforeRequest`. */
	readonly enableClockAnchor?: boolean;
	readonly schedulerTask: RoutineSchedulerTaskToken;
	readonly getUtcOffsetMinutes: () => number;
	readonly getNow: () => number;
	readonly isRootConversation: (conversationId: ConversationId) => boolean;
	/**
	 * Optional callback returning the next epoch ms when held quiet-hours notifications should auto-flush.
	 * Invoked inside `runtime.commit(tx)` so callers can read `tx.doc(HeldNotificationsDoc)` atomically with sleep/terminal transitions.
	 */
	readonly getNextQuietFlushAtMs?: (nowMs: number, tx?: Tx) => Promise<number | undefined>;
	/** Optional callback invoked when `getNextQuietFlushAtMs(nowMs, tx) <= nowMs` to flush held quiet-hours notifications. */
	readonly onQuietFlushDue?: (nowMs: number, context: Context) => Promise<void>;
	/** Optional retry backoff (ms) when `onQuietFlushDue` or `getNextQuietFlushAtMs` fails transiently. Defaults to 60_000 ms. */
	readonly quietFlushRetryBackoffMs?: number;
};

/** Creates the `"jehee.routines"` extension: background scheduler task, user-side clock anchor hook, and optional root tools. */
export function createRoutinesExtension(options: CreateRoutinesExtensionOptions): Extension {
	if (
		options.getNextQuietFlushAtMs !== undefined ||
		options.onQuietFlushDue !== undefined ||
		options.quietFlushRetryBackoffMs !== undefined
	) {
		quietFlushBindings.set(options.schedulerTask, {
			...(options.getNextQuietFlushAtMs !== undefined
				? { getNextQuietFlushAtMs: options.getNextQuietFlushAtMs }
				: {}),
			...(options.onQuietFlushDue !== undefined ? { onQuietFlushDue: options.onQuietFlushDue } : {}),
			...(options.quietFlushRetryBackoffMs !== undefined
				? { quietFlushRetryBackoffMs: options.quietFlushRetryBackoffMs }
				: {}),
		});
	}
	const injectClock = options.enableClockAnchor ?? options.enableRoutineTools;
	return defineExtension({
		name: JEHEE_ROUTINES_EXTENSION_NAME,
		tasks: [options.schedulerTask],
		tools: options.enableRoutineTools
			? [
					...createRoutineTools({
						schedulerTask: options.schedulerTask,
						getUtcOffsetMinutes: options.getUtcOffsetMinutes,
					}),
				]
			: [],
		hooks: injectClock
			? [
					hook(GenerationTask, {
						beforeRequest: async (request, api) => {
							if (!options.isRootConversation(api.conversationId)) return undefined;
							return {
								messages: attachUserClockAnchors(
									request.messages,
									options.getUtcOffsetMinutes(),
									options.getNow(),
								),
							};
						},
					}),
				]
			: [],
	});
}
