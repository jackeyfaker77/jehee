// Cucumber step definitions verifying durable write-confirmation tickets, Telegram inline callback approval,
// intent-digest anti-tampering, SQLite restart persistence, stranger rejection, and proactive quiet-hours governance.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
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
