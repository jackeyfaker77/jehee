// `pi-durable` extension exposing Jehee's portable read-only web tools (`"jehee.web"`):
// SSRF-guarded `web_fetch` and optional TinyFish-backed `web_search`.

import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { arr, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { fetchWebPage, MAX_WEB_FETCH_CHARS_CAP, type WebFetchOptions } from "./web-fetch.ts";
import { MAX_WEB_SEARCH_RESULTS_CAP, searchWeb, type WebSearchOptions } from "./web-search.ts";

/** Fixed extension slot name for Jehee's portable web tools (`web_fetch` + optional `web_search`). */
export const JEHEE_WEB_EXTENSION_NAME = "jehee.web";

/** Extension handle referencing `"jehee.web"` for `configure({ extensions: { remove: [...] } })`. */
export const JEHEE_WEB_EXTENSION_HANDLE: Extension = defineExtension({
	name: JEHEE_WEB_EXTENSION_NAME,
});

/** Read-only tool name for fetching and extracting readable text from public HTTP/HTTPS URLs. */
export const WEB_FETCH_TOOL = "web_fetch";

/** Read-only tool name for live web search (powered by TinyFish TinySearch). */
export const WEB_SEARCH_TOOL = "web_search";

/** Options for enabling and configuring the `web_search` tool inside `"jehee.web"`. */
export type CreateWebSearchToolOptions = Omit<WebSearchOptions, "signal"> & {
	/** Whether to expose `web_search` on the conversation (defaults to `true` when `apiKey` is provided). */
	readonly enabled?: boolean;
	/** When true, marks `web_search` as deferred for on-demand discovery via `tool_search`. */
	readonly deferred?: boolean;
};

/** Options for configuring the `"jehee.web"` extension. */
export type CreateWebExtensionOptions = Omit<WebFetchOptions, "signal"> & {
	/** Whether to expose the `web_fetch` tool on the conversation (default `true`). */
	readonly enabled?: boolean;
	/** When true, marks `web_fetch` as deferred for on-demand discovery via `tool_search`. */
	readonly deferred?: boolean;
	/** Optional live `web_search` backend configuration (TinyFish TinySearch). */
	readonly webSearch?: CreateWebSearchToolOptions;
};

/** Creates the `"jehee.web"` extension exposing `web_fetch` and optional `web_search` read-only tools. */
export function createWebExtension(options?: CreateWebExtensionOptions): Extension {
	const webFetchTool =
		options?.enabled !== false
			? defineTool({
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
				})
			: undefined;

	const searchCfg = options?.webSearch;
	const webSearchTool =
		searchCfg !== undefined && searchCfg.enabled !== false && searchCfg.apiKey.trim().length > 0
			? defineTool({
					name: WEB_SEARCH_TOOL,
					description:
						"Search the live web using TinyFish TinySearch and return ranked titles, URLs, dates, and concise snippets. Follow up with `web_fetch` on a specific URL when you need the full page text.",
					parameters: obj({
						query: str({ description: "Search query string (plain keywords or question)." }),
						maxResults: opt(
							int({
								description: `Optional maximum results to return (default 8, max ${MAX_WEB_SEARCH_RESULTS_CAP}).`,
							}),
						),
						domainType: opt(
							oneOf(["web", "news", "research_paper"], {
								description: 'Optional result category: "web" (default), "news", or "research_paper".',
							}),
						),
						language: opt(str({ description: 'Optional ISO language code (e.g. "zh", "en", "ja").' })),
						location: opt(
							str({ description: 'Optional country code for geo-targeted results (e.g. "US", "CN", "JP").' }),
						),
						recencyMinutes: opt(
							int({ description: "Optional freshness window in minutes (e.g. 1440 for last 24 hours)." }),
						),
						afterDate: opt(str({ description: 'Optional lower date bound formatted as "YYYY-MM-DD".' })),
						beforeDate: opt(str({ description: 'Optional upper date bound formatted as "YYYY-MM-DD".' })),
						includeDomains: opt(arr(str(), { description: "Optional list of domains to restrict search to." })),
						excludeDomains: opt(arr(str(), { description: "Optional list of domains to exclude." })),
						page: opt(int({ description: "Optional 0-based pagination offset." })),
					}),
					...(searchCfg.deferred === true ? { deferred: true } : {}),
					replay: "safe",
					execute: async (args, _api, context): Promise<ToolExecutionResult> => {
						const result = await searchWeb(
							{
								query: args.query,
								...(args.maxResults !== undefined ? { maxResults: args.maxResults } : {}),
								...(args.domainType !== undefined ? { domainType: args.domainType } : {}),
								...(args.language !== undefined ? { language: args.language } : {}),
								...(args.location !== undefined ? { location: args.location } : {}),
								...(args.recencyMinutes !== undefined ? { recencyMinutes: args.recencyMinutes } : {}),
								...(args.afterDate !== undefined ? { afterDate: args.afterDate } : {}),
								...(args.beforeDate !== undefined ? { beforeDate: args.beforeDate } : {}),
								...(args.includeDomains !== undefined ? { includeDomains: args.includeDomains } : {}),
								...(args.excludeDomains !== undefined ? { excludeDomains: args.excludeDomains } : {}),
								...(args.page !== undefined ? { page: args.page } : {}),
							},
							{
								...searchCfg,
								...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
							},
						);

						if (!result.ok) {
							return {
								isError: true,
								output: [{ type: "text", text: JSON.stringify(result) }],
								details: {
									provider: result.provider,
									query: result.query,
									error: result.error,
									...(result.status !== undefined ? { status: result.status } : {}),
								},
							};
						}

						return {
							output: [{ type: "text", text: JSON.stringify(result) }],
							details: {
								provider: result.provider,
								query: result.query,
								resultCount: result.results.length,
								truncated: result.truncatedResults,
							},
						};
					},
				})
			: undefined;

	return defineExtension({
		name: JEHEE_WEB_EXTENSION_NAME,
		tools: [
			...(webFetchTool !== undefined ? [webFetchTool] : []),
			...(webSearchTool !== undefined ? [webSearchTool] : []),
		],
	});
}
