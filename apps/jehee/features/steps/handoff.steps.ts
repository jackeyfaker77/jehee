// Cucumber step definitions verifying Slice 5D (ADR-0013):
// automatic sweet-spot compaction + pre-compaction memory consolidation,
// manual `/handoff` with allowlist & `/status` reporting, cross-handoff `history_search` verbatim recall,
// portable snapshot compatibility, and workshop tool isolation.

import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChannelGateway, type IngestResult } from "../../src/channels/gateway.ts";
import { HISTORY_SEARCH_TOOL } from "../../src/context/extension.ts";
import { JeheeHost } from "../../src/core/host.ts";
import { AtomicMemoryProvider } from "../../src/memory/atomic-memory.ts";
import { InstaBoxClient } from "../../src/workshop/instabox-client.ts";
import { SingleBoxWorktreeProvisioner } from "../../src/workshop/provisioner.ts";
import type { JeheeWorld } from "../support/world.ts";

let handoffTgReplies: string[] = [];
let handoffUnauthResult: IngestResult | undefined;
let handoffTokensBefore = 0;
let handoffTokensAfter = 0;
let handoffQueryToolOut = "";
let handoffEntryToolOut = "";
let handoffWorkshopChildCtx: TranscriptContext | undefined;

function extractSystem(ctx: TranscriptContext): string {
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

Given(
	"已启动开启甜点自动压缩（sweetSpotTokens=160, keepRecentTokens=50）与原子记忆的 Jehee 宿主",
	async function (this: JeheeWorld) {
		this.host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				memory: new AtomicMemoryProvider(),
				handoff: {
					sweetSpotTokens: 160,
					keepRecentTokens: 50,
					consolidateBeforeHandoff: true,
				},
			},
			this.ctx,
		);
	},
);

When(
	"用户连续发送 2 轮较长业务对话（含隐性项目代号 {string} 与预算 {string}）并等待自动压缩结算",
	async function (this: JeheeWorld, codename: string, budget: string) {
		const router = (ctx: TranscriptContext) => {
			const sys = extractSystem(ctx);
			if (sys.includes("background memory consolidation engine")) {
				return fauxAssistantMessage(
					JSON.stringify({
						summary: `压缩前落盘${codename}`,
						ops: [
							{
								op: "add",
								kind: "fact",
								content: `${codename}预算为 ${budget}`,
								keywords: [codename, "预算"],
								sourceEntryId: "1",
							},
						],
					}),
				);
			}
			if (sys.includes("context summarization assistant") || sys.includes("seamless window handoff summarizer")) {
				return fauxAssistantMessage(`## Goal\n推进${codename}\n\n## Key Decisions\n- 预算 ${budget}`);
			}
			return fauxAssistantMessage(`明白，继续推进${codename}。`.repeat(10));
		};
		this.installScriptedSteps(Array.from({ length: 12 }, () => router));

		await this.host!.sendMessage(
			{ text: `本季度核心项目是${codename}，核定预算 ${budget}。${"补充上下文细节 ".repeat(25)}` },
			this.ctx,
		);
		await this.host!.sendMessage(
			{ text: `第二轮对齐：确认里程碑与上线窗口。${"详细排期信息 ".repeat(25)}` },
			this.ctx,
		);
		await this.host!.waitForCompaction(this.ctx);
	},
);

Then(
	"宿主累计自动压缩次数至少为 1，且原子记忆库已自动沉淀 {string} 事实",
	async function (this: JeheeWorld, codename: string) {
		const status = await this.host!.getContextStatus(this.ctx);
		assert.ok(status.totalCompactions >= 1, `Expected totalCompactions >= 1, got ${status.totalCompactions}`);
		const hits = await this.host!.searchMemory({ query: codename }, this.ctx);
		assert.equal(hits.kind, "atomic");
		if (hits.kind === "atomic") {
			assert.ok(hits.hits.some((h) => h.item.content.includes(codename)));
		}
	},
);

Then("可移植快照 active 视图包含压缩摘要，full 视图仍完整保留首轮逐字原话", async function (this: JeheeWorld) {
	const active = await this.host!.exportPortableSnapshot(this.ctx, { transcriptScope: "active" });
	const full = await this.host!.exportPortableSnapshot(this.ctx, { transcriptScope: "full" });
	assert.ok(active.context.turns.some((t) => t.role === "summary"));
	assert.ok(full.context.turns.some((t) => t.role === "user" && t.text.includes("星辰计划")));
});

Given(
	"已启动挂载原子记忆的 Jehee 宿主与 Telegram 渠道网关（授权主人 {string}）",
	async function (this: JeheeWorld, ownerId: string) {
		handoffTgReplies = [];
		handoffUnauthResult = undefined;
		handoffTokensBefore = 0;
		handoffTokensAfter = 0;
		this.host = await this.openHost("memory", new AtomicMemoryProvider());
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
		});
		this.gateway.registerTransport({
			channel: "telegram",
			sendText: async (_chatId, text) => {
				handoffTgReplies.push(text);
			},
		});
	},
);

When(
	"宿主先完成一轮长背景对话，随后陌生人 {string} 发送 {string}",
	async function (this: JeheeWorld, strangerId: string, cmd: string) {
		const router = (ctx: TranscriptContext) => {
			const sys = extractSystem(ctx);
			if (sys.includes("background memory consolidation engine")) {
				return fauxAssistantMessage(JSON.stringify({ summary: "无新增", ops: [] }));
			}
			if (sys.includes("seamless window handoff summarizer")) {
				return fauxAssistantMessage("## Goal\n发布收口\n\n## Open Items\n- 检查发布清单");
			}
			return fauxAssistantMessage(`收到长背景说明。${"确认细节 ".repeat(40)}`);
		};
		this.installScriptedSteps(Array.from({ length: 10 }, () => router));

		await this.host!.sendMessage(
			{ text: `长背景交代：准备本周版本发布收口。${"发布事项详情 ".repeat(45)}` },
			this.ctx,
		);
		handoffTokensBefore = (await this.host!.getContextStatus(this.ctx)).activeTokens;

		handoffUnauthResult = await this.gateway!.ingest(
			{
				channel: "telegram",
				chatId: "c-ho",
				senderId: strangerId,
				messageId: "ho-u1",
				text: cmd,
				timestampMs: 1_000,
			},
			this.ctx,
		);
	},
);

Then("陌生人换窗请求返回 unauthorized 且换窗计数仍为 0", async function (this: JeheeWorld) {
	assert.deepEqual(handoffUnauthResult, { kind: "unauthorized" });
	assert.equal(handoffTgReplies.length, 0);
	const status = await this.host!.getContextStatus(this.ctx);
	assert.equal(status.totalHandoffs, 0);
});

When(
	"主人 {string} 发送 {string} 并查询 {string}",
	async function (this: JeheeWorld, ownerId: string, handoffCmd: string, statusCmd: string) {
		const r1 = await this.gateway!.ingest(
			{
				channel: "telegram",
				chatId: "c-ho",
				senderId: ownerId,
				messageId: "ho-1",
				text: handoffCmd,
				timestampMs: 2_000,
			},
			this.ctx,
		);
		assert.deepEqual(r1, { kind: "command_handled", command: "handoff" });
		handoffTokensAfter = (await this.host!.getContextStatus(this.ctx)).activeTokens;

		const r2 = await this.gateway!.ingest(
			{
				channel: "telegram",
				chatId: "c-ho",
				senderId: ownerId,
				messageId: "ho-2",
				text: statusCmd,
				timestampMs: 3_000,
			},
			this.ctx,
		);
		assert.deepEqual(r2, { kind: "command_handled", command: "status" });
	},
);

Then("渠道回报换窗完成且活跃 Token 显著下降，\\/status 展示最新上下文水位与 handoffs=1", () => {
	assert.ok(handoffTgReplies[0]?.includes("[Seamless Handoff]"));
	assert.ok(handoffTokensAfter < handoffTokensBefore, `Expected ${handoffTokensAfter} < ${handoffTokensBefore}`);
	const statusReply = handoffTgReplies.at(-1) ?? "";
	assert.ok(statusReply.includes("context:"), `Expected context line in:\n${statusReply}`);
	assert.ok(statusReply.includes("handoffs=1"), `Expected handoffs=1 in:\n${statusReply}`);
});

Given("已启动挂载原子记忆与内置工坊的 Jehee 宿主", async function (this: JeheeWorld) {
	handoffQueryToolOut = "";
	handoffEntryToolOut = "";
	handoffWorkshopChildCtx = undefined;
	const mockFetch: typeof fetch = async (input) => {
		const url = String(input);
		if (url.endsWith("/machines/m-ho")) {
			return Response.json({ id: "m-ho", name: "m-ho", state: "running" });
		}
		if (url.endsWith("/exec")) {
			return Response.json({ exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false });
		}
		return Response.json({});
	};
	const client = new InstaBoxClient({ apiKey: "test-key", fetchImpl: mockFetch });
	const provisioner = new SingleBoxWorktreeProvisioner({ client, machineId: "m-ho" });
	this.host = await JeheeHost.open(
		{
			storage: { kind: "memory" },
			models: this.models,
			defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
			memory: new AtomicMemoryProvider(),
			handoff: { consolidateBeforeHandoff: false },
			workshop: { client, provisioner, defaultDriver: "builtin" },
		},
		this.ctx,
	);
});

When("首轮对话记录关键原话 {string} 后执行整窗换窗", async function (this: JeheeWorld, quote: string) {
	this.installScriptedSteps([
		fauxAssistantMessage("收到，已记录暗号。"),
		fauxAssistantMessage("## Goal\n保留任务背景（已省略暗号原文）"),
	]);
	await this.host!.sendMessage({ text: `请先听我说一句：${quote}` }, this.ctx);
	const report = await this.host!.handoffWindow(this.ctx);
	assert.equal(report.status, "ok");
});

When(
	"新窗口内主会话调用 history_search 检索 {string} 并按首轮 entryId 回查",
	async function (this: JeheeWorld, keyword: string) {
		// Look up the exact entryId of the first user message from host history to verify entryId recall too.
		const initialLookup = await this.host!.lookupHistory({ query: keyword }, this.ctx);
		assert.equal(initialLookup.mode, "search");
		const firstEntryId = initialLookup.mode === "search" ? (initialLookup.hits[0]?.record.entryId ?? "1") : "1";

		let callStep = 0;
		this.installScriptedSteps([
			() => {
				callStep = 1;
				return fauxAssistantMessage([fauxToolCall(HISTORY_SEARCH_TOOL, { query: keyword })], {
					stopReason: "toolUse",
				});
			},
			(ctx) => {
				const lastTool = ctx.messages.findLast((m) => m.role === "toolResult");
				if (lastTool?.role === "toolResult") {
					handoffQueryToolOut = lastTool.content.map((b) => (b.type === "text" ? b.text : "")).join("");
				}
				callStep = 2;
				return fauxAssistantMessage(
					[fauxToolCall(HISTORY_SEARCH_TOOL, { entryId: firstEntryId, contextWindow: 1 })],
					{ stopReason: "toolUse" },
				);
			},
			(ctx) => {
				const lastTool = ctx.messages.findLast((m) => m.role === "toolResult");
				if (lastTool?.role === "toolResult") {
					handoffEntryToolOut = lastTool.content.map((b) => (b.type === "text" ? b.text : "")).join("");
				}
				assert.equal(callStep, 2);
				return fauxAssistantMessage("已精准回查到原话。");
			},
		]);
		const reply = await this.host!.sendMessage({ text: "回查一下之前的暗号原话" }, this.ctx);
		assert.equal(reply.status, "done");
	},
);

Then("两种方式均精准返回换窗前的逐字原话 {string}", (expectedQuote: string) => {
	assert.ok(handoffQueryToolOut.includes(expectedQuote), `Expected query hit in: ${handoffQueryToolOut}`);
	assert.ok(handoffEntryToolOut.includes(expectedQuote), `Expected entryId hit in: ${handoffEntryToolOut}`);
});

When("主会话派发内置工坊任务 {string}", async function (this: JeheeWorld, taskName: string) {
	const handleConcurrent = (ctx: TranscriptContext) => {
		if (extractSystem(ctx).includes("Jehee Workshop subagent")) {
			handoffWorkshopChildCtx = ctx;
			return fauxAssistantMessage("工坊检查完成。");
		}
		return fauxAssistantMessage("已派发工坊任务。");
	};
	this.installScriptedSteps([
		fauxAssistantMessage([fauxToolCall("workshop", { action: "spawn", name: taskName, message: "检查隔离" })], {
			stopReason: "toolUse",
		}),
		handleConcurrent,
		handleConcurrent,
		fauxAssistantMessage("工坊汇报已收到。"),
	]);
	await this.host!.sendMessage({ text: "派发一个工坊任务" }, this.ctx);
	await this.host!.waitForWorkshopSettled(this.ctx);
});

Then("工坊子 Agent 可用工具集中不包含 history_search", () => {
	assert.ok(handoffWorkshopChildCtx !== undefined, "Expected workshop child context");
	const tools = activeToolNames(handoffWorkshopChildCtx);
	assert.ok(!tools.has(HISTORY_SEARCH_TOOL));
});
