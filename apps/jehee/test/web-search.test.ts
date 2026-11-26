// Unit tests for Jehee's portable TinyFish TinySearch `web_search` client, `"jehee.web"` extension integration,
// runtime env parsing, credential redaction, strict `this === undefined` fetch invocation, and `web_search -> web_fetch` chaining.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SystemMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { JeheeHost } from "../src/core/host.ts";
import { parseJeheeEnvConfig } from "../src/runtime/config.ts";
import {
	createWebExtension,
	JEHEE_WEB_EXTENSION_HANDLE,
	JEHEE_WEB_EXTENSION_NAME,
	WEB_FETCH_TOOL,
	WEB_SEARCH_TOOL,
} from "../src/web/extension.ts";
import { searchWeb } from "../src/web/web-search.ts";

describe("web_search TinyFish client", () => {
	it("serializes TinySearch query parameters, parses live response shape (optional total_results/page and mixed dates), and enforces bounds", async () => {
		let seenUrl = "";
		let seenKey = "";
		let seenThis: unknown = "unset";

		async function strictFetch(this: unknown, input: string | URL | Request, init?: RequestInit): Promise<Response> {
			seenThis = this;
			if (this !== undefined) {
				throw new TypeError("Illegal invocation");
			}
			seenUrl = String(input);
			const headers = new Headers(init?.headers);
			seenKey = headers.get("X-API-Key") ?? "";
			assert.equal(init?.method, "GET");

			return new Response(
				JSON.stringify({
					query: "Cloudflare Workers Durable Objects",
					results: [
						{
							position: 1,
							date: "2026-11-21T00:26:58Z",
							site_name: "developers.cloudflare.com",
							title: "What are Durable Objects?",
							snippet: "A".repeat(80),
							url: "https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects",
						},
						{
							position: 2,
							date: "Oct 12, 2026",
							site_name: "blog.cloudflare.com",
							title: "SQLite in Durable Objects",
							snippet: "Fast   embedded   SQLite   storage.",
							url: "https://blog.cloudflare.com/sqlite-in-do",
						},
						{
							// Malformed hit missing URL should be skipped safely.
							position: 3,
							title: "Broken hit",
						},
						{
							position: 4,
							title: "Extra result trimmed by maxResults",
							snippet: "Should not be returned.",
							url: "https://example.com/extra",
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}

		const res = await searchWeb(
			{
				query: "  Cloudflare Workers Durable Objects  ",
				maxResults: 2,
				domainType: "news",
				language: "en",
				location: "US",
				recencyMinutes: 1440,
				afterDate: "2026-01-01",
				beforeDate: "2026-12-31",
				includeDomains: ["developers.cloudflare.com", " blog.cloudflare.com "],
				excludeDomains: ["pinterest.com"],
				page: 0,
			},
			{
				apiKey: "sk-tinyfish-test-secret",
				maxSnippetChars: 60,
				fetchImpl: strictFetch,
			},
		);

		assert.equal(seenThis, undefined);
		assert.equal(seenKey, "sk-tinyfish-test-secret");
		const parsedUrl = new URL(seenUrl);
		assert.equal(parsedUrl.origin, "https://api.search.tinyfish.ai");
		assert.equal(parsedUrl.searchParams.get("query"), "Cloudflare Workers Durable Objects");
		assert.equal(parsedUrl.searchParams.get("domain_type"), "news");
		assert.equal(parsedUrl.searchParams.get("language"), "en");
		assert.equal(parsedUrl.searchParams.get("location"), "US");
		assert.equal(parsedUrl.searchParams.get("recency_minutes"), "1440");
		assert.equal(parsedUrl.searchParams.get("after_date"), "2026-01-01");
		assert.equal(parsedUrl.searchParams.get("before_date"), "2026-12-31");
		assert.equal(parsedUrl.searchParams.get("include_domains"), "developers.cloudflare.com,blog.cloudflare.com");
		assert.equal(parsedUrl.searchParams.get("exclude_domains"), "pinterest.com");
		assert.equal(parsedUrl.searchParams.get("page"), "0");

		assert.equal(res.ok, true);
		if (res.ok) {
			assert.equal(res.provider, "tinyfish");
			assert.equal(res.totalResults, undefined);
			assert.equal(res.page, undefined);
			assert.equal(res.truncatedResults, true);
			assert.equal(res.results.length, 2);
			assert.equal(res.results[0]?.date, "2026-11-21T00:26:58Z");
			assert.equal(res.results[0]?.siteName, "developers.cloudflare.com");
			assert.equal(res.results[0]?.snippet, `${"A".repeat(60)}...`);
			assert.equal(res.results[1]?.date, "Oct 12, 2026");
			assert.equal(res.results[1]?.snippet, "Fast embedded SQLite storage.");
		}
	});

	it("validates query/date/recency inputs, handles HTTP 429 & timeout, and redacts apiKey from upstream error bodies", async () => {
		const emptyQuery = await searchWeb({ query: "   " }, { apiKey: "sk-key" });
		assert.equal(emptyQuery.ok, false);
		if (!emptyQuery.ok) assert.equal(emptyQuery.error, "invalid_query");

		const badDate = await searchWeb({ query: "test", afterDate: "2026/01/01" }, { apiKey: "sk-key" });
		assert.equal(badDate.ok, false);
		if (!badDate.ok) assert.equal(badDate.error, "invalid_query");

		const missingKey = await searchWeb({ query: "test" }, { apiKey: "   " });
		assert.equal(missingKey.ok, false);
		if (!missingKey.ok) assert.equal(missingKey.error, "missing_api_key");

		const secretKey = "sk-tinyfish-ultra-secret-999";
		const rateLimited = await searchWeb(
			{ query: "news" },
			{
				apiKey: secretKey,
				fetchImpl: async () =>
					new Response(`Rate limit exceeded for key ${secretKey}`, {
						status: 429,
						headers: { "content-type": "text/plain" },
					}),
			},
		);
		assert.equal(rateLimited.ok, false);
		if (!rateLimited.ok) {
			assert.equal(rateLimited.error, "rate_limited");
			assert.equal(rateLimited.status, 429);
			assert.equal(rateLimited.message.includes(secretKey), false);
			assert.equal(rateLimited.message.includes("[redacted]"), true);
		}

		const timeoutRes = await searchWeb(
			{ query: "slow query" },
			{
				apiKey: secretKey,
				timeoutMs: 100,
				fetchImpl: (_input, init) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
							{ once: true },
						);
					}),
			},
		);
		assert.equal(timeoutRes.ok, false);
		if (!timeoutRes.ok) {
			assert.equal(timeoutRes.error, "timeout");
		}
	});
});

describe("jehee.web web_search integration & env config", () => {
	it("parses TINYFISH_API_KEY and optional web search defaults via parseJeheeEnvConfig", () => {
		const withoutKey = parseJeheeEnvConfig({
			OPENCODE_GO_API_KEY: "dummy-key",
		});
		assert.equal(withoutKey.webSearch, undefined);

		const withKey = parseJeheeEnvConfig({
			OPENCODE_GO_API_KEY: "dummy-key",
			TINYFISH_API_KEY: "  sk-tinyfish-demo  ",
			TINYFISH_SEARCH_BASE_URL: "https://search.example.test",
			JEHEE_WEB_SEARCH_LANGUAGE: "zh",
			JEHEE_WEB_SEARCH_LOCATION: "CN",
		});
		assert.deepEqual(withKey.webSearch, {
			provider: "tinyfish",
			apiKey: "sk-tinyfish-demo",
			baseUrl: "https://search.example.test",
			defaultLanguage: "zh",
			defaultLocation: "CN",
		});
	});

	it("chains web_search into web_fetch through JeheeHost and omits web_search when unconfigured", async () => {
		assert.equal(JEHEE_WEB_EXTENSION_NAME, "jehee.web");
		assert.equal(JEHEE_WEB_EXTENSION_HANDLE.name, "jehee.web");
		assert.equal(WEB_SEARCH_TOOL, "web_search");

		const extWithoutSearch = createWebExtension({ enabled: true });
		assert.deepEqual(
			extWithoutSearch.tools?.map((t) => t.name),
			[WEB_FETCH_TOOL],
		);

		const extWithSearch = createWebExtension({
			enabled: true,
			webSearch: { apiKey: "sk-tinyfish-live-mock" },
		});
		assert.deepEqual(
			extWithSearch.tools?.map((t) => t.name),
			[WEB_FETCH_TOOL, WEB_SEARCH_TOOL],
		);

		const collectActiveTools = (ctx: TranscriptContext): string[] => {
			const tools = new Set<string>();
			for (const msg of ctx.messages) {
				if (msg.role !== "system") continue;
				const sys = msg as SystemMessage;
				for (const t of sys.toolsAdded ?? []) tools.add(t.name);
				for (const t of sys.toolsRemoved ?? []) tools.delete(t.name);
			}
			return [...tools];
		};

		const seenToolNames: string[] = [];
		const seenSearchResults: string[] = [];
		const faux = fauxProvider();
		faux.setResponses([
			(ctx) => {
				for (const name of collectActiveTools(ctx)) {
					seenToolNames.push(name);
				}
				return fauxAssistantMessage(
					[fauxToolCall(WEB_SEARCH_TOOL, { query: "Jehee Durable Objects", maxResults: 3 })],
					{ stopReason: "toolUse" },
				);
			},
			(ctx) => {
				for (const msg of ctx.messages) {
					if (msg.role === "toolResult" && msg.toolName === WEB_SEARCH_TOOL) {
						seenSearchResults.push(
							msg.content
								.filter((c) => c.type === "text")
								.map((c) => c.text)
								.join(""),
						);
					}
				}
				return fauxAssistantMessage(
					[fauxToolCall(WEB_FETCH_TOOL, { url: "https://docs.example.com/jehee-search" })],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("Searched via TinyFish and read the top doc."),
		]);

		const models = createModels();
		models.setProvider(faux.provider);

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				enableWebFetch: true,
				webFetch: {
					fetchImpl: async (input) => {
						assert.equal(String(input), "https://docs.example.com/jehee-search");
						return new Response(
							"<html><title>Jehee Search</title><body><p>Full article body.</p></body></html>",
							{
								status: 200,
								headers: { "content-type": "text/html" },
							},
						);
					},
				},
				webSearch: {
					apiKey: "sk-tinyfish-live-mock",
					fetchImpl: async () =>
						new Response(
							JSON.stringify({
								query: "Jehee Durable Objects",
								results: [
									{
										position: 1,
										title: "Jehee Search",
										site_name: "docs.example.com",
										date: "2026-11-27T00:00:00Z",
										snippet: "Portable search + fetch guide.",
										url: "https://docs.example.com/jehee-search",
									},
								],
							}),
							{ status: 200, headers: { "content-type": "application/json" } },
						),
				},
			},
			BACKGROUND_CONTEXT,
		);

		try {
			const reply = await host.sendMessage({ text: "Search and read Jehee docs" }, BACKGROUND_CONTEXT);
			assert.equal(reply.status, "done");
			if (reply.status === "done") {
				assert.equal(reply.replyText, "Searched via TinyFish and read the top doc.");
			}
			assert.ok(seenToolNames.includes(WEB_SEARCH_TOOL));
			assert.ok(seenToolNames.includes(WEB_FETCH_TOOL));
			assert.equal(seenSearchResults.length, 1);
			const parsed = JSON.parse(seenSearchResults[0]!) as {
				ok: boolean;
				results: Array<{ title: string; url: string }>;
			};
			assert.equal(parsed.ok, true);
			assert.equal(parsed.results[0]?.url, "https://docs.example.com/jehee-search");
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}
	});
});
