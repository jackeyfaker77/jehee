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
import type { StoredSpan } from "@earendil-works/pi-telemetry";
import {
	classifyFailureRootCause,
	computeTraceMetrics,
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
});
