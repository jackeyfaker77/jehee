// Unit tests for Slice 6C outbound media delivery (`jehee.media` / `send_media`) and `McpBlobVault.getBlob`:
// blobHandle forwarding, raw base64 photos, UTF-8 textContent documents, source exclusivity, size bounds,
// raster image MIME enforcement, delivery error propagation, and end-to-end execution through JeheeHost.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-durable";
import { JeheeHost } from "../src/core/host.ts";
import { JEHEE_BLOB_HANDLE_PREFIX, McpBlobVault } from "../src/mcp/blob-vault.ts";
import {
	createOutboundMediaExtension,
	JEHEE_MEDIA_EXTENSION_HANDLE,
	JEHEE_MEDIA_EXTENSION_NAME,
	type OutboundMediaDeliveryResult,
	type OutboundMediaPayload,
	SEND_MEDIA_TOOL,
} from "../src/media/extension.ts";

async function runSendMediaThroughHost(params: {
	readonly calls: readonly { readonly name: string; readonly args: JsonObject }[];
	readonly resolveBlob?: (handle: string) => { readonly bytes: Uint8Array; readonly mimeType: string } | undefined;
	readonly deliverMedia: (payload: OutboundMediaPayload) => Promise<OutboundMediaDeliveryResult>;
	readonly maxBytes?: number;
	readonly enabled?: boolean;
}): Promise<Array<{ readonly isError: boolean; readonly text: string }>> {
	const results: Array<{ readonly isError: boolean; readonly text: string }> = [];
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage(
			params.calls.map((c) => fauxToolCall(c.name, c.args)),
			{ stopReason: "toolUse" },
		),
		(ctx) => {
			for (const msg of ctx.messages) {
				if (msg.role === "toolResult" && msg.toolName === SEND_MEDIA_TOOL) {
					const text = msg.content
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join("");
					results.push({ isError: msg.isError, text });
				}
			}
			return fauxAssistantMessage("Done.");
		},
	]);

	const models = createModels();
	models.setProvider(faux.provider);

	const mediaExt = createOutboundMediaExtension({
		...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
		...(params.resolveBlob !== undefined ? { resolveBlob: params.resolveBlob } : {}),
		...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
		deliverMedia: async (payload) => params.deliverMedia(payload),
	});

	const host = await JeheeHost.open(
		{
			storage: { kind: "memory" },
			models,
			defaultModel: { provider: "faux", modelId: faux.getModel().id },
			extensions: [mediaExt],
		},
		BACKGROUND_CONTEXT,
	);

	try {
		const reply = await host.sendMessage({ text: "Deliver requested media" }, BACKGROUND_CONTEXT);
		assert.equal(reply.status, "done");
	} finally {
		await host.close(BACKGROUND_CONTEXT);
	}

	return results;
}

describe("jehee.media outbound media extension (send_media)", () => {
	it("exposes stable extension constants, handle, and empty toolset when disabled", () => {
		assert.equal(JEHEE_MEDIA_EXTENSION_NAME, "jehee.media");
		assert.equal(JEHEE_MEDIA_EXTENSION_HANDLE.name, "jehee.media");
		assert.equal(SEND_MEDIA_TOOL, "send_media");

		const disabled = createOutboundMediaExtension({
			enabled: false,
			deliverMedia: async () => ({ ok: true, route: "telegram:1" }),
		});
		assert.equal(disabled.name, "jehee.media");
		assert.deepEqual(disabled.tools ?? [], []);
	});

	it("delivers a photo from McpBlobVault via blobHandle using Web-standard getBlob decoding", async () => {
		const vault = new McpBlobVault();
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
		const pngBase64 = Buffer.from(pngBytes).toString("base64");
		const stored = vault.storeBase64(pngBase64, "image/png");
		assert.ok(stored.handle.startsWith(JEHEE_BLOB_HANDLE_PREFIX));

		const resolvedDirect = vault.getBlob(stored.handle);
		assert.ok(resolvedDirect);
		assert.equal(resolvedDirect.mimeType, "image/png");
		assert.equal(resolvedDirect.byteLength, pngBytes.byteLength);
		assert.deepEqual(resolvedDirect.bytes, pngBytes);
		assert.equal(vault.getBlob(`${JEHEE_BLOB_HANDLE_PREFIX}nonexistent`), undefined);

		const delivered: OutboundMediaPayload[] = [];
		const results = await runSendMediaThroughHost({
			calls: [
				{
					name: SEND_MEDIA_TOOL,
					args: {
						kind: "photo",
						blobHandle: stored.handle,
						fileName: "phone_screen.png",
						caption: "Latest phone screenshot",
					},
				},
			],
			resolveBlob: (handle) => vault.getBlob(handle),
			deliverMedia: async (payload) => {
				delivered.push(payload);
				return { ok: true, route: "telegram:owner-42" };
			},
		});

		assert.equal(results.length, 1);
		assert.equal(results[0]!.isError, false);
		const parsed = JSON.parse(results[0]!.text) as { ok: boolean; route: string; kind: string; bytes: number };
		assert.equal(parsed.ok, true);
		assert.equal(parsed.route, "telegram:owner-42");
		assert.equal(parsed.kind, "photo");
		assert.equal(parsed.bytes, pngBytes.byteLength);

		assert.equal(delivered.length, 1);
		assert.equal(delivered[0]!.kind, "photo");
		assert.equal(delivered[0]!.mimeType, "image/png");
		assert.equal(delivered[0]!.fileName, "phone_screen.png");
		assert.equal(delivered[0]!.caption, "Latest phone screenshot");
		assert.deepEqual(delivered[0]!.bytes, pngBytes);
	});

	it("delivers raw base64 photos and UTF-8 textContent documents with MIME/filename resolution", async () => {
		const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
		const jpegBase64 = Buffer.from(jpegBytes).toString("base64");
		const markdownText = "# Daily Summary\n\n- 完成了 Slice 6C 媒体发送工具\n- 状态: OK\n";

		const delivered: OutboundMediaPayload[] = [];
		const results = await runSendMediaThroughHost({
			calls: [
				{
					name: SEND_MEDIA_TOOL,
					args: {
						kind: "photo",
						base64: jpegBase64,
						mimeType: "image/jpeg",
						caption: "Camera frame",
					},
				},
				{
					name: SEND_MEDIA_TOOL,
					args: {
						kind: "document",
						textContent: markdownText,
						fileName: "../reports/daily-summary.md",
						caption: "Daily report",
					},
				},
				{
					name: SEND_MEDIA_TOOL,
					args: {
						kind: "document",
						textContent: '{"ok":true}',
						mimeType: "application/json",
					},
				},
			],
			deliverMedia: async (payload) => {
				delivered.push(payload);
				return { ok: true, route: "telegram:1001" };
			},
		});

		assert.equal(results.length, 3);
		for (const res of results) {
			assert.equal(res.isError, false);
		}

		assert.equal(delivered.length, 3);
		assert.equal(delivered[0]!.kind, "photo");
		assert.equal(delivered[0]!.mimeType, "image/jpeg");
		assert.deepEqual(delivered[0]!.bytes, jpegBytes);
		assert.equal(delivered[0]!.caption, "Camera frame");

		assert.equal(delivered[1]!.kind, "document");
		assert.equal(delivered[1]!.mimeType, "text/markdown");
		assert.equal(delivered[1]!.fileName, "daily-summary.md");
		assert.equal(new TextDecoder().decode(delivered[1]!.bytes), markdownText);

		assert.equal(delivered[2]!.kind, "document");
		assert.equal(delivered[2]!.mimeType, "application/json");
		assert.equal(delivered[2]!.fileName, "document.json");
		assert.equal(new TextDecoder().decode(delivered[2]!.bytes), '{"ok":true}');
	});

	it("rejects missing or multiple content sources, invalid base64, and unknown blob handles", async () => {
		const delivered: OutboundMediaPayload[] = [];
		const results = await runSendMediaThroughHost({
			calls: [
				{
					name: SEND_MEDIA_TOOL,
					args: { kind: "document", fileName: "empty.txt" },
				},
				{
					name: SEND_MEDIA_TOOL,
					args: {
						kind: "document",
						blobHandle: "$jehee_blob:abc",
						textContent: "conflict",
					},
				},
				{
					name: SEND_MEDIA_TOOL,
					args: {
						kind: "photo",
						base64: "%%%not-valid-base64%%%",
						mimeType: "image/png",
					},
				},
				{
					name: SEND_MEDIA_TOOL,
					args: {
						kind: "photo",
						blobHandle: "$jehee_blob:missing123",
					},
				},
			],
			resolveBlob: () => undefined,
			deliverMedia: async (payload) => {
				delivered.push(payload);
				return { ok: true, route: "telegram:1001" };
			},
		});

		assert.equal(delivered.length, 0);
		assert.equal(results.length, 4);
		for (const res of results) {
			assert.equal(res.isError, true);
		}
		assert.equal((JSON.parse(results[0]!.text) as { error: string }).error, "invalid_source");
		assert.equal((JSON.parse(results[1]!.text) as { error: string }).error, "invalid_source");
		assert.equal((JSON.parse(results[2]!.text) as { error: string }).error, "invalid_base64");
		assert.equal((JSON.parse(results[3]!.text) as { error: string }).error, "blob_not_found");
	});

	it("enforces maxBytes cap across base64, textContent, and blobHandle payloads", async () => {
		const vault = new McpBlobVault();
		const bigBytes = new Uint8Array(64).fill(0x41);
		const bigBase64 = Buffer.from(bigBytes).toString("base64");
		const bigBlob = vault.storeBase64(bigBase64, "image/png");

		const delivered: OutboundMediaPayload[] = [];
		const results = await runSendMediaThroughHost({
			maxBytes: 32,
			calls: [
				{
					name: SEND_MEDIA_TOOL,
					args: { kind: "photo", base64: bigBase64, mimeType: "image/png" },
				},
				{
					name: SEND_MEDIA_TOOL,
					args: { kind: "photo", blobHandle: bigBlob.handle },
				},
				{
					name: SEND_MEDIA_TOOL,
					args: { kind: "document", textContent: "X".repeat(40), fileName: "too-big.txt" },
				},
			],
			resolveBlob: (handle) => vault.getBlob(handle),
			deliverMedia: async (payload) => {
				delivered.push(payload);
				return { ok: true, route: "telegram:1001" };
			},
		});

		assert.equal(delivered.length, 0);
		assert.equal(results.length, 3);
		for (const res of results) {
			assert.equal(res.isError, true);
			assert.equal((JSON.parse(res.text) as { error: string }).error, "payload_too_large");
		}
	});

	it("rejects non-raster MIME types for photo delivery while allowing them as documents", async () => {
		const svgBytes = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
		const svgBase64 = Buffer.from(svgBytes).toString("base64");
		const pdfBase64 = Buffer.from("%PDF-1.4\n%%EOF\n", "utf8").toString("base64");

		const delivered: OutboundMediaPayload[] = [];
		const results = await runSendMediaThroughHost({
			calls: [
				{
					name: SEND_MEDIA_TOOL,
					args: { kind: "photo", base64: svgBase64, mimeType: "image/svg+xml" },
				},
				{
					name: SEND_MEDIA_TOOL,
					args: { kind: "photo", base64: pdfBase64, mimeType: "application/pdf" },
				},
				{
					name: SEND_MEDIA_TOOL,
					args: { kind: "photo", textContent: "plain text cannot be a photo" },
				},
				{
					name: SEND_MEDIA_TOOL,
					args: { kind: "document", base64: pdfBase64, mimeType: "application/pdf", fileName: "invoice.pdf" },
				},
			],
			deliverMedia: async (payload) => {
				delivered.push(payload);
				return { ok: true, route: "telegram:1001" };
			},
		});

		assert.equal(results.length, 4);
		assert.equal(results[0]!.isError, true);
		assert.equal((JSON.parse(results[0]!.text) as { error: string }).error, "unsupported_photo_mime");
		assert.equal(results[1]!.isError, true);
		assert.equal((JSON.parse(results[1]!.text) as { error: string }).error, "unsupported_photo_mime");
		assert.equal(results[2]!.isError, true);
		assert.equal((JSON.parse(results[2]!.text) as { error: string }).error, "unsupported_photo_mime");

		assert.equal(results[3]!.isError, false);
		assert.equal(delivered.length, 1);
		assert.equal(delivered[0]!.kind, "document");
		assert.equal(delivered[0]!.fileName, "invoice.pdf");
	});

	it("propagates channel delivery failures and thrown transport errors cleanly with isError: true", async () => {
		let attempt = 0;
		const results = await runSendMediaThroughHost({
			calls: [
				{
					name: SEND_MEDIA_TOOL,
					args: { kind: "document", textContent: "hello", fileName: "a.txt" },
				},
				{
					name: SEND_MEDIA_TOOL,
					args: { kind: "document", textContent: "world", fileName: "b.txt" },
				},
			],
			deliverMedia: async () => {
				attempt += 1;
				if (attempt === 1) {
					return { ok: false, reason: "Active channel route does not support outbound document delivery." };
				}
				throw new Error("Telegram API 502 Bad Gateway");
			},
		});

		assert.equal(results.length, 2);
		assert.equal(results[0]!.isError, true);
		const first = JSON.parse(results[0]!.text) as { ok: boolean; error: string; reason: string };
		assert.equal(first.ok, false);
		assert.equal(first.error, "delivery_failed");
		assert.match(first.reason, /does not support outbound document delivery/);

		assert.equal(results[1]!.isError, true);
		const second = JSON.parse(results[1]!.text) as { ok: boolean; error: string; reason: string };
		assert.equal(second.ok, false);
		assert.equal(second.error, "delivery_failed");
		assert.match(second.reason, /502 Bad Gateway/);
	});

	it("sanitizes traversal/dot/control/quote fileNames, catches throwing resolveBlob, and checks textContent length before encoding", async () => {
		const delivered: OutboundMediaPayload[] = [];
		const results = await runSendMediaThroughHost({
			maxBytes: 16,
			calls: [
				{
					name: SEND_MEDIA_TOOL,
					args: { kind: "document", textContent: "ok", fileName: "foo/.." },
				},
				{
					name: SEND_MEDIA_TOOL,
					args: { kind: "document", textContent: "ok", fileName: "." },
				},
				{
					name: SEND_MEDIA_TOOL,
					args: { kind: "document", textContent: "ok", fileName: 'bad"\r\nX-Injected:1\u0000.txt' },
				},
				{
					name: SEND_MEDIA_TOOL,
					args: { kind: "photo", blobHandle: "$jehee_blob:corrupt" },
				},
				{
					name: SEND_MEDIA_TOOL,
					args: { kind: "document", textContent: "中文中文中文中文", fileName: "cjk.txt" },
				},
			],
			resolveBlob: () => {
				throw new Error("corrupt blob encoding");
			},
			deliverMedia: async (payload) => {
				delivered.push(payload);
				return { ok: true, route: "telegram:1001" };
			},
		});

		assert.equal(results.length, 5);
		assert.equal(results[0]!.isError, false);
		assert.equal(results[1]!.isError, false);
		assert.equal(results[2]!.isError, false);
		assert.equal(results[3]!.isError, true);
		assert.equal((JSON.parse(results[3]!.text) as { error: string }).error, "blob_resolve_failed");
		assert.equal(results[4]!.isError, true);
		assert.equal((JSON.parse(results[4]!.text) as { error: string }).error, "payload_too_large");

		assert.equal(delivered.length, 3);
		assert.equal(delivered[0]!.kind, "document");
		assert.equal(delivered[0]!.fileName, "document.txt");
		assert.equal(delivered[1]!.kind, "document");
		assert.equal(delivered[1]!.fileName, "document.txt");
		assert.equal(delivered[2]!.kind, "document");
		assert.equal(delivered[2]!.fileName, "badX-Injected:1.txt");
		assert.equal(/[\r\n\0"']/.test(delivered[2]!.fileName), false);
	});
});
