// Bridges `McpConnectorHub` into `pi-durable` extensions: namespaced MCP business tools (`deferred` + `tool_search` or
// `eager`), Codex-aligned MCP resource tools, `$jehee_blob:` binary handle translation, write-gate hooks, and telemetry spans.

import type { JsonValue } from "@earendil-works/chord/json";
import {
	defineExtension,
	defineTool,
	type Extension,
	section,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import {
	type CallToolResult,
	createMcpToolName,
	type LlmContent,
	limitMcpContent,
	mcpNamespace,
	normalizeMcpInputSchema,
	type Tool as RawMcpTool,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { checkOrCreateWriteApproval } from "../governance/approvals.ts";
import { startJeheeMcpSpan } from "../telemetry/recorder.ts";
import { DEFAULT_BLOB_OFFLOAD_THRESHOLD_BYTES, McpBlobVault } from "./blob-vault.ts";
import type { ConnectedMcpServer, JeheeMcpExposure, JeheeMcpOptions } from "./contract.ts";
import type { McpConnectorHub } from "./hub.ts";

/** Fixed extension name for Jehee's MCP connector layer. */
export const JEHEE_MCP_EXTENSION_NAME = "jehee.mcp";

/** Standard resource listing tool name aligned with Codex/OpenCode model priors. */
export const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";

/** Standard parameterized resource template listing tool name aligned with Codex/OpenCode model priors. */
export const LIST_MCP_RESOURCE_TEMPLATES_TOOL = "list_mcp_resource_templates";

/** Standard resource reader tool name aligned with Codex/OpenCode model priors. */
export const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";

/** Assembled `pi-durable` extensions and shared `McpBlobVault` produced for an `McpConnectorHub`. */
export type JeheeMcpBundle = {
	readonly extensions: readonly Extension[];
	readonly mcpExtension: Extension;
	readonly blobVault: McpBlobVault;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractMcpStatus(result: CallToolResult): string | undefined {
	if (isPlainRecord(result.structuredContent) && typeof result.structuredContent.status === "string") {
		return result.structuredContent.status;
	}
	const firstText = result.content.find((block) => block.type === "text");
	if (firstText?.type === "text" && firstText.text.trim().startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(firstText.text);
			if (isPlainRecord(parsed) && typeof parsed.status === "string") {
				return parsed.status;
			}
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function buildServersPromptSection(
	servers: readonly ConnectedMcpServer[],
	hasAnyResources: boolean,
): string | undefined {
	if (servers.length === 0) return undefined;
	const resourceNote = hasAnyResources
		? ` To inspect or read file/attachment resources (e.g. PDFs, ICS invites), load \`${LIST_MCP_RESOURCES_TOOL}\`, \`${LIST_MCP_RESOURCE_TEMPLATES_TOOL}\`, and \`${READ_MCP_RESOURCE_TOOL}\` via \`tool_search\`. Pass any \`$jehee_blob:<id>\` handle unchanged to downstream attachment tools.`
		: "";
	const intro = `Connected MCP servers whose tools are deferred. Use \`tool_search\` to load the tools you need before calling them.${resourceNote}`;
	const lines = servers.map((server) => {
		const tags = ["tool_search", ...(server.hasResources ? ["resources"] : [])].join(", ");
		const head = `- ${mcpNamespace(server.name)} (${tags}, server="${server.name}")`;
		return server.summary.length > 0 ? `${head}: ${server.summary}` : head;
	});
	return [intro, ...lines].join("\n");
}

function isMcpUiAppResource(item: {
	readonly uri?: string;
	readonly uriTemplate?: string;
	readonly mimeType?: string;
}): boolean {
	const uri = item.uri ?? item.uriTemplate ?? "";
	return uri.startsWith("ui://") || /;\s*profile\s*=\s*"?mcp-app"?/i.test(item.mimeType ?? "");
}

function toListedEntry<T extends { readonly _meta?: unknown }>(server: string, item: T): Record<string, unknown> {
	const { _meta: _ignoredMeta, icons: _ignoredIcons, ...rest } = item as T & { readonly icons?: unknown };
	return { server, ...rest };
}

function createResourceTools(
	hub: McpConnectorHub,
	blobVault: McpBlobVault,
	exposure: JeheeMcpExposure,
	thresholdBytes: number,
): ToolRegistration[] {
	const resourceServers = () => hub.servers().filter((server) => server.hasResources);
	if (resourceServers().length === 0) return [];

	const findResourceServer = (name: string): ConnectedMcpServer => {
		const found = resourceServers().find((server) => server.name === name);
		if (found !== undefined) return found;
		const available = resourceServers()
			.map((server) => server.name)
			.join(", ");
		throw new Error(
			`MCP server "${name}" has no resources${available.length > 0 ? `. Available resource servers: ${available}` : ""}`,
		);
	};

	const listAcrossOrSingle = async <
		T extends {
			readonly uri?: string;
			readonly uriTemplate?: string;
			readonly mimeType?: string;
			readonly _meta?: unknown;
		},
	>(
		toolName: string,
		key: "resources" | "resourceTemplates",
		args: { readonly server?: string; readonly cursor?: string },
		signal: AbortSignal | undefined,
		fetchPage: (
			server: ConnectedMcpServer,
			cursor: string | undefined,
			sig: AbortSignal | undefined,
		) => Promise<{ readonly items: readonly T[]; readonly nextCursor?: string }>,
		fetchAll: (server: ConnectedMcpServer, sig: AbortSignal | undefined) => Promise<readonly T[]>,
	): Promise<ToolExecutionResult> => {
		const serverName = args.server?.trim();
		const cursor = args.cursor?.trim();
		const visible = (item: T) => !isMcpUiAppResource(item);
		if (serverName !== undefined && serverName.length > 0) {
			const target = findResourceServer(serverName);
			const page = await fetchPage(target, cursor, signal);
			const payload = {
				server: target.name,
				[key]: page.items.filter(visible).map((item) => toListedEntry(target.name, item)),
				...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
			};
			const limited = await limitMcpContent([{ type: "text", text: JSON.stringify(payload) }]);
			return { output: limited.content, details: { tool: toolName, server: target.name } };
		}
		if (cursor !== undefined && cursor.length > 0) {
			return {
				isError: true,
				output: [{ type: "text", text: "Parameter `cursor` requires specifying `server`." }],
			};
		}
		const ordered = [...resourceServers()].sort((a, b) => a.name.localeCompare(b.name));
		const settled = await Promise.allSettled(ordered.map((server) => fetchAll(server, signal)));
		const allItems: Record<string, unknown>[] = [];
		const errors: { readonly server: string; readonly error: string }[] = [];
		settled.forEach((res, idx) => {
			const srvName = ordered[idx]!.name;
			if (res.status === "fulfilled") {
				for (const item of res.value) {
					if (visible(item)) allItems.push(toListedEntry(srvName, item));
				}
			} else {
				errors.push({
					server: srvName,
					error: res.reason instanceof Error ? res.reason.message : String(res.reason),
				});
			}
		});
		const payload = {
			[key]: allItems,
			...(errors.length > 0 ? { errors } : {}),
		};
		const limited = await limitMcpContent([{ type: "text", text: JSON.stringify(payload) }]);
		return { output: limited.content, details: { tool: toolName } };
	};

	const listParameters = obj({
		server: opt(str({ description: "Optional MCP server instance name. Omit to list across all resource servers." })),
		cursor: opt(str({ description: "Optional pagination cursor when `server` is specified." })),
	});

	const listResourcesTool = defineTool({
		name: LIST_MCP_RESOURCES_TOOL,
		description:
			"List file, attachment, or application resources exposed by connected MCP servers. Omit `server` to list resources across all servers.",
		parameters: listParameters,
		...(exposure === "deferred" ? { deferred: true } : {}),
		replay: "safe",
		execute: (args, _api, context): Promise<ToolExecutionResult> =>
			listAcrossOrSingle(
				LIST_MCP_RESOURCES_TOOL,
				"resources",
				args,
				context.abortSignal,
				async (server, cursor, sig) => {
					const page = await server.listResourcesPage(cursor, sig);
					return {
						items: page.resources,
						...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
					};
				},
				(server, sig) => server.listAllResources(sig),
			),
	});

	const listResourceTemplatesTool = defineTool({
		name: LIST_MCP_RESOURCE_TEMPLATES_TOOL,
		description:
			"List parameterized RFC 6570 resource URI templates exposed by connected MCP servers. Omit `server` to list templates across all servers.",
		parameters: listParameters,
		...(exposure === "deferred" ? { deferred: true } : {}),
		replay: "safe",
		execute: (args, _api, context): Promise<ToolExecutionResult> =>
			listAcrossOrSingle(
				LIST_MCP_RESOURCE_TEMPLATES_TOOL,
				"resourceTemplates",
				args,
				context.abortSignal,
				async (server, cursor, sig) => {
					const page = await server.listResourceTemplatesPage(cursor, sig);
					return {
						items: page.resourceTemplates,
						...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
					};
				},
				(server, sig) => server.listAllResourceTemplates(sig),
			),
	});

	const readResourceTool = defineTool({
		name: READ_MCP_RESOURCE_TOOL,
		description:
			"Read a resource or attachment URI (e.g. PDF, ICS calendar invite, text, image) from a connected MCP server. Large binary blobs return a `$jehee_blob:<id>` handle that can be passed directly to downstream MCP attachment tools.",
		parameters: obj({
			server: str({ description: "MCP server name exactly as configured." }),
			uri: str({ description: "Resource URI to read (e.g. `pale://run/mail/assets/att-1`)." }),
		}),
		...(exposure === "deferred" ? { deferred: true } : {}),
		replay: "safe",
		execute: async (args, _api, context): Promise<ToolExecutionResult> => {
			const target = findResourceServer(args.server.trim());
			const uri = args.uri.trim();
			return startJeheeMcpSpan(context.telemetry)(
				"jehee.mcp.resource_read",
				{ server: target.name, uri },
				async (span) => {
					const readResult = await target.readResource(uri, context.abortSignal);
					const llmBlocks: LlmContent[] = [];
					let totalBytes = 0;
					let anyOffloaded = false;
					const firstMime = readResult.contents[0]?.mimeType;

					for (const item of readResult.contents) {
						const shaped = blobVault.shapeResourceReadItem(item, thresholdBytes);
						totalBytes += shaped.bytes;
						if (shaped.offloaded) anyOffloaded = true;
						if (shaped.kind === "image") {
							llmBlocks.push({ type: "image", data: shaped.data, mimeType: shaped.mimeType });
						} else {
							llmBlocks.push({ type: "text", text: shaped.text });
						}
					}

					span.setAttributes({
						...(firstMime !== undefined ? { mime_type: firstMime } : {}),
						bytes: totalBytes,
						"blob.offloaded": anyOffloaded,
					});

					const limited = await limitMcpContent(
						llmBlocks.length > 0 ? llmBlocks : [{ type: "text", text: `Resource ${uri} is empty.` }],
					);
					return {
						output: limited.content,
						details: { server: target.name, uri, bytes: totalBytes, offloaded: anyOffloaded },
					};
				},
			);
		},
	});

	return [listResourcesTool, listResourceTemplatesTool, readResourceTool];
}

function createBusinessToolRegistration(params: {
	readonly server: ConnectedMcpServer;
	readonly rawTool: RawMcpTool;
	readonly registeredName: string;
	readonly exposure: JeheeMcpExposure;
	readonly thresholdBytes: number;
	readonly blobVault: McpBlobVault;
	readonly writeGate: JeheeMcpOptions["writeGate"];
	readonly onApprovalRequested: JeheeMcpOptions["onApprovalRequested"];
	readonly beforeWriteToolCall: JeheeMcpOptions["beforeWriteToolCall"];
}): ToolRegistration {
	const {
		server,
		rawTool,
		registeredName,
		exposure,
		thresholdBytes,
		blobVault,
		writeGate,
		onApprovalRequested,
		beforeWriteToolCall,
	} = params;
	const isReadOnly = rawTool.annotations?.readOnlyHint === true;
	const title = rawTool.title ?? rawTool.annotations?.title;
	const baseDescription = rawTool.description?.trim() || title || `MCP tool ${rawTool.name} on server ${server.name}`;

	return {
		name: registeredName,
		description: `[server=${server.name}] ${baseDescription}`,
		parameters: normalizeMcpInputSchema(rawTool.inputSchema),
		...(exposure === "deferred" ? { deferred: true } : {}),
		replay: isReadOnly ? "safe" : "unsafe",
		...(rawTool.outputSchema !== undefined ? { structuredOutputSchema: rawTool.outputSchema } : {}),
		execute: async (args, api, context): Promise<ToolExecutionResult> => {
			return startJeheeMcpSpan(context.telemetry)(
				"jehee.mcp.call",
				{
					server: server.name,
					tool: rawTool.name,
					read_only: isReadOnly,
				},
				async (span): Promise<ToolExecutionResult> => {
					const rawArgs = args as Record<string, unknown>;
					const { args: expandedArgs, restoredCount } = blobVault.restoreInArgs(rawArgs);

					if (!isReadOnly && beforeWriteToolCall !== undefined) {
						const decision = await beforeWriteToolCall({
							server: server.name,
							tool: rawTool.name,
							args: expandedArgs,
						});
						if (decision.action === "block") {
							span.setAttributes({
								"gate.action": "block",
								"mcp.status": "confirmation_required",
								is_error: true,
								"blob.restored_count": restoredCount,
							});
							span.setStatus({
								status: "error",
								error: { name: "write_gate_blocked", message: decision.reason.slice(0, 500) },
							});
							return {
								isError: true,
								output: [
									{
										type: "text",
										text: JSON.stringify({
											status: "confirmation_required",
											server: server.name,
											tool: rawTool.name,
											reason: decision.reason,
										}),
									},
								],
								details: { server: server.name, tool: rawTool.name, blockedByGate: true },
							};
						}
						span.setAttributes({ "gate.action": "allow" });
					}

					if (!isReadOnly && writeGate !== undefined && writeGate.mode === "confirm-writes") {
						const approvalCheck = await checkOrCreateWriteApproval({
							api,
							context,
							policy: writeGate,
							server: server.name,
							tool: rawTool.name,
							args: expandedArgs,
							rawArgsForSummary: rawArgs,
						});
						if (approvalCheck.action === "block") {
							if (approvalCheck.isNewTicket && onApprovalRequested !== undefined) {
								await onApprovalRequested(approvalCheck.ticket);
							}
							const reason = `Owner confirmation required (ticket ${approvalCheck.ticket.id}). Inform the owner and wait for approval; do not retry until approved.`;
							span.setAttributes({
								"gate.action": "block",
								"mcp.status": "confirmation_required",
								is_error: true,
								"blob.restored_count": restoredCount,
							});
							span.setStatus({
								status: "error",
								error: { name: "write_gate_blocked", message: reason },
							});
							return {
								isError: true,
								output: [
									{
										type: "text",
										text: JSON.stringify({
											status: "confirmation_required",
											approval_id: approvalCheck.ticket.id,
											server: server.name,
											tool: rawTool.name,
											reason,
										}),
									},
								],
								details: {
									server: server.name,
									tool: rawTool.name,
									blockedByGate: true,
									approvalId: approvalCheck.ticket.id,
								},
							};
						}
						span.setAttributes({ "gate.action": "allow" });
					}

					const result = await server.callTool(rawTool.name, expandedArgs, context.abortSignal);
					const rawBlocks = toLlmContent(result);
					let totalOffloadedBytes = 0;
					const shapedBlocks: LlmContent[] = rawBlocks.map((block) => {
						if (block.type !== "text") return block;
						const shaped = blobVault.shapeToolResultText(block.text, thresholdBytes);
						totalOffloadedBytes += shaped.offloadedBytes;
						return { type: "text", text: shaped.text };
					});

					if (result.isError === true && shapedBlocks.length === 0) {
						const fallback =
							result.structuredContent !== undefined
								? JSON.stringify(result.structuredContent)
								: `MCP tool ${server.name}/${rawTool.name} returned an error`;
						shapedBlocks.push({ type: "text", text: fallback });
					}

					const limited = await limitMcpContent(shapedBlocks);
					const mcpStatus = extractMcpStatus(result);

					span.setAttributes({
						...(mcpStatus !== undefined ? { "mcp.status": mcpStatus } : {}),
						is_error: result.isError === true,
						"blob.offloaded_bytes": totalOffloadedBytes,
						"blob.restored_count": restoredCount,
					});

					const structured =
						rawTool.outputSchema !== undefined && result.structuredContent !== undefined
							? { structuredOutput: result.structuredContent as JsonValue }
							: {};

					return {
						output: limited.content,
						isError: result.isError === true,
						details: {
							server: server.name,
							tool: rawTool.name,
							...(mcpStatus !== undefined ? { status: mcpStatus } : {}),
						},
						...structured,
					};
				},
			);
		},
	};
}

/** Builds the `jehee.mcp` extension (and `tool-search` when `exposure === "deferred"`) from a connected `McpConnectorHub`. */
export function createMcpBundle(hub: McpConnectorHub, options?: Omit<JeheeMcpOptions, "servers">): JeheeMcpBundle {
	const exposure: JeheeMcpExposure = options?.exposure ?? "deferred";
	const thresholdBytes = options?.blobOffloadThresholdBytes ?? DEFAULT_BLOB_OFFLOAD_THRESHOLD_BYTES;
	const blobVault = new McpBlobVault();
	const servers = hub.servers();

	const takenNames = new Set<string>([
		LIST_MCP_RESOURCES_TOOL,
		LIST_MCP_RESOURCE_TEMPLATES_TOOL,
		READ_MCP_RESOURCE_TOOL,
		"tool_search",
		"workshop",
	]);
	const businessTools: ToolRegistration[] = [];

	for (const server of servers) {
		for (const rawTool of server.tools) {
			const registeredName = createMcpToolName(server.name, rawTool.name, (candidate) => takenNames.has(candidate));
			takenNames.add(registeredName);
			businessTools.push(
				createBusinessToolRegistration({
					server,
					rawTool,
					registeredName,
					exposure,
					thresholdBytes,
					blobVault,
					writeGate: options?.writeGate,
					onApprovalRequested: options?.onApprovalRequested,
					beforeWriteToolCall: options?.beforeWriteToolCall,
				}),
			);
		}
	}

	const resourceTools = createResourceTools(hub, blobVault, exposure, thresholdBytes);
	const allMcpTools = [...businessTools, ...resourceTools];
	const hasAnyResources = resourceTools.length > 0;

	const mcpExtension = defineExtension({
		name: JEHEE_MCP_EXTENSION_NAME,
		tools: allMcpTools,
		...(exposure === "deferred" && allMcpTools.length > 0
			? {
					sections: [section("mcp_servers", () => buildServersPromptSection(servers, hasAnyResources))],
				}
			: {}),
	});

	const extensions: Extension[] =
		exposure === "deferred" && allMcpTools.length > 0 ? [mcpExtension, createToolSearchExtension()] : [mcpExtension];

	return {
		extensions,
		mcpExtension,
		blobVault,
	};
}
