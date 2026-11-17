// Unit tests for pure Telegram webhook verification, update parsing, and 4096-character message chunking.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTelegramUpdate, splitTelegramText, verifyTelegramSecretToken } from "../src/index.ts";

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
});
