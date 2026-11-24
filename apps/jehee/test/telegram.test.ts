// Unit tests for pure Telegram webhook verification, update parsing, 4096-character chunking,
// AbortSignal propagation in polling, and `/stop` cancellation of pending debounce buckets.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	formatInboundAttachmentsContext,
	parseTelegramUpdate,
	pollTelegramUpdatesOnce,
	splitTelegramText,
	TelegramTransport,
	verifyTelegramSecretToken,
} from "../src/channels/telegram.ts";
import { ChannelGateway, JeheeHost } from "../src/index.ts";
import { runTelegramPollingDaemon } from "../src/runtime/node.ts";

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

	it("admits callback_query updates non-blockingly via pollTelegramUpdatesOnce and runs daemon retry loop until aborted", async () => {
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("daemon reply")]);
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
		const sentTexts: string[] = [];
		const answeredCallbacks: string[] = [];
		const gateway = new ChannelGateway({ host, allowFrom: { telegram: ["owner-1"] } });
		gateway.registerTransport(
			new TelegramTransport({
				botToken: "tok",
				fetchImpl: async (input, init) => {
					const url = String(input);
					const body = JSON.parse(String(init?.body)) as { text?: string; callback_query_id?: string };
					if (url.endsWith("/sendMessage") && body.text !== undefined) {
						sentTexts.push(body.text);
					}
					if (url.endsWith("/answerCallbackQuery") && body.callback_query_id !== undefined) {
						answeredCallbacks.push(body.callback_query_id);
					}
					return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
				},
			}),
		);

		try {
			// 1. Non-blocking callback_query polling updates offset immediately.
			const cbOffset = await pollTelegramUpdatesOnce(
				{
					botToken: "tok",
					gateway,
					fetchImpl: async () =>
						Response.json({
							ok: true,
							result: [
								{
									update_id: 500,
									callback_query: {
										id: "cb-poll-1",
										from: { id: "owner-1" },
										message: { message_id: 12, chat: { id: "chat-1", type: "private" } },
										data: "apv:no:missing_ticket",
									},
								},
							],
						}),
				},
				BACKGROUND_CONTEXT,
			);
			await gateway.drain();
			assert.equal(cbOffset, 501);
			assert.deepEqual(answeredCallbacks, ["cb-poll-1"]);

			// 2. Daemon retries past transient 500 error, carries offset forward, and stops on AbortSignal.
			const controller = new AbortController();
			let pollCount = 0;
			const observedOffsets: Array<number | undefined> = [];
			await runTelegramPollingDaemon(
				{
					botToken: "tok",
					gateway,
					signal: controller.signal,
					retryDelayMs: 5,
					fetchImpl: async (_input, init) => {
						pollCount += 1;
						const body = JSON.parse(String(init?.body)) as { offset?: number };
						observedOffsets.push(body.offset);
						if (pollCount === 1) {
							return new Response("upstream error", { status: 500 });
						}
						if (pollCount === 2) {
							return Response.json({
								ok: true,
								result: [
									{
										update_id: 600,
										message: {
											message_id: 1,
											from: { id: "owner-1" },
											chat: { id: "chat-1", type: "private" },
											text: "daemon ping",
										},
									},
								],
							});
						}
						controller.abort();
						return Response.json({ ok: true, result: [] });
					},
				},
				BACKGROUND_CONTEXT,
			);
			await gateway.drain();
			assert.deepEqual(observedOffsets, [undefined, undefined, 601]);
			assert.ok(sentTexts.includes("daemon reply"));
		} finally {
			gateway.dispose();
			await host.close(BACKGROUND_CONTEXT);
			await gateway.drain();
		}
	});

	it("invokes fetch without binding `this` to the TelegramTransport instance (Cloudflare Workers compatibility)", async () => {
		const calls: string[] = [];
		async function strictFetch(this: unknown, input: string | URL | Request): Promise<Response> {
			if (this !== undefined) {
				throw new TypeError("Illegal invocation");
			}
			const url = String(input);
			calls.push(url);
			if (url.endsWith("/getFile")) {
				return Response.json({
					ok: true,
					result: { file_id: "f-strict", file_size: 4, file_path: "photos/strict.png" },
				});
			}
			if (url.includes("/file/bot")) {
				return new Response(new Uint8Array([1, 2, 3, 4]), {
					status: 200,
					headers: { "content-type": "image/png" },
				});
			}
			return Response.json({ ok: true, result: true });
		}
		const transport = new TelegramTransport({ botToken: "tok", fetchImpl: strictFetch });
		await transport.sendTyping("chat-1");
		await transport.sendText("chat-1", "hello");
		await transport.answerCallback("cb-1", "ok");
		const downloaded = await transport.downloadFile("f-strict", 1024);
		assert.deepEqual([...downloaded.bytes], [1, 2, 3, 4]);
		await transport.sendPhoto("chat-1", {
			bytes: new Uint8Array([1, 2, 3]),
			mimeType: "image/png",
			caption: "strict photo",
		});
		await transport.sendDocument("chat-1", {
			bytes: new TextEncoder().encode("hello"),
			mimeType: "text/plain",
			fileName: "note.txt",
		});
		assert.equal(calls.length, 7);
	});

	it("parses photo, document, voice, and audio updates both with and without captions", () => {
		// 1. Photo without caption: picks largest photo and synthesizes placeholder text.
		const photoNoCaption = parseTelegramUpdate({
			update_id: 101,
			message: {
				message_id: 10,
				date: 1700000100,
				from: { id: 42 },
				chat: { id: 42, type: "private" },
				photo: [
					{ file_id: "small", width: 90, height: 90, file_size: 1200 },
					{ file_id: "large", width: 1280, height: 720, file_size: 84000 },
					{ file_id: "medium", width: 320, height: 240, file_size: 12000 },
				],
			},
		});
		assert.ok(photoNoCaption !== undefined);
		assert.equal(photoNoCaption.text, "[User sent a photo]");
		assert.deepEqual(photoNoCaption.attachments, [
			{ kind: "image", fileId: "large", mimeType: "image/jpeg", sizeBytes: 84000 },
		]);

		// 2. Photo with caption preserves caption and picks largest by pixel area when file_size is absent.
		const photoWithCaption = parseTelegramUpdate({
			update_id: 102,
			message: {
				message_id: 11,
				date: 1700000101,
				from: { id: 42 },
				chat: { id: 42, type: "private" },
				caption: "What error is on this screen?",
				photo: [
					{ file_id: "p1", width: 100, height: 100 },
					{ file_id: "p2", width: 800, height: 600 },
				],
			},
		});
		assert.ok(photoWithCaption !== undefined);
		assert.equal(photoWithCaption.text, "What error is on this screen?");
		assert.deepEqual(photoWithCaption.attachments, [{ kind: "image", fileId: "p2", mimeType: "image/jpeg" }]);

		// 3. Document without caption keeps filename and synthesizes placeholder.
		const docNoCaption = parseTelegramUpdate({
			update_id: 103,
			message: {
				message_id: 12,
				date: 1700000102,
				from: { id: 42 },
				chat: { id: 42, type: "private" },
				document: {
					file_id: "doc-1",
					file_name: "report.csv",
					mime_type: "text/csv",
					file_size: 2048,
				},
			},
		});
		assert.ok(docNoCaption !== undefined);
		assert.equal(docNoCaption.text, "[User sent a document: report.csv]");
		assert.deepEqual(docNoCaption.attachments, [
			{ kind: "document", fileId: "doc-1", mimeType: "text/csv", fileName: "report.csv", sizeBytes: 2048 },
		]);

		// 4. Voice without caption preserves duration and default audio/ogg mimeType.
		const voiceNoCaption = parseTelegramUpdate({
			update_id: 104,
			message: {
				message_id: 13,
				date: 1700000103,
				from: { id: 42 },
				chat: { id: 42, type: "private" },
				voice: { file_id: "voice-1", duration: 14, file_size: 19000 },
			},
		});
		assert.ok(voiceNoCaption !== undefined);
		assert.equal(voiceNoCaption.text, "[User sent a voice message (14s)]");
		assert.deepEqual(voiceNoCaption.attachments, [
			{ kind: "voice", fileId: "voice-1", mimeType: "audio/ogg", durationSeconds: 14, sizeBytes: 19000 },
		]);

		// 5. Audio with caption preserves metadata.
		const audioWithCaption = parseTelegramUpdate({
			update_id: 105,
			message: {
				message_id: 14,
				date: 1700000104,
				from: { id: 42 },
				chat: { id: 42, type: "private" },
				caption: "Meeting recording",
				audio: {
					file_id: "aud-1",
					duration: 95,
					file_name: "standup.mp3",
					mime_type: "audio/mpeg",
					file_size: 420000,
				},
			},
		});
		assert.ok(audioWithCaption !== undefined);
		assert.equal(audioWithCaption.text, "Meeting recording");
		assert.deepEqual(audioWithCaption.attachments, [
			{
				kind: "audio",
				fileId: "aud-1",
				mimeType: "audio/mpeg",
				fileName: "standup.mp3",
				sizeBytes: 420000,
				durationSeconds: 95,
			},
		]);
	});

	it("downloads Telegram files with inferred MIME type and enforces maxBytes on both metadata and streamed body", async () => {
		const requestedUrls: string[] = [];
		const payloadBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
		const transport = new TelegramTransport({
			botToken: "secret-tok",
			apiBaseUrl: "https://mock.telegram.test",
			fetchImpl: async (input) => {
				const url = String(input);
				requestedUrls.push(url);
				if (url.endsWith("/getFile")) {
					return Response.json({
						ok: true,
						result: { file_id: "photo-1", file_size: payloadBytes.byteLength, file_path: "photos/snap.png" },
					});
				}
				return new Response(payloadBytes, {
					status: 200,
					headers: { "content-type": "application/octet-stream" },
				});
			},
		});

		const file = await transport.downloadFile("photo-1", 1024);
		assert.deepEqual([...file.bytes], [...payloadBytes]);
		assert.equal(file.mimeType, "image/png");
		assert.equal(file.fileName, "snap.png");
		assert.deepEqual(requestedUrls, [
			"https://mock.telegram.test/botsecret-tok/getFile",
			"https://mock.telegram.test/file/botsecret-tok/photos/snap.png",
		]);

		// Rejects before downloading when getFile reports file_size > maxBytes.
		let secondCallCount = 0;
		const metaGuardTransport = new TelegramTransport({
			botToken: "tok",
			fetchImpl: async (input) => {
				secondCallCount += 1;
				if (String(input).endsWith("/getFile")) {
					return Response.json({
						ok: true,
						result: { file_id: "huge", file_size: 5000, file_path: "docs/huge.bin" },
					});
				}
				throw new Error("should not fetch file body when metadata exceeds maxBytes");
			},
		});
		await assert.rejects(() => metaGuardTransport.downloadFile("huge", 1000), /exceeds limit/);
		assert.equal(secondCallCount, 1);

		// Rejects mid-stream when actual bytes exceed maxBytes despite omitted file_size / content-length.
		const streamGuardTransport = new TelegramTransport({
			botToken: "tok",
			fetchImpl: async (input) => {
				if (String(input).endsWith("/getFile")) {
					return Response.json({
						ok: true,
						result: { file_id: "sneaky", file_path: "docs/sneaky.txt" },
					});
				}
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(600));
						controller.enqueue(new Uint8Array(600));
						controller.close();
					},
				});
				return new Response(stream, { status: 200 });
			},
		});
		await assert.rejects(() => streamGuardTransport.downloadFile("sneaky", 1000), /exceeds maximum allowed size/);
	});

	it("sends photos and documents as Web-standard multipart FormData with caption and reply metadata", async () => {
		const captured: Array<{ url: string; form: FormData }> = [];
		const transport = new TelegramTransport({
			botToken: "tok",
			apiBaseUrl: "https://mock.telegram.test",
			fetchImpl: async (input, init) => {
				assert.ok(init?.body instanceof FormData, "expected multipart FormData body");
				captured.push({ url: String(input), form: init.body });
				return Response.json({ ok: true, result: { message_id: 99 } });
			},
		});

		await transport.sendPhoto(
			"chat-9",
			{
				bytes: new Uint8Array([10, 20, 30]),
				mimeType: "image/jpeg",
				caption: "Chart snapshot",
			},
			{
				replyToMessageId: "77",
				buttons: [[{ label: "Open", callbackData: "open:1" }]],
			},
		);

		await transport.sendDocument(
			"chat-9",
			{
				bytes: new TextEncoder().encode("id,score\n1,99\n"),
				mimeType: "text/csv",
				fileName: "scores.csv",
				caption: "Exported CSV",
			},
			{ replyToMessageId: "78" },
		);

		assert.equal(captured.length, 2);
		assert.equal(captured[0]!.url, "https://mock.telegram.test/bottok/sendPhoto");
		assert.equal(captured[0]!.form.get("chat_id"), "chat-9");
		assert.equal(captured[0]!.form.get("caption"), "Chart snapshot");
		assert.equal(captured[0]!.form.get("reply_parameters"), JSON.stringify({ message_id: 77 }));
		assert.equal(
			captured[0]!.form.get("reply_markup"),
			JSON.stringify({ inline_keyboard: [[{ text: "Open", callback_data: "open:1" }]] }),
		);
		const photoPart = captured[0]!.form.get("photo");
		assert.ok(photoPart instanceof File);
		assert.equal(photoPart.name, "photo.jpg");
		assert.equal(photoPart.type, "image/jpeg");
		assert.deepEqual([...new Uint8Array(await photoPart.arrayBuffer())], [10, 20, 30]);

		assert.equal(captured[1]!.url, "https://mock.telegram.test/bottok/sendDocument");
		assert.equal(captured[1]!.form.get("chat_id"), "chat-9");
		assert.equal(captured[1]!.form.get("caption"), "Exported CSV");
		const docPart = captured[1]!.form.get("document");
		assert.ok(docPart instanceof File);
		assert.equal(docPart.name, "scores.csv");
		assert.equal(docPart.type, "text/csv");
		assert.equal(await docPart.text(), "id,score\n1,99\n");
	});

	it("formats downloaded inbound attachments into pi-ai ImageContent blocks, bounded text excerpts, and graceful notices", () => {
		const imgBytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello" -> "SGVsbG8="
		const jsonBytes = new TextEncoder().encode('{"service":"jehee","status":"healthy"}');
		const longMdBytes = new TextEncoder().encode(`# Notes\n${"x".repeat(400)}`);
		const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

		const formatted = formatInboundAttachmentsContext(
			[
				{ kind: "image", fileId: "img-1", mimeType: "image/png" },
				{ kind: "document", fileId: "doc-json", fileName: "status.json", mimeType: "application/json" },
				{ kind: "document", fileId: "doc-md", fileName: "notes.md", mimeType: "text/markdown" },
				{ kind: "document", fileId: "doc-pdf", fileName: "invoice.pdf", mimeType: "application/pdf" },
				{ kind: "voice", fileId: "voice-1", mimeType: "audio/ogg", durationSeconds: 8 },
				{ kind: "document", fileId: "missing-1", fileName: "too-big.csv", mimeType: "text/csv" },
			],
			new Map([
				["img-1", { bytes: imgBytes, mimeType: "image/png", fileName: "snap.png" }],
				["doc-json", { bytes: jsonBytes, mimeType: "application/json", fileName: "status.json" }],
				["doc-md", { bytes: longMdBytes, mimeType: "text/markdown", fileName: "notes.md" }],
				["doc-pdf", { bytes: pdfBytes, mimeType: "application/pdf", fileName: "invoice.pdf" }],
			]),
			{ maxTextChars: 220 },
		);

		assert.deepEqual(formatted.images, [{ type: "image", data: "SGVsbG8=", mimeType: "image/png" }]);
		assert.equal(formatted.textNotes.length, 5);
		assert.match(formatted.textNotes[0]!, /\[Document: status\.json \(application\/json, 38 bytes\)\]/);
		assert.match(formatted.textNotes[0]!, /"service":"jehee"/);
		assert.match(formatted.textNotes[1]!, /\[Document: notes\.md \(text\/markdown/);
		assert.match(formatted.textNotes[1]!, /\.\.\.\[truncated\]$/);
		assert.match(formatted.textNotes[2]!, /\[Binary attachment: invoice\.pdf \(application\/pdf, 4 bytes\)/);
		assert.match(formatted.textNotes[3]!, /\[Voice message: audio\/ogg, 8s/);
		assert.match(formatted.textNotes[4]!, /\[Attachment unavailable \(document\): too-big\.csv/);

		// Prefers concrete downloaded MIME (e.g. image/png) over parseTelegramUpdate's default image/jpeg,
		// and routes image/svg+xml through readable text excerpts instead of raster ImageContent.
		const parsedPhoto = parseTelegramUpdate({
			update_id: 201,
			message: {
				message_id: 55,
				date: 1700000200,
				from: { id: 42 },
				chat: { id: 42, type: "private" },
				photo: [{ file_id: "tg-png-photo", width: 640, height: 480 }],
			},
		});
		assert.ok(parsedPhoto?.attachments !== undefined);
		const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><text>Hi</text></svg>');
		const refined = formatInboundAttachmentsContext(
			[
				...parsedPhoto.attachments,
				{ kind: "image", fileId: "svg-1", fileName: "diagram.svg", mimeType: "image/svg+xml" },
			],
			{
				"tg-png-photo": { bytes: imgBytes, mimeType: "image/png", fileName: "photo.png" },
				"svg-1": { bytes: svgBytes, mimeType: "image/svg+xml", fileName: "diagram.svg" },
			},
		);
		assert.deepEqual(refined.images, [{ type: "image", data: "SGVsbG8=", mimeType: "image/png" }]);
		assert.equal(refined.textNotes.length, 1);
		assert.match(refined.textNotes[0]!, /\[Document: diagram\.svg \(image\/svg\+xml/);
		assert.match(refined.textNotes[0]!, /<text>Hi<\/text>/);
	});

	it("preserves attachments across ChannelGateway debounced coalescing while isolating per-file download errors", async () => {
		const faux = fauxProvider();
		const seenUserMessages: Array<{
			readonly texts: readonly string[];
			readonly images: readonly { readonly data: string; readonly mimeType: string }[];
		}> = [];

		faux.setResponses([
			(ctx) => {
				const lastUser = ctx.messages.findLast((m) => m.role === "user");
				const texts: string[] = [];
				const images: Array<{ data: string; mimeType: string }> = [];
				if (lastUser?.role === "user") {
					if (typeof lastUser.content === "string") {
						texts.push(lastUser.content);
					} else {
						for (const part of lastUser.content) {
							if (part.type === "text") texts.push(part.text);
							if (part.type === "image") images.push({ data: part.data, mimeType: part.mimeType });
						}
					}
				}
				seenUserMessages.push({ texts, images });
				return fauxAssistantMessage("coalesced multimodal ok");
			},
		]);

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

		const sentTexts: string[] = [];
		const imgBytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello" -> "SGVsbG8="
		const gateway = new ChannelGateway({
			host,
			allowFrom: { telegram: ["owner-mm"] },
			debounceMs: 25,
		});
		gateway.registerTransport({
			channel: "telegram",
			sendText: async (_chatId, text) => {
				sentTexts.push(text);
			},
			downloadFile: async (fileId) => {
				if (fileId === "ok-img") {
					return { bytes: imgBytes, mimeType: "image/png", fileName: "shot.png" };
				}
				if (fileId === "ok-doc") {
					return {
						bytes: new TextEncoder().encode("release=v6b"),
						mimeType: "text/plain",
						fileName: "meta.txt",
					};
				}
				throw new Error("upstream 500");
			},
		});

		try {
			const m1 = parseTelegramUpdate({
				update_id: 901,
				message: {
					message_id: 1,
					date: 1700000900,
					from: { id: "owner-mm" },
					chat: { id: "chat-mm", type: "private" },
					photo: [{ file_id: "ok-img", width: 800, height: 600 }],
				},
			})!;
			const m2 = {
				channel: "telegram",
				chatId: "chat-mm",
				senderId: "owner-mm",
				messageId: "2",
				text: "请结合附件检查",
				timestampMs: Date.now() + 5,
				attachments: [
					{ kind: "document" as const, fileId: "ok-doc", fileName: "meta.txt", mimeType: "text/plain" },
					{ kind: "document" as const, fileId: "bad-doc", fileName: "broken.txt", mimeType: "text/plain" },
				],
			};

			const [r1, r2] = await Promise.all([
				gateway.ingest(m1, BACKGROUND_CONTEXT),
				gateway.ingest(m2, BACKGROUND_CONTEXT),
			]);
			assert.deepEqual(r1, { kind: "replied", replyText: "coalesced multimodal ok" });
			assert.deepEqual(r2, { kind: "replied", replyText: "coalesced multimodal ok" });
			assert.equal(seenUserMessages.length, 1);
			assert.deepEqual(seenUserMessages[0]!.images, [{ data: "SGVsbG8=", mimeType: "image/png" }]);
			const joined = seenUserMessages[0]!.texts.join("\n");
			assert.ok(joined.includes("release=v6b"));
			assert.ok(joined.includes("Attachment download failed (document): broken.txt — upstream 500"));
			assert.deepEqual(sentTexts, ["coalesced multimodal ok"]);
		} finally {
			gateway.dispose();
			await host.close(BACKGROUND_CONTEXT);
			await gateway.drain();
		}
	});
});
