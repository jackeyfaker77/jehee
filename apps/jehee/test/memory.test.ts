// Unit and integration tests for Jehee's atomic memory engine, durable SQLite persistence,
// `/memory` slash commands, telemetry spans, and hot-swap tool unloading.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChannelGateway } from "../src/channels/gateway.ts";
import { JeheeHost } from "../src/core/host.ts";
import {
	AtomicMemoryProvider,
	createEmptyMemoryStoreState,
	forgetAtomicMemory,
	formatMemoryInspectReply,
	formatMemorySearchReply,
	inspectAtomicMemory,
	parseMemoryProviderEnv,
	renderCoreFromMemoryState,
	restoreAtomicMemory,
	saveAtomicMemory,
	searchAtomicMemory,
} from "../src/memory/atomic-memory.ts";
import { MEMORY_FORGET_TOOL, MEMORY_SAVE_TOOL, MEMORY_SEARCH_TOOL } from "../src/memory/bridge.ts";
import { StaticCoreMemoryProvider } from "../src/memory/static-core.ts";
import { parseJeheeEnvConfig } from "../src/runtime/config.ts";
import { openNodeJeheeHost } from "../src/runtime/node.ts";
import { JeheeTraceRecorder } from "../src/telemetry/recorder.ts";

function effectiveCoreSection(ctx: TranscriptContext): string | null | undefined {
	let current: string | null | undefined;
	for (const msg of ctx.messages) {
		if (msg.role !== "system" || msg.sections === undefined) continue;
		if (Object.hasOwn(msg.sections, "jehee_core_memory")) {
			current = msg.sections.jehee_core_memory;
		}
	}
	return current;
}

function activeToolNames(ctx: TranscriptContext): Set<string> {
	const active = new Set<string>();
	for (const msg of ctx.messages) {
		if (msg.role !== "system") continue;
		for (const tool of msg.toolsAdded ?? []) {
			active.add(tool.name);
		}
		for (const tool of msg.toolsRemoved ?? []) {
			active.delete(tool.name);
		}
	}
	return active;
}

describe("atomic memory pure domain engine", () => {
	it("saves, updates, renders L1 Core, and enforces maxCoreChars ceiling", () => {
		const state = createEmptyMemoryStoreState();
		const r1 = saveAtomicMemory(state, { kind: "core", content: "代码一律使用 TypeScript 和 pnpm" }, 1_000, {
			maxCoreChars: 80,
			seedCorePrompt: "Seed",
		});
		assert.equal(r1.ok, true);
		if (!r1.ok) return;
		assert.equal(r1.created, true);
		assert.equal(r1.item.id, "mem_0001");

		const rendered = renderCoreFromMemoryState(state, "Seed");
		assert.ok(rendered?.includes("Seed"));
		assert.ok(rendered?.includes("- [mem_0001] 代码一律使用 TypeScript 和 pnpm"));

		// Exceeding maxCoreChars must fail without mutating state.
		const tooBig = saveAtomicMemory(state, { kind: "core", content: "x".repeat(100) }, 2_000, {
			maxCoreChars: 80,
			seedCorePrompt: "Seed",
		});
		assert.equal(tooBig.ok, false);
		if (!tooBig.ok) {
			assert.equal(tooBig.reason, "core_limit_exceeded");
		}
		assert.equal(state.seq, 1);

		// Updating in place preserves createdAtMs and ID.
		const updated = saveAtomicMemory(state, { id: "mem_0001", kind: "core", content: "代码使用 pnpm" }, 3_000, {
			maxCoreChars: 80,
			seedCorePrompt: "Seed",
		});
		assert.equal(updated.ok, true);
		if (updated.ok) {
			assert.equal(updated.created, false);
			assert.equal(updated.item.createdAtMs, 1_000);
			assert.equal(updated.item.updatedAtMs, 3_000);
		}
	});

	it("searches active memories by CJK/Latin keywords, aliases, and ISO date range, excluding forgotten items", () => {
		const state = createEmptyMemoryStoreState();
		saveAtomicMemory(
			state,
			{
				kind: "episode",
				content: "五月东京出差，入住新宿希尔顿酒店",
				keywords: ["东京", "出差", "酒店"],
				aliases: ["Tokyo trip", "老王同行"],
				validFrom: "2026-05-10",
				validUntil: "2026-05-14",
				sourceEntryId: "entry-11",
			},
			10_000,
		);
		saveAtomicMemory(
			state,
			{
				kind: "fact",
				content: "项目 Alpha 负责人是王明",
				keywords: ["Alpha", "负责人"],
				aliases: ["老王", "Wang"],
				validFrom: "2026-01-01",
			},
			20_000,
		);
		saveAtomicMemory(
			state,
			{
				kind: "fact",
				content: "旧办公室地址在陆家嘴",
				keywords: ["地址", "办公室"],
				aliases: ["旧地址"],
			},
			30_000,
		);

		// Alias lookup
		const aliasHits = searchAtomicMemory(state, { query: "老王" });
		assert.equal(aliasHits.length, 2);
		assert.equal(aliasHits[0]!.item.id, "mem_0002");

		// Bilingual / Latin alias lookup
		const tokyoHits = searchAtomicMemory(state, { query: "tokyo" });
		assert.equal(tokyoHits.length, 1);
		assert.equal(tokyoHits[0]!.item.id, "mem_0001");
		assert.equal(tokyoHits[0]!.item.sourceEntryId, "entry-11");

		// Date range filter
		const mayHits = searchAtomicMemory(state, { query: "", fromDate: "2026-05-01", toDate: "2026-05-31" });
		assert.equal(mayHits.length, 1);
		assert.equal(mayHits[0]!.item.id, "mem_0001");

		// Forget removes from search; restore brings it back.
		const forgot = forgetAtomicMemory(state, "mem_0003", 40_000, "搬家了");
		assert.equal(forgot.ok, true);
		assert.equal(searchAtomicMemory(state, { query: "陆家嘴" }).length, 0);

		const restored = restoreAtomicMemory(state, "mem_0003", 50_000);
		assert.equal(restored.ok, true);
		assert.equal(searchAtomicMemory(state, { query: "陆家嘴" }).length, 1);

		const snap = inspectAtomicMemory(state, 5);
		assert.equal(snap.totalActive, 3);
		assert.equal(snap.totalForgotten, 0);
		assert.ok(formatMemoryInspectReply(snap).includes("mem_0001"));
		assert.ok(formatMemorySearchReply("tokyo", tokyoHits).includes("entry-11"));
	});

	it("validates JEHEE_MEMORY_PROVIDER and JEHEE_MEMORY_CORE_MAX_CHARS config parsing", () => {
		assert.equal(parseMemoryProviderEnv(undefined), undefined);
		assert.equal(parseMemoryProviderEnv("atomic"), "atomic");
		assert.equal(parseMemoryProviderEnv("STATIC"), "static");
		assert.throws(() => parseMemoryProviderEnv("vector"), /Invalid JEHEE_MEMORY_PROVIDER/);

		const cfg = parseJeheeEnvConfig({
			JEHEE_MEMORY_PROVIDER: "atomic",
			JEHEE_MEMORY_CORE_MAX_CHARS: "2048",
		});
		assert.equal(cfg.memoryProvider, "atomic");
		assert.equal(cfg.memoryCoreMaxChars, 2048);
		assert.throws(
			() => parseJeheeEnvConfig({ JEHEE_MEMORY_CORE_MAX_CHARS: "50" }),
			/Invalid JEHEE_MEMORY_CORE_MAX_CHARS/,
		);
	});
});

describe("atomic memory durable host integration", () => {
	it("persists memories across SQLite restart, records telemetry spans, keeps prefixes clean on fact writes, and unloads tools on swap", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "jehee-mem-test-"));
		const sqlitePath = join(tempDir, "jehee.sqlite");
		const recorder = new JeheeTraceRecorder();
		const captured: TranscriptContext[] = [];
		let openHost: JeheeHost | undefined;

		try {
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);

			faux.setResponses([
				(ctx) => {
					captured.push(ctx);
					return fauxAssistantMessage(
						[
							fauxToolCall(MEMORY_SAVE_TOOL, {
								kind: "core",
								content: "统一使用 pnpm 作为包管理器",
								keywords: ["pnpm", "包管理器"],
							}),
						],
						{ stopReason: "toolUse" },
					);
				},
				(ctx) => {
					captured.push(ctx);
					return fauxAssistantMessage(
						[
							fauxToolCall(MEMORY_SAVE_TOOL, {
								kind: "fact",
								content: "张伟负责支付网关迁移",
								keywords: ["支付网关", "迁移"],
								aliases: ["老张", "Zhang"],
								validFrom: "2026-11-20",
							}),
						],
						{ stopReason: "toolUse" },
					);
				},
				(ctx) => {
					captured.push(ctx);
					return fauxAssistantMessage("好的，已记住两条信息。");
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

			const r1 = await host1.sendMessage(
				{ text: "记住：统一用 pnpm；另外老张负责支付网关迁移" },
				BACKGROUND_CONTEXT,
			);
			assert.equal(r1.status, "done");

			// Step 2 (after core save) immediately reflects L1 Core; Step 3 (after fact save) emits zero new system deltas.
			const coreAfterCore = effectiveCoreSection(captured[1]!);
			const coreAfterFact = effectiveCoreSection(captured[2]!);
			assert.ok(coreAfterCore?.includes("统一使用 pnpm 作为包管理器"));
			assert.equal(coreAfterFact, coreAfterCore);
			const sysCountAfterCore = captured[1]!.messages.filter((m) => m.role === "system").length;
			const sysCountAfterFact = captured[2]!.messages.filter((m) => m.role === "system").length;
			assert.equal(sysCountAfterFact, sysCountAfterCore);

			// Telemetry spans recorded for memory_save.
			const traces = await recorder.listTraces();
			const spans = traces.flatMap((t) => t.spans);
			const memSaveSpans = spans.filter((s) => s.name === "jehee.memory.save");
			assert.equal(memSaveSpans.length, 2);

			await host1.close(BACKGROUND_CONTEXT);
			openHost = undefined;

			// Reopen against same SQLite file to verify crash/restart durability.
			const faux2 = fauxProvider();
			const models2 = createModels();
			models2.setProvider(faux2.provider);
			const captured2: TranscriptContext[] = [];
			let searchToolOutput = "";

			faux2.setResponses([
				(ctx) => {
					captured2.push(ctx);
					return fauxAssistantMessage([fauxToolCall(MEMORY_SEARCH_TOOL, { query: "老张" })], {
						stopReason: "toolUse",
					});
				},
				(ctx) => {
					captured2.push(ctx);
					const lastTool = ctx.messages.findLast((m) => m.role === "toolResult");
					if (lastTool?.role === "toolResult") {
						searchToolOutput = lastTool.content.map((b) => (b.type === "text" ? b.text : "")).join("");
					}
					return fauxAssistantMessage("张伟负责支付网关迁移。");
				},
				(ctx) => {
					captured2.push(ctx);
					return fauxAssistantMessage([fauxToolCall(MEMORY_FORGET_TOOL, { id: "mem_0001", reason: "改用 bun" })], {
						stopReason: "toolUse",
					});
				},
				(ctx) => {
					captured2.push(ctx);
					return fauxAssistantMessage("已遗忘 pnpm 规则。");
				},
				(ctx) => {
					captured2.push(ctx);
					return fauxAssistantMessage("已切换为静态记忆。");
				},
			]);

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

			const r2 = await host2.sendMessage({ text: "老张现在负责什么？" }, BACKGROUND_CONTEXT);
			assert.equal(r2.status, "done");
			assert.ok(effectiveCoreSection(captured2[0]!)?.includes("统一使用 pnpm 作为包管理器"));
			assert.ok(searchToolOutput.includes("张伟负责支付网关迁移"));
			assert.ok(searchToolOutput.includes("sourceEntryId"));

			// Forget mem_0001 and verify immediate retraction of effective L1 Core section.
			const r3 = await host2.sendMessage({ text: "忘掉 pnpm 那条" }, BACKGROUND_CONTEXT);
			assert.equal(r3.status, "done");
			assert.equal(effectiveCoreSection(captured2[3]!), null);

			// Hot-swap back to StaticCoreMemoryProvider and verify memory_* tools are unloaded.
			assert.ok(activeToolNames(captured2[0]!).has(MEMORY_SAVE_TOOL));
			host2.setMemoryProvider(new StaticCoreMemoryProvider({ corePrompt: "静态兜底画像" }));
			const r4 = await host2.sendMessage({ text: "测试热切换" }, BACKGROUND_CONTEXT);
			assert.equal(r4.status, "done");
			const lastReq = captured2.at(-1)!;
			const toolNames = activeToolNames(lastReq);
			assert.ok(!toolNames.has(MEMORY_SAVE_TOOL));
			assert.ok(!toolNames.has(MEMORY_SEARCH_TOOL));
			assert.ok(!toolNames.has(MEMORY_FORGET_TOOL));
			assert.ok(effectiveCoreSection(lastReq)?.includes("静态兜底画像"));

			await host2.close(BACKGROUND_CONTEXT);
			openHost = undefined;
		} finally {
			if (openHost !== undefined) {
				await openHost.close(BACKGROUND_CONTEXT);
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("handles /memory, /memory search, /memory forget, /memory restore deterministically with allowlist enforcement", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				memory: new AtomicMemoryProvider({ seedCorePrompt: "基础身份" }),
			},
			BACKGROUND_CONTEXT,
		);

		await host.saveMemory({ kind: "core", content: "回复尽量简短" }, BACKGROUND_CONTEXT);
		await host.saveMemory(
			{ kind: "fact", content: "下周二与产品评审 Q4 路线图", aliases: ["产品评审", "Q4"] },
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

		// Stranger rejected
		const unauth = await gateway.ingest(
			{
				channel: "telegram",
				chatId: "c1",
				senderId: "stranger",
				messageId: "m0",
				text: "/memory",
				timestampMs: 1_000,
			},
			BACKGROUND_CONTEXT,
		);
		assert.equal(unauth.kind, "unauthorized");
		assert.equal(sent.length, 0);

		// Owner /memory list
		const rList = await gateway.ingest(
			{
				channel: "telegram",
				chatId: "c1",
				senderId: "owner-1",
				messageId: "m1",
				text: "/memory",
				timestampMs: 2_000,
			},
			BACKGROUND_CONTEXT,
		);
		assert.deepEqual(rList, { kind: "command_handled", command: "memory" });
		assert.ok(sent.at(-1)?.includes("mem_0001"));
		assert.ok(sent.at(-1)?.includes("mem_0002"));

		// Owner /memory search
		await gateway.ingest(
			{
				channel: "telegram",
				chatId: "c1",
				senderId: "owner-1",
				messageId: "m2",
				text: "/memory search Q4",
				timestampMs: 3_000,
			},
			BACKGROUND_CONTEXT,
		);
		assert.ok(sent.at(-1)?.includes("下周二与产品评审 Q4 路线图"));

		// Owner /memory forget
		await gateway.ingest(
			{
				channel: "telegram",
				chatId: "c1",
				senderId: "owner-1",
				messageId: "m3",
				text: "/memory forget mem_0002",
				timestampMs: 4_000,
			},
			BACKGROUND_CONTEXT,
		);
		assert.ok(sent.at(-1)?.includes("已遗忘记忆 mem_0002"));

		await gateway.ingest(
			{
				channel: "telegram",
				chatId: "c1",
				senderId: "owner-1",
				messageId: "m4",
				text: "/memory search Q4",
				timestampMs: 5_000,
			},
			BACKGROUND_CONTEXT,
		);
		assert.ok(sent.at(-1)?.includes("未找到匹配"));

		// Owner /memory restore
		await gateway.ingest(
			{
				channel: "telegram",
				chatId: "c1",
				senderId: "owner-1",
				messageId: "m5",
				text: "/memory restore mem_0002",
				timestampMs: 6_000,
			},
			BACKGROUND_CONTEXT,
		);
		assert.ok(sent.at(-1)?.includes("已恢复记忆 mem_0002"));

		gateway.dispose();
		await host.close(BACKGROUND_CONTEXT);
	});
});
