// Zero-dependency Web-standard Telegram Bot adapter compatible with both Cloudflare Workers (Webhook) and Node 24 (polling/Webhook).

import type { Context } from "@earendil-works/chord/context";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
	ChannelAttachment,
	ChannelSendOptions,
	ChannelTransport,
	DownloadedChannelFile,
	InboundCallbackAction,
	InboundChannelMessage,
	InboundForwardContext,
	InboundReplyContext,
	OutboundDocumentPayload,
	OutboundPhotoPayload,
} from "./contract.ts";
import type { ChannelGateway } from "./gateway.ts";
import { extractPdfText } from "./pdf-text.ts";

/** Telegram's hard per-message limit in UTF-16 code units. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** Telegram's hard per-media caption limit in UTF-16 code units. */
export const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

/** Default maximum byte budget enforced by `TelegramTransport.downloadFile` (10 MiB). */
export const TELEGRAM_DEFAULT_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/** Default maximum characters emitted for decoded text document excerpts in `formatInboundAttachmentsContext`. */
export const DEFAULT_ATTACHMENT_TEXT_EXCERPT_CHARS = 12_000;

/** Default maximum characters preserved from a quoted/replied-to Telegram message excerpt. */
export const MAX_REPLY_EXCERPT_CHARS = 1_500;

/** Single Telegram Bot API slash command entry accepted by `/setMyCommands`. */
export type TelegramBotCommand = {
	readonly command: string;
	readonly description: string;
};

/** Complete slash command menu registered by Jehee via Telegram's `setMyCommands` API. */
export const JEHEE_TELEGRAM_COMMANDS: readonly TelegramBotCommand[] = [
	{ command: "status", description: "查看运行状态、上下文水位、MCP与暂存队列" },
	{ command: "model", description: "查看或热切换模型（list / <provider/id> / reset）" },
	{ command: "mcp", description: "查看 MCP 服务状态或执行 /mcp reconnect" },
	{ command: "routines", description: "查看、触发或删除定时提醒任务" },
	{ command: "memory", description: "查看、检索、整理或导出长期记忆" },
	{ command: "flush", description: "立即补发静默期暂存的通知汇总" },
	{ command: "handoff", description: "整理记忆并无感开启新上下文窗口" },
	{ command: "trace", description: "查看最近对话的调用链与耗时账单" },
	{ command: "approve", description: "批准待确认的高风险外部写操作" },
	{ command: "reject", description: "拒绝待确认的高风险外部写操作" },
	{ command: "stop", description: "立即中止当前正在执行的任务" },
];

/** Minimal Telegram User object fields consumed by Jehee. */
export type TelegramUser = {
	readonly id: number | string;
	readonly is_bot?: boolean;
	readonly first_name?: string;
	readonly last_name?: string;
	readonly username?: string;
};

/** Minimal Telegram Chat object fields consumed by Jehee. */
export type TelegramChat = {
	readonly id: number | string;
	readonly type: string;
	readonly title?: string;
	readonly username?: string;
};

/** Telegram Bot API 7.0+ `MessageOrigin` discriminated union for forwarded messages. */
export type TelegramForwardOrigin =
	| {
			readonly type: "user";
			readonly date: number;
			readonly sender_user: TelegramUser;
	  }
	| {
			readonly type: "hidden_user";
			readonly date: number;
			readonly sender_user_name: string;
	  }
	| {
			readonly type: "chat";
			readonly date: number;
			readonly sender_chat: TelegramChat;
			readonly author_signature?: string;
	  }
	| {
			readonly type: "channel";
			readonly date: number;
			readonly chat: TelegramChat;
			readonly message_id?: number;
			readonly author_signature?: string;
	  };

/** Subset of a replied-to Telegram message (`message.reply_to_message`). */
export type TelegramReplyMessage = {
	readonly message_id: number | string;
	readonly date?: number;
	readonly from?: TelegramUser;
	readonly text?: string;
	readonly caption?: string;
	readonly photo?: readonly TelegramPhotoSize[];
	readonly document?: TelegramDocument;
	readonly voice?: TelegramVoice;
	readonly audio?: TelegramAudio;
};

/** Subset of Telegram's partial text quote (`message.quote`). */
export type TelegramTextQuote = {
	readonly text: string;
};

/** Telegram photo variant metadata (`PhotoSize`). */
export type TelegramPhotoSize = {
	readonly file_id: string;
	readonly width: number;
	readonly height: number;
	readonly file_size?: number;
};

/** Telegram generic file/document metadata (`Document`). */
export type TelegramDocument = {
	readonly file_id: string;
	readonly file_name?: string;
	readonly mime_type?: string;
	readonly file_size?: number;
};

/** Telegram voice note metadata (`Voice`). */
export type TelegramVoice = {
	readonly file_id: string;
	readonly duration: number;
	readonly mime_type?: string;
	readonly file_size?: number;
};

/** Telegram audio track metadata (`Audio`). */
export type TelegramAudio = {
	readonly file_id: string;
	readonly duration: number;
	readonly file_name?: string;
	readonly mime_type?: string;
	readonly file_size?: number;
};

/** Minimal subset of Telegram's Update JSON payload consumed by Jehee. */
export type TelegramUpdate = {
	readonly update_id: number;
	readonly message?: {
		readonly message_id: number | string;
		readonly date?: number;
		readonly from?: TelegramUser;
		readonly chat: TelegramChat;
		readonly text?: string;
		readonly caption?: string;
		readonly photo?: readonly TelegramPhotoSize[];
		readonly document?: TelegramDocument;
		readonly voice?: TelegramVoice;
		readonly audio?: TelegramAudio;
		readonly reply_to_message?: TelegramReplyMessage;
		readonly quote?: TelegramTextQuote;
		readonly forward_origin?: TelegramForwardOrigin;
		readonly forward_from?: TelegramUser;
		readonly forward_sender_name?: string;
		readonly forward_from_chat?: TelegramChat;
		readonly forward_date?: number;
	};
	readonly callback_query?: {
		readonly id: string;
		readonly from: TelegramUser;
		readonly message?: {
			readonly message_id: number | string;
			readonly chat: TelegramChat;
		};
		readonly data?: string;
	};
};

/** Options for constructing a TelegramTransport. */
export type TelegramTransportOptions = {
	readonly botToken: string;
	readonly apiBaseUrl?: string;
	readonly fetchImpl?: typeof fetch;
	readonly channelName?: string;
};

/** Structured model-ready context produced by `formatInboundAttachmentsContext`. */
export type FormattedInboundAttachments = {
	/** Supplemental text excerpts (for text/JSON/MD/CSV documents) and graceful notices (for voice/audio/binary/unavailable files). */
	readonly textNotes: readonly string[];
	/** Vision-ready `pi-ai` `ImageContent` blocks converted from downloaded image attachments. */
	readonly images: readonly ImageContent[];
};

const EXTENSION_TO_MIME: Readonly<Record<string, string>> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
	svg: "image/svg+xml",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/ogg",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	wav: "audio/wav",
	flac: "audio/flac",
	pdf: "application/pdf",
	txt: "text/plain",
	md: "text/markdown",
	markdown: "text/markdown",
	json: "application/json",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	html: "text/html",
	htm: "text/html",
	xml: "application/xml",
	yaml: "text/yaml",
	yml: "text/yaml",
	log: "text/plain",
	ics: "text/calendar",
};

const MIME_TO_EXTENSION: Readonly<Record<string, string>> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"application/pdf": "pdf",
	"text/plain": "txt",
	"text/markdown": "md",
	"application/json": "json",
	"text/csv": "csv",
};

const READABLE_TEXT_EXTENSIONS = new Set([
	"txt",
	"md",
	"markdown",
	"json",
	"csv",
	"tsv",
	"yaml",
	"yml",
	"xml",
	"html",
	"htm",
	"svg",
	"log",
	"ics",
	"toml",
	"ini",
	"cfg",
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"py",
	"sh",
	"sql",
	"css",
]);

const RASTER_VISION_IMAGE_MIMES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);

function normalizeMimeType(raw: string | null | undefined): string {
	if (raw === null || raw === undefined) return "";
	return raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function getFileExtension(fileNameOrPath: string | undefined): string | undefined {
	if (fileNameOrPath === undefined) return undefined;
	const base = fileNameOrPath.split("/").at(-1) ?? fileNameOrPath;
	const dot = base.lastIndexOf(".");
	if (dot <= 0 || dot === base.length - 1) return undefined;
	return base.slice(dot + 1).toLowerCase();
}

function inferMimeFromPath(filePath: string | undefined): string | undefined {
	const ext = getFileExtension(filePath);
	return ext !== undefined ? EXTENSION_TO_MIME[ext] : undefined;
}

function inferFileNameForMime(prefix: string, mimeType: string): string {
	const normalized = normalizeMimeType(mimeType);
	const ext = MIME_TO_EXTENSION[normalized] ?? "bin";
	return `${prefix}.${ext}`;
}

function isPdfDocument(mimeType: string, fileName: string | undefined): boolean {
	const normalized = normalizeMimeType(mimeType);
	if (normalized === "application/pdf") return true;
	if (normalized.length === 0 || normalized === "application/octet-stream") {
		return getFileExtension(fileName) === "pdf";
	}
	return false;
}

function formatTelegramUserLabel(user: TelegramUser | undefined): string | undefined {
	if (user === undefined) return undefined;
	const fullName = [user.first_name?.trim(), user.last_name?.trim()].filter((p) => p && p.length > 0).join(" ");
	if (fullName.length > 0 && user.username !== undefined && user.username.trim().length > 0) {
		return `${fullName} (@${user.username.trim()})`;
	}
	if (fullName.length > 0) return fullName;
	if (user.username !== undefined && user.username.trim().length > 0) return `@${user.username.trim()}`;
	return `user#${String(user.id)}`;
}

function formatTelegramChatLabel(chat: TelegramChat | undefined): string | undefined {
	if (chat === undefined) return undefined;
	if (chat.title !== undefined && chat.title.trim().length > 0) {
		if (chat.username !== undefined && chat.username.trim().length > 0) {
			return `${chat.title.trim()} (@${chat.username.trim()})`;
		}
		return chat.title.trim();
	}
	if (chat.username !== undefined && chat.username.trim().length > 0) return `@${chat.username.trim()}`;
	return `chat#${String(chat.id)}`;
}

function summarizeReplyAttachments(reply: TelegramReplyMessage): string | undefined {
	const parts: string[] = [];
	if (reply.photo !== undefined && reply.photo.length > 0) parts.push("photo");
	if (reply.document !== undefined) {
		parts.push(reply.document.file_name !== undefined ? `document: ${reply.document.file_name}` : "document");
	}
	if (reply.voice !== undefined) parts.push(`voice (${reply.voice.duration}s)`);
	if (reply.audio !== undefined) {
		parts.push(reply.audio.file_name !== undefined ? `audio: ${reply.audio.file_name}` : "audio");
	}
	return parts.length > 0 ? parts.join(", ") : undefined;
}

function extractTelegramReplyContext(
	reply: TelegramReplyMessage | undefined,
	quote: TelegramTextQuote | undefined,
): InboundReplyContext | undefined {
	const quoteText = quote?.text?.trim();
	if (reply === undefined && (quoteText === undefined || quoteText.length === 0)) {
		return undefined;
	}
	const rawText = quoteText && quoteText.length > 0 ? quoteText : (reply?.text ?? reply?.caption)?.trim();
	const boundedText =
		rawText !== undefined && rawText.length > 0
			? rawText.length > MAX_REPLY_EXCERPT_CHARS
				? `${rawText.slice(0, MAX_REPLY_EXCERPT_CHARS)}...[truncated]`
				: rawText
			: undefined;
	const senderName = formatTelegramUserLabel(reply?.from);
	const attachmentSummary = reply !== undefined ? summarizeReplyAttachments(reply) : undefined;
	if (boundedText === undefined && attachmentSummary === undefined && reply === undefined) {
		return undefined;
	}
	return {
		...(reply !== undefined ? { messageId: String(reply.message_id) } : {}),
		...(senderName !== undefined ? { senderName } : {}),
		...(reply?.from?.is_bot === true ? { isFromAssistant: true } : {}),
		...(boundedText !== undefined ? { text: boundedText } : {}),
		...(quoteText !== undefined && quoteText.length > 0 ? { isPartialQuote: true } : {}),
		...(attachmentSummary !== undefined ? { attachmentSummary } : {}),
	};
}

function extractTelegramForwardContext(msg: NonNullable<TelegramUpdate["message"]>): InboundForwardContext | undefined {
	const origin = msg.forward_origin;
	if (origin !== undefined) {
		const originalTimestampMs = Number.isFinite(origin.date) ? origin.date * 1000 : undefined;
		if (origin.type === "user") {
			return {
				originType: "user",
				originLabel: formatTelegramUserLabel(origin.sender_user) ?? "unknown user",
				...(originalTimestampMs !== undefined ? { originalTimestampMs } : {}),
			};
		}
		if (origin.type === "hidden_user") {
			return {
				originType: "hidden_user",
				originLabel: origin.sender_user_name.trim() || "hidden user",
				...(originalTimestampMs !== undefined ? { originalTimestampMs } : {}),
			};
		}
		if (origin.type === "chat") {
			return {
				originType: "chat",
				originLabel: formatTelegramChatLabel(origin.sender_chat) ?? "unknown chat",
				...(origin.author_signature?.trim() ? { authorSignature: origin.author_signature.trim() } : {}),
				...(originalTimestampMs !== undefined ? { originalTimestampMs } : {}),
			};
		}
		return {
			originType: "channel",
			originLabel: formatTelegramChatLabel(origin.chat) ?? "unknown channel",
			...(origin.author_signature?.trim() ? { authorSignature: origin.author_signature.trim() } : {}),
			...(originalTimestampMs !== undefined ? { originalTimestampMs } : {}),
		};
	}

	const legacyTimestampMs = msg.forward_date !== undefined ? msg.forward_date * 1000 : undefined;
	if (msg.forward_from !== undefined) {
		return {
			originType: "user",
			originLabel: formatTelegramUserLabel(msg.forward_from) ?? "unknown user",
			...(legacyTimestampMs !== undefined ? { originalTimestampMs: legacyTimestampMs } : {}),
		};
	}
	if (msg.forward_sender_name !== undefined && msg.forward_sender_name.trim().length > 0) {
		return {
			originType: "hidden_user",
			originLabel: msg.forward_sender_name.trim(),
			...(legacyTimestampMs !== undefined ? { originalTimestampMs: legacyTimestampMs } : {}),
		};
	}
	if (msg.forward_from_chat !== undefined) {
		return {
			originType: msg.forward_from_chat.type === "channel" ? "channel" : "chat",
			originLabel: formatTelegramChatLabel(msg.forward_from_chat) ?? "unknown chat",
			...(legacyTimestampMs !== undefined ? { originalTimestampMs: legacyTimestampMs } : {}),
		};
	}
	return undefined;
}

/** Formats optional quoted-reply and forwarded-origin metadata into concise context prefix lines for the model. */
export function formatInboundMessageContextPrefix(input: {
	readonly replyContext?: InboundReplyContext;
	readonly forwardContext?: InboundForwardContext;
}): string | undefined {
	const lines: string[] = [];
	if (input.replyContext !== undefined) {
		const rc = input.replyContext;
		const who = rc.isFromAssistant
			? rc.senderName
				? `${rc.senderName} (assistant)`
				: "assistant"
			: (rc.senderName ?? "previous message");
		const msgRef = rc.messageId !== undefined ? ` msg #${rc.messageId}` : "";
		const kind = rc.isPartialQuote ? "Quoted excerpt" : "Replying to";
		const details: string[] = [];
		if (rc.attachmentSummary !== undefined) details.push(`[${rc.attachmentSummary}]`);
		if (rc.text !== undefined) details.push(rc.text);
		const body = details.length > 0 ? `: ${details.join(" ")}` : "";
		lines.push(`[${kind} ${who}${msgRef}${body}]`);
	}
	if (input.forwardContext !== undefined) {
		const fc = input.forwardContext;
		const authorPart = fc.authorSignature !== undefined ? ` by ${fc.authorSignature}` : "";
		const datePart =
			fc.originalTimestampMs !== undefined
				? ` on ${new Date(fc.originalTimestampMs).toISOString().slice(0, 16).replace("T", " ")}Z`
				: "";
		lines.push(`[Forwarded from ${fc.originType} "${fc.originLabel}"${authorPart}${datePart}]`);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function isReadableDocument(mimeType: string, fileName: string | undefined): boolean {
	const normalized = normalizeMimeType(mimeType);
	if (
		normalized.startsWith("text/") ||
		normalized === "application/json" ||
		normalized.endsWith("+json") ||
		normalized === "application/xml" ||
		normalized.endsWith("+xml") ||
		normalized === "image/svg+xml"
	) {
		return true;
	}
	if (normalized.length === 0 || normalized === "application/octet-stream") {
		const ext = getFileExtension(fileName);
		return ext !== undefined && READABLE_TEXT_EXTENSIONS.has(ext);
	}
	return false;
}

function bytesToBase64(bytes: Uint8Array): string {
	// Chunk conversion to stay safe against JS argument-stack limits on multi-megabyte photos in Node & Workers.
	const chunkSize = 0x8000;
	const parts: string[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
		const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
		parts.push(String.fromCharCode(...slice));
	}
	return btoa(parts.join(""));
}

function selectLargestTelegramPhoto(photos: readonly TelegramPhotoSize[]): TelegramPhotoSize | undefined {
	let best: TelegramPhotoSize | undefined;
	for (const candidate of photos) {
		if (best === undefined) {
			best = candidate;
			continue;
		}
		const bestSize = best.file_size;
		const candSize = candidate.file_size;
		if (bestSize !== undefined && candSize !== undefined) {
			if (candSize >= bestSize) best = candidate;
			continue;
		}
		const bestArea = best.width * best.height;
		const candArea = candidate.width * candidate.height;
		if (candArea >= bestArea) {
			best = candidate;
		}
	}
	return best;
}

function synthesizeAttachmentPlaceholder(attachments: readonly ChannelAttachment[]): string {
	const labels = attachments.map((att) => {
		if (att.kind === "image") return "[User sent a photo]";
		if (att.kind === "document") {
			return att.fileName !== undefined ? `[User sent a document: ${att.fileName}]` : "[User sent a document]";
		}
		if (att.kind === "voice") {
			return att.durationSeconds !== undefined
				? `[User sent a voice message (${att.durationSeconds}s)]`
				: "[User sent a voice message]";
		}
		const namePart = att.fileName !== undefined ? `: ${att.fileName}` : "";
		const durPart = att.durationSeconds !== undefined ? ` (${att.durationSeconds}s)` : "";
		return `[User sent an audio file${namePart}${durPart}]`;
	});
	return labels.join(" ");
}

function appendTelegramReplyOptions(form: FormData, options: ChannelSendOptions | undefined): void {
	if (options?.replyToMessageId !== undefined) {
		const numericReplyId = Number(options.replyToMessageId);
		if (Number.isInteger(numericReplyId)) {
			form.append("reply_parameters", JSON.stringify({ message_id: numericReplyId }));
		}
	}
	if (options?.buttons !== undefined && options.buttons.length > 0) {
		form.append(
			"reply_markup",
			JSON.stringify({
				inline_keyboard: options.buttons.map((row) =>
					row.map((btn) => ({ text: btn.label, callback_data: btn.callbackData })),
				),
			}),
		);
	}
}

async function readResponseBytesWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
	if (response.body === null) {
		const buf = new Uint8Array(await response.arrayBuffer());
		if (buf.byteLength > maxBytes) {
			throw new Error(`Telegram file exceeds maximum allowed size (${buf.byteLength} > ${maxBytes} bytes)`);
		}
		return buf;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined || value.byteLength === 0) continue;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new Error(`Telegram file exceeds maximum allowed size (${totalBytes} > ${maxBytes} bytes)`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined;
}

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

/**
 * Converts a raw Telegram Update into a normalized InboundChannelMessage, including photo, document, voice, and audio
 * attachments (synthesizing a concise placeholder text when no caption is provided). Returns `undefined` for updates
 * that contain neither text/caption nor supported media attachments.
 */
export function parseTelegramUpdate(
	update: TelegramUpdate,
	channelName: string = "telegram",
): InboundChannelMessage | undefined {
	const msg = update.message;
	if (msg === undefined || msg.from === undefined) return undefined;

	const attachments: ChannelAttachment[] = [];

	if (msg.photo !== undefined && msg.photo.length > 0) {
		const largest = selectLargestTelegramPhoto(msg.photo);
		if (largest !== undefined) {
			attachments.push({
				kind: "image",
				fileId: largest.file_id,
				mimeType: "image/jpeg",
				...(largest.file_size !== undefined ? { sizeBytes: largest.file_size } : {}),
			});
		}
	}

	if (msg.document !== undefined) {
		attachments.push({
			kind: "document",
			fileId: msg.document.file_id,
			...(msg.document.mime_type !== undefined ? { mimeType: msg.document.mime_type } : {}),
			...(msg.document.file_name !== undefined ? { fileName: msg.document.file_name } : {}),
			...(msg.document.file_size !== undefined ? { sizeBytes: msg.document.file_size } : {}),
		});
	}

	if (msg.voice !== undefined) {
		attachments.push({
			kind: "voice",
			fileId: msg.voice.file_id,
			mimeType: msg.voice.mime_type ?? "audio/ogg",
			durationSeconds: msg.voice.duration,
			...(msg.voice.file_size !== undefined ? { sizeBytes: msg.voice.file_size } : {}),
		});
	}

	if (msg.audio !== undefined) {
		attachments.push({
			kind: "audio",
			fileId: msg.audio.file_id,
			...(msg.audio.mime_type !== undefined ? { mimeType: msg.audio.mime_type } : {}),
			...(msg.audio.file_name !== undefined ? { fileName: msg.audio.file_name } : {}),
			...(msg.audio.file_size !== undefined ? { sizeBytes: msg.audio.file_size } : {}),
			durationSeconds: msg.audio.duration,
		});
	}

	const rawBody = msg.text ?? msg.caption;
	const hasText = rawBody !== undefined && rawBody.trim().length > 0;
	if (!hasText && attachments.length === 0) return undefined;

	const replyContext = extractTelegramReplyContext(msg.reply_to_message, msg.quote);
	const forwardContext = extractTelegramForwardContext(msg);

	return {
		channel: channelName,
		chatId: String(msg.chat.id),
		senderId: String(msg.from.id),
		messageId: String(msg.message_id),
		text: hasText ? rawBody : synthesizeAttachmentPlaceholder(attachments),
		timestampMs: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
		...(attachments.length > 0 ? { attachments } : {}),
		...(replyContext !== undefined ? { replyContext } : {}),
		...(forwardContext !== undefined ? { forwardContext } : {}),
	};
}

/** Converts a raw Telegram `callback_query` Update into a normalized `InboundCallbackAction`, if valid. */
export function parseTelegramCallback(
	update: TelegramUpdate,
	channelName: string = "telegram",
): InboundCallbackAction | undefined {
	const cb = update.callback_query;
	if (cb === undefined || cb.message === undefined || cb.data === undefined || cb.data.trim().length === 0) {
		return undefined;
	}
	return {
		channel: channelName,
		chatId: String(cb.message.chat.id),
		senderId: String(cb.from.id),
		callbackId: String(cb.id),
		messageId: String(cb.message.message_id),
		data: cb.data.trim(),
		timestampMs: Date.now(),
	};
}

/**
 * Pure helper converting normalized inbound attachments and their downloaded bytes into:
 * - `images`: vision-ready `pi-ai` `ImageContent` blocks (`{ type: "image", data, mimeType }`) for image attachments;
 * - `textNotes`: bounded UTF-8 excerpts for text/JSON/MD/CSV documents and graceful notices for voice/audio/binary/missing files.
 */
export function formatInboundAttachmentsContext(
	attachments: readonly ChannelAttachment[],
	downloaded: ReadonlyMap<string, DownloadedChannelFile> | Readonly<Record<string, DownloadedChannelFile>>,
	options?: { readonly maxTextChars?: number },
): FormattedInboundAttachments {
	const maxTextChars = Math.max(200, options?.maxTextChars ?? DEFAULT_ATTACHMENT_TEXT_EXCERPT_CHARS);
	const lookup = (fileId: string): DownloadedChannelFile | undefined =>
		downloaded instanceof Map
			? downloaded.get(fileId)
			: Object.hasOwn(downloaded, fileId)
				? (downloaded as Readonly<Record<string, DownloadedChannelFile>>)[fileId]
				: undefined;

	const images: ImageContent[] = [];
	const textNotes: string[] = [];
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let remainingTextChars = maxTextChars;

	for (const att of attachments) {
		const file = lookup(att.fileId);
		const fallbackName = att.fileName ?? att.fileId;

		if (att.kind === "voice" || att.kind === "audio") {
			const effectiveMime = normalizeMimeType(att.mimeType ?? file?.mimeType) || "audio/ogg";
			const durPart = att.durationSeconds !== undefined ? `, ${att.durationSeconds}s` : "";
			const sizePart =
				file !== undefined
					? `, ${file.bytes.byteLength} bytes`
					: att.sizeBytes !== undefined
						? `, ${att.sizeBytes} bytes`
						: "";
			const label =
				att.kind === "voice" ? "Voice message" : `Audio attachment (${att.fileName ?? file?.fileName ?? "audio"})`;
			textNotes.push(
				`[${label}: ${effectiveMime}${durPart}${sizePart} — automatic speech transcription is not configured; ask the user for text if needed.]`,
			);
			continue;
		}

		if (file === undefined) {
			textNotes.push(`[Attachment unavailable (${att.kind}): ${fallbackName} could not be downloaded.]`);
			continue;
		}

		const fileName = att.fileName ?? file.fileName;
		const attMime = normalizeMimeType(att.mimeType);
		const fileMime = normalizeMimeType(file.mimeType);
		// Prefer concrete MIME observed by `downloadFile` (response headers / `file_path`) over update-level defaults.
		const effectiveMime =
			fileMime.length > 0 && fileMime !== "application/octet-stream"
				? fileMime
				: attMime.length > 0 && attMime !== "application/octet-stream"
					? attMime
					: "application/octet-stream";

		const isRasterImage =
			RASTER_VISION_IMAGE_MIMES.has(effectiveMime) ||
			(att.kind === "image" && effectiveMime === "application/octet-stream");
		if (isRasterImage) {
			const normalizedImageMime =
				effectiveMime === "image/jpg" || effectiveMime === "application/octet-stream"
					? "image/jpeg"
					: effectiveMime;
			images.push({
				type: "image",
				data: bytesToBase64(file.bytes),
				mimeType: normalizedImageMime,
			});
			continue;
		}

		if (isReadableDocument(effectiveMime, fileName)) {
			const decoded = decoder.decode(file.bytes).replace(/\r\n/g, "\n").trim();
			const displayName = fileName ?? att.fileId;
			if (remainingTextChars <= 0) {
				textNotes.push(
					`[Document excerpt omitted due to context budget: ${displayName} (${effectiveMime}, ${file.bytes.byteLength} bytes)]`,
				);
				continue;
			}
			const truncated = decoded.length > remainingTextChars;
			const excerpt = truncated ? `${decoded.slice(0, remainingTextChars)}\n...[truncated]` : decoded;
			remainingTextChars = Math.max(0, remainingTextChars - Math.min(decoded.length, remainingTextChars));
			textNotes.push(`[Document: ${displayName} (${effectiveMime}, ${file.bytes.byteLength} bytes)]\n${excerpt}`);
			continue;
		}

		textNotes.push(
			`[Binary attachment: ${fileName ?? att.fileId} (${effectiveMime}, ${file.bytes.byteLength} bytes) — binary content cannot be inspected directly as plain text.]`,
		);
	}

	return { textNotes, images };
}

/**
 * Async variant of `formatInboundAttachmentsContext` that also extracts readable text from `application/pdf`
 * attachments via the portable Web-standard PDF text extractor (`extractPdfText`).
 */
export async function formatInboundAttachmentsContextAsync(
	attachments: readonly ChannelAttachment[],
	downloaded: ReadonlyMap<string, DownloadedChannelFile> | Readonly<Record<string, DownloadedChannelFile>>,
	options?: { readonly maxTextChars?: number },
): Promise<FormattedInboundAttachments> {
	const maxTextChars = Math.max(200, options?.maxTextChars ?? DEFAULT_ATTACHMENT_TEXT_EXCERPT_CHARS);
	const lookup = (fileId: string): DownloadedChannelFile | undefined =>
		downloaded instanceof Map
			? downloaded.get(fileId)
			: Object.hasOwn(downloaded, fileId)
				? (downloaded as Readonly<Record<string, DownloadedChannelFile>>)[fileId]
				: undefined;

	const images: ImageContent[] = [];
	const textNotes: string[] = [];
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let remainingTextChars = maxTextChars;

	for (const att of attachments) {
		const file = lookup(att.fileId);
		const fallbackName = att.fileName ?? att.fileId;

		if (att.kind === "voice" || att.kind === "audio") {
			const effectiveMime = normalizeMimeType(att.mimeType ?? file?.mimeType) || "audio/ogg";
			const durPart = att.durationSeconds !== undefined ? `, ${att.durationSeconds}s` : "";
			const sizePart =
				file !== undefined
					? `, ${file.bytes.byteLength} bytes`
					: att.sizeBytes !== undefined
						? `, ${att.sizeBytes} bytes`
						: "";
			const label =
				att.kind === "voice" ? "Voice message" : `Audio attachment (${att.fileName ?? file?.fileName ?? "audio"})`;
			textNotes.push(
				`[${label}: ${effectiveMime}${durPart}${sizePart} — automatic speech transcription is not configured; ask the user for text if needed.]`,
			);
			continue;
		}

		if (file === undefined) {
			textNotes.push(`[Attachment unavailable (${att.kind}): ${fallbackName} could not be downloaded.]`);
			continue;
		}

		const fileName = att.fileName ?? file.fileName;
		const attMime = normalizeMimeType(att.mimeType);
		const fileMime = normalizeMimeType(file.mimeType);
		const effectiveMime =
			fileMime.length > 0 && fileMime !== "application/octet-stream"
				? fileMime
				: attMime.length > 0 && attMime !== "application/octet-stream"
					? attMime
					: "application/octet-stream";

		const isRasterImage =
			RASTER_VISION_IMAGE_MIMES.has(effectiveMime) ||
			(att.kind === "image" && effectiveMime === "application/octet-stream");
		if (isRasterImage) {
			const normalizedImageMime =
				effectiveMime === "image/jpg" || effectiveMime === "application/octet-stream"
					? "image/jpeg"
					: effectiveMime;
			images.push({
				type: "image",
				data: bytesToBase64(file.bytes),
				mimeType: normalizedImageMime,
			});
			continue;
		}

		if (isPdfDocument(effectiveMime, fileName)) {
			const displayName = fileName ?? att.fileId;
			if (remainingTextChars <= 0) {
				textNotes.push(
					`[PDF excerpt omitted due to context budget: ${displayName} (application/pdf, ${file.bytes.byteLength} bytes)]`,
				);
				continue;
			}
			const extracted = await extractPdfText(file.bytes, { maxChars: remainingTextChars });
			if (extracted.ok) {
				remainingTextChars = Math.max(0, remainingTextChars - Math.min(extracted.totalChars, remainingTextChars));
				textNotes.push(
					`[PDF Document: ${displayName} (application/pdf, ${file.bytes.byteLength} bytes)]\n${extracted.text}`,
				);
			} else if (extracted.reason === "encrypted") {
				textNotes.push(
					`[PDF Document: ${displayName} (application/pdf, ${file.bytes.byteLength} bytes) — PDF is password-protected/encrypted and cannot be read.]`,
				);
			} else if (extracted.reason === "no_text_layer") {
				textNotes.push(
					`[PDF Document: ${displayName} (application/pdf, ${file.bytes.byteLength} bytes) — no extractable text layer found (likely a scanned image PDF); ask the user to send page screenshots as photos for visual reading.]`,
				);
			} else {
				textNotes.push(
					`[PDF Document: ${displayName} (application/pdf, ${file.bytes.byteLength} bytes) — ${extracted.message}]`,
				);
			}
			continue;
		}

		if (isReadableDocument(effectiveMime, fileName)) {
			const decoded = decoder.decode(file.bytes).replace(/\r\n/g, "\n").trim();
			const displayName = fileName ?? att.fileId;
			if (remainingTextChars <= 0) {
				textNotes.push(
					`[Document excerpt omitted due to context budget: ${displayName} (${effectiveMime}, ${file.bytes.byteLength} bytes)]`,
				);
				continue;
			}
			const truncated = decoded.length > remainingTextChars;
			const excerpt = truncated ? `${decoded.slice(0, remainingTextChars)}\n...[truncated]` : decoded;
			remainingTextChars = Math.max(0, remainingTextChars - Math.min(decoded.length, remainingTextChars));
			textNotes.push(`[Document: ${displayName} (${effectiveMime}, ${file.bytes.byteLength} bytes)]\n${excerpt}`);
			continue;
		}

		textNotes.push(
			`[Binary attachment: ${fileName ?? att.fileId} (${effectiveMime}, ${file.bytes.byteLength} bytes) — binary content cannot be inspected directly as plain text.]`,
		);
	}

	return { textNotes, images };
}

/** Pure fetch-based Telegram Bot API outbound and file-download transport. */
export class TelegramTransport implements ChannelTransport {
	readonly channel: string;
	readonly #baseUrl: string;
	readonly #fileBaseUrl: string;
	readonly #fetch: typeof fetch;

	constructor(options: TelegramTransportOptions) {
		this.channel = options.channelName ?? "telegram";
		const apiRoot = (options.apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
		this.#baseUrl = `${apiRoot}/bot${options.botToken}`;
		this.#fileBaseUrl = `${apiRoot}/file/bot${options.botToken}`;
		// Wrap fetch so Cloudflare Workers `globalThis.fetch` is never invoked with `TelegramTransport` as `this`.
		const customFetch = options.fetchImpl;
		this.#fetch =
			customFetch !== undefined
				? (input, init) => customFetch(input, init)
				: (input, init) => globalThis.fetch(input, init);
	}

	/** Sends a text reply, chunking payloads past Telegram's 4096-character limit and attaching inline buttons on the final chunk. */
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
			if (idx === parts.length - 1 && options?.buttons !== undefined && options.buttons.length > 0) {
				payload.reply_markup = {
					inline_keyboard: options.buttons.map((row) =>
						row.map((btn) => ({ text: btn.label, callback_data: btn.callbackData })),
					),
				};
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

	/** Registers Jehee's slash command menu in Telegram (`setMyCommands`) so typing `/` displays autocomplete hints. */
	async setMyCommands(commands: readonly TelegramBotCommand[] = JEHEE_TELEGRAM_COMMANDS): Promise<void> {
		const response = await this.#fetch(`${this.#baseUrl}/setMyCommands`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				commands: commands.map((entry) => ({
					command: entry.command.replace(/^\/+/, "").toLowerCase(),
					description: entry.description.slice(0, 256),
				})),
			}),
		});
		if (!response.ok) {
			const detail = await response.text();
			throw new Error(`Telegram setMyCommands failed (${response.status}): ${detail}`);
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

	/** Answers an inline button press (`answerCallbackQuery`) to clear Telegram's loading spinner. */
	async answerCallback(callbackId: string, text?: string): Promise<void> {
		await this.#fetch(`${this.#baseUrl}/answerCallbackQuery`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				callback_query_id: callbackId,
				...(text !== undefined && text.length > 0 ? { text } : {}),
			}),
		}).catch(() => undefined);
	}

	/** Downloads a Telegram file via `/getFile` -> `/file/bot<token>/<file_path>` while enforcing a strict `maxBytes` ceiling. */
	async downloadFile(
		fileId: string,
		maxBytes: number = TELEGRAM_DEFAULT_MAX_DOWNLOAD_BYTES,
	): Promise<DownloadedChannelFile> {
		if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
			throw new Error(`Invalid maxBytes limit for Telegram downloadFile: ${String(maxBytes)}`);
		}
		const metaResponse = await this.#fetch(`${this.#baseUrl}/getFile`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ file_id: fileId }),
		});
		if (!metaResponse.ok) {
			const detail = await metaResponse.text();
			throw new Error(`Telegram getFile failed (${metaResponse.status}): ${detail}`);
		}
		const metaBody = (await metaResponse.json()) as {
			readonly ok: boolean;
			readonly description?: string;
			readonly result?: {
				readonly file_id: string;
				readonly file_size?: number;
				readonly file_path?: string;
			};
		};
		const filePath = metaBody.result?.file_path;
		if (!metaBody.ok || filePath === undefined || filePath.length === 0) {
			throw new Error(
				`Telegram getFile did not return a downloadable file_path: ${metaBody.description ?? "unknown error"}`,
			);
		}
		if (metaBody.result?.file_size !== undefined && metaBody.result.file_size > maxBytes) {
			throw new Error(
				`Telegram file "${fileId}" size (${metaBody.result.file_size} bytes) exceeds limit (${maxBytes} bytes)`,
			);
		}

		const cleanPath = filePath.replace(/^\/+/, "");
		const fileResponse = await this.#fetch(`${this.#fileBaseUrl}/${cleanPath}`, {
			method: "GET",
		});
		if (!fileResponse.ok) {
			const detail = await fileResponse.text();
			throw new Error(`Telegram file download failed (${fileResponse.status}): ${detail}`);
		}
		const declaredLenHeader = fileResponse.headers.get("content-length");
		if (declaredLenHeader !== null) {
			const declaredLen = Number(declaredLenHeader);
			if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
				await fileResponse.body?.cancel().catch(() => undefined);
				throw new Error(
					`Telegram file "${fileId}" content-length (${declaredLen} bytes) exceeds limit (${maxBytes} bytes)`,
				);
			}
		}

		const bytes = await readResponseBytesWithLimit(fileResponse, maxBytes);
		const headerMime = normalizeMimeType(fileResponse.headers.get("content-type"));
		const inferredMime = inferMimeFromPath(cleanPath);
		const mimeType =
			headerMime.length > 0 && headerMime !== "application/octet-stream"
				? headerMime
				: (inferredMime ?? (headerMime || "application/octet-stream"));
		const fileName = cleanPath.split("/").at(-1);
		return {
			bytes,
			mimeType,
			...(fileName !== undefined && fileName.length > 0 ? { fileName } : {}),
		};
	}

	/** Sends a photo attachment via Web-standard multipart `FormData` + `Blob` (`sendPhoto`). */
	async sendPhoto(chatId: string, photo: OutboundPhotoPayload, options?: ChannelSendOptions): Promise<void> {
		const form = new FormData();
		form.append("chat_id", chatId);
		const blob = new Blob([new Uint8Array(photo.bytes)], { type: photo.mimeType });
		form.append("photo", blob, photo.fileName ?? inferFileNameForMime("photo", photo.mimeType));
		if (photo.caption !== undefined && photo.caption.length > 0) {
			form.append("caption", photo.caption.slice(0, TELEGRAM_MAX_CAPTION_LENGTH));
		}
		appendTelegramReplyOptions(form, options);

		const response = await this.#fetch(`${this.#baseUrl}/sendPhoto`, {
			method: "POST",
			body: form,
		});
		if (!response.ok) {
			const detail = await response.text();
			throw new Error(`Telegram sendPhoto failed (${response.status}): ${detail}`);
		}
	}

	/** Sends a document attachment via Web-standard multipart `FormData` + `Blob` (`sendDocument`). */
	async sendDocument(chatId: string, doc: OutboundDocumentPayload, options?: ChannelSendOptions): Promise<void> {
		const form = new FormData();
		form.append("chat_id", chatId);
		const blob = new Blob([new Uint8Array(doc.bytes)], { type: doc.mimeType });
		form.append("document", blob, doc.fileName);
		if (doc.caption !== undefined && doc.caption.length > 0) {
			form.append("caption", doc.caption.slice(0, TELEGRAM_MAX_CAPTION_LENGTH));
		}
		appendTelegramReplyOptions(form, options);

		const response = await this.#fetch(`${this.#baseUrl}/sendDocument`, {
			method: "POST",
			body: form,
		});
		if (!response.ok) {
			const detail = await response.text();
			throw new Error(`Telegram sendDocument failed (${response.status}): ${detail}`);
		}
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
	const callback = parseTelegramCallback(update, options.channelName);
	if (callback !== undefined) {
		await options.gateway.ingestCallback(callback, context);
		return new Response("ok", { status: 200 });
	}
	const inbound = parseTelegramUpdate(update, options.channelName);
	if (inbound !== undefined) {
		await options.gateway.ingest(inbound, context);
	}
	return new Response("ok", { status: 200 });
}

/** Polls Telegram `getUpdates` once, admits all parsed messages and callbacks without blocking on turn completion, and returns the next `offset`. */
export async function pollTelegramUpdatesOnce(
	options: {
		readonly botToken: string;
		readonly gateway: ChannelGateway;
		readonly offset?: number;
		readonly timeoutSeconds?: number;
		readonly apiBaseUrl?: string;
		readonly fetchImpl?: typeof fetch;
		readonly channelName?: string;
		readonly signal?: AbortSignal;
		readonly onError?: (error: unknown, message: InboundChannelMessage) => void;
	},
	context: Context,
): Promise<number | undefined> {
	const customFetch = options.fetchImpl;
	const fetchFn: typeof fetch =
		customFetch !== undefined
			? (input, init) => customFetch(input, init)
			: (input, init) => globalThis.fetch(input, init);
	const apiRoot = (options.apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
	const response = await fetchFn(`${apiRoot}/bot${options.botToken}/getUpdates`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			...(options.offset !== undefined ? { offset: options.offset } : {}),
			timeout: options.timeoutSeconds ?? 25,
			allowed_updates: ["message", "callback_query"],
		}),
		...(options.signal !== undefined ? { signal: options.signal } : {}),
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
		const callback = parseTelegramCallback(update, options.channelName);
		if (callback !== undefined) {
			const admittedCb = await options.gateway.admitCallback(callback, context);
			admittedCb.settled.catch(() => undefined);
			continue;
		}
		const inbound = parseTelegramUpdate(update, options.channelName);
		if (inbound !== undefined) {
			const admitted = await options.gateway.admit(inbound, context);
			if (options.onError !== undefined) {
				const reportError = options.onError;
				admitted.settled.catch((err: unknown) => {
					reportError(err, inbound);
				});
			}
		}
	}
	return nextOffset;
}
