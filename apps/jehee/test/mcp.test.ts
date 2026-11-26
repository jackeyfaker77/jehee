// Unit tests for MCP blob handle vault, server namespace validation, telemetry metric formulas, root-cause taxonomy, and Node stdio MCP.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import {
	isJsonRpcNotification,
	isJsonRpcRequest,
	JSON_RPC_ERROR_CODES,
	LATEST_PROTOCOL_VERSION,
	type McpTransport,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { StoredSpan } from "@earendil-works/pi-telemetry";
import {
	classifyFailureRootCause,
	computeTraceMetrics,
	createMcpBundle,
	JEHEE_BLOB_HANDLE_PREFIX,
	JeheeHost,
	JeheeTraceRecorder,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	LIST_MCP_RESOURCES_TOOL,
	McpBlobVault,
	McpConnectorHub,
	parseJeheeEnvConfig,
	parseMcpConfigJson,
	READ_MCP_RESOURCE_TOOL,
	validateMcpServerSpecs,
} from "../src/index.ts";
import { stdioMcpServer } from "../src/mcp/node-stdio.ts";
import { createOutboundMediaExtension, type OutboundMediaPayload, SEND_MEDIA_TOOL } from "../src/media/extension.ts";
import { assembleNodeRuntime } from "../src/runtime/node.ts";
import { createMockPaleEnvironment } from "./fixtures/pale-mcp-fixture.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");

describe("MCP blob vault, metric dictionary, and stdio connector", () => {
	it("offloads large binary base64 behind $jehee_blob handles and restores exact bytes", () => {
		const vault = new McpBlobVault();
		const pdfBytes = Buffer.alloc(8_192, 0xab);
		const pdfBase64 = pdfBytes.toString("base64");
		const expectedSha = createHash("sha256").update(pdfBytes).digest("hex");

		const rawToolJson = JSON.stringify({
			status: "ok",
			file: {
				filename: "receipt.pdf",
				mime_type: "application/pdf",
				base64: pdfBase64,
				sha256: expectedSha,
			},
		});

		const shaped = vault.shapeToolResultText(rawToolJson, 4_096);
		assert.equal(shaped.offloadedBytes, 8_192);
		assert.ok(!shaped.text.includes(pdfBase64));

		const parsed = JSON.parse(shaped.text) as { file: { base64: string; sha256: string } };
		assert.ok(parsed.file.base64.startsWith(JEHEE_BLOB_HANDLE_PREFIX));
		assert.equal(parsed.file.sha256, expectedSha);

		const restored = vault.restoreInArgs({
			id: "evt-1",
			files: [
				{
					filename: "receipt.pdf",
					mime_type: "application/pdf",
					base64: parsed.file.base64,
					sha256: expectedSha,
				},
			],
		});
		assert.equal(restored.restoredCount, 1);
		const files = restored.args.files as Array<{ base64: string }>;
		assert.equal(files[0]?.base64, pdfBase64);

		assert.throws(() => vault.restoreInArgs({ token: `${JEHEE_BLOB_HANDLE_PREFIX}missing` }));
	});

	it("adds UTF-8 decoded_text preview for text/calendar ICS attachments", () => {
		const vault = new McpBlobVault();
		const ics = "BEGIN:VCALENDAR\r\nUID:evt-9\r\nEND:VCALENDAR";
		const shaped = vault.shapeToolResultText(
			JSON.stringify({
				file: {
					filename: "invite.ics",
					mime_type: "text/calendar",
					base64: Buffer.from(ics, "utf8").toString("base64"),
				},
			}),
			4_096,
		);
		const parsed = JSON.parse(shaped.text) as { file: { decoded_text?: string } };
		assert.equal(parsed.file.decoded_text, ics);
	});

	it("rejects duplicate or namespace-colliding MCP server specs", () => {
		const dummy = { kind: "http" as const, url: "https://mcp.example.com" };
		validateMcpServerSpecs([
			{ name: "mail_personal", transport: dummy },
			{ name: "mail_work", transport: dummy },
		]);
		assert.throws(() =>
			validateMcpServerSpecs([
				{ name: "mail-work", transport: dummy },
				{ name: "mail_work", transport: dummy },
			]),
		);
	});

	it("computes exact prefill, overall KV-cache hit rate, post-warmup hit rate, and root causes", () => {
		const spans: StoredSpan[] = [
			{
				id: "s1",
				traceId: "t1",
				name: "pi.durable.submit",
				startedMs: 100,
				endedMs: 550,
				attributes: {},
				events: [],
				links: [],
				status: { status: "ok" },
			},
			{
				id: "s2",
				traceId: "t1",
				parentId: "s1",
				name: "pi.ai.request",
				startedMs: 110,
				endedMs: 250,
				attributes: {
					"usage.input": 200,
					"usage.output": 40,
					"usage.cache_read": 0,
					"usage.cache_write": 800,
					"cost.total": 0.001,
				},
				events: [{ name: "pi.ai.first_chunk", timeMs: 60, attributes: {} }],
				links: [],
				status: { status: "ok" },
			},
			{
				id: "s3",
				traceId: "t1",
				parentId: "s1",
				name: "pi.durable.phase",
				startedMs: 255,
				endedMs: 265,
				attributes: { "task.name": "pi.tool", "tool.name": "tool_search" },
				events: [],
				links: [],
				status: { status: "ok" },
			},
			{
				id: "s4",
				traceId: "t1",
				parentId: "s1",
				name: "pi.ai.request",
				startedMs: 270,
				endedMs: 540,
				attributes: {
					"usage.input": 100,
					"usage.output": 50,
					"usage.cache_read": 900,
					"usage.cache_write": 0,
					"cost.total": 0.0005,
				},
				events: [{ name: "pi.ai.first_chunk", timeMs: 40, attributes: {} }],
				links: [],
				status: { status: "ok" },
			},
		];

		const metrics = computeTraceMetrics(spans);
		assert.equal(metrics.llmTurns, 2);
		assert.equal(metrics.toolCalls, 1);
		assert.equal(metrics.toolSearchCalls, 1);
		assert.equal(metrics.prefillTokens, 2_000);
		assert.equal(metrics.cacheHitRate, 900 / 2_000);
		assert.equal(metrics.postWarmupCacheHitRate, 900 / 1_000);
		assert.equal(metrics.ttftP50Ms, 50);
		assert.equal(metrics.wallTimeMs, 450);

		assert.equal(classifyFailureRootCause({ spans, expectedServers: ["calendar"] }), "discovery_miss");
		assert.equal(classifyFailureRootCause({ spans, payloadOverflowDetected: true }), "payload_overflow");
		assert.equal(classifyFailureRootCause({ spans }), "model_reasoning");
		assert.equal(
			classifyFailureRootCause({
				spans: [
					{
						id: "b1",
						traceId: "t2",
						name: "jehee.mcp.call",
						startedMs: 1,
						endedMs: 2,
						attributes: { server: "mail", tool: "mail.send", "gate.action": "block", is_error: true },
						events: [],
						links: [],
						status: { status: "error", error: { name: "blocked", message: "blocked" } },
					},
				],
			}),
			"boundary_violation",
		);
		assert.equal(
			classifyFailureRootCause({
				spans: [
					{
						id: "v1",
						traceId: "t3",
						name: "jehee.mcp.call",
						startedMs: 1,
						endedMs: 2,
						attributes: {
							server: "calendar",
							tool: "calendar.import_ics",
							"mcp.status": "stale_version",
							is_error: true,
						},
						events: [],
						links: [],
						status: { status: "ok" },
					},
				],
			}),
			"arg_or_version_error",
		);
	});

	it("connects to a real child-process stdio MCP server via node-stdio helper", async () => {
		const fixtureScript = resolve(repoRoot, "packages/mcp/test/fixtures/stdio-server.mjs");
		const hub = await McpConnectorHub.connect([
			stdioMcpServer({
				name: "local_stdio_fixture",
				command: process.execPath,
				args: [fixtureScript],
			}),
		]);
		try {
			const server = hub.server("local_stdio_fixture");
			assert.ok(server);
			assert.ok(server.tools.length > 0);
		} finally {
			await hub.close();
		}
	});

	it("exposes the full MCP resource triad (list_mcp_resources, list_mcp_resource_templates, read_mcp_resource) and emits resource_read spans", async () => {
		const paleEnv = createMockPaleEnvironment({ pdfSizeBytes: 8_192, distractorServerCount: 0 });
		const recorder = new JeheeTraceRecorder();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		let capturedToolResults: string[] = [];
		faux.setResponses([
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall(LIST_MCP_RESOURCES_TOOL, {}),
						fauxToolCall(LIST_MCP_RESOURCE_TEMPLATES_TOOL, { server: "mail" }),
						fauxToolCall(READ_MCP_RESOURCE_TOOL, { server: "mail", uri: "pale://demo/mail/assets/att-pdf" }),
					],
					{ stopReason: "toolUse" },
				),
			(ctx) => {
				capturedToolResults = ctx.messages
					.filter((m) => m.role === "toolResult")
					.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text));
				return fauxAssistantMessage("资源列表、URI 模板与 PDF 句柄均已读取。");
			},
		]);

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				telemetry: recorder.telemetry,
				mcp: {
					servers: [paleEnv.mailSpec],
					exposure: "eager",
					blobOffloadThresholdBytes: 4_096,
				},
			},
			BACKGROUND_CONTEXT,
		);

		try {
			await host.sendMessage({ text: "检查邮件资源与模板并读取 PDF 收据资源" }, BACKGROUND_CONTEXT);
			await host.waitForIdle(BACKGROUND_CONTEXT);
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}

		assert.equal(capturedToolResults.length, 3);
		const resourcesPayload = JSON.parse(capturedToolResults[0]!) as { resources: Array<{ uri: string }> };
		assert.equal(resourcesPayload.resources.length, 2);

		const templatesPayload = JSON.parse(capturedToolResults[1]!) as {
			server: string;
			resourceTemplates: Array<{ uriTemplate: string }>;
		};
		assert.equal(templatesPayload.server, "mail");
		assert.equal(templatesPayload.resourceTemplates[0]?.uriTemplate, "pale://demo/mail/assets/{asset_id}");

		const pdfReadPayload = JSON.parse(capturedToolResults[2]!) as { base64: string; sha256: string };
		assert.ok(pdfReadPayload.base64.startsWith(JEHEE_BLOB_HANDLE_PREFIX));
		assert.equal(pdfReadPayload.sha256, paleEnv.expectedPdfSha256);

		const trace = await recorder.latestTrace();
		assert.ok(trace);
		const readSpan = trace.spans.find((s) => s.name === "jehee.mcp.resource_read");
		assert.ok(readSpan);
		assert.equal(readSpan.attributes.server, "mail");
		assert.equal(readSpan.attributes["blob.offloaded"], true);
	});

	it("discovers and invokes the MCP resource triad cleanly in default deferred mode via tool_search", async () => {
		const paleEnv = createMockPaleEnvironment({ pdfSizeBytes: 8_192, distractorServerCount: 0 });
		const recorder = new JeheeTraceRecorder();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		let capturedDeferredRead = "";
		faux.setResponses([
			() =>
				fauxAssistantMessage([fauxToolCall("tool_search", { query: "mcp resource" })], { stopReason: "toolUse" }),
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall(LIST_MCP_RESOURCES_TOOL, { server: "mail" }),
						fauxToolCall(READ_MCP_RESOURCE_TOOL, { server: "mail", uri: "pale://demo/mail/assets/att-pdf" }),
					],
					{ stopReason: "toolUse" },
				),
			(ctx) => {
				const texts = ctx.messages
					.filter((m) => m.role === "toolResult")
					.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text));
				capturedDeferredRead = texts.at(-1) ?? "";
				return fauxAssistantMessage("已通过 tool_search 按需检索并读取邮件 PDF 资源。");
			},
		]);

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				telemetry: recorder.telemetry,
				mcp: {
					servers: [paleEnv.mailSpec],
					exposure: "deferred",
					blobOffloadThresholdBytes: 4_096,
				},
			},
			BACKGROUND_CONTEXT,
		);

		try {
			await host.sendMessage({ text: "按需查找资源工具并读取邮件附件资源" }, BACKGROUND_CONTEXT);
			await host.waitForIdle(BACKGROUND_CONTEXT);
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}

		const parsedRead = JSON.parse(capturedDeferredRead) as { base64: string; sha256: string };
		assert.ok(parsedRead.base64.startsWith(JEHEE_BLOB_HANDLE_PREFIX));
		assert.equal(parsedRead.sha256, paleEnv.expectedPdfSha256);

		const trace = await recorder.latestTrace();
		assert.ok(trace);
		const readSpan = trace.spans.find((s) => s.name === "jehee.mcp.resource_read");
		assert.ok(readSpan);
		assert.equal(readSpan.attributes["blob.offloaded"], true);
	});

	it("parses mcpServers config with env interpolation, skips disabled servers, and blocks stdio on Worker config", () => {
		const rawJson = JSON.stringify({
			exposure: "eager",
			blobOffloadThresholdBytes: 8192,
			mcpServers: {
				remote_docs: {
					url: "https://mcp.example.com/v1",
					description: "Remote docs server",
					timeout: 15,
					includeTools: ["search_docs"],
					headers: { Authorization: `Bearer \${DOCS_API_TOKEN}` },
				},
				disabled_srv: {
					enabled: false,
					command: "npx",
					args: ["-y", "unused"],
				},
			},
		});

		const parsed = parseMcpConfigJson(rawJson, {
			env: { DOCS_API_TOKEN: "sec-xyz" },
		});
		assert.ok(parsed);
		assert.equal(parsed.exposure, "eager");
		assert.equal(parsed.blobOffloadThresholdBytes, 8192);
		assert.equal(parsed.servers.length, 1);
		const srv = parsed.servers[0]!;
		assert.equal(srv.name, "remote_docs");
		assert.equal(srv.requestTimeoutMs, 15_000);
		assert.deepEqual(srv.includeTools, ["search_docs"]);
		assert.equal(srv.transport.kind, "http");
		if (srv.transport.kind === "http") {
			assert.equal(srv.transport.headers?.Authorization, "Bearer sec-xyz");
		}

		// Missing env placeholder fails fast at startup.
		assert.throws(() => parseMcpConfigJson(rawJson, { env: {} }), /Missing environment variable "DOCS_API_TOKEN"/);

		// Cloudflare Workers (`parseJeheeEnvConfig` without `stdioFactory`) rejects `stdio` servers cleanly.
		assert.throws(
			() =>
				parseJeheeEnvConfig({
					JEHEE_MCP_SERVERS: JSON.stringify({
						mcpServers: { local_only: { command: "node", args: ["srv.js"] } },
					}),
				}),
			/only supported in local Node runtimes/,
		);
	});

	it("wires mcp.json end-to-end through assembleNodeRuntime and surfaces connected servers in /status", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "jehee-mcp-runtime-"));
		try {
			const fixtureScript = resolve(repoRoot, "packages/mcp/test/fixtures/stdio-server.mjs");
			const mcpConfigPath = join(tmpDir, "mcp.json");
			await writeFile(
				mcpConfigPath,
				JSON.stringify({
					mcpServers: {
						stdio_fixture: {
							description: "Local fixture server",
							command: process.execPath,
							args: [fixtureScript],
						},
						skipped_server: {
							enabled: false,
							url: "https://unused.example.com/mcp",
						},
					},
				}),
				"utf8",
			);

			const { host, gateway } = await assembleNodeRuntime(
				{
					env: {},
					sqlitePath: join(tmpDir, "jehee.sqlite"),
					mcpConfigPath,
				},
				BACKGROUND_CONTEXT,
			);

			const outbound: string[] = [];
			gateway.registerTransport({
				channel: "cli",
				sendText: async (_chatId, text) => {
					outbound.push(text);
				},
			});

			try {
				assert.deepEqual(host.mcpServerNames, ["stdio_fixture"]);
				const res = await gateway.ingest(
					{
						channel: "cli",
						chatId: "local-terminal",
						senderId: "local-owner",
						messageId: "m-status-1",
						text: "/status",
						timestampMs: Date.now(),
					},
					BACKGROUND_CONTEXT,
				);
				assert.equal(res.kind, "command_handled");
				assert.ok(outbound[0]?.includes("mcp: stdio_fixture"));
			} finally {
				gateway.dispose();
				await host.close(BACKGROUND_CONTEXT);
			}
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("skips unreachable HTTP MCP servers cleanly when bestEffortConnect is enabled", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([() => fauxAssistantMessage("手机离线不影响主对话。")]);

		const failingFetch: typeof fetch = async () => {
			throw new TypeError("fetch failed: phone offline");
		};
		const paleEnv = createMockPaleEnvironment({ pdfSizeBytes: 1_024, distractorServerCount: 0 });

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				mcp: {
					bestEffortConnect: true,
					servers: [
						{
							name: "phone",
							requestTimeoutMs: 1_000,
							transport: {
								kind: "http",
								url: "https://offline-phone.invalid/mcp",
								openGetStream: false,
								fetchImpl: failingFetch,
							},
						},
						paleEnv.mailSpec,
					],
				},
			},
			BACKGROUND_CONTEXT,
		);

		try {
			assert.deepEqual(host.mcpServerNames, ["mail"]);
			const turn = await host.sendMessage({ text: "你好" }, BACKGROUND_CONTEXT);
			assert.equal(turn.status, "done");
			if (turn.status === "done") {
				assert.equal(turn.replyText, "手机离线不影响主对话。");
			}
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}
	});

	it("records unreachable servers in McpConnectorHub.failedServers() with sanitized error messages", async () => {
		const secretBearer = "sk:live:miu_secret_987654";
		const secretApiKey = "sk-live-secret-112233";
		const customSchemeSecret = "custom-scheme-secret-4455";
		const urlQueryKey = "url-query-secret-6677";
		const paleEnv = createMockPaleEnvironment({ pdfSizeBytes: 1_024, distractorServerCount: 0 });

		const hub = await McpConnectorHub.connect(
			[
				{
					name: "phone",
					requestTimeoutMs: 1_000,
					transport: {
						kind: "http",
						url: `https://offline-phone.invalid/mcp?key=${urlQueryKey}`,
						headers: {
							Authorization: `Bearer ${secretBearer}`,
							"X-API-Key": secretApiKey,
							"X-Custom-Auth": `Token ${customSchemeSecret}`,
						},
						openGetStream: false,
						fetchImpl: async () => {
							throw new Error(
								`https://u:pw99@h.invalid/m?key=${urlQueryKey}&auth=qauth8&token=qtok9 {"token":"jtok1","api_key":"jkey2","authorization":"Bearer jauth3"} Bearer ${secretBearer} Bearer abcd:csec9 ${customSchemeSecret} X-API-Key:${secretApiKey}`,
							);
						},
					},
				},
				paleEnv.mailSpec,
			],
			{ bestEffort: true },
		);

		try {
			assert.deepEqual(
				hub.servers().map((s) => s.name),
				["mail"],
			);
			const failed = hub.failedServers();
			assert.equal(failed.length, 1);
			assert.equal(failed[0]!.name, "phone");
			const err = failed[0]!.error;
			assert.ok(err.length > 0);
			assert.equal(err.endsWith("…"), false, `error should not be truncated in redaction test: ${err}`);
			for (const leaked of [
				secretBearer,
				secretApiKey,
				customSchemeSecret,
				urlQueryKey,
				"pw99",
				"qauth8",
				"qtok9",
				"jtok1",
				"jkey2",
				"jauth3",
				"csec9",
			]) {
				assert.equal(err.includes(leaked), false, `expected secret "${leaked}" to be redacted in: ${err}`);
			}
			assert.ok(err.includes("[redacted]"));
		} finally {
			await hub.close();
		}
	});

	it("enforces bounded LRU eviction and base64url/invalid-base64 safety in McpBlobVault", () => {
		const vault = new McpBlobVault({ maxEntries: 2, maxTotalBytes: 24 });
		const b1 = Buffer.from("aaaaaaaaaa", "utf8").toString("base64"); // 10 bytes
		const b2 = Buffer.from("bbbbbbbbbb", "utf8").toString("base64"); // 10 bytes
		const b3 = Buffer.from("cccccccccc", "utf8").toString("base64"); // 10 bytes

		const e1 = vault.storeBase64(b1, "image/png");
		const e2 = vault.storeBase64(b2, "image/png");
		assert.equal(vault.size, 2);
		assert.equal(vault.totalBytes, 20);

		// Touch e1 so e2 becomes LRU, then insert e3 -> e2 is evicted to stay within both maxEntries and maxTotalBytes.
		assert.ok(vault.getBlob(e1.handle));
		const e3 = vault.storeBase64(b3, "image/png");
		assert.equal(vault.size, 2);
		assert.equal(vault.totalBytes, 20);
		assert.ok(vault.get(e1.handle));
		assert.equal(vault.get(e2.handle), undefined);
		assert.ok(vault.get(e3.handle));

		// Base64URL (with -/_ and omitted padding) normalizes cleanly and decodes via getBlob.
		const rawUrlBytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x3e, 0x7f]);
		const base64Url = Buffer.from(rawUrlBytes).toString("base64url");
		const urlEntry = vault.tryStoreBase64(base64Url, "image/webp");
		assert.ok(urlEntry);
		const decodedUrl = vault.getBlob(urlEntry.handle);
		assert.ok(decodedUrl);
		assert.deepEqual(decodedUrl.bytes, rawUrlBytes);
		assert.equal(decodedUrl.mimeType, "image/webp");

		// Malformed base64 and payloads exceeding vault maxTotalBytes return undefined from tryStoreBase64 without crashing.
		assert.equal(vault.tryStoreBase64("%%%invalid-base64%%%", "image/png"), undefined);
		assert.equal(vault.tryStoreBase64(Buffer.alloc(32, 0x7a).toString("base64"), "image/png"), undefined);
	});

	it("exposes extensionHandles on McpBundle for clean registry swap and saves MCP ImageContent into blobVault for send_media", async () => {
		const screenshotBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x10, 0x20, 0x30, 0x40]);
		const screenshotBase64 = Buffer.from(screenshotBytes).toString("base64");

		const createScreenshotServerTransport = (): McpTransport => {
			const pair = createInMemoryTransportPair();
			let initialized = false;
			let ready = false;
			pair.server.onMessage((msg) => {
				if (isJsonRpcNotification(msg)) {
					if (msg.method === "notifications/initialized" && initialized) ready = true;
					return;
				}
				if (!isJsonRpcRequest(msg)) return;
				const reply = (result: unknown) => {
					void pair.server.send({ jsonrpc: "2.0", id: msg.id, result });
				};
				if (msg.method === "initialize") {
					initialized = true;
					reply({
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: { listChanged: false } },
						serverInfo: { name: "miu-bridge-mock", version: "0.1.0" },
					});
					return;
				}
				if (!ready) {
					void pair.server.send({
						jsonrpc: "2.0",
						id: msg.id,
						error: { code: -32002, message: "not ready" },
					});
					return;
				}
				if (msg.method === "tools/list") {
					reply({
						tools: [
							{
								name: "phone_screenshot",
								description: "Capture the current Android phone screen as a PNG image.",
								annotations: { readOnlyHint: true },
								inputSchema: { type: "object", properties: {}, additionalProperties: false },
							},
							{
								name: "bad_screenshot",
								description: "Returns malformed base64 image data.",
								annotations: { readOnlyHint: true },
								inputSchema: { type: "object", properties: {}, additionalProperties: false },
							},
						],
					});
					return;
				}
				if (msg.method === "tools/call") {
					const params =
						typeof msg.params === "object" && msg.params !== null ? (msg.params as Record<string, unknown>) : {};
					if (params.name === "bad_screenshot") {
						reply({
							content: [{ type: "image", data: "!!!malformed-base64!!!", mimeType: "image/png" }],
						});
						return;
					}
					reply({
						content: [
							{ type: "image", data: screenshotBase64, mimeType: "image/png" },
							{ type: "text", text: "Captured 1080x2400 PNG screenshot." },
						],
					});
					return;
				}
				void pair.server.send({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: `Unknown method: ${msg.method}` },
				});
			});
			void pair.server.start();
			return pair.client;
		};

		const hub = await McpConnectorHub.connect([
			{
				name: "phone",
				description: "Miu Bridge Android phone control",
				transport: { kind: "custom", create: createScreenshotServerTransport },
			},
		]);

		try {
			const deferredBundle = createMcpBundle(hub, { exposure: "deferred" });
			assert.equal(deferredBundle.extensionHandles.length, 2);
			const registry = createRegistry();
			for (const ext of deferredBundle.extensions) {
				registry.install(ext);
			}
			assert.equal(registry.snapshot().installed().length, 2);
			for (const handle of deferredBundle.extensionHandles) {
				registry.uninstall(handle);
			}
			assert.equal(registry.snapshot().installed().length, 0);

			const eagerBundle = createMcpBundle(hub, { exposure: "eager" });
			assert.equal(eagerBundle.extensionHandles.length, 1);

			const deliveredMedia: OutboundMediaPayload[] = [];
			const mediaExtension = createOutboundMediaExtension({
				resolveBlob: (handle) => eagerBundle.blobVault.getBlob(handle),
				deliverMedia: async (payload) => {
					deliveredMedia.push(payload);
					return { ok: true, route: "telegram:owner-1" };
				},
			});

			let extractedBlobHandle = "";
			let sawImageBlock = false;
			let badImageHadHandleNote = true;
			const faux = fauxProvider();
			faux.setResponses([
				() =>
					fauxAssistantMessage(
						[fauxToolCall("mcp__phone__phone_screenshot", {}), fauxToolCall("mcp__phone__bad_screenshot", {})],
						{ stopReason: "toolUse" },
					),
				(ctx) => {
					const toolResults = ctx.messages.filter((m) => m.role === "toolResult");
					assert.equal(toolResults.length, 2);
					const goodResult = toolResults[0]!;
					sawImageBlock = goodResult.content.some((b) => b.type === "image" && b.mimeType === "image/png");
					const joinedText = goodResult.content
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join("\n");
					const match =
						/\[Saved image handle: (\$jehee_blob:[0-9a-f]+) — pass to send_media to deliver to user\]/.exec(
							joinedText,
						);
					assert.ok(match?.[1], `expected saved image handle note in: ${joinedText}`);
					extractedBlobHandle = match[1];

					const badResult = toolResults[1]!;
					assert.equal(badResult.isError, false);
					assert.equal(
						badResult.content.some((b) => b.type === "image" && b.mimeType === "image/png"),
						true,
					);
					const badText = badResult.content
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join("\n");
					badImageHadHandleNote = badText.includes(JEHEE_BLOB_HANDLE_PREFIX);

					return fauxAssistantMessage(
						[
							fauxToolCall(SEND_MEDIA_TOOL, {
								kind: "photo",
								blobHandle: extractedBlobHandle,
								caption: "Phone screen",
							}),
						],
						{ stopReason: "toolUse" },
					);
				},
				() => fauxAssistantMessage("Screenshot sent to Telegram."),
			]);

			const models = createModels();
			models.setProvider(faux.provider);

			const host = await JeheeHost.open(
				{
					storage: { kind: "memory" },
					models,
					defaultModel: { provider: "faux", modelId: faux.getModel().id },
					extensions: [...eagerBundle.extensions, mediaExtension],
				},
				BACKGROUND_CONTEXT,
			);

			try {
				const reply = await host.sendMessage(
					{ text: "Take a phone screenshot and send it to me" },
					BACKGROUND_CONTEXT,
				);
				assert.equal(reply.status, "done");
			} finally {
				await host.close(BACKGROUND_CONTEXT);
			}

			assert.equal(sawImageBlock, true);
			assert.equal(badImageHadHandleNote, false);
			assert.ok(extractedBlobHandle.startsWith(JEHEE_BLOB_HANDLE_PREFIX));
			assert.equal(deliveredMedia.length, 1);
			assert.equal(deliveredMedia[0]!.kind, "photo");
			assert.equal(deliveredMedia[0]!.mimeType, "image/png");
			assert.equal(deliveredMedia[0]!.caption, "Phone screen");
			assert.deepEqual(deliveredMedia[0]!.bytes, screenshotBytes);
		} finally {
			await hub.close();
		}
	});
});
