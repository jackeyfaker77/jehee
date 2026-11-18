// Node-only helper constructing `stdio` MCP server specs (e.g. for local connectors and PALE benchmark environments).
// Kept outside `src/core/host.ts` and `worker.ts` so Cloudflare Workers bundles stay 100% free of `child_process`.

import { StdioTransport, type StdioTransportOptions } from "@earendil-works/pi-mcp";
import type { JeheeMcpServerSpec } from "./contract.ts";

/** Options for defining a local `stdio` MCP server instance in Node 24 runtimes. */
export type StdioMcpServerSpecOptions = StdioTransportOptions & {
	readonly name: string;
	readonly description?: string;
	readonly includeTools?: readonly string[];
	readonly excludeTools?: readonly string[];
	readonly requestTimeoutMs?: number;
};

/** Wraps a local `StdioTransport` process configuration as a portable `JeheeMcpServerSpec`. */
export function stdioMcpServer(options: StdioMcpServerSpecOptions): JeheeMcpServerSpec {
	const { name, description, includeTools, excludeTools, requestTimeoutMs, ...stdioOptions } = options;
	return {
		name,
		...(description !== undefined ? { description } : {}),
		...(includeTools !== undefined ? { includeTools } : {}),
		...(excludeTools !== undefined ? { excludeTools } : {}),
		...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
		transport: {
			kind: "custom",
			create: () => new StdioTransport(stdioOptions),
		},
	};
}
