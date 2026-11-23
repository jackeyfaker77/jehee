// Cucumber step definitions verifying Slice 5C-1 atomic memory persistence, alias/date search with provenance,
// immediate L1 Core forgetting & restore, /memory slash command allowlist, prefix stability, and workshop isolation.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChannelGateway, type IngestResult } from "../../src/channels/gateway.ts";
import { JeheeHost } from "../../src/core/host.ts";
import { AtomicMemoryProvider } from "../../src/memory/atomic-memory.ts";
import { MEMORY_FORGET_TOOL, MEMORY_SAVE_TOOL, MEMORY_SEARCH_TOOL } from "../../src/memory/bridge.ts";
import { StaticCoreMemoryProvider } from "../../src/memory/static-core.ts";
import { openNodeJeheeHost } from "../../src/runtime/node.ts";
import { InstaBoxClient } from "../../src/workshop/instabox-client.ts";
import { SingleBoxWorktreeProvisioner } from "../../src/workshop/provisioner.ts";
import type { JeheeWorld } from "../support/world.ts";

let memTgReplies: string[] = [];
let memUnauthResults: IngestResult[] = [];
let memSearchResultJson = "";
let memPrefixBeforeFact = "";
let memPrefixAfterFact = "";
let memWorkshopChildCtx: TranscriptContext | undefined;

function extractSystemText(ctx: TranscriptContext): string {
	const parts: string[] = [];
	for (const msg of ctx.messages) {
		if (msg.role !== "system") continue;
		if (typeof msg.content === "string") {
			parts.push(msg.content);
		} else {
			for (const b of msg.content) {
				parts.push(b.text);
			}
		}
		if (msg.sections !== undefined) {
			for (const [k, v] of Object.entries(msg.sections)) {
				if (v !== null) parts.push(`<${k}>\n${v}\n</${k}>`);
			}
		}
	}
	return parts.join("\n");
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

Given("已以 SQLite 模式启动挂载原子记忆插件的 Jehee 宿主", async function (this: JeheeWorld) {
	memSearchResultJson = "";
	this.tempDir = await mkdtemp(join(tmpdir(), "jehee-bdd-mem-"));
	this.sqlitePath = join(this.tempDir, "jehee.sqlite");
	this.host = await openNodeJeheeHost(
		{
			sqlitePath: this.sqlitePath,
			models: this.models,
			defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
			memory: new AtomicMemoryProvider(),
		},
		this.ctx,
	);
});

When(
	"主会话在首轮调用 memory_save 写入一条 Core 偏好 {string} 和一条带别称 {string} 与日期 {string} 的 Fact {string}",
	async function (this: JeheeWorld, coreText: string, alias: string, date: string, factText: string) {
		this.installScriptedSteps([
			fauxAssistantMessage(
				[
					fauxToolCall(MEMORY_SAVE_TOOL, { kind: "core", content: coreText, keywords: ["pnpm"] }),
					fauxToolCall(MEMORY_SAVE_TOOL, {
						kind: "fact",
						content: factText,
						keywords: ["支付网关"],
						aliases: [alias],
						validFrom: date,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已保存两条记忆。"),
		]);
		const reply = await this.host!.sendMessage({ text: "请记住这两条信息" }, this.ctx);
		assert.equal(reply.status, "done");
	},
);

Then(
	"宿主关闭并重新打开同一 SQLite 文件后，模型收到的系统提示词自动包含 L1 Core {string}",
	async function (this: JeheeWorld, expectedCore: string) {
		await this.host!.close(this.ctx);
		this.host = undefined;

		const faux2 = fauxProvider();
		const models2 = createModels();
		models2.setProvider(faux2.provider);
		const captured2: TranscriptContext[] = [];

		faux2.setResponses([
			(ctx) => {
				captured2.push(ctx);
				return fauxAssistantMessage(
					[
						fauxToolCall(MEMORY_SEARCH_TOOL, {
							query: "老张",
							fromDate: "2026-05-01",
							toDate: "2026-05-31",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			(ctx) => {
				captured2.push(ctx);
				const lastTool = ctx.messages.findLast((m) => m.role === "toolResult");
				if (lastTool?.role === "toolResult") {
					memSearchResultJson = lastTool.content.map((b) => (b.type === "text" ? b.text : "")).join("");
				}
				return fauxAssistantMessage("已查到老张负责支付网关迁移。");
			},
		]);

		this.host = await openNodeJeheeHost(
			{
				sqlitePath: this.sqlitePath!,
				models: models2,
				defaultModel: { provider: "faux", modelId: faux2.getModel().id },
				memory: new AtomicMemoryProvider(),
			},
			this.ctx,
		);

		const reply = await this.host.sendMessage({ text: "五月老张负责什么？" }, this.ctx);
		assert.equal(reply.status, "done");
		assert.ok(extractSystemText(captured2[0]!).includes(expectedCore));
	},
);

Then(
	"通过 memory_search 用别称 {string} 与时间区间 {string} 至 {string} 可精准命中 {string} 且附带 sourceEntryId 溯源",
	(_alias: string, _from: string, _to: string, expectedFact: string) => {
		assert.ok(memSearchResultJson.includes(expectedFact), `Expected "${expectedFact}" in ${memSearchResultJson}`);
		assert.ok(memSearchResultJson.includes("sourceEntryId"), `Expected sourceEntryId in ${memSearchResultJson}`);
	},
);

Given(
	"已以内存模式启动挂载原子记忆插件的 Jehee 宿主与 Telegram 渠道网关（授权主人 {string}）",
	async function (this: JeheeWorld, ownerId: string) {
		memTgReplies = [];
		memUnauthResults = [];
		this.host = await this.openHost("memory", new AtomicMemoryProvider());
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
		});
		this.gateway.registerTransport({
			channel: "telegram",
			sendText: async (_chatId, text) => {
				memTgReplies.push(text);
			},
		});
	},
);

Given(
	"宿主内已存入一条 Core 记忆 {string} 和一条 Fact 记忆 {string}",
	async function (this: JeheeWorld, coreText: string, factText: string) {
		const r1 = await this.host!.saveMemory({ kind: "core", content: coreText }, this.ctx);
		assert.equal(r1.ok, true);
		const r2 = await this.host!.saveMemory({ kind: "fact", content: factText, keywords: ["浦东", "地址"] }, this.ctx);
		assert.equal(r2.ok, true);
	},
);

Given("宿主内已存入一条 Core 记忆 {string}", async function (this: JeheeWorld, coreText: string) {
	const r1 = await this.host!.saveMemory({ kind: "core", content: coreText }, this.ctx);
	assert.equal(r1.ok, true);
});

When("主人 {string} 在 Telegram 发送 {string}", async function (this: JeheeWorld, ownerId: string, text: string) {
	const res = await this.gateway!.ingest(
		{
			channel: "telegram",
			chatId: "chat-mem",
			senderId: ownerId,
			messageId: `msg-${Date.now()}-${Math.random()}`,
			text,
			timestampMs: 1_000,
		},
		this.ctx,
	);
	assert.equal(res.kind, "command_handled");
});

Then(
	"渠道立即回复已遗忘 {string} 且下一轮模型系统提示词中不再包含 {string}",
	async function (this: JeheeWorld, id: string, forgottenCore: string) {
		assert.ok(memTgReplies.at(-1)?.includes(id));
		this.installScriptedSteps([fauxAssistantMessage("收到。")]);
		const reply = await this.host!.sendMessage({ text: "确认一下当前偏好" }, this.ctx);
		assert.equal(reply.status, "done");
		assert.ok(!this.latestSystemSnapshot().includes(forgottenCore));
	},
);

When(
	"主人 {string} 在 Telegram 发送 {string} 后再发送 {string}",
	async function (this: JeheeWorld, ownerId: string, firstCmd: string, secondCmd: string) {
		await this.gateway!.ingest(
			{
				channel: "telegram",
				chatId: "chat-mem",
				senderId: ownerId,
				messageId: "m-cmd-1",
				text: firstCmd,
				timestampMs: 2_000,
			},
			this.ctx,
		);
		await this.gateway!.ingest(
			{
				channel: "telegram",
				chatId: "chat-mem",
				senderId: ownerId,
				messageId: "m-cmd-2",
				text: secondCmd,
				timestampMs: 3_000,
			},
			this.ctx,
		);
	},
);

Then("渠道回复未找到匹配记忆", () => {
	assert.ok(memTgReplies.at(-1)?.includes("未找到匹配"));
});

Then("渠道回复重新命中 {string}", (expectedFact: string) => {
	assert.ok(memTgReplies.at(-1)?.includes(expectedFact));
});

When(
	"陌生人 {string} 在 Telegram 发送 {string} 和 {string}",
	async function (this: JeheeWorld, strangerId: string, cmd1: string, cmd2: string) {
		memUnauthResults.push(
			await this.gateway!.ingest(
				{
					channel: "telegram",
					chatId: "chat-mem",
					senderId: strangerId,
					messageId: "m-u1",
					text: cmd1,
					timestampMs: 1_000,
				},
				this.ctx,
			),
		);
		memUnauthResults.push(
			await this.gateway!.ingest(
				{
					channel: "telegram",
					chatId: "chat-mem",
					senderId: strangerId,
					messageId: "m-u2",
					text: cmd2,
					timestampMs: 2_000,
				},
				this.ctx,
			),
		);
	},
);

Then(
	"两次请求均返回 unauthorized 且渠道未发送任何回复，记忆 {string} 仍保持活跃",
	async function (this: JeheeWorld, id: string) {
		assert.equal(memUnauthResults.length, 2);
		assert.ok(memUnauthResults.every((r) => r.kind === "unauthorized"));
		assert.equal(memTgReplies.length, 0);
		const inspected = await this.host!.inspectMemory(this.ctx);
		assert.equal(inspected.kind, "atomic");
		if (inspected.kind === "atomic") {
			assert.ok(inspected.snapshot.coreItems.some((item) => item.id === id));
		}
	},
);

Given(
	"已以内存模式启动挂载原子记忆插件的 Jehee 宿主（初始 Core 种子 {string}）",
	async function (this: JeheeWorld, seed: string) {
		memPrefixBeforeFact = "";
		memPrefixAfterFact = "";
		this.host = await this.openHost("memory", new AtomicMemoryProvider({ seedCorePrompt: seed }));
	},
);

When("主会话写入一条 Fact 记忆 {string}", async function (this: JeheeWorld, factText: string) {
	this.installScriptedSteps([
		(ctx) => {
			memPrefixBeforeFact = extractSystemText(ctx);
			return fauxAssistantMessage([fauxToolCall(MEMORY_SAVE_TOOL, { kind: "fact", content: factText })], {
				stopReason: "toolUse",
			});
		},
		(ctx) => {
			memPrefixAfterFact = extractSystemText(ctx);
			return fauxAssistantMessage("已记录。");
		},
	]);
	const reply = await this.host!.sendMessage({ text: `记一下：${factText}` }, this.ctx);
	assert.equal(reply.status, "done");
});

Then("写入 Fact 前后两轮请求的 L1 Core 系统提示词前缀完全一致", () => {
	assert.ok(memPrefixBeforeFact.length > 0);
	assert.equal(memPrefixAfterFact, memPrefixBeforeFact);
});

When("运行时热切换回静态核心记忆 {string} 并发送一轮新消息", async function (this: JeheeWorld, staticPrompt: string) {
	this.host!.setMemoryProvider(new StaticCoreMemoryProvider({ corePrompt: staticPrompt }));
	this.installScriptedSteps([fauxAssistantMessage("切换成功。")]);
	const reply = await this.host!.sendMessage({ text: "测试静态记忆" }, this.ctx);
	assert.equal(reply.status, "done");
});

Then(
	"模型请求中不再挂载 memory_save、memory_search、memory_forget 工具，且系统提示词切换为 {string}",
	function (this: JeheeWorld, staticPrompt: string) {
		const latest = this.capturedContexts.at(-1)!;
		const names = activeToolNames(latest);
		assert.ok(!names.has(MEMORY_SAVE_TOOL));
		assert.ok(!names.has(MEMORY_SEARCH_TOOL));
		assert.ok(!names.has(MEMORY_FORGET_TOOL));
		assert.ok(this.latestSystemSnapshot().includes(staticPrompt));
	},
);

Given("已以内存模式启动同时挂载原子记忆插件与内置工坊的 Jehee 宿主", async function (this: JeheeWorld) {
	memWorkshopChildCtx = undefined;
	const mockFetch: typeof fetch = async (input) => {
		const url = String(input);
		if (url.endsWith("/machines/m-mem")) {
			return Response.json({ id: "m-mem", name: "m-mem", state: "running" });
		}
		if (url.endsWith("/exec")) {
			return Response.json({ exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false });
		}
		return Response.json({});
	};
	const client = new InstaBoxClient({ apiKey: "test-key", fetchImpl: mockFetch });
	const provisioner = new SingleBoxWorktreeProvisioner({ client, machineId: "m-mem" });
	this.host = await JeheeHost.open(
		{
			storage: { kind: "memory" },
			models: this.models,
			defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
			memory: new AtomicMemoryProvider(),
			workshop: { client, provisioner, defaultDriver: "builtin" },
		},
		this.ctx,
	);
});

When("主会话通过 workshop\\(spawn) 派发一个内置工坊任务 {string}", async function (this: JeheeWorld, taskName: string) {
	const handleConcurrent = (ctx: TranscriptContext) => {
		if (extractSystemText(ctx).includes("Jehee Workshop subagent")) {
			memWorkshopChildCtx = ctx;
			return fauxAssistantMessage("工坊检查完成。");
		}
		return fauxAssistantMessage("已派发工坊任务。");
	};
	this.installScriptedSteps([
		fauxAssistantMessage([fauxToolCall("workshop", { action: "spawn", name: taskName, message: "检查工坊隔离" })], {
			stopReason: "toolUse",
		}),
		handleConcurrent,
		handleConcurrent,
		fauxAssistantMessage("工坊任务已完成。"),
	]);

	const reply = await this.host!.sendMessage({ text: "派发工坊任务" }, this.ctx);
	assert.equal(reply.status, "done");
	await this.host!.waitForWorkshopSettled(this.ctx);
});

Then(
	"工坊子 Agent 收到的系统提示词包含 {string}，且可用工具集中不包含 memory_save 或 memory_forget",
	(expectedCore: string) => {
		assert.ok(memWorkshopChildCtx !== undefined, "Expected workshop child context to be captured");
		assert.ok(extractSystemText(memWorkshopChildCtx).includes(expectedCore));
		const toolNames = activeToolNames(memWorkshopChildCtx);
		assert.ok(!toolNames.has(MEMORY_SAVE_TOOL));
		assert.ok(!toolNames.has(MEMORY_FORGET_TOOL));
	},
);
