// Public entry point of @jehee/bot.

export {
	type ChannelRoute,
	type ChannelSendOptions,
	type ChannelTransport,
	formatRouteKey,
	type InboundChannelMessage,
} from "./channels/contract.ts";
export {
	type AdmittedIngest,
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
	type JeheeUsageSummary,
	type JeheeWorkshopOptions,
	type ProactiveReplyListener,
} from "./core/host.ts";
export {
	type BlobOffloadResult,
	type BlobRestoreResult,
	DEFAULT_BLOB_OFFLOAD_THRESHOLD_BYTES,
	isReadableTextMime,
	JEHEE_BLOB_HANDLE_PREFIX,
	McpBlobVault,
	type ShapedResourceItem,
	type StoredBlobEntry,
} from "./mcp/blob-vault.ts";
export {
	interpolateMcpEnvString,
	mergeJeheeMcpOptions,
	type ParsedStdioServerInput,
	type ParseMcpConfigOptions,
	parseMcpConfigJson,
	parseMcpExposureEnv,
} from "./mcp/config.ts";
export type {
	ConnectedMcpServer,
	JeheeMcpExposure,
	JeheeMcpOptions,
	JeheeMcpServerSpec,
	JeheeMcpTransportConfig,
	McpWriteCallInfo,
	McpWriteGateDecision,
} from "./mcp/contract.ts";
export {
	createMcpBundle,
	JEHEE_MCP_EXTENSION_NAME,
	type JeheeMcpBundle,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	LIST_MCP_RESOURCES_TOOL,
	READ_MCP_RESOURCE_TOOL,
} from "./mcp/extension.ts";
export { McpConnectorHub, validateMcpServerSpecs } from "./mcp/hub.ts";
export { createMemoryExtension, JEHEE_MEMORY_EXTENSION_NAME } from "./memory/bridge.ts";
export {
	extractAssistantText,
	extractUserText,
	type MemoryProvider,
	type RequestContextInput,
	type TurnCompletedEvent,
} from "./memory/contract.ts";
export { type StaticCoreMemoryOptions, StaticCoreMemoryProvider } from "./memory/static-core.ts";
export { type JeheeRuntimeConfig, parseJeheeEnvConfig } from "./runtime/config.ts";
export {
	createJeheeModels,
	DEFAULT_JEHEE_MODEL_SPEC,
	type EnvDictionary,
	resolveModelSpec,
} from "./runtime/models.ts";
export {
	buildPostmortemReport,
	classifyFailureRootCause,
	computeTraceMetrics,
	type FailureRootCause,
	JEHEE_MCP_TELEMETRY_SCHEMA,
	type JeheePostmortemReport,
	type JeheeTraceMetrics,
	JeheeTraceRecorder,
	startJeheeMcpSpan,
} from "./telemetry/recorder.ts";
export {
	createWorkshopBundle,
	type WorkshopBundle,
	type WorkshopBundleOptions,
	WorkshopRegistryDoc,
	type WorkshopTaskEntry,
} from "./workshop/extension.ts";
export {
	InstaBoxClient,
	type InstaBoxClientOptions,
	type InstaBoxExecRequest,
	type InstaBoxExecResult,
	type InstaBoxMachine,
	type InstaBoxMachineState,
	type InstaBoxOperation,
	type InstaBoxOperationState,
} from "./workshop/instabox-client.ts";
export {
	type ProvisionedWorkspace,
	type ProvisionWorkspaceRequest,
	type SingleBoxWorktreeOptions,
	SingleBoxWorktreeProvisioner,
	validateTaskSlug,
	type WorkshopProvisioner,
} from "./workshop/provisioner.ts";
export {
	createWorkshopSandboxExtension,
	resolveScopedSandboxPath,
	WorkshopBindingDoc,
	type WorkshopBindingState,
} from "./workshop/sandbox-tools.ts";
