// Cucumber step definitions verifying Slice 5C-2 background memory consolidation:
// implicit extraction + watermark idempotency, merge + supersede + tombstone restore,
// automatic idle consolidation scheduling, and /memory consolidate allowlist protection.

import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ChannelGateway, type IngestResult } from "../../src/channels/gateway.ts";
import { AtomicMemoryProvider } from "../../src/memory/atomic-memory.ts";
import type { JeheeWorld } from "../support/world.ts";

let consolTgReplies: string[] = [];
let consolLlmCalls = 0;
let consolUnauthResult: IngestResult | undefined;

Given(
	"已启动挂载原子记忆插件的 Jehee 宿主与 Telegram 渠道网关（授权主人 {string}）",
	async function (this: JeheeWorld, ownerId: string) {
		consolTgReplies = [];
		consolLlmCalls = 0;
		consolUnauthResult = undefined;
		this.host = await this.openHost("memory", new AtomicMemoryProvider());
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
		});
		this.gateway.registerTransport({
			channel: "telegram",
			sendText: async (_chatId, text) => {
				consolTgReplies.push(text);
			},
		});
	},
);

When("主人与宿主完成一轮日常对话 {string}（未显式调用 memory_save）", async function (this: JeheeWorld, text: string) {
	this.installScriptedSteps([
		() => {
			consolLlmCalls += 1;
			return fauxAssistantMessage("好的，明白。");
		},
		() => {
			consolLlmCalls += 1;
			return fauxAssistantMessage(
				JSON.stringify({
					summary: "提取周报格式偏好",
					ops: [
						{
							op: "add",
							kind: "core",
							content: "周报统一使用 bullet list 格式",
							keywords: ["周报", "bullet list"],
							sourceEntryId: "1",
						},
					],
				}),
			);
		},
	]);
	const reply = await this.host!.sendMessage({ text }, this.ctx);
	assert.equal(reply.status, "done");
});

When(
	"主人 {string} 在 Telegram 发送 {string} 触发整理提取隐性偏好",
	async function (this: JeheeWorld, ownerId: string, cmd: string) {
		const res = await this.gateway!.ingest(
			{ channel: "telegram", chatId: "chat-c", senderId: ownerId, messageId: "mc-1", text: cmd, timestampMs: 1_000 },
			this.ctx,
		);
		assert.deepEqual(res, { kind: "command_handled", command: "memory" });
	},
);

Then(
	"渠道回报整理新增 1 条记忆，且 {string} 巡检展示 {string} 偏好与累计整理次数 1",
	async function (this: JeheeWorld, inspectCmd: string, keyword: string) {
		assert.ok(consolTgReplies.at(-1)?.includes("+1 added"));
		await this.gateway!.ingest(
			{
				channel: "telegram",
				chatId: "chat-c",
				senderId: "owner-consol",
				messageId: "mc-2",
				text: inspectCmd,
				timestampMs: 2_000,
			},
			this.ctx,
		);
		const inspectReply = consolTgReplies.at(-1) ?? "";
		assert.ok(inspectReply.includes(keyword), `Expected "${keyword}" in:\n${inspectReply}`);
		assert.ok(inspectReply.includes("runs=1"), `Expected "runs=1" in:\n${inspectReply}`);
	},
);

When("主人 {string} 紧接着再次发送 {string}", async function (this: JeheeWorld, ownerId: string, cmd: string) {
	const beforeCalls = consolLlmCalls;
	await this.gateway!.ingest(
		{ channel: "telegram", chatId: "chat-c", senderId: ownerId, messageId: "mc-3", text: cmd, timestampMs: 3_000 },
		this.ctx,
	);
	assert.equal(consolLlmCalls, beforeCalls);
});

Then("渠道回复无需整理，且后台未发起额外模型调用", () => {
	assert.ok(consolTgReplies.at(-1)?.includes("无需整理"));
	assert.equal(consolLlmCalls, 2);
});

Given(
	"宿主内已存入两条重复记忆 {string}、{string} 以及一条旧地址 {string}",
	async function (this: JeheeWorld, dup1: string, dup2: string, oldAddr: string) {
		await this.host!.saveMemory({ kind: "fact", content: dup1, keywords: ["支付"], aliases: ["老王"] }, this.ctx);
		await this.host!.saveMemory({ kind: "fact", content: dup2, keywords: ["负责人"], aliases: ["Wang"] }, this.ctx);
		await this.host!.saveMemory({ kind: "fact", content: oldAddr, keywords: ["地址", "浦东"] }, this.ctx);
	},
);

When(
	"主人与宿主对话告知 {string}，随后主人发送 {string}",
	async function (this: JeheeWorld, message: string, cmd: string) {
		this.installScriptedSteps([
			fauxAssistantMessage("恭喜乔迁新居！"),
			fauxAssistantMessage(
				JSON.stringify({
					summary: "合并支付负责人重复项并更新深圳南山新地址",
					ops: [
						{
							op: "merge",
							keepId: "mem_0001",
							dropIds: ["mem_0002"],
							content: "王明负责支付服务",
							keywords: ["支付服务"],
						},
						{
							op: "supersede",
							oldId: "mem_0003",
							reason: "搬至深圳南山",
							replacement: {
								kind: "fact",
								content: "现住在深圳南山",
								keywords: ["地址", "深圳", "南山"],
							},
						},
					],
				}),
			),
		]);
		await this.host!.sendMessage({ text: message }, this.ctx);
		await this.gateway!.ingest(
			{
				channel: "telegram",
				chatId: "chat-c",
				senderId: "owner-consol",
				messageId: "mc-4",
				text: cmd,
				timestampMs: 4_000,
			},
			this.ctx,
		);
	},
);

Then(
	"渠道回报 merge=1 与 supersede=1，检索 {string} 命中新地址，检索 {string} 为空，且重复项已合并为 1 条",
	async function (this: JeheeWorld, newQuery: string, oldQuery: string) {
		const reply = consolTgReplies.at(-1) ?? "";
		assert.ok(reply.includes("merge=1"), `Expected merge=1 in: ${reply}`);
		assert.ok(reply.includes("supersede=1"), `Expected supersede=1 in: ${reply}`);

		const newHits = await this.host!.searchMemory({ query: newQuery }, this.ctx);
		assert.equal(newHits.kind, "atomic");
		if (newHits.kind === "atomic") {
			assert.equal(newHits.hits.length, 1);
			assert.ok(newHits.hits[0]!.item.content.includes("深圳南山"));
		}

		const oldHits = await this.host!.searchMemory({ query: oldQuery }, this.ctx);
		assert.equal(oldHits.kind, "atomic");
		if (oldHits.kind === "atomic") {
			assert.equal(oldHits.hits.length, 0);
		}

		const ownerHits = await this.host!.searchMemory({ query: "Wang" }, this.ctx);
		assert.equal(ownerHits.kind, "atomic");
		if (ownerHits.kind === "atomic") {
			assert.equal(ownerHits.hits.length, 1);
			assert.equal(ownerHits.hits[0]!.item.id, "mem_0001");
		}
	},
);

When(
	"主人 {string} 在 Telegram 发送 {string} 撤销旧地址替换",
	async function (this: JeheeWorld, ownerId: string, cmd: string) {
		await this.gateway!.ingest(
			{ channel: "telegram", chatId: "chat-c", senderId: ownerId, messageId: "mc-5", text: cmd, timestampMs: 5_000 },
			this.ctx,
		);
	},
);

Then("检索 {string} 重新命中旧地址 {string}", async function (this: JeheeWorld, query: string, expected: string) {
	const hits = await this.host!.searchMemory({ query }, this.ctx);
	assert.equal(hits.kind, "atomic");
	if (hits.kind === "atomic") {
		assert.equal(hits.hits.length, 1);
		assert.ok(hits.hits[0]!.item.content.includes(expected));
	}
});

Given(
	"已启动开启空闲自动整理（idleDelayMs=60, minNewTurns=2）的原子记忆宿主与 Telegram 网关（授权主人 {string}）",
	async function (this: JeheeWorld, ownerId: string) {
		consolTgReplies = [];
		consolLlmCalls = 0;
		consolUnauthResult = undefined;
		this.host = await this.openHost(
			"memory",
			new AtomicMemoryProvider({ consolidation: { idleDelayMs: 60, minNewTurns: 2 } }),
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
		});
		this.gateway.registerTransport({
			channel: "telegram",
			sendText: async (_chatId, text) => {
				consolTgReplies.push(text);
			},
		});
	},
);

When("陌生人 {string} 在 Telegram 发送 {string}", async function (this: JeheeWorld, strangerId: string, cmd: string) {
	consolUnauthResult = await this.gateway!.ingest(
		{
			channel: "telegram",
			chatId: "chat-c",
			senderId: strangerId,
			messageId: "mc-u1",
			text: cmd,
			timestampMs: 1_000,
		},
		this.ctx,
	);
});

Then("陌生人请求返回 unauthorized 且未触发任何整理", async function (this: JeheeWorld) {
	assert.deepEqual(consolUnauthResult, { kind: "unauthorized" });
	assert.equal(consolTgReplies.length, 0);
	const state = await this.host!.getMemoryConsolidationState(this.ctx);
	assert.equal(state.totalRuns, 0);
});

When("主人与宿主完成 2 轮日常对话并等待空闲整理任务完成", async function (this: JeheeWorld) {
	this.installScriptedSteps([
		fauxAssistantMessage("好的，深色主题很护眼。"),
		fauxAssistantMessage("没问题，明天继续。"),
		fauxAssistantMessage(
			JSON.stringify({
				summary: "自动提炼界面主题偏好",
				ops: [{ op: "add", kind: "core", content: "偏好深色主题", keywords: ["深色主题", "UI"] }],
			}),
		),
	]);
	await this.host!.sendMessage({ text: "我平时软件都偏好深色主题" }, this.ctx);
	await this.host!.sendMessage({ text: "今天先聊到这" }, this.ctx);
	await this.host!.waitForMemoryConsolidation(this.ctx);
});

Then("后台空闲整理自动沉淀隐性事实 {string}，且累计整理次数为 1", async function (this: JeheeWorld, expected: string) {
	const inspected = await this.host!.inspectMemory(this.ctx);
	assert.equal(inspected.kind, "atomic");
	if (inspected.kind === "atomic") {
		assert.ok(inspected.snapshot.coreItems.some((item) => item.content.includes(expected)));
		assert.equal(inspected.consolidation.totalRuns, 1);
	}
});
