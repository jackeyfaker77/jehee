// Unit tests for pure memory text extraction and baseline StaticCoreMemoryProvider boundaries.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractAssistantText, extractUserText, StaticCoreMemoryProvider } from "../src/index.ts";

describe("memory contract helpers", () => {
	it("extracts text from string and multipart user messages", () => {
		assert.equal(extractUserText({ role: "user", content: "hello", timestamp: 1 }), "hello");
		assert.equal(
			extractUserText({
				role: "user",
				content: [
					{ type: "text", text: "part-1 " },
					{ type: "image", data: "abc", mimeType: "image/png" },
					{ type: "text", text: "part-2" },
				],
				timestamp: 2,
			}),
			"part-1 part-2",
		);
	});

	it("extracts only text blocks from assistant messages with thinking or tool calls", () => {
		const text = extractAssistantText({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "internal chain" },
				{ type: "text", text: "visible " },
				{ type: "toolCall", id: "c1", name: "bash", arguments: {} },
				{ type: "text", text: "answer" },
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-test",
			stopReason: "stop",
			timestamp: 3,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		assert.equal(text, "visible answer");
	});

	it("omits blank core prompts so empty memory does not pollute prompt sections", () => {
		const blank = new StaticCoreMemoryProvider({ corePrompt: "   \n  " });
		assert.equal(blank.renderCorePrompt(), undefined);
	});
});
