// Harness- and model-independent portable snapshot format (`jehee.portable.snapshot` v1):
// lossless JSON serialization/validation, human/external-agent Markdown rendering, and deterministic merge/replace
// atomic memory import logic. Kept 100% pure TypeScript with zero `pi-durable` or `node:*` imports.

import { DEFAULT_MAX_CORE_CHARS, isMemoryKind, renderCoreFromMemoryState } from "./atomic-memory.ts";
import type { MemoryItem, MemoryKind, MemoryStatus, MemoryStoreState } from "./contract.ts";

/** Canonical schema identifier for Jehee portable context & memory snapshots. */
export const PORTABLE_SNAPSHOT_SCHEMA = "jehee.portable.snapshot";

/** Current portable snapshot schema version. */
export const PORTABLE_SNAPSHOT_VERSION = 1;

/** Normalized dialogue role recorded in portable conversation context snapshots. */
export type PortableDialogueRole = "user" | "assistant" | "summary";

/** One model- and harness-independent dialogue turn in a portable snapshot. */
export type PortableDialogueTurn = {
	readonly id: string;
	readonly role: PortableDialogueRole;
	readonly text: string;
	readonly timestampMs?: number;
	readonly model?: {
		readonly provider: string;
		readonly modelId: string;
	};
};

/** One serialized atomic memory record in a portable snapshot. */
export type PortableMemoryRecord = {
	readonly id: string;
	readonly kind: MemoryKind;
	readonly content: string;
	readonly keywords: readonly string[];
	readonly aliases: readonly string[];
	readonly validFrom?: string;
	readonly validUntil?: string;
	readonly sourceEntryId?: string;
	readonly sourceRef?: string;
	readonly status: MemoryStatus;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
	readonly forgottenAtMs?: number;
	readonly forgetReason?: string;
};

/** Scope of transcript entries captured during snapshot export. */
export type PortableTranscriptScope = "active" | "full";

/** Complete versioned portable snapshot of Jehee's memory and conversation context. */
export type PortableContextSnapshot = {
	readonly schema: typeof PORTABLE_SNAPSHOT_SCHEMA;
	readonly version: typeof PORTABLE_SNAPSHOT_VERSION;
	readonly exportedAt: string;
	readonly source?: {
		readonly app: "jehee";
		readonly memoryProviderId: string;
		readonly defaultModel?: {
			readonly provider: string;
			readonly modelId: string;
		};
		readonly conversationId?: string;
	};
	readonly memory: {
		readonly seedCorePrompt?: string;
		readonly corePrompt?: string;
		readonly items: readonly PortableMemoryRecord[];
	};
	readonly context: {
		readonly scope: PortableTranscriptScope;
		readonly turns: readonly PortableDialogueTurn[];
	};
};

/** Options controlling what `exportPortableSnapshot` includes. */
export type ExportSnapshotOptions = {
	/** Whether to include soft-deleted (`forgotten`) tombstones in the snapshot (defaults to `true`). */
	readonly includeForgotten?: boolean;
	/** `"active"` exports the active context window (post-reset/compaction); `"full"` scans the full transcript. */
	readonly transcriptScope?: PortableTranscriptScope;
	/** Optional cap retaining only the newest N dialogue turns. */
	readonly maxTurns?: number;
};

/** Import strategy for merging or replacing existing memory and context. */
export type ImportSnapshotMode = "merge" | "replace";

/** Options controlling how `importPortableSnapshot` applies a snapshot onto a host. */
export type ImportSnapshotOptions = {
	/** `"merge"` (default) deduplicates and preserves local IDs; `"replace"` resets memory and context baseline cleanly. */
	readonly mode?: ImportSnapshotMode;
	/** Whether to import atomic memory records (defaults to `true`). */
	readonly includeMemory?: boolean;
	/** Whether to replay conversation context turns into the root transcript (defaults to `true`). */
	readonly includeContext?: boolean;
	/** Whether to enforce L1 Core character limit on imported `"core"` records (defaults to `true`). */
	readonly respectCoreLimit?: boolean;
};

/** Result of strictly parsing and validating raw JSON text into a `PortableContextSnapshot`. */
export type ParsePortableSnapshotResult =
	| { readonly ok: true; readonly snapshot: PortableContextSnapshot }
	| { readonly ok: false; readonly error: string };

/** Deterministic counters produced by `applyPortableMemoryImport`. */
export type PortableMemoryApplyOutcome = {
	readonly imported: number;
	readonly skippedDuplicates: number;
	readonly reassignedIds: number;
	readonly skippedCoreLimit: number;
	readonly skippedReasons: readonly string[];
};

/** Settled outcome returned by `JeheeHost.importPortableSnapshot`. */
export type ImportSnapshotResult =
	| {
			readonly ok: true;
			readonly mode: ImportSnapshotMode;
			readonly memoriesImported: number;
			readonly memoriesSkippedDuplicates: number;
			readonly memoriesReassignedIds: number;
			readonly memoriesSkipped: number;
			readonly memoryUnsupported?: true;
			readonly contextTurnsImported: number;
			readonly contextResetApplied: boolean;
			readonly skippedReasons: readonly string[];
	  }
	| {
			readonly ok: false;
			readonly reason: "host_busy";
			readonly message: string;
	  };

/** Input for assembling a normalized `PortableContextSnapshot` from plain domain values. */
export type BuildPortableSnapshotInput = {
	readonly exportedAtMs: number;
	readonly memoryProviderId: string;
	readonly defaultModel?: { readonly provider: string; readonly modelId: string };
	readonly conversationId?: string;
	readonly seedCorePrompt?: string;
	readonly corePrompt?: string;
	readonly memoryState?: MemoryStoreState;
	readonly scope: PortableTranscriptScope;
	readonly turns: readonly PortableDialogueTurn[];
	readonly includeForgotten?: boolean;
	readonly maxTurns?: number;
};

function cloneMemoryRecord(item: MemoryItem): PortableMemoryRecord {
	return {
		id: item.id,
		kind: item.kind,
		content: item.content,
		keywords: [...item.keywords],
		aliases: [...item.aliases],
		...(item.validFrom !== undefined ? { validFrom: item.validFrom } : {}),
		...(item.validUntil !== undefined ? { validUntil: item.validUntil } : {}),
		...(item.sourceEntryId !== undefined ? { sourceEntryId: item.sourceEntryId } : {}),
		...(item.sourceRef !== undefined ? { sourceRef: item.sourceRef } : {}),
		status: item.status,
		createdAtMs: item.createdAtMs,
		updatedAtMs: item.updatedAtMs,
		...(item.forgottenAtMs !== undefined ? { forgottenAtMs: item.forgottenAtMs } : {}),
		...(item.forgetReason !== undefined ? { forgetReason: item.forgetReason } : {}),
	};
}

function cloneTurn(turn: PortableDialogueTurn): PortableDialogueTurn {
	return {
		id: turn.id,
		role: turn.role,
		text: turn.text,
		...(turn.timestampMs !== undefined ? { timestampMs: turn.timestampMs } : {}),
		...(turn.model !== undefined ? { model: { provider: turn.model.provider, modelId: turn.model.modelId } } : {}),
	};
}

/** Assembles a deterministic, harness-independent `PortableContextSnapshot` from plain state and dialogue turns. */
export function buildPortableSnapshot(input: BuildPortableSnapshotInput): PortableContextSnapshot {
	const includeForgotten = input.includeForgotten !== false;
	const rawItems = input.memoryState !== undefined ? Object.values(input.memoryState.items) : [];
	const items = rawItems
		.filter((item) => includeForgotten || item.status === "active")
		.sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id))
		.map(cloneMemoryRecord);

	const seed = input.seedCorePrompt?.trim();
	const core = input.corePrompt?.trim();
	const boundedTurns =
		input.maxTurns !== undefined && input.maxTurns >= 0
			? input.turns.slice(-Math.floor(input.maxTurns)).map(cloneTurn)
			: input.turns.map(cloneTurn);

	return {
		schema: PORTABLE_SNAPSHOT_SCHEMA,
		version: PORTABLE_SNAPSHOT_VERSION,
		exportedAt: new Date(input.exportedAtMs).toISOString(),
		source: {
			app: "jehee",
			memoryProviderId: input.memoryProviderId,
			...(input.defaultModel !== undefined
				? { defaultModel: { provider: input.defaultModel.provider, modelId: input.defaultModel.modelId } }
				: {}),
			...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
		},
		memory: {
			...(seed !== undefined && seed.length > 0 ? { seedCorePrompt: seed } : {}),
			...(core !== undefined && core.length > 0 ? { corePrompt: core } : {}),
			items,
		},
		context: {
			scope: input.scope,
			turns: boundedTurns,
		},
	};
}

/** Serializes a `PortableContextSnapshot` into canonical UTF-8 JSON text. */
export function serializePortableSnapshotJson(snapshot: PortableContextSnapshot, pretty: boolean = true): string {
	return pretty ? `${JSON.stringify(snapshot, null, 2)}\n` : JSON.stringify(snapshot);
}

// Trust boundary: imported snapshot JSON is untrusted external file/wire input and must be strictly validated.
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(rec: Record<string, unknown>, key: string): string | undefined {
	const val = rec[key];
	if (typeof val !== "string") return undefined;
	const trimmed = val.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalTrimmedString(rec: Record<string, unknown>, key: string): string | undefined | null {
	const val = rec[key];
	if (val === undefined) return undefined;
	if (typeof val !== "string") return null;
	const trimmed = val.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalStringArray(rec: Record<string, unknown>, key: string): string[] | null {
	const val = rec[key];
	if (val === undefined) return [];
	if (!Array.isArray(val)) return null;
	const out: string[] = [];
	const seen = new Set<string>();
	for (const entry of val) {
		if (typeof entry !== "string") return null;
		const trimmed = entry.trim();
		if (trimmed.length === 0) continue;
		const dedupKey = trimmed.toLowerCase();
		if (seen.has(dedupKey)) continue;
		seen.add(dedupKey);
		out.push(trimmed);
	}
	return out;
}

function readFiniteNumber(rec: Record<string, unknown>, key: string): number | undefined {
	const val = rec[key];
	return typeof val === "number" && Number.isFinite(val) ? val : undefined;
}

function isMemoryStatus(value: string): value is MemoryStatus {
	return value === "active" || value === "forgotten";
}

function isDialogueRole(value: string): value is PortableDialogueRole {
	return value === "user" || value === "assistant" || value === "summary";
}

function parseMemoryRecord(
	raw: unknown,
	index: number,
): { readonly ok: true; readonly record: PortableMemoryRecord } | { readonly ok: false; readonly error: string } {
	if (!isPlainRecord(raw)) {
		return { ok: false, error: `memory.items[${index}] must be an object` };
	}
	const id = readRequiredString(raw, "id");
	if (id === undefined) return { ok: false, error: `memory.items[${index}].id must be a non-empty string` };
	const kind = readRequiredString(raw, "kind");
	if (kind === undefined || !isMemoryKind(kind)) {
		return { ok: false, error: `memory.items[${index}].kind must be one of core|fact|episode|active` };
	}
	const content = readRequiredString(raw, "content");
	if (content === undefined) {
		return { ok: false, error: `memory.items[${index}].content must be a non-empty string` };
	}
	const rawStatus = raw.status === undefined ? "active" : readRequiredString(raw, "status");
	if (rawStatus === undefined || !isMemoryStatus(rawStatus)) {
		return { ok: false, error: `memory.items[${index}].status must be "active" or "forgotten"` };
	}
	const keywords = readOptionalStringArray(raw, "keywords");
	if (keywords === null) return { ok: false, error: `memory.items[${index}].keywords must be an array of strings` };
	const aliases = readOptionalStringArray(raw, "aliases");
	if (aliases === null) return { ok: false, error: `memory.items[${index}].aliases must be an array of strings` };

	const validFrom = readOptionalTrimmedString(raw, "validFrom");
	if (validFrom === null) return { ok: false, error: `memory.items[${index}].validFrom must be a string` };
	const validUntil = readOptionalTrimmedString(raw, "validUntil");
	if (validUntil === null) return { ok: false, error: `memory.items[${index}].validUntil must be a string` };
	const sourceEntryId = readOptionalTrimmedString(raw, "sourceEntryId");
	if (sourceEntryId === null) return { ok: false, error: `memory.items[${index}].sourceEntryId must be a string` };
	const sourceRef = readOptionalTrimmedString(raw, "sourceRef");
	if (sourceRef === null) return { ok: false, error: `memory.items[${index}].sourceRef must be a string` };
	const forgetReason = readOptionalTrimmedString(raw, "forgetReason");
	if (forgetReason === null) return { ok: false, error: `memory.items[${index}].forgetReason must be a string` };

	const createdAtMs = readFiniteNumber(raw, "createdAtMs");
	if (createdAtMs === undefined) {
		return { ok: false, error: `memory.items[${index}].createdAtMs must be a finite number` };
	}
	const updatedAtMs = readFiniteNumber(raw, "updatedAtMs") ?? createdAtMs;
	const forgottenAtMs = raw.forgottenAtMs === undefined ? undefined : readFiniteNumber(raw, "forgottenAtMs");
	if (raw.forgottenAtMs !== undefined && forgottenAtMs === undefined) {
		return { ok: false, error: `memory.items[${index}].forgottenAtMs must be a finite number` };
	}

	return {
		ok: true,
		record: {
			id,
			kind,
			content,
			keywords,
			aliases,
			...(validFrom !== undefined ? { validFrom } : {}),
			...(validUntil !== undefined ? { validUntil } : {}),
			...(sourceEntryId !== undefined ? { sourceEntryId } : {}),
			...(sourceRef !== undefined ? { sourceRef } : {}),
			status: rawStatus,
			createdAtMs,
			updatedAtMs,
			...(forgottenAtMs !== undefined ? { forgottenAtMs } : {}),
			...(forgetReason !== undefined ? { forgetReason } : {}),
		},
	};
}

function parseDialogueTurn(
	raw: unknown,
	index: number,
): { readonly ok: true; readonly turn: PortableDialogueTurn } | { readonly ok: false; readonly error: string } {
	if (!isPlainRecord(raw)) {
		return { ok: false, error: `context.turns[${index}] must be an object` };
	}
	const id = readRequiredString(raw, "id") ?? `turn_${index + 1}`;
	const role = readRequiredString(raw, "role");
	if (role === undefined || !isDialogueRole(role)) {
		return { ok: false, error: `context.turns[${index}].role must be one of user|assistant|summary` };
	}
	const text = readRequiredString(raw, "text");
	if (text === undefined) {
		return { ok: false, error: `context.turns[${index}].text must be a non-empty string` };
	}
	const timestampMs = raw.timestampMs === undefined ? undefined : readFiniteNumber(raw, "timestampMs");
	if (raw.timestampMs !== undefined && timestampMs === undefined) {
		return { ok: false, error: `context.turns[${index}].timestampMs must be a finite number` };
	}
	let model: { readonly provider: string; readonly modelId: string } | undefined;
	if (raw.model !== undefined) {
		if (!isPlainRecord(raw.model)) {
			return { ok: false, error: `context.turns[${index}].model must be an object` };
		}
		const provider = readRequiredString(raw.model, "provider");
		const modelId = readRequiredString(raw.model, "modelId");
		if (provider === undefined || modelId === undefined) {
			return { ok: false, error: `context.turns[${index}].model requires non-empty provider and modelId` };
		}
		model = { provider, modelId };
	}
	return {
		ok: true,
		turn: {
			id,
			role,
			text,
			...(timestampMs !== undefined ? { timestampMs } : {}),
			...(model !== undefined ? { model } : {}),
		},
	};
}

/** Strictly parses and validates untrusted JSON text into a `PortableContextSnapshot`. */
export function parsePortableSnapshotJson(raw: string): ParsePortableSnapshotResult {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return { ok: false, error: "Portable snapshot JSON is empty." };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		return {
			ok: false,
			error: `Invalid portable snapshot JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (!isPlainRecord(parsed)) {
		return { ok: false, error: "Portable snapshot must be a JSON object." };
	}
	if (parsed.schema !== PORTABLE_SNAPSHOT_SCHEMA) {
		return {
			ok: false,
			error: `Unsupported snapshot schema "${String(parsed.schema)}": expected "${PORTABLE_SNAPSHOT_SCHEMA}".`,
		};
	}
	if (parsed.version !== PORTABLE_SNAPSHOT_VERSION) {
		return {
			ok: false,
			error: `Unsupported snapshot version "${String(parsed.version)}": expected ${PORTABLE_SNAPSHOT_VERSION}.`,
		};
	}
	const exportedAt = readRequiredString(parsed, "exportedAt");
	if (exportedAt === undefined) {
		return { ok: false, error: "Portable snapshot requires a non-empty exportedAt ISO string." };
	}

	let source: PortableContextSnapshot["source"];
	if (parsed.source !== undefined) {
		if (!isPlainRecord(parsed.source)) {
			return { ok: false, error: "Portable snapshot source must be an object." };
		}
		const memoryProviderId = readRequiredString(parsed.source, "memoryProviderId") ?? "unknown";
		const conversationId = readOptionalTrimmedString(parsed.source, "conversationId");
		if (conversationId === null) {
			return { ok: false, error: "Portable snapshot source.conversationId must be a string." };
		}
		let defaultModel: { readonly provider: string; readonly modelId: string } | undefined;
		if (parsed.source.defaultModel !== undefined) {
			if (!isPlainRecord(parsed.source.defaultModel)) {
				return { ok: false, error: "Portable snapshot source.defaultModel must be an object." };
			}
			const provider = readRequiredString(parsed.source.defaultModel, "provider");
			const modelId = readRequiredString(parsed.source.defaultModel, "modelId");
			if (provider === undefined || modelId === undefined) {
				return { ok: false, error: "Portable snapshot source.defaultModel requires provider and modelId." };
			}
			defaultModel = { provider, modelId };
		}
		source = {
			app: "jehee",
			memoryProviderId,
			...(defaultModel !== undefined ? { defaultModel } : {}),
			...(conversationId !== undefined ? { conversationId } : {}),
		};
	}

	if (!isPlainRecord(parsed.memory)) {
		return { ok: false, error: "Portable snapshot requires a memory object." };
	}
	if (!Array.isArray(parsed.memory.items)) {
		return { ok: false, error: "Portable snapshot memory.items must be an array." };
	}
	const seedCorePrompt = readOptionalTrimmedString(parsed.memory, "seedCorePrompt");
	if (seedCorePrompt === null) {
		return { ok: false, error: "Portable snapshot memory.seedCorePrompt must be a string." };
	}
	const corePrompt = readOptionalTrimmedString(parsed.memory, "corePrompt");
	if (corePrompt === null) {
		return { ok: false, error: "Portable snapshot memory.corePrompt must be a string." };
	}
	const items: PortableMemoryRecord[] = [];
	for (let i = 0; i < parsed.memory.items.length; i += 1) {
		const itemRes = parseMemoryRecord(parsed.memory.items[i], i);
		if (!itemRes.ok) return itemRes;
		items.push(itemRes.record);
	}

	if (!isPlainRecord(parsed.context)) {
		return { ok: false, error: "Portable snapshot requires a context object." };
	}
	const rawScope = parsed.context.scope === undefined ? "active" : parsed.context.scope;
	if (rawScope !== "active" && rawScope !== "full") {
		return { ok: false, error: `Portable snapshot context.scope must be "active" or "full".` };
	}
	if (!Array.isArray(parsed.context.turns)) {
		return { ok: false, error: "Portable snapshot context.turns must be an array." };
	}
	const turns: PortableDialogueTurn[] = [];
	for (let i = 0; i < parsed.context.turns.length; i += 1) {
		const turnRes = parseDialogueTurn(parsed.context.turns[i], i);
		if (!turnRes.ok) return turnRes;
		turns.push(turnRes.turn);
	}

	return {
		ok: true,
		snapshot: {
			schema: PORTABLE_SNAPSHOT_SCHEMA,
			version: PORTABLE_SNAPSHOT_VERSION,
			exportedAt,
			...(source !== undefined ? { source } : {}),
			memory: {
				...(seedCorePrompt !== undefined ? { seedCorePrompt } : {}),
				...(corePrompt !== undefined ? { corePrompt } : {}),
				items,
			},
			context: {
				scope: rawScope,
				turns,
			},
		},
	};
}

function formatDateSpan(item: PortableMemoryRecord): string {
	if (item.validFrom !== undefined && item.validUntil !== undefined) {
		return item.validFrom === item.validUntil ? ` (${item.validFrom})` : ` (${item.validFrom}..${item.validUntil})`;
	}
	if (item.validFrom !== undefined) return ` (from ${item.validFrom})`;
	if (item.validUntil !== undefined) return ` (until ${item.validUntil})`;
	return "";
}

/** Renders a `PortableContextSnapshot` into human- and external-agent-readable Markdown. */
export function renderPortableSnapshotMarkdown(snapshot: PortableContextSnapshot): string {
	const activeItems = snapshot.memory.items.filter((item) => item.status === "active");
	const forgottenItems = snapshot.memory.items.filter((item) => item.status === "forgotten");
	const activeCore = activeItems.filter((item) => item.kind === "core");
	const activeNonCore = activeItems.filter((item) => item.kind !== "core");

	const lines: string[] = [
		"# Jehee Portable Context & Memory Snapshot",
		"",
		`- **Schema**: \`${snapshot.schema}\` v${snapshot.version}`,
		`- **Exported At**: ${snapshot.exportedAt}`,
	];
	if (snapshot.source !== undefined) {
		const modelLabel =
			snapshot.source.defaultModel !== undefined
				? `${snapshot.source.defaultModel.provider}/${snapshot.source.defaultModel.modelId}`
				: "unspecified";
		lines.push(`- **Memory Provider**: \`${snapshot.source.memoryProviderId}\` | **Model**: \`${modelLabel}\``);
	}
	lines.push(
		`- **Stats**: active_memories=${activeItems.length}, forgotten_memories=${forgottenItems.length}, context_turns=${snapshot.context.turns.length} (${snapshot.context.scope})`,
		"",
		"## L1 Core Memory",
		"",
	);

	if (snapshot.memory.seedCorePrompt !== undefined || activeCore.length > 0) {
		if (snapshot.memory.seedCorePrompt !== undefined) {
			lines.push(`- [seed] ${snapshot.memory.seedCorePrompt}`);
		}
		for (const item of activeCore) {
			lines.push(`- [${item.id}]${formatDateSpan(item)} ${item.content}`);
		}
	} else if (snapshot.memory.corePrompt !== undefined) {
		lines.push(snapshot.memory.corePrompt);
	} else {
		lines.push("(empty)");
	}

	lines.push("", "## Atomic Memories", "");
	if (activeNonCore.length === 0) {
		lines.push("(none)");
	} else {
		for (const item of activeNonCore) {
			const meta: string[] = [];
			if (item.keywords.length > 0) meta.push(`keywords: ${item.keywords.join(", ")}`);
			if (item.aliases.length > 0) meta.push(`aliases: ${item.aliases.join(", ")}`);
			if (item.sourceEntryId !== undefined) meta.push(`src: ${item.sourceEntryId}`);
			if (item.sourceRef !== undefined) meta.push(`ref: ${item.sourceRef}`);
			const suffix = meta.length > 0 ? ` | ${meta.join(" | ")}` : "";
			lines.push(`- [${item.id}] (${item.kind})${formatDateSpan(item)} ${item.content}${suffix}`);
		}
	}

	if (forgottenItems.length > 0) {
		lines.push("", "## Forgotten Memories (Tombstones)", "");
		for (const item of forgottenItems) {
			const reason = item.forgetReason !== undefined ? ` | reason: ${item.forgetReason}` : "";
			lines.push(`- [${item.id}] (${item.kind}) ${item.content}${reason}`);
		}
	}

	lines.push("", `## Conversation Context (${snapshot.context.scope})`, "");
	if (snapshot.context.turns.length === 0) {
		lines.push("(none)");
	} else {
		for (const turn of snapshot.context.turns) {
			const ts = turn.timestampMs !== undefined ? ` @ ${new Date(turn.timestampMs).toISOString()}` : "";
			const model = turn.model !== undefined ? ` [${turn.model.provider}/${turn.model.modelId}]` : "";
			lines.push(`### ${turn.role.toUpperCase()} (#${turn.id}${ts}${model})`, "", turn.text, "");
		}
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

function normalizeMemoryKey(kind: MemoryKind, content: string): string {
	return `${kind}::${content.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

function parseNumericMemorySeq(id: string): number {
	const match = /^mem_(\d+)$/.exec(id);
	if (match === null) return 0;
	const num = Number(match[1]);
	return Number.isSafeInteger(num) && num > 0 ? num : 0;
}

function allocateNextMemoryId(state: MemoryStoreState): string {
	let candidate: string;
	do {
		state.seq += 1;
		candidate = `mem_${String(state.seq).padStart(4, "0")}`;
	} while (Object.hasOwn(state.items, candidate));
	return candidate;
}

function buildMemoryItemFromRecord(record: PortableMemoryRecord, assignedId: string): MemoryItem {
	return {
		id: assignedId,
		kind: record.kind,
		content: record.content,
		keywords: [...record.keywords],
		aliases: [...record.aliases],
		...(record.validFrom !== undefined ? { validFrom: record.validFrom } : {}),
		...(record.validUntil !== undefined ? { validUntil: record.validUntil } : {}),
		...(record.sourceEntryId !== undefined ? { sourceEntryId: record.sourceEntryId } : {}),
		...(record.sourceRef !== undefined ? { sourceRef: record.sourceRef } : {}),
		status: record.status,
		createdAtMs: record.createdAtMs,
		updatedAtMs: record.updatedAtMs,
		...(record.forgottenAtMs !== undefined ? { forgottenAtMs: record.forgottenAtMs } : {}),
		...(record.forgetReason !== undefined ? { forgetReason: record.forgetReason } : {}),
	};
}

/**
 * Deterministically applies portable memory records onto `state` in `"merge"` or `"replace"` mode.
 * Enforces L1 Core character guardrails when `respectCoreLimit !== false` and protects local IDs on collision in merge mode.
 */
export function applyPortableMemoryImport(
	state: MemoryStoreState,
	records: readonly PortableMemoryRecord[],
	options?: {
		readonly mode?: ImportSnapshotMode;
		readonly maxCoreChars?: number;
		readonly seedCorePrompt?: string;
		readonly respectCoreLimit?: boolean;
	},
): PortableMemoryApplyOutcome {
	const mode: ImportSnapshotMode = options?.mode ?? "merge";
	const respectCoreLimit = options?.respectCoreLimit !== false;
	const maxCoreChars = options?.maxCoreChars ?? DEFAULT_MAX_CORE_CHARS;

	if (mode === "replace") {
		state.seq = 0;
		for (const key of Object.keys(state.items)) {
			delete state.items[key];
		}
	}

	const existingActiveKeys = new Set<string>();
	const existingAllKeysById = new Map<string, string>();
	for (const existing of Object.values(state.items)) {
		existingAllKeysById.set(
			existing.id,
			`${existing.status}::${normalizeMemoryKey(existing.kind, existing.content)}`,
		);
		if (existing.status === "active") {
			existingActiveKeys.add(normalizeMemoryKey(existing.kind, existing.content));
		}
		const seq = parseNumericMemorySeq(existing.id);
		if (seq > state.seq) state.seq = seq;
	}

	let imported = 0;
	let skippedDuplicates = 0;
	let reassignedIds = 0;
	let skippedCoreLimit = 0;
	const skippedReasons: string[] = [];

	for (const record of records) {
		const normKey = normalizeMemoryKey(record.kind, record.content);
		const fullKey = `${record.status}::${normKey}`;

		if (mode === "merge") {
			if (record.status === "active" && existingActiveKeys.has(normKey)) {
				skippedDuplicates += 1;
				continue;
			}
			if (existingAllKeysById.get(record.id) === fullKey) {
				skippedDuplicates += 1;
				continue;
			}
		}

		let assignedId = record.id;
		if (Object.hasOwn(state.items, assignedId)) {
			assignedId = allocateNextMemoryId(state);
			reassignedIds += 1;
		} else {
			const seq = parseNumericMemorySeq(assignedId);
			if (seq > state.seq) {
				state.seq = seq;
			}
		}

		const candidate = buildMemoryItemFromRecord(record, assignedId);
		if (respectCoreLimit && candidate.kind === "core" && candidate.status === "active") {
			const projected: MemoryStoreState = {
				seq: state.seq,
				items: { ...state.items, [candidate.id]: candidate },
			};
			const rendered = renderCoreFromMemoryState(projected, options?.seedCorePrompt) ?? "";
			if (rendered.length > maxCoreChars) {
				skippedCoreLimit += 1;
				skippedReasons.push(
					`Skipped core memory "${record.id}" (exceeds L1 Core limit ${rendered.length}/${maxCoreChars} chars).`,
				);
				continue;
			}
		}

		state.items[candidate.id] = candidate;
		existingAllKeysById.set(candidate.id, fullKey);
		if (candidate.status === "active") {
			existingActiveKeys.add(normKey);
		}
		imported += 1;
	}

	return {
		imported,
		skippedDuplicates,
		reassignedIds,
		skippedCoreLimit,
		skippedReasons,
	};
}

/** Formats an `ImportSnapshotResult` into a concise human-readable report for CLI and operational feedback. */
export function formatImportSnapshotReply(result: ImportSnapshotResult): string {
	if (!result.ok) {
		return `[Snapshot Import Failed] (${result.reason}): ${result.message}`;
	}
	const parts = [
		`[Snapshot Import] mode=${result.mode} | memories: +${result.memoriesImported} imported, ${result.memoriesSkippedDuplicates} duplicate(s) skipped${result.memoriesReassignedIds > 0 ? `, ${result.memoriesReassignedIds} ID(s) reassigned` : ""}${result.memoriesSkipped > 0 ? `, ${result.memoriesSkipped} skipped` : ""} | context: +${result.contextTurnsImported} turn(s)${result.contextResetApplied ? " (reset baseline)" : ""}`,
	];
	if (result.memoryUnsupported) {
		parts.push("Note: current host uses a static memory provider; atomic memory records were skipped.");
	}
	for (const reason of result.skippedReasons) {
		parts.push(`- ${reason}`);
	}
	return parts.join("\n");
}
