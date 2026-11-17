// Cucumber step definitions verifying Jehee's persistent single-entry conversation and pluggable memory contract.

import assert from "node:assert/strict";
import { type DataTable, Given, Then, When } from "@cucumber/cucumber";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import type { MemoryProvider } from "../../src/memory/contract.ts";
import { StaticCoreMemoryProvider } from "../../src/memory/static-core.ts";
import type { JeheeWorld } from "../support/world.ts";

Given("Jehee 以内存模式启动并预设模型回复:", async function (this: JeheeWorld, table: DataTable) {
	const rows = table.hashes();
	this.installScriptedSteps(rows.map((row) => fauxAssistantMessage(row.reply ?? "")));
	await this.openHost("memory");
});

Given("Jehee 以本地 SQLite 模式启动并预设模型回复:", async function (this: JeheeWorld, table: DataTable) {
	const rows = table.hashes();
	this.installScriptedSteps(rows.map((row) => fauxAssistantMessage(row.reply ?? "")));
	await this.openHost("sqlite");
});

Given("Jehee 以内存模式启动且挂载了一个可控慢工具 {string}", async function (this: JeheeWorld, toolName: string) {
	let markEntered!: () => void;
	this.toolEntered = new Promise<void>((resolve) => {
		markEntered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		this.releaseSlowTool = resolve;
	});
	const slowTool = defineTool({
		name: toolName,
		description: "Controllable slow inspection tool for testing mid-turn steering",
		parameters: obj({}),
		execute: async () => {
			markEntered();
			await gate;
			return { output: [{ type: "text", text: "default-env: healthy" }] };
		},
	});
	this.customExtensions = [defineExtension({ name: "test.slow-tools", tools: [slowTool] })];
	await this.openHost("memory");
});

Given(
	"模型第一轮会调用慢工具 {string}，第二轮在看到插话后回复 {string}",
	function (this: JeheeWorld, toolName: string, secondReply: string) {
		this.installScriptedSteps([
			fauxAssistantMessage([fauxToolCall(toolName, {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(secondReply),
		]);
	},
);

Given("Jehee 以内存模式启动并挂载核心记忆 {string}", async function (this: JeheeWorld, corePrompt: string) {
	this.staticMemory = new StaticCoreMemoryProvider({ corePrompt });
	await this.openHost("memory", this.staticMemory);
});

Given("预设模型回复:", function (this: JeheeWorld, table: DataTable) {
	const rows = table.hashes();
	this.installScriptedSteps(rows.map((row) => fauxAssistantMessage(row.reply ?? "")));
});

When("用户携带请求号 {string} 发送消息 {string}", async function (this: JeheeWorld, requestId: string, text: string) {
	assert.ok(this.host, "Host must be opened first");
	this.lastReply = await this.host.sendMessage({ text, requestId }, this.ctx);
	await this.host.waitForIdle(this.ctx);
});

When(
	"网络重投再次携带请求号 {string} 发送消息 {string}",
	async function (this: JeheeWorld, requestId: string, text: string) {
		assert.ok(this.host, "Host must be opened first");
		this.duplicateReply = await this.host.sendMessage({ text, requestId }, this.ctx);
	},
);

When("Jehee 宿主进程正常关闭并以同一个 SQLite 文件重新启动", async function (this: JeheeWorld) {
	assert.ok(this.host, "Host must be running before restart");
	await this.host.close(this.ctx);
	this.host = undefined;
	await this.openHost("sqlite");
});

When("用户异步发起首条消息 {string}", async function (this: JeheeWorld, text: string) {
	assert.ok(this.host, "Host must be opened first");
	this.pendingFirstTurn = await this.host.submitMessage({ text, requestId: "steer-first" }, this.ctx);
});

When("在慢工具尚未结束时用户发送 steer 插话 {string}", async function (this: JeheeWorld, steerText: string) {
	assert.ok(this.host && this.toolEntered, "Slow tool must be configured");
	await this.toolEntered;
	this.pendingSteerTurn = await this.host.submitMessage(
		{ text: steerText, requestId: "steer-msg", whenBusy: "steer" },
		this.ctx,
	);
});

When("慢工具执行完毕放行", async function (this: JeheeWorld) {
	assert.ok(this.releaseSlowTool && this.pendingFirstTurn && this.pendingSteerTurn);
	this.releaseSlowTool();
	this.releaseSlowTool = undefined;
	this.lastReply = await this.pendingFirstTurn.wait(this.ctx);
	await this.pendingSteerTurn.wait(this.ctx);
});

When("系统在运行时热切换为带尾部状态抽屉 {string} 的记忆插件", function (this: JeheeWorld, drawerNote: string) {
	assert.ok(this.host, "Host must be opened first");
	const tailDrawerMemory: MemoryProvider = {
		id: "tail-drawer-memory",
		renderCorePrompt: () => "热切换后的核心画像 v2",
		shapeRequestMessages: ({ messages }) => [
			...messages,
			{
				role: "user",
				content: drawerNote,
				timestamp: Date.now(),
			},
		],
	};
	this.host.setMemoryProvider(tailDrawerMemory);
});

Then("两次提交返回相同的回复 {string}", function (this: JeheeWorld, expectedReply: string) {
	assert.ok(this.lastReply && this.duplicateReply);
	assert.equal(this.lastReply.submissionId, this.duplicateReply.submissionId);
	assert.equal(this.lastReply.status, "done");
	assert.equal(this.duplicateReply.status, "done");
	assert.equal(this.lastReply.replyText, expectedReply);
	assert.equal(this.duplicateReply.replyText, expectedReply);
});

Then("底层模型实际只被调用了 {int} 次", function (this: JeheeWorld, expectedCalls: number) {
	assert.equal(this.faux.state.callCount, expectedCalls);
});

Then("主入口收到回复 {string}", function (this: JeheeWorld, expectedReply: string) {
	assert.ok(this.lastReply);
	assert.equal(this.lastReply.status, "done");
	assert.equal(this.lastReply.replyText, expectedReply);
});

Then("当前主对话可见历史依次包含 {int} 条消息", async function (this: JeheeWorld, expectedCount: number) {
	assert.ok(this.host);
	const history = await this.host.getVisibleHistory(this.ctx);
	assert.equal(history.length, expectedCount);
});

Then(
	"首条回合与 steer 插话均完成，最终模型请求上下文中包含了插话 {string}",
	function (this: JeheeWorld, expectedSteer: string) {
		const userTexts = this.latestRequestUserTexts();
		assert.ok(
			userTexts.some((item) => item.includes(expectedSteer)),
			`Expected latest request user messages ${JSON.stringify(userTexts)} to include ${expectedSteer}`,
		);
	},
);

Then("首条消息最终收到的回合回复为 {string}", function (this: JeheeWorld, expectedReply: string) {
	assert.ok(this.lastReply);
	assert.equal(this.lastReply.status, "done");
	assert.equal(this.lastReply.replyText, expectedReply);
});

Then("模型收到的系统提示词包含核心记忆 {string}", function (this: JeheeWorld, expectedCore: string) {
	const systemText = this.latestSystemSnapshot();
	assert.ok(
		systemText.includes(expectedCore),
		`Expected system prompt ${JSON.stringify(systemText)} to contain ${expectedCore}`,
	);
});

Then(
	"当前记忆插件归档了 {int} 条完整回合记录，助手回复为 {string}",
	function (this: JeheeWorld, expectedTurns: number, expectedReply: string) {
		assert.ok(this.staticMemory);
		assert.equal(this.staticMemory.archivedTurns.length, expectedTurns);
		assert.equal(this.staticMemory.archivedTurns[0]?.assistantReply, expectedReply);
	},
);

Then("最后一次模型请求的消息列表中包含尾部抽屉内容 {string}", function (this: JeheeWorld, expectedDrawer: string) {
	const userTexts = this.latestRequestUserTexts();
	assert.ok(
		userTexts.includes(expectedDrawer),
		`Expected shaped request messages ${JSON.stringify(userTexts)} to contain ${expectedDrawer}`,
	);
});

Then(
	"主对话底层可见历史仍然只有干净的 {int} 条用户与助手消息（不含临时抽屉条目）",
	async function (this: JeheeWorld, expectedCount: number) {
		assert.ok(this.host);
		const history = await this.host.getVisibleHistory(this.ctx);
		assert.equal(history.length, expectedCount);
		assert.ok(history.every((item) => !item.text.includes("短期缓存")));
	},
);
