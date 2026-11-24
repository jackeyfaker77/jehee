// Cucumber step definitions verifying Slice 6B (ADR-0015):
// captionless Telegram photo + text document inbound through ChannelGateway (debounced coalescing + per-file download
// error isolation -> ImageContent + document excerpt), and web_fetch reading public HTML, blocking SSRF 169.254.169.254,
// and confirming builtin workshop subagents exclude web_fetch.

import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import type { ImageContent, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChannelGateway } from "../../src/channels/gateway.ts";
import { parseTelegramUpdate, TelegramTransport } from "../../src/channels/telegram.ts";
import { JeheeHost } from "../../src/core/host.ts";
import { WEB_FETCH_TOOL } from "../../src/web/extension.ts";
import { InstaBoxClient } from "../../src/workshop/instabox-client.ts";
import type { WorkshopProvisioner } from "../../src/workshop/provisioner.ts";
import type { JeheeWorld } from "../support/world.ts";

let mmSentTexts: string[] = [];
let webPublicToolResult: { readonly isError: boolean; readonly text: string } | undefined;
let webBlockedToolResult: { readonly isError: boolean; readonly text: string } | undefined;
let webWorkshopChildCtx: TranscriptContext | undefined;

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

function collectActiveTools(ctx: TranscriptContext): Set<string> {
	const tools = new Set<string>();
	for (const msg of ctx.messages) {
		if (msg.role !== "system") continue;
		for (const t of msg.toolsAdded ?? []) tools.add(t.name);
		for (const t of msg.toolsRemoved ?? []) tools.delete(t.name);
	}
	return tools;
}

function collectUserImagesAndTexts(ctx: TranscriptContext): {
	readonly texts: readonly string[];
	readonly images: readonly ImageContent[];
} {
	const texts: string[] = [];
	const images: ImageContent[] = [];
	for (const msg of ctx.messages) {
		if (msg.role !== "user") continue;
		if (typeof msg.content === "string") {
			texts.push(msg.content);
		} else {
			for (const block of msg.content) {
				if (block.type === "text") texts.push(block.text);
				if (block.type === "image") images.push(block);
			}
		}
	}
	return { texts, images };
}

Given(
	"已启动带 Telegram 多模态传输器与防抖窗口的 Jehee 宿主及渠道网关（授权主人 {string}）",
	async function (this: JeheeWorld, ownerId: string) {
		mmSentTexts = [];
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const mdBytes = new TextEncoder().encode("# Release Notes\nSprint-6B-Checkpoint verified.");

		this.host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
			debounceMs: 25,
		});
		this.gateway.registerTransport(
			new TelegramTransport({
				botToken: "bdd-6b-token",
				apiBaseUrl: "https://mock.telegram.test",
				fetchImpl: async (input, init) => {
					const url = String(input);
					if (url.endsWith("/getFile")) {
						const body = JSON.parse(String(init?.body)) as { file_id?: string };
						if (body.file_id === "photo-6b") {
							return Response.json({
								ok: true,
								result: { file_id: "photo-6b", file_size: pngBytes.byteLength, file_path: "photos/shot.png" },
							});
						}
						if (body.file_id === "doc-6b") {
							return Response.json({
								ok: true,
								result: { file_id: "doc-6b", file_size: mdBytes.byteLength, file_path: "docs/notes.md" },
							});
						}
						return new Response("file server unavailable", { status: 500 });
					}
					if (url.endsWith("/photos/shot.png")) {
						return new Response(pngBytes, { status: 200, headers: { "content-type": "image/png" } });
					}
					if (url.endsWith("/docs/notes.md")) {
						return new Response(mdBytes, { status: 200, headers: { "content-type": "text/markdown" } });
					}
					if (url.endsWith("/sendMessage")) {
						const body = JSON.parse(String(init?.body)) as { text?: string };
						if (body.text !== undefined) mmSentTexts.push(body.text);
					}
					return Response.json({ ok: true, result: true });
				},
			}),
		);
	},
);

When(
	"主人 {string} 连续发送一条无配文 Telegram 图片与一条 Markdown 文档 {string}",
	async function (this: JeheeWorld, ownerId: string, docFileName: string) {
		this.installScriptedSteps([fauxAssistantMessage("已收到图片和文档摘要。")]);
		const photoMsg = parseTelegramUpdate({
			update_id: 6001,
			message: {
				message_id: 101,
				date: 1700001000,
				from: { id: ownerId },
				chat: { id: "chat-6b", type: "private" },
				photo: [
					{ file_id: "photo-thumb", width: 100, height: 100, file_size: 4 },
					{ file_id: "photo-6b", width: 1024, height: 768, file_size: 8 },
				],
			},
		});
		const docMsg = parseTelegramUpdate({
			update_id: 6002,
			message: {
				message_id: 102,
				date: 1700001001,
				from: { id: ownerId },
				chat: { id: "chat-6b", type: "private" },
				document: {
					file_id: "doc-6b",
					file_name: docFileName,
					mime_type: "text/markdown",
				},
			},
		});
		assert.ok(photoMsg !== undefined);
		assert.ok(docMsg !== undefined);

		const [res1, res2] = await Promise.all([
			this.gateway!.ingest(photoMsg, this.ctx),
			this.gateway!.ingest(docMsg, this.ctx),
		]);
		assert.deepEqual(res1, { kind: "replied", replyText: "已收到图片和文档摘要。" });
		assert.deepEqual(res2, { kind: "replied", replyText: "已收到图片和文档摘要。" });
	},
);

Then(
	"发往模型的用户消息包含 {string} 的 ImageContent 块与文档正文 {string}，且渠道收到模型回复",
	function (this: JeheeWorld, expectedMime: string, expectedExcerpt: string) {
		assert.equal(this.capturedContexts.length, 1);
		const { texts, images } = collectUserImagesAndTexts(this.capturedContexts[0]!);
		assert.equal(images.length, 1);
		assert.equal(images[0]!.type, "image");
		assert.equal(images[0]!.mimeType, expectedMime);
		assert.ok(images[0]!.data.length > 0);
		assert.ok(texts.join("\n").includes(expectedExcerpt));
		assert.deepEqual(mmSentTexts, ["已收到图片和文档摘要。"]);
	},
);

When(
	"主人 {string} 发送包含有效图片与下载失败文档 {string} 的消息",
	async function (this: JeheeWorld, ownerId: string, failingDocName: string) {
		this.installScriptedSteps([fauxAssistantMessage("已收到有效图片，损坏文档已记录提示。")]);
		const result = await this.gateway!.ingest(
			{
				channel: "telegram",
				chatId: "chat-6b-err",
				senderId: ownerId,
				messageId: "201",
				text: "请查看这两个附件",
				timestampMs: Date.now(),
				attachments: [
					{ kind: "image", fileId: "photo-6b", mimeType: "image/jpeg" },
					{ kind: "document", fileId: "broken-6b", fileName: failingDocName, mimeType: "text/plain" },
				],
			},
			this.ctx,
		);
		assert.deepEqual(result, { kind: "replied", replyText: "已收到有效图片，损坏文档已记录提示。" });
	},
);

Then(
	"模型仍收到有效图片的 ImageContent 与 {string} 降级提示，整条消息未被丢弃",
	function (this: JeheeWorld, expectedNote: string) {
		assert.equal(this.capturedContexts.length, 1);
		const { texts, images } = collectUserImagesAndTexts(this.capturedContexts[0]!);
		assert.equal(images.length, 1);
		assert.equal(images[0]!.mimeType, "image/png");
		assert.ok(texts.join("\n").includes(expectedNote));
	},
);

Given(
	"已启动开启 web_fetch 与内置工坊的 Jehee 宿主（公网页面标题 {string}）",
	async function (this: JeheeWorld, pageTitle: string) {
		webPublicToolResult = undefined;
		webBlockedToolResult = undefined;
		webWorkshopChildCtx = undefined;

		const client = new InstaBoxClient({
			apiKey: "bdd-mock-key",
			fetchImpl: async () => Response.json({ ok: true }),
		});
		const provisioner: WorkshopProvisioner = {
			prepareWorkspace: async (req) => ({
				machineId: "bdd-box-1",
				cwd: `/data/jehee/worktrees/${req.taskName}`,
			}),
			cleanupWorkspace: async () => undefined,
		};

		this.host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				enableWebFetch: true,
				webFetch: {
					fetchImpl: async (input) => {
						const url = String(input);
						if (url === "https://docs.example.com/public-guide") {
							return new Response(
								`<!doctype html><html><head><title>${pageTitle}</title><script>window.__xss = 1;</script></head><body><h1>Public Handbook</h1><p>Portable edge web fetch works.</p></body></html>`,
								{ status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
							);
						}
						throw new Error(`Unexpected external fetch to ${url}`);
					},
				},
				workshop: { client, provisioner, defaultDriver: "builtin" },
			},
			this.ctx,
		);
	},
);

When(
	"主会话依次调用 web_fetch 抓取公网 HTML 与元数据地址 {string}",
	async function (this: JeheeWorld, metadataUrl: string) {
		this.installScriptedSteps([
			fauxAssistantMessage(
				[
					fauxToolCall(WEB_FETCH_TOOL, { url: "https://docs.example.com/public-guide" }),
					fauxToolCall(WEB_FETCH_TOOL, { url: metadataUrl }),
				],
				{ stopReason: "toolUse" },
			),
			(ctx) => {
				const results = ctx.messages.filter((m) => m.role === "toolResult" && m.toolName === WEB_FETCH_TOOL);
				if (results[0]?.role === "toolResult") {
					webPublicToolResult = {
						isError: results[0].isError,
						text: results[0].content.map((b) => (b.type === "text" ? b.text : "")).join(""),
					};
				}
				if (results[1]?.role === "toolResult") {
					webBlockedToolResult = {
						isError: results[1].isError,
						text: results[1].content.map((b) => (b.type === "text" ? b.text : "")).join(""),
					};
				}
				return fauxAssistantMessage("公网页面已抓取，元数据地址已安全拦截。");
			},
		]);

		const reply = await this.host!.sendMessage({ text: "帮我读这两个链接" }, this.ctx);
		assert.equal(reply.status, "done");
	},
);

Then(
	"公网抓取成功提取标题 {string} 与正文并剥离脚本，元数据地址被 {string} 拦截",
	(expectedTitle: string, expectedErrorCode: string) => {
		assert.ok(webPublicToolResult !== undefined);
		assert.equal(webPublicToolResult.isError, false);
		const okBody = JSON.parse(webPublicToolResult.text) as {
			ok: boolean;
			title?: string;
			text?: string;
		};
		assert.equal(okBody.ok, true);
		assert.equal(okBody.title, expectedTitle);
		assert.ok(okBody.text?.includes("Portable edge web fetch works."));
		assert.equal(okBody.text?.includes("window.__xss"), false);

		assert.ok(webBlockedToolResult !== undefined);
		assert.equal(webBlockedToolResult.isError, true);
		const blockedBody = JSON.parse(webBlockedToolResult.text) as {
			ok: boolean;
			error?: string;
		};
		assert.equal(blockedBody.ok, false);
		assert.equal(blockedBody.error, expectedErrorCode);
	},
);

When("主会话派发校验 web_fetch 隔离的内置工坊任务 {string}", async function (this: JeheeWorld, taskName: string) {
	const handleConcurrent = (ctx: TranscriptContext) => {
		if (extractSystemText(ctx).includes("Jehee Workshop subagent")) {
			webWorkshopChildCtx = ctx;
			return fauxAssistantMessage("工坊校验完成。");
		}
		return fauxAssistantMessage("已派发工坊任务。");
	};
	this.installScriptedSteps([
		fauxAssistantMessage([fauxToolCall("workshop", { action: "spawn", name: taskName, message: "校验隔离" })], {
			stopReason: "toolUse",
		}),
		handleConcurrent,
		handleConcurrent,
		fauxAssistantMessage("工坊回报已收到。"),
	]);
	await this.host!.sendMessage({ text: "启动一个工坊任务" }, this.ctx);
	await this.host!.waitForWorkshopSettled(this.ctx);
});

Then("工坊子 Agent 可用工具集中不包含 web_fetch", () => {
	assert.ok(webWorkshopChildCtx !== undefined, "Expected workshop subagent context");
	const childTools = collectActiveTools(webWorkshopChildCtx);
	assert.ok(!childTools.has(WEB_FETCH_TOOL));
});
