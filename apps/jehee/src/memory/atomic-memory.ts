// Pure TypeScript atomic memory engine: L1 Core one-pager rendering with hard size guardrails, portable CJK + Latin
// keyword/alias/date-range retrieval, soft-delete tombstones, restore, and deterministic `/memory` formatting.

import type {
	AtomicMemoryController,
	MemoryConsolidationPolicy,
	MemoryConsolidationState,
	MemoryForgetResult,
	MemoryInspectSnapshot,
	MemoryItem,
	MemoryKind,
	MemoryModelRef,
	MemoryProvider,
	MemoryRestoreResult,
	MemorySaveInput,
	MemorySaveResult,
	MemorySearchHit,
	MemorySearchQuery,
	MemoryStoreState,
} from "./contract.ts";

/** Default character ceiling for the always-on L1 Core one-pager prompt section. */
export const DEFAULT_MAX_CORE_CHARS = 4_000;

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_RECENT_INSPECT_LIMIT = 10;

/** Options for creating an `AtomicMemoryProvider`. */
export type AtomicMemoryOptions = {
	readonly id?: string;
	/** Optional static seed prompt prepended to the L1 Core one-pager. */
	readonly seedCorePrompt?: string;
	/** Maximum allowed character length of the rendered L1 Core prompt (defaults to 4000). */
	readonly maxCoreChars?: number;
	/** Optional background idle/manual consolidation settings (Slice 5C-2). */
	readonly consolidation?: {
		/** Idle delay in ms before auto-running background consolidation (`0` disables auto timer). */
		readonly idleDelayMs?: number;
		/** Minimum new dialogue turns required before auto idle consolidation fires (defaults to 2). */
		readonly minNewTurns?: number;
		/** Optional dedicated consolidation model ref; falls back to host `defaultModel`. */
		readonly model?: MemoryModelRef;
	};
};

/** Creates an empty `MemoryStoreState`. */
export function createEmptyMemoryStoreState(): MemoryStoreState {
	return { seq: 0, items: {} };
}

function normalizeStringList(values: readonly string[] | undefined): string[] {
	if (values === undefined) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of values) {
		const trimmed = raw.trim();
		if (trimmed.length === 0) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

function toIsoDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function cloneItem(item: MemoryItem): MemoryItem {
	return {
		...item,
		keywords: [...item.keywords],
		aliases: [...item.aliases],
	};
}

function listActiveCoreItems(state: MemoryStoreState): MemoryItem[] {
	return Object.values(state.items)
		.filter((item) => item.kind === "core" && item.status === "active")
		.sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
}

function renderCoreWithItems(seedCorePrompt: string | undefined, coreItems: readonly MemoryItem[]): string | undefined {
	const blocks: string[] = [];
	const seed = seedCorePrompt?.trim();
	if (seed !== undefined && seed.length > 0) {
		blocks.push(seed);
	}
	if (coreItems.length > 0) {
		const lines = coreItems.map((item) => `- [${item.id}] ${item.content}`);
		blocks.push(lines.join("\n"));
	}
	if (blocks.length === 0) return undefined;
	return blocks.join("\n\n");
}

function tokenizeQuery(query: string): string[] {
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

function matchesDateRange(item: MemoryItem, fromDate: string | undefined, toDate: string | undefined): boolean {
	if (fromDate === undefined && toDate === undefined) return true;
	const fallbackDate = toIsoDate(item.createdAtMs);
	const itemStart = item.validFrom ?? fallbackDate;
	const itemEnd = item.validUntil ?? item.validFrom ?? fallbackDate;
	if (toDate !== undefined && itemStart > toDate) return false;
	if (fromDate !== undefined && itemEnd < fromDate) return false;
	return true;
}

function scoreItemAgainstQuery(item: MemoryItem, normalizedQuery: string, tokens: readonly string[]): number {
	let score = 0;
	const contentLower = item.content.toLowerCase();
	const keywordsLower = item.keywords.map((k) => k.toLowerCase());
	const aliasesLower = item.aliases.map((a) => a.toLowerCase());

	for (const alias of aliasesLower) {
		if (alias === normalizedQuery) {
			score += 12;
		} else if (alias.includes(normalizedQuery) || normalizedQuery.includes(alias)) {
			score += 7;
		}
	}

	for (const kw of keywordsLower) {
		if (kw === normalizedQuery) {
			score += 10;
		} else if (kw.includes(normalizedQuery) || normalizedQuery.includes(kw)) {
			score += 6;
		}
	}

	if (contentLower.includes(normalizedQuery)) {
		score += 8;
	}

	for (const token of tokens) {
		if (token === normalizedQuery) continue;
		if (aliasesLower.some((a) => a.includes(token))) {
			score += 4;
		}
		if (keywordsLower.some((k) => k.includes(token))) {
			score += 3;
		}
		if (contentLower.includes(token)) {
			score += 2;
		}
	}

	return score;
}

/** Renders the L1 Core one-pager prompt from `state` and an optional static seed prompt. */
export function renderCoreFromMemoryState(state: MemoryStoreState, seedCorePrompt?: string): string | undefined {
	return renderCoreWithItems(seedCorePrompt, listActiveCoreItems(state));
}

/** Saves a new atomic memory item or updates an existing item in `state`, enforcing `maxCoreChars` on `"core"` items. */
export function saveAtomicMemory(
	state: MemoryStoreState,
	input: MemorySaveInput,
	nowMs: number,
	options?: { readonly maxCoreChars?: number; readonly seedCorePrompt?: string },
): MemorySaveResult {
	const content = input.content.trim();
	if (content.length === 0) {
		return { ok: false, reason: "empty_content", message: "Memory content must not be empty." };
	}

	const maxCoreChars = options?.maxCoreChars ?? DEFAULT_MAX_CORE_CHARS;
	const keywords = normalizeStringList(input.keywords);
	const aliases = normalizeStringList(input.aliases);
	const validFrom = input.validFrom?.trim() || undefined;
	const validUntil = input.validUntil?.trim() || undefined;
	const sourceEntryId = input.sourceEntryId?.trim() || undefined;
	const sourceRef = input.sourceRef?.trim() || undefined;

	const existingId = input.id?.trim();
	let candidate: MemoryItem;
	let created: boolean;

	if (existingId !== undefined && existingId.length > 0) {
		const existing = Object.hasOwn(state.items, existingId) ? state.items[existingId] : undefined;
		if (existing === undefined) {
			return { ok: false, reason: "not_found", message: `Memory item "${existingId}" not found.` };
		}
		candidate = {
			id: existing.id,
			kind: input.kind,
			content,
			keywords: input.keywords !== undefined ? keywords : [...existing.keywords],
			aliases: input.aliases !== undefined ? aliases : [...existing.aliases],
			...(validFrom !== undefined
				? { validFrom }
				: existing.validFrom !== undefined
					? { validFrom: existing.validFrom }
					: {}),
			...(validUntil !== undefined
				? { validUntil }
				: existing.validUntil !== undefined
					? { validUntil: existing.validUntil }
					: {}),
			...(sourceEntryId !== undefined
				? { sourceEntryId }
				: existing.sourceEntryId !== undefined
					? { sourceEntryId: existing.sourceEntryId }
					: {}),
			...(sourceRef !== undefined
				? { sourceRef }
				: existing.sourceRef !== undefined
					? { sourceRef: existing.sourceRef }
					: {}),
			status: "active",
			createdAtMs: existing.createdAtMs,
			updatedAtMs: nowMs,
		};
		created = false;
	} else {
		const nextSeq = state.seq + 1;
		const id = `mem_${String(nextSeq).padStart(4, "0")}`;
		candidate = {
			id,
			kind: input.kind,
			content,
			keywords,
			aliases,
			...(validFrom !== undefined ? { validFrom } : {}),
			...(validUntil !== undefined ? { validUntil } : {}),
			...(sourceEntryId !== undefined ? { sourceEntryId } : {}),
			...(sourceRef !== undefined ? { sourceRef } : {}),
			status: "active",
			createdAtMs: nowMs,
			updatedAtMs: nowMs,
		};
		created = true;
	}

	if (candidate.kind === "core") {
		const projectedItems = listActiveCoreItems(state).filter((item) => item.id !== candidate.id);
		projectedItems.push(candidate);
		projectedItems.sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
		const rendered = renderCoreWithItems(options?.seedCorePrompt, projectedItems) ?? "";
		if (rendered.length > maxCoreChars) {
			return {
				ok: false,
				reason: "core_limit_exceeded",
				message: `L1 Core memory limit exceeded (${rendered.length}/${maxCoreChars} chars). Save this as kind="fact" or forget/shorten existing core items first.`,
			};
		}
	}

	if (created) {
		state.seq += 1;
	}
	state.items[candidate.id] = candidate;
	return { ok: true, item: cloneItem(candidate), created };
}

/** Searches active atomic memories by keywords, aliases, content, kind, and ISO date range. */
export function searchAtomicMemory(state: MemoryStoreState, query: MemorySearchQuery): readonly MemorySearchHit[] {
	const rawLimit = query.limit ?? DEFAULT_SEARCH_LIMIT;
	const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(rawLimit)));
	const normalizedQuery = query.query.trim().toLowerCase();
	const fromDate = query.fromDate?.trim() || undefined;
	const toDate = query.toDate?.trim() || undefined;
	const tokens = normalizedQuery.length > 0 ? tokenizeQuery(normalizedQuery) : [];

	const hits: MemorySearchHit[] = [];
	for (const item of Object.values(state.items)) {
		if (item.status !== "active") continue;
		if (query.kind !== undefined && item.kind !== query.kind) continue;
		if (!matchesDateRange(item, fromDate, toDate)) continue;

		if (normalizedQuery.length === 0) {
			hits.push({ item: cloneItem(item), score: 1 });
			continue;
		}

		const score = scoreItemAgainstQuery(item, normalizedQuery, tokens);
		if (score > 0) {
			hits.push({ item: cloneItem(item), score });
		}
	}

	hits.sort(
		(a, b) => b.score - a.score || b.item.updatedAtMs - a.item.updatedAtMs || b.item.id.localeCompare(a.item.id),
	);
	return hits.slice(0, limit);
}

/** Soft-deletes (tombstones) an atomic memory item so it disappears from L1 Core and search immediately. */
export function forgetAtomicMemory(
	state: MemoryStoreState,
	id: string,
	nowMs: number,
	reason?: string,
): MemoryForgetResult {
	const targetId = id.trim();
	const item = Object.hasOwn(state.items, targetId) ? state.items[targetId] : undefined;
	if (item === undefined) {
		return { ok: false, reason: "not_found", id: targetId };
	}
	if (item.status === "forgotten") {
		return { ok: true, item: cloneItem(item), alreadyForgotten: true };
	}
	item.status = "forgotten";
	item.forgottenAtMs = nowMs;
	item.updatedAtMs = nowMs;
	const cleanReason = reason?.trim();
	if (cleanReason !== undefined && cleanReason.length > 0) {
		item.forgetReason = cleanReason;
	}
	return { ok: true, item: cloneItem(item), alreadyForgotten: false };
}

/** Restores a previously forgotten atomic memory item back to `"active"`, enforcing `maxCoreChars` on `"core"` items. */
export function restoreAtomicMemory(
	state: MemoryStoreState,
	id: string,
	nowMs: number,
	options?: { readonly maxCoreChars?: number; readonly seedCorePrompt?: string },
): MemoryRestoreResult {
	const targetId = id.trim();
	const item = Object.hasOwn(state.items, targetId) ? state.items[targetId] : undefined;
	if (item === undefined) {
		return { ok: false, reason: "not_found", message: `Memory item "${targetId}" not found.` };
	}
	if (item.status === "active") {
		return { ok: true, item: cloneItem(item), alreadyActive: true };
	}
	const maxCoreChars = options?.maxCoreChars ?? DEFAULT_MAX_CORE_CHARS;
	if (item.kind === "core") {
		const projected = listActiveCoreItems(state);
		projected.push(item);
		projected.sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
		const rendered = renderCoreWithItems(options?.seedCorePrompt, projected) ?? "";
		if (rendered.length > maxCoreChars) {
			return {
				ok: false,
				reason: "core_limit_exceeded",
				message: `Restoring "${targetId}" would exceed L1 Core limit (${rendered.length}/${maxCoreChars} chars).`,
			};
		}
	}
	item.status = "active";
	delete item.forgottenAtMs;
	delete item.forgetReason;
	item.updatedAtMs = nowMs;
	return { ok: true, item: cloneItem(item), alreadyActive: false };
}

/** Builds a bounded inspection summary for `/memory`. */
export function inspectAtomicMemory(
	state: MemoryStoreState,
	recentLimit: number = DEFAULT_RECENT_INSPECT_LIMIT,
	options?: { readonly maxCoreChars?: number; readonly seedCorePrompt?: string },
): MemoryInspectSnapshot {
	const maxCoreChars = options?.maxCoreChars ?? DEFAULT_MAX_CORE_CHARS;
	const coreItems = listActiveCoreItems(state).map(cloneItem);
	const allItems = Object.values(state.items);
	const nonCoreActive = allItems
		.filter((item) => item.status === "active" && item.kind !== "core")
		.sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.id.localeCompare(a.id))
		.slice(0, Math.max(1, recentLimit))
		.map(cloneItem);
	const totalActive = allItems.filter((item) => item.status === "active").length;
	const totalForgotten = allItems.length - totalActive;
	const renderedCore = renderCoreWithItems(options?.seedCorePrompt, coreItems) ?? "";
	const seed = options?.seedCorePrompt?.trim();
	return {
		...(seed !== undefined && seed.length > 0 ? { seedCorePrompt: seed } : {}),
		coreItems,
		recentItems: nonCoreActive,
		totalActive,
		totalForgotten,
		coreChars: renderedCore.length,
		maxCoreChars,
	};
}

function formatDateSpan(item: MemoryItem): string {
	if (item.validFrom !== undefined && item.validUntil !== undefined) {
		return item.validFrom === item.validUntil ? ` (${item.validFrom})` : ` (${item.validFrom}..${item.validUntil})`;
	}
	if (item.validFrom !== undefined) return ` (from ${item.validFrom})`;
	if (item.validUntil !== undefined) return ` (until ${item.validUntil})`;
	return "";
}

/** Formats a `MemoryInspectSnapshot` (and optional consolidation status) into a concise chat reply for `/memory`. */
export function formatMemoryInspectReply(
	snapshot: MemoryInspectSnapshot,
	consolidation?: MemoryConsolidationState,
): string {
	const lines: string[] = [
		`[Memory] active=${snapshot.totalActive}, forgotten=${snapshot.totalForgotten}, core=${snapshot.coreChars}/${snapshot.maxCoreChars} chars`,
	];
	if (consolidation !== undefined && consolidation.totalRuns > 0) {
		const statusLabel = consolidation.lastRunStatus ?? "ok";
		lines.push(
			`[Consolidation] runs=${consolidation.totalRuns}, last=${statusLabel} (+${consolidation.totalAdded} added, ~${consolidation.totalUpdated} updated, merge=${consolidation.totalMerged}, supersede=${consolidation.totalSuperseded})`,
		);
	}
	if (snapshot.seedCorePrompt !== undefined || snapshot.coreItems.length > 0) {
		lines.push("", "L1 Core:");
		if (snapshot.seedCorePrompt !== undefined) {
			lines.push(`- [seed] ${snapshot.seedCorePrompt}`);
		}
		for (const item of snapshot.coreItems) {
			lines.push(`- [${item.id}] ${item.content}`);
		}
	} else {
		lines.push("", "L1 Core: (empty)");
	}

	if (snapshot.recentItems.length > 0) {
		lines.push("", "Recent Memories:");
		for (const item of snapshot.recentItems) {
			const aliases = item.aliases.length > 0 ? ` | aliases: ${item.aliases.join(", ")}` : "";
			const src = item.sourceEntryId !== undefined ? ` | src: ${item.sourceEntryId}` : "";
			lines.push(`- [${item.id}] (${item.kind})${formatDateSpan(item)} ${item.content}${aliases}${src}`);
		}
	} else {
		lines.push("", "Recent Memories: (none)");
	}
	return lines.join("\n");
}

/** Formats ranked search hits into a concise chat reply for `/memory search <query>`. */
export function formatMemorySearchReply(query: string, hits: readonly MemorySearchHit[]): string {
	if (hits.length === 0) {
		return `未找到匹配 "${query}" 的活跃记忆。`;
	}
	const lines: string[] = [`匹配 "${query}" 的记忆（${hits.length} 条）：`];
	for (const { item } of hits) {
		const aliases = item.aliases.length > 0 ? ` | aliases: ${item.aliases.join(", ")}` : "";
		const src = item.sourceEntryId !== undefined ? ` | src: ${item.sourceEntryId}` : "";
		lines.push(`- [${item.id}] (${item.kind})${formatDateSpan(item)} ${item.content}${aliases}${src}`);
	}
	return lines.join("\n");
}

/** Parses and validates a `JEHEE_MEMORY_PROVIDER` environment value. */
export function parseMemoryProviderEnv(raw: string | undefined): "atomic" | "static" | undefined {
	const trimmed = raw?.trim().toLowerCase();
	if (trimmed === undefined || trimmed.length === 0) return undefined;
	if (trimmed === "atomic" || trimmed === "static") return trimmed;
	throw new Error(`Invalid JEHEE_MEMORY_PROVIDER "${raw}": expected "atomic" or "static"`);
}

/** Pluggable durable atomic memory provider backed by `MemoryDoc` when mounted in `JeheeHost`. */
export class AtomicMemoryProvider implements MemoryProvider {
	readonly id: string;
	readonly atomic: AtomicMemoryController;
	readonly #seedCorePrompt: string | undefined;

	constructor(options: AtomicMemoryOptions = {}) {
		this.id = options.id ?? "atomic-memory";
		const seed = options.seedCorePrompt?.trim();
		this.#seedCorePrompt = seed !== undefined && seed.length > 0 ? seed : undefined;
		const maxCoreChars = options.maxCoreChars ?? DEFAULT_MAX_CORE_CHARS;
		const consolidation: MemoryConsolidationPolicy = {
			idleDelayMs: Math.max(0, Math.floor(options.consolidation?.idleDelayMs ?? 0)),
			minNewTurns: Math.max(1, Math.floor(options.consolidation?.minNewTurns ?? 2)),
			...(options.consolidation?.model !== undefined ? { model: options.consolidation.model } : {}),
		};
		const sharedOpts = {
			maxCoreChars,
			...(this.#seedCorePrompt !== undefined ? { seedCorePrompt: this.#seedCorePrompt } : {}),
		};
		this.atomic = {
			maxCoreChars,
			...(this.#seedCorePrompt !== undefined ? { seedCorePrompt: this.#seedCorePrompt } : {}),
			consolidation,
			renderCoreFromState: (state) => renderCoreFromMemoryState(state, this.#seedCorePrompt),
			save: (state, input, nowMs) => saveAtomicMemory(state, input, nowMs, sharedOpts),
			search: (state, query) => searchAtomicMemory(state, query),
			forget: (state, id, nowMs, reason) => forgetAtomicMemory(state, id, nowMs, reason),
			restore: (state, id, nowMs) => restoreAtomicMemory(state, id, nowMs, sharedOpts),
			inspect: (state, recentLimit) => inspectAtomicMemory(state, recentLimit, sharedOpts),
		};
	}

	/** Fallback static seed prompt when invoked outside a durable `MemoryDoc` reader context. */
	renderCorePrompt(): string | undefined {
		return this.#seedCorePrompt;
	}
}

/** Type guard helper for narrowing allowed `MemoryKind` values from untrusted strings. */
export function isMemoryKind(value: string): value is MemoryKind {
	return value === "core" || value === "fact" || value === "episode" || value === "active";
}
