// Platform-agnostic contracts for Jehee's thin messaging adapters (Telegram, QQ, CLI). Adding or switching chat
// platforms requires implementing only ChannelTransport and translating webhook/socket events into InboundChannelMessage.

/** Destination chat route on a specific messaging channel. */
export type ChannelRoute = {
	readonly channel: string;
	readonly chatId: string;
};

/** Interactive inline action button attached to an outbound message (e.g. Telegram InlineKeyboardButton). */
export type ChannelInlineButton = {
	readonly label: string;
	readonly callbackData: string;
};

/** Media category for a normalized inbound channel attachment. */
export type ChannelAttachmentKind = "image" | "document" | "audio" | "voice";

/** Normalized inbound media attachment metadata extracted from a messaging connector payload. */
export type ChannelAttachment = {
	readonly kind: ChannelAttachmentKind;
	readonly fileId: string;
	readonly mimeType?: string;
	readonly fileName?: string;
	readonly sizeBytes?: number;
	readonly durationSeconds?: number;
};

/** Raw bytes and normalized metadata returned by `ChannelTransport.downloadFile`. */
export type DownloadedChannelFile = {
	readonly bytes: Uint8Array;
	readonly mimeType: string;
	readonly fileName?: string;
};

/** Outbound image payload delivered through `ChannelTransport.sendPhoto`. */
export type OutboundPhotoPayload = {
	readonly bytes: Uint8Array;
	readonly mimeType: string;
	readonly fileName?: string;
	readonly caption?: string;
};

/** Outbound document payload delivered through `ChannelTransport.sendDocument`. */
export type OutboundDocumentPayload = {
	readonly bytes: Uint8Array;
	readonly mimeType: string;
	readonly fileName: string;
	readonly caption?: string;
};

/** Normalized inbound user message delivered by any messaging connector. */
export type InboundChannelMessage = {
	readonly channel: string;
	readonly chatId: string;
	readonly senderId: string;
	readonly messageId: string;
	readonly text: string;
	readonly timestampMs: number;
	readonly attachments?: readonly ChannelAttachment[];
};

/** Normalized inbound button/callback interaction (e.g. Telegram `callback_query`). */
export type InboundCallbackAction = {
	readonly channel: string;
	readonly chatId: string;
	readonly senderId: string;
	readonly callbackId: string;
	readonly messageId?: string;
	readonly data: string;
	readonly timestampMs: number;
};

/** Optional delivery hints passed to an outbound transport. */
export type ChannelSendOptions = {
	readonly replyToMessageId?: string;
	readonly buttons?: readonly (readonly ChannelInlineButton[])[];
	readonly urgency?: "normal" | "urgent";
};

/** Outbound transport implemented by each platform connector (e.g., Telegram, QQBot, NapCat relay). */
export interface ChannelTransport {
	readonly channel: string;
	sendText(chatId: string, text: string, options?: ChannelSendOptions): Promise<void>;
	sendTyping?(chatId: string): Promise<void>;
	answerCallback?(callbackId: string, text?: string): Promise<void>;
	downloadFile?(fileId: string, maxBytes?: number): Promise<DownloadedChannelFile>;
	sendPhoto?(chatId: string, photo: OutboundPhotoPayload, options?: ChannelSendOptions): Promise<void>;
	sendDocument?(chatId: string, doc: OutboundDocumentPayload, options?: ChannelSendOptions): Promise<void>;
}

/** Formats a canonical `"<channel>:<chatId>"` route key for allowlists and staging guards. */
export function formatRouteKey(channel: string, chatId: string): string {
	return `${channel}:${chatId}`;
}
