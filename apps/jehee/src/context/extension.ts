// `pi-durable` extension and helpers for Slice 5D (ADR-0013):
// - Hooks `CompactionTask.beforeCompact` to flush Slice 5C-2 memory consolidation before old entries leave the active window;
// - Exposes read-only `history_search` tool for verbatim recall across CompactionEntry/ResetEntry boundaries (kept off workshop subagents);
// - Implements explicit manual handoff (`ResetEntry`) with deterministic `sessionId` and `HandoffDoc` accounting.

import type { Context } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	CompactionEntry,
	CompactionTask,
	type ConversationId,
	type Cursor,
	defineExtension,
	defineTool,
	type EntryRecord,
	type Extension,
	GenerationTask,
	hook,
	type ModelRef,
	ResetEntry,
	type ToolExecutionResult,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { extractAssistantText, extractUserText } from "../memory/contract.ts";
import { startJeheeContextSpan } from "../telemetry/recorder.ts";
import { HandoffDoc } from "./durable-store.ts";
import {
	buildHandoffUserPrompt,
	estimateActiveContextTokens,
	HANDOFF_SYSTEM_PROMPT,
	type HandoffPolicy,
	type HandoffWindowReport,
	type HistoryLookupQuery,
	type HistoryLookupResult,
	type HistoryRecord,
	lookupHistoryRecords,
	wrapHandoffBriefMessage,
} from "./handoff.ts";

/** Fixed extension slot name for Slice 5D context handoff hooks and `history_search` tool. */
export const JEHEE_CONTEXT_EXTENSION_NAME = "jehee.context";

/** Extension handle referencing `"jehee.context"` for `configure({ extensions: { remove: [...] } })`. */
export const JEHEE_CONTEXT_EXTENSION_HANDLE: Extension = defineExtension({
	name: JEHEE_CONTEXT_EXTENSION_NAME,
});

/** Read-only tool name for verbatim transcript recall across past compactions and handoffs. */
export const HISTORY_SEARCH_TOOL = "history_search";

const MAX_HISTORY_SCAN_ENTRIES = 1_000;

function jsonTextResult(payload: Record<string, unknown>, isError: boolean = false): ToolExecutionResult {
	return {
		output: [{ type: "text", text: JSON.stringify(payload) }],
		...(isError ? { isError: true } : {}),
	};
}

/** Projects chronological verbatim `HistoryRecord` items from raw `pi-durable` entries. */
export function extractHistoryRecords(entries: readonly EntryRecord[]): HistoryRecord[] {
	const records: HistoryRecord[] = [];
	for (const entry of entries) {
		const firstMsg = entry.model?.[0];
		if (UserEntry.is(entry) && firstMsg?.role === "user") {
			const text = extractUserText(firstMsg).trim();
			if (text.length > 0) {
				records.push({
					entryId: String(entry.id),
					role: "user",
					text,
					...(firstMsg.timestamp !== undefined ? { timestampMs: firstMsg.timestamp } : {}),
				});
			}
		} else if (AssistantEntry.is(entry) && firstMsg?.role === "assistant" && firstMsg.stopReason === "stop") {
			const text = extractAssistantText(firstMsg).trim();
			if (text.length > 0) {
				records.push({
					entryId: String(entry.id),
					role: "assistant",
					text,
					...(firstMsg.timestamp !== undefined ? { timestampMs: firstMsg.timestamp } : {}),
				});
			}
		} else if ((CompactionEntry.is(entry) || ResetEntry.is(entry)) && firstMsg?.role === "user") {
			const text = extractUserText(firstMsg).trim();
			if (text.length > 0) {
				records.push({
					entryId: String(entry.id),
					role: "summary",
					text,
					...(firstMsg.timestamp !== undefined ? { timestampMs: firstMsg.timestamp } : {}),
				});
			}
		}
	}
	return records;
}

/** Scans up to `MAX_HISTORY_SCAN_ENTRIES` immutable transcript entries inside a transaction in chronological order. */
export async function scanAllHistoryInTx(tx: Tx, conversationId: ConversationId): Promise<HistoryRecord[]> {
	const collected: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	while (collected.length < MAX_HISTORY_SCAN_ENTRIES) {
		const page = await tx.scanEntries({ conversationId, order: "descending" }, 200, cursor);
		for (const item of page.items) {
			collected.push(item);
			if (collected.length >= MAX_HISTORY_SCAN_ENTRIES) break;
		}
		if (page.next === undefined) break;
		cursor = page.next;
	}
	collected.reverse();
	return extractHistoryRecords(collected);
}

/** Generates a concise structured handoff summary using `modelRef` with deterministic `sessionId` and `cacheRetention: "none"`. */
export async function generateHandoffBrief(params: {
	readonly conversationId: ConversationId;
	readonly turns: readonly HistoryRecord[];
	readonly focus?: string;
	readonly models: Models;
	readonly modelRef: ModelRef;
	readonly now: () => number;
	readonly signal?: AbortSignal;
	readonly span?: Parameters<Models["completeSimple"]>[2] extends infer O
		? O extends { readonly telemetry?: infer T }
			? T
			: never
		: never;
}): Promise<
	| { readonly ok: true; readonly summary: string }
	| { readonly ok: false; readonly reason: "model_not_found" | "summary_failed"; readonly message: string }
> {
	const model = params.models.getModel(params.modelRef.provider, params.modelRef.modelId);
	if (model === undefined) {
		return {
			ok: false,
			reason: "model_not_found",
			message: `Handoff model "${params.modelRef.provider}/${params.modelRef.modelId}" not found.`,
		};
	}
	const nowMs = params.now();
	const messages: Message[] = [
		{ role: "system", content: HANDOFF_SYSTEM_PROMPT, timestamp: nowMs },
		{
			role: "user",
			content: [{ type: "text", text: buildHandoffUserPrompt(params.turns, params.focus) }],
			timestamp: nowMs,
		},
	];
	try {
		const reply = await params.models.completeSimple(
			model,
			{ messages },
			{
				cacheRetention: "none",
				sessionId: `jehee-handoff-${String(params.conversationId)}`,
				...(params.span !== undefined ? { telemetry: params.span } : {}),
				...(params.signal !== undefined ? { signal: params.signal } : {}),
			},
		);
		if (reply.stopReason === "error") {
			return {
				ok: false,
				reason: "summary_failed",
				message: reply.errorMessage ?? "Handoff summary model returned error stopReason.",
			};
		}
		const summary = extractAssistantText(reply).trim();
		if (summary.length === 0) {
			return { ok: false, reason: "summary_failed", message: "Handoff summary model returned empty output." };
		}
		return { ok: true, summary };
	} catch (error) {
		return {
			ok: false,
			reason: "summary_failed",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Options for wiring the `"jehee.context"` extension onto `JeheeHost`. */
export type CreateContextExtensionOptions = {
	/** Whether to expose the eager `history_search` tool on the root conversation (enabled when atomic memory or handoff config is mounted). */
	readonly enableHistoryTool?: boolean;
	readonly getPolicy: () => HandoffPolicy;
	readonly getDefaultModel: () => ModelRef;
	readonly getModels: () => Models;
	readonly getNow: () => number;
	readonly getTelemetry: () => TelemetryContext | undefined;
	readonly isRootConversation: (conversationId: ConversationId) => boolean;
	readonly runPreHandoffConsolidation: (context: Context) => Promise<boolean>;
	readonly recordAutoCompaction: (
		metrics: { readonly tokensBefore: number; readonly summaryPreview?: string },
		context: Context,
	) => Promise<void>;
	readonly onRootAfterRun?: (conversationId: ConversationId, context: Context) => void | Promise<void>;
};

/** Creates the `"jehee.context"` extension: `CompactionTask.beforeCompact` memory flush + `history_search` tool. */
export function createContextExtension(options: CreateContextExtensionOptions): Extension {
	const historySearchTool = defineTool({
		name: HISTORY_SEARCH_TOOL,
		description:
			"Search or look up verbatim past conversation turns from immutable SQLite history, including turns compacted or handed off from earlier windows. Use `entryId` (e.g. a memory's `sourceEntryId`) to read an exact quote with surrounding context, or `query` to search by keywords.",
		parameters: obj({
			entryId: opt(
				str({ description: "Exact EntryId (e.g. from a memory item's sourceEntryId) to inspect verbatim." }),
			),
			query: opt(
				str({ description: "Keywords or phrase to search across all historical user and assistant turns." }),
			),
			contextWindow: opt(
				int({ description: "Neighboring messages before/after `entryId` to include (default 1, max 5)." }),
			),
			limit: opt(int({ description: "Maximum number of keyword search hits to return (default 5, max 20)." })),
		}),
		execute: async (args, api, context) => {
			const telemetry = options.getTelemetry() ?? context.telemetry;
			const mode = args.entryId !== undefined && args.entryId.trim().length > 0 ? "entry" : "search";
			return startJeheeContextSpan(telemetry)(
				"jehee.context.history_search",
				{ "history.mode": mode },
				async (span) => {
					const records = await api.commit((tx) => scanAllHistoryInTx(tx, api.conversationId), context);
					const query: HistoryLookupQuery = {
						...(args.entryId !== undefined ? { entryId: args.entryId } : {}),
						...(args.query !== undefined ? { query: args.query } : {}),
						...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
						...(args.limit !== undefined ? { limit: args.limit } : {}),
					};
					const result: HistoryLookupResult = lookupHistoryRecords(records, query);
					if (result.mode === "entry") {
						span.setAttributes({ "history.hit_count": result.records.length });
						return jsonTextResult({
							ok: true,
							mode: "entry",
							targetEntryId: result.targetEntryId,
							found: result.found,
							records: result.records,
						});
					}
					span.setAttributes({ "history.hit_count": result.hits.length });
					return jsonTextResult({
						ok: true,
						mode: "search",
						query: result.query,
						count: result.hits.length,
						hits: result.hits.map(({ record, score }) => ({ ...record, score })),
					});
				},
			);
		},
	});

	return defineExtension({
		name: JEHEE_CONTEXT_EXTENSION_NAME,
		tools: options.enableHistoryTool === true ? [historySearchTool] : [],
		hooks: [
			hook(CompactionTask, {
				beforeCompact: async (compaction, api, context) => {
					if (!options.isRootConversation(api.conversationId)) return undefined;
					const policy = options.getPolicy();
					const telemetry = options.getTelemetry() ?? context.telemetry;
					return startJeheeContextSpan(telemetry)(
						"jehee.context.handoff",
						{ "context.kind": "auto_compaction" },
						async (span) => {
							const tokensBefore = estimateActiveContextTokens(compaction.messages);
							let consolidatedMemory = false;
							if (policy.consolidateBeforeHandoff) {
								try {
									consolidatedMemory = await options.runPreHandoffConsolidation(context);
								} catch {
									consolidatedMemory = false;
								}
							}

							let customSummary: string | undefined;
							if (policy.model !== undefined) {
								const turns = extractHistoryRecords(compaction.entries);
								const brief = await generateHandoffBrief({
									conversationId: api.conversationId,
									turns,
									...(compaction.instructions !== undefined ? { focus: compaction.instructions } : {}),
									models: options.getModels(),
									modelRef: policy.model,
									now: options.getNow,
									...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
									span,
								});
								if (brief.ok) {
									customSummary = brief.summary;
								}
							}

							await options.recordAutoCompaction(
								{
									tokensBefore,
									...(customSummary !== undefined ? { summaryPreview: customSummary.slice(0, 200) } : {}),
								},
								context,
							);

							span.setAttributes({
								"context.tokens_before": tokensBefore,
								"context.consolidated_memory": consolidatedMemory,
								"context.outcome": "ok",
							});
							return customSummary !== undefined ? { summary: customSummary } : undefined;
						},
					);
				},
			}),
			hook(GenerationTask, {
				afterRun: async (_run, api, context) => {
					if (options.isRootConversation(api.conversationId)) {
						await options.onRootAfterRun?.(api.conversationId, context);
					}
					return undefined;
				},
			}),
		],
	});
}

/** Input for executing an explicit manual window handoff (`ResetEntry` with structured brief). */
export type ExecuteManualHandoffInput = {
	readonly conversationId: ConversationId;
	readonly focus?: string;
	readonly policy: HandoffPolicy;
	readonly models: Models;
	readonly defaultModel: ModelRef;
	readonly now: () => number;
	readonly telemetry?: TelemetryContext;
	readonly isBusy: (context: Context) => Promise<boolean>;
	readonly readActiveContext: (
		context: Context,
	) => Promise<{ readonly entries: readonly EntryRecord[]; readonly messages: readonly Message[] }>;
	readonly runPreHandoffConsolidation: (context: Context) => Promise<boolean>;
	readonly resetWithBrief: (briefText: string, context: Context) => Promise<void>;
	readonly commit: <T>(change: (tx: Tx) => T | Promise<T>, context: Context) => Promise<T>;
};

/** Executes a full explicit window handoff: consolidates memory, summarizes active window, writes `ResetEntry`, and records `HandoffDoc`. */
export async function executeManualWindowHandoff(
	input: ExecuteManualHandoffInput,
	context: Context,
): Promise<HandoffWindowReport> {
	const telemetry = input.telemetry ?? context.telemetry;
	return startJeheeContextSpan(telemetry)(
		"jehee.context.handoff",
		{ "context.kind": "manual_handoff" },
		async (span) => {
			if (await input.isBusy(context)) {
				const message = "Cannot hand off context window while the root conversation is busy.";
				span.setAttributes({ "context.outcome": "error" });
				span.setStatus({ status: "error", error: { name: "host_busy", message } });
				return { status: "error", reason: "host_busy", message };
			}

			const view = await input.readActiveContext(context);
			const turns = extractHistoryRecords(view.entries);
			const tokensBefore = estimateActiveContextTokens(view.messages);
			if (turns.length === 0) {
				span.setAttributes({ "context.tokens_before": 0, "context.outcome": "noop" });
				return { status: "noop", reason: "empty_context", tokensBefore: 0 };
			}

			let consolidatedMemory = false;
			if (input.policy.consolidateBeforeHandoff) {
				try {
					consolidatedMemory = await input.runPreHandoffConsolidation(context);
				} catch {
					consolidatedMemory = false;
				}
			}

			const modelRef = input.policy.model ?? input.defaultModel;
			const brief = await generateHandoffBrief({
				conversationId: input.conversationId,
				turns,
				...(input.focus !== undefined ? { focus: input.focus } : {}),
				models: input.models,
				modelRef,
				now: input.now,
				...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
				span,
			});

			if (!brief.ok) {
				span.setAttributes({
					"context.tokens_before": tokensBefore,
					"context.consolidated_memory": consolidatedMemory,
					"context.outcome": "error",
				});
				span.setStatus({ status: "error", error: { name: brief.reason, message: brief.message } });
				return { status: "error", reason: brief.reason, message: brief.message };
			}

			const wrappedBrief = wrapHandoffBriefMessage(brief.summary, input.focus);
			await input.resetWithBrief(wrappedBrief, context);

			const afterView = await input.readActiveContext(context);
			const tokensAfter = estimateActiveContextTokens(afterView.messages);
			const nowMs = input.now();

			await input.commit(async (tx) => {
				const hDoc = await tx.doc(HandoffDoc);
				hDoc.totalManualHandoffs += 1;
				hDoc.lastHandoffAtMs = nowMs;
				hDoc.lastHandoffKind = "manual_handoff";
				hDoc.lastTokensBefore = tokensBefore;
				hDoc.lastTokensAfter = tokensAfter;
				hDoc.lastSummaryPreview = brief.summary.slice(0, 200);
			}, context);

			span.setAttributes({
				"context.tokens_before": tokensBefore,
				"context.tokens_after": tokensAfter,
				"context.consolidated_memory": consolidatedMemory,
				"context.outcome": "ok",
			});

			return {
				status: "ok",
				tokensBefore,
				tokensAfter,
				consolidatedMemory,
				summary: brief.summary,
			};
		},
	);
}
