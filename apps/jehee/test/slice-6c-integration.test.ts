// Focused integration unit tests for Slice 6C (ADR-0016):
// - Staging outbound route lock enforced on `send_media`;
// - Builtin workshop subagent isolation excludes `send_media` (`JEHEE_MEDIA_EXTENSION_HANDLE`);
// - Failed quiet-end auto-flush preserves held items in `HeldNotificationsDoc` and retries after backoff;
// - Slice 4 pure-MCP turn-1 `["tool_search"]` invariant preserved when `enableMedia` is unset;
// - Concurrent `reconnectMcp` serialization, fresh `blobVault` routing for `send_media`, and `host.close()` teardown.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SystemMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	isJsonRpcNotification,
	isJsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	type McpTransport,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import {
	ChannelGateway,
	computeNextQuietEndMs,
	InstaBoxClient,
	JeheeHost,
	type OutboundDocumentPayload,
	type OutboundPhotoPayload,
	parseQuietHoursWindow,
	SEND_MEDIA_TOOL,
	type WorkshopProvisioner,
} from "../src/index.ts";
import { createMockPaleEnvironment } from "./fixtures/pale-mcp-fixture.ts";

function collectActiveTools(ctx: TranscriptContext): string[] {
	const tools = new Set<string>();
	for (const msg of ctx.messages) {
		if (msg.role !== "system") continue;
		const sys = msg as SystemMessage;
		for (const t of sys.toolsAdded ?? []) tools.add(t.name);
		for (const t of sys.toolsRemoved ?? []) tools.delete(t.name);
	}
	return [...tools];
}

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

function createToggleScreenshotTransport(options: {
	readonly isOnline: () => boolean;
	readonly pngBytes: Uint8Array;
	readonly onClose?: () => void;
}): McpTransport {
	const pair = createInMemoryTransportPair();
	const originalClose = pair.client.close.bind(pair.client);
	pair.client.close = async () => {
		options.onClose?.();
		return originalClose();
	};
	let initialized = false;
	let ready = false;
	const b64 = Buffer.from(options.pngBytes).toString("base64");

	pair.server.onMessage((msg) => {
		if (isJsonRpcNotification(msg)) {
			if (msg.method === "notifications/initialized" && initialized) ready = true;
			return;
		}
		if (!isJsonRpcRequest(msg)) return;
		if (!options.isOnline()) {
			void pair.server.send({
				jsonrpc: "2.0",
				id: msg.id,
				error: { code: -32000, message: "offline" },
			});
			return;
		}
		const reply = (result: unknown) => {
			void pair.server.send({ jsonrpc: "2.0", id: msg.id, result });
		};
		if (msg.method === "initialize") {
			initialized = true;
			reply({
				protocolVersion: LATEST_PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "screen-mock", version: "0.1.0" },
			});
			return;
		}
		if (!ready) {
			void pair.server.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "not ready" } });
			return;
		}
		if (msg.method === "tools/list") {
			reply({
				tools: [
					{
						name: "take_shot",
						description: "Take a PNG screenshot",
						annotations: { readOnlyHint: true },
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			});
			return;
		}
		if (msg.method === "tools/call") {
			reply({
				content: [{ type: "image", data: b64, mimeType: "image/png" }],
			});
		}
	});
	void pair.server.start();
	return pair.client;
}

describe("Slice 6C host/gateway/workshop integration guarantees", () => {
	it("enforces stagingAllowedRoutes lock on send_media without leaking media to non-staging routes", async () => {
		const faux = fauxProvider();
		const capturedToolResults: string[] = [];
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(SEND_MEDIA_TOOL, {
						kind: "document",
						textContent: "classified staging doc",
						fileName: "secret.txt",
					}),
				],
				{ stopReason: "toolUse" },
			),
			(ctx) => {
				for (const msg of ctx.messages) {
					if (msg.role === "toolResult" && msg.toolName === SEND_MEDIA_TOOL) {
						capturedToolResults.push(msg.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
					}
				}
				return fauxAssistantMessage("发送被拦截。");
			},
		]);
		const models = createModels();
		models.setProvider(faux.provider);

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				enableMedia: true,
			},
			BACKGROUND_CONTEXT,
		);

		const docsSent: OutboundDocumentPayload[] = [];
		const gateway = new ChannelGateway({
			host,
			allowFrom: { telegram: ["owner-1"] },
			stagingAllowedRoutes: ["telegram:staging-only-chat"],
		});
		gateway.registerTransport({
			channel: "telegram",
			sendText: async () => undefined,
			sendDocument: async (_chatId, doc) => {
				docsSent.push(doc);
			},
		});

		try {
			await gateway.ingest(
				{
					channel: "telegram",
					chatId: "prod-chat-blocked",
					senderId: "owner-1",
					messageId: "m-stg-1",
					text: "把文件发给我",
					timestampMs: Date.now(),
				},
				BACKGROUND_CONTEXT,
			);
			assert.equal(docsSent.length, 0);
			assert.ok(gateway.blockedStagingDeliveries >= 1);
			assert.equal(capturedToolResults.length, 1);
			const parsed = JSON.parse(capturedToolResults[0]!) as { ok: boolean; error: string; reason: string };
			assert.equal(parsed.ok, false);
			assert.equal(parsed.error, "delivery_failed");
			assert.ok(parsed.reason.includes("staging lock"));
		} finally {
			gateway.dispose();
			await host.close(BACKGROUND_CONTEXT);
		}
	});

	it("excludes send_media (jehee.media) from builtin workshop subagents", async () => {
		const faux = fauxProvider();
		let childCtx: TranscriptContext | undefined;
		let rootCtx: TranscriptContext | undefined;

		const handleConcurrent = (ctx: TranscriptContext) => {
			if (extractSystemText(ctx).includes("Jehee Workshop subagent")) {
				childCtx = ctx;
				return fauxAssistantMessage("子工坊任务完成。");
			}
			return fauxAssistantMessage("已启动子工坊任务。");
		};
		faux.setResponses([
			(ctx) => {
				rootCtx = ctx;
				return fauxAssistantMessage(
					[fauxToolCall("workshop", { action: "spawn", name: "media-iso", message: "检查工具集" })],
					{ stopReason: "toolUse" },
				);
			},
			handleConcurrent,
			handleConcurrent,
			fauxAssistantMessage("子工坊汇报完毕。"),
		]);

		const models = createModels();
		models.setProvider(faux.provider);
		const client = new InstaBoxClient({
			apiKey: "unit-key",
			fetchImpl: async () => Response.json({ ok: true }),
		});
		const provisioner: WorkshopProvisioner = {
			prepareWorkspace: async (req) => ({ machineId: "box-iso", cwd: `/data/jehee/worktrees/${req.taskName}` }),
			cleanupWorkspace: async () => undefined,
		};

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				enableMedia: true,
				workshop: { client, provisioner, defaultDriver: "builtin" },
			},
			BACKGROUND_CONTEXT,
		);

		try {
			await host.sendMessage({ text: "派发工坊隔离验证" }, BACKGROUND_CONTEXT);
			await host.waitForWorkshopSettled(BACKGROUND_CONTEXT);

			assert.ok(rootCtx !== undefined);
			assert.ok(collectActiveTools(rootCtx).includes(SEND_MEDIA_TOOL));
			assert.ok(childCtx !== undefined);
			assert.equal(collectActiveTools(childCtx).includes(SEND_MEDIA_TOOL), false);
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}
	});

	it("preserves held quiet notifications when transport delivery fails during quiet-end auto-flush and delivers on retry", async () => {
		const quietWindow = parseQuietHoursWindow("23:00-08:00", "+08:00");
		let fakeNow = Date.parse("2026-11-18T15:30:00.000Z"); // 23:30+08:00
		const quietEndMs = computeNextQuietEndMs(quietWindow, fakeNow); // 2026-11-19T00:00:00.000Z
		const retryBackoffMs = 30_000;

		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				quietHours: quietWindow,
				quietFlushRetryBackoffMs: retryBackoffMs,
				now: () => fakeNow,
				autoResume: false,
			},
			BACKGROUND_CONTEXT,
		);

		let sendAttempts = 0;
		const delivered: string[] = [];
		const gateway = new ChannelGateway({
			host,
			allowFrom: { telegram: ["owner-1"] },
			quietPolicy: { quietHours: quietWindow },
			now: () => fakeNow,
		});
		gateway.registerTransport({
			channel: "telegram",
			sendText: async (_chatId, text) => {
				sendAttempts += 1;
				if (sendAttempts === 1) {
					throw new Error("Simulated transient Telegram 503");
				}
				delivered.push(text);
			},
		});
		host.resume();

		try {
			await gateway.pushMessage({ channel: "telegram", chatId: "chat-fail-keep" }, "不能丢失的夜间汇报");
			assert.equal(gateway.heldProactiveCount, 1);
			assert.equal((await host.listHeldNotifications(BACKGROUND_CONTEXT)).length, 1);

			// Wait for scheduler to settle into sleeping until quietEndMs.
			const sleepDeadline = Date.now() + 2_000;
			while (Date.now() < sleepDeadline && (host.wake().active || host.wake().at !== quietEndMs)) {
				await new Promise((resolve) => setTimeout(resolve, 15));
			}
			assert.equal(host.wake().at, quietEndMs);

			// Advance to quiet end: attempt 1 throws -> item must be preserved in HeldNotificationsDoc & scheduler backs off.
			fakeNow = quietEndMs;
			host.resume();
			await host.waitForDueRoutines(BACKGROUND_CONTEXT);

			assert.equal(sendAttempts, 1);
			assert.equal(delivered.length, 0);
			const preserved = await host.listHeldNotifications(BACKGROUND_CONTEXT);
			assert.equal(preserved.length, 1);
			assert.equal(preserved[0]?.text, "不能丢失的夜间汇报");
			assert.equal(host.wake().active, false);
			assert.equal(host.wake().at, quietEndMs + retryBackoffMs);

			// Advance past backoff: attempt 2 succeeds and drains the durable queue.
			fakeNow = quietEndMs + retryBackoffMs;
			host.resume();
			await host.waitForDueRoutines(BACKGROUND_CONTEXT);

			assert.equal(sendAttempts, 2);
			assert.equal(delivered.length, 1);
			assert.ok(delivered[0]?.includes("不能丢失的夜间汇报"));
			assert.equal((await host.listHeldNotifications(BACKGROUND_CONTEXT)).length, 0);
			assert.equal(gateway.heldProactiveCount, 0);
		} finally {
			gateway.dispose();
			await host.close(BACKGROUND_CONTEXT);
		}
	});

	it('preserves Slice 4 pure-MCP turn-1 ["tool_search"] invariant when enableMedia/routines/memory/handoff are unset', async () => {
		const paleEnv = createMockPaleEnvironment({ distractorServerCount: 0 });
		const faux = fauxProvider();
		let firstTurnTools: string[] = [];
		faux.setResponses([
			(ctx) => {
				firstTurnTools = collectActiveTools(ctx);
				return fauxAssistantMessage("仅暴露 tool_search。");
			},
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
					exposure: "deferred",
				},
			},
			BACKGROUND_CONTEXT,
		);

		try {
			await host.sendMessage({ text: "检查工具集" }, BACKGROUND_CONTEXT);
			assert.deepEqual(firstTurnTools, ["tool_search"]);
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}
	});

	it("serializes concurrent reconnectMcp calls, updates send_media blobVault reference, and closes the latest hub on host.close()", async () => {
		let online = false;
		let closedCount = 0;
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99, 0x88]);

		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				enableMedia: true,
				mcp: {
					servers: [
						{
							name: "screen",
							transport: {
								kind: "custom",
								create: () =>
									createToggleScreenshotTransport({
										isOnline: () => online,
										pngBytes,
										onClose: () => {
											closedCount += 1;
										},
									}),
							},
						},
					],
					exposure: "eager",
					bestEffortConnect: true,
				},
			},
			BACKGROUND_CONTEXT,
		);

		const photos: OutboundPhotoPayload[] = [];
		const gateway = new ChannelGateway({
			host,
			allowFrom: { telegram: ["owner-1"] },
		});
		gateway.registerTransport({
			channel: "telegram",
			sendText: async () => undefined,
			sendPhoto: async (_chatId, photo) => {
				photos.push(photo);
			},
		});

		try {
			assert.equal(host.getMcpStatus().connected.length, 0);
			assert.equal(host.getMcpStatus().failed.length, 1);

			online = true;
			// Fire two concurrent reconnects; both must succeed cleanly without racing.
			const [r1, r2] = await Promise.all([
				host.reconnectMcp(BACKGROUND_CONTEXT),
				host.reconnectMcp(BACKGROUND_CONTEXT),
			]);
			assert.equal(r1.connected.length, 1);
			assert.equal(r2.connected.length, 1);
			assert.equal(r2.failed.length, 0);

			// Now take a screenshot on the newly connected MCP bundle and send it via send_media -> uses latest blobVault!
			let step = 0;
			faux.setResponses([
				() => {
					step += 1;
					return fauxAssistantMessage([fauxToolCall("mcp__screen__take_shot", {})], { stopReason: "toolUse" });
				},
				(ctx) => {
					step += 1;
					const texts = ctx.messages
						.filter((m) => m.role === "toolResult")
						.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text))
						.join("\n");
					const handle = /\$jehee_blob:[a-f0-9]+/.exec(texts)?.[0];
					assert.ok(handle, `Expected blob handle after reconnect, got: ${texts}`);
					return fauxAssistantMessage([fauxToolCall(SEND_MEDIA_TOOL, { kind: "photo", blobHandle: handle })], {
						stopReason: "toolUse",
					});
				},
				() => fauxAssistantMessage("重连后截屏发送成功。"),
			]);

			await gateway.ingest(
				{
					channel: "telegram",
					chatId: "chat-recon",
					senderId: "owner-1",
					messageId: "m-recon-1",
					text: "截屏发给我",
					timestampMs: Date.now(),
				},
				BACKGROUND_CONTEXT,
			);
			assert.equal(step, 2);
			assert.equal(photos.length, 1);
			assert.deepEqual(photos[0]?.bytes, pngBytes);

			const closedBeforeShutdown = closedCount;
			gateway.dispose();
			await host.close(BACKGROUND_CONTEXT);
			assert.ok(closedCount > closedBeforeShutdown, "host.close() must close the latest reconnected MCP hub");
		} finally {
			gateway.dispose();
		}
	});
});
