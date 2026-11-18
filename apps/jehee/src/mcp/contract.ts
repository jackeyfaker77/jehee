// Portable contracts for Jehee's MCP connector layer (Web/Edge safe: zero Node child_process dependencies).

import type { CallToolResult, McpFetch, McpTransport, Resource, ResourceTemplate, Tool } from "@earendil-works/pi-mcp";

/** Strategy governing how MCP business tools are exposed to the root conversation. */
export type JeheeMcpExposure = "deferred" | "eager";

/** Portable transport specification for connecting to an MCP server. */
export type JeheeMcpTransportConfig =
	| {
			readonly kind: "http";
			readonly url: string;
			readonly headers?: Readonly<Record<string, string>>;
			readonly fetchImpl?: McpFetch;
	  }
	| {
			readonly kind: "custom";
			readonly create: () => McpTransport;
	  };

/** Configuration for one named MCP server instance (e.g. `"mail"`, `"mail_work"`, `"calendar"`). */
export type JeheeMcpServerSpec = {
	readonly name: string;
	readonly description?: string;
	readonly transport: JeheeMcpTransportConfig;
	readonly includeTools?: readonly string[];
	readonly excludeTools?: readonly string[];
	readonly requestTimeoutMs?: number;
};

/** Decision returned by `beforeWriteToolCall` before executing a mutating (`readOnlyHint !== true`) MCP tool. */
export type McpWriteGateDecision = { readonly action: "allow" } | { readonly action: "block"; readonly reason: string };

/** Metadata passed to `beforeWriteToolCall` for deterministic safety/confirmation checks. */
export type McpWriteCallInfo = {
	readonly server: string;
	readonly tool: string;
	readonly args: Readonly<Record<string, unknown>>;
};

/** Options configuring the MCP connector bundle mounted on `JeheeHost`. */
export type JeheeMcpOptions = {
	readonly servers: readonly JeheeMcpServerSpec[];
	/** Defaults to `"deferred"` (`mcp_servers` summary section + `tool_search` on-demand schema loading). */
	readonly exposure?: JeheeMcpExposure;
	/** Decoded byte threshold above which binary Base64 payloads are replaced with `$jehee_blob:<id>` handles. Defaults to 4096. */
	readonly blobOffloadThresholdBytes?: number;
	/** Optional deterministic gate invoked before non-readOnly MCP tools execute. */
	readonly beforeWriteToolCall?: (call: McpWriteCallInfo) => McpWriteGateDecision | Promise<McpWriteGateDecision>;
};

/** Snapshot of one connected MCP server instance held by `McpConnectorHub`. */
export type ConnectedMcpServer = {
	readonly name: string;
	readonly summary: string;
	readonly instructions?: string;
	readonly tools: readonly Tool[];
	readonly hasResources: boolean;
	readonly hasResourceTemplates: boolean;
	readonly requestTimeoutMs: number;
	listResourcesPage(
		cursor: string | undefined,
		signal?: AbortSignal,
	): Promise<{
		readonly resources: readonly Resource[];
		readonly nextCursor?: string;
	}>;
	listAllResources(signal?: AbortSignal): Promise<readonly Resource[]>;
	listResourceTemplatesPage(
		cursor: string | undefined,
		signal?: AbortSignal,
	): Promise<{
		readonly resourceTemplates: readonly ResourceTemplate[];
		readonly nextCursor?: string;
	}>;
	listAllResourceTemplates(signal?: AbortSignal): Promise<readonly ResourceTemplate[]>;
	readResource(
		uri: string,
		signal?: AbortSignal,
	): Promise<{
		readonly contents: readonly {
			readonly uri: string;
			readonly mimeType?: string;
			readonly text?: string;
			readonly blob?: string;
		}[];
	}>;
	callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
};
