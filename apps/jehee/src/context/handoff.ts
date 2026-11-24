// Pure TypeScript context governance engine for Slice 5D (ADR-0013):
// self-contained CJK/Latin token estimation, sweet-spot threshold evaluation, structured handoff brief prompt builder,
// cross-handoff verbatim history lookup/search, and `/handoff` reply formatting.

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { MemoryModelRef } from "../memory/contract.ts";

/** Default attention sweet-spot ceiling (tokens) before automatic background compaction triggers. */
export const DEFAULT_HANDOFF_SWEET_SPOT_TOKENS = 48_000;

/** Default recent verbatim context budget (tokens) preserved during automatic sweet-spot compaction. */
export const DEFAULT_HANDOFF_KEEP_RECENT_TOKENS = 12_000;

const DEFAULT_HISTORY_LIMIT = 5;
const MAX_HISTORY_LIMIT = 20;
const DEFAULT_CONTEXT_WINDOW = 1;
const MAX_CONTEXT_WINDOW = 5;
const MAX_PROMPT_TURN_CHARS = 3_000;

/** Policy governing automatic sweet-spot compaction and manual seamless handoff (Slice 5D). */
export type HandoffPolicy = {
	/** Attention sweet-spot ceiling (tokens). `0` disables automatic sweet-spot compaction. */
	readonly sweetSpotTokens: number;
	/** Approximate recent tokens preserved verbatim during automatic compaction. */
	readonly keepRecentTokens: number;
	/** Whether to run Slice 5C-2 memory consolidation before compaction/handoff (default true). */
	readonly consolidateBeforeHandoff: boolean;
	/** Optional dedicated model for handoff/compaction summaries; defaults to host `defaultModel`. */
	readonly model?: MemoryModelRef;
};

/** Persisted session-scoped metrics and latest handoff summary stored in `HandoffDoc`. */
export type HandoffState = {
	totalCompactions: number;
	totalManualHandoffs: number;
	lastHandoffAtMs?: number;
	lastHandoffKind?: "auto_compaction" | "manual_handoff";
	lastTokensBefore?: number;
	lastTokensAfter?: number;
	lastSummaryPreview?: string;
};

/** Live context window status snapshot exposed via `JeheeHost.getContextStatus` and `/status`. */
export type ContextWindowStatus = {
	readonly activeTokens: number;
	readonly sweetSpotTokens: number;
	readonly keepRecentTokens: number;
	readonly activeEntries: number;
	readonly totalCompactions: number;
	readonly totalManualHandoffs: number;
	readonly totalHandoffs: number;
	readonly lastHandoffAtMs?: number;
	readonly lastHandoffKind?: "auto_compaction" | "manual_handoff";
};

/** Outcome of an explicit `JeheeHost.handoffWindow` / `/handoff` operation. */
export type HandoffWindowReport =
	| {
			readonly status: "ok";
			readonly tokensBefore: number;
			readonly tokensAfter: number;
			readonly consolidatedMemory: boolean;
			readonly summary: string;
	  }
	| {
			readonly status: "noop";
			readonly reason: "empty_context";
			readonly tokensBefore: number;
	  }
	| {
			readonly status: "error";
			readonly reason: "host_busy" | "model_not_found" | "summary_failed";
			readonly message: string;
	  };

/** One verbatim transcript record extracted from immutable SQLite history across all past handoffs. */
export type HistoryRecord = {
	readonly entryId: string;
	readonly role: "user" | "assistant" | "summary";
	readonly text: string;
	readonly timestampMs?: number;
};

/** Parameters for `JeheeHost.lookupHistory` and the `history_search` tool. */
export type HistoryLookupQuery = {
	/** Exact `EntryId` (e.g. from a memory item's `sourceEntryId`) to inspect with surrounding context. */
	readonly entryId?: string;
	/** Free-text CJK/Latin keyword query across all historical user and assistant messages. */
	readonly query?: string;
	/** Number of neighboring records to include before and after `entryId` (default 1, max 5). */
	readonly contextWindow?: number;
	/** Maximum number of keyword search hits to return (default 5, max 20). */
	readonly limit?: number;
};

/** Ranked hit from keyword history search. */
export type HistorySearchHit = {
	readonly record: HistoryRecord;
	readonly score: number;
};

/** Outcome of `lookupHistoryRecords`. */
export type HistoryLookupResult =
	| {
			readonly mode: "entry";
			readonly targetEntryId: string;
			readonly found: boolean;
			readonly records: readonly HistoryRecord[];
	  }
	| {
			readonly mode: "search";
			readonly query: string;
			readonly hits: readonly HistorySearchHit[];
	  };

/** Creates an empty `HandoffState` for `HandoffDoc`. */
export function createEmptyHandoffState(): HandoffState {
	return {
		totalCompactions: 0,
		totalManualHandoffs: 0,
	};
}

/** Resolves a partial `HandoffPolicy` with safe defaults. */
export function resolveHandoffPolicy(input?: Partial<HandoffPolicy>): HandoffPolicy {
	const sweetSpotTokens = Math.max(0, Math.floor(input?.sweetSpotTokens ?? DEFAULT_HANDOFF_SWEET_SPOT_TOKENS));
	const rawKeep = Math.max(0, Math.floor(input?.keepRecentTokens ?? DEFAULT_HANDOFF_KEEP_RECENT_TOKENS));
	const keepRecentTokens =
		sweetSpotTokens > 0 && rawKeep >= sweetSpotTokens ? Math.max(1, Math.floor(sweetSpotTokens / 3)) : rawKeep;
	return {
		sweetSpotTokens,
		keepRecentTokens,
		consolidateBeforeHandoff: input?.consolidateBeforeHandoff ?? true,
		...(input?.model !== undefined ? { model: input.model } : {}),
	};
}

function messageCharLength(message: Message): number {
	if (message.role === "system") {
		let chars = typeof message.content === "string" ? message.content.length : 0;
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				chars += block.text.length;
			}
		}
		if (message.sections !== undefined) {
			for (const val of Object.values(message.sections)) {
				if (val !== null) chars += val.length;
			}
		}
		return chars;
	}
	if (message.role === "user") {
		if (typeof message.content === "string") return message.content.length;
		let chars = 0;
		for (const block of message.content) {
			chars += block.type === "text" ? block.text.length : 256;
		}
		return chars;
	}
	if (message.role === "assistant") {
		let chars = 0;
		for (const block of message.content) {
			if (block.type === "text") {
				chars += block.text.length;
			} else if (block.type === "thinking") {
				chars += block.thinking.length;
			} else if (block.type === "toolCall") {
				chars += block.name.length + JSON.stringify(block.arguments).length;
			}
		}
		return chars;
	}
	// toolResult
	let chars = 0;
	for (const block of message.content) {
		chars += block.type === "text" ? block.text.length : 256;
	}
	return chars;
}

/** Portable CJK/Latin token estimate for a single `pi-ai` `Message` (no external tokenizer required). */
export function estimateMessageTokens(message: Message): number {
	const chars = messageCharLength(message);
	return Math.max(1, Math.ceil(chars / 3));
}

function assistantUsageTotalTokens(message: AssistantMessage): number {
	const u = message.usage;
	return u.input + u.output + u.cacheRead + u.cacheWrite;
}

/**
 * Estimates total active context window tokens.
 * Anchors on the newest `AssistantMessage` carrying real provider usage when available, plus estimates of subsequent messages.
 */
export function estimateActiveContextTokens(messages: readonly Message[]): number {
	let charEstimatedTotal = 0;
	let anchorIdx = -1;
	let anchorTokens = 0;
	for (let i = 0; i < messages.length; i += 1) {
		const msg = messages[i]!;
		charEstimatedTotal += estimateMessageTokens(msg);
		if (msg.role === "assistant") {
			const total = assistantUsageTotalTokens(msg);
			if (total > 0) {
				anchorIdx = i;
				anchorTokens = total;
			}
		}
	}
	if (anchorIdx === -1) return charEstimatedTotal;
	let anchoredTotal = anchorTokens;
	for (let i = anchorIdx + 1; i < messages.length; i += 1) {
		anchoredTotal += estimateMessageTokens(messages[i]!);
	}
	// Guard against partial/zero-input provider usage reports by never under-estimating below char-based total.
	return Math.max(anchoredTotal, charEstimatedTotal);
}

/** Determines whether the active window has crossed `sweetSpotTokens` and has enough messages to compact safely. */
export function shouldTriggerSweetSpotCompaction(params: {
	readonly activeTokens: number;
	readonly activeDialogueTurns: number;
	readonly policy: HandoffPolicy;
	readonly hasRunningCompaction: boolean;
}): boolean {
	if (params.policy.sweetSpotTokens <= 0) return false;
	if (params.hasRunningCompaction) return false;
	if (params.activeDialogueTurns < 2) return false;
	return params.activeTokens >= params.policy.sweetSpotTokens;
}

/** System prompt for generating a clean, compact seamless-handoff brief (`ResetEntry` / custom compaction summary). */
export const HANDOFF_SYSTEM_PROMPT = `You are Jehee's seamless window handoff summarizer.
Produce a concise, structured handoff brief so the next fresh context window can seamlessly continue working with the user without losing track of active goals or decisions.

Do NOT answer the user's last question and do NOT continue the dialogue. Output ONLY the structured handoff brief in the same primary language as the conversation using this concise format:

## Goal
- Current primary objective(s)

## Progress & Key Decisions
- Completed work and firm decisions (keep exact file paths, IDs, dates, and constraints)

## Open Items & Next Steps
- Unfinished tasks or immediate next steps`;

/** Builds the user prompt containing the active window's transcript turns and an optional user focus instruction. */
export function buildHandoffUserPrompt(turns: readonly HistoryRecord[], focus?: string): string {
	const lines = turns.map((turn) => {
		const clipped =
			turn.text.length > MAX_PROMPT_TURN_CHARS
				? `${turn.text.slice(0, MAX_PROMPT_TURN_CHARS)}…[truncated]`
				: turn.text;
		return `[entry=${turn.entryId}] ${turn.role.toUpperCase()}: ${clipped}`;
	});
	const focusBlock =
		focus !== undefined && focus.trim().length > 0 ? `\n\n## Special Focus Requested by User\n${focus.trim()}` : "";
	return `## Active Conversation Window to Hand Off\n${lines.join("\n")}${focusBlock}`;
}

/** Wraps a handoff summary string into the starting user message placed on `ResetEntry`. */
export function wrapHandoffBriefMessage(summary: string, focus?: string): string {
	const cleanSummary = summary.trim();
	const focusLine = focus !== undefined && focus.trim().length > 0 ? `\n\nFocus for next window: ${focus.trim()}` : "";
	return `[Seamless Window Handoff Brief]\nThe previous conversation window was handed off cleanly into this fresh window. Long-term memories remain in L1 Core / memory_search, and verbatim past turns remain searchable via history_search.\n\n${cleanSummary}${focusLine}`;
}

function tokenizeSearchText(query: string): string[] {
	const lower = query.toLowerCase();
	const tokens = new Set<string>();
	for (const match of lower.matchAll(/[a-z0-9_.-]+/g)) {
		if (match[0].length > 0) tokens.add(match[0]);
	}
	for (const match of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
		const run = match[0];
		tokens.add(run);
		if (run.length >= 2) {
			for (let i = 0; i < run.length - 1; i += 1) {
				tokens.add(run.slice(i, i + 2));
			}
		}
	}
	return [...tokens];
}

function scoreRecordText(text: string, normalizedQuery: string, tokens: readonly string[]): number {
	const lower = text.toLowerCase();
	let score = 0;
	if (lower.includes(normalizedQuery)) {
		score += 10;
	}
	for (const token of tokens) {
		if (token === normalizedQuery) continue;
		if (lower.includes(token)) {
			score += 2;
		}
	}
	return score;
}

/** Looks up verbatim historical turns either by exact `entryId` (+ neighboring context) or by CJK/Latin keyword search. */
export function lookupHistoryRecords(
	chronologicalRecords: readonly HistoryRecord[],
	query: HistoryLookupQuery,
): HistoryLookupResult {
	const targetEntryId = query.entryId?.trim();
	if (targetEntryId !== undefined && targetEntryId.length > 0) {
		const idx = chronologicalRecords.findIndex((r) => r.entryId === targetEntryId);
		if (idx === -1) {
			return { mode: "entry", targetEntryId, found: false, records: [] };
		}
		const win = Math.max(0, Math.min(MAX_CONTEXT_WINDOW, Math.floor(query.contextWindow ?? DEFAULT_CONTEXT_WINDOW)));
		const start = Math.max(0, idx - win);
		const end = Math.min(chronologicalRecords.length, idx + win + 1);
		return {
			mode: "entry",
			targetEntryId,
			found: true,
			records: chronologicalRecords.slice(start, end),
		};
	}

	const rawQuery = query.query?.trim() ?? "";
	const limit = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(query.limit ?? DEFAULT_HISTORY_LIMIT)));
	if (rawQuery.length === 0) {
		const tail = chronologicalRecords.slice(-limit).reverse();
		return {
			mode: "search",
			query: "",
			hits: tail.map((record) => ({ record, score: 1 })),
		};
	}

	const normalized = rawQuery.toLowerCase();
	const tokens = tokenizeSearchText(normalized);
	const hits: Array<{ readonly record: HistoryRecord; readonly score: number; readonly order: number }> = [];
	for (let i = 0; i < chronologicalRecords.length; i += 1) {
		const record = chronologicalRecords[i]!;
		if (record.role === "summary") continue;
		const score = scoreRecordText(record.text, normalized, tokens);
		if (score > 0) {
			hits.push({ record, score, order: i });
		}
	}
	hits.sort((a, b) => b.score - a.score || b.order - a.order);
	return {
		mode: "search",
		query: rawQuery,
		hits: hits.slice(0, limit).map(({ record, score }) => ({ record, score })),
	};
}

/** Formats a `HandoffWindowReport` into a concise chat reply for `/handoff`. */
export function formatHandoffReply(report: HandoffWindowReport): string {
	if (report.status === "noop") {
		return "当前活跃窗口为空，无需换窗交接。";
	}
	if (report.status === "error") {
		if (report.reason === "host_busy") {
			return "当前主对话正忙，请等本轮完成后再执行 /handoff。";
		}
		return `换窗交接失败：${report.message}`;
	}
	const preview = report.summary.length > 500 ? `${report.summary.slice(0, 500)}…` : report.summary;
	const memNote = report.consolidatedMemory ? "已先落盘记忆" : "跳过记忆整理";
	return [
		`[Seamless Handoff] 换窗完成（${report.tokensBefore} -> ${report.tokensAfter} tok，${memNote}）`,
		preview,
	].join("\n");
}
