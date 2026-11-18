// Unit tests for pure Telegram webhook verification, update parsing, 4096-character chunking,
// AbortSignal propagation in polling, and `/stop` cancellation of pending debounce buckets.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	ChannelGateway,
	JeheeHost,
	parseTelegramUpdate,
	pollTelegramUpdatesOnce,
	splitTelegramText,
	verifyTelegramSecretToken,
} from "../src/index.ts";

describe("telegram channel helpers", () => {
	it("verifies webhook secret tokens in constant time", () => {
		assert.equal(verifyTelegramSecretToken(undefined, null), true);
		assert.equal(verifyTelegramSecretToken("s3cr3t", "s3cr3t"), true);
		assert.equal(verifyTelegramSecretToken("s3cr3t", "wrong!"), false);
		assert.equal(verifyTelegramSecretToken("s3cr3t", "short"), false);
		assert.equal(verifyTelegramSecretToken("s3cr3t", null), false);
	});

	it("splits oversized messages cleanly along paragraph boundaries", () => {
		const p1 = "A".repeat(70);
		const p2 = "B".repeat(70);
		const combined = `${p1}\n\n${p2}`;
		const parts = splitTelegramText(combined, 100);
		assert.equal(parts.length, 2);
		assert.equal(parts[0], `${p1}\n\n`);
		assert.equal(parts[1], p2);
	});

	it("parses text and caption updates and ignores empty updates", () => {
		assert.equal(parseTelegramUpdate({ update_id: 1 }), undefined);
		const parsed = parseTelegramUpdate({
			update_id: 2,
			message: {
				message_id: 42,
				date: 1700000000,
				from: { id: 998877 },
				chat: { id: 998877, type: "private" },
				text: "ping",
			},
		});
		assert.deepEqual(parsed, {
			channel: "telegram",
			chatId: "998877",
			senderId: "998877",
			messageId: "42",
			text: "ping",
			timestampMs: 1700000000000,
		});
	});

	it("cancels pending debounced messages without calling the model when /stop arrives inside the debounce window", async () => {
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("should never run")]);
		const models = createModels();
		models.setProvider(faux.provider);

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
			},
			BACKGROUND_CONTEXT,
		);
		const outbound: string[] = [];
		const gateway = new ChannelGateway({
			host,
			allowFrom: { telegram: ["owner-1"] },
			debounceMs: 200,
		});
		gateway.registerTransport({
			channel: "telegram",
			sendText: async (_chatId, text) => {
				outbound.push(text);
			},
		});

		try {
			const firstAdmitted = await gateway.admit(
				{
					channel: "telegram",
					chatId: "chat-1",
					senderId: "owner-1",
					messageId: "1",
					text: "误发的一条重任务",
					timestampMs: Date.now(),
				},
				BACKGROUND_CONTEXT,
			);
			const stopOutcome = await gateway.ingest(
				{
					channel: "telegram",
					chatId: "chat-1",
					senderId: "owner-1",
					messageId: "2",
					text: "/stop",
					timestampMs: Date.now() + 5,
				},
				BACKGROUND_CONTEXT,
			);
			const firstSettled = await firstAdmitted.settled;
			await gateway.drain();

			assert.deepEqual(stopOutcome, { kind: "command_handled", command: "stop" });
			assert.deepEqual(firstSettled, { kind: "unanswered", reason: "aborted" });
			assert.equal(faux.state.callCount, 0);
			assert.deepEqual(outbound, ["已停止当前在途任务。"]);
		} finally {
			gateway.dispose();
			await host.close(BACKGROUND_CONTEXT);
			await gateway.drain();
		}
	});

	it("forwards AbortSignal to getUpdates fetch so Ctrl+C interrupts long-polling immediately", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
			},
			BACKGROUND_CONTEXT,
		);
		const gateway = new ChannelGateway({ host, allowFrom: { telegram: ["owner-1"] } });
		const controller = new AbortController();
		controller.abort();

		try {
			await assert.rejects(
				() =>
					pollTelegramUpdatesOnce(
						{
							botToken: "tok",
							gateway,
							signal: controller.signal,
							fetchImpl: (_url, init) => {
								if (init?.signal?.aborted) {
									return Promise.reject(new DOMException("Aborted", "AbortError"));
								}
								return Promise.resolve(new Response(JSON.stringify({ ok: true, result: [] })));
							},
						},
						BACKGROUND_CONTEXT,
					),
				(err: unknown) => err instanceof DOMException && err.name === "AbortError",
			);
		} finally {
			gateway.dispose();
			await host.close(BACKGROUND_CONTEXT);
		}
	});
});
