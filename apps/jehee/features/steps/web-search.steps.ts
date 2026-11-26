// Cucumber step definitions verifying Slice 6D-1 (ADR-0017):
// 1. Chaining TinyFish `web_search` into SSRF-guarded `web_fetch` through `JeheeHost`;
// 2. Handling HTTP 429 rate limits cleanly while redacting `TINYFISH_API_KEY` from tool errors.

import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { JeheeHost } from "../../src/core/host.ts";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "../../src/web/extension.ts";
import type { JeheeWorld } from "../support/world.ts";

let searchApiKeySeen = "";
let fetchedUrlSeen = "";
let lastSearchToolResultText = "";
let lastSearchToolIsError = false;
const bddSecretKey = "sk-tinyfish-bdd-secret-key";

Given("a JeheeHost configured with TinyFish web_search and web_fetch", async function (this: JeheeWorld) {
	searchApiKeySeen = "";
	fetchedUrlSeen = "";
	lastSearchToolResultText = "";
	lastSearchToolIsError = false;

	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall(WEB_SEARCH_TOOL, { query: "Cloudflare Durable Objects SQLite", maxResults: 3 })],
			{ stopReason: "toolUse" },
		),
		(ctx) => {
			for (const msg of ctx.messages) {
				if (msg.role === "toolResult" && msg.toolName === WEB_SEARCH_TOOL) {
					lastSearchToolIsError = msg.isError;
					lastSearchToolResultText = msg.content
						.filter((c) => c.type === "text")
						.map((c) => c.text)
						.join("");
				}
			}
			return fauxAssistantMessage(
				[fauxToolCall(WEB_FETCH_TOOL, { url: "https://developers.cloudflare.com/durable-objects/sqlite" })],
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage(
			"Durable Objects SQLite supports zero-latency embedded storage (verified via search + fetch).",
		),
	]);

	const models = createModels();
	models.setProvider(faux.provider);

	this.host = await JeheeHost.open(
		{
			storage: { kind: "memory" },
			models,
			defaultModel: { provider: "faux", modelId: faux.getModel().id },
			enableWebFetch: true,
			webFetch: {
				fetchImpl: async (input) => {
					fetchedUrlSeen = String(input);
					return new Response(
						"<html><title>Durable Objects SQLite</title><body><p>Zero-latency embedded SQLite storage per DO.</p></body></html>",
						{ status: 200, headers: { "content-type": "text/html" } },
					);
				},
			},
			webSearch: {
				apiKey: bddSecretKey,
				fetchImpl: async (_input, init) => {
					searchApiKeySeen = new Headers(init?.headers).get("X-API-Key") ?? "";
					return new Response(
						JSON.stringify({
							query: "Cloudflare Durable Objects SQLite",
							results: [
								{
									position: 1,
									date: "2026-11-21T00:00:00Z",
									site_name: "developers.cloudflare.com",
									title: "Durable Objects SQLite",
									snippet: "Embedded SQLite backend for Cloudflare Durable Objects.",
									url: "https://developers.cloudflare.com/durable-objects/sqlite",
								},
							],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				},
			},
		},
		this.ctx,
	);
});

Given("a JeheeHost configured with TinyFish web_search returning rate limit errors", async function (this: JeheeWorld) {
	searchApiKeySeen = "";
	fetchedUrlSeen = "";
	lastSearchToolResultText = "";
	lastSearchToolIsError = false;

	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall(WEB_SEARCH_TOOL, { query: "breaking news" })], { stopReason: "toolUse" }),
		(ctx) => {
			for (const msg of ctx.messages) {
				if (msg.role === "toolResult" && msg.toolName === WEB_SEARCH_TOOL) {
					lastSearchToolIsError = msg.isError;
					lastSearchToolResultText = msg.content
						.filter((c) => c.type === "text")
						.map((c) => c.text)
						.join("");
				}
			}
			return fauxAssistantMessage("Search is temporarily rate limited; please retry shortly.");
		},
	]);

	const models = createModels();
	models.setProvider(faux.provider);

	this.host = await JeheeHost.open(
		{
			storage: { kind: "memory" },
			models,
			defaultModel: { provider: "faux", modelId: faux.getModel().id },
			enableWebFetch: true,
			webSearch: {
				apiKey: bddSecretKey,
				fetchImpl: async () =>
					new Response(`Too many requests for ${bddSecretKey}`, {
						status: 429,
						headers: { "content-type": "text/plain" },
					}),
			},
		},
		this.ctx,
	);
});

When(
	"the user asks Jehee to search for {string} and read the top result",
	async function (this: JeheeWorld, query: string) {
		assert.ok(this.host);
		this.lastReply = await this.host.sendMessage({ text: `Search for ${query} and read the top result` }, this.ctx);
	},
);

When("the user asks Jehee to search for {string}", async function (this: JeheeWorld, query: string) {
	assert.ok(this.host);
	this.lastReply = await this.host.sendMessage({ text: `Search for ${query}` }, this.ctx);
});

Then("Jehee should call web_search with the X-API-Key header and then fetch the discovered public URL", () => {
	assert.equal(searchApiKeySeen, bddSecretKey);
	assert.equal(lastSearchToolIsError, false);
	assert.equal(fetchedUrlSeen, "https://developers.cloudflare.com/durable-objects/sqlite");
});

Then("Jehee should answer using both the search hit and fetched page content", function (this: JeheeWorld) {
	assert.ok(this.lastReply);
	assert.equal(this.lastReply.status, "done");
	if (this.lastReply.status === "done") {
		assert.ok(this.lastReply.replyText.includes("Durable Objects SQLite"));
	}
});

Then("the web_search tool result should report {string} without leaking the API key", (expectedError: string) => {
	assert.equal(lastSearchToolIsError, true);
	assert.equal(lastSearchToolResultText.includes(bddSecretKey), false);
	const parsed = JSON.parse(lastSearchToolResultText) as { ok: boolean; error: string; message: string };
	assert.equal(parsed.ok, false);
	assert.equal(parsed.error, expectedError);
	assert.ok(parsed.message.includes("[redacted]"));
});
