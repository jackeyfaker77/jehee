// Anti-corruption bridge adapting a pure Jehee MemoryProvider into `pi-durable` extensions.
// Keeps `pi-durable` coupling isolated here: `jehee.memory` provides the L1 Core prompt section and turn hooks,
// while `jehee.memory.tools` mounts `memory_save` / `memory_search` / `memory_forget` and the single-flight idle
// `MemoryConsolidatorTask` on the root conversation only.

import type { Context } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	type Cursor,
	defineExtension,
	defineTask,
	defineTool,
	type EntryRecord,
	type Extension,
	GenerationTask,
	hook,
	LiveDoc,
	type ModelRef,
	section,
	type TaskId,
	type ToolExecutionResult,
	type ToolRegistration,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";
import { arr, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { startJeheeMemorySpan } from "../telemetry/recorder.ts";
import { createEmptyMemoryStoreState } from "./atomic-memory.ts";
import {
	applyConsolidationPlan,
	buildConsolidationUserPrompt,
	CONSOLIDATION_SYSTEM_PROMPT,
	type ConsolidationDialogueTurn,
	parseConsolidationPlan,
} from "./consolidator.ts";
import {
	type AtomicMemoryController,
	extractAssistantText,
	extractUserText,
	type MemoryConsolidationReport,
	type MemoryProvider,
} from "./contract.ts";
import { MemoryConsolidationDoc, MemoryDoc } from "./durable-store.ts";

/** Fixed extension slot name for L1 Core prompt section and turn hooks (shared with workshop subagents). */
export const JEHEE_MEMORY_EXTENSION_NAME = "jehee.memory";

/** Fixed extension slot name for atomic memory read/write tools & background consolidator (kept off workshop subagents). */
export const JEHEE_MEMORY_TOOLS_EXTENSION_NAME = "jehee.memory.tools";

/** Extension handle referencing `"jehee.memory.tools"` for `configure({ extensions: { remove: [...] } })`. */
export const JEHEE_MEMORY_TOOLS_EXTENSION_HANDLE: Extension = defineExtension({
	name: JEHEE_MEMORY_TOOLS_EXTENSION_NAME,
});

/** Tool name for saving or updating an atomic memory item. */
export const MEMORY_SAVE_TOOL = "memory_save";

/** Tool name for searching active atomic memories on demand. */
export const MEMORY_SEARCH_TOOL = "memory_search";

/** Tool name for soft-deleting (forgetting) an atomic memory item. */
export const MEMORY_FORGET_TOOL = "memory_forget";

const MAX_SCAN_ENTRIES = 500;
const BUSY_RECHECK_FLOOR_MS = 250;
const BUSY_RECHECK_CAP_MS = 30_000;

function jsonTextResult(payload: Record<string, unknown>, isError: boolean = false): ToolExecutionResult {
	return {
		output: [{ type: "text", text: JSON.stringify(payload) }],
		...(isError ? { isError: true } : {}),
	};
}

/** Shared runner options for executing one incremental memory consolidation pass (manual or idle). */
export type RunMemoryConsolidationInput = {
	readonly trigger: "manual" | "idle";
	readonly force?: boolean;
	readonly conversationId: ConversationId;
	readonly atomic: AtomicMemoryController;
	readonly models: Models;
	readonly defaultModel: ModelRef;
	readonly now: () => number;
	readonly telemetry?: TelemetryContext;
	readonly signal?: AbortSignal;
	readonly commit: <T>(change: (tx: Tx) => T | Promise<T>, context: Context) => Promise<T>;
};

function extractDialogueTurns(entries: readonly EntryRecord[]): {
	readonly turns: ConsolidationDialogueTurn[];
	readonly userTurnsCount: number;
	readonly maxEntryId?: string;
} {
	const turns: ConsolidationDialogueTurn[] = [];
	let userTurnsCount = 0;
	let maxEntryId: string | undefined;

	for (const entry of entries) {
		maxEntryId = String(entry.id);
		const firstMsg = entry.model?.[0];
		if (UserEntry.is(entry) && firstMsg?.role === "user") {
			const text = extractUserText(firstMsg).trim();
			if (text.length > 0) {
				userTurnsCount += 1;
				turns.push({ entryId: String(entry.id), role: "user", text });
			}
		} else if (AssistantEntry.is(entry) && firstMsg?.role === "assistant" && firstMsg.stopReason === "stop") {
			const text = extractAssistantText(firstMsg).trim();
			if (text.length > 0) {
				turns.push({ entryId: String(entry.id), role: "assistant", text });
			}
		}
	}

	return {
		turns,
		userTurnsCount,
		...(maxEntryId !== undefined ? { maxEntryId } : {}),
	};
}

async function scanNewEntriesSince(
	tx: Tx,
	conversationId: ConversationId,
	lastConsolidatedEntryId: string | undefined,
): Promise<EntryRecord[]> {
	const lastNumeric = lastConsolidatedEntryId !== undefined ? Number(lastConsolidatedEntryId) : undefined;
	const collected: EntryRecord[] = [];
	let cursor: Cursor | undefined;

	while (collected.length < MAX_SCAN_ENTRIES) {
		const page = await tx.scanEntries({ conversationId, order: "descending" }, 100, cursor);
		let reachedWatermark = false;
		for (const item of page.items) {
			if (lastNumeric !== undefined && Number(item.id) <= lastNumeric) {
				reachedWatermark = true;
				break;
			}
			collected.push(item);
			if (collected.length >= MAX_SCAN_ENTRIES) break;
		}
		if (reachedWatermark || page.next === undefined) break;
		cursor = page.next;
	}

	collected.reverse();
	return collected;
}

/**
 * Executes one incremental memory consolidation pass:
 * 1. Scans transcript entries strictly after `lastConsolidatedEntryId` (high-water mark);
 * 2. Calls the configured consolidation model (or `defaultModel`) with `cacheRetention: "none"` for a strict JSON patch;
 * 3. Validates and atomically applies ops onto `MemoryDoc` and advances `MemoryConsolidationDoc` in a single commit.
 */
export async function executeMemoryConsolidation(
	input: RunMemoryConsolidationInput,
	context: Context,
): Promise<MemoryConsolidationReport> {
	const telemetry = input.telemetry ?? context.telemetry;
	return startJeheeMemorySpan(telemetry)(
		"jehee.memory.consolidate",
		{ "memory.trigger": input.trigger },
		async (span) => {
			// Stage 1: Snapshot active memories (cloned out of the tx overlay), watermark, and incremental dialogue turns.
			const stage1 = await input.commit(async (tx) => {
				const memDoc = await tx.doc(MemoryDoc);
				const cDoc = await tx.doc(MemoryConsolidationDoc);
				const newEntries = await scanNewEntriesSince(tx, input.conversationId, cDoc.lastConsolidatedEntryId);
				const activeItems = Object.values(memDoc.items)
					.filter((item) => item.status === "active")
					.sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id))
					.map((item) => ({
						...item,
						keywords: [...item.keywords],
						aliases: [...item.aliases],
					}));
				const maxItemUpdatedMs = activeItems.reduce((acc, item) => Math.max(acc, item.updatedAtMs), 0);
				return {
					activeItems,
					memorySeq: memDoc.seq,
					maxItemUpdatedMs,
					lastConsolidatedMemorySeq: cDoc.lastConsolidatedMemorySeq,
					lastConsolidatedAtMs: cDoc.lastConsolidatedAtMs,
					...extractDialogueTurns(newEntries),
				};
			}, context);

			const hasMemoryChangesSinceLastRun =
				stage1.lastConsolidatedMemorySeq === undefined
					? stage1.activeItems.length >= 2
					: stage1.memorySeq !== stage1.lastConsolidatedMemorySeq ||
						stage1.maxItemUpdatedMs > (stage1.lastConsolidatedAtMs ?? 0);

			if (input.trigger === "idle") {
				if (stage1.userTurnsCount === 0) {
					span.setAttributes({ "memory.turns_scanned": 0, "memory.outcome": "noop" });
					return { status: "noop", trigger: "idle", reason: "no_new_activity", turnsScanned: 0 };
				}
				if (stage1.userTurnsCount < input.atomic.consolidation.minNewTurns) {
					span.setAttributes({ "memory.turns_scanned": stage1.userTurnsCount, "memory.outcome": "noop" });
					return {
						status: "noop",
						trigger: "idle",
						reason: "below_min_turns",
						turnsScanned: stage1.userTurnsCount,
					};
				}
			} else if (input.force !== true && stage1.turns.length === 0 && !hasMemoryChangesSinceLastRun) {
				span.setAttributes({ "memory.turns_scanned": 0, "memory.outcome": "noop" });
				return { status: "noop", trigger: "manual", reason: "no_new_activity", turnsScanned: 0 };
			}

			// Stage 2: Invoke consolidation model with cacheRetention: "none".
			const modelRef = input.atomic.consolidation.model ?? input.defaultModel;
			const model = input.models.getModel(modelRef.provider, modelRef.modelId);
			if (model === undefined) {
				const message = `Consolidation model "${modelRef.provider}/${modelRef.modelId}" not found.`;
				await input.commit(async (tx) => {
					const cDoc = await tx.doc(MemoryConsolidationDoc);
					cDoc.lastRunStatus = "error";
					cDoc.lastError = message;
				}, context);
				span.setAttributes({ "memory.turns_scanned": stage1.userTurnsCount, "memory.outcome": "error" });
				span.setStatus({ status: "error", error: { name: "model_not_found", message } });
				return { status: "error", trigger: input.trigger, message };
			}

			const promptNow = input.now();
			const messages: Message[] = [
				{ role: "system", content: CONSOLIDATION_SYSTEM_PROMPT, timestamp: promptNow },
				{
					role: "user",
					content: [{ type: "text", text: buildConsolidationUserPrompt(stage1.activeItems, stage1.turns) }],
					timestamp: promptNow,
				},
			];

			let rawText: string;
			try {
				const reply = await input.models.completeSimple(
					model,
					{ messages },
					{
						cacheRetention: "none",
						sessionId: `jehee-memory-consolidation-${String(input.conversationId)}`,
						telemetry: span,
						...(input.signal !== undefined
							? { signal: input.signal }
							: context.abortSignal !== undefined
								? { signal: context.abortSignal }
								: {}),
					},
				);
				if (reply.stopReason === "error") {
					throw new Error(reply.errorMessage ?? "Consolidation model returned error stopReason.");
				}
				rawText = extractAssistantText(reply);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await input.commit(async (tx) => {
					const cDoc = await tx.doc(MemoryConsolidationDoc);
					cDoc.lastRunStatus = "error";
					cDoc.lastError = message;
				}, context);
				span.setAttributes({ "memory.turns_scanned": stage1.userTurnsCount, "memory.outcome": "error" });
				span.setStatus({ status: "error", error: { name: "consolidation_llm_error", message } });
				return { status: "error", trigger: input.trigger, message };
			}

			// Stage 3: Strictly validate JSON patch; on invalid output, do NOT advance watermark.
			const parsed = parseConsolidationPlan(rawText);
			if (!parsed.ok) {
				await input.commit(async (tx) => {
					const cDoc = await tx.doc(MemoryConsolidationDoc);
					cDoc.lastRunStatus = "error";
					cDoc.lastError = parsed.error;
				}, context);
				span.setAttributes({ "memory.turns_scanned": stage1.userTurnsCount, "memory.outcome": "error" });
				span.setStatus({ status: "error", error: { name: "invalid_consolidation_plan", message: parsed.error } });
				return { status: "error", trigger: input.trigger, message: parsed.error };
			}

			// Stage 4: Atomically apply patch onto MemoryDoc and advance MemoryConsolidationDoc watermark.
			const commitNow = input.now();
			const applied = await input.commit(async (tx) => {
				const memDoc = await tx.doc(MemoryDoc);
				const cDoc = await tx.doc(MemoryConsolidationDoc);
				const outcome = applyConsolidationPlan(memDoc, parsed.plan, input.atomic, commitNow);
				if (stage1.maxEntryId !== undefined) {
					cDoc.lastConsolidatedEntryId = stage1.maxEntryId;
				}
				cDoc.lastConsolidatedMemorySeq = memDoc.seq;
				cDoc.lastConsolidatedAtMs = commitNow;
				cDoc.lastRunStatus = "ok";
				if (parsed.plan.summary !== undefined) {
					cDoc.lastRunSummary = parsed.plan.summary;
				} else {
					delete cDoc.lastRunSummary;
				}
				delete cDoc.lastError;
				cDoc.totalRuns += 1;
				cDoc.totalAdded += outcome.added;
				cDoc.totalUpdated += outcome.updated;
				cDoc.totalMerged += outcome.merged;
				cDoc.totalSuperseded += outcome.superseded;
				cDoc.totalForgotten += outcome.forgotten;
				return outcome;
			}, context);

			span.setAttributes({
				"memory.turns_scanned": stage1.userTurnsCount,
				"memory.added": applied.added,
				"memory.updated": applied.updated,
				"memory.merged": applied.merged,
				"memory.superseded": applied.superseded,
				"memory.forgotten": applied.forgotten,
				"memory.skipped": applied.skipped,
				"memory.outcome": "ok",
			});

			return {
				status: "ok",
				trigger: input.trigger,
				turnsScanned: stage1.userTurnsCount,
				added: applied.added,
				updated: applied.updated,
				merged: applied.merged,
				superseded: applied.superseded,
				forgotten: applied.forgotten,
				skipped: applied.skipped,
				skippedReasons: applied.skippedReasons,
				...(parsed.plan.summary !== undefined ? { summary: parsed.plan.summary } : {}),
				...(stage1.maxEntryId !== undefined ? { watermarkEntryId: stage1.maxEntryId } : {}),
			};
		},
	);
}

type ConsolidatorTaskState = { readonly phase: "wait" } | { readonly phase: "run" };

/** Creates the single-flight background `pi-durable` task that wakes after `idleDelayMs` to consolidate memory. */
export function createMemoryConsolidatorTask(options: {
	readonly getAtomic: () => AtomicMemoryController | undefined;
	readonly defaultModel: ModelRef;
	readonly telemetry?: TelemetryContext;
}) {
	return defineTask<{ readonly triggerAtMs: number }, ConsolidatorTaskState, null>({
		name: "jehee.memory.consolidator",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (task, runtime, context) => {
				await runtime.commit(async (tx) => {
					const cDoc = await tx.doc(MemoryConsolidationDoc);
					const atomic = options.getAtomic();
					const myTaskNum = Number(runtime.taskId);
					if (atomic === undefined || atomic.consolidation.idleDelayMs <= 0) {
						if (cDoc.scheduledTaskId === myTaskNum) {
							delete cDoc.scheduledTaskId;
							delete cDoc.scheduledForMs;
						}
						return { status: "terminal", outcome: { status: "completed", result: null } } as const;
					}

					const nowMs = runtime.now();
					const idleDelayMs = atomic.consolidation.idleDelayMs;
					const lastActivity = cDoc.lastActivityAtMs ?? task.input.triggerAtMs - idleDelayMs;
					const dueAt = lastActivity + idleDelayMs;

					// Defer if new user activity pushed the idle deadline forward.
					if (nowMs < dueAt) {
						cDoc.scheduledTaskId = myTaskNum;
						cDoc.scheduledForMs = dueAt;
						return { status: "sleeping", until: dueAt, checkpoint: { phase: "wait" } } as const;
					}

					// Yield if root conversation is currently busy in a foreground turn.
					const live = await tx.doc(LiveDoc, runtime.conversationId);
					if (live.run !== undefined && live.run.afterRun === undefined) {
						const recheckMs = Math.max(BUSY_RECHECK_FLOOR_MS, Math.min(idleDelayMs, BUSY_RECHECK_CAP_MS));
						const nextAt = nowMs + recheckMs;
						cDoc.scheduledForMs = nextAt;
						return { status: "sleeping", until: nextAt, checkpoint: { phase: "wait" } } as const;
					}

					return { status: "running", checkpoint: { phase: "run" } } as const;
				}, context);
			},
			run: async (_task, runtime, context) => {
				const atomic = options.getAtomic();
				if (atomic !== undefined && atomic.consolidation.idleDelayMs > 0) {
					await executeMemoryConsolidation(
						{
							trigger: "idle",
							conversationId: runtime.conversationId,
							atomic,
							models: runtime.models,
							defaultModel: options.defaultModel,
							now: () => runtime.now(),
							...(options.telemetry !== undefined ? { telemetry: options.telemetry } : {}),
							signal: runtime.signal,
							// Capture callback value without returning it to `runtime.commit`, which treats returned objects as TaskState replacements.
							commit: async <T>(change: (tx: Tx) => T | Promise<T>, ctx: Context): Promise<T> => {
								let result!: T;
								await runtime.commit(async (tx) => {
									result = await change(tx);
								}, ctx);
								return result;
							},
						},
						context,
					);
				}

				await runtime.commit(async (tx) => {
					const cDoc = await tx.doc(MemoryConsolidationDoc);
					if (cDoc.scheduledTaskId === Number(runtime.taskId)) {
						delete cDoc.scheduledTaskId;
						delete cDoc.scheduledForMs;
					}
					return { status: "terminal", outcome: { status: "completed", result: null } } as const;
				}, context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const cDoc = await tx.doc(MemoryConsolidationDoc);
				if (cDoc.scheduledTaskId === Number(runtime.taskId)) {
					delete cDoc.scheduledTaskId;
					delete cDoc.scheduledForMs;
				}
				return { status: "terminal", outcome: { status: "aborted" } } as const;
			}, context);
		},
	});
}

/** Type alias for the background memory consolidator durable task token. */
export type MemoryConsolidatorTaskToken = ReturnType<typeof createMemoryConsolidatorTask>;

/** Schedules or refreshes the single-flight idle consolidation timer inside `tx` on the root conversation. */
export async function scheduleIdleConsolidationInTx(
	tx: Tx,
	taskToken: MemoryConsolidatorTaskToken,
	nowMs: number,
	idleDelayMs: number,
): Promise<TaskId<null> | undefined> {
	const cDoc = await tx.doc(MemoryConsolidationDoc);
	cDoc.lastActivityAtMs = nowMs;
	if (idleDelayMs <= 0) return undefined;

	const dueAt = nowMs + idleDelayMs;
	if (cDoc.scheduledTaskId !== undefined) {
		const existingId = cDoc.scheduledTaskId as TaskId<null>;
		const existing = await tx.task(existingId);
		if (existing !== undefined && existing.state.status !== "terminal") {
			cDoc.scheduledForMs = dueAt;
			return existingId;
		}
	}

	const taskId = await tx.createTask(
		taskToken,
		{ triggerAtMs: dueAt },
		{ ownership: { kind: "conversation" }, background: true },
	);
	cDoc.scheduledTaskId = Number(taskId);
	cDoc.scheduledForMs = dueAt;
	return taskId;
}

function createAtomicMemoryTools(atomic: AtomicMemoryController): readonly ToolRegistration[] {
	const saveTool = defineTool({
		name: MEMORY_SAVE_TOOL,
		description:
			'Persist a durable memory item. Use kind="core" ONLY for rare, long-term stable user preferences or hard rules (always injected into system prompt). Use kind="fact" | "episode" | "active" for events, schedules, project details, and ongoing tasks (searched on demand without busting prompt cache). Provide `keywords` and `aliases` (nicknames, abbreviations, bilingual terms) to improve recall.',
		parameters: obj({
			kind: oneOf(["core", "fact", "episode", "active"] as const),
			content: str({ description: "Concise, human-readable statement to remember." }),
			keywords: opt(arr(str(), { description: "Search keywords." })),
			aliases: opt(arr(str(), { description: "Alternative names, nicknames, abbreviations, or translations." })),
			validFrom: opt(str({ description: "Optional ISO date (YYYY-MM-DD) when this memory starts applying." })),
			validUntil: opt(str({ description: "Optional ISO date (YYYY-MM-DD) when this memory stops applying." })),
			sourceRef: opt(str({ description: "Optional external provenance URI or workshop task reference." })),
			id: opt(str({ description: "Existing memory ID (e.g. mem_0001) to update in place." })),
		}),
		execute: async (args, api, context) => {
			return startJeheeMemorySpan(context.telemetry)(
				"jehee.memory.save",
				{ "memory.kind": args.kind },
				async (span) => {
					const outcome = await api.commit(async (tx) => {
						const latestPage = await tx.scanEntries(
							{ conversationId: api.conversationId, order: "descending" },
							20,
						);
						const latestUserEntry = latestPage.items.find((entry) => UserEntry.is(entry));
						const sourceEntryId = latestUserEntry !== undefined ? String(latestUserEntry.id) : undefined;
						const doc = await tx.doc(MemoryDoc);
						return atomic.save(
							doc,
							{
								kind: args.kind,
								content: args.content,
								...(args.id !== undefined ? { id: args.id } : {}),
								...(args.keywords !== undefined ? { keywords: args.keywords } : {}),
								...(args.aliases !== undefined ? { aliases: args.aliases } : {}),
								...(args.validFrom !== undefined ? { validFrom: args.validFrom } : {}),
								...(args.validUntil !== undefined ? { validUntil: args.validUntil } : {}),
								...(sourceEntryId !== undefined ? { sourceEntryId } : {}),
								...(args.sourceRef !== undefined ? { sourceRef: args.sourceRef } : {}),
							},
							api.now(),
						);
					}, context);

					if (!outcome.ok) {
						span.setAttributes({ "memory.outcome": outcome.reason });
						span.setStatus({
							status: "error",
							error: { name: outcome.reason, message: outcome.message },
						});
						return jsonTextResult({ ok: false, reason: outcome.reason, message: outcome.message }, true);
					}

					span.setAttributes({
						"memory.id": outcome.item.id,
						"memory.created": outcome.created,
						"memory.outcome": "ok",
					});
					return jsonTextResult({
						ok: true,
						created: outcome.created,
						id: outcome.item.id,
						kind: outcome.item.kind,
						content: outcome.item.content,
						...(outcome.item.sourceEntryId !== undefined ? { sourceEntryId: outcome.item.sourceEntryId } : {}),
					});
				},
			);
		},
	});

	const searchTool = defineTool({
		name: MEMORY_SEARCH_TOOL,
		description:
			"Search active durable memories on demand by keywords, aliases, content, kind, or ISO date range (YYYY-MM-DD). Forgotten items are never returned.",
		parameters: obj({
			query: str({ description: "Search keywords, person/project alias, or topic phrase." }),
			kind: opt(oneOf(["core", "fact", "episode", "active"] as const)),
			fromDate: opt(str({ description: "Optional start ISO date (YYYY-MM-DD) filter." })),
			toDate: opt(str({ description: "Optional end ISO date (YYYY-MM-DD) filter." })),
			limit: opt(int({ description: "Maximum number of hits to return (default 10, max 50)." })),
		}),
		execute: async (args, api, context) => {
			return startJeheeMemorySpan(context.telemetry)(
				"jehee.memory.search",
				{ ...(args.kind !== undefined ? { "memory.kind": args.kind } : {}) },
				async (span) => {
					const doc = (await api.snapshot(MemoryDoc, context)) ?? createEmptyMemoryStoreState();
					const hits = atomic.search(doc, {
						query: args.query,
						...(args.kind !== undefined ? { kind: args.kind } : {}),
						...(args.fromDate !== undefined ? { fromDate: args.fromDate } : {}),
						...(args.toDate !== undefined ? { toDate: args.toDate } : {}),
						...(args.limit !== undefined ? { limit: args.limit } : {}),
					});
					span.setAttributes({ "memory.hit_count": hits.length });
					return jsonTextResult({
						ok: true,
						count: hits.length,
						items: hits.map(({ item, score }) => ({
							id: item.id,
							kind: item.kind,
							content: item.content,
							score,
							...(item.keywords.length > 0 ? { keywords: item.keywords } : {}),
							...(item.aliases.length > 0 ? { aliases: item.aliases } : {}),
							...(item.validFrom !== undefined ? { validFrom: item.validFrom } : {}),
							...(item.validUntil !== undefined ? { validUntil: item.validUntil } : {}),
							...(item.sourceEntryId !== undefined ? { sourceEntryId: item.sourceEntryId } : {}),
							...(item.sourceRef !== undefined ? { sourceRef: item.sourceRef } : {}),
						})),
					});
				},
			);
		},
	});

	const forgetTool = defineTool({
		name: MEMORY_FORGET_TOOL,
		description:
			"Soft-delete (forget) a memory item by ID so it immediately disappears from both L1 Core and search results.",
		parameters: obj({
			id: str({ description: "Memory ID to forget (e.g. mem_0001)." }),
			reason: opt(str({ description: "Optional brief reason for forgetting this memory." })),
		}),
		execute: async (args, api, context) => {
			return startJeheeMemorySpan(context.telemetry)(
				"jehee.memory.forget",
				{ "memory.id": args.id },
				async (span) => {
					const outcome = await api.commit(async (tx) => {
						const doc = await tx.doc(MemoryDoc);
						return atomic.forget(doc, args.id, api.now(), args.reason);
					}, context);

					if (!outcome.ok) {
						span.setAttributes({ "memory.outcome": "not_found" });
						span.setStatus({
							status: "error",
							error: { name: "not_found", message: `Memory item "${outcome.id}" not found.` },
						});
						return jsonTextResult(
							{ ok: false, reason: "not_found", message: `Memory item "${outcome.id}" not found.` },
							true,
						);
					}

					span.setAttributes({
						"memory.outcome": outcome.alreadyForgotten ? "already_forgotten" : "ok",
					});
					return jsonTextResult({
						ok: true,
						id: outcome.item.id,
						kind: outcome.item.kind,
						alreadyForgotten: outcome.alreadyForgotten,
					});
				},
			);
		},
	});

	return [saveTool, searchTool, forgetTool];
}

/** Optional hooks passed into `createMemoryExtension` by `JeheeHost`. */
export type CreateMemoryExtensionOptions = {
	readonly onRootTurnCompleted?: (conversationId: ConversationId, context: Context) => void | Promise<void>;
};

/** Wraps `provider` as the `"jehee.memory"` pi-durable extension (L1 Core section + request/turn hooks). */
export function createMemoryExtension(provider: MemoryProvider, options?: CreateMemoryExtensionOptions): Extension {
	return defineExtension({
		name: JEHEE_MEMORY_EXTENSION_NAME,
		sections: [
			section("jehee_core_memory", async (input, context) => {
				if (provider.atomic !== undefined) {
					const doc = (await input.read.snapshot(MemoryDoc, context)) ?? createEmptyMemoryStoreState();
					return provider.atomic.renderCoreFromState(doc);
				}
				return provider.renderCorePrompt?.(String(input.conversationId));
			}),
		],
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (request, api) => {
					if (provider.shapeRequestMessages === undefined) return undefined;
					const shaped = await provider.shapeRequestMessages({
						conversationId: String(api.conversationId),
						messages: request.messages,
					});
					return shaped === undefined ? undefined : { messages: shaped };
				},
				afterRun: async (run, api, context) => {
					if (provider.onTurnCompleted !== undefined) {
						const page = await api.entries(
							{ minEntryId: run.first, maxEntryId: run.last, order: "ascending" },
							1000,
							undefined,
							context,
						);
						const userMessages: string[] = [];
						let assistantReply = "";
						for (const entry of page.items) {
							const firstModelMsg = entry.model?.[0];
							if (UserEntry.is(entry) && firstModelMsg?.role === "user") {
								userMessages.push(extractUserText(firstModelMsg));
							} else if (
								AssistantEntry.is(entry) &&
								entry.id === run.answer &&
								firstModelMsg?.role === "assistant"
							) {
								assistantReply = extractAssistantText(firstModelMsg);
							}
						}
						await provider.onTurnCompleted({
							conversationId: String(api.conversationId),
							userMessages,
							assistantReply,
						});
					}
					await options?.onRootTurnCompleted?.(api.conversationId, context);
					return undefined;
				},
			}),
		],
	});
}

/** Wraps `provider`'s atomic memory tools and optional background consolidator task as `"jehee.memory.tools"`. */
export function createMemoryToolsExtension(
	provider: MemoryProvider | undefined,
	consolidatorTask?: MemoryConsolidatorTaskToken,
): Extension {
	return defineExtension({
		name: JEHEE_MEMORY_TOOLS_EXTENSION_NAME,
		tools: provider?.atomic !== undefined ? [...createAtomicMemoryTools(provider.atomic)] : [],
		...(consolidatorTask !== undefined ? { tasks: [consolidatorTask] } : {}),
	});
}
