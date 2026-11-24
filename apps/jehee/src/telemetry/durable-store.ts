// Durable session-scoped ring buffer (`TraceDoc`) for persisting recent turn traces across SQLite restarts
// and Cloudflare Durable Object hibernation, plus pure formatters for `/trace` and `/trace list`.

import { defineDoc } from "@earendil-works/pi-durable";
import type { StoredTrace } from "@earendil-works/pi-telemetry";
import { renderTrace } from "@earendil-works/pi-telemetry/render";
import { computeTraceMetrics } from "./recorder.ts";

/** Maximum number of recent traces retained in SQLite `TraceDoc`. */
export const MAX_PERSISTED_TRACES = 20;

const MAX_RENDERED_TREE_CHARS = 6_000;
const MAX_LABEL_CHARS = 80;
const MAX_TELEGRAM_TRACE_CHARS = 3_600;

/** Compact persisted snapshot of one settled turn trace stored in `TraceDoc`. */
export type PersistedTraceEntry = {
	readonly id: number;
	readonly traceId: string;
	readonly submissionId?: number;
	readonly recordedAtMs: number;
	readonly label: string;
	readonly status: "ok" | "error";
	readonly llmTurns: number;
	readonly toolCalls: number;
	readonly mcpCalls: number;
	readonly mcpErrors: number;
	readonly prefillTokens: number;
	readonly outputTokens: number;
	readonly cacheHitRate: number;
	readonly costUsd: number;
	readonly wallTimeMs: number;
	readonly renderedTree: string;
};

/** Session-scoped document state holding the ring buffer of recent turn traces. */
export type TraceStoreState = {
	seq: number;
	entries: PersistedTraceEntry[];
};

/** Creates an empty `TraceStoreState`. */
export function createEmptyTraceStoreState(): TraceStoreState {
	return { seq: 0, entries: [] };
}

/** Session-scoped SQLite document storing the last `MAX_PERSISTED_TRACES` turn traces (Web/Edge portable). */
export const TraceDoc = defineDoc<TraceStoreState>({
	kind: "jehee.traces",
	version: 1,
	scope: "session",
	initial: createEmptyTraceStoreState,
	checkpointWhen: () => false,
});

function sanitizeSingleLine(raw: string, maxChars: number): string {
	const collapsed = raw.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxChars) return collapsed;
	return `${collapsed.slice(0, Math.max(1, maxChars - 1))}…`;
}

function truncateTree(tree: string, maxChars: number): string {
	if (tree.length <= maxChars) return tree;
	return `${tree.slice(0, maxChars)}\n... [truncated ${tree.length - maxChars} chars]`;
}

/** Projects a settled `StoredTrace` into a compact persistable payload (excluding monotonic `id`). */
export function buildPersistedTraceInput(
	trace: StoredTrace,
	meta: {
		readonly label: string;
		readonly recordedAtMs: number;
		readonly submissionId?: number;
		readonly turnError?: boolean;
	},
): Omit<PersistedTraceEntry, "id"> {
	const metrics = computeTraceMetrics(trace.spans);
	const hasSpanError = trace.spans.some(
		(span) =>
			span.status.status === "error" ||
			span.events.some(
				(ev) =>
					ev.name === "pi.durable.report" &&
					(ev.attributes.type === "extension_error" || ev.attributes.type === "task_faulted"),
			),
	);
	const status: "ok" | "error" = meta.turnError === true || hasSpanError || metrics.mcpErrors > 0 ? "error" : "ok";
	const renderedTree = truncateTree(renderTrace(trace.spans).trimEnd(), MAX_RENDERED_TREE_CHARS);
	return {
		traceId: trace.traceId,
		...(meta.submissionId !== undefined ? { submissionId: meta.submissionId } : {}),
		recordedAtMs: meta.recordedAtMs,
		label: sanitizeSingleLine(meta.label, MAX_LABEL_CHARS) || "(turn)",
		status,
		llmTurns: metrics.llmTurns,
		toolCalls: metrics.toolCalls,
		mcpCalls: metrics.mcpCalls,
		mcpErrors: metrics.mcpErrors,
		prefillTokens: metrics.prefillTokens,
		outputTokens: metrics.outputTokens,
		cacheHitRate: metrics.cacheHitRate,
		costUsd: metrics.costUsd,
		wallTimeMs: metrics.wallTimeMs,
		renderedTree,
	};
}

/** Appends one trace snapshot into `TraceStoreState` inside a transaction and evicts oldest entries past `maxEntries`. */
export function appendPersistedTrace(
	state: TraceStoreState,
	input: Omit<PersistedTraceEntry, "id">,
	maxEntries: number = MAX_PERSISTED_TRACES,
): PersistedTraceEntry {
	state.seq += 1;
	const entry: PersistedTraceEntry = { id: state.seq, ...input };
	state.entries.push(entry);
	const cap = Math.max(1, Math.floor(maxEntries));
	if (state.entries.length > cap) {
		state.entries.splice(0, state.entries.length - cap);
	}
	return entry;
}

function formatUtcShortTime(ms: number): string {
	return new Date(ms).toISOString().slice(5, 19).replace("T", " ");
}

/** Formats recent trace entries (newest first) for `/trace list`. */
export function formatTraceListReply(entries: readonly PersistedTraceEntry[]): string {
	if (entries.length === 0) {
		return "暂无可查询的 Trace 记录（完成任意一轮对话后会自动留存）。";
	}
	const lines: string[] = [`[Traces] 最近 ${entries.length} 轮（用 /trace <编号> 查看完整决策树）：`];
	for (const item of entries) {
		const cachePct = (item.cacheHitRate * 100).toFixed(0);
		const mcpPart =
			item.mcpCalls > 0 ? ` mcp=${item.mcpCalls}${item.mcpErrors > 0 ? `(err=${item.mcpErrors})` : ""}` : "";
		lines.push(
			`#${item.id} [${item.status}] ${formatUtcShortTime(item.recordedAtMs)}Z | turns=${item.llmTurns} tools=${item.toolCalls}${mcpPart} | prefill=${item.prefillTokens} (${cachePct}%) | $${item.costUsd.toFixed(5)} | ${Math.round(item.wallTimeMs)}ms | ${item.label}`,
		);
	}
	return lines.join("\n");
}

/** Formats one trace entry with its full indented span forest for `/trace` or `/trace <id>`. */
export function formatTraceDetailReply(entry: PersistedTraceEntry | undefined, requestedId?: number): string {
	if (entry === undefined) {
		return requestedId !== undefined
			? `未找到编号为 #${requestedId} 的 Trace（可能已超出最近 ${MAX_PERSISTED_TRACES} 条环形缓存，可用 /trace list 查看）。`
			: "暂无可查询的 Trace 记录（完成任意一轮对话后会自动留存）。";
	}
	const cachePct = (entry.cacheHitRate * 100).toFixed(1);
	const header = [
		`[Trace #${entry.id}] status=${entry.status} | ${formatUtcShortTime(entry.recordedAtMs)}Z | ${entry.label}`,
		`turns=${entry.llmTurns}, tools=${entry.toolCalls}, mcp=${entry.mcpCalls} (err=${entry.mcpErrors}), prefill=${entry.prefillTokens}, out=${entry.outputTokens}, cache=${cachePct}%, cost=$${entry.costUsd.toFixed(6)}, wall=${Math.round(entry.wallTimeMs)}ms`,
		"---",
	].join("\n");
	const remaining = Math.max(400, MAX_TELEGRAM_TRACE_CHARS - header.length - 1);
	const tree = entry.renderedTree.length > 0 ? truncateTree(entry.renderedTree, remaining) : "(empty span tree)";
	return `${header}\n${tree}`;
}
