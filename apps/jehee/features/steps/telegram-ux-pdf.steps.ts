// Cucumber step definitions verifying Slice 6D-2 (ADR-0018):
// 1. Telegram quoted reply (`reply_to_message` / `quote`) & `forward_origin` preservation through ChannelGateway;
// 2. Portable FlateDecode + ToUnicode CMap CJK PDF text extraction via Telegram document attachment;
// 3. `TelegramTransport.setMyCommands` slash command menu registration.

import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ChannelGateway } from "../../src/channels/gateway.ts";
import { JEHEE_TELEGRAM_COMMANDS, parseTelegramUpdate, TelegramTransport } from "../../src/channels/telegram.ts";
import { JeheeHost } from "../../src/core/host.ts";
import type { JeheeWorld } from "../support/world.ts";

let uxGateway: ChannelGateway | undefined;
let uxSeenUserTexts: string[] = [];
let uxRegisteredCommands: Array<{ command: string; description: string }> = [];

async function buildCompressedCjkPdf(): Promise<Uint8Array> {
	const deflate = async (str: string): Promise<Uint8Array> => {
		const cs = new CompressionStream("deflate");
		const writer = cs.writable.getWriter();
		const reader = cs.readable.getReader();
		const writeDone = (async () => {
			await writer.write(new TextEncoder().encode(str));
			await writer.close();
		})();
		const chunks: Uint8Array[] = [];
		let total = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value !== undefined) {
				chunks.push(value);
				total += value.byteLength;
			}
		}
		await writeDone;
		const out = new Uint8Array(total);
		let off = 0;
		for (const c of chunks) {
			out.set(c, off);
			off += c.byteLength;
		}
		return out;
	};

	const cmap = ["begincmap", "2 beginbfchar", "<0001> <673A>", "<0002> <7968>", "endbfchar", "endcmap"].join("\n");
	const content = "BT /F1 12 Tf <00010002> Tj 0 -16 Td (MU5101 PEK->SHA) Tj ET";
	const [zCmap, zContent] = await Promise.all([deflate(cmap), deflate(content)]);
	const enc = new TextEncoder();
	const parts: Uint8Array[] = [
		enc.encode("%PDF-1.7\n1 0 obj << /Resources << /Font << /F1 10 0 R >> >> >> endobj\n"),
		enc.encode("10 0 obj << /Type /Font /ToUnicode 11 0 R >> endobj\n"),
		enc.encode(`11 0 obj << /Filter /FlateDecode /Length ${zCmap.byteLength} >>\nstream\n`),
		zCmap,
		enc.encode("\nendstream\nendobj\n"),
		enc.encode(`20 0 obj << /Filter /FlateDecode /Length ${zContent.byteLength} >>\nstream\n`),
		zContent,
		enc.encode("\nendstream\nendobj\n%%EOF"),
	];
	const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
	const merged = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		merged.set(p, off);
		off += p.byteLength;
	}
	return merged;
}

Given("a ChannelGateway connected to JeheeHost for Telegram UX testing", async function (this: JeheeWorld) {
	uxSeenUserTexts = [];
	const faux = fauxProvider();
	faux.setResponses([
		(ctx) => {
			const lastUser = ctx.messages.findLast((m) => m.role === "user");
			if (lastUser?.role === "user" && typeof lastUser.content === "string") {
				uxSeenUserTexts.push(lastUser.content);
			}
			return fauxAssistantMessage("ack-1");
		},
		(ctx) => {
			const lastUser = ctx.messages.findLast((m) => m.role === "user");
			if (lastUser?.role === "user" && typeof lastUser.content === "string") {
				uxSeenUserTexts.push(lastUser.content);
			}
			return fauxAssistantMessage("ack-2");
		},
	]);
	const models = createModels();
	models.setProvider(faux.provider);

	this.host = await JeheeHost.open(
		{
			storage: { kind: "memory" },
			models,
			defaultModel: { provider: "faux", modelId: faux.getModel().id },
		},
		this.ctx,
	);
	uxGateway = new ChannelGateway({
		host: this.host,
		allowFrom: { telegram: ["ux-owner"] },
	});
	uxGateway.registerTransport({
		channel: "telegram",
		sendText: async () => undefined,
	});
});

Given(
	"a ChannelGateway connected to JeheeHost with a compressed CJK PDF attachment",
	async function (this: JeheeWorld) {
		uxSeenUserTexts = [];
		const pdfBytes = await buildCompressedCjkPdf();
		const faux = fauxProvider();
		faux.setResponses([
			(ctx) => {
				const lastUser = ctx.messages.findLast((m) => m.role === "user");
				if (lastUser?.role === "user" && typeof lastUser.content === "string") {
					uxSeenUserTexts.push(lastUser.content);
				}
				return fauxAssistantMessage("PDF flight parsed.");
			},
		]);
		const models = createModels();
		models.setProvider(faux.provider);

		this.host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
			},
			this.ctx,
		);
		uxGateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: ["ux-owner"] },
		});
		uxGateway.registerTransport({
			channel: "telegram",
			sendText: async () => undefined,
			downloadFile: async () => ({
				bytes: pdfBytes,
				mimeType: "application/pdf",
				fileName: "itinerary.pdf",
			}),
		});
	},
);

When(
	"the owner sends a Telegram message quoting an earlier reply and another message forwarded from a channel",
	async function (this: JeheeWorld) {
		assert.ok(uxGateway);
		const quoted = parseTelegramUpdate({
			update_id: 2001,
			message: {
				message_id: 10,
				from: { id: "ux-owner" },
				chat: { id: "chat-ux", type: "private" },
				text: "改到周五吧",
				reply_to_message: {
					message_id: 5,
					from: { id: 99, is_bot: true, first_name: "Jehee" },
					text: "周四下午 2 点开会",
				},
				quote: { text: "周四下午 2 点" },
			},
		})!;
		const forwarded = parseTelegramUpdate({
			update_id: 2002,
			message: {
				message_id: 11,
				from: { id: "ux-owner" },
				chat: { id: "chat-ux", type: "private" },
				text: "Node 24 LTS released",
				forward_origin: {
					type: "channel",
					date: 1700000000,
					chat: { id: -100999, type: "channel", title: "Runtime Weekly" },
				},
			},
		})!;
		await uxGateway.ingest(quoted, this.ctx);
		await uxGateway.ingest(forwarded, this.ctx);
		uxGateway.dispose();
	},
);

When("the owner sends the PDF document over Telegram", async function (this: JeheeWorld) {
	assert.ok(uxGateway);
	const pdfMsg = parseTelegramUpdate({
		update_id: 2003,
		message: {
			message_id: 12,
			from: { id: "ux-owner" },
			chat: { id: "chat-ux", type: "private" },
			caption: "提取航班号",
			document: { file_id: "cjk-pdf", file_name: "itinerary.pdf", mime_type: "application/pdf" },
		},
	})!;
	await uxGateway.ingest(pdfMsg, this.ctx);
	uxGateway.dispose();
});

When("TelegramTransport registers the default Jehee bot command menu", async () => {
	uxRegisteredCommands = [];
	const transport = new TelegramTransport({
		botToken: "bdd-tok",
		fetchImpl: async (_input, init) => {
			const parsed = JSON.parse(String(init?.body)) as {
				commands: Array<{ command: string; description: string }>;
			};
			uxRegisteredCommands = parsed.commands;
			return Response.json({ ok: true, result: true });
		},
	});
	await transport.setMyCommands();
});

Then("Jehee should receive both the quoted excerpt and the forwarded channel attribution in context", () => {
	assert.equal(uxSeenUserTexts.length, 2);
	assert.ok(uxSeenUserTexts[0]!.includes("Quoted excerpt Jehee (assistant) msg #5: 周四下午 2 点"));
	assert.ok(uxSeenUserTexts[0]!.includes("改到周五吧"));
	assert.ok(uxSeenUserTexts[1]!.includes('[Forwarded from channel "Runtime Weekly"'));
	assert.ok(uxSeenUserTexts[1]!.includes("Node 24 LTS released"));
});

Then("Jehee should receive the extracted Chinese and Latin PDF text in context", () => {
	assert.equal(uxSeenUserTexts.length, 1);
	assert.ok(uxSeenUserTexts[0]!.includes("[PDF Document: itinerary.pdf"));
	assert.ok(uxSeenUserTexts[0]!.includes("机票"));
	assert.ok(uxSeenUserTexts[0]!.includes("MU5101 PEK->SHA"));
});

Then("Telegram Bot API setMyCommands should receive all 11 valid Jehee slash commands", () => {
	assert.equal(uxRegisteredCommands.length, 11);
	assert.equal(uxRegisteredCommands.length, JEHEE_TELEGRAM_COMMANDS.length);
	for (const cmd of uxRegisteredCommands) {
		assert.match(cmd.command, /^[a-z0-9_]{1,32}$/);
		assert.ok(cmd.description.length >= 3);
	}
});
