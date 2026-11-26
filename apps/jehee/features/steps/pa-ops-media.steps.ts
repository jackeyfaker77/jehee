// Cucumber step definitions verifying Slice 6C (ADR-0016):
// 1. Quiet-hours held notifications persist across SQLite restart, /status shows durable held_proactive, and quiet-end auto-flush delivers digest;
// 2. /mcp displays sanitized failed server diagnostics and /mcp reconnect recovers when server comes online;
// 3. /model lists models, rejects unknown model, hot-swaps and persists across SQLite restart, and /model reset restores default;
// 4. send_media delivers an MCP screenshot via $jehee_blob: handle to sendPhoto and a UTF-8 document to sendDocument.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	isJsonRpcNotification,
	isJsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	type McpTransport,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { OutboundDocumentPayload, OutboundPhotoPayload } from "../../src/channels/contract.ts";
import { ChannelGateway } from "../../src/channels/gateway.ts";
import { JeheeHost } from "../../src/core/host.ts";
import { parseQuietHoursWindow, type QuietHoursWindow } from "../../src/governance/quiet-gate.ts";
import { JEHEE_BLOB_HANDLE_PREFIX } from "../../src/mcp/blob-vault.ts";
import type { JeheeMcpServerSpec } from "../../src/mcp/contract.ts";
import { SEND_MEDIA_TOOL } from "../../src/media/extension.ts";
import { openNodeJeheeHost } from "../../src/runtime/node.ts";
import { createMockPaleEnvironment } from "../../test/fixtures/pale-mcp-fixture.ts";
import type { JeheeWorld } from "../support/world.ts";

let opsFakeNow = 0;
let opsQuietWindow: QuietHoursWindow | undefined;
let opsOwnerId = "tg-owner-6c";
let opsSentTexts: Array<{ readonly chatId: string; readonly text: string }> = [];
let opsSentPhotos: Array<{ readonly chatId: string; readonly photo: OutboundPhotoPayload }> = [];
let opsSentDocs: Array<{ readonly chatId: string; readonly doc: OutboundDocumentPayload }> = [];
let opsPhoneOnline = false;
let opsMultiFaux: FauxProviderHandle | undefined;
let opsMultiModels = createModels();
let opsObservedModelIds: string[] = [];
let opsPostRestartModelReply = "";
let opsObservedBlobHandle = "";
const opsScreenshotBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33, 0x44]);

function collectToolResultTexts(ctx: TranscriptContext): string[] {
	const out: string[] = [];
	for (const msg of ctx.messages) {
		if (msg.role !== "toolResult") continue;
		for (const block of msg.content) {
			if (block.type === "text") out.push(block.text);
		}
	}
	return out;
}

function createPhoneMcpTransport(options: {
	readonly isOnline: () => boolean;
	readonly secretToken: string;
	readonly screenshotBase64: string;
}): McpTransport {
	const pair = createInMemoryTransportPair();
	let initialized = false;
	let ready = false;
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
				error: {
					code: -32000,
					message: `ECONNREFUSED Authorization: Bearer ${options.secretToken} https://phone.local/mcp?key=${options.secretToken}`,
				},
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
				serverInfo: { name: "phone-bridge-bdd", version: "0.1.0" },
			});
			return;
		}
		if (!ready) {
			void pair.server.send({
				jsonrpc: "2.0",
				id: msg.id,
				error: { code: -32002, message: "not ready" },
			});
			return;
		}
		if (msg.method === "tools/list") {
			reply({
				tools: [
					{
						name: "phone_ping",
						description: "Check whether the Android phone bridge is online.",
						annotations: { readOnlyHint: true },
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
					},
					{
						name: "phone_screenshot",
						description: "Capture the current Android phone screen as a PNG image.",
						annotations: { readOnlyHint: true },
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			});
			return;
		}
		if (msg.method === "tools/call") {
			const params =
				typeof msg.params === "object" && msg.params !== null ? (msg.params as Record<string, unknown>) : {};
			if (params.name === "phone_screenshot") {
				reply({
					content: [
						{ type: "image", data: options.screenshotBase64, mimeType: "image/png" },
						{ type: "text", text: "Screenshot captured." },
					],
				});
				return;
			}
			reply({
				content: [{ type: "text", text: JSON.stringify({ status: "ok", device: "pixel-6c" }) }],
			});
		}
	});
	void pair.server.start();
	return pair.client;
}

function attachCapturingTelegram(gateway: ChannelGateway): void {
	gateway.registerTransport({
		channel: "telegram",
		sendText: async (chatId, text) => {
			opsSentTexts.push({ chatId, text });
		},
		sendPhoto: async (chatId, photo) => {
			opsSentPhotos.push({ chatId, photo });
		},
		sendDocument: async (chatId, doc) => {
			opsSentDocs.push({ chatId, doc });
		},
	});
}

// ---------------------------------------------------------------------------
// Scenario 1: Quiet-hours durable persistence & quiet-end auto-flush
// ---------------------------------------------------------------------------

Given(
	"已以本地 SQLite 模式启动配置静默时段 {string}（UTC+08:00）的 Jehee 宿主与 Telegram 网关（授权主人 {string}）",
	async function (this: JeheeWorld, quietSpec: string, ownerId: string) {
		opsSentTexts = [];
		opsOwnerId = ownerId;
		opsQuietWindow = parseQuietHoursWindow(quietSpec, "+08:00");
		opsFakeNow = Date.parse("2026-11-18T15:30:00Z"); // 23:30+08:00
		this.tempDir = await mkdtemp(join(tmpdir(), "jehee-bdd-6c-quiet-"));
		this.sqlitePath = join(this.tempDir, "quiet.sqlite");

		this.host = await openNodeJeheeHost(
			{
				sqlitePath: this.sqlitePath,
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				utcOffsetMinutes: 480,
				quietHours: opsQuietWindow,
				now: () => opsFakeNow,
				autoResume: false,
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
			quietPolicy: { quietHours: opsQuietWindow },
			now: () => opsFakeNow,
		});
		attachCapturingTelegram(this.gateway);
		this.host.resume();
	},
);

When(
	"当前时钟处在深夜 {string}（23:30+08:00），后台推送通知 {string} 并重启 SQLite 宿主与网关",
	async function (this: JeheeWorld, isoUtc: string, notifyText: string) {
		assert.ok(this.host && this.gateway && this.sqlitePath && opsQuietWindow);
		opsFakeNow = Date.parse(isoUtc);
		const pushed = await this.gateway.pushMessage({ channel: "telegram", chatId: "chat-6c-quiet" }, notifyText);
		assert.equal(pushed, false);
		assert.equal(opsSentTexts.length, 0);

		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline && this.host.wake().active) {
			await new Promise((resolve) => setTimeout(resolve, 15));
		}

		this.gateway.dispose();
		await this.host.close(this.ctx);

		this.host = await openNodeJeheeHost(
			{
				sqlitePath: this.sqlitePath,
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				utcOffsetMinutes: 480,
				quietHours: opsQuietWindow,
				now: () => opsFakeNow,
				autoResume: false,
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [opsOwnerId] },
			quietPolicy: { quietHours: opsQuietWindow },
			now: () => opsFakeNow,
		});
		attachCapturingTelegram(this.gateway);
		this.host.resume();
	},
);

When(
	"主人 {string} 在会话 {string} 执行运维指令 {string}",
	async function (this: JeheeWorld, ownerId: string, chatId: string, cmdText: string) {
		assert.ok(this.gateway);
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId,
				senderId: ownerId,
				messageId: `ops-cmd-${Date.now()}-${Math.random()}`,
				text: cmdText,
				timestampMs: opsFakeNow || Date.now(),
			},
			this.ctx,
		);
	},
);

Then(
	"运维状态回执显示持久化暂存数 {string}，且深夜未产生打扰推送",
	function (this: JeheeWorld, expectedSnippet: string) {
		assert.equal(opsSentTexts.length, 1);
		assert.ok(
			opsSentTexts[0]?.text.includes(expectedSnippet),
			`Expected "${expectedSnippet}" in:\n${opsSentTexts[0]?.text}`,
		);
	},
);

When(
	"时钟推进到次日清晨 {string}（08:00+08:00）并唤醒调度器结算",
	async function (this: JeheeWorld, morningIso: string) {
		assert.ok(this.host && this.gateway);
		opsFakeNow = Date.parse(morningIso);
		this.host.resume();
		await this.host.waitForDueRoutines(this.ctx);
		await this.gateway.drain();
	},
);

Then(
	"Telegram 会话 {string} 自动收到包含 {string} 的补发通知，且再次执行 {string} 提示 {string}",
	async function (
		this: JeheeWorld,
		chatId: string,
		expectedNotice: string,
		flushCmd: string,
		expectedEmptyHint: string,
	) {
		assert.ok(this.gateway);
		const flushedMsg = opsSentTexts.find((m) => m.chatId === chatId && m.text.includes(expectedNotice));
		assert.ok(flushedMsg, `Expected auto-flushed "${expectedNotice}" in ${JSON.stringify(opsSentTexts)}`);

		const beforeFlush = opsSentTexts.length;
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId,
				senderId: opsOwnerId,
				messageId: "ops-flush-after-auto",
				text: flushCmd,
				timestampMs: opsFakeNow,
			},
			this.ctx,
		);
		const afterReply = opsSentTexts.slice(beforeFlush).at(-1)?.text ?? "";
		assert.ok(afterReply.includes(expectedEmptyHint), `Expected "${expectedEmptyHint}" in: ${afterReply}`);
	},
);

// ---------------------------------------------------------------------------
// Scenario 2: /mcp diagnostics & /mcp reconnect self-healing
// ---------------------------------------------------------------------------

Given(
	"已启动挂载离线 MCP 服务 {string}（含敏感凭据）与在线服务 {string} 的 Jehee 宿主及 Telegram 网关（授权主人 {string}）",
	async function (this: JeheeWorld, offlineName: string, onlineName: string, ownerId: string) {
		opsSentTexts = [];
		opsOwnerId = ownerId;
		opsPhoneOnline = false;
		const paleEnv = createMockPaleEnvironment({ distractorServerCount: 0 });
		const phoneSpec: JeheeMcpServerSpec = {
			name: offlineName,
			description: "Android phone bridge",
			transport: {
				kind: "custom",
				create: () =>
					createPhoneMcpTransport({
						isOnline: () => opsPhoneOnline,
						secretToken: "secret-phone-token-6c",
						screenshotBase64: Buffer.from(opsScreenshotBytes).toString("base64"),
					}),
			},
		};
		const mailSpec: JeheeMcpServerSpec = {
			...paleEnv.mailSpec,
			name: onlineName,
		};

		this.host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				mcp: {
					servers: [mailSpec, phoneSpec],
					exposure: "eager",
					bestEffortConnect: true,
				},
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
		});
		attachCapturingTelegram(this.gateway);
	},
);

Then(
	"渠道回执包含 {string} 与 {string}，且不包含原始凭据 {string}",
	(okSnippet: string, failSnippet: string, secret: string) => {
		const latest = opsSentTexts.at(-1)?.text ?? "";
		assert.ok(latest.includes(okSnippet), `Expected "${okSnippet}" in:\n${latest}`);
		assert.ok(latest.includes(failSnippet), `Expected "${failSnippet}" in:\n${latest}`);
		assert.equal(latest.includes(secret), false, `Expected secret "${secret}" to be redacted in:\n${latest}`);
		assert.ok(latest.includes("[redacted]"), `Expected [redacted] marker in:\n${latest}`);
	},
);

When(
	"离线 MCP 服务 {string} 恢复上线后，主人执行 {string}",
	async function (this: JeheeWorld, _name: string, cmd: string) {
		assert.ok(this.gateway);
		opsPhoneOnline = true;
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId: "chat-6c-mcp",
				senderId: opsOwnerId,
				messageId: "ops-mcp-reconnect",
				text: cmd,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
	},
);

Then(
	"渠道回执显示重连完成且同时包含 {string} 与 {string}，且模型随后可正常调用 {string}",
	async function (this: JeheeWorld, mailOk: string, phoneOk: string, toolName: string) {
		assert.ok(this.host);
		const latest = opsSentTexts.at(-1)?.text ?? "";
		assert.ok(latest.includes("重连完成"), `Expected 重连完成 in:\n${latest}`);
		assert.ok(latest.includes(mailOk), `Expected "${mailOk}" in:\n${latest}`);
		assert.ok(latest.includes(phoneOk), `Expected "${phoneOk}" in:\n${latest}`);

		const router: FauxResponseStep = (ctx) => {
			const results = collectToolResultTexts(ctx);
			if (results.length === 0) {
				return fauxAssistantMessage([fauxToolCall(toolName, {})], { stopReason: "toolUse" });
			}
			assert.ok(results[0]?.includes("pixel-6c"), `Expected phone_ping output, got: ${results[0]}`);
			return fauxAssistantMessage("手机桥接已恢复在线（pixel-6c）。");
		};
		this.installScriptedSteps([router, router]);
		const reply = await this.host.sendMessage({ text: "测试手机桥接连通性" }, this.ctx);
		assert.equal(reply.status, "done");
		if (reply.status === "done") {
			assert.ok(reply.replyText.includes("pixel-6c"));
		}
	},
);

// ---------------------------------------------------------------------------
// Scenario 3: /model list, validation, hot-swap persistence & reset
// ---------------------------------------------------------------------------

Given(
	"已以本地 SQLite 模式启动多模型注册表的 Jehee 宿主与 Telegram 网关（授权主人 {string}，默认模型 {string}）",
	async function (this: JeheeWorld, ownerId: string, defaultSpec: string) {
		opsSentTexts = [];
		opsOwnerId = ownerId;
		opsObservedModelIds = [];
		opsPostRestartModelReply = "";
		opsMultiFaux = fauxProvider({
			provider: "faux-multi",
			models: [
				{ id: "fast-1", name: "Fast Model" },
				{ id: "pro-2", name: "Pro Model" },
			],
		});
		opsMultiModels = createModels();
		opsMultiModels.setProvider(opsMultiFaux.provider);

		const [provider, modelId] = defaultSpec.split("/");
		assert.ok(provider && modelId);

		this.tempDir = await mkdtemp(join(tmpdir(), "jehee-bdd-6c-model-"));
		this.sqlitePath = join(this.tempDir, "model.sqlite");
		this.host = await openNodeJeheeHost(
			{
				sqlitePath: this.sqlitePath,
				models: opsMultiModels,
				defaultModel: { provider, modelId },
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
		});
		attachCapturingTelegram(this.gateway);
	},
);

When(
	"主人 {string} 在会话 {string} 依次执行 {string}、{string} 与 {string}",
	async function (this: JeheeWorld, ownerId: string, chatId: string, cmd1: string, cmd2: string, cmd3: string) {
		assert.ok(this.gateway && opsMultiFaux);
		for (const [idx, cmd] of [cmd1, cmd2, cmd3].entries()) {
			await this.gateway.ingest(
				{
					channel: "telegram",
					chatId,
					senderId: ownerId,
					messageId: `ops-model-${idx}`,
					text: cmd,
					timestampMs: Date.now(),
				},
				this.ctx,
			);
		}
		opsMultiFaux.setResponses([
			(_ctx, _opts, _state, model) => {
				opsObservedModelIds.push(model.id);
				return fauxAssistantMessage(`using ${model.id}`);
			},
		]);
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId,
				senderId: ownerId,
				messageId: "ops-model-turn-1",
				text: "确认当前模型",
				timestampMs: Date.now(),
			},
			this.ctx,
		);
	},
);

Then(
	"渠道回执依次包含可用模型列表、未知模型拦截提示以及切换至 {string} 的确认，且下一轮模型请求使用 {string}",
	(targetSpec: string, expectedModelId: string) => {
		assert.ok(opsSentTexts[0]?.text.includes("faux-multi/fast-1"));
		assert.ok(opsSentTexts[0]?.text.includes("faux-multi/pro-2"));
		assert.ok(opsSentTexts[1]?.text.includes("切换失败"));
		assert.ok(opsSentTexts[1]?.text.includes("does-not-exist"));
		assert.ok(opsSentTexts[2]?.text.includes(`已切换模型：${targetSpec}`));
		assert.equal(opsObservedModelIds[0], expectedModelId);
	},
);

When(
	"重启 SQLite 宿主与网关后主人先查询 {string} 再执行 {string} 并进行一轮对话",
	async function (this: JeheeWorld, statusCmd: string, resetCmd: string) {
		assert.ok(this.host && this.gateway && this.sqlitePath && opsMultiFaux);
		this.gateway.dispose();
		await this.host.close(this.ctx);

		this.host = await openNodeJeheeHost(
			{
				sqlitePath: this.sqlitePath,
				models: opsMultiModels,
				defaultModel: { provider: "faux-multi", modelId: "fast-1" },
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [opsOwnerId] },
		});
		attachCapturingTelegram(this.gateway);

		const beforeCount = opsSentTexts.length;
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId: "chat-6c-model",
				senderId: opsOwnerId,
				messageId: "ops-model-status-restart",
				text: statusCmd,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		opsPostRestartModelReply = opsSentTexts.slice(beforeCount).at(-1)?.text ?? "";

		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId: "chat-6c-model",
				senderId: opsOwnerId,
				messageId: "ops-model-reset",
				text: resetCmd,
				timestampMs: Date.now(),
			},
			this.ctx,
		);

		opsMultiFaux.setResponses([
			(_ctx, _opts, _state, model) => {
				opsObservedModelIds.push(model.id);
				return fauxAssistantMessage(`back to ${model.id}`);
			},
		]);
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId: "chat-6c-model",
				senderId: opsOwnerId,
				messageId: "ops-model-turn-after-reset",
				text: "现在用的哪个模型",
				timestampMs: Date.now(),
			},
			this.ctx,
		);
	},
);

Then(
	"重启后 {string} 仍显示运行时覆盖 {string}，执行 {string} 后恢复为默认模型 {string}",
	(_cmd: string, expectedOverride: string, _resetCmd: string, expectedDefaultId: string) => {
		assert.ok(opsPostRestartModelReply.includes(expectedOverride), `Got:\n${opsPostRestartModelReply}`);
		assert.ok(opsPostRestartModelReply.includes("运行时覆盖"), `Got:\n${opsPostRestartModelReply}`);
		assert.equal(opsObservedModelIds.at(-1), expectedDefaultId);
	},
);

// ---------------------------------------------------------------------------
// Scenario 4: send_media delivering MCP screenshot blob + UTF-8 document
// ---------------------------------------------------------------------------

Given(
	"已启动开启出站富媒体与模拟手机截图 MCP 服务的 Jehee 宿主及多模态 Telegram 网关（授权主人 {string}）",
	async function (this: JeheeWorld, ownerId: string) {
		opsSentTexts = [];
		opsSentPhotos = [];
		opsSentDocs = [];
		opsObservedBlobHandle = "";
		opsOwnerId = ownerId;
		const phoneSpec: JeheeMcpServerSpec = {
			name: "phone",
			description: "Mock Android phone bridge",
			transport: {
				kind: "custom",
				create: () =>
					createPhoneMcpTransport({
						isOnline: () => true,
						secretToken: "unused",
						screenshotBase64: Buffer.from(opsScreenshotBytes).toString("base64"),
					}),
			},
		};
		this.host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				enableMedia: true,
				mcp: {
					servers: [phoneSpec],
					exposure: "eager",
				},
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
		});
		attachCapturingTelegram(this.gateway);
	},
);

When(
	"主人 {string} 在会话 {string} 请求截屏并导出巡检报告，模型依次调用截图 MCP 工具与两次 send_media",
	async function (this: JeheeWorld, ownerId: string, chatId: string) {
		assert.ok(this.gateway);
		const router: FauxResponseStep = (ctx) => {
			const results = collectToolResultTexts(ctx);
			if (results.length === 0) {
				return fauxAssistantMessage([fauxToolCall("mcp__phone__phone_screenshot", {})], {
					stopReason: "toolUse",
				});
			}
			if (results.length === 2) {
				const handleMatch = /\$jehee_blob:[a-f0-9]+/.exec(results.join("\n"));
				assert.ok(handleMatch, `Expected $jehee_blob handle in: ${results.join("\n")}`);
				opsObservedBlobHandle = handleMatch[0];
				return fauxAssistantMessage(
					[
						fauxToolCall(SEND_MEDIA_TOOL, {
							kind: "photo",
							blobHandle: opsObservedBlobHandle,
							caption: "手机实时截图",
						}),
						fauxToolCall(SEND_MEDIA_TOOL, {
							kind: "document",
							textContent: "# Patrol Report\nAll services nominal.",
							fileName: "report.md",
							caption: "巡检报告",
						}),
					],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("已发送截图与巡检报告。");
		};
		this.installScriptedSteps([router, router, router]);

		const res = await this.gateway.ingest(
			{
				channel: "telegram",
				chatId,
				senderId: ownerId,
				messageId: "ops-media-req-1",
				text: "把手机截图和巡检报告发给我",
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		assert.equal(res.kind, "replied");
	},
);

Then(
	"Telegram 传输器收到 1 张通过 {string} 句柄无损转发的 {string} 图片与 1 份 {string} UTF-8 文档",
	(expectedHandlePrefix: string, expectedMime: string, expectedFileName: string) => {
		assert.ok(opsObservedBlobHandle.startsWith(expectedHandlePrefix));
		assert.ok(opsObservedBlobHandle.startsWith(JEHEE_BLOB_HANDLE_PREFIX));
		assert.equal(opsSentPhotos.length, 1);
		assert.equal(opsSentPhotos[0]?.chatId, "chat-6c-media");
		assert.equal(opsSentPhotos[0]?.photo.mimeType, expectedMime);
		assert.deepEqual(opsSentPhotos[0]?.photo.bytes, opsScreenshotBytes);
		assert.equal(opsSentPhotos[0]?.photo.caption, "手机实时截图");

		assert.equal(opsSentDocs.length, 1);
		assert.equal(opsSentDocs[0]?.chatId, "chat-6c-media");
		assert.equal(opsSentDocs[0]?.doc.fileName, expectedFileName);
		assert.equal(opsSentDocs[0]?.doc.mimeType, "text/markdown");
		assert.equal(new TextDecoder().decode(opsSentDocs[0]?.doc.bytes), "# Patrol Report\nAll services nominal.");
	},
);
