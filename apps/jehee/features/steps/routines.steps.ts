// Cucumber step definitions verifying Slice 6A (ADR-0014):
// user-side local clock anchor with stable system prefix, SQLite restart persistence of RoutineDoc & LastRouteDoc,
// zero-LLM direct_notify delivery, agent_prompt with [SILENT] suppression + cold allowFrom fallback + telemetry spans,
// and allowlisted /routines [list | run | cancel] commands.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ChannelGateway, type IngestResult } from "../../src/channels/gateway.ts";
import { JeheeHost } from "../../src/core/host.ts";
import { parseUtcOffsetMinutes } from "../../src/governance/quiet-gate.ts";
import { LOCAL_CLOCK_LINE_PREFIX } from "../../src/routines/scheduler.ts";
import { openNodeJeheeHost } from "../../src/runtime/node.ts";
import { JeheeTraceRecorder } from "../../src/telemetry/recorder.ts";
import type { JeheeWorld } from "../support/world.ts";

let routineFakeNow = 0;
let routineRecorder: JeheeTraceRecorder | undefined;
let routineSent: Array<{ readonly chatId: string; readonly text: string }> = [];
let routinePresetId = "";
let routineUnauthResult: IngestResult | undefined;
let routineCallsAfterRestartBase = 0;

function extractSystemText(ctx: TranscriptContext): string {
	const parts: string[] = [];
	for (const msg of ctx.messages) {
		if (msg.role !== "system") continue;
		if (typeof msg.content === "string") {
			parts.push(msg.content);
		} else {
			for (const b of msg.content) parts.push(b.text);
		}
		if (msg.sections !== undefined) {
			for (const [k, v] of Object.entries(msg.sections)) {
				if (v !== null) parts.push(`<${k}>${v}</${k}>`);
			}
		}
	}
	return parts.join("\n");
}

Given("已启动开启 Routines 与时区 {string} 的 Jehee 宿主（时钟可推进）", async function (this: JeheeWorld, tz: string) {
	routineFakeNow = Date.parse("2026-11-25T01:00:00Z"); // 09:00+08:00
	this.host = await JeheeHost.open(
		{
			storage: { kind: "memory" },
			models: this.models,
			defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
			instructions: "Jehee fixed L1 core system prefix.",
			utcOffsetMinutes: parseUtcOffsetMinutes(tz),
			enableRoutines: true,
			now: () => routineFakeNow,
		},
		this.ctx,
	);
});

When("用户在不同时间点连续发送两轮普通对话", async function (this: JeheeWorld) {
	this.installScriptedSteps([fauxAssistantMessage("第一轮回复"), fauxAssistantMessage("第二轮回复")]);
	await this.host!.sendMessage({ text: "早上好" }, this.ctx);
	routineFakeNow = Date.parse("2026-11-25T08:30:00Z"); // 16:30+08:00
	await this.host!.sendMessage({ text: "下午好" }, this.ctx);
});

Then("两轮请求发往模型的系统提示词前缀完全一致且不包含 {string}", function (this: JeheeWorld, forbiddenPrefix: string) {
	assert.equal(this.capturedContexts.length, 2);
	const sys1 = extractSystemText(this.capturedContexts[0]!);
	const sys2 = extractSystemText(this.capturedContexts[1]!);
	assert.equal(sys1, sys2);
	assert.ok(!sys1.includes(forbiddenPrefix));
	assert.ok(!sys1.includes(LOCAL_CLOCK_LINE_PREFIX));
	assert.ok(LOCAL_CLOCK_LINE_PREFIX.startsWith(forbiddenPrefix));
});

Then("发往模型的用户侧消息包含两个时刻对应的本地时钟锚点，而持久化可见历史保持纯净", async function (this: JeheeWorld) {
	const users = this.latestRequestUserTexts();
	assert.ok(users.includes("[Local Time: 2026-11-25 09:00 (Wed, UTC+08:00)]"));
	assert.ok(users.includes("[Local Time: 2026-11-25 16:30 (Wed, UTC+08:00)]"));
	const history = await this.host!.getVisibleHistory(this.ctx);
	assert.equal(history.length, 4);
	assert.equal(history[0]?.text, "早上好");
	assert.equal(history[2]?.text, "下午好");
});

Given(
	"已以本地 SQLite 模式启动 Jehee 宿主与 Telegram 渠道网关（授权主人 {string}）",
	async function (this: JeheeWorld, ownerId: string) {
		routineSent = [];
		this.tempDir = await mkdtemp(join(tmpdir(), "jehee-bdd-rtn-"));
		this.sqlitePath = join(this.tempDir, "jehee.sqlite");
		this.host = await openNodeJeheeHost(
			{
				sqlitePath: this.sqlitePath,
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				utcOffsetMinutes: 480,
				enableRoutines: true,
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
		});
		this.gateway.registerTransport({
			channel: "telegram",
			sendText: async (chatId, text) => {
				routineSent.push({ chatId, text });
			},
		});
	},
);

When(
	"主人 {string} 在会话 {string} 发过一条消息并重启宿主与网关",
	async function (this: JeheeWorld, ownerId: string, chatId: string) {
		this.installScriptedSteps([fauxAssistantMessage("收到！")]);
		await this.gateway!.ingest(
			{
				channel: "telegram",
				chatId,
				senderId: ownerId,
				messageId: "r-m1",
				text: "记录我的会话",
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		this.gateway!.dispose();
		await this.host!.close(this.ctx);

		routineSent = [];
		routineCallsAfterRestartBase = this.faux.state.callCount;
		this.host = await openNodeJeheeHost(
			{
				sqlitePath: this.sqlitePath!,
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				utcOffsetMinutes: 480,
				enableRoutines: true,
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
		});
		this.gateway.registerTransport({
			channel: "telegram",
			sendText: async (targetChatId, text) => {
				routineSent.push({ chatId: targetChatId, text });
			},
		});
	},
);

When(
	"宿主创建一条 {int} 毫秒后触发的 direct_notify 提醒 {string} 并等待调度器结算",
	async function (this: JeheeWorld, delayMs: number, reminderText: string) {
		const res = await this.host!.createRoutine(
			{
				title: "会议提醒",
				mode: "direct_notify",
				payload: reminderText,
				schedule: { kind: "once", runAtMs: Date.now() + delayMs },
			},
			this.ctx,
		);
		assert.equal(res.ok, true);
		await this.host!.waitForRoutineScheduler(this.ctx);
		await this.gateway!.drain();
	},
);

Then(
	"底层模型重启后调用次数为 {int}，且 Telegram 会话 {string} 自动收到提醒 {string}",
	function (this: JeheeWorld, expectedCalls: number, expectedChatId: string, expectedText: string) {
		assert.equal(this.faux.state.callCount - routineCallsAfterRestartBase, expectedCalls);
		assert.equal(routineSent.length, 1);
		assert.deepEqual(routineSent[0], { chatId: expectedChatId, text: expectedText });
	},
);

Given(
	"已启动开启 Routines 与 Trace 录制器的 Jehee 宿主及冷启动 Telegram 网关（授权主人 {string}）",
	async function (this: JeheeWorld, ownerId: string) {
		routineSent = [];
		routineRecorder = new JeheeTraceRecorder();
		this.host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				utcOffsetMinutes: 480,
				enableRoutines: true,
				telemetry: routineRecorder.telemetry,
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
		});
		this.gateway.registerTransport({
			channel: "telegram",
			sendText: async (chatId, text) => {
				routineSent.push({ chatId, text });
			},
		});
	},
);

When(
	"创建一条回复 {string} 的 agent_prompt 巡检与一条返回 {string} 的 agent_prompt 简报并等待触发",
	async function (this: JeheeWorld, silentReply: string, briefingReply: string) {
		this.installScriptedSteps([fauxAssistantMessage(silentReply), fauxAssistantMessage(briefingReply)]);
		const r1 = await this.host!.createRoutine(
			{
				title: "静默巡检",
				mode: "agent_prompt",
				payload: "无紧急事项时保持静默",
				schedule: { kind: "once", runAtMs: Date.now() + 50 },
			},
			this.ctx,
		);
		assert.equal(r1.ok, true);
		await this.host!.waitForRoutineScheduler(this.ctx);

		const r2 = await this.host!.createRoutine(
			{
				title: "早间简报",
				mode: "agent_prompt",
				payload: "汇报今日待办",
				schedule: { kind: "once", runAtMs: Date.now() + 50 },
			},
			this.ctx,
		);
		assert.equal(r2.ok, true);
		await this.host!.waitForRoutineScheduler(this.ctx);
		await this.gateway!.drain();
	},
);

Then(
	"{string} 巡检不会向 Telegram 推送任何消息，而 {string} 自动回退投递至 {string}",
	(_silentToken: string, expectedBriefing: string, expectedChatId: string) => {
		assert.equal(routineSent.length, 1);
		assert.deepEqual(routineSent[0], { chatId: expectedChatId, text: expectedBriefing });
	},
);

Then("Trace 录制器记录了 {int} 条 {string} Span", async (expectedCount: number, spanName: string) => {
	assert.ok(routineRecorder);
	const traces = await routineRecorder.listTraces(100);
	const matched = traces.flatMap((t) => t.spans).filter((s) => s.name === spanName);
	assert.equal(matched.length, expectedCount);
});

Given(
	"已启动开启 Routines 的 Jehee 宿主与 Telegram 渠道网关（授权主人 {string}）并预置一条每日提醒",
	async function (this: JeheeWorld, ownerId: string) {
		routineSent = [];
		routinePresetId = "";
		routineUnauthResult = undefined;
		this.host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				utcOffsetMinutes: 480,
				enableRoutines: true,
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
		});
		this.gateway.registerTransport({
			channel: "telegram",
			sendText: async (chatId, text) => {
				routineSent.push({ chatId, text });
			},
		});
		const created = await this.host.createRoutine(
			{
				title: "每日喝水",
				mode: "direct_notify",
				payload: "记得喝水！",
				schedule: { kind: "daily", hour: 10, minute: 0, utcOffsetMinutes: 480 },
			},
			this.ctx,
		);
		assert.equal(created.ok, true);
		if (created.ok) routinePresetId = created.item.id;
	},
);

When("陌生人 {string} 发送定时指令 {string}", async function (this: JeheeWorld, strangerId: string, cmd: string) {
	routineUnauthResult = await this.gateway!.ingest(
		{
			channel: "telegram",
			chatId: "stranger-c",
			senderId: strangerId,
			messageId: "r-u1",
			text: cmd,
			timestampMs: Date.now(),
		},
		this.ctx,
	);
});

Then("陌生人定时指令返回 unauthorized 且无出站消息", () => {
	assert.deepEqual(routineUnauthResult, { kind: "unauthorized" });
	assert.equal(routineSent.length, 0);
});

When(
	"主人 {string} 依次发送 {string}、{string} 与 {string}",
	async function (this: JeheeWorld, ownerId: string, listCmd: string, runCmd: string, cancelCmd: string) {
		const r1 = await this.gateway!.ingest(
			{
				channel: "telegram",
				chatId: ownerId,
				senderId: ownerId,
				messageId: "r-c1",
				text: listCmd,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		assert.deepEqual(r1, { kind: "command_handled", command: "routines" });

		const r2 = await this.gateway!.ingest(
			{
				channel: "telegram",
				chatId: ownerId,
				senderId: ownerId,
				messageId: "r-c2",
				text: `${runCmd} ${routinePresetId}`,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		assert.deepEqual(r2, { kind: "command_handled", command: "routines" });

		const r3 = await this.gateway!.ingest(
			{
				channel: "telegram",
				chatId: ownerId,
				senderId: ownerId,
				messageId: "r-c3",
				text: `${cancelCmd} ${routinePresetId}`,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		assert.deepEqual(r3, { kind: "command_handled", command: "routines" });
	},
);

Then("渠道依次回执定时任务列表、触发成功提示与取消确认，且任务列表归零", async function (this: JeheeWorld) {
	const texts = routineSent.map((s) => s.text);
	assert.ok(texts.some((t) => t.includes("[Routines]") && t.includes(routinePresetId)));
	assert.ok(texts.some((t) => t.includes("记得喝水！")));
	assert.ok(texts.some((t) => t.includes("已立即触发直推提醒")));
	assert.ok(texts.some((t) => t.includes("已取消定时任务")));
	assert.equal((await this.host!.listRoutines(this.ctx)).length, 0);
});
