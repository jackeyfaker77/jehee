// Portable multi-server MCP client hub managing handshake, tool filtering, resource queries, and clean teardown.

import { McpClient, mcpNamespace, mcpServerSummary, StreamableHttpTransport, type Tool } from "@earendil-works/pi-mcp";
import type { ConnectedMcpServer, FailedMcpServer, JeheeMcpServerSpec } from "./contract.ts";

const SERVER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_SUMMARY_CHARS = 250;
const MAX_ERROR_CHARS = 300;
const SENSITIVE_NAME_PATTERN = /auth|token|key|secret|cookie|pass/i;

function sanitizeMcpErrorMessage(error: unknown, spec: JeheeMcpServerSpec): string {
	let message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
	if (spec.transport.kind === "http") {
		try {
			const parsedUrl = new URL(spec.transport.url);
			if (parsedUrl.password.length > 0) {
				if (parsedUrl.username.length > 0) {
					message = message.replaceAll(`${parsedUrl.username}:${parsedUrl.password}`, "[redacted]");
				}
				message = message.replaceAll(parsedUrl.password, "[redacted]");
			}
			for (const [paramName, paramValue] of parsedUrl.searchParams.entries()) {
				const trimmed = paramValue.trim();
				if (trimmed.length === 0 || !SENSITIVE_NAME_PATTERN.test(paramName)) continue;
				message = message.replaceAll(trimmed, "[redacted]");
				const encoded = encodeURIComponent(trimmed);
				if (encoded !== trimmed) {
					message = message.replaceAll(encoded, "[redacted]");
				}
			}
		} catch {
			// Invalid URL string falls back to generic regex redaction below.
		}
		if (spec.transport.headers !== undefined) {
			for (const [headerName, headerValue] of Object.entries(spec.transport.headers)) {
				const trimmed = headerValue.trim();
				if (trimmed.length === 0) continue;
				const isSensitive = SENSITIVE_NAME_PATTERN.test(headerName) || /^(?:bearer|basic)\s+/i.test(trimmed);
				if (!isSensitive) continue;
				message = message.replaceAll(trimmed, "[redacted]");
				const schemeSplit = /^[A-Za-z0-9_-]+\s+(.+)$/.exec(trimmed);
				const tokenPart = schemeSplit?.[1]?.trim();
				if (tokenPart !== undefined && tokenPart.length >= 4) {
					message = message.replaceAll(tokenPart, "[redacted]");
				}
			}
		}
	}
	message = message
		.replace(/(https?:\/\/)([^/\s@]+)@/gi, "$1[redacted]@")
		.replace(
			/((?:["']?(?:proxy-)?authorization["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:bearer|basic)\s+[^\s,;}"']+|[^\s,;}"']+)/gi,
			"$1[redacted]",
		)
		.replace(/(\b(?:bearer|basic)\s+)([^\s,;}"']+)/gi, "$1[redacted]")
		.replace(
			/((?:^|[\s?&;,{"'])(?:["']?(?:x-api-key|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|cookie|password|passwd|auth|key)["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,&;}"']+)/gi,
			"$1[redacted]",
		);
	if (message.length === 0) return "Connection failed";
	return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS - 1).trimEnd()}…` : message;
}

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
	readonly #failedServers: readonly FailedMcpServer[];

	private constructor(
		servers: readonly ConnectedMcpServer[],
		clients: readonly McpClient[],
		failedServers: readonly FailedMcpServer[],
	) {
		this.#servers = servers;
		this.#byName = new Map(servers.map((server) => [server.name, server]));
		this.#clients = clients;
		this.#failedServers = failedServers;
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
		const failedServers: FailedMcpServer[] = [];

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
					const sanitizedError = sanitizeMcpErrorMessage(error, spec);
					failedServers.push({ name, error: sanitizedError });
					console.warn(`[jehee/mcp] skipped unreachable MCP server "${name}": ${sanitizedError}`);
				}
			}
		} catch (error) {
			await Promise.allSettled(connectedClients.map((client) => client.close()));
			throw error;
		}

		return new McpConnectorHub(servers, connectedClients, failedServers);
	}

	/** Ordered list of connected MCP servers. */
	servers(): readonly ConnectedMcpServer[] {
		return this.#servers;
	}

	/** Ordered list of unreachable MCP servers skipped under `bestEffort: true` (with sanitized error messages). */
	failedServers(): readonly FailedMcpServer[] {
		return this.#failedServers;
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
