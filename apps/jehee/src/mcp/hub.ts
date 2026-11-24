// Portable multi-server MCP client hub managing handshake, tool filtering, resource queries, and clean teardown.

import { McpClient, mcpNamespace, mcpServerSummary, StreamableHttpTransport, type Tool } from "@earendil-works/pi-mcp";
import type { ConnectedMcpServer, JeheeMcpServerSpec } from "./contract.ts";

const SERVER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_SUMMARY_CHARS = 250;

function truncateSummary(summary: string): string {
	const chars = [...summary];
	if (chars.length <= MAX_SUMMARY_CHARS) return summary;
	return `${chars
		.slice(0, MAX_SUMMARY_CHARS - 1)
		.join("")
		.trimEnd()}…`;
}

function filterTools(
	tools: readonly Tool[],
	includeTools: readonly string[] | undefined,
	excludeTools: readonly string[] | undefined,
): Tool[] {
	const includeSet = includeTools !== undefined ? new Set(includeTools) : undefined;
	const excludeSet = excludeTools !== undefined ? new Set(excludeTools) : undefined;
	return tools.filter((tool) => {
		if (includeSet !== undefined && !includeSet.has(tool.name)) return false;
		if (excludeSet?.has(tool.name)) return false;
		return true;
	});
}

/** Validates a server name and rejects collisions across `-` and `_` namespaces. */
export function validateMcpServerSpecs(specs: readonly JeheeMcpServerSpec[]): void {
	const seenNames = new Set<string>();
	const seenNamespaces = new Set<string>();
	for (const spec of specs) {
		const trimmed = spec.name.trim();
		if (!SERVER_NAME_PATTERN.test(trimmed)) {
			throw new Error(
				`Invalid MCP server name "${spec.name}": use 1-48 ASCII letters, digits, '_', or '-' starting with alphanumeric`,
			);
		}
		if (seenNames.has(trimmed)) {
			throw new Error(`Duplicate MCP server name "${trimmed}"`);
		}
		const ns = mcpNamespace(trimmed);
		if (seenNamespaces.has(ns)) {
			throw new Error(`MCP server "${trimmed}" collides in namespace "${ns}" with another server`);
		}
		seenNames.add(trimmed);
		seenNamespaces.add(ns);
	}
}

/** Owns active `McpClient` connections for one `JeheeHost` instance. */
export class McpConnectorHub {
	readonly #servers: readonly ConnectedMcpServer[];
	readonly #byName: ReadonlyMap<string, ConnectedMcpServer>;
	readonly #clients: readonly McpClient[];

	private constructor(servers: readonly ConnectedMcpServer[], clients: readonly McpClient[]) {
		this.#servers = servers;
		this.#byName = new Map(servers.map((server) => [server.name, server]));
		this.#clients = clients;
	}

	/** Connects and initializes configured MCP servers; when `bestEffort` is true, unreachable servers are skipped cleanly. */
	static async connect(
		specs: readonly JeheeMcpServerSpec[],
		clientIdentity?: { readonly name?: string; readonly version?: string; readonly bestEffort?: boolean },
	): Promise<McpConnectorHub> {
		validateMcpServerSpecs(specs);
		const bestEffort = clientIdentity?.bestEffort === true;
		const connectedClients: McpClient[] = [];
		const servers: ConnectedMcpServer[] = [];

		try {
			for (const spec of specs) {
				const name = spec.name.trim();
				const timeoutMs = spec.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
				const transport =
					spec.transport.kind === "http"
						? new StreamableHttpTransport({
								url: spec.transport.url,
								...(spec.transport.headers !== undefined ? { headers: { ...spec.transport.headers } } : {}),
								...(spec.transport.fetchImpl !== undefined ? { fetch: spec.transport.fetchImpl } : {}),
								...(spec.transport.openGetStream !== undefined
									? { openGetStream: spec.transport.openGetStream }
									: {}),
							})
						: spec.transport.create();
				const client = new McpClient({
					name: clientIdentity?.name ?? "jehee-mcp",
					version: clientIdentity?.version ?? "0.1.0",
					requestTimeoutMs: timeoutMs,
				});
				try {
					await client.connect(transport);
					const capabilities = client.serverCapabilities;
					const rawTools = capabilities?.tools !== undefined ? await client.listTools({ timeoutMs }) : [];
					const tools = filterTools(rawTools, spec.includeTools, spec.excludeTools);
					const hasResources = capabilities?.resources !== undefined;
					const summary = truncateSummary(mcpServerSummary(spec.description, client.instructions));

					connectedClients.push(client);
					servers.push({
						name,
						summary,
						...(client.instructions !== undefined ? { instructions: client.instructions } : {}),
						tools,
						hasResources,
						hasResourceTemplates: hasResources,
						requestTimeoutMs: timeoutMs,
						listResourcesPage: (cursor, signal) =>
							client.listResourcesPage(cursor, { timeoutMs, ...(signal !== undefined ? { signal } : {}) }),
						listAllResources: (signal) =>
							client.listResources({ timeoutMs, ...(signal !== undefined ? { signal } : {}) }),
						listResourceTemplatesPage: (cursor, signal) =>
							client.listResourceTemplatesPage(cursor, {
								timeoutMs,
								...(signal !== undefined ? { signal } : {}),
							}),
						listAllResourceTemplates: (signal) =>
							client.listResourceTemplates({ timeoutMs, ...(signal !== undefined ? { signal } : {}) }),
						readResource: (uri, signal) =>
							client.readResource(uri, { timeoutMs, ...(signal !== undefined ? { signal } : {}) }),
						callTool: (toolName, args, signal) =>
							client.callTool(toolName, args, { timeoutMs, ...(signal !== undefined ? { signal } : {}) }),
					});
				} catch (error) {
					await client.close().catch(() => undefined);
					if (!bestEffort) {
						throw error;
					}
					const detail = error instanceof Error ? error.message : String(error);
					console.warn(`[jehee/mcp] skipped unreachable MCP server "${name}": ${detail}`);
				}
			}
		} catch (error) {
			await Promise.allSettled(connectedClients.map((client) => client.close()));
			throw error;
		}

		return new McpConnectorHub(servers, connectedClients);
	}

	/** Ordered list of connected MCP servers. */
	servers(): readonly ConnectedMcpServer[] {
		return this.#servers;
	}

	/** Looks up a connected MCP server by its configured instance name. */
	server(name: string): ConnectedMcpServer | undefined {
		return this.#byName.get(name);
	}

	/** Closes all underlying MCP client transports cleanly. */
	async close(): Promise<void> {
		await Promise.allSettled(this.#clients.map((client) => client.close()));
	}
}
