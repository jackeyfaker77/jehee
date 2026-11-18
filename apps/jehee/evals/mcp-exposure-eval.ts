// Comparative Eval & Failure Postmortem suite for Jehee's MCP Connector Skeleton (`ADR-0007`).
// Compares:
//   Arm A: `eager` exposure + raw Base64 (baseline without `tool_search` or blob offloading)
//   Arm B: `eager` exposure + `$jehee_blob:` handles (isolates attachment handle impact)
//   Arm C: `deferred` exposure (`tool_search`) + `$jehee_blob:` handles (Jehee default)
//   Arm D (Diagnostic control): simulated `discovery_miss` failure to verify automatic 5-bucket postmortem export.
//
// Run offline (deterministic token/cache simulation, 0 API cost):
//   npm --prefix apps/jehee run eval:mcp
// Run against a live model configured in `apps/jehee/.env`:
//   JEHEE_EVAL_LIVE=1 npm --prefix apps/jehee run eval:mcp

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { JeheeHost } from "../src/core/host.ts";
import type { JeheeMcpExposure } from "../src/mcp/contract.ts";
import { parseJeheeEnvConfig } from "../src/runtime/config.ts";
import { createJeheeModels } from "../src/runtime/models.ts";
import { loadDotEnvFile } from "../src/runtime/node.ts";
import {
	buildPostmortemReport,
	computeTraceMetrics,
	type JeheePostmortemReport,
	type JeheeTraceMetrics,
	JeheeTraceRecorder,
} from "../src/telemetry/recorder.ts";
import { createMockPaleEnvironment, type MockPaleEnvironment } from "../test/fixtures/pale-mcp-fixture.ts";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type EvalArmConfig = {
	readonly id: string;
	readonly label: string;
	readonly exposure: JeheeMcpExposure;
	readonly blobOffloadThresholdBytes: number;
	readonly injectDiscoveryMiss?: boolean;
};

type EvalTrialResult = {
	readonly arm: EvalArmConfig;
	readonly modelLabel: string;
	readonly passed: boolean;
	readonly rubricScorePct: number;
	readonly turnStatus: string;
	readonly replyPreview: string;
	readonly metrics: JeheeTraceMetrics;
	readonly referenceCostUsd: number;
	readonly renderedTree: string;
	readonly postmortem?: JeheePostmortemReport;
};

// Reference pricing ($/1M tokens: $1.00 uncached/write, $0.10 cache_read, $4.00 output) used when offline faux provider reports $0.
function computeReferenceUsd(m: JeheeTraceMetrics): number {
	if (m.costUsd > 0) return m.costUsd;
	const uncachedAndWrite = m.inputTokens + m.cacheWriteTokens;
	return (uncachedAndWrite * 1.0 + m.cacheReadTokens * 0.1 + m.outputTokens * 4.0) / 1_000_000;
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

function createScriptedWorkflowRouter(paleEnv: MockPaleEnvironment, arm: EvalArmConfig): FauxResponseStep {
	return (reqCtx) => {
		const results = latestToolResultTexts(reqCtx);

		if (arm.injectDiscoveryMiss === true) {
			if (results.length === 0) {
				return fauxAssistantMessage([fauxToolCall("tool_search", { query: "unrelated_grocery_coupon" })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("未能找到对应的航班日历工具。");
		}

		// Step 0: in `deferred` mode, discover mail & calendar tools first; in `eager` mode, call directly.
		if (arm.exposure === "deferred" && results.length === 0) {
			return fauxAssistantMessage(
				[fauxToolCall("tool_search", { query: "mail search attachment calendar import_ics attachment add" })],
				{ stopReason: "toolUse" },
			);
		}

		const offset = arm.exposure === "deferred" ? 1 : 0;

		if (results.length === offset) {
			return fauxAssistantMessage([fauxToolCall("mcp__mail__mail_search", { query: "flight", folder: "inbox" })], {
				stopReason: "toolUse",
			});
		}

		if (results.length === offset + 1) {
			return fauxAssistantMessage(
				[
					fauxToolCall("mcp__mail__mail_attachment_get", { id: "msg-flight-1", asset_id: "att-ics" }),
					fauxToolCall("mcp__mail__mail_attachment_get", { id: "msg-flight-1", asset_id: "att-pdf" }),
				],
				{ stopReason: "toolUse" },
			);
		}

		// Deliberately exercise PALE optimistic-lock conflict recovery (initial calendar revision is 1, try 0 first).
		if (results.length === offset + 3) {
			const icsPayload = JSON.parse(results[offset + 1]!) as {
				file: { base64: string; decoded_text?: string };
			};
			const icsContent =
				icsPayload.file.decoded_text ?? Buffer.from(icsPayload.file.base64, "base64").toString("utf8");
			return fauxAssistantMessage(
				[
					fauxToolCall("mcp__calendar__calendar_import_ics", {
						text: icsContent,
						expected_version: { epoch: 1, revision: 0 },
						request_id: "eval-import-1",
					}),
				],
				{ stopReason: "toolUse" },
			);
		}

		if (results.length === offset + 4) {
			const icsPayload = JSON.parse(results[offset + 1]!) as {
				file: { base64: string; decoded_text?: string };
			};
			const icsContent =
				icsPayload.file.decoded_text ?? Buffer.from(icsPayload.file.base64, "base64").toString("utf8");
			const conflict = JSON.parse(results[offset + 3]!) as {
				current_version: { epoch: number; revision: number };
			};
			return fauxAssistantMessage(
				[
					fauxToolCall("mcp__calendar__calendar_import_ics", {
						text: icsContent,
						expected_version: conflict.current_version,
						request_id: "eval-import-2",
					}),
				],
				{ stopReason: "toolUse" },
			);
		}

		if (results.length === offset + 5) {
			const rawPdfResult = results[offset + 2]!;
			const imported = JSON.parse(results[offset + 4]!) as {
				id: string;
				version: { epoch: number; revision: number };
			};
			if (rawPdfResult.startsWith("Warning: truncated output")) {
				// Without `$jehee_blob:` offloading, the 24 KiB PDF Base64 (~32.8 KiB) hit the 20 KiB output cap and lost its middle bytes.
				return fauxAssistantMessage(
					[
						fauxToolCall("mcp__calendar__calendar_attachment_add", {
							id: imported.id,
							files: [
								{
									filename: "receipt.pdf",
									mime_type: "application/pdf",
									base64: "dHJ1bmNhdGVk",
									sha256: paleEnv.expectedPdfSha256,
								},
							],
							expected_version: imported.version,
							request_id: "eval-attach-pdf-corrupt",
						}),
					],
					{ stopReason: "toolUse" },
				);
			}
			const pdfPayload = JSON.parse(rawPdfResult) as {
				file: { filename: string; mime_type: string; base64: string; sha256: string };
			};
			return fauxAssistantMessage(
				[
					fauxToolCall("mcp__calendar__calendar_attachment_add", {
						id: imported.id,
						files: [
							{
								filename: pdfPayload.file.filename,
								mime_type: pdfPayload.file.mime_type,
								base64: pdfPayload.file.base64,
								sha256: pdfPayload.file.sha256,
							},
						],
						expected_version: imported.version,
						request_id: "eval-attach-pdf",
					}),
				],
				{ stopReason: "toolUse" },
			);
		}

		return fauxAssistantMessage("已查收改签航班邮件，完成日历日程导入并挂载原始 PDF 收据。");
	};
}

function scoreEnvironmentOutcome(paleEnv: MockPaleEnvironment): {
	readonly passed: boolean;
	readonly rubricScorePct: number;
	readonly stateDiff: string;
} {
	const snap = paleEnv.snapshot();
	let points = 0;
	const notes: string[] = [];

	const event = snap.calendarEvents[0];
	if (event !== undefined && event.uid === "flight-rebook-778@pale.example") {
		points += 50;
	} else {
		notes.push(`missing_or_wrong_calendar_event: count=${snap.calendarEvents.length}`);
	}

	const attachedPdf = event?.attachments.find((f) => f.filename === "receipt.pdf");
	if (attachedPdf !== undefined && attachedPdf.sha256 === paleEnv.expectedPdfSha256) {
		points += 50;
	} else {
		notes.push(`missing_or_corrupt_pdf_attachment: attachments=${event?.attachments.length ?? 0}`);
	}

	return {
		passed: points === 100,
		rubricScorePct: points,
		stateDiff: notes.length === 0 ? "all_assertions_matched" : notes.join("; "),
	};
}

async function runSingleArm(arm: EvalArmConfig, liveEnvDict: Record<string, string | undefined> | undefined): Promise<EvalTrialResult> {
	// 6 servers total: mail (4) + calendar (3) + 5 distractor apps * 12 tools = 67 MCP tools; 24 KiB PDF receipt.
	const paleEnv = createMockPaleEnvironment({
		pdfSizeBytes: 24_576,
		distractorServerCount: 5,
		toolsPerDistractor: 12,
		calendarInitialRevision: 1,
	});
	const recorder = new JeheeTraceRecorder();

	const useLive = liveEnvDict !== undefined && arm.injectDiscoveryMiss !== true;
	const faux = fauxProvider();
	const models = useLive ? createJeheeModels(liveEnvDict) : createModels();
	if (!useLive) {
		models.setProvider(faux.provider);
		const router = createScriptedWorkflowRouter(paleEnv, arm);
		faux.setResponses(Array.from({ length: 12 }, () => router));
	}
	const defaultModel = useLive
		? parseJeheeEnvConfig(liveEnvDict).defaultModel
		: { provider: "faux", modelId: faux.getModel().id };

	const host = await JeheeHost.open(
		{
			storage: { kind: "memory" },
			models,
			defaultModel,
			telemetry: recorder.telemetry,
			mcp: {
				servers: [paleEnv.mailSpec, paleEnv.calendarSpec, ...paleEnv.distractorSpecs],
				exposure: arm.exposure,
				blobOffloadThresholdBytes: arm.blobOffloadThresholdBytes,
			},
		},
		BACKGROUND_CONTEXT,
	);

	const taskPrompt =
		"Check my inbox for the updated flight confirmation email, import its attached ICS invite into my calendar (if calendar version conflicts, retry with current_version), and attach the exact PDF receipt from that email onto the newly created calendar event.";

	let turnStatus = "unknown";
	let replyPreview = "";
	try {
		const turnReply = await host.sendMessage({ text: taskPrompt }, BACKGROUND_CONTEXT);
		turnStatus = turnReply.status === "done" ? "done" : `unanswered:${turnReply.reason}`;
		replyPreview = turnReply.status === "done" ? turnReply.replyText.slice(0, 200) : turnReply.reason;
		await host.waitForIdle(BACKGROUND_CONTEXT);
	} finally {
		await host.close(BACKGROUND_CONTEXT);
	}

	const trace = (await recorder.latestTrace())!;
	const renderedTree = await recorder.renderLatestTrace();
	const metrics = computeTraceMetrics(trace.spans);
	const grade = scoreEnvironmentOutcome(paleEnv);
	const readAnyAttachment = trace.spans.some(
		(s) =>
			(s.name === "jehee.mcp.call" && s.attributes.tool === "mail.attachment.get") ||
			s.name === "jehee.mcp.resource_read",
	);
	const payloadOverflowDetected = arm.blobOffloadThresholdBytes > 100_000 && readAnyAttachment && !grade.passed;

	const postmortem = grade.passed
		? undefined
		: buildPostmortemReport({
				caseId: arm.id,
				trace,
				summary: `Trial "${arm.label}" failed rubric (${grade.rubricScorePct}%, turn=${turnStatus}).`,
				expectedServers: ["mail", "calendar"],
				payloadOverflowDetected,
				stateDiff: `${grade.stateDiff} | turn=${turnStatus}`,
			});

	return {
		arm,
		modelLabel: `${defaultModel.provider}/${defaultModel.modelId}`,
		passed: grade.passed,
		rubricScorePct: grade.rubricScorePct,
		turnStatus,
		replyPreview,
		metrics,
		referenceCostUsd: computeReferenceUsd(metrics),
		renderedTree,
		...(postmortem !== undefined ? { postmortem } : {}),
	};
}

function pct(rate: number | undefined): string {
	return rate === undefined ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
	const isLive = process.env.JEHEE_EVAL_LIVE === "1";
	const dotEnv = isLive ? await loadDotEnvFile(join(appDir, ".env")) : undefined;
	const mergedEnv = isLive ? { ...dotEnv, ...process.env } : undefined;

	const arms: readonly EvalArmConfig[] = [
		{
			id: "arm-a-eager-raw",
			label: "A: eager (67 tools) + raw base64",
			exposure: "eager",
			blobOffloadThresholdBytes: 10_000_000,
		},
		{
			id: "arm-b-eager-blob",
			label: "B: eager (67 tools) + $jehee_blob",
			exposure: "eager",
			blobOffloadThresholdBytes: 4_096,
		},
		{
			id: "arm-c-deferred-blob",
			label: "C: deferred (tool_search) + $jehee_blob",
			exposure: "deferred",
			blobOffloadThresholdBytes: 4_096,
		},
		...(isLive
			? []
			: [
					{
						id: "arm-d-postmortem-demo",
						label: "D: diagnostic failure (discovery_miss)",
						exposure: "deferred" as const,
						blobOffloadThresholdBytes: 4_096,
						injectDiscoveryMiss: true,
					},
				]),
	];

	const results: EvalTrialResult[] = [];
	for (const arm of arms) {
		results.push(await runSingleArm(arm, mergedEnv));
	}

	const header = [
		"| Arm | Pass | Rubric | Turns | Tool Calls | Prefill Tokens | Cache Hit (All) | Cache Hit (Turn 2+) | Ref Cost (USD) | Wall (ms) |",
		"| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	const rows = results.map((r) => {
		const m = r.metrics;
		return `| ${r.arm.label} | ${r.passed ? "PASS" : "FAIL"} | ${r.rubricScorePct}% | ${m.llmTurns} | ${m.toolCalls} (search=${m.toolSearchCalls}) | ${m.prefillTokens} | ${pct(m.cacheHitRate)} | ${pct(m.postWarmupCacheHitRate)} | $${r.referenceCostUsd.toFixed(5)} | ${m.wallTimeMs.toFixed(1)} |`;
	});

	const modelBanner = results[0]?.modelLabel ?? "unknown";
	console.log(
		`\n=== Jehee MCP Exposure & Blob Handle Comparative Eval (${isLive ? `LIVE MODEL: ${modelBanner}` : "DETERMINISTIC HARNESS"}) ===\n`,
	);
	console.log([...header, ...rows].join("\n"));

	const outDir = join(appDir, ".artifacts", "evals");
	await mkdir(outDir, { recursive: true });
	await writeFile(
		join(outDir, isLive ? "latest-live-results.json" : "latest-offline-results.json"),
		`${JSON.stringify(results, null, 2)}\n`,
		"utf8",
	);

	const armA = results[0];
	const armC = results[2];
	if (armA !== undefined && armC !== undefined) {
		const savedPct = ((1 - armC.metrics.prefillTokens / armA.metrics.prefillTokens) * 100).toFixed(1);
		const costSavedPct = ((1 - armC.referenceCostUsd / armA.referenceCostUsd) * 100).toFixed(1);
		console.log(
			`\nKey takeaway: Arm C (deferred + $jehee_blob) reduced total prefill tokens by ${savedPct}% and reference cost by ${costSavedPct}% vs Arm A (${armA.metrics.prefillTokens} -> ${armC.metrics.prefillTokens} tokens).\n`,
		);
	}

	const failures = results.filter((r) => r.postmortem !== undefined).map((r) => r.postmortem!);
	if (failures.length > 0) {
		const outDir = join(appDir, ".artifacts", "evals");
		await mkdir(outDir, { recursive: true });
		const reportPath = join(outDir, "latest-postmortems.json");
		await writeFile(reportPath, `${JSON.stringify(failures, null, 2)}\n`, "utf8");
		console.log(`=== Failure Postmortem Sample (saved to ${reportPath}) ===`);
		for (const pm of failures) {
			console.log(`Case: ${pm.caseId} | Root Cause Bucket: ${pm.rootCause} | Diff: ${pm.stateDiff ?? "n/a"}`);
			console.log(pm.renderedTree);
		}
	}
}

await main();
