// Unit and durable integration tests for Slice 5C-2 background memory consolidation:
// JSON patch parsing, deterministic guardrails (dedup, merge/supersede tombstones, maxCoreChars),
// high-water mark idempotency, bad-JSON watermark preservation, idle background timer, and config parsing.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { JeheeHost } from "../src/core/host.ts";
import { AtomicMemoryProvider, createEmptyMemoryStoreState } from "../src/memory/atomic-memory.ts";
import {
	applyConsolidationPlan,
	formatConsolidationReportReply,
	MAX_CONSOLIDATION_OPS,
	parseConsolidationPlan,
} from "../src/memory/consolidator.ts";
import { parseJeheeEnvConfig } from "../src/runtime/config.ts";
import { openNodeJeheeHost } from "../src/runtime/node.ts";
import { JeheeTraceRecorder } from "../src/telemetry/recorder.ts";

describe("memory consolidation pure parser and deterministic applier", () => {
	it("parses raw and fenced JSON plans and rejects malformed or oversized payloads", () => {
		const fenced = parseConsolidationPlan(
			'```json\n{"summary":"Extracted 1 fact","ops":[{"op":"add","kind":"fact","content":"下周三去北京","aliases":["北京出差"]}]}\n```',
		);
		assert.equal(fenced.ok, true);
		if (fenced.ok) {
			assert.equal(fenced.plan.summary, "Extracted 1 fact");
			assert.equal(fenced.plan.ops.length, 1);
		}

		assert.equal(parseConsolidationPlan("not json at all").ok, false);
		assert.equal(parseConsolidationPlan('{"summary":"missing ops"}').ok, false);
		assert.equal(parseConsolidationPlan('{"ops":[{"op":"drop_all"}]}').ok, false);

		const tooManyOps = Array.from({ length: MAX_CONSOLIDATION_OPS + 1 }, (_, idx) => ({
			op: "add",
			kind: "fact",
			content: `fact-${idx}`,
		}));
		assert.equal(parseConsolidationPlan(JSON.stringify({ ops: tooManyOps })).ok, false);
	});

	it("applies add, dedup, merge, supersede (including core ceiling), and forget with reversible tombstones", () => {
		const provider = new AtomicMemoryProvider({ maxCoreChars: 80 });
		const state = createEmptyMemoryStoreState();

		provider.atomic.save(state, { kind: "core", content: "包管理器使用 npm", keywords: ["npm"] }, 1_000);
		provider.atomic.save(
			state,
			{ kind: "fact", content: "王明负责订单服务", keywords: ["订单"], aliases: ["老王"] },
			2_000,
		);
		provider.atomic.save(
			state,
			{ kind: "fact", content: "王明是订单服务负责人", keywords: ["负责人"], aliases: ["Wang"] },
			3_000,
		);
		provider.atomic.save(state, { kind: "fact", content: "旧住址在上海浦东", keywords: ["住址"] }, 4_000);

		const plan = parseConsolidationPlan(
			JSON.stringify({
				summary: "Merged duplicate owner facts, superseded package manager and address, skipped duplicate add",
				ops: [
					// Exact duplicate of existing active item -> skipped deterministically
					{ op: "add", kind: "fact", content: "  王明负责订单服务  " },
					// Merge mem_0003 into mem_0002 -> union keywords & aliases, tombstone mem_0003
					{
						op: "merge",
						keepId: "mem_0002",
						dropIds: ["mem_0003"],
						content: "王明负责订单服务",
						keywords: ["owner"],
					},
					// Supersede core mem_0001 with new core (tests net maxCoreChars check)
					{
						op: "supersede",
						oldId: "mem_0001",
						reason: "User switched to pnpm",
						replacement: { kind: "core", content: "包管理器统一使用 pnpm", keywords: ["pnpm"] },
					},
					// Supersede fact mem_0004 with new address
					{
						op: "supersede",
						oldId: "mem_0004",
						reason: "Moved to Shenzhen",
						replacement: { kind: "fact", content: "现住址在深圳南山", keywords: ["住址", "深圳"] },
					},
					// Oversized core add -> skipped without aborting previous ops
					{ op: "add", kind: "core", content: "x".repeat(200) },
				],
			}),
		);
		assert.equal(plan.ok, true);
		if (!plan.ok) return;

		const outcome = applyConsolidationPlan(state, plan.plan, provider.atomic, 5_000);
		assert.equal(outcome.added, 0);
		assert.equal(outcome.merged, 1);
		assert.equal(outcome.superseded, 2);
		assert.equal(outcome.skipped, 2);

		// mem_0003 tombstoned with merged_into:mem_0002, and mem_0002 inherited alias "Wang"
		assert.equal(state.items.mem_0003?.status, "forgotten");
		assert.equal(state.items.mem_0003?.forgetReason, "merged_into:mem_0002");
		assert.ok(state.items.mem_0002?.aliases.includes("Wang"));
		assert.ok(state.items.mem_0002?.aliases.includes("老王"));

		// Core now has pnpm, not npm; old core & old address are reversible tombstones
		const coreRendered = provider.atomic.renderCoreFromState(state);
		assert.ok(coreRendered?.includes("使用 pnpm"));
		assert.ok(!coreRendered?.includes("使用 npm"));
		assert.equal(state.items.mem_0001?.status, "forgotten");
		assert.ok(state.items.mem_0001?.forgetReason?.startsWith("superseded_by:mem_0005"));
		assert.equal(state.items.mem_0004?.status, "forgotten");
		assert.ok(state.items.mem_0004?.forgetReason?.startsWith("superseded_by:mem_0006"));

		// Restore old address tombstoned by supersede works cleanly
		const restored = provider.atomic.restore(state, "mem_0004", 6_000);
		assert.equal(restored.ok, true);
		assert.equal(provider.atomic.search(state, { query: "浦东" }).length, 1);
	});

	it("parses JEHEE_MEMORY_CONSOLIDATION_* config and formats consolidation reports", () => {
		const cfg = parseJeheeEnvConfig({
			JEHEE_MEMORY_PROVIDER: "atomic",
			JEHEE_MEMORY_CONSOLIDATION_IDLE_MS: "900000",
			JEHEE_MEMORY_CONSOLIDATION_MIN_TURNS: "3",
			JEHEE_MEMORY_CONSOLIDATION_MODEL: "opencode-go/deepseek-v4.1-flash",
		});
		assert.equal(cfg.memoryConsolidation.idleDelayMs, 900_000);
		assert.equal(cfg.memoryConsolidation.minNewTurns, 3);
		assert.deepEqual(cfg.memoryConsolidation.model, {
			provider: "opencode-go",
			modelId: "deepseek-v4.1-flash",
		});

		assert.throws(
			() => parseJeheeEnvConfig({ JEHEE_MEMORY_CONSOLIDATION_IDLE_MS: "-1" }),
			/Invalid JEHEE_MEMORY_CONSOLIDATION_IDLE_MS/,
		);
		assert.throws(
			() => parseJeheeEnvConfig({ JEHEE_MEMORY_CONSOLIDATION_MIN_TURNS: "0" }),
			/Invalid JEHEE_MEMORY_CONSOLIDATION_MIN_TURNS/,
		);

		assert.ok(
			formatConsolidationReportReply({
				status: "noop",
				trigger: "manual",
				reason: "no_new_activity",
				turnsScanned: 0,
			}).includes("无需整理"),
		);
	});
});

describe("memory consolidation durable host integration", () => {
	it("preserves watermark on invalid JSON, advances watermark on success, skips repeat runs, and persists across SQLite restart", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "jehee-consol-test-"));
		const sqlitePath = join(tempDir, "jehee.sqlite");
		const recorder = new JeheeTraceRecorder();
		let openHost: JeheeHost | undefined;

		try {
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);

			let llmCallCount = 0;
			faux.setResponses([
				// Foreground turn 1 (user shares implicit fact without calling memory_save)
				() => {
					llmCallCount += 1;
					return fauxAssistantMessage("好的，祝北京出差顺利！");
				},
				// Consolidation attempt 1: bad JSON -> must NOT advance watermark
				() => {
					llmCallCount += 1;
					return fauxAssistantMessage("oops not valid json");
				},
				// Consolidation attempt 2: valid JSON extracting implicit fact
				() => {
					llmCallCount += 1;
					return fauxAssistantMessage(
						JSON.stringify({
							summary: "提取下周三北京出差行程",
							ops: [
								{
									op: "add",
									kind: "episode",
									content: "下周三飞北京见王总",
									keywords: ["北京", "出差"],
									aliases: ["老王", "王总"],
									validFrom: "2026-12-02",
									sourceEntryId: "1",
								},
							],
						}),
					);
				},
			]);

			const host1 = await openNodeJeheeHost(
				{
					sqlitePath,
					models,
					defaultModel: { provider: "faux", modelId: faux.getModel().id },
					memory: new AtomicMemoryProvider(),
					telemetry: recorder.telemetry,
				},
				BACKGROUND_CONTEXT,
			);
			openHost = host1;

			await host1.sendMessage({ text: "我下周三飞北京见王总，顺便聊下 Q1 合作" }, BACKGROUND_CONTEXT);

			// Attempt 1 fails with bad JSON; watermark stays unset.
			const badReport = await host1.consolidateMemory(BACKGROUND_CONTEXT);
			assert.equal(badReport.status, "error");
			const stateAfterErr = await host1.getMemoryConsolidationState(BACKGROUND_CONTEXT);
			assert.equal(stateAfterErr.lastConsolidatedEntryId, undefined);
			assert.equal(stateAfterErr.lastRunStatus, "error");

			// Attempt 2 succeeds on the same un-scanned turn and advances watermark.
			const okReport = await host1.consolidateMemory(BACKGROUND_CONTEXT);
			assert.equal(okReport.status, "ok");
			if (okReport.status === "ok") {
				assert.equal(okReport.added, 1);
				assert.equal(okReport.turnsScanned, 1);
			}
			assert.equal(llmCallCount, 3);

			// Attempt 3 immediately after -> deterministic noop with ZERO extra LLM call.
			const noopReport = await host1.consolidateMemory(BACKGROUND_CONTEXT);
			assert.equal(noopReport.status, "noop");
			assert.equal(llmCallCount, 3);

			// Telemetry spans recorded for consolidate runs.
			const traces = await recorder.listTraces(100);
			const consolSpans = traces.flatMap((t) => t.spans).filter((s) => s.name === "jehee.memory.consolidate");
			assert.equal(consolSpans.length, 3);

			await host1.close(BACKGROUND_CONTEXT);
			openHost = undefined;

			// Reopen SQLite and verify both extracted memory and watermark survived restart.
			const faux2 = fauxProvider();
			const models2 = createModels();
			models2.setProvider(faux2.provider);
			const host2 = await openNodeJeheeHost(
				{
					sqlitePath,
					models: models2,
					defaultModel: { provider: "faux", modelId: faux2.getModel().id },
					memory: new AtomicMemoryProvider(),
				},
				BACKGROUND_CONTEXT,
			);
			openHost = host2;

			const search = await host2.searchMemory({ query: "王总" }, BACKGROUND_CONTEXT);
			assert.equal(search.kind, "atomic");
			if (search.kind === "atomic") {
				assert.equal(search.hits.length, 1);
				assert.ok(search.hits[0]!.item.content.includes("北京"));
			}
			const persistedState = await host2.getMemoryConsolidationState(BACKGROUND_CONTEXT);
			assert.equal(persistedState.totalRuns, 1);
			assert.equal(persistedState.totalAdded, 1);
			assert.ok(persistedState.lastConsolidatedEntryId !== undefined);

			// Still noop after restart with no new turns.
			const postRestartNoop = await host2.consolidateMemory(BACKGROUND_CONTEXT);
			assert.equal(postRestartNoop.status, "noop");

			await host2.close(BACKGROUND_CONTEXT);
			openHost = undefined;
		} finally {
			if (openHost !== undefined) {
				await openHost.close(BACKGROUND_CONTEXT);
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("automatically triggers single-flight background idle consolidation after idleDelayMs once minNewTurns is met", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		let consolidationCalls = 0;
		faux.setResponses([
			// Turn 1 reply
			fauxAssistantMessage("收到，周报格式我记下了。"),
			// Turn 2 reply
			fauxAssistantMessage("好的，明天见。"),
			// Idle background consolidation call after turn 2 + idleDelayMs
			() => {
				consolidationCalls += 1;
				return fauxAssistantMessage(
					JSON.stringify({
						summary: "提炼周报偏好",
						ops: [
							{
								op: "add",
								kind: "core",
								content: "周报统一使用精简 bullet list 格式",
								keywords: ["周报", "格式"],
							},
						],
					}),
				);
			},
		]);

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				memory: new AtomicMemoryProvider({
					consolidation: { idleDelayMs: 60, minNewTurns: 2 },
				}),
			},
			BACKGROUND_CONTEXT,
		);

		try {
			await host.sendMessage({ text: "以后周报都用精简 bullet list 发我" }, BACKGROUND_CONTEXT);
			// Wait for the first idle timer to fire; minNewTurns=2 so it must noop (0 consolidation LLM calls).
			await host.waitForMemoryConsolidation(BACKGROUND_CONTEXT);
			assert.equal(consolidationCalls, 0);

			// Second turn satisfies minNewTurns=2 -> idle timer fires and extracts the preference automatically.
			await host.sendMessage({ text: "好的明天见" }, BACKGROUND_CONTEXT);
			await host.waitForMemoryConsolidation(BACKGROUND_CONTEXT);
			assert.equal(consolidationCalls, 1);

			const inspected = await host.inspectMemory(BACKGROUND_CONTEXT);
			assert.equal(inspected.kind, "atomic");
			if (inspected.kind === "atomic") {
				assert.ok(inspected.snapshot.coreItems.some((item) => item.content.includes("bullet list")));
				assert.equal(inspected.consolidation.totalRuns, 1);
				assert.equal(inspected.consolidation.totalAdded, 1);
			}
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}
	});
});
