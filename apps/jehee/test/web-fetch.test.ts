// Unit tests for Jehee's portable SSRF-guarded `web_fetch` module and `"jehee.web"` pi-durable extension:
// URL/IP SSRF blocking (including redirect targets & IPv4-mapped IPv6), HTML/JSON/text extraction, byte/char
// truncation, timeout handling, strict `this === undefined` fetch invocation, and tool execution via JeheeHost.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { JeheeHost } from "../src/core/host.ts";
import {
	createWebExtension,
	JEHEE_WEB_EXTENSION_HANDLE,
	JEHEE_WEB_EXTENSION_NAME,
	WEB_FETCH_TOOL,
} from "../src/web/extension.ts";
import { extractReadableWebText, fetchWebPage, validatePublicHttpUrl } from "../src/web/web-fetch.ts";

describe("web_fetch SSRF guards", () => {
	it("allows public http/https URLs and blocks non-http schemes, localhost, internal suffixes, and non-public IPv4/IPv6 ranges", () => {
		// Allowed public URLs
		for (const allowed of [
			"https://example.com/docs/intro",
			"http://news.ycombinator.com/",
			"https://1.1.1.1/dns-query",
			"https://172.15.0.1/",
			"https://172.32.0.1/",
			"https://100.63.255.255/",
			"https://100.128.0.1/",
			"https://[2606:4700:4700::1111]/",
		]) {
			const res = validatePublicHttpUrl(allowed);
			assert.equal(res.ok, true, `expected allowed: ${allowed}`);
		}

		// Blocked schemes & private/internal/metadata targets
		const blockedCases: readonly string[] = [
			"file:///etc/passwd",
			"ftp://example.com/pub",
			"javascript:alert(1)",
			"data:text/html,<h1>hi</h1>",
			"http://localhost/admin",
			"https://sub.localhost:8080/health",
			"http://printer.local/status",
			"http://metadata.google.internal/computeMetadata/v1/",
			"http://127.0.0.1/",
			"http://127.255.255.254:3000/",
			"http://2130706433/", // decimal 127.0.0.1 normalized by URL parser
			"http://0177.0.0.1/", // octal loopback
			"http://0x7f000001/", // hex loopback
			"http://127.1/", // shorthand loopback
			"http://10.0.0.1/",
			"http://172.16.0.1/",
			"http://172.31.255.254/",
			"http://192.168.1.10/",
			"http://169.254.169.254/latest/meta-data/",
			"http://100.64.0.1/",
			"http://100.127.255.254/",
			"http://0.0.0.0/",
			"http://[::1]/",
			"http://[::]/",
			"http://[::127.0.0.1]/",
			"http://[::169.254.169.254]/",
			"http://[::7f00:1]/",
			"http://[fc00::1]/",
			"http://[fd12:3456:789a::1]/",
			"http://[fe80::1]/",
			"http://[fec0::1]/",
			"http://[100::1]/",
			"http://[::ffff:127.0.0.1]/",
			"http://[::ffff:169.254.169.254]/latest/meta-data/",
			"http://[::ffff:0:127.0.0.1]/",
			"http://[::ffff:0:169.254.169.254]/",
			"http://[64:ff9b:1::127.0.0.1]/",
			"http://[2002:7f00:0001::]/",
			"http://[2002:a9fe:a9fe::]/",
		];
		for (const blocked of blockedCases) {
			const res = validatePublicHttpUrl(blocked);
			assert.equal(res.ok, false, `expected blocked: ${blocked}`);
			if (!res.ok) {
				assert.equal(res.code, "ssrf_blocked", `expected ssrf_blocked for ${blocked}, got ${res.code}`);
			}
		}

		const malformed = validatePublicHttpUrl("not a url at all");
		assert.equal(malformed.ok, false);
		if (!malformed.ok) assert.equal(malformed.code, "invalid_url");
	});

	it("blocks HTTP redirects pointing to cloud metadata, loopback, or localhost without fetching the redirect target", async () => {
		const forbiddenTargets = [
			"http://169.254.169.254/latest/meta-data/iam/security-credentials/",
			"http://127.0.0.1:8080/internal",
			"http://localhost/secret",
		];

		for (const target of forbiddenTargets) {
			const called: string[] = [];
			const res = await fetchWebPage("https://public.example.com/start", {
				fetchImpl: async (input) => {
					const url = String(input);
					called.push(url);
					return new Response(null, { status: 302, headers: { location: target } });
				},
			});
			assert.equal(res.ok, false);
			if (!res.ok) {
				assert.equal(res.error, "ssrf_blocked");
			}
			assert.deepEqual(called, ["https://public.example.com/start"]);
		}
	});

	it("follows safe public redirects up to maxRedirects and rejects excessive redirect chains", async () => {
		const res = await fetchWebPage("https://example.com/old", {
			fetchImpl: async (input) => {
				const url = String(input);
				if (url === "https://example.com/old") {
					return new Response(null, { status: 301, headers: { location: "/new-page" } });
				}
				return new Response("Welcome to the new page", {
					status: 200,
					headers: { "content-type": "text/plain; charset=utf-8" },
				});
			},
		});
		assert.equal(res.ok, true);
		if (res.ok) {
			assert.equal(res.finalUrl, "https://example.com/new-page");
			assert.equal(res.redirectCount, 1);
			assert.equal(res.text, "Welcome to the new page");
		}

		let hop = 0;
		const tooMany = await fetchWebPage("https://example.com/loop", {
			maxRedirects: 2,
			fetchImpl: async () => {
				hop += 1;
				return new Response(null, { status: 302, headers: { location: `https://example.com/hop-${hop}` } });
			},
		});
		assert.equal(tooMany.ok, false);
		if (!tooMany.ok) {
			assert.equal(tooMany.error, "too_many_redirects");
		}
	});
});

describe("web_fetch content extraction, bounds, timeout, and strict fetch", () => {
	it("extracts readable text and title from HTML while stripping scripts, styles, noscript, svg, and comments", () => {
		const html = [
			"<!doctype html>",
			"<html>",
			"<head>",
			"  <title>Jehee &amp; Docs &mdash; Guide</title>",
			"  <style>body { color: red; }</style>",
			"  <script>window.__secret = 'ignore-me';</script>",
			"</head>",
			"<body>",
			"  <!-- secret html comment -->",
			"  <svg><text>svg-icon-text</text></svg>",
			"  <noscript>Enable JS</noscript>",
			"  <h1>Welcome to Jehee</h1>",
			"  <p>Fast &amp; portable&#39;s runtime &lt;v2&gt; &nbsp; works everywhere.</p>",
			"  <div>Second&nbsp;paragraph &#x2014; done.</div>",
			"</body>",
			"</html>",
		].join("\n");

		const extracted = extractReadableWebText(html, "text/html; charset=utf-8");
		assert.equal(extracted.title, "Jehee & Docs — Guide");
		assert.equal(extracted.truncated, false);
		assert.ok(extracted.text.includes("Welcome to Jehee"));
		assert.ok(extracted.text.includes("Fast & portable's runtime <v2> works everywhere."));
		assert.ok(extracted.text.includes("Second paragraph — done."));
		assert.equal(extracted.text.includes("ignore-me"), false);
		assert.equal(extracted.text.includes("color: red"), false);
		assert.equal(extracted.text.includes("secret html comment"), false);
		assert.equal(extracted.text.includes("svg-icon-text"), false);
		assert.equal(extracted.text.includes("Enable JS"), false);
	});

	it("handles JSON, plain text, unsupported binary content-types, and enforces maxBytes + maxChars truncation", async () => {
		const jsonRes = await fetchWebPage("https://api.example.com/info.json", {
			fetchImpl: async () =>
				new Response('{"name":"jehee","portable":true}', {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		});
		assert.equal(jsonRes.ok, true);
		if (jsonRes.ok) {
			assert.equal(jsonRes.contentType, "application/json");
			assert.equal(jsonRes.text, '{\n  "name": "jehee",\n  "portable": true\n}');
		}

		const binaryRes = await fetchWebPage("https://example.com/manual.pdf", {
			fetchImpl: async () =>
				new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { "content-type": "application/pdf" },
				}),
		});
		assert.equal(binaryRes.ok, false);
		if (!binaryRes.ok) {
			assert.equal(binaryRes.error, "unsupported_content_type");
		}

		// Stream exceeds maxBytes (1024) and text exceeds maxChars (150).
		const largeRes = await fetchWebPage("https://example.com/huge.txt", {
			maxBytes: 1024,
			maxChars: 150,
			fetchImpl: async () => {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("A".repeat(800)));
						controller.enqueue(new TextEncoder().encode("B".repeat(800)));
						controller.close();
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/plain" },
				});
			},
		});
		assert.equal(largeRes.ok, true);
		if (largeRes.ok) {
			assert.equal(largeRes.bytesRead, 1024);
			assert.equal(largeRes.truncatedBytes, true);
			assert.equal(largeRes.truncatedChars, true);
			assert.match(largeRes.text, /\.\.\.\[truncated\]$/);
		}
	});

	it("returns timeout error when fetch exceeds timeoutMs and invokes fetch with `this === undefined`", async () => {
		let seenThis: unknown = "unset";
		async function strictFetch(this: unknown, _input: string | URL | Request, init?: RequestInit): Promise<Response> {
			seenThis = this;
			if (this !== undefined) {
				throw new TypeError("Illegal invocation");
			}
			assert.equal(init?.redirect, "manual");
			return new Response("<html><title>OK</title><body><p>Portable</p></body></html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		}

		const okRes = await fetchWebPage("https://example.com/ok", { fetchImpl: strictFetch });
		assert.equal(seenThis, undefined);
		assert.equal(okRes.ok, true);

		const timeoutRes = await fetchWebPage("https://example.com/slow", {
			timeoutMs: 100,
			fetchImpl: (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => {
							reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
						},
						{ once: true },
					);
				}),
		});
		assert.equal(timeoutRes.ok, false);
		if (!timeoutRes.ok) {
			assert.equal(timeoutRes.error, "timeout");
		}
	});
});

describe("jehee.web pi-durable extension", () => {
	it("exposes stable handle/constants and executes web_fetch through JeheeHost for both public and SSRF-blocked URLs", async () => {
		assert.equal(JEHEE_WEB_EXTENSION_NAME, "jehee.web");
		assert.equal(JEHEE_WEB_EXTENSION_HANDLE.name, "jehee.web");
		assert.equal(WEB_FETCH_TOOL, "web_fetch");

		const seenToolResults: Array<{ isError: boolean; text: string }> = [];
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(WEB_FETCH_TOOL, { url: "https://docs.example.com/guide", maxChars: 200 }),
					fauxToolCall(WEB_FETCH_TOOL, { url: "http://169.254.169.254/latest/meta-data/" }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				for (const msg of context.messages) {
					if (msg.role === "toolResult" && msg.toolName === WEB_FETCH_TOOL) {
						const text = msg.content
							.filter((c) => c.type === "text")
							.map((c) => c.text)
							.join("");
						seenToolResults.push({ isError: msg.isError, text });
					}
				}
				return fauxAssistantMessage("Fetched guide and blocked metadata endpoint.");
			},
		]);

		const models = createModels();
		models.setProvider(faux.provider);

		const webExtension = createWebExtension({
			fetchImpl: async (input) => {
				assert.equal(String(input), "https://docs.example.com/guide");
				return new Response(
					"<html><head><title>Guide</title></head><body><p>Hello from public docs.</p></body></html>",
					{ status: 200, headers: { "content-type": "text/html" } },
				);
			},
		});

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				extensions: [webExtension],
			},
			BACKGROUND_CONTEXT,
		);

		try {
			const reply = await host.sendMessage({ text: "Read the guide" }, BACKGROUND_CONTEXT);
			assert.equal(reply.status, "done");
			if (reply.status === "done") {
				assert.equal(reply.replyText, "Fetched guide and blocked metadata endpoint.");
			}
			assert.equal(seenToolResults.length, 2);

			assert.equal(seenToolResults[0]!.isError, false);
			const parsedOk = JSON.parse(seenToolResults[0]!.text) as {
				ok: boolean;
				title?: string;
				text?: string;
			};
			assert.equal(parsedOk.ok, true);
			assert.equal(parsedOk.title, "Guide");
			assert.ok(parsedOk.text?.includes("Hello from public docs."));

			assert.equal(seenToolResults[1]!.isError, true);
			const parsedBlocked = JSON.parse(seenToolResults[1]!.text) as {
				ok: boolean;
				error?: string;
			};
			assert.equal(parsedBlocked.ok, false);
			assert.equal(parsedBlocked.error, "ssrf_blocked");
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}
	});
});
