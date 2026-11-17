// Cucumber step definitions for ChannelGateway, Telegram Webhook security/chunking, debouncing, Staging lock, and seamless QQ switch.

import assert from "node:assert/strict";
import { type DataTable, Given, Then, When } from "@cucumber/cucumber";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ChannelTransport } from "../../src/channels/contract.ts";
import { ChannelGateway } from "../../src/channels/gateway.ts";
import { handleTelegramWebhook, TELEGRAM_MAX_MESSAGE_LENGTH, TelegramTransport } from "../../src/channels/telegram.ts";
import type { JeheeWorld } from "../support/world.ts";

let generatedLongReport = "";
let pendingCoalescePromises: Array<Promise<unknown>> = [];
let telegramCountBeforeQQ = 0;

function createMockTelegramTransport(world: JeheeWorld): TelegramTransport {
	const mockFetch: typeof fetch = async (input, init) => {
		const url = String(input);
		if (url.endsWith("/sendMessage") && init?.body !== undefined) {
			const parsed = JSON.parse(String(init.body)) as { chat_id: string; text: string };
			world.telegramSent.push({ chatId: String(parsed.chat_id), text: parsed.text });
		}
		return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
	};
	return new TelegramTransport({
		botToken: "test-token",
		fetchImpl: mockFetch,
	});
}

function createMockQQTransport(world: JeheeWorld): ChannelTransport {
	return {
		channel: "qq",
		sendText: async (chatId, text) => {
			world.qqSent.push({ chatId, text });
		},
	};
}

Given(
	"Jehee 渠道网关已启动并绑定 Telegram 适配器（白名单用户 {string}，Webhook 密钥 {string}）",
	async function (this: JeheeWorld, ownerId: string, secret: string) {
		const host = await this.openHost("memory");
		this.webhookSecret = secret;
		this.gateway = new ChannelGateway({
			host,
			allowFrom: { telegram: [ownerId] },
		});
		this.gateway.registerTransport(createMockTelegramTransport(this));
	},
);

Given("预设模型将返回一段长度为 {int} 字符的长篇报告", function (this: JeheeWorld, totalLength: number) {
	const line = "这是一段用于测试 Telegram 自动分片能力的详细技术段落。\n";
	generatedLongReport = line.repeat(Math.ceil(totalLength / line.length)).slice(0, totalLength);
	this.installScriptedSteps([fauxAssistantMessage(generatedLongReport)]);
});

When("收到携带错误密钥 {string} 的 Telegram Webhook 请求", async function (this: JeheeWorld, badSecret: string) {
	assert.ok(this.gateway);
	const req = new Request("https://jehee.example/webhook/telegram", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-telegram-bot-api-secret-token": badSecret,
		},
		body: JSON.stringify({
			update_id: 1,
			message: {
				message_id: 10,
				from: { id: "tg-owner-1" },
				chat: { id: "chat-100", type: "private" },
				text: "hello",
			},
		}),
	});
	this.lastWebhookResponse = await handleTelegramWebhook(
		req,
		{ gateway: this.gateway, secretToken: this.webhookSecret },
		this.ctx,
	);
});

Then(
	"Webhook 返回 HTTP 状态码 {int} 且底层模型调用次数为 {int}",
	function (this: JeheeWorld, expectedStatus: number, expectedCalls: number) {
		assert.ok(this.lastWebhookResponse);
		assert.equal(this.lastWebhookResponse.status, expectedStatus);
		assert.equal(this.faux.state.callCount, expectedCalls);
	},
);

When(
	"收到未授权陌生人 {string} 发来的合法签名 Telegram Webhook 消息 {string}",
	async function (this: JeheeWorld, strangerId: string, text: string) {
		assert.ok(this.gateway);
		const req = new Request("https://jehee.example/webhook/telegram", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-telegram-bot-api-secret-token": this.webhookSecret ?? "",
			},
			body: JSON.stringify({
				update_id: 2,
				message: {
					message_id: 11,
					from: { id: strangerId },
					chat: { id: "stranger-chat", type: "private" },
					text,
				},
			}),
		});
		this.lastWebhookResponse = await handleTelegramWebhook(
			req,
			{ gateway: this.gateway, secretToken: this.webhookSecret },
			this.ctx,
		);
	},
);

Then(
	"Webhook 返回 HTTP 状态码 {int} 但不产生任何出站消息且底层模型调用次数为 {int}",
	function (this: JeheeWorld, expectedStatus: number, expectedCalls: number) {
		assert.ok(this.lastWebhookResponse);
		assert.equal(this.lastWebhookResponse.status, expectedStatus);
		assert.equal(this.telegramSent.length, 0);
		assert.equal(this.faux.state.callCount, expectedCalls);
	},
);

When(
	"收到主人 {string} 在会话 {string} 发来的合法签名 Telegram Webhook 消息 {string}",
	async function (this: JeheeWorld, ownerId: string, chatId: string, text: string) {
		assert.ok(this.gateway);
		const req = new Request("https://jehee.example/webhook/telegram", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-telegram-bot-api-secret-token": this.webhookSecret ?? "",
			},
			body: JSON.stringify({
				update_id: 3,
				message: {
					message_id: 12,
					from: { id: ownerId },
					chat: { id: chatId, type: "private" },
					text,
				},
			}),
		});
		this.lastWebhookResponse = await handleTelegramWebhook(
			req,
			{ gateway: this.gateway, secretToken: this.webhookSecret },
			this.ctx,
		);
	},
);

Then(
	"Telegram 出站接口向会话 {string} 依次分 {int} 片发送了完整报告（每片均不超过 4096 字符）",
	function (this: JeheeWorld, expectedChatId: string, expectedChunks: number) {
		const chunks = this.telegramSent.filter((item) => item.chatId === expectedChatId);
		assert.equal(chunks.length, expectedChunks);
		for (const chunk of chunks) {
			assert.ok(chunk.text.length <= TELEGRAM_MAX_MESSAGE_LENGTH);
		}
		assert.equal(chunks.map((c) => c.text).join(""), generatedLongReport);
	},
);

Given(
	"Jehee 渠道网关已启动（防抖合并窗口 {int} 毫秒）并绑定 Telegram 白名单用户 {string}",
	async function (this: JeheeWorld, debounceMs: number, ownerId: string) {
		const host = await this.openHost("memory");
		this.gateway = new ChannelGateway({
			host,
			allowFrom: { telegram: [ownerId] },
			debounceMs,
		});
		this.gateway.registerTransport(createMockTelegramTransport(this));
		pendingCoalescePromises = [];
	},
);

When(
	"主人 {string} 在会话 {string} 连续快速发送两条 Telegram 消息:",
	function (this: JeheeWorld, ownerId: string, chatId: string, table: DataTable) {
		assert.ok(this.gateway);
		const rows = table.hashes();
		pendingCoalescePromises = rows.map((row, index) =>
			this.gateway!.ingest(
				{
					channel: "telegram",
					chatId,
					senderId: ownerId,
					messageId: row.messageId ?? `m-${index}`,
					text: row.text ?? "",
					timestampMs: Date.now() + index,
				},
				this.ctx,
			),
		);
	},
);

Then(
	"等待防抖窗口结算后 Telegram 会话 {string} 收到 {int} 条回复 {string}",
	async function (this: JeheeWorld, chatId: string, expectedCount: number, expectedReply: string) {
		await Promise.all(pendingCoalescePromises);
		const sent = this.telegramSent.filter((item) => item.chatId === chatId);
		assert.equal(sent.length, expectedCount);
		assert.equal(sent[0]?.text, expectedReply);
	},
);

Then(
	"底层模型实际只被调用了 {int} 次，且收到的用户消息合并包含了 {string} 与 {string}",
	function (this: JeheeWorld, expectedCalls: number, partA: string, partB: string) {
		assert.equal(this.faux.state.callCount, expectedCalls);
		const texts = this.latestRequestUserTexts();
		assert.ok(texts.some((t) => t.includes(partA) && t.includes(partB)));
	},
);

Given(
	"Jehee 渠道网关以 Staging 保护模式启动（仅允许发往 {string}）",
	async function (this: JeheeWorld, allowedRoute: string) {
		const host = await this.openHost("memory");
		this.gateway = new ChannelGateway({
			host,
			allowFrom: { telegram: ["tg-owner-1"] },
			stagingAllowedRoutes: [allowedRoute],
		});
		this.gateway.registerTransport(createMockTelegramTransport(this));
	},
);

When(
	"主人 {string} 在受保护的测试会话 {string} 发送 {string}",
	async function (this: JeheeWorld, ownerId: string, chatId: string, text: string) {
		assert.ok(this.gateway);
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId,
				senderId: ownerId,
				messageId: "cmd-1",
				text,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
	},
);

Then(
	"Telegram 会话 {string} 收到包含 {string} 的状态回执且底层模型调用次数为 {int}",
	function (this: JeheeWorld, chatId: string, expectedSnippet: string, expectedCalls: number) {
		const sent = this.telegramSent.filter((item) => item.chatId === chatId);
		assert.equal(sent.length, 1);
		assert.ok(sent[0]?.text.includes(expectedSnippet));
		assert.equal(this.faux.state.callCount, expectedCalls);
	},
);

When(
	"系统尝试向未列入 Staging 允许名单的生产会话 {string} 主动推送消息 {string}",
	async function (this: JeheeWorld, routeSpec: string, text: string) {
		assert.ok(this.gateway);
		const [channel = "telegram", chatId = ""] = routeSpec.split(":");
		await this.gateway.pushMessage({ channel, chatId }, text);
	},
);

Then("该推送被 Staging 发送保护锁拦截，会话 {string} 收不到任何消息", function (this: JeheeWorld, prodChatId: string) {
	assert.ok(this.gateway);
	assert.equal(this.gateway.blockedStagingDeliveries, 1);
	assert.equal(this.telegramSent.filter((item) => item.chatId === prodChatId).length, 0);
});

Given(
	"Jehee 渠道网关同时授权了 Telegram 主人 {string} 与 QQ 主人 {string}",
	async function (this: JeheeWorld, tgOwner: string, qqOwner: string) {
		const host = await this.openHost("memory");
		this.gateway = new ChannelGateway({
			host,
			allowFrom: {
				telegram: [tgOwner],
				qq: [qqOwner],
			},
		});
		this.gateway.registerTransport(createMockTelegramTransport(this));
		this.gateway.registerTransport(createMockQQTransport(this));
	},
);

When(
	"主人 {string} 通过 Telegram 会话 {string} 发送消息 {string}",
	async function (this: JeheeWorld, senderId: string, chatId: string, text: string) {
		assert.ok(this.gateway);
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId,
				senderId,
				messageId: "tg-m-1",
				text,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
	},
);

Then(
	"Telegram 会话 {string} 收到回复 {string}，而 QQ 未收到任何消息",
	function (this: JeheeWorld, tgChatId: string, expectedReply: string) {
		const tgMsgs = this.telegramSent.filter((item) => item.chatId === tgChatId);
		assert.equal(tgMsgs.length, 1);
		assert.equal(tgMsgs[0]?.text, expectedReply);
		assert.equal(this.qqSent.length, 0);
		telegramCountBeforeQQ = this.telegramSent.length;
	},
);

When(
	"主人 {string} 随后切到 QQ 会话 {string} 发送消息 {string}",
	async function (this: JeheeWorld, senderId: string, chatId: string, text: string) {
		assert.ok(this.gateway);
		await this.gateway.ingest(
			{
				channel: "qq",
				chatId,
				senderId,
				messageId: "qq-m-1",
				text,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
	},
);

Then(
	"QQ 会话 {string} 收到回复 {string}，而 Telegram 未收到新消息",
	function (this: JeheeWorld, qqChatId: string, expectedReply: string) {
		const qqMsgs = this.qqSent.filter((item) => item.chatId === qqChatId);
		assert.equal(qqMsgs.length, 1);
		assert.equal(qqMsgs[0]?.text, expectedReply);
		assert.equal(this.telegramSent.length, telegramCountBeforeQQ);
	},
);

Then(
	"最后一次发往模型的上下文同时包含之前的 {string} 与当前的 {string}",
	function (this: JeheeWorld, earlierText: string, currentText: string) {
		const userTexts = this.latestRequestUserTexts();
		assert.ok(userTexts.includes(earlierText));
		assert.ok(userTexts.includes(currentText));
	},
);
