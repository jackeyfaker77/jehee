// Cucumber step definitions verifying durable write-confirmation tickets, Telegram inline callback approval,
// intent-digest anti-tampering, SQLite restart persistence, stranger rejection, and proactive quiet-hours governance.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import type { ChannelInlineButton } from "../../src/channels/contract.ts";
import { ChannelGateway, type IngestResult } from "../../src/channels/gateway.ts";
import { JeheeHost } from "../../src/core/host.ts";
import { parseQuietHoursWindow } from "../../src/governance/quiet-gate.ts";
import { openNodeJeheeHost } from "../../src/runtime/node.ts";
import { createMockPaleEnvironment, type MockPaleEnvironment } from "../../test/fixtures/pale-mcp-fixture.ts";
import type { JeheeWorld } from "../support/world.ts";

type CapturedTgMessage = {
	readonly chatId: string;
	readonly text: string;
	readonly buttons?: readonly (readonly ChannelInlineButton[])[];
};

let govPaleEnv: MockPaleEnvironment;
let tgCaptured: CapturedTgMessage[] = [];
let callbackToasts: string[] = [];
let latestTicketId = "";
let unauthorizedResults: IngestResult[] = [];
let fakeClockMs = Date.parse("2026-11-18T04:00:00Z");
let baselineTgCount = 0;

function toolResultTexts(ctx: TranscriptContext): string[] {
	const out: string[] = [];
	for (const msg of ctx.messages) {
		if (msg.role !== "toolResult") continue;
		for (const block of msg.content) {
			if (block.type === "text") out.push(block.text);
		}
	}
	return out;
}

function latestUserText(ctx: TranscriptContext): string {
	for (let i = ctx.messages.length - 1; i >= 0; i--) {
		const m = ctx.messages[i]!;
		if (m.role !== "user") continue;
		if (typeof m.content === "string") return m.content;
		return m.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n");
	}
	return "";
}

function attachMockTelegram(gateway: ChannelGateway): void {
	gateway.registerTransport({
		channel: "telegram",
		sendText: async (chatId, text, options) => {
			tgCaptured.push({
				chatId,
				text,
				...(options?.buttons !== undefined ? { buttons: options.buttons } : {}),
			});
		},
		answerCallback: async (_cbId, text) => {
			if (text !== undefined) callbackToasts.push(text);
		},
	});
}

Given(
	"已启动开启 {string} 门控的模拟邮件 MCP 宿主与 Telegram 渠道网关（授权主人 {string}）",
	async function (this: JeheeWorld, gateMode: string, ownerId: string) {
		govPaleEnv = createMockPaleEnvironment({ distractorServerCount: 0 });
		tgCaptured = [];
		callbackToasts = [];
		latestTicketId = "";
		unauthorizedResults = [];

		let prevToolResultsCount = 0;
		const router: FauxResponseStep = (ctx) => {
			const results = toolResultTexts(ctx);
			const addedResults = results.length - prevToolResultsCount;
			prevToolResultsCount = results.length;
			const lastUser = latestUserText(ctx);

			if (lastUser.includes("今天星期几")) {
				return fauxAssistantMessage("今天是星期三，你可以稍后再决定是否发那封接机邮件。");
			}

			// First step of a send request or an approval resume: call mail_send if no new tool result landed in this run yet.
			if (addedResults === 0) {
				return fauxAssistantMessage(
					[
						fauxToolCall("mcp__mail__mail_send", {
							id: "msg-draft-1",
							expected_version: { epoch: 1, revision: 0 },
							request_id: `send-${results.length + 1}`,
						}),
					],
					{ stopReason: "toolUse" },
				);
			}

			const newestResult = results.at(-1) ?? "";
			if (newestResult.includes("confirmation_required")) {
				return fauxAssistantMessage("发信操作已挂起等待你的确认，批准后我会立即发出。");
			}
			return fauxAssistantMessage("已按你的确认成功发送接机草稿 msg-draft-1。");
		};

		this.faux.setResponses(Array.from({ length: 12 }, () => router));

		this.host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				mcp: {
					servers: [govPaleEnv.mailSpec],
					exposure: "eager",
					writeGate: gateMode === "confirm-writes" ? { mode: "confirm-writes" } : { mode: "off" },
				},
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
		});
		attachMockTelegram(this.gateway);
	},
);

When(
	"主人 {string} 在会话 {string} 发送 {string}",
	async function (this: JeheeWorld, senderId: string, chatId: string, text: string) {
		assert.ok(this.gateway);
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId,
				senderId,
				messageId: `m-${Date.now()}-${Math.random()}`,
				text,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
	},
);

Then(
	"邮件写操作被拦截并生成待确认票据，Telegram 会话 {string} 收到带内联批准按钮的确认卡片，实际外发邮件数为 {int}",
	async function (this: JeheeWorld, expectedChatId: string, expectedSentCount: number) {
		assert.ok(this.host);
		const pending = await this.host.listPendingApprovals(this.ctx);
		assert.equal(pending.length, 1);
		latestTicketId = pending[0]!.id;

		const cardMsg = tgCaptured.find((m) => m.chatId === expectedChatId && m.text.includes(latestTicketId));
		assert.ok(cardMsg, `Expected approval card for ${latestTicketId} in ${JSON.stringify(tgCaptured)}`);
		const okBtn = cardMsg.buttons?.[0]?.find((b) => b.callbackData === `apv:ok:${latestTicketId}`);
		assert.ok(okBtn, "Expected inline approve button on approval card");
		assert.equal(govPaleEnv.snapshot().mailSentIds.length, expectedSentCount);
	},
);

Then(
	"等待确认期间主对话处于空闲状态，主人穿插发送 {string} 能立即得到正常回复",
	async function (this: JeheeWorld, casualText: string) {
		assert.ok(this.host && this.gateway);
		assert.equal(await this.host.isBusy(this.ctx), false);
		const res = await this.gateway.ingest(
			{
				channel: "telegram",
				chatId: "chat-500",
				senderId: "tg-owner-1",
				messageId: "m-casual-1",
				text: casualText,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		assert.equal(res.kind, "replied");
		if (res.kind === "replied") {
			assert.ok(res.replyText.includes("星期三"));
		}
	},
);

When("主人 {string} 点击 Telegram 确认卡片上的内联批准按钮", async function (this: JeheeWorld, senderId: string) {
	assert.ok(this.gateway);
	await this.gateway.ingestCallback(
		{
			channel: "telegram",
			chatId: "chat-500",
			senderId,
			callbackId: "cb-approve-1",
			messageId: "88",
			data: `apv:ok:${latestTicketId}`,
			timestampMs: Date.now(),
		},
		this.ctx,
	);
});

Then(
	"系统自动唤醒主对话执行已批准的 {string}，邮件 {string} 成功发出（外发邮件数为 {int}）",
	function (this: JeheeWorld, _toolName: string, expectedMailId: string, expectedCount: number) {
		const snap = govPaleEnv.snapshot();
		assert.equal(snap.mailSentIds.length, expectedCount);
		assert.equal(snap.mailSentIds[0], expectedMailId);
		assert.ok(callbackToasts.some((t) => t.includes("已批准")));
	},
);

Then(
	"该单次批准票据已消费，若再次尝试无新审批直接调用同一发信操作仍会被门控拦截（外发邮件数保持为 {int}）",
	async function (this: JeheeWorld, expectedCount: number) {
		assert.ok(this.gateway);
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId: "chat-500",
				senderId: "tg-owner-1",
				messageId: "m-replay-attempt",
				text: "再发一次同一封邮件",
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		assert.equal(govPaleEnv.snapshot().mailSentIds.length, expectedCount);
	},
);

Given(
	"已在本地 SQLite 开启 {string} 门控挂载模拟邮件 MCP 与渠道网关（授权主人 {string}）",
	async function (this: JeheeWorld, gateMode: string, ownerId: string) {
		govPaleEnv = createMockPaleEnvironment({ distractorServerCount: 0 });
		tgCaptured = [];
		this.tempDir = await mkdtemp(join(tmpdir(), "jehee-bdd-gov-"));
		this.sqlitePath = join(this.tempDir, "gov.sqlite");

		const installTamperingRouter = () => {
			let prevResults = 0;
			const router: FauxResponseStep = (ctx) => {
				const results = toolResultTexts(ctx);
				const delta = results.length - prevResults;
				prevResults = results.length;
				const lastUser = latestUserText(ctx);

				if (delta === 0) {
					// On approval resume, attempt to bait-and-switch `id` from `msg-draft-1` to `msg-secret-99`!
					const targetDraftId = lastUser.includes("[Owner Approval Granted]") ? "msg-secret-99" : "msg-draft-1";
					return fauxAssistantMessage(
						[
							fauxToolCall("mcp__mail__mail_send", {
								id: targetDraftId,
								expected_version: { epoch: 1, revision: 0 },
								request_id: `tamper-${results.length + 1}`,
							}),
						],
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("操作需要审批确认。");
			};
			this.faux.setResponses(Array.from({ length: 8 }, () => router));
		};

		installTamperingRouter();
		this.host = await openNodeJeheeHost(
			{
				sqlitePath: this.sqlitePath,
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				mcp: {
					servers: [govPaleEnv.mailSpec],
					exposure: "eager",
					writeGate: gateMode === "confirm-writes" ? { mode: "confirm-writes" } : { mode: "off" },
				},
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
		});
		attachMockTelegram(this.gateway);
	},
);

When(
	"主人 {string} 在会话 {string} 请求发送草稿 {string} 触发生成待批票据",
	async function (this: JeheeWorld, senderId: string, chatId: string, draftId: string) {
		assert.ok(this.gateway && this.host);
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId,
				senderId,
				messageId: "m-req-1",
				text: `发送草稿 ${draftId}`,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		const pending = await this.host.listPendingApprovals(this.ctx);
		assert.equal(pending.length, 1);
		latestTicketId = pending[0]!.id;
	},
);

When("宿主进程重启并重新打开同一本地 SQLite 数据库后查询 {string}", async function (this: JeheeWorld, cmd: string) {
	assert.ok(this.host && this.gateway && this.sqlitePath);
	this.gateway.dispose();
	await this.host.close(this.ctx);

	let prevResults = 1;
	const postRestartRouter: FauxResponseStep = (ctx) => {
		const results = toolResultTexts(ctx);
		const delta = results.length - prevResults;
		prevResults = results.length;
		if (delta === 0) {
			return fauxAssistantMessage(
				[
					fauxToolCall("mcp__mail__mail_send", {
						id: "msg-secret-99",
						expected_version: { epoch: 1, revision: 0 },
						request_id: "tamper-after-restart",
					}),
				],
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("检测到目标邮件参数变更，已重新拦截等待确认。");
	};
	this.faux.setResponses(Array.from({ length: 6 }, () => postRestartRouter));

	this.host = await openNodeJeheeHost(
		{
			sqlitePath: this.sqlitePath,
			models: this.models,
			defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
			mcp: {
				servers: [govPaleEnv.mailSpec],
				exposure: "eager",
				writeGate: { mode: "confirm-writes" },
			},
		},
		this.ctx,
	);
	this.gateway = new ChannelGateway({
		host: this.host,
		allowFrom: { telegram: ["tg-owner-1"] },
	});
	attachMockTelegram(this.gateway);

	await this.gateway.ingest(
		{
			channel: "telegram",
			chatId: "chat-501",
			senderId: "tg-owner-1",
			messageId: "m-status-after-restart",
			text: cmd,
			timestampMs: Date.now(),
		},
		this.ctx,
	);
});

Then("状态回执显示 {string}（待批票据跨越重启未丢失）", (expectedSnippet: string) => {
	const lastMsg = tgCaptured.at(-1)?.text ?? "";
	assert.ok(lastMsg.includes(expectedSnippet), `Expected "${expectedSnippet}" in:\n${lastMsg}`);
});

When(
	"主人发送 {string} 批准该票据，但模型在续跑轮试图篡改参数改发另一封邮件 {string}",
	async function (this: JeheeWorld, approveCmd: string, _tamperedId: string) {
		assert.ok(this.gateway);
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId: "chat-501",
				senderId: "tg-owner-1",
				messageId: "m-approve-1",
				text: approveCmd,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
	},
);

Then(
	"篡改参数的发信调用被参数指纹门控拦截并生成新待批票据，邮件实际外发数仍为 {int}",
	async function (this: JeheeWorld, expectedSent: number) {
		assert.ok(this.host);
		assert.equal(govPaleEnv.snapshot().mailSentIds.length, expectedSent);
		const pending = await this.host.listPendingApprovals(this.ctx);
		assert.equal(pending.length, 1);
		assert.notEqual(pending[0]?.id, latestTicketId);
	},
);

When(
	"主人 {string} 在会话 {string} 请求发送草稿 {string} 生成待确认票据",
	async function (this: JeheeWorld, senderId: string, chatId: string, draftId: string) {
		assert.ok(this.gateway && this.host);
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId,
				senderId,
				messageId: "m-owner-req",
				text: `发送草稿 ${draftId}`,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		const pending = await this.host.listPendingApprovals(this.ctx);
		assert.equal(pending.length, 1);
		latestTicketId = pending[0]!.id;
	},
);

When(
	"未授权陌生人 {string} 伪造点击该票据的 Telegram 内联批准按钮并发送 {string}",
	async function (this: JeheeWorld, strangerId: string, slashCmd: string) {
		assert.ok(this.gateway);
		const cbRes = await this.gateway.ingestCallback(
			{
				channel: "telegram",
				chatId: "chat-502",
				senderId: strangerId,
				callbackId: "cb-stranger-1",
				messageId: "91",
				data: `apv:ok:${latestTicketId}`,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		const msgRes = await this.gateway.ingest(
			{
				channel: "telegram",
				chatId: "chat-502",
				senderId: strangerId,
				messageId: "m-stranger-2",
				text: slashCmd,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		unauthorizedResults = [cbRes, msgRes];
	},
);

Then(
	"两次未授权操作均返回 {string}，待确认票据仍保持 {string} 且邮件实际外发数为 {int}",
	async function (this: JeheeWorld, expectedKind: string, _expectedStatus: string, expectedSent: number) {
		assert.ok(this.host);
		assert.deepEqual(
			unauthorizedResults.map((r) => r.kind),
			[expectedKind, expectedKind],
		);
		const pending = await this.host.listPendingApprovals(this.ctx);
		assert.equal(pending.length, 1);
		assert.equal(pending[0]?.id, latestTicketId);
		assert.equal(govPaleEnv.snapshot().mailSentIds.length, expectedSent);
	},
);

Given(
	"已启动配置静默时段 {string}（UTC+08:00）与 {int} 秒冷却窗口的渠道网关（授权主人 {string}）",
	async function (this: JeheeWorld, quietSpec: string, cooldownSec: number, ownerId: string) {
		tgCaptured = [];
		fakeClockMs = Date.parse("2026-11-18T16:30:00Z");
		this.faux.setResponses([() => fauxAssistantMessage("早上好！新的一天开始了。")]);

		this.host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				now: () => fakeClockMs,
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
			quietPolicy: {
				quietHours: parseQuietHoursWindow(quietSpec, "+08:00"),
				minIntervalMs: cooldownSec * 1000,
			},
			now: () => fakeClockMs,
		});
		attachMockTelegram(this.gateway);
	},
);

Given(
	"当前时钟处在深夜静默时段 {string}（北京时间 00:30），主人先发送过 {string} 激活路由 {string}",
	async function (this: JeheeWorld, isoUtc: string, cmd: string, chatId: string) {
		assert.ok(this.gateway);
		fakeClockMs = Date.parse(isoUtc);
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId,
				senderId: "tg-owner-1",
				messageId: "m-init-route",
				text: cmd,
				timestampMs: fakeClockMs,
			},
			this.ctx,
		);
		baselineTgCount = tgCaptured.length;
	},
);

When(
	"后台连续产生 {string} 空巡检与两条完工汇报 {string}、{string}",
	async function (this: JeheeWorld, silentToken: string, reportA: string, reportB: string) {
		assert.ok(this.gateway);
		const route = { channel: "telegram", chatId: "chat-503" };
		await this.gateway.pushMessage(route, silentToken);
		await this.gateway.pushMessage(route, reportA);
		await this.gateway.pushMessage(route, reportB);
	},
);

Then(
	"{string} 被直接丢弃，两条有效汇报被静默暂存（Telegram 深夜新增打扰消息数为 {int}，暂存数为 {int}）",
	function (this: JeheeWorld, _silentToken: string, expectedNewDeliveries: number, expectedHeld: number) {
		assert.ok(this.gateway);
		assert.equal(tgCaptured.length - baselineTgCount, expectedNewDeliveries);
		assert.equal(this.gateway.heldProactiveCount, expectedHeld);
	},
);

When(
	"时钟推进到白天 {string}（北京时间 09:00），主人发送日常消息 {string}",
	async function (this: JeheeWorld, morningIso: string, text: string) {
		assert.ok(this.gateway);
		fakeClockMs = Date.parse(morningIso);
		baselineTgCount = tgCaptured.length;
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId: "chat-503",
				senderId: "tg-owner-1",
				messageId: "m-morning-1",
				text,
				timestampMs: fakeClockMs,
			},
			this.ctx,
		);
	},
);

Then(
	"Telegram 会话 {string} 先自动收到包含 {string} 的暂存通知汇总，再收到 {string} 的正常回复（暂存数归 {int}）",
	function (
		this: JeheeWorld,
		expectedChatId: string,
		expectedDigestMark: string,
		expectedMorningWord: string,
		expectedHeld: number,
	) {
		assert.ok(this.gateway);
		const newMsgs = tgCaptured.slice(baselineTgCount).filter((m) => m.chatId === expectedChatId);
		assert.equal(newMsgs.length, 2);
		assert.ok(newMsgs[0]?.text.includes(expectedDigestMark), `Expected digest first, got: ${newMsgs[0]?.text}`);
		assert.ok(newMsgs[0]?.text.includes("alpha") && newMsgs[0]?.text.includes("beta"));
		assert.ok(newMsgs[1]?.text.includes(expectedMorningWord), `Expected reply second, got: ${newMsgs[1]?.text}`);
		assert.equal(this.gateway.heldProactiveCount, expectedHeld);
	},
);

let modelCallsBeforeCancel = 0;
let slowBusyBaselineTgCount = 0;

Given(
	"已在本地 SQLite 开启 {string} 与豁免规则 {string} 挂载邮件及日历 MCP",
	async function (this: JeheeWorld, gateMode: string, exemptRule: string) {
		govPaleEnv = createMockPaleEnvironment({ distractorServerCount: 0, calendarInitialRevision: 1 });
		tgCaptured = [];
		callbackToasts = [];
		latestTicketId = "";
		this.tempDir = await mkdtemp(join(tmpdir(), "jehee-bdd-gov-exempt-"));
		this.sqlitePath = join(this.tempDir, "gov-exempt.sqlite");

		const router: FauxResponseStep = (ctx) => {
			const lastRole = ctx.messages.at(-1)?.role;
			const lastUser = latestUserText(ctx);

			if (lastUser.includes("先执行日历导入")) {
				if (lastRole === "user") {
					return fauxAssistantMessage(
						[
							fauxToolCall("mcp__calendar__calendar_import_ics", {
								text: govPaleEnv.icsText,
								expected_version: { epoch: 1, revision: 1 },
								request_id: "exempt-ics-1",
							}),
							fauxToolCall("mcp__mail__mail_send", {
								id: "msg-draft-1",
								expected_version: { epoch: 1, revision: 0 },
								request_id: "send-gated-1",
							}),
						],
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("日历已导入；外发邮件等待你的确认。");
			}

			if (lastRole === "user") {
				const count = toolResultTexts(ctx).length;
				return fauxAssistantMessage(
					[
						fauxToolCall("mcp__mail__mail_send", {
							id: "msg-draft-1",
							expected_version: { epoch: 1, revision: 0 },
							request_id: `send-resume-${count + 1}`,
						}),
					],
					{ stopReason: "toolUse" },
				);
			}
			const newest = toolResultTexts(ctx).at(-1) ?? "";
			if (newest.includes("confirmation_required")) {
				return fauxAssistantMessage("已拦截等待确认。");
			}
			return fauxAssistantMessage("已在重启后完成已批准邮件发送。");
		};
		this.faux.setResponses(Array.from({ length: 12 }, () => router));

		this.host = await openNodeJeheeHost(
			{
				sqlitePath: this.sqlitePath,
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				mcp: {
					servers: [govPaleEnv.mailSpec, govPaleEnv.calendarSpec],
					exposure: "eager",
					writeGate: {
						mode: gateMode === "confirm-writes" ? "confirm-writes" : "off",
						exemptTools: [exemptRule],
					},
				},
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({ host: this.host, allowFrom: { telegram: ["tg-owner-1"] } });
		attachMockTelegram(this.gateway);
	},
);

When(
	"主人 {string} 在会话 {string} 先执行日历导入再发送草稿 {string}",
	async function (this: JeheeWorld, senderId: string, chatId: string, _draftId: string) {
		assert.ok(this.gateway && this.host);
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId,
				senderId,
				messageId: "m-exempt-and-send",
				text: "先执行日历导入再把草稿 msg-draft-1 发出去",
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		const pending = await this.host.listPendingApprovals(this.ctx);
		assert.equal(pending.length, 1);
		latestTicketId = pending[0]!.id;
	},
);

Then(
	"日历导入因命中豁免规则免批直通（日历事件数为 {int}），而发信被拦截生成待批票据（外发邮件数为 {int}）",
	(expectedEvents: number, expectedMailSent: number) => {
		const snap = govPaleEnv.snapshot();
		assert.equal(snap.calendarEvents.length, expectedEvents);
		assert.equal(snap.mailSentIds.length, expectedMailSent);
	},
);

When("主人点击确认卡片上的 Telegram 取消按钮作废该票据", async function (this: JeheeWorld) {
	assert.ok(this.gateway);
	modelCallsBeforeCancel = this.faux.state.callCount;
	await this.gateway.ingestCallback(
		{
			channel: "telegram",
			chatId: "chat-504",
			senderId: "tg-owner-1",
			callbackId: "cb-cancel-1",
			messageId: "101",
			data: `apv:no:${latestTicketId}`,
			timestampMs: Date.now(),
		},
		this.ctx,
	);
});

Then(
	"票据被立即作废且未调用模型（待批数归 {int}，外发邮件数仍为 {int}）",
	async function (this: JeheeWorld, expectedPending: number, expectedMailSent: number) {
		assert.ok(this.host);
		assert.equal(this.faux.state.callCount, modelCallsBeforeCancel);
		assert.equal((await this.host.listPendingApprovals(this.ctx)).length, expectedPending);
		assert.equal(govPaleEnv.snapshot().mailSentIds.length, expectedMailSent);
		assert.ok(callbackToasts.some((t) => t.includes("已取消")));
	},
);

When(
	"主人重新发起发送草稿 {string} 并在网关后台批准后不立即续跑，随后重启 SQLite 宿主进程",
	async function (this: JeheeWorld, _draftId: string) {
		assert.ok(this.host && this.gateway && this.sqlitePath);
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId: "chat-504",
				senderId: "tg-owner-1",
				messageId: "m-retrigger-send",
				text: "重新请求发送草稿",
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		const pending = await this.host.listPendingApprovals(this.ctx);
		assert.equal(pending.length, 1);
		const approvedRes = await this.host.resolveApproval(
			{ ticketId: pending[0]!.id, decision: "approve", resumeOnApprove: false },
			this.ctx,
		);
		assert.equal(approvedRes.kind, "approved");

		this.gateway.dispose();
		await this.host.close(this.ctx);

		const postRestartApprovedRouter: FauxResponseStep = (ctx) => {
			if (ctx.messages.at(-1)?.role === "user") {
				return fauxAssistantMessage(
					[
						fauxToolCall("mcp__mail__mail_send", {
							id: "msg-draft-1",
							expected_version: { epoch: 1, revision: 0 },
							request_id: "send-after-restart-approved",
						}),
					],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("持久化已批准票据已在重启后自动放行完成发信。");
		};
		this.faux.setResponses([postRestartApprovedRouter, postRestartApprovedRouter]);

		this.host = await openNodeJeheeHost(
			{
				sqlitePath: this.sqlitePath,
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				mcp: {
					servers: [govPaleEnv.mailSpec, govPaleEnv.calendarSpec],
					exposure: "eager",
					writeGate: {
						mode: "confirm-writes",
						exemptTools: ["calendar/calendar.import_ics"],
					},
				},
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({ host: this.host, allowFrom: { telegram: ["tg-owner-1"] } });
		attachMockTelegram(this.gateway);
	},
);

When("重启后主人在会话 {string} 发送 {string}", async function (this: JeheeWorld, chatId: string, text: string) {
	assert.ok(this.gateway);
	await this.gateway.ingest(
		{
			channel: "telegram",
			chatId,
			senderId: "tg-owner-1",
			messageId: "m-post-restart-continue",
			text,
			timestampMs: Date.now(),
		},
		this.ctx,
	);
});

Then(
	"持久化在 SQLite 中的已批准票据跨越重启自动放行并消费，邮件 {string} 成功发出（外发邮件数为 {int}）",
	(expectedMailId: string, expectedSent: number) => {
		const snap = govPaleEnv.snapshot();
		assert.equal(snap.mailSentIds.length, expectedSent);
		assert.equal(snap.mailSentIds[0], expectedMailId);
	},
);

Given(
	"已启动挂载可控慢工具 {string} 与 {int} 秒冷却窗口的渠道网关（授权主人 {string}）",
	async function (this: JeheeWorld, slowToolName: string, cooldownSec: number, ownerId: string) {
		tgCaptured = [];
		fakeClockMs = Date.parse("2026-11-18T04:00:00Z"); // 12:00 Beijing time (daytime)
		let markEntered!: () => void;
		this.toolEntered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			this.releaseSlowTool = resolve;
		});
		const slowTool = defineTool({
			name: slowToolName,
			description: "Slow foreground tool for testing busy_yield",
			parameters: obj({}),
			execute: async (_args, _api, toolCtx) => {
				markEntered();
				await awaitWithContext(gate, toolCtx);
				return { output: [{ type: "text", text: "slow task done" }] };
			},
		});
		this.customExtensions = [defineExtension({ name: `test.gov-slow.${slowToolName}`, tools: [slowTool] })];
		this.faux.setResponses([
			fauxAssistantMessage([fauxToolCall(slowToolName, {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("前台慢任务已结束。"),
		]);

		this.host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				extensions: this.customExtensions,
				now: () => fakeClockMs,
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
			quietPolicy: { minIntervalMs: cooldownSec * 1000, yieldWhenBusy: true },
			now: () => fakeClockMs,
		});
		attachMockTelegram(this.gateway);
	},
);

let pendingForegroundTurn!: Promise<unknown>;

When(
	"主人先在会话 {string} 触发慢工具执行，在主会话忙碌期间后台尝试推送 {string}",
	async function (this: JeheeWorld, chatId: string, proactiveText: string) {
		assert.ok(this.gateway && this.toolEntered);
		slowBusyBaselineTgCount = tgCaptured.length;
		const admitted = await this.gateway.admit(
			{
				channel: "telegram",
				chatId,
				senderId: "tg-owner-1",
				messageId: "m-slow-start",
				text: "跑一个慢任务",
				timestampMs: fakeClockMs,
			},
			this.ctx,
		);
		pendingForegroundTurn = admitted.settled;
		await this.toolEntered;

		await this.gateway.pushMessage({ channel: "telegram", chatId }, proactiveText);
	},
);

Then(
	"该推送因忙时让路被暂存（Telegram 当前未打扰，暂存数为 {int}）",
	function (this: JeheeWorld, expectedHeld: number) {
		assert.ok(this.gateway);
		assert.equal(tgCaptured.length, slowBusyBaselineTgCount);
		assert.equal(this.gateway.heldProactiveCount, expectedHeld);
	},
);

When("释放慢工具完成前台回合后，主人主动发送 {string}", async function (this: JeheeWorld, flushCmd: string) {
	assert.ok(this.releaseSlowTool && this.gateway);
	this.releaseSlowTool();
	this.releaseSlowTool = undefined;
	await pendingForegroundTurn;
	await this.gateway.drain();
	baselineTgCount = tgCaptured.length;
	await this.gateway.ingest(
		{
			channel: "telegram",
			chatId: "chat-505",
			senderId: "tg-owner-1",
			messageId: "m-flush-busy",
			text: flushCmd,
			timestampMs: fakeClockMs,
		},
		this.ctx,
	);
});

Then(
	"Telegram 会话 {string} 立即收到包含 {string} 的补发通知（暂存数归 {int}）",
	function (this: JeheeWorld, chatId: string, expectedText: string, expectedHeld: number) {
		assert.ok(this.gateway);
		const newlySent = tgCaptured.slice(baselineTgCount).filter((m) => m.chatId === chatId);
		assert.ok(
			newlySent.some((m) => m.text.includes(expectedText)),
			`Missing "${expectedText}" in ${JSON.stringify(newlySent)}`,
		);
		assert.equal(this.gateway.heldProactiveCount, expectedHeld);
	},
);

When(
	"冷却窗口内 {int} 秒后后台再次主动推送 {string}",
	async function (this: JeheeWorld, deltaSec: number, text: string) {
		assert.ok(this.gateway);
		fakeClockMs += deltaSec * 1000;
		baselineTgCount = tgCaptured.length;
		await this.gateway.pushMessage({ channel: "telegram", chatId: "chat-505" }, text);
	},
);

Then(
	"该推送因频控冷却被暂存（暂存数为 {int}），再次发送 {string} 后立即收到 {string}（暂存数归 {int}）",
	async function (this: JeheeWorld, heldBefore: number, flushCmd: string, expectedText: string, heldAfter: number) {
		assert.ok(this.gateway);
		assert.equal(tgCaptured.length, baselineTgCount);
		assert.equal(this.gateway.heldProactiveCount, heldBefore);

		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId: "chat-505",
				senderId: "tg-owner-1",
				messageId: "m-flush-cooldown",
				text: flushCmd,
				timestampMs: fakeClockMs,
			},
			this.ctx,
		);
		const newlySent = tgCaptured.slice(baselineTgCount);
		assert.ok(newlySent.some((m) => m.text.includes(expectedText)));
		assert.equal(this.gateway.heldProactiveCount, heldAfter);
	},
);
