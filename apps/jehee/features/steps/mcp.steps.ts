// Cucumber step definitions verifying MCP deferred discovery, trace span hierarchy, PALE stale_version self-healing,
// $jehee_blob lossless PDF/ICS cross-app transfer, and deterministic write-gate interception.

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Given, Then, When } from "@cucumber/cucumber";
import type { FauxResponseStep, SystemMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { JeheeHost } from "../../src/core/host.ts";
import { JEHEE_BLOB_HANDLE_PREFIX } from "../../src/mcp/blob-vault.ts";
import type { JeheeMcpExposure, McpWriteGateDecision } from "../../src/mcp/contract.ts";
import { assembleNodeRuntime } from "../../src/runtime/node.ts";
import { computeTraceMetrics, JeheeTraceRecorder } from "../../src/telemetry/recorder.ts";
import { createMockPaleEnvironment, type MockPaleEnvironment } from "../../test/fixtures/pale-mcp-fixture.ts";
import type { JeheeWorld } from "../support/world.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
let runtimeMcpConfigPath = "";
let statusReplies: string[] = [];

let paleEnv: MockPaleEnvironment;
let traceRecorder: JeheeTraceRecorder;
let writeGateEnabled = false;

function extractToolsAddedInTurn(ctx: TranscriptContext): string[] {
	const names: string[] = [];
	for (const msg of ctx.messages) {
		if (msg.role === "system") {
			const sys = msg as SystemMessage;
			for (const tool of sys.toolsAdded ?? []) {
				names.push(tool.name);
			}
		}
	}
	return names;
}

function latestToolResultTexts(ctx: TranscriptContext): string[] {
	const out: string[] = [];
	for (const msg of ctx.messages) {
		if (msg.role !== "toolResult") continue;
		for (const block of msg.content) {
			if (block.type === "text") out.push(block.text);
		}
	}
	return out;
}

Given("已启动模拟 PALE 多应用 MCP 环境（含 mail、calendar 与 4 个干扰域服务，共 55 个工具）", () => {
	paleEnv = createMockPaleEnvironment({ distractorServerCount: 4, toolsPerDistractor: 12 });
	writeGateEnabled = false;
});

Given(
	"Jehee 以 {string} 模式挂载全部 MCP 服务并开启 Trace 录制器",
	async function (this: JeheeWorld, exposure: string) {
		traceRecorder = new JeheeTraceRecorder();
		const stepRouter: FauxResponseStep = (reqCtx) => {
			this.capturedContexts.push(reqCtx);
			const toolResults = latestToolResultTexts(reqCtx);
			if (toolResults.length === 0) {
				return fauxAssistantMessage([fauxToolCall("tool_search", { query: "mail search inbox" })], {
					stopReason: "toolUse",
				});
			}
			if (toolResults.length === 1) {
				return fauxAssistantMessage(
					[fauxToolCall("mcp__mail__mail_search", { query: "flight", folder: "inbox" })],
					{
						stopReason: "toolUse",
					},
				);
			}
			return fauxAssistantMessage("查到了：有一封主题为 Updated Flight Confirmation & Receipt 的改签航班邮件。");
		};
		this.faux.setResponses([stepRouter, stepRouter, stepRouter]);

		this.host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				telemetry: traceRecorder.telemetry,
				mcp: {
					servers: [paleEnv.mailSpec, paleEnv.calendarSpec, ...paleEnv.distractorSpecs],
					exposure: exposure as JeheeMcpExposure,
				},
			},
			this.ctx,
		);
	},
);

When("用户发送任务 {string}", async function (this: JeheeWorld, text: string) {
	assert.ok(this.host);
	this.lastReply = await this.host.sendMessage({ text }, this.ctx);
	await this.host.waitForIdle(this.ctx);
});

Then(
	"首轮发往模型的系统提示词包含 {string} 摘要目录，且首轮可见工具仅包含 {string}",
	function (this: JeheeWorld, expectedSectionKey: string, expectedOnlyTool: string) {
		const firstTurn = this.capturedContexts[0];
		assert.ok(firstTurn, "First turn context must be captured");
		const sysMessages = firstTurn.messages.filter((m): m is SystemMessage => m.role === "system");
		const sectionDump = sysMessages.flatMap((s) => Object.keys(s.sections ?? {})).join(",");
		assert.ok(sectionDump.includes(expectedSectionKey), `Expected section ${expectedSectionKey} in ${sectionDump}`);
		const firstTurnTools = extractToolsAddedInTurn(firstTurn);
		assert.deepEqual(firstTurnTools, [expectedOnlyTool]);
	},
);

Then(
	"模型先调用 {string} 按需加载邮件工具，再调用 {string} 查得航班邮件并完成回复",
	function (this: JeheeWorld, searchTool: string, mcpTool: string) {
		assert.equal(this.lastReply?.status, "done");
		if (this.lastReply?.status === "done") {
			assert.ok(this.lastReply.replyText.includes("Updated Flight Confirmation"));
		}
		const secondTurn = this.capturedContexts[1];
		assert.ok(secondTurn);
		const allToolsAfterSearch = extractToolsAddedInTurn(secondTurn);
		assert.ok(allToolsAfterSearch.includes(searchTool));
		assert.ok(allToolsAfterSearch.includes(mcpTool));
	},
);

Then(
	"Trace 录制器记录了完整的父子决策树（包含 {string}、{string}、{string} 与 {string}）",
	async (rootSpan: string, aiSpan: string, searchTool: string, mcpSpan: string) => {
		const rendered = await traceRecorder.renderLatestTrace();
		assert.ok(rendered.includes(rootSpan), `Missing ${rootSpan} in:\n${rendered}`);
		assert.ok(rendered.includes(aiSpan), `Missing ${aiSpan} in:\n${rendered}`);
		assert.ok(rendered.includes(`tool.name="${searchTool}"`), `Missing ${searchTool} in:\n${rendered}`);
		assert.ok(rendered.includes(mcpSpan), `Missing ${mcpSpan} in:\n${rendered}`);
	},
);

Given("已启动模拟 PALE 多应用 MCP 环境且日历初始版本号 revision 为 {int}", (initialRev: number) => {
	paleEnv = createMockPaleEnvironment({ calendarInitialRevision: initialRev, distractorServerCount: 0 });
	writeGateEnabled = false;
});

Given("Jehee 挂载日历 MCP 服务并开启 Trace 录制器", async function (this: JeheeWorld) {
	traceRecorder = new JeheeTraceRecorder();
	const stepRouter: FauxResponseStep = (reqCtx) => {
		this.capturedContexts.push(reqCtx);
		const results = latestToolResultTexts(reqCtx);
		if (results.length === 0) {
			return fauxAssistantMessage([fauxToolCall("tool_search", { query: "calendar import ics" })], {
				stopReason: "toolUse",
			});
		}
		if (results.length === 1) {
			return fauxAssistantMessage(
				[
					fauxToolCall("mcp__calendar__calendar_import_ics", {
						text: paleEnv.icsText,
						expected_version: { epoch: 1, revision: 0 },
						request_id: "import-attempt-1",
					}),
				],
				{ stopReason: "toolUse" },
			);
		}
		if (results.length === 2) {
			const errorPayload = JSON.parse(results[1]!) as {
				status: string;
				current_version: { epoch: number; revision: number };
			};
			return fauxAssistantMessage(
				[
					fauxToolCall("mcp__calendar__calendar_import_ics", {
						text: paleEnv.icsText,
						expected_version: errorPayload.current_version,
						request_id: "import-attempt-2",
					}),
				],
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("已根据最新版本号重试并成功导入日历。");
	};
	this.faux.setResponses([stepRouter, stepRouter, stepRouter, stepRouter]);

	this.host = await JeheeHost.open(
		{
			storage: { kind: "memory" },
			models: this.models,
			defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
			telemetry: traceRecorder.telemetry,
			mcp: { servers: [paleEnv.calendarSpec] },
		},
		this.ctx,
	);
});

When("用户发送任务 {string}，且模型首次误传旧版本号 revision 0", async function (this: JeheeWorld, text: string) {
	assert.ok(this.host);
	this.lastReply = await this.host.sendMessage({ text }, this.ctx);
	await this.host.waitForIdle(this.ctx);
});

Then(
	"模型收到了包含 {string} 与最新 revision {int} 的结构化错误详情",
	function (this: JeheeWorld, expectedCode: string, expectedRev: number) {
		const thirdTurn = this.capturedContexts[2];
		assert.ok(thirdTurn);
		const results = latestToolResultTexts(thirdTurn);
		const conflictText = results[1] ?? "";
		assert.ok(conflictText.includes(expectedCode), `Expected ${expectedCode} in ${conflictText}`);
		assert.ok(
			conflictText.includes(`"revision":${expectedRev}`),
			`Expected revision ${expectedRev} in ${conflictText}`,
		);
	},
);

Then(
	"模型在下一轮读取最新版本号重新提交 {string} 并成功落库（日历事件数为 {int}）",
	(_toolName: string, expectedCount: number) => {
		const snap = paleEnv.snapshot();
		assert.equal(snap.calendarEvents.length, expectedCount);
	},
);

Given("已启动模拟 PALE 多应用 MCP 环境（邮件内含 16 KiB PDF 收据与 ICS 日历附件）", () => {
	paleEnv = createMockPaleEnvironment({ pdfSizeBytes: 16_384, distractorServerCount: 0 });
	writeGateEnabled = false;
});

Given(
	"Jehee 挂载邮件与日历 MCP 服务（Blob 卸载阈值 {int} 字节）并开启 Trace 录制器",
	async function (this: JeheeWorld, thresholdBytes: number) {
		traceRecorder = new JeheeTraceRecorder();
		const stepRouter: FauxResponseStep = (reqCtx) => {
			this.capturedContexts.push(reqCtx);
			const results = latestToolResultTexts(reqCtx);
			if (results.length === 0) {
				return fauxAssistantMessage(
					[fauxToolCall("tool_search", { query: "mail attachment calendar import_ics attachment add" })],
					{ stopReason: "toolUse" },
				);
			}
			if (results.length === 1) {
				return fauxAssistantMessage(
					[
						fauxToolCall("mcp__mail__mail_attachment_get", { id: "msg-flight-1", asset_id: "att-ics" }),
						fauxToolCall("mcp__mail__mail_attachment_get", { id: "msg-flight-1", asset_id: "att-pdf" }),
						fauxToolCall("mcp__calendar__calendar_list", {}),
					],
					{ stopReason: "toolUse" },
				);
			}
			if (results.length === 4) {
				const icsRes = JSON.parse(results[1]!) as { file: { decoded_text: string } };
				const calList = JSON.parse(results[3]!) as { version: { epoch: number; revision: number } };
				return fauxAssistantMessage(
					[
						fauxToolCall("mcp__calendar__calendar_import_ics", {
							text: icsRes.file.decoded_text,
							expected_version: calList.version,
							request_id: "imp-flight-ics",
						}),
					],
					{ stopReason: "toolUse" },
				);
			}
			if (results.length === 5) {
				const pdfRes = JSON.parse(results[2]!) as {
					file: { filename: string; mime_type: string; base64: string; sha256: string };
				};
				const impRes = JSON.parse(results[4]!) as { id: string; version: { epoch: number; revision: number } };
				return fauxAssistantMessage(
					[
						fauxToolCall("mcp__calendar__calendar_attachment_add", {
							id: impRes.id,
							files: [
								{
									filename: pdfRes.file.filename,
									mime_type: pdfRes.file.mime_type,
									base64: pdfRes.file.base64,
									sha256: pdfRes.file.sha256,
								},
							],
							expected_version: impRes.version,
							request_id: "att-flight-pdf",
						}),
					],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("已完成航班日程导入并无损挂载 PDF 付款收据。");
		};
		this.faux.setResponses(Array.from({ length: 6 }, () => stepRouter));

		this.host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				telemetry: traceRecorder.telemetry,
				mcp: {
					servers: [paleEnv.mailSpec, paleEnv.calendarSpec],
					blobOffloadThresholdBytes: thresholdBytes,
				},
			},
			this.ctx,
		);
	},
);

Then(
	"模型读取邮件附件时收到解码后的 ICS 文本与 {string} 句柄（全程上下文未出现原始长 Base64 字符串）",
	function (this: JeheeWorld, handlePrefix: string) {
		const allToolTexts = this.capturedContexts.flatMap((c) => latestToolResultTexts(c)).join("\n");
		assert.ok(allToolTexts.includes("BEGIN:VCALENDAR"), "Expected decoded ICS text in model context");
		assert.ok(allToolTexts.includes(handlePrefix), `Expected ${handlePrefix} handle in model context`);
		// Raw 16 KiB PDF in base64 is ~21,848 chars; ensure no single toolResult block dumped 20k+ raw base64 chars.
		for (const ctx of this.capturedContexts) {
			for (const txt of latestToolResultTexts(ctx)) {
				assert.ok(txt.length < 4_000, `Unexpectedly large toolResult in context (${txt.length} chars)`);
			}
		}
		assert.ok(handlePrefix.startsWith(JEHEE_BLOB_HANDLE_PREFIX.slice(0, 8)));
	},
);

Then(
	"日历服务最终保存了 {int} 条日程与 {int} 份附件，且接收端校验的 PDF SHA-256 与原始邮件附件 100% 一致",
	(expectedEvents: number, expectedAttachments: number) => {
		const snap = paleEnv.snapshot();
		assert.equal(snap.calendarEvents.length, expectedEvents);
		const evt = snap.calendarEvents[0]!;
		assert.equal(evt.attachments.length, expectedAttachments);
		assert.equal(evt.attachments[0]?.sha256, paleEnv.expectedPdfSha256);
	},
);

Given("已启动模拟 PALE 多应用 MCP 环境并配置写操作需用户确认门控", () => {
	paleEnv = createMockPaleEnvironment({ distractorServerCount: 0 });
	writeGateEnabled = true;
});

Given("Jehee 挂载邮件 MCP 服务并开启 Trace 录制器", async function (this: JeheeWorld) {
	traceRecorder = new JeheeTraceRecorder();
	const stepRouter: FauxResponseStep = (reqCtx) => {
		this.capturedContexts.push(reqCtx);
		const results = latestToolResultTexts(reqCtx);
		if (results.length === 0) {
			return fauxAssistantMessage([fauxToolCall("tool_search", { query: "mail search send" })], {
				stopReason: "toolUse",
			});
		}
		if (results.length === 1) {
			return fauxAssistantMessage([fauxToolCall("mcp__mail__mail_search", { folder: "drafts" })], {
				stopReason: "toolUse",
			});
		}
		if (results.length === 2) {
			return fauxAssistantMessage(
				[
					fauxToolCall("mcp__mail__mail_send", {
						id: "msg-draft-1",
						expected_version: { epoch: 1, revision: 0 },
						request_id: "send-without-confirm",
					}),
				],
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("已在草稿箱找到接机邮件；外发操作需要你的明确确认后我再发送。");
	};
	this.faux.setResponses(Array.from({ length: 5 }, () => stepRouter));

	this.host = await JeheeHost.open(
		{
			storage: { kind: "memory" },
			models: this.models,
			defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
			telemetry: traceRecorder.telemetry,
			mcp: {
				servers: [paleEnv.mailSpec],
				beforeWriteToolCall: ({ tool }): McpWriteGateDecision => {
					if (writeGateEnabled) {
						return { action: "block", reason: `Irreversible action "${tool}" requires explicit owner approval.` };
					}
					return { action: "allow" };
				},
			},
		},
		this.ctx,
	);
});

When("用户发送任务 {string}（尚未授予发送确认）", async function (this: JeheeWorld, text: string) {
	assert.ok(this.host);
	this.lastReply = await this.host.sendMessage({ text }, this.ctx);
	await this.host.waitForIdle(this.ctx);
});

Then("只读工具 {string} 正常放行返回草稿列表", function (this: JeheeWorld, _readTool: string) {
	const thirdTurn = this.capturedContexts[2];
	assert.ok(thirdTurn);
	const results = latestToolResultTexts(thirdTurn);
	assert.ok(results[1]?.includes("msg-draft-1"), `Expected draft in ${JSON.stringify(results)}`);
});

Then(
	"写工具 {string} 被确定性门控拦截并返回 {string}，邮件实际外发数为 {int}",
	function (this: JeheeWorld, _writeTool: string, expectedStatus: string, expectedSentCount: number) {
		const fourthTurn = this.capturedContexts[3];
		assert.ok(fourthTurn);
		const results = latestToolResultTexts(fourthTurn);
		assert.ok(results[2]?.includes(expectedStatus), `Expected ${expectedStatus} in ${JSON.stringify(results)}`);
		assert.equal(paleEnv.snapshot().mailSentIds.length, expectedSentCount);
	},
);

Then("当前 Trace 指标记录的 {string} 次数为 {int}", async (_metricField: string, expectedCount: number) => {
	const latest = await traceRecorder.latestTrace();
	assert.ok(latest);
	const metrics = computeTraceMetrics(latest.spans);
	assert.equal(metrics.boundaryViolations, expectedCount);
});

Given(
	"已在临时目录写入包含真实本地 stdio 服务 {string} 与禁用项 {string} 的 mcp.json",
	async function (this: JeheeWorld, activeServer: string, disabledServer: string) {
		this.tempDir = await mkdtemp(join(tmpdir(), "jehee-bdd-mcp-"));
		runtimeMcpConfigPath = join(this.tempDir, "mcp.json");
		statusReplies = [];
		const fixtureScript = resolve(repoRoot, "packages/mcp/test/fixtures/stdio-server.mjs");
		await writeFile(
			runtimeMcpConfigPath,
			JSON.stringify({
				mcpServers: {
					[activeServer]: {
						description: "Real local stdio MCP fixture",
						command: process.execPath,
						args: [fixtureScript],
					},
					[disabledServer]: {
						enabled: false,
						url: "https://disabled.example.com/mcp",
					},
				},
			}),
			"utf8",
		);
	},
);

When(
	"通过 assembleNodeRuntime 启动本地宿主与渠道网关并发送 {string}",
	async function (this: JeheeWorld, cmdText: string) {
		const sqlitePath = join(dirname(runtimeMcpConfigPath), "runtime.sqlite");
		const assembled = await assembleNodeRuntime(
			{
				env: {},
				sqlitePath,
				mcpConfigPath: runtimeMcpConfigPath,
			},
			this.ctx,
		);
		this.host = assembled.host;
		this.gateway = assembled.gateway;
		this.gateway.registerTransport({
			channel: "cli",
			sendText: async (_chatId, text) => {
				statusReplies.push(text);
			},
		});
		await this.gateway.ingest(
			{
				channel: "cli",
				chatId: "local-terminal",
				senderId: "local-owner",
				messageId: "m-bdd-status-1",
				text: cmdText,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
	},
);

Then(
	"渠道状态回执包含 {string} 且未挂载已禁用的 {string}",
	function (this: JeheeWorld, expectedLine: string, forbiddenServer: string) {
		const joined = statusReplies.join("\n");
		assert.ok(joined.includes(expectedLine), `Expected "${expectedLine}" in:\n${joined}`);
		assert.ok(!joined.includes(forbiddenServer), `Did not expect "${forbiddenServer}" in:\n${joined}`);
	},
);
