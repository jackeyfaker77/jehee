// Unit tests for write-approval intent digests, pattern matching, quiet-hours calculation, proactive governor, and Telegram inline callbacks.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	ChannelGateway,
	computeWriteIntentDigest,
	isSilentReplyText,
	isWithinQuietHours,
	JeheeHost,
	ProactiveNotificationGovernor,
	parseQuietHoursWindow,
	parseTelegramCallback,
	parseUtcOffsetMinutes,
	requiresWriteApproval,
	TelegramTransport,
} from "../src/index.ts";
import { createMockPaleEnvironment } from "./fixtures/pale-mcp-fixture.ts";

describe("write-approval intent digests and pattern rules", () => {
	it("produces identical digests across varying request_id and expected_version, but distinct digests when business args change", () => {
		const d1 = computeWriteIntentDigest("mail", "mail.send", {
			id: "msg-draft-1",
			expected_version: { epoch: 1, revision: 0 },
			request_id: "req-1",
		});
		const d2 = computeWriteIntentDigest("mail", "mail.send", {
			request_id: "req-retry-2",
			expected_version: { epoch: 1, revision: 3 },
			id: "msg-draft-1",
		});
		assert.equal(d1, d2);

		const tampered = computeWriteIntentDigest("mail", "mail.send", {
			id: "msg-draft-2",
			expected_version: { epoch: 1, revision: 0 },
			request_id: "req-1",
		});
		assert.notEqual(d1, tampered);
	});

	it("evaluates exemptTools and matchTools patterns accurately", () => {
		const policy = {
			mode: "confirm-writes" as const,
			exemptTools: ["calendar/calendar.import_ics", "notes/*"],
		};
		assert.equal(requiresWriteApproval(policy, "mail", "mail.send"), true);
		assert.equal(requiresWriteApproval(policy, "calendar", "calendar.import_ics"), false);
		assert.equal(requiresWriteApproval(policy, "calendar", "calendar.attachment.add"), true);
		assert.equal(requiresWriteApproval(policy, "notes", "notes.create"), false);
		assert.equal(requiresWriteApproval({ mode: "off" }, "mail", "mail.send"), false);
	});
});

describe("proactive quiet-hours and notification governor", () => {
	it("handles overnight (23:00-08:00) and daytime quiet windows with UTC offsets", () => {
		assert.equal(parseUtcOffsetMinutes("+08:00"), 480);
		assert.equal(parseUtcOffsetMinutes("-05:30"), -330);
		assert.equal(parseUtcOffsetMinutes("UTC"), 0);

		const overnight = parseQuietHoursWindow("23:00-08:00", "+08:00");
		// 2026-11-18T15:30:00Z == 23:30:00+08:00 -> inside quiet hours
		assert.equal(isWithinQuietHours(Date.parse("2026-11-18T15:30:00Z"), overnight), true);
		// 2026-11-18T23:59:00Z == 07:59:00+08:00 -> inside quiet hours
		assert.equal(isWithinQuietHours(Date.parse("2026-11-18T23:59:00Z"), overnight), true);
		// 2026-11-19T00:00:00Z == 08:00:00+08:00 -> outside quiet hours (exclusive end)
		assert.equal(isWithinQuietHours(Date.parse("2026-11-19T00:00:00Z"), overnight), false);
		// 2026-11-18T06:00:00Z == 14:00:00+08:00 -> outside quiet hours
		assert.equal(isWithinQuietHours(Date.parse("2026-11-18T06:00:00Z"), overnight), false);

		const lunch = parseQuietHoursWindow("12:30-14:00", "+08:00");
		assert.equal(isWithinQuietHours(Date.parse("2026-11-18T05:00:00Z"), lunch), true); // 13:00+08:00
		assert.equal(isWithinQuietHours(Date.parse("2026-11-18T06:00:00Z"), lunch), false); // 14:00+08:00
	});

	it("drops [SILENT], holds on quiet/busy/cooldown, bypasses urgent, and formats digests", () => {
		assert.equal(isSilentReplyText("[SILENT]"), true);
		assert.equal(isSilentReplyText("   "), true);
		assert.equal(isSilentReplyText("Build succeeded"), false);

		const gov = new ProactiveNotificationGovernor({
			quietHours: parseQuietHoursWindow("23:00-08:00", "+08:00"),
			minIntervalMs: 30_000,
		});
		const route = { channel: "telegram", chatId: "chat-1" };
		const nightMs = Date.parse("2026-11-18T16:00:00Z"); // 00:00+08:00
		const dayMs = Date.parse("2026-11-18T04:00:00Z"); // 12:00+08:00

		assert.equal(gov.evaluate({ route, text: "[SILENT]", isBusy: false, nowMs: nightMs }).action, "drop_silent");
		assert.equal(gov.heldCount, 0);

		const heldNight = gov.evaluate({ route, text: "工坊任务 A 已完成", isBusy: false, nowMs: nightMs });
		assert.equal(heldNight.action, "hold");
		if (heldNight.action === "hold") assert.equal(heldNight.reason, "quiet_hours");

		// Urgent approval prompts bypass quiet hours.
		const urgentNight = gov.evaluate({
			route,
			text: "[待确认写操作]",
			urgency: "urgent",
			isBusy: true,
			nowMs: nightMs,
		});
		assert.equal(urgentNight.action, "deliver");
		assert.equal(gov.heldCount, 1);

		// Busy foreground yield during daytime.
		const heldBusy = gov.evaluate({ route, text: "工坊任务 B 已完成", isBusy: true, nowMs: dayMs });
		assert.equal(heldBusy.action, "hold");
		if (heldBusy.action === "hold") assert.equal(heldBusy.reason, "busy_yield");

		// Normal daytime delivery + cooldown hold on rapid second push.
		assert.equal(gov.evaluate({ route, text: "工坊任务 C 已完成", isBusy: false, nowMs: dayMs }).action, "deliver");
		gov.recordDelivered(route, dayMs);

		const heldCooldown = gov.evaluate({
			route,
			text: "工坊任务 D 已完成",
			isBusy: false,
			nowMs: dayMs + 5_000,
		});
		assert.equal(heldCooldown.action, "hold");
		if (heldCooldown.action === "hold") assert.equal(heldCooldown.reason, "rate_cooldown");

		const batches = gov.drainHeld(route);
		assert.equal(batches.length, 1);
		assert.equal(batches[0]?.count, 3);
		assert.ok(batches[0]?.digestText.includes("共 3 条"));
		assert.equal(gov.heldCount, 0);
	});
});

describe("Telegram inline keyboard and callback_query helpers", () => {
	it("parses callback_query updates and attaches inline_keyboard + answerCallbackQuery", async () => {
		const cb = parseTelegramCallback({
			update_id: 901,
			callback_query: {
				id: "cb-77",
				from: { id: 10001 },
				message: { message_id: 55, chat: { id: 20002, type: "private" } },
				data: "apv:ok:apv_1_abcdef",
			},
		});
		assert.deepEqual(
			cb && {
				channel: cb.channel,
				chatId: cb.chatId,
				senderId: cb.senderId,
				callbackId: cb.callbackId,
				messageId: cb.messageId,
				data: cb.data,
			},
			{
				channel: "telegram",
				chatId: "20002",
				senderId: "10001",
				callbackId: "cb-77",
				messageId: "55",
				data: "apv:ok:apv_1_abcdef",
			},
		);

		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		const transport = new TelegramTransport({
			botToken: "tok",
			fetchImpl: async (input, init) => {
				calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
				return new Response(JSON.stringify({ ok: true }));
			},
		});

		await transport.sendText("20002", "确认卡片", {
			buttons: [[{ label: "确认执行", callbackData: "apv:ok:apv_1" }]],
		});
		await transport.answerCallback("cb-77", "已批准");

		assert.equal(calls.length, 2);
		assert.ok(calls[0]?.url.endsWith("/sendMessage"));
		assert.deepEqual(calls[0]?.body.reply_markup, {
			inline_keyboard: [[{ text: "确认执行", callback_data: "apv:ok:apv_1" }]],
		});
		assert.ok(calls[1]?.url.endsWith("/answerCallbackQuery"));
		assert.equal(calls[1]?.body.callback_query_id, "cb-77");
		assert.equal(calls[1]?.body.text, "已批准");
	});
});

describe("ChannelGateway approval disambiguation, /reject, and /flush commands", () => {
	it("handles ambiguous pending tickets, explicit /approve <id>, /reject without model calls, and empty /flush", async () => {
		const paleEnv = createMockPaleEnvironment({ distractorServerCount: 0 });
		const faux = fauxProvider();
		faux.setResponses([
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall("mcp__mail__mail_send", {
							id: "msg-draft-1",
							expected_version: { epoch: 1, revision: 0 },
							request_id: "r1",
						}),
						fauxToolCall("mcp__mail__mail_send", {
							id: "msg-draft-2",
							expected_version: { epoch: 1, revision: 0 },
							request_id: "r2",
						}),
					],
					{ stopReason: "toolUse" },
				),
			() => fauxAssistantMessage("两项发信均已排队待确认。"),
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall("mcp__mail__mail_send", {
							id: "msg-draft-1",
							expected_version: { epoch: 1, revision: 0 },
							request_id: "r1-exec",
						}),
					],
					{ stopReason: "toolUse" },
				),
			() => fauxAssistantMessage("已发送 msg-draft-1。"),
		]);
		const models = createModels();
		models.setProvider(faux.provider);

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				mcp: {
					servers: [paleEnv.mailSpec],
					exposure: "eager",
					writeGate: { mode: "confirm-writes" },
				},
			},
			BACKGROUND_CONTEXT,
		);
		const outbound: string[] = [];
		const gateway = new ChannelGateway({
			host,
			allowFrom: { telegram: ["owner-1"] },
		});
		gateway.registerTransport({
			channel: "telegram",
			sendText: async (_chatId, text) => {
				outbound.push(text);
			},
		});

		try {
			await gateway.ingest(
				{
					channel: "telegram",
					chatId: "chat-gov-unit",
					senderId: "owner-1",
					messageId: "m-1",
					text: "发两封邮件",
					timestampMs: Date.now(),
				},
				BACKGROUND_CONTEXT,
			);
			const pending = await host.listPendingApprovals(BACKGROUND_CONTEXT);
			assert.equal(pending.length, 2);
			const callsBeforeCommands = faux.state.callCount;

			// Ambiguous `/approve` without ID prompts for explicit ticket ID with zero model calls.
			await gateway.ingest(
				{
					channel: "telegram",
					chatId: "chat-gov-unit",
					senderId: "owner-1",
					messageId: "m-ambig",
					text: "/approve",
					timestampMs: Date.now(),
				},
				BACKGROUND_CONTEXT,
			);
			assert.equal(faux.state.callCount, callsBeforeCommands);
			assert.ok(outbound.at(-1)?.includes("请指定编号"));

			// `/reject <secondId>` cancels the second ticket with zero model calls.
			const secondId = pending[1]!.id;
			await gateway.ingest(
				{
					channel: "telegram",
					chatId: "chat-gov-unit",
					senderId: "owner-1",
					messageId: "m-reject",
					text: `/reject ${secondId}`,
					timestampMs: Date.now(),
				},
				BACKGROUND_CONTEXT,
			);
			assert.equal(faux.state.callCount, callsBeforeCommands);
			assert.ok(outbound.at(-1)?.includes(`已取消待确认写操作 ${secondId}`));
			assert.equal((await host.listPendingApprovals(BACKGROUND_CONTEXT)).length, 1);

			// `/approve` now resolves the sole remaining ticket and sends msg-draft-1.
			await gateway.ingest(
				{
					channel: "telegram",
					chatId: "chat-gov-unit",
					senderId: "owner-1",
					messageId: "m-approve-rem",
					text: "/approve",
					timestampMs: Date.now(),
				},
				BACKGROUND_CONTEXT,
			);
			assert.deepEqual(paleEnv.snapshot().mailSentIds, ["msg-draft-1"]);

			// `/flush` with empty queue replies deterministically.
			await gateway.ingest(
				{
					channel: "telegram",
					chatId: "chat-gov-unit",
					senderId: "owner-1",
					messageId: "m-flush-empty",
					text: "/flush",
					timestampMs: Date.now(),
				},
				BACKGROUND_CONTEXT,
			);
			assert.ok(outbound.at(-1)?.includes("当前没有暂存通知"));
		} finally {
			gateway.dispose();
			await host.close(BACKGROUND_CONTEXT);
			await gateway.drain();
		}
	});
});
