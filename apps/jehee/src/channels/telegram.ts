// Zero-dependency Web-standard Telegram Bot adapter compatible with both Cloudflare Workers (Webhook) and Node 24 (polling/Webhook).

import type { Context } from "@earendil-works/chord/context";
import type { ChannelSendOptions, ChannelTransport, InboundChannelMessage } from "./contract.ts";
import type { ChannelGateway } from "./gateway.ts";

/** Telegram's hard per-message limit in UTF-16 code units. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** Minimal subset of Telegram's Update JSON payload consumed by Jehee. */
export type TelegramUpdate = {
	readonly update_id: number;
	readonly message?: {
		readonly message_id: number | string;
		readonly date?: number;
		readonly from?: {
			readonly id: number | string;
			readonly username?: string;
		};
		readonly chat: {
			readonly id: number | string;
			readonly type: string;
		};
		readonly text?: string;
		readonly caption?: string;
	};
};

/** Options for constructing a TelegramTransport. */
export type TelegramTransportOptions = {
	readonly botToken: string;
	readonly apiBaseUrl?: string;
	readonly fetchImpl?: typeof fetch;
	readonly channelName?: string;
};

/** Splits long reply text into chunks <= `maxLength`, preferring paragraph and line breaks over mid-line cuts. */
export function splitTelegramText(text: string, maxLength: number = TELEGRAM_MAX_MESSAGE_LENGTH): readonly string[] {
	if (text.length <= maxLength) return [text];
	const chunks: string[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const remaining = text.length - cursor;
		if (remaining <= maxLength) {
			chunks.push(text.slice(cursor));
			break;
		}
		const slice = text.slice(cursor, cursor + maxLength);
		const doubleNewline = slice.lastIndexOf("\n\n");
		const singleNewline = slice.lastIndexOf("\n");
		const minBreakPos = Math.floor(maxLength * 0.5);
		const cutOffset =
			doubleNewline >= minBreakPos
				? doubleNewline + 2
				: singleNewline >= minBreakPos
					? singleNewline + 1
					: maxLength;
		chunks.push(text.slice(cursor, cursor + cutOffset));
		cursor += cutOffset;
	}
	return chunks;
}

/** Constant-time byte comparison for `X-Telegram-Bot-Api-Secret-Token` header verification across Node and Edge runtimes. */
export function verifyTelegramSecretToken(expectedSecret: string | undefined, receivedHeader: string | null): boolean {
	if (expectedSecret === undefined || expectedSecret.length === 0) return true;
	if (receivedHeader === null) return false;
	const enc = new TextEncoder();
	const a = enc.encode(expectedSecret);
	const b = enc.encode(receivedHeader);
	if (a.byteLength !== b.byteLength) return false;
	let diff = 0;
	for (let i = 0; i < a.byteLength; i++) {
		diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	}
	return diff === 0;
}

/** Converts a raw Telegram Update into a normalized InboundChannelMessage, or `undefined` for non-text updates. */
export function parseTelegramUpdate(
	update: TelegramUpdate,
	channelName: string = "telegram",
): InboundChannelMessage | undefined {
	const msg = update.message;
	if (msg === undefined || msg.from === undefined) return undefined;
	const body = msg.text ?? msg.caption;
	if (body === undefined || body.trim().length === 0) return undefined;
	return {
		channel: channelName,
		chatId: String(msg.chat.id),
		senderId: String(msg.from.id),
		messageId: String(msg.message_id),
		text: body,
		timestampMs: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
	};
}

/** Pure fetch-based Telegram Bot API outbound transport. */
export class TelegramTransport implements ChannelTransport {
	readonly channel: string;
	readonly #baseUrl: string;
	readonly #fetch: typeof fetch;

	constructor(options: TelegramTransportOptions) {
		this.channel = options.channelName ?? "telegram";
		const apiRoot = (options.apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
		this.#baseUrl = `${apiRoot}/bot${options.botToken}`;
		this.#fetch = options.fetchImpl ?? globalThis.fetch;
	}

	/** Sends a text reply, automatically chunking payloads past Telegram's 4096-character limit. */
	async sendText(chatId: string, text: string, options?: ChannelSendOptions): Promise<void> {
		const parts = splitTelegramText(text);
		for (let idx = 0; idx < parts.length; idx++) {
			const part = parts[idx]!;
			const payload: Record<string, unknown> = {
				chat_id: chatId,
				text: part,
			};
			if (idx === 0 && options?.replyToMessageId !== undefined) {
				const numericReplyId = Number(options.replyToMessageId);
				if (Number.isInteger(numericReplyId)) {
					payload.reply_parameters = { message_id: numericReplyId };
				}
			}
			const response = await this.#fetch(`${this.#baseUrl}/sendMessage`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			if (!response.ok) {
				const detail = await response.text();
				throw new Error(`Telegram sendMessage failed (${response.status}): ${detail}`);
			}
		}
	}

	/** Sends a non-fatal typing indicator before model generation begins. */
	async sendTyping(chatId: string): Promise<void> {
		await this.#fetch(`${this.#baseUrl}/sendChatAction`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, action: "typing" }),
		}).catch(() => undefined);
	}
}

/** Handles an incoming Web-standard Webhook Request (directly usable in Cloudflare Workers or Node HTTP servers). */
export async function handleTelegramWebhook(
	request: Request,
	options: {
		readonly gateway: ChannelGateway;
		readonly secretToken?: string;
		readonly channelName?: string;
	},
	context: Context,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", { status: 405 });
	}
	const headerSecret = request.headers.get("x-telegram-bot-api-secret-token");
	if (!verifyTelegramSecretToken(options.secretToken, headerSecret)) {
		return new Response("Unauthorized", { status: 401 });
	}
	const update = (await request.json()) as TelegramUpdate;
	const inbound = parseTelegramUpdate(update, options.channelName);
	if (inbound !== undefined) {
		await options.gateway.ingest(inbound, context);
	}
	return new Response("ok", { status: 200 });
}

/** Polls Telegram `getUpdates` once and forwards all parsed messages into `gateway`, returning the next `offset`. */
export async function pollTelegramUpdatesOnce(
	options: {
		readonly botToken: string;
		readonly gateway: ChannelGateway;
		readonly offset?: number;
		readonly timeoutSeconds?: number;
		readonly apiBaseUrl?: string;
		readonly fetchImpl?: typeof fetch;
		readonly channelName?: string;
	},
	context: Context,
): Promise<number | undefined> {
	const fetchFn = options.fetchImpl ?? globalThis.fetch;
	const apiRoot = (options.apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
	const response = await fetchFn(`${apiRoot}/bot${options.botToken}/getUpdates`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			...(options.offset !== undefined ? { offset: options.offset } : {}),
			timeout: options.timeoutSeconds ?? 25,
			allowed_updates: ["message"],
		}),
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Telegram getUpdates failed (${response.status}): ${detail}`);
	}
	const body = (await response.json()) as {
		readonly ok: boolean;
		readonly result?: readonly TelegramUpdate[];
	};
	let nextOffset = options.offset;
	for (const update of body.result ?? []) {
		nextOffset = update.update_id + 1;
		const inbound = parseTelegramUpdate(update, options.channelName);
		if (inbound !== undefined) {
			await options.gateway.ingest(inbound, context);
		}
	}
	return nextOffset;
}
