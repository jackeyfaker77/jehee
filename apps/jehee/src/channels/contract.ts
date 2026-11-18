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

/** Normalized inbound user message delivered by any messaging connector. */
export type InboundChannelMessage = {
	readonly channel: string;
	readonly chatId: string;
	readonly senderId: string;
	readonly messageId: string;
	readonly text: string;
	readonly timestampMs: number;
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
}

/** Formats a canonical `"<channel>:<chatId>"` route key for allowlists and staging guards. */
export function formatRouteKey(channel: string, chatId: string): string {
	return `${channel}:${chatId}`;
}
