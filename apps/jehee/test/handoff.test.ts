// Unit and durable integration tests for Slice 5D (ADR-0013):
// token estimation, sweet-spot automatic compaction with pre-compaction memory consolidation,
// manual `/handoff` ResetEntry brief, cross-handoff `history_search` verbatim recall,
// portable snapshot compatibility, SQLite restart durability, and env config validation.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChannelGateway } from "../src/channels/gateway.ts";
import { HISTORY_SEARCH_TOOL } from "../src/context/extension.ts";
import {
	estimateActiveContextTokens,
	estimateMessageTokens,
	formatHandoffReply,
	type HistoryRecord,
	lookupHistoryRecords,
	resolveHandoffPolicy,
	shouldTriggerSweetSpotCompaction,
} from "../src/context/handoff.ts";
import { JeheeHost } from "../src/core/host.ts";
import { AtomicMemoryProvider } from "../src/memory/atomic-memory.ts";
import { parseJeheeEnvConfig } from "../src/runtime/config.ts";
import { openNodeJeheeHost } from "../src/runtime/node.ts";
import { JeheeTraceRecorder } from "../src/telemetry/recorder.ts";

describe("seamless handoff pure engine and config parsing", () => {
	it("estimates tokens from assistant usage anchor plus subsequent message estimates and evaluates sweet-spot trigger", () => {
		const userMsg: Message = { role: "user", content: "测试一段包含中英文的长消息 payload", timestamp: 1_000 };
		assert.ok(estimateMessageTokens(userMsg) >= 7);

		const asstWithUsage = {
			...fauxAssistantMessage("收到。"),
			usage: {
				input: 30_000,
				output: 500,
				cacheRead: 18_000,
				cacheWrite: 0,
				totalTokens: 48_500,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const total = estimateActiveContextTokens([userMsg, asstWithUsage, userMsg]);
		assert.ok(total > 48_500);

		const policy = resolveHandoffPolicy({ sweetSpotTokens: 48_000, keepRecentTokens: 12_000 });
		assert.equal(
			shouldTriggerSweetSpotCompaction({
				activeTokens: total,
				activeDialogueTurns: 4,
				policy,
				hasRunningCompaction: false,
			}),
			true,
		);
		assert.equal(
			shouldTriggerSweetSpotCompaction({
				activeTokens: total,
				activeDialogueTurns: 4,
				policy,
				hasRunningCompaction: true,
			}),
			false,
		);
		assert.equal(
			shouldTriggerSweetSpotCompaction({
				activeTokens: total,
				activeDialogueTurns: 4,
				policy: resolveHandoffPolicy({ sweetSpotTokens: 0 }),
				hasRunningCompaction: false,
			}),
			false,
		);
	});

	it("looks up verbatim history records by exact entryId with context window and by CJK/Latin keyword search", () => {
		const records: HistoryRecord[] = [
			{ entryId: "1", role: "user", text: "记住：项目代号凤凰，预算 50 万。" },
			{ entryId: "2", role: "assistant", text: "已记录项目凤凰预算。" },
			{ entryId: "3", role: "summary", text: "[Seamless Window Handoff Brief] 凤凰项目摘要" },
			{ entryId: "4", role: "user", text: "今天天气不错，聊聊午饭。" },
			{ entryId: "5", role: "assistant", text: "好的，推荐牛肉面。" },
		];

		const byId = lookupHistoryRecords(records, { entryId: "1", contextWindow: 1 });
		assert.equal(byId.mode, "entry");
		if (byId.mode === "entry") {
			assert.equal(byId.found, true);
			assert.deepEqual(
				byId.records.map((r) => r.entryId),
				["1", "2"],
			);
		}

		const byQuery = lookupHistoryRecords(records, { query: "凤凰 50 万" });
		assert.equal(byQuery.mode, "search");
		if (byQuery.mode === "search") {
			// Summary records are excluded from verbatim search; entry 1 ranks highest.
			assert.equal(byQuery.hits.length, 2);
			assert.equal(byQuery.hits[0]!.record.entryId, "1");
		}
	});

	it("validates JEHEE_HANDOFF_* environment variables and formats handoff replies", () => {
		const cfg = parseJeheeEnvConfig({
			JEHEE_HANDOFF_SWEET_SPOT_TOKENS: "32000",
			JEHEE_HANDOFF_KEEP_RECENT_TOKENS: "8000",
			JEHEE_HANDOFF_CONSOLIDATE: "false",
			JEHEE_HANDOFF_MODEL: "opencode-go/deepseek-v4.1-flash",
		});
		assert.equal(cfg.handoff.sweetSpotTokens, 32_000);
		assert.equal(cfg.handoff.keepRecentTokens, 8_000);
		assert.equal(cfg.handoff.consolidateBeforeHandoff, false);
		assert.deepEqual(cfg.handoff.model, { provider: "opencode-go", modelId: "deepseek-v4.1-flash" });

		assert.throws(
			() => parseJeheeEnvConfig({ JEHEE_HANDOFF_SWEET_SPOT_TOKENS: "-10" }),
			/Invalid JEHEE_HANDOFF_SWEET_SPOT_TOKENS/,
		);
		assert.throws(
			() => parseJeheeEnvConfig({ JEHEE_HANDOFF_CONSOLIDATE: "maybe" }),
			/Invalid JEHEE_HANDOFF_CONSOLIDATE/,
		);

		assert.ok(formatHandoffReply({ status: "noop", reason: "empty_context", tokensBefore: 0 }).includes("无需换窗"));
	});
});

describe("seamless handoff durable SQLite integration", () => {
	it("auto-compacts at sweet-spot threshold after flushing memory consolidation, persists HandoffDoc across SQLite restart, and preserves full history", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "jehee-handoff-auto-"));
		const sqlitePath = join(tempDir, "jehee.sqlite");
		const recorder = new JeheeTraceRecorder();
		let openHost: JeheeHost | undefined;

		try {
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);

			// Route responses by system prompt so foreground chat, pre-compaction consolidation, and compaction summary
			// each receive deterministic payloads without brittle call-order coupling.
			const router = (ctx: TranscriptContext) => {
				const sys = ctx.messages
					.filter((m) => m.role === "system")
					.map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text).join("")))
					.join("\n");
				if (sys.includes("background memory consolidation engine")) {
					return fauxAssistantMessage(
						JSON.stringify({
							summary: "压缩前自动沉淀凤凰项目预算事实",
							ops: [
								{
									op: "add",
									kind: "fact",
									content: "项目代号凤凰，预算 50 万元，负责人林工",
									keywords: ["凤凰", "预算", "林工"],
									aliases: ["Phoenix"],
									sourceEntryId: "1",
								},
							],
						}),
					);
				}
				if (sys.includes("context summarization assistant") || sys.includes("seamless window handoff summarizer")) {
					return fauxAssistantMessage("## Goal\n推进凤凰项目\n\n## Key Decisions\n- 预算 50 万，负责人林工");
				}
				return fauxAssistantMessage("收到，我已了解当前进展并继续跟进。".repeat(8));
			};
			faux.setResponses(Array.from({ length: 12 }, () => router));

			const host1 = await openNodeJeheeHost(
				{
					sqlitePath,
					models,
					defaultModel: { provider: "faux", modelId: faux.getModel().id },
					memory: new AtomicMemoryProvider(),
					handoff: {
						sweetSpotTokens: 160,
						keepRecentTokens: 50,
						consolidateBeforeHandoff: true,
					},
					telemetry: recorder.telemetry,
				},
				BACKGROUND_CONTEXT,
			);
			openHost = host1;

			await host1.sendMessage(
				{ text: `项目代号凤凰，预算 50 万元，负责人林工。补充背景：${"详细需求描述 ".repeat(25)}` },
				BACKGROUND_CONTEXT,
			);
			await host1.sendMessage(
				{ text: `第二轮讨论：确认 API 网关拆分方案与灰度计划。${"细节补充 ".repeat(25)}` },
				BACKGROUND_CONTEXT,
			);
			await host1.waitForCompaction(BACKGROUND_CONTEXT);

			const status1 = await host1.getContextStatus(BACKGROUND_CONTEXT);
			assert.ok(status1.totalCompactions >= 1, `Expected auto-compaction >= 1, got ${status1.totalCompactions}`);

			// Pre-compaction memory consolidation saved Phoenix fact before old turns left active window.
			const memHits = await host1.searchMemory({ query: "Phoenix" }, BACKGROUND_CONTEXT);
			assert.equal(memHits.kind, "atomic");
			if (memHits.kind === "atomic") {
				assert.equal(memHits.hits.length, 1);
				assert.ok(memHits.hits[0]!.item.content.includes("50 万"));
			}

			// Portable snapshot compatibility: `active` contains summary, `full` retains verbatim turn 1.
			const activeSnap = await host1.exportPortableSnapshot(BACKGROUND_CONTEXT, { transcriptScope: "active" });
			const fullSnap = await host1.exportPortableSnapshot(BACKGROUND_CONTEXT, { transcriptScope: "full" });
			assert.ok(activeSnap.context.turns.some((t) => t.role === "summary"));
			assert.ok(fullSnap.context.turns.some((t) => t.role === "user" && t.text.includes("项目代号凤凰")));

			await host1.close(BACKGROUND_CONTEXT);
			openHost = undefined;

			// Reopen SQLite and verify HandoffDoc + verbatim lookupHistory persist cleanly.
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

			const persistedHandoff = await host2.getHandoffState(BACKGROUND_CONTEXT);
			assert.ok(persistedHandoff.totalCompactions >= 1);

			const verbatim = await host2.lookupHistory({ query: "50 万元" }, BACKGROUND_CONTEXT);
			assert.equal(verbatim.mode, "search");
			if (verbatim.mode === "search") {
				assert.ok(verbatim.hits.some((h) => h.record.text.includes("项目代号凤凰")));
			}

			await host2.close(BACKGROUND_CONTEXT);
			openHost = undefined;
		} finally {
			if (openHost !== undefined) {
				await openHost.close(BACKGROUND_CONTEXT);
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("handles manual /handoff, updates /status, enforces allowlist, and lets model recall pre-handoff quotes via history_search tool", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const recorder = new JeheeTraceRecorder();

		let historyToolOutput = "";
		let turnIndex = 0;

		const router = (ctx: TranscriptContext) => {
			const sys = ctx.messages
				.filter((m) => m.role === "system")
				.map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text).join("")))
				.join("\n");
			if (sys.includes("background memory consolidation engine")) {
				return fauxAssistantMessage(
					JSON.stringify({
						summary: "换窗前沉淀合同编号",
						ops: [
							{
								op: "add",
								kind: "fact",
								content: "合同编号 CT-2026-889 需要在周五前盖章",
								keywords: ["合同", "CT-2026-889"],
								sourceEntryId: "1",
							},
						],
					}),
				);
			}
			if (sys.includes("seamless window handoff summarizer")) {
				return fauxAssistantMessage("## Goal\n完成合同 CT-2026-889 盖章\n\n## Open Items\n- 周五前确认法务意见");
			}
			const lastTool = ctx.messages.findLast((m) => m.role === "toolResult");
			if (lastTool?.role === "toolResult") {
				historyToolOutput = lastTool.content.map((b) => (b.type === "text" ? b.text : "")).join("");
				return fauxAssistantMessage("原话记录是：合同编号 CT-2026-889，法务审核人陈律师。");
			}
			turnIndex += 1;
			if (turnIndex === 1) {
				return fauxAssistantMessage(`收到，已记录合同详情。${"补充确认 ".repeat(40)}`);
			}
			return fauxAssistantMessage([fauxToolCall(HISTORY_SEARCH_TOOL, { query: "陈律师" })], {
				stopReason: "toolUse",
			});
		};
		faux.setResponses(Array.from({ length: 12 }, () => router));

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				memory: new AtomicMemoryProvider(),
				handoff: { sweetSpotTokens: 48_000, consolidateBeforeHandoff: true },
				telemetry: recorder.telemetry,
			},
			BACKGROUND_CONTEXT,
		);

		const sent: string[] = [];
		const gateway = new ChannelGateway({
			host,
			allowFrom: { telegram: ["owner-1"] },
		});
		gateway.registerTransport({
			channel: "telegram",
			sendText: async (_chatId, text) => {
				sent.push(text);
			},
		});

		try {
			await host.sendMessage(
				{ text: `合同编号 CT-2026-889，法务审核人陈律师，周五前盖章。${"背景条款 ".repeat(40)}` },
				BACKGROUND_CONTEXT,
			);
			const before = await host.getContextStatus(BACKGROUND_CONTEXT);

			// Stranger rejected
			const unauth = await gateway.ingest(
				{
					channel: "telegram",
					chatId: "c1",
					senderId: "stranger",
					messageId: "m0",
					text: "/handoff",
					timestampMs: 1_000,
				},
				BACKGROUND_CONTEXT,
			);
			assert.equal(unauth.kind, "unauthorized");

			// Owner executes /handoff with focus
			const res = await gateway.ingest(
				{
					channel: "telegram",
					chatId: "c1",
					senderId: "owner-1",
					messageId: "m1",
					text: "/handoff 聚焦合同盖章",
					timestampMs: 2_000,
				},
				BACKGROUND_CONTEXT,
			);
			assert.deepEqual(res, { kind: "command_handled", command: "handoff" });
			assert.ok(sent.at(-1)?.includes("[Seamless Handoff]"));

			const after = await host.getContextStatus(BACKGROUND_CONTEXT);
			assert.equal(after.totalManualHandoffs, 1);
			assert.ok(
				after.activeTokens < before.activeTokens,
				`Expected token drop: ${before.activeTokens} -> ${after.activeTokens}`,
			);

			// /status surfaces context budget and handoff count
			await gateway.ingest(
				{
					channel: "telegram",
					chatId: "c1",
					senderId: "owner-1",
					messageId: "m2",
					text: "/status",
					timestampMs: 3_000,
				},
				BACKGROUND_CONTEXT,
			);
			assert.ok(sent.at(-1)?.includes("context:"));
			assert.ok(sent.at(-1)?.includes("handoffs=1"));

			// After handoff, model invokes `history_search` tool to retrieve exact pre-handoff verbatim quote.
			const recallReply = await host.sendMessage({ text: "之前提到的法务审核人原话是谁？" }, BACKGROUND_CONTEXT);
			assert.equal(recallReply.status, "done");
			assert.ok(historyToolOutput.includes("陈律师"), `Expected verbatim hit in: ${historyToolOutput}`);

			// Verify telemetry spans emitted for both handoff and history_search.
			const traces = await recorder.listTraces(100);
			const spans = traces.flatMap((t) => t.spans);
			assert.ok(spans.some((s) => s.name === "jehee.context.handoff"));
			assert.ok(spans.some((s) => s.name === "jehee.context.history_search"));
		} finally {
			gateway.dispose();
			await host.close(BACKGROUND_CONTEXT);
		}
	});
});
