// Unit and SQLite restart integration tests for persistent ring-buffer traces (`TraceDoc`) and `/trace` commands.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChannelGateway } from "../src/channels/gateway.ts";
import type { JeheeHost } from "../src/core/host.ts";
import { AtomicMemoryProvider } from "../src/memory/atomic-memory.ts";
import { MEMORY_SAVE_TOOL } from "../src/memory/bridge.ts";
import { openNodeJeheeHost } from "../src/runtime/node.ts";
import {
	appendPersistedTrace,
	createEmptyTraceStoreState,
	formatTraceDetailReply,
	formatTraceListReply,
} from "../src/telemetry/durable-store.ts";

describe("TraceDoc ring buffer and formatters", () => {
	it("evicts oldest traces past maxEntries while keeping monotonic IDs and renders list/detail replies", () => {
		const state = createEmptyTraceStoreState();
		for (let i = 1; i <= 5; i += 1) {
			appendPersistedTrace(
				state,
				{
					traceId: `trace-${i}`,
					recordedAtMs: 1_795_400_000_000 + i * 1_000,
					label: `第 ${i} 轮测试消息`,
					status: i === 4 ? "error" : "ok",
					llmTurns: 1,
					toolCalls: i % 2,
					mcpCalls: i === 4 ? 1 : 0,
					mcpErrors: i === 4 ? 1 : 0,
					prefillTokens: 500 + i * 10,
					outputTokens: 40,
					cacheHitRate: 0.5,
					costUsd: 0.00012,
					wallTimeMs: 320,
					renderedTree: `pi.durable.submit trace=${i}`,
				},
				3,
			);
		}

		assert.equal(state.seq, 5);
		assert.deepEqual(
			state.entries.map((e) => e.id),
			[3, 4, 5],
		);

		const listText = formatTraceListReply([...state.entries].reverse());
		assert.ok(listText.includes("#5 [ok]"));
		assert.ok(listText.includes("#4 [error]"));
		assert.ok(listText.includes("mcp=1(err=1)"));

		const detailText = formatTraceDetailReply(state.entries[1]);
		assert.ok(detailText.includes("[Trace #4] status=error"));
		assert.ok(detailText.includes("pi.durable.submit trace=4"));

		const missingText = formatTraceDetailReply(undefined, 99);
		assert.ok(missingText.includes("未找到编号为 #99"));
	});
});

describe("TraceDoc SQLite persistence and /trace gateway commands", () => {
	it("persists turn span trees across SQLite restart and serves /trace, /trace list, and /trace <id> with allowlist", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "jehee-trace-test-"));
		const sqlitePath = join(tempDir, "jehee.sqlite");
		let openHost: JeheeHost | undefined;

		try {
			const faux1 = fauxProvider();
			const models1 = createModels();
			models1.setProvider(faux1.provider);
			faux1.setResponses([
				() =>
					fauxAssistantMessage(
						[
							fauxToolCall(MEMORY_SAVE_TOOL, {
								kind: "fact",
								content: "周会固定在周四上午十点",
								keywords: ["周会", "周四"],
							}),
						],
						{ stopReason: "toolUse" },
					),
				() => fauxAssistantMessage("好的，已记住周会时间。"),
				() => fauxAssistantMessage("收到，第二轮正常回复。"),
			]);

			const host1 = await openNodeJeheeHost(
				{
					sqlitePath,
					models: models1,
					defaultModel: { provider: "faux", modelId: faux1.getModel().id },
					memory: new AtomicMemoryProvider(),
				},
				BACKGROUND_CONTEXT,
			);
			openHost = host1;

			await host1.sendMessage({ text: "记住周会固定在周四上午十点" }, BACKGROUND_CONTEXT);
			await host1.sendMessage({ text: "第二轮普通对话" }, BACKGROUND_CONTEXT);
			await host1.close(BACKGROUND_CONTEXT);
			openHost = undefined;

			// Reopen SQLite cleanly (simulating Cloudflare DO hibernation cold boot) and query via /trace commands.
			const faux2 = fauxProvider();
			const models2 = createModels();
			models2.setProvider(faux2.provider);
			const host2 = await openNodeJeheeHost(
				{
					sqlitePath,
					models: models2,
					defaultModel: { provider: "faux", modelId: faux2.getModel().id },
					memory: new AtomicMemoryProvider(),
				},
				BACKGROUND_CONTEXT,
			);
			openHost = host2;

			const replies: string[] = [];
			const gateway = new ChannelGateway({
				host: host2,
				allowFrom: { telegram: ["owner-1"] },
				debounceMs: 0,
			});
			gateway.registerTransport({
				channel: "telegram",
				sendText: async (_chatId, text) => {
					replies.push(text);
				},
			});

			// Unauthorized user cannot inspect traces.
			const unauth = await gateway.ingest(
				{
					channel: "telegram",
					chatId: "stranger-1",
					senderId: "stranger-1",
					messageId: "t-unauth",
					text: "/trace",
					timestampMs: Date.now(),
				},
				BACKGROUND_CONTEXT,
			);
			assert.equal(unauth.kind, "unauthorized");
			assert.equal(replies.length, 0);

			// `/trace list` returns newest first (#2, #1).
			const listRes = await gateway.ingest(
				{
					channel: "telegram",
					chatId: "owner-1",
					senderId: "owner-1",
					messageId: "t-list",
					text: "/trace list",
					timestampMs: Date.now(),
				},
				BACKGROUND_CONTEXT,
			);
			assert.deepEqual(listRes, { kind: "command_handled", command: "trace" });
			assert.ok(replies[0]?.includes("#2 [ok]"));
			assert.ok(replies[0]?.includes("#1 [ok]"));

			// `/trace` returns latest trace (#2).
			await gateway.ingest(
				{
					channel: "telegram",
					chatId: "owner-1",
					senderId: "owner-1",
					messageId: "t-latest",
					text: "/trace",
					timestampMs: Date.now(),
				},
				BACKGROUND_CONTEXT,
			);
			assert.ok(replies[1]?.includes("[Trace #2]"));
			assert.ok(replies[1]?.includes("pi.durable.submit"));
			assert.ok(replies[1]?.includes("pi.ai.request"));

			// `/trace #1` returns turn 1 including tool + memory span.
			await gateway.ingest(
				{
					channel: "telegram",
					chatId: "owner-1",
					senderId: "owner-1",
					messageId: "t-one",
					text: "/trace #1",
					timestampMs: Date.now(),
				},
				BACKGROUND_CONTEXT,
			);
			assert.ok(replies[2]?.includes("[Trace #1]"));
			assert.ok(replies[2]?.includes("tools=1"));
			assert.ok(replies[2]?.includes("jehee.memory.save"));

			gateway.dispose();
			await host2.close(BACKGROUND_CONTEXT);
			openHost = undefined;
		} finally {
			if (openHost !== undefined) {
				await openHost.close(BACKGROUND_CONTEXT).catch(() => undefined);
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
