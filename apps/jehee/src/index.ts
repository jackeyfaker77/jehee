// Public entry point of @jehee/bot.

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
