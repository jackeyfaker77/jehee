// Telemetry schema, trace recorder, standardized metric dictionary, and 5-bucket failure postmortem utilities for Jehee.

import {
	createTypedSpanStarter,
	defineTelemetrySchema,
	InMemoryTelemetryContext,
	type StoredSpan,
	type StoredTrace,
	type TelemetryContext,
	type TypedSpanStarter,
} from "@earendil-works/pi-telemetry";
import { renderTrace } from "@earendil-works/pi-telemetry/render";

/** Telemetry span vocabulary emitted by Jehee's MCP connector layer underneath `pi.tool` spans. */
export const JEHEE_MCP_TELEMETRY_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {
		"jehee.mcp.call": {
			description: "One outbound MCP tools/call invocation including write-gate check and blob handle translation.",
			parents: { kind: "any" },
			startAttributes: {
				server: { type: "string", required: true, description: "Configured MCP server instance name." },
				tool: { type: "string", required: true, description: "Raw MCP tool name on the target server." },
				read_only: { type: "boolean", required: true, description: "Whether the tool advertises readOnlyHint." },
			},
			endAttributes: {
				"mcp.status": {
					type: "string",
					description: "Structured status field returned by the MCP server, if any.",
				},
				is_error: { type: "boolean", description: "Whether the MCP call settled as an error." },
				"gate.action": {
					type: "string",
					values: ["allow", "block"],
					description: "Decision of `beforeWriteToolCall` for mutating calls.",
				},
				"blob.offloaded_bytes": {
					type: "number",
					description: "Total decoded binary bytes replaced with `$jehee_blob:` handles in model-facing output.",
				},
				"blob.restored_count": {
					type: "number",
					description: "Count of `$jehee_blob:` handles expanded back into raw Base64 in outbound arguments.",
				},
			},
			status: {
				default: "ok",
				errorWhen: "Transport/protocol exception or write gate rejection.",
			},
		},
		"jehee.mcp.resource_read": {
			description: "One outbound MCP resources/read invocation.",
			parents: { kind: "any" },
			startAttributes: {
				server: { type: "string", required: true, description: "Configured MCP server instance name." },
				uri: { type: "string", required: true, description: "Requested MCP resource URI.", cardinality: "high" },
			},
			endAttributes: {
				mime_type: { type: "string", description: "MIME type of the first returned resource item." },
				bytes: { type: "number", description: "Decoded byte length of the returned resource contents." },
				"blob.offloaded": {
					type: "boolean",
					description: "Whether binary bytes were offloaded behind a `$jehee_blob:` handle.",
				},
			},
			status: {
				default: "ok",
				errorWhen: "Resource read failed at protocol or authorization level.",
			},
		},
	},
});

/** Standardized quantitative metrics computed from one settled trace (or a batch of spans). */
export type JeheeTraceMetrics = {
	readonly llmTurns: number;
	readonly toolCalls: number;
	readonly toolSearchCalls: number;
	readonly mcpCalls: number;
	readonly mcpErrors: number;
	readonly boundaryViolations: number;
	/** Uncached new input tokens (`pi-ai` `usage.input`). */
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	/** Total prompt tokens (`inputTokens + cacheReadTokens + cacheWriteTokens`). */
	readonly prefillTokens: number;
	/** Overall `cacheReadTokens / prefillTokens` (0 when `prefillTokens === 0`). */
	readonly cacheHitRate: number;
	/** Cache hit rate across turns 2..N, excluding turn-1 cold prefill (`undefined` when `llmTurns < 2`). */
	readonly postWarmupCacheHitRate?: number;
	readonly costUsd: number;
	readonly ttftP50Ms?: number;
	readonly wallTimeMs: number;
};

/** Five canonical root-cause buckets required for every non-passing Eval trial postmortem. */
export type FailureRootCause =
	| "discovery_miss"
	| "arg_or_version_error"
	| "payload_overflow"
	| "boundary_violation"
	| "model_reasoning";

/** Structured postmortem diagnostic bundle exported for failed Eval runs. */
export type JeheePostmortemReport = {
	readonly caseId: string;
	readonly traceId: string;
	readonly rootCause: FailureRootCause;
	readonly summary: string;
	readonly metrics: JeheeTraceMetrics;
	readonly renderedTree: string;
	readonly stateDiff?: string;
};

/** Bound typed span starter for Jehee MCP spans. */
export function startJeheeMcpSpan(
	telemetry: TelemetryContext,
): TypedSpanStarter<readonly [typeof JEHEE_MCP_TELEMETRY_SCHEMA]> {
	return createTypedSpanStarter(telemetry, [JEHEE_MCP_TELEMETRY_SCHEMA]);
}

/** Telemetry span vocabulary emitted by Jehee's atomic memory tools underneath `pi.tool` spans. */
export const JEHEE_MEMORY_TELEMETRY_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {
		"jehee.memory.save": {
			description: "One atomic memory save/update transaction against MemoryDoc.",
			parents: { kind: "any" },
			startAttributes: {
				"memory.kind": {
					type: "string",
					required: true,
					description: "Target memory kind (core/fact/episode/active).",
				},
			},
			endAttributes: {
				"memory.id": { type: "string", description: "Assigned or updated memory ID." },
				"memory.created": { type: "boolean", description: "Whether a new memory item was created." },
				"memory.outcome": { type: "string", description: "Result status (ok / error reason)." },
			},
			status: {
				default: "ok",
				errorWhen: "Validation failure or core character limit exceeded.",
			},
		},
		"jehee.memory.search": {
			description: "One on-demand atomic memory search against MemoryDoc.",
			parents: { kind: "any" },
			startAttributes: {
				"memory.kind": { type: "string", required: false, description: "Optional kind filter." },
			},
			endAttributes: {
				"memory.hit_count": { type: "number", description: "Number of active memories returned." },
			},
			status: {
				default: "ok",
				errorWhen: "Unexpected storage read failure.",
			},
		},
		"jehee.memory.forget": {
			description: "One atomic memory soft-delete (tombstone) transaction against MemoryDoc.",
			parents: { kind: "any" },
			startAttributes: {
				"memory.id": { type: "string", required: true, description: "Target memory ID to forget." },
			},
			endAttributes: {
				"memory.outcome": { type: "string", description: "Result status (ok / already_forgotten / not_found)." },
			},
			status: {
				default: "ok",
				errorWhen: "Target memory ID not found.",
			},
		},
		"jehee.memory.consolidate": {
			description: "One background or manual incremental memory consolidation pass (extract, merge, supersede).",
			parents: { kind: "any" },
			startAttributes: {
				"memory.trigger": {
					type: "string",
					required: true,
					values: ["idle", "manual"],
					description: "What triggered this consolidation run.",
				},
			},
			endAttributes: {
				"memory.turns_scanned": {
					type: "number",
					description: "Count of incremental user dialogue turns scanned.",
				},
				"memory.added": { type: "number", description: "Count of new atomic memories added." },
				"memory.updated": { type: "number", description: "Count of existing memories updated." },
				"memory.merged": { type: "number", description: "Count of duplicate memories merged and tombstoned." },
				"memory.superseded": { type: "number", description: "Count of conflicting memories superseded." },
				"memory.forgotten": { type: "number", description: "Count of negated memories forgotten." },
				"memory.skipped": { type: "number", description: "Count of ops skipped by deterministic guardrails." },
				"memory.outcome": { type: "string", description: "Outcome status (ok / noop / error)." },
			},
			status: {
				default: "ok",
				errorWhen: "Consolidation model unavailable, returned invalid JSON, or failed.",
			},
		},
		"jehee.memory.export": {
			description: "One portable context and memory snapshot export.",
			parents: { kind: "any" },
			startAttributes: {
				"snapshot.scope": {
					type: "string",
					required: true,
					values: ["active", "full"],
					description: "Transcript scope captured in the portable snapshot.",
				},
			},
			endAttributes: {
				"snapshot.memory_count": { type: "number", description: "Count of memory records exported." },
				"snapshot.turn_count": { type: "number", description: "Count of conversation dialogue turns exported." },
			},
			status: {
				default: "ok",
				errorWhen: "Snapshot export failed to read durable state.",
			},
		},
		"jehee.memory.import": {
			description: "One atomic portable context and memory snapshot import.",
			parents: { kind: "any" },
			startAttributes: {
				"snapshot.mode": {
					type: "string",
					required: true,
					values: ["merge", "replace"],
					description: "Import mode applied to target host state.",
				},
			},
			endAttributes: {
				"snapshot.memories_imported": { type: "number", description: "Count of memory records written." },
				"snapshot.memories_skipped": { type: "number", description: "Count of memory records skipped." },
				"snapshot.turns_imported": { type: "number", description: "Count of dialogue turns replayed." },
				"snapshot.outcome": { type: "string", description: "Outcome status (ok / host_busy)." },
			},
			status: {
				default: "ok",
				errorWhen: "Import rejected because host was busy or transaction failed.",
			},
		},
	},
});

/** Bound typed span starter for Jehee atomic memory spans. */
export function startJeheeMemorySpan(
	telemetry: TelemetryContext,
): TypedSpanStarter<readonly [typeof JEHEE_MEMORY_TELEMETRY_SCHEMA]> {
	return createTypedSpanStarter(telemetry, [JEHEE_MEMORY_TELEMETRY_SCHEMA]);
}

/** Telemetry span vocabulary emitted by Jehee's Slice 5D seamless handoff and verbatim history recall layer. */
export const JEHEE_CONTEXT_TELEMETRY_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {
		"jehee.context.handoff": {
			description: "One seamless window handoff (manual reset brief or pre-compaction sweet-spot governance).",
			parents: { kind: "any" },
			startAttributes: {
				"context.kind": {
					type: "string",
					required: true,
					values: ["auto_compaction", "manual_handoff"],
					description: "Whether this handoff is automatic sweet-spot compaction or manual /handoff reset.",
				},
			},
			endAttributes: {
				"context.tokens_before": { type: "number", description: "Estimated active tokens prior to handoff." },
				"context.tokens_after": { type: "number", description: "Estimated active tokens after handoff." },
				"context.consolidated_memory": {
					type: "boolean",
					description: "Whether Slice 5C-2 memory consolidation ran before handoff.",
				},
				"context.outcome": { type: "string", description: "Result status (ok / noop / error)." },
			},
			status: {
				default: "ok",
				errorWhen: "Handoff blocked because host was busy or summary generation failed.",
			},
		},
		"jehee.context.history_search": {
			description: "One verbatim transcript lookup across immutable SQLite history past compaction/reset markers.",
			parents: { kind: "any" },
			startAttributes: {
				"history.mode": {
					type: "string",
					required: true,
					values: ["entry", "search"],
					description: "Lookup by exact entryId or keyword search.",
				},
			},
			endAttributes: {
				"history.hit_count": { type: "number", description: "Count of verbatim transcript records returned." },
			},
			status: {
				default: "ok",
				errorWhen: "Unexpected storage scan failure.",
			},
		},
	},
});

/** Bound typed span starter for Jehee context handoff and history recall spans. */
export function startJeheeContextSpan(
	telemetry: TelemetryContext,
): TypedSpanStarter<readonly [typeof JEHEE_CONTEXT_TELEMETRY_SCHEMA]> {
	return createTypedSpanStarter(telemetry, [JEHEE_CONTEXT_TELEMETRY_SCHEMA]);
}

function numAttr(span: StoredSpan, key: string): number {
	const val = span.attributes[key];
	return typeof val === "number" && Number.isFinite(val) ? val : 0;
}

function median(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Computes Jehee's canonical Metric Dictionary from a trace's settled spans. */
export function computeTraceMetrics(spans: readonly StoredSpan[]): JeheeTraceMetrics {
	const aiSpans = spans
		.filter((span) => span.name === "pi.ai.request")
		.sort((left, right) => left.startedMs - right.startedMs);
	const toolPhaseSpans = spans.filter(
		(span) => span.name === "pi.durable.phase" && span.attributes["task.name"] === "pi.tool",
	);
	const mcpCallSpans = spans.filter((span) => span.name === "jehee.mcp.call");

	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let costUsd = 0;
	let warmupPrefill = 0;
	let warmupCacheRead = 0;
	const ttfts: number[] = [];

	aiSpans.forEach((span, index) => {
		const inp = numAttr(span, "usage.input");
		const out = numAttr(span, "usage.output");
		const cr = numAttr(span, "usage.cache_read");
		const cw = numAttr(span, "usage.cache_write");
		inputTokens += inp;
		outputTokens += out;
		cacheReadTokens += cr;
		cacheWriteTokens += cw;
		costUsd += numAttr(span, "cost.total");
		if (index >= 1) {
			warmupPrefill += inp + cr + cw;
			warmupCacheRead += cr;
		}
		const firstChunk = span.events.find((ev) => ev.name === "pi.ai.first_chunk");
		if (firstChunk !== undefined) {
			ttfts.push(firstChunk.timeMs);
		}
	});

	const prefillTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
	const cacheHitRate = prefillTokens > 0 ? cacheReadTokens / prefillTokens : 0;
	const postWarmupCacheHitRate =
		aiSpans.length >= 2 ? (warmupPrefill > 0 ? warmupCacheRead / warmupPrefill : 0) : undefined;
	const ttftP50Ms = median(ttfts);

	let minStart = Infinity;
	let maxEnd = -Infinity;
	for (const span of spans) {
		if (span.startedMs < minStart) minStart = span.startedMs;
		if (span.endedMs > maxEnd) maxEnd = span.endedMs;
	}
	const wallTimeMs = spans.length > 0 && maxEnd >= minStart ? Math.round((maxEnd - minStart) * 1000) / 1000 : 0;

	return {
		llmTurns: aiSpans.length,
		toolCalls: toolPhaseSpans.length,
		toolSearchCalls: toolPhaseSpans.filter((span) => span.attributes["tool.name"] === "tool_search").length,
		mcpCalls: mcpCallSpans.length,
		mcpErrors: mcpCallSpans.filter((span) => span.attributes.is_error === true).length,
		boundaryViolations: mcpCallSpans.filter(
			(span) =>
				span.attributes["gate.action"] === "block" ||
				span.attributes["mcp.status"] === "not_authorized" ||
				span.attributes["mcp.status"] === "permission_denied",
		).length,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		prefillTokens,
		cacheHitRate,
		...(postWarmupCacheHitRate !== undefined ? { postWarmupCacheHitRate } : {}),
		costUsd,
		...(ttftP50Ms !== undefined ? { ttftP50Ms } : {}),
		wallTimeMs,
	};
}

/** Classifies a failed trial into one of Jehee's 5 canonical root-cause buckets using its recorded span tree. */
export function classifyFailureRootCause(input: {
	readonly spans: readonly StoredSpan[];
	readonly expectedServers?: readonly string[];
	readonly payloadOverflowDetected?: boolean;
}): FailureRootCause {
	const mcpCalls = input.spans.filter((span) => span.name === "jehee.mcp.call");
	const resourceReads = input.spans.filter((span) => span.name === "jehee.mcp.resource_read");

	const hasBoundaryViolation = mcpCalls.some(
		(span) =>
			span.attributes["gate.action"] === "block" ||
			span.attributes["mcp.status"] === "not_authorized" ||
			span.attributes["mcp.status"] === "permission_denied",
	);
	if (hasBoundaryViolation) return "boundary_violation";

	if (input.payloadOverflowDetected === true) return "payload_overflow";

	if (input.expectedServers !== undefined && input.expectedServers.length > 0) {
		const touchedServers = new Set<string>();
		for (const span of [...mcpCalls, ...resourceReads]) {
			const server = span.attributes.server;
			if (typeof server === "string") touchedServers.add(server);
		}
		if (input.expectedServers.some((expected) => !touchedServers.has(expected))) {
			return "discovery_miss";
		}
	}

	const unresolvedByTool = new Map<string, boolean>();
	const chronologicalMcp = [...mcpCalls].sort((a, b) => a.startedMs - b.startedMs);
	for (const span of chronologicalMcp) {
		const key = `${String(span.attributes.server)}:${String(span.attributes.tool)}`;
		unresolvedByTool.set(key, span.attributes.is_error === true);
	}
	if ([...unresolvedByTool.values()].some((failed) => failed)) {
		return "arg_or_version_error";
	}

	return "model_reasoning";
}

/** Builds a human- and machine-readable postmortem bundle from a settled trace. */
export function buildPostmortemReport(input: {
	readonly caseId: string;
	readonly trace: StoredTrace;
	readonly summary: string;
	readonly expectedServers?: readonly string[];
	readonly payloadOverflowDetected?: boolean;
	readonly stateDiff?: string;
}): JeheePostmortemReport {
	const metrics = computeTraceMetrics(input.trace.spans);
	const rootCause = classifyFailureRootCause({
		spans: input.trace.spans,
		...(input.expectedServers !== undefined ? { expectedServers: input.expectedServers } : {}),
		...(input.payloadOverflowDetected !== undefined
			? { payloadOverflowDetected: input.payloadOverflowDetected }
			: {}),
	});
	return {
		caseId: input.caseId,
		traceId: input.trace.traceId,
		rootCause,
		summary: input.summary,
		metrics,
		renderedTree: renderTrace(input.trace.spans),
		...(input.stateDiff !== undefined ? { stateDiff: input.stateDiff } : {}),
	};
}

/** Portable trace recorder wrapping `InMemoryTelemetryContext` for BDD assertions, CLI inspection, and Eval runs. */
export class JeheeTraceRecorder {
	readonly #context = new InMemoryTelemetryContext();

	/** Underlying `TelemetryContext` to pass into `JeheeHost.open({ telemetry })`. */
	get telemetry(): TelemetryContext {
		return this.#context;
	}

	/** Returns all settled traces recorded so far in chronological order. */
	async listTraces(limit: number = 100): Promise<readonly StoredTrace[]> {
		const page = await this.#context.findTraces({ limit });
		return page.traces;
	}

	/** Returns the most recently started trace, if any. */
	async latestTrace(): Promise<StoredTrace | undefined> {
		const traces = await this.listTraces(100);
		return traces.at(-1);
	}

	/** Renders the latest trace's parent-child span forest as indented text. */
	async renderLatestTrace(): Promise<string> {
		const latest = await this.latestTrace();
		return latest === undefined ? "" : renderTrace(latest.spans);
	}

	/** Serializes all recorded traces as JSON Lines for `.artifacts/` persistence. */
	async toJsonLines(): Promise<string> {
		const traces = await this.listTraces(1_000);
		return traces.map((trace) => JSON.stringify(trace)).join("\n");
	}
}
