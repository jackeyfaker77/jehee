// Public entry point of @jehee/bot.

export {
	type ChannelRoute,
	type ChannelSendOptions,
	type ChannelTransport,
	formatRouteKey,
	type InboundChannelMessage,
} from "./channels/contract.ts";
export {
	type ChannelAllowlist,
	ChannelGateway,
	type ChannelGatewayOptions,
	type IngestResult,
} from "./channels/gateway.ts";
export {
	handleTelegramWebhook,
	parseTelegramUpdate,
	pollTelegramUpdatesOnce,
	splitTelegramText,
	TELEGRAM_MAX_MESSAGE_LENGTH,
	TelegramTransport,
	type TelegramTransportOptions,
	type TelegramUpdate,
	verifyTelegramSecretToken,
} from "./channels/telegram.ts";
export {
	type JeheeHistoryItem,
	JeheeHost,
	type JeheeHostOptions,
	type JeheePendingTurn,
	type JeheeSendInput,
	type JeheeStorageConfig,
	type JeheeTurnReply,
} from "./core/host.ts";
export { createMemoryExtension, JEHEE_MEMORY_EXTENSION_NAME } from "./memory/bridge.ts";
export {
	extractAssistantText,
	extractUserText,
	type MemoryProvider,
	type RequestContextInput,
	type TurnCompletedEvent,
} from "./memory/contract.ts";
export { type StaticCoreMemoryOptions, StaticCoreMemoryProvider } from "./memory/static-core.ts";
