// Pure TypeScript background memory consolidation engine: prompt assembly, strict untrusted-JSON patch parsing,
// deterministic transactional applier (exact dedup, merge/supersede/forget tombstones, L1 Core guardrails), and formatting.

import { isMemoryKind } from "./atomic-memory.ts";
import type {
	AtomicMemoryController,
	ConsolidationOp,
	ConsolidationPlan,
	MemoryConsolidationReport,
	MemoryConsolidationState,
	MemoryItem,
	MemoryStoreState,
} from "./contract.ts";

/** Default minimum new turns required before automatic idle consolidation fires. */
export const DEFAULT_CONSOLIDATION_MIN_TURNS = 2;

/** Hard ceiling on operations per consolidation batch to bound blast radius. */
export const MAX_CONSOLIDATION_OPS = 50;

/** Compact transcript turn passed into the consolidation planner prompt. */
export type ConsolidationDialogueTurn = {
	readonly entryId: string;
	readonly role: "user" | "assistant";
	readonly text: string;
};

/** Deterministic counts returned after applying a `ConsolidationPlan` onto `MemoryStoreState`. */
export type ConsolidationApplyOutcome = {
	readonly added: number;
	readonly updated: number;
	readonly merged: number;
	readonly superseded: number;
	readonly forgotten: number;
	readonly skipped: number;
	readonly skippedReasons: readonly string[];
};

/** Result of validating raw planner model text into a typed `ConsolidationPlan`. */
export type ParseConsolidationPlanResult =
	| { readonly ok: true; readonly plan: ConsolidationPlan }
	| { readonly ok: false; readonly error: string };

/** Creates an empty `MemoryConsolidationState` for `MemoryConsolidationDoc`. */
export function createEmptyConsolidationState(): MemoryConsolidationState {
	return {
		totalRuns: 0,
		totalAdded: 0,
		totalUpdated: 0,
		totalMerged: 0,
		totalSuperseded: 0,
		totalForgotten: 0,
	};
}

/** System prompt guiding the background consolidation model to emit strict JSON Patch operations. */
export const CONSOLIDATION_SYSTEM_PROMPT = `You are Jehee's background memory consolidation engine.
Your job is to review existing active atomic memories and newly arrived dialogue turns, then emit ONLY a single JSON object matching this schema:
{
  "summary": "Brief 1-sentence summary of changes (optional)",
  "ops": [
    { "op": "add", "kind": "core|fact|episode|active", "content": "...", "keywords": ["..."], "aliases": ["..."], "validFrom": "YYYY-MM-DD", "validUntil": "YYYY-MM-DD", "sourceEntryId": "..." },
    { "op": "update", "id": "mem_0001", "kind": "core|fact|episode|active", "content": "...", "keywords": ["..."], "aliases": ["..."] },
    { "op": "merge", "keepId": "mem_0001", "dropIds": ["mem_0002"], "content": "Merged concise content", "keywords": ["..."], "aliases": ["..."] },
    { "op": "supersede", "oldId": "mem_0003", "reason": "Why old fact is outdated", "replacement": { "kind": "fact", "content": "...", "keywords": ["..."], "aliases": ["..."], "sourceEntryId": "..." } },
    { "op": "forget", "id": "mem_0004", "reason": "User explicitly negated this" }
  ]
}

Rules:
1. Return ONLY raw JSON (no prose before or after). If nothing needs changing, return {"summary":"No changes needed","ops":[]}.
2. Extract durable implicit facts, schedules, relationships, or user preferences from the new dialogue turns that are not yet stored. Attach the relevant user turn's entryId as sourceEntryId.
3. Reserve kind="core" ONLY for rare, long-term stable rules or user identity preferences. Use "fact", "episode", or "active" for everything else.
4. Merge duplicate or near-duplicate active memories with "merge".
5. Resolve contradictions between an older active memory and newer dialogue (such as a changed address, job, owner, or preference) using "supersede" — never leave conflicting current-state facts both active, and state ONLY the new current fact in replacement.content without repeating the outdated value (the superseded item's tombstone already preserves history).
6. Do NOT invent facts not supported by the dialogue or existing memories.`;

/** Formats active memories and incremental dialogue turns into the user prompt for consolidation. */
export function buildConsolidationUserPrompt(
	activeItems: readonly MemoryItem[],
	turns: readonly ConsolidationDialogueTurn[],
): string {
	const sections: string[] = [];

	if (activeItems.length === 0) {
		sections.push("## Existing Active Memories\n(none)");
	} else {
		const lines = activeItems.map((item) => {
			const meta: string[] = [];
			if (item.keywords.length > 0) meta.push(`keywords=${JSON.stringify(item.keywords)}`);
			if (item.aliases.length > 0) meta.push(`aliases=${JSON.stringify(item.aliases)}`);
			if (item.validFrom !== undefined) meta.push(`validFrom=${item.validFrom}`);
			if (item.validUntil !== undefined) meta.push(`validUntil=${item.validUntil}`);
			const suffix = meta.length > 0 ? ` | ${meta.join(", ")}` : "";
			return `- [${item.id}] (${item.kind}) ${item.content}${suffix}`;
		});
		sections.push(`## Existing Active Memories\n${lines.join("\n")}`);
	}

	if (turns.length === 0) {
		sections.push(
			"## New Dialogue Turns Since Last Consolidation\n(none — check existing memories for duplicates or conflicts only)",
		);
	} else {
		const lines = turns.map((turn) => `- [entryId=${turn.entryId}] ${turn.role.toUpperCase()}: ${turn.text}`);
		sections.push(`## New Dialogue Turns Since Last Consolidation\n${lines.join("\n")}`);
	}

	return sections.join("\n\n");
}

function stripJsonCodeFence(raw: string): string {
	const trimmed = raw.trim();
	const fenceMatch = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
	return fenceMatch !== null ? fenceMatch[1]!.trim() : trimmed;
}

// Trust boundary: LLM JSON output is untrusted wire input and must be validated before entering typed domain state.
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(rec: Record<string, unknown>, key: string): string | undefined {
	const val = rec[key];
	if (val === undefined || val === null) return undefined;
	if (typeof val !== "string") return undefined;
	const trimmed = val.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalStringArray(rec: Record<string, unknown>, key: string): string[] | undefined {
	const val = rec[key];
	if (val === undefined || val === null) return undefined;
	if (!Array.isArray(val)) return undefined;
	const out: string[] = [];
	for (const entry of val) {
		if (typeof entry === "string" && entry.trim().length > 0) {
			out.push(entry.trim());
		}
	}
	return out;
}

function parseSingleOp(
	raw: unknown,
	index: number,
): { readonly ok: true; readonly op: ConsolidationOp } | { readonly ok: false; readonly error: string } {
	if (!isRecord(raw)) {
		return { ok: false, error: `ops[${index}] must be an object` };
	}
	const opType = readOptionalString(raw, "op");
	if (opType === "add") {
		const kind = readOptionalString(raw, "kind");
		const content = readOptionalString(raw, "content");
		if (kind === undefined || !isMemoryKind(kind)) {
			return { ok: false, error: `ops[${index}].kind must be one of core|fact|episode|active` };
		}
		if (content === undefined) {
			return { ok: false, error: `ops[${index}].content must be a non-empty string` };
		}
		const keywords = readOptionalStringArray(raw, "keywords");
		const aliases = readOptionalStringArray(raw, "aliases");
		const validFrom = readOptionalString(raw, "validFrom");
		const validUntil = readOptionalString(raw, "validUntil");
		const sourceEntryId = readOptionalString(raw, "sourceEntryId");
		return {
			ok: true,
			op: {
				op: "add",
				kind,
				content,
				...(keywords !== undefined ? { keywords } : {}),
				...(aliases !== undefined ? { aliases } : {}),
				...(validFrom !== undefined ? { validFrom } : {}),
				...(validUntil !== undefined ? { validUntil } : {}),
				...(sourceEntryId !== undefined ? { sourceEntryId } : {}),
			},
		};
	}

	if (opType === "update") {
		const id = readOptionalString(raw, "id");
		const content = readOptionalString(raw, "content");
		const rawKind = readOptionalString(raw, "kind");
		if (id === undefined) return { ok: false, error: `ops[${index}].id must be a non-empty string` };
		if (content === undefined) return { ok: false, error: `ops[${index}].content must be a non-empty string` };
		if (rawKind !== undefined && !isMemoryKind(rawKind)) {
			return { ok: false, error: `ops[${index}].kind must be one of core|fact|episode|active` };
		}
		const keywords = readOptionalStringArray(raw, "keywords");
		const aliases = readOptionalStringArray(raw, "aliases");
		const validFrom = readOptionalString(raw, "validFrom");
		const validUntil = readOptionalString(raw, "validUntil");
		const sourceEntryId = readOptionalString(raw, "sourceEntryId");
		return {
			ok: true,
			op: {
				op: "update",
				id,
				...(rawKind !== undefined ? { kind: rawKind } : {}),
				content,
				...(keywords !== undefined ? { keywords } : {}),
				...(aliases !== undefined ? { aliases } : {}),
				...(validFrom !== undefined ? { validFrom } : {}),
				...(validUntil !== undefined ? { validUntil } : {}),
				...(sourceEntryId !== undefined ? { sourceEntryId } : {}),
			},
		};
	}

	if (opType === "merge") {
		const keepId = readOptionalString(raw, "keepId");
		const dropIds = readOptionalStringArray(raw, "dropIds");
		const content = readOptionalString(raw, "content");
		if (keepId === undefined) return { ok: false, error: `ops[${index}].keepId must be a non-empty string` };
		if (dropIds === undefined || dropIds.length === 0) {
			return { ok: false, error: `ops[${index}].dropIds must be a non-empty string array` };
		}
		if (content === undefined) return { ok: false, error: `ops[${index}].content must be a non-empty string` };
		const keywords = readOptionalStringArray(raw, "keywords");
		const aliases = readOptionalStringArray(raw, "aliases");
		const validFrom = readOptionalString(raw, "validFrom");
		const validUntil = readOptionalString(raw, "validUntil");
		return {
			ok: true,
			op: {
				op: "merge",
				keepId,
				dropIds,
				content,
				...(keywords !== undefined ? { keywords } : {}),
				...(aliases !== undefined ? { aliases } : {}),
				...(validFrom !== undefined ? { validFrom } : {}),
				...(validUntil !== undefined ? { validUntil } : {}),
			},
		};
	}

	if (opType === "supersede") {
		const oldId = readOptionalString(raw, "oldId");
		const reason = readOptionalString(raw, "reason") ?? "superseded_by_newer_fact";
		const repl = raw.replacement;
		if (oldId === undefined) return { ok: false, error: `ops[${index}].oldId must be a non-empty string` };
		if (!isRecord(repl)) return { ok: false, error: `ops[${index}].replacement must be an object` };
		const kind = readOptionalString(repl, "kind");
		const content = readOptionalString(repl, "content");
		if (kind === undefined || !isMemoryKind(kind)) {
			return { ok: false, error: `ops[${index}].replacement.kind must be one of core|fact|episode|active` };
		}
		if (content === undefined) {
			return { ok: false, error: `ops[${index}].replacement.content must be a non-empty string` };
		}
		const keywords = readOptionalStringArray(repl, "keywords");
		const aliases = readOptionalStringArray(repl, "aliases");
		const validFrom = readOptionalString(repl, "validFrom");
		const validUntil = readOptionalString(repl, "validUntil");
		const sourceEntryId = readOptionalString(repl, "sourceEntryId");
		return {
			ok: true,
			op: {
				op: "supersede",
				oldId,
				reason,
				replacement: {
					kind,
					content,
					...(keywords !== undefined ? { keywords } : {}),
					...(aliases !== undefined ? { aliases } : {}),
					...(validFrom !== undefined ? { validFrom } : {}),
					...(validUntil !== undefined ? { validUntil } : {}),
					...(sourceEntryId !== undefined ? { sourceEntryId } : {}),
				},
			},
		};
	}

	if (opType === "forget") {
		const id = readOptionalString(raw, "id");
		const reason = readOptionalString(raw, "reason") ?? "consolidated_forget";
		if (id === undefined) return { ok: false, error: `ops[${index}].id must be a non-empty string` };
		return { ok: true, op: { op: "forget", id, reason } };
	}

	return { ok: false, error: `ops[${index}].op "${String(raw.op)}" is not a supported operation` };
}

/** Strictly parses and validates raw LLM text into a `ConsolidationPlan`. */
export function parseConsolidationPlan(rawText: string): ParseConsolidationPlanResult {
	const cleaned = stripJsonCodeFence(rawText);
	if (cleaned.length === 0) {
		return { ok: false, error: "Consolidation model returned empty output." };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch (error) {
		return {
			ok: false,
			error: `Invalid JSON from consolidation model: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (!isRecord(parsed)) {
		return { ok: false, error: "Consolidation output must be a JSON object." };
	}
	if (!Array.isArray(parsed.ops)) {
		return { ok: false, error: 'Consolidation output must include an "ops" array.' };
	}
	if (parsed.ops.length > MAX_CONSOLIDATION_OPS) {
		return {
			ok: false,
			error: `Consolidation batch exceeded max ops ceiling (${parsed.ops.length}/${MAX_CONSOLIDATION_OPS}).`,
		};
	}

	const ops: ConsolidationOp[] = [];
	for (let i = 0; i < parsed.ops.length; i += 1) {
		const single = parseSingleOp(parsed.ops[i], i);
		if (!single.ok) return { ok: false, error: single.error };
		ops.push(single.op);
	}

	const summary = readOptionalString(parsed, "summary");
	return {
		ok: true,
		plan: {
			...(summary !== undefined ? { summary } : {}),
			ops,
		},
	};
}

function normalizeContentKey(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function mergeStringLists(...lists: readonly (readonly string[] | undefined)[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const list of lists) {
		if (list === undefined) continue;
		for (const item of list) {
			const trimmed = item.trim();
			if (trimmed.length === 0) continue;
			const key = trimmed.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(trimmed);
		}
	}
	return out;
}

/**
 * Applies a validated `ConsolidationPlan` onto `state` with deterministic guardrails:
 * exact-duplicate suppression, reversible tombstones for `merge`/`supersede`/`forget`, and L1 Core limit enforcement.
 */
export function applyConsolidationPlan(
	state: MemoryStoreState,
	plan: ConsolidationPlan,
	atomic: AtomicMemoryController,
	nowMs: number,
): ConsolidationApplyOutcome {
	let added = 0;
	let updated = 0;
	let merged = 0;
	let superseded = 0;
	let forgotten = 0;
	const skippedReasons: string[] = [];

	const activeNormalizedContents = (): Set<string> => {
		const set = new Set<string>();
		for (const item of Object.values(state.items)) {
			if (item.status === "active") {
				set.add(normalizeContentKey(item.content));
			}
		}
		return set;
	};

	for (const op of plan.ops) {
		if (op.op === "add") {
			const normKey = normalizeContentKey(op.content);
			if (activeNormalizedContents().has(normKey)) {
				skippedReasons.push(`add skipped (duplicate content): ${op.content.slice(0, 60)}`);
				continue;
			}
			const saved = atomic.save(
				state,
				{
					kind: op.kind,
					content: op.content,
					...(op.keywords !== undefined ? { keywords: op.keywords } : {}),
					...(op.aliases !== undefined ? { aliases: op.aliases } : {}),
					...(op.validFrom !== undefined ? { validFrom: op.validFrom } : {}),
					...(op.validUntil !== undefined ? { validUntil: op.validUntil } : {}),
					...(op.sourceEntryId !== undefined ? { sourceEntryId: op.sourceEntryId } : {}),
				},
				nowMs,
			);
			if (!saved.ok) {
				skippedReasons.push(`add skipped (${saved.reason}): ${saved.message}`);
			} else {
				added += 1;
			}
			continue;
		}

		if (op.op === "update") {
			const existing = Object.hasOwn(state.items, op.id) ? state.items[op.id] : undefined;
			if (existing === undefined || existing.status !== "active") {
				skippedReasons.push(`update skipped (missing or inactive id "${op.id}")`);
				continue;
			}
			const saved = atomic.save(
				state,
				{
					id: op.id,
					kind: op.kind ?? existing.kind,
					content: op.content,
					keywords:
						op.keywords !== undefined ? mergeStringLists(existing.keywords, op.keywords) : existing.keywords,
					aliases: op.aliases !== undefined ? mergeStringLists(existing.aliases, op.aliases) : existing.aliases,
					...(op.validFrom !== undefined ? { validFrom: op.validFrom } : {}),
					...(op.validUntil !== undefined ? { validUntil: op.validUntil } : {}),
					...(op.sourceEntryId !== undefined ? { sourceEntryId: op.sourceEntryId } : {}),
				},
				nowMs,
			);
			if (!saved.ok) {
				skippedReasons.push(`update "${op.id}" skipped (${saved.reason}): ${saved.message}`);
			} else {
				updated += 1;
			}
			continue;
		}

		if (op.op === "merge") {
			const kept = Object.hasOwn(state.items, op.keepId) ? state.items[op.keepId] : undefined;
			if (kept === undefined || kept.status !== "active") {
				skippedReasons.push(`merge skipped (missing or inactive keepId "${op.keepId}")`);
				continue;
			}
			const validDrops: MemoryItem[] = [];
			const seenDrops = new Set<string>();
			for (const dropId of op.dropIds) {
				if (dropId === op.keepId || seenDrops.has(dropId)) continue;
				const candidate = Object.hasOwn(state.items, dropId) ? state.items[dropId] : undefined;
				if (candidate !== undefined && candidate.status === "active") {
					seenDrops.add(dropId);
					validDrops.push(candidate);
				}
			}
			if (validDrops.length === 0) {
				skippedReasons.push(`merge "${op.keepId}" skipped (no active dropIds found)`);
				continue;
			}

			// Temporarily tombstone core dropIds before saving merged core content so maxCoreChars checks net length.
			const preForgottenDrops: MemoryItem[] = [];
			for (const drop of validDrops) {
				if (drop.kind === "core" && kept.kind === "core") {
					atomic.forget(state, drop.id, nowMs, `merged_into:${kept.id}`);
					preForgottenDrops.push(drop);
				}
			}

			const combinedKeywords = mergeStringLists(kept.keywords, ...validDrops.map((d) => d.keywords), op.keywords);
			const combinedAliases = mergeStringLists(kept.aliases, ...validDrops.map((d) => d.aliases), op.aliases);
			const saved = atomic.save(
				state,
				{
					id: kept.id,
					kind: kept.kind,
					content: op.content,
					keywords: combinedKeywords,
					aliases: combinedAliases,
					...(op.validFrom !== undefined ? { validFrom: op.validFrom } : {}),
					...(op.validUntil !== undefined ? { validUntil: op.validUntil } : {}),
				},
				nowMs,
			);
			if (!saved.ok) {
				for (const drop of preForgottenDrops) {
					atomic.restore(state, drop.id, nowMs);
				}
				skippedReasons.push(`merge "${op.keepId}" skipped (${saved.reason}): ${saved.message}`);
				continue;
			}

			for (const drop of validDrops) {
				atomic.forget(state, drop.id, nowMs, `merged_into:${kept.id}`);
			}
			merged += validDrops.length;
			continue;
		}

		if (op.op === "supersede") {
			const oldItem = Object.hasOwn(state.items, op.oldId) ? state.items[op.oldId] : undefined;
			if (oldItem === undefined || oldItem.status !== "active") {
				skippedReasons.push(`supersede skipped (missing or inactive oldId "${op.oldId}")`);
				continue;
			}
			// Temporarily tombstone oldItem if both are core so maxCoreChars evaluates the replacement cleanly.
			const preForgotOld = oldItem.kind === "core" && op.replacement.kind === "core";
			if (preForgotOld) {
				atomic.forget(state, oldItem.id, nowMs, "superseded_pending");
			}
			const saved = atomic.save(
				state,
				{
					kind: op.replacement.kind,
					content: op.replacement.content,
					...(op.replacement.keywords !== undefined ? { keywords: op.replacement.keywords } : {}),
					...(op.replacement.aliases !== undefined ? { aliases: op.replacement.aliases } : {}),
					...(op.replacement.validFrom !== undefined ? { validFrom: op.replacement.validFrom } : {}),
					...(op.replacement.validUntil !== undefined ? { validUntil: op.replacement.validUntil } : {}),
					...(op.replacement.sourceEntryId !== undefined ? { sourceEntryId: op.replacement.sourceEntryId } : {}),
				},
				nowMs,
			);
			if (!saved.ok) {
				if (preForgotOld) {
					atomic.restore(state, oldItem.id, nowMs);
				}
				skippedReasons.push(`supersede "${op.oldId}" skipped (${saved.reason}): ${saved.message}`);
				continue;
			}
			// Mark old item with explicit tombstone pointing to the new item ID.
			if (preForgotOld) {
				oldItem.forgetReason = `superseded_by:${saved.item.id}: ${op.reason}`;
			} else {
				atomic.forget(state, oldItem.id, nowMs, `superseded_by:${saved.item.id}: ${op.reason}`);
			}
			superseded += 1;
			continue;
		}

		if (op.op === "forget") {
			const result = atomic.forget(state, op.id, nowMs, op.reason);
			if (!result.ok || result.alreadyForgotten) {
				skippedReasons.push(`forget "${op.id}" skipped (${result.ok ? "already_forgotten" : "not_found"})`);
			} else {
				forgotten += 1;
			}
		}
	}

	return {
		added,
		updated,
		merged,
		superseded,
		forgotten,
		skipped: skippedReasons.length,
		skippedReasons,
	};
}

/** Formats a `MemoryConsolidationReport` into a concise chat reply for `/memory consolidate`. */
export function formatConsolidationReportReply(report: MemoryConsolidationReport): string {
	if (report.status === "noop") {
		if (report.reason === "unsupported") {
			return "当前记忆插件不支持后台记忆整理。";
		}
		if (report.reason === "below_min_turns") {
			return `新增对话仅 ${report.turnsScanned} 条，未达自动整理阈值，本次跳过。`;
		}
		return "自上次整理以来没有新增对话或待整理记忆，无需整理。";
	}
	if (report.status === "error") {
		return `记忆整理失败（水位线未推进）：${report.message}`;
	}
	const parts = [
		`[Memory Consolidate] scanned=${report.turnsScanned} turns | +${report.added} added, ~${report.updated} updated, merge=${report.merged}, supersede=${report.superseded}, forget=${report.forgotten}${report.skipped > 0 ? `, skipped=${report.skipped}` : ""}`,
	];
	if (report.summary !== undefined && report.summary.length > 0) {
		parts.push(`摘要：${report.summary}`);
	}
	return parts.join("\n");
}
