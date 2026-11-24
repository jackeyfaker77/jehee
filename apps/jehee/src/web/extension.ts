// `pi-durable` extension exposing Jehee's portable SSRF-guarded read-only `web_fetch` tool (`"jehee.web"`).

import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { fetchWebPage, MAX_WEB_FETCH_CHARS_CAP, type WebFetchOptions } from "./web-fetch.ts";

/** Fixed extension slot name for Jehee's portable web fetch tool. */
export const JEHEE_WEB_EXTENSION_NAME = "jehee.web";

/** Extension handle referencing `"jehee.web"` for `configure({ extensions: { remove: [...] } })`. */
export const JEHEE_WEB_EXTENSION_HANDLE: Extension = defineExtension({
	name: JEHEE_WEB_EXTENSION_NAME,
});

/** Read-only tool name for fetching and extracting readable text from public HTTP/HTTPS URLs. */
export const WEB_FETCH_TOOL = "web_fetch";

/** Options for configuring the `"jehee.web"` extension. */
export type CreateWebExtensionOptions = Omit<WebFetchOptions, "signal"> & {
	/** Whether to expose the `web_fetch` tool on the conversation (default `true`). */
	readonly enabled?: boolean;
	/** When true, marks `web_fetch` as deferred for on-demand discovery via `tool_search`. */
	readonly deferred?: boolean;
};

/** Creates the `"jehee.web"` extension exposing the read-only, SSRF-guarded `web_fetch` tool. */
export function createWebExtension(options?: CreateWebExtensionOptions): Extension {
	if (options?.enabled === false) {
		return defineExtension({
			name: JEHEE_WEB_EXTENSION_NAME,
			tools: [],
		});
	}

	const webFetchTool = defineTool({
		name: WEB_FETCH_TOOL,
		description:
			"Fetch a public HTTP/HTTPS web page, Markdown/plain text document, or JSON endpoint and extract bounded readable text. Enforces SSRF guards against localhost, private networks, and cloud metadata endpoints.",
		parameters: obj({
			url: str({ description: "Public http:// or https:// URL to fetch." }),
			maxChars: opt(
				int({
					description: `Optional maximum characters of extracted text to return (default 12000, max ${MAX_WEB_FETCH_CHARS_CAP}).`,
				}),
			),
		}),
		...(options?.deferred === true ? { deferred: true } : {}),
		replay: "safe",
		execute: async (args, _api, context): Promise<ToolExecutionResult> => {
			const effectiveMaxChars = args.maxChars ?? options?.maxChars;
			const result = await fetchWebPage(args.url, {
				...(options?.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
				...(effectiveMaxChars !== undefined ? { maxChars: effectiveMaxChars } : {}),
				...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
				...(options?.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}),
				...(options?.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
				...(options?.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
				...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
			});

			if (!result.ok) {
				return {
					isError: true,
					output: [{ type: "text", text: JSON.stringify(result) }],
					details: {
						url: result.url,
						error: result.error,
						...(result.status !== undefined ? { status: result.status } : {}),
					},
				};
			}

			return {
				output: [{ type: "text", text: JSON.stringify(result) }],
				details: {
					url: result.url,
					finalUrl: result.finalUrl,
					status: result.status,
					contentType: result.contentType,
					bytesRead: result.bytesRead,
					truncated: result.truncatedBytes || result.truncatedChars,
				},
			};
		},
	});

	return defineExtension({
		name: JEHEE_WEB_EXTENSION_NAME,
		tools: [webFetchTool],
	});
}
