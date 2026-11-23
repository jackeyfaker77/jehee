// Pure TypeScript contract for Jehee's pluggable memory layer. Kept free of pi-durable imports so memory strategies
// remain plain data transformations that survive upstream Experimental API changes.

import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";

/** Summary emitted to a memory provider after a conversational run completes and commits its answer. */
export type TurnCompletedEvent = {
	readonly conversationId: string;
	readonly userMessages: readonly string[];
	readonly assistantReply: string;
};

/** Input passed to a memory provider right before a model request is sent, allowing transient context shaping. */
export type RequestContextInput = {
	readonly conversationId: string;
	readonly messages: readonly Message[];
};

/** Classification of one persisted atomic memory record. */
export type MemoryKind = "core" | "fact" | "episode" | "active";

/** Lifecycle status of one persisted atomic memory record. */
export type MemoryStatus = "active" | "forgotten";

/** One human-readable atomic memory record persisted in `MemoryDoc`. */
export type MemoryItem = {
	id: string;
	kind: MemoryKind;
	content: string;
	keywords: string[];
	aliases: string[];
	validFrom?: string;
	validUntil?: string;
	sourceEntryId?: string;
	sourceRef?: string;
	status: MemoryStatus;
	createdAtMs: number;
	updatedAtMs: number;
	forgottenAtMs?: number;
	forgetReason?: string;
};

/** Serializable conversation-scoped state holding all atomic memories and their monotonic ID counter. */
export type MemoryStoreState = {
	seq: number;
	items: Record<string, MemoryItem>;
};

/** Input for creating a new atomic memory item or updating an existing one by `id`. */
export type MemorySaveInput = {
	readonly id?: string;
	readonly kind: MemoryKind;
	readonly content: string;
	readonly keywords?: readonly string[];
	readonly aliases?: readonly string[];
	readonly validFrom?: string;
	readonly validUntil?: string;
	readonly sourceEntryId?: string;
	readonly sourceRef?: string;
};

/** Outcome of saving or updating an atomic memory item. */
export type MemorySaveResult =
	| { readonly ok: true; readonly item: MemoryItem; readonly created: boolean }
	| {
			readonly ok: false;
			readonly reason: "empty_content" | "not_found" | "core_limit_exceeded";
			readonly message: string;
	  };

/** Query parameters for on-demand atomic memory retrieval. */
export type MemorySearchQuery = {
	readonly query: string;
	readonly kind?: MemoryKind;
	readonly fromDate?: string;
	readonly toDate?: string;
	readonly limit?: number;
};

/** Ranked hit returned by `memory_search` and `/memory search`. */
export type MemorySearchHit = {
	readonly item: MemoryItem;
	readonly score: number;
};

/** Outcome of soft-deleting (forgetting) an atomic memory item. */
export type MemoryForgetResult =
	| { readonly ok: true; readonly item: MemoryItem; readonly alreadyForgotten: boolean }
	| { readonly ok: false; readonly reason: "not_found"; readonly id: string };

/** Outcome of restoring a previously forgotten atomic memory item. */
export type MemoryRestoreResult =
	| { readonly ok: true; readonly item: MemoryItem; readonly alreadyActive: boolean }
	| { readonly ok: false; readonly reason: "not_found" | "core_limit_exceeded"; readonly message: string };

/** Read-only summary returned by `/memory` inspection. */
export type MemoryInspectSnapshot = {
	readonly seedCorePrompt?: string;
	readonly coreItems: readonly MemoryItem[];
	readonly recentItems: readonly MemoryItem[];
	readonly totalActive: number;
	readonly totalForgotten: number;
	readonly coreChars: number;
	readonly maxCoreChars: number;
};

/** Optional model reference (`provider` + `modelId`) used by background memory consolidation. */
export type MemoryModelRef = {
	readonly provider: string;
	readonly modelId: string;
};

/** Configuration governing automatic idle and manual memory consolidation (Slice 5C-2). */
export type MemoryConsolidationPolicy = {
	/** Idle delay (ms) after the latest foreground turn before background consolidation runs. `0` disables auto-idle timer. */
	readonly idleDelayMs: number;
	/** Minimum number of new dialogue turns required for automatic idle runs (manual runs ignore this floor). */
	readonly minNewTurns: number;
	/** Optional dedicated model for consolidation; defaults to the host's `defaultModel`. */
	readonly model?: MemoryModelRef;
};

/** One structured memory mutation emitted by the background consolidation planner. */
export type ConsolidationOp =
	| {
			readonly op: "add";
			readonly kind: MemoryKind;
			readonly content: string;
			readonly keywords?: readonly string[];
			readonly aliases?: readonly string[];
			readonly validFrom?: string;
			readonly validUntil?: string;
			readonly sourceEntryId?: string;
	  }
	| {
			readonly op: "update";
			readonly id: string;
			readonly kind?: MemoryKind;
			readonly content: string;
			readonly keywords?: readonly string[];
			readonly aliases?: readonly string[];
			readonly validFrom?: string;
			readonly validUntil?: string;
			readonly sourceEntryId?: string;
	  }
	| {
			readonly op: "merge";
			readonly keepId: string;
			readonly dropIds: readonly string[];
			readonly content: string;
			readonly keywords?: readonly string[];
			readonly aliases?: readonly string[];
			readonly validFrom?: string;
			readonly validUntil?: string;
	  }
	| {
			readonly op: "supersede";
			readonly oldId: string;
			readonly reason: string;
			readonly replacement: {
				readonly kind: MemoryKind;
				readonly content: string;
				readonly keywords?: readonly string[];
				readonly aliases?: readonly string[];
				readonly validFrom?: string;
				readonly validUntil?: string;
				readonly sourceEntryId?: string;
			};
	  }
	| {
			readonly op: "forget";
			readonly id: string;
			readonly reason: string;
	  };

/** Validated consolidation batch produced by the planner model. */
export type ConsolidationPlan = {
	readonly summary?: string;
	readonly ops: readonly ConsolidationOp[];
};

/** Persisted high-water mark and telemetry counters for background memory consolidation. */
export type MemoryConsolidationState = {
	/** Highest transcript `EntryId` (as string) already scanned and committed by consolidation. */
	lastConsolidatedEntryId?: string;
	/** `MemoryDoc.seq` observed at the end of the last completed consolidation run. */
	lastConsolidatedMemorySeq?: number;
	/** Timestamp of the most recent completed foreground turn (used for idle debounce). */
	lastActivityAtMs?: number;
	/** Timestamp when the last consolidation run finished. */
	lastConsolidatedAtMs?: number;
	/** Outcome of the latest consolidation run. */
	lastRunStatus?: "ok" | "noop" | "error";
	lastRunSummary?: string;
	lastError?: string;
	/** Active single-flight background consolidation task ID (numeric pi-durable TaskId), if scheduled. */
	scheduledTaskId?: number;
	scheduledForMs?: number;
	totalRuns: number;
	totalAdded: number;
	totalUpdated: number;
	totalMerged: number;
	totalSuperseded: number;
	totalForgotten: number;
};

/** Structured report returned by `JeheeHost.consolidateMemory` and `/memory consolidate`. */
export type MemoryConsolidationReport =
	| {
			readonly status: "ok";
			readonly trigger: "manual" | "idle";
			readonly turnsScanned: number;
			readonly added: number;
			readonly updated: number;
			readonly merged: number;
			readonly superseded: number;
			readonly forgotten: number;
			readonly skipped: number;
			readonly skippedReasons: readonly string[];
			readonly summary?: string;
			readonly watermarkEntryId?: string;
	  }
	| {
			readonly status: "noop";
			readonly trigger: "manual" | "idle";
			readonly reason: "no_new_activity" | "below_min_turns" | "unsupported";
			readonly turnsScanned: number;
	  }
	| {
			readonly status: "error";
			readonly trigger: "manual" | "idle";
			readonly message: string;
	  };

/** Pure domain controller implemented by durable atomic memory providers and wired into `MemoryDoc` by `bridge.ts`. */
export type AtomicMemoryController = {
	readonly maxCoreChars: number;
	readonly seedCorePrompt?: string;
	readonly consolidation: MemoryConsolidationPolicy;
	renderCoreFromState(state: MemoryStoreState): string | undefined;
	save(state: MemoryStoreState, input: MemorySaveInput, nowMs: number): MemorySaveResult;
	search(state: MemoryStoreState, query: MemorySearchQuery): readonly MemorySearchHit[];
	forget(state: MemoryStoreState, id: string, nowMs: number, reason?: string): MemoryForgetResult;
	restore(state: MemoryStoreState, id: string, nowMs: number): MemoryRestoreResult;
	inspect(state: MemoryStoreState, recentLimit?: number): MemoryInspectSnapshot;
};

/** Pluggable memory strategy mounted by JeheeHost. */
export interface MemoryProvider {
	readonly id: string;
	/** Present when this provider uses durable `MemoryDoc` storage and mounts `memory_*` tools. */
	readonly atomic?: AtomicMemoryController;
	/** Renders the stable L1 core identity/preference block; unchanged text preserves provider KV-cache prefixes. */
	renderCorePrompt?(conversationId: string): string | undefined | Promise<string | undefined>;
	/** Shapes the per-request message list (for tail-injected drawers or sweet-spot windowing) without altering stored entries. */
	shapeRequestMessages?(
		input: RequestContextInput,
	): readonly Message[] | undefined | Promise<readonly Message[] | undefined>;
	/** Invoked after a run commits its final answer so memory providers can archive or classify turns asynchronously. */
	onTurnCompleted?(event: TurnCompletedEvent): void | Promise<void>;
}

/** Extracts plain text from a normalized pi-ai UserMessage. */
export function extractUserText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/** Extracts plain text from a normalized pi-ai AssistantMessage. */
export function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}
