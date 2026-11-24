// Comparative Eval (`Eval-0003`) for Jehee's Single-Window Seamless Handoff (`ADR-0013` Slice 5D).
// Compares two arms on the exact same multi-turn scenario + SQLite restart + post-handoff verbatim recall:
//   Arm A: `no-handoff`        (unbounded active window: `sweetSpotTokens: 0`, no manual handoff)
//   Arm B: `seamless-handoff`  (sweet-spot auto-compaction + pre-compaction memory flush + manual `/handoff` + `history_search` verbatim recall)
//
// Run offline (deterministic, 0 API cost):
//   npm --prefix apps/jehee run eval:handoff
// Run against a real model configured in `apps/jehee/.env`:
//   JEHEE_EVAL_LIVE=1 npm --prefix apps/jehee run eval:handoff

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { HISTORY_SEARCH_TOOL } from "../src/context/extension.ts";
import type { HandoffWindowReport } from "../src/context/handoff.ts";
import { AtomicMemoryProvider } from "../src/memory/atomic-memory.ts";
import { parseJeheeEnvConfig } from "../src/runtime/config.ts";
import { createJeheeModels, type EnvDictionary } from "../src/runtime/models.ts";
import { loadDotEnvFile, openNodeJeheeHost } from "../src/runtime/node.ts";
import { computeTraceMetrics, type JeheeTraceMetrics, JeheeTraceRecorder } from "../src/telemetry/recorder.ts";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type HandoffArmId = "no-handoff" | "seamless-handoff";

type HandoffEvalResult = {
	readonly armId: HandoffArmId;
	readonly label: string;
	readonly modelLabel: string;
	readonly checks: {
		readonly autoCompactionTriggered: boolean;
		readonly preCompactionMemoryFlushed: boolean;
		readonly manualHandoffReducedWindow: boolean;
		readonly persistedAndSnapshotCompatible: boolean;
		readonly verbatimRecallAcrossHandoff: boolean;
		readonly activeWindowBounded: boolean;
	};
	readonly rubricScorePct: number;
	readonly passed: boolean;
	readonly windowStats: {
		readonly tokensAfterPhase1: number;
		readonly tokensAfterHandoff: number;
		readonly activeEntriesAfterHandoff: number;
		readonly totalCompactions: number;
		readonly totalManualHandoffs: number;
		readonly fullSnapshotTurns: number;
		readonly activeSnapshotTurns: number;
	};
	readonly contextSpanCounts: {
		readonly handoff: number;
		readonly historySearch: number;
		readonly memoryConsolidate: number;
	};
	readonly metrics: JeheeTraceMetrics;
	readonly diagnostics: {
		readonly manualHandoffReport?: HandoffWindowReport;
		readonly recallReply: string;
		readonly recalledMemoryItems: readonly string[];
		readonly notes: readonly string[];
	};
};

function pct(rate: number | undefined): string {
	return rate === undefined ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

function extractSystemText(ctx: TranscriptContext): string {
	return ctx.messages
		.filter((m) => m.role === "system")
		.map((m) => {
			const base = typeof m.content === "string" ? m.content : m.content.map((b) => b.text).join("");
			const secs =
				m.sections !== undefined
					? Object.values(m.sections)
							.filter((v): v is string => typeof v === "string")
							.join("\n")
					: "";
			return `${base}\n${secs}`;
		})
		.join("\n");
}

async function runArm(armId: HandoffArmId, liveEnvDict: EnvDictionary | undefined): Promise<HandoffEvalResult> {
	const tempDir = await mkdtemp(join(tmpdir(), `jehee-eval-handoff-${armId}-`));
	const sqlitePath = join(tempDir, "jehee.sqlite");
	const recorder = new JeheeTraceRecorder();

	const useLive = liveEnvDict !== undefined;
	const enableHandoff = armId === "seamless-handoff";
	const liveConfig = useLive ? parseJeheeEnvConfig(liveEnvDict) : undefined;
	const modelLabel =
		liveConfig !== undefined
			? `${liveConfig.defaultModel.provider}/${liveConfig.defaultModel.modelId}`
			: "faux/deterministic";

	const instructions =
		"You are Jehee, an always-on personal colleague. Reply concisely in Chinese. When the user asks to verify exact earlier wording, codes, or details that may have been compacted or handed off from earlier windows, call `history_search` with relevant keywords to inspect the verbatim history before answering.";

	let autoCompactionTriggered = false;
	let preCompactionMemoryFlushed = false;
	let manualHandoffReducedWindow = false;
	let persistedAndSnapshotCompatible = false;
	let verbatimRecallAcrossHandoff = false;
	let tokensAfterPhase1 = 0;
	let tokensAfterHandoff = 0;
	let activeEntriesAfterHandoff = 0;
	let totalCompactions = 0;
	let totalManualHandoffs = 0;
	let fullSnapshotTurns = 0;
	let activeSnapshotTurns = 0;
	let manualHandoffReport: HandoffWindowReport | undefined;
	let recallReply = "";
	const recalledMemoryItems: string[] = [];
	const notes: string[] = [];

	const makeMemory = () =>
		new AtomicMemoryProvider({
			seedCorePrompt: "身份：个人助理 Jehee",
			...(liveConfig?.memoryConsolidation.model !== undefined
				? { consolidation: { model: liveConfig.memoryConsolidation.model } }
				: {}),
		});

	const handoffConfig = enableHandoff
		? {
				sweetSpotTokens: 320,
				keepRecentTokens: 90,
				consolidateBeforeHandoff: true,
				...(liveConfig?.handoff.model !== undefined ? { model: liveConfig.handoff.model } : {}),
			}
		: {
				sweetSpotTokens: 0,
				keepRecentTokens: 90,
				consolidateBeforeHandoff: false,
			};

	try {
		// Phase 1: Two substantial project discussion turns that cross the 320-token sweet spot.
		const faux1 = fauxProvider();
		const models1 = useLive ? createJeheeModels(liveEnvDict) : createModels();
		if (!useLive) {
			models1.setProvider(faux1.provider);
			let chatTurn = 0;
			const router1 = (ctx: TranscriptContext) => {
				const sys = extractSystemText(ctx);
				if (sys.includes("background memory consolidation engine")) {
					const userText = ctx.messages
						.filter((m) => m.role === "user")
						.map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("")))
						.join("\n");
					if (userText.includes("SUP-991")) {
						return fauxAssistantMessage(
							JSON.stringify({
								summary: "换窗前沉淀补充协议编号",
								ops: [
									{
										op: "add",
										kind: "active",
										content: "补充协议编号 SUP-991 需在周五下午五点前完成法务双签（陈律师）",
										keywords: ["SUP-991", "补充协议", "陈律师", "周五"],
									},
								],
							}),
						);
					}
					return fauxAssistantMessage(
						JSON.stringify({
							summary: "压缩前自动沉淀灯塔计划核心信息",
							ops: [
								{
									op: "add",
									kind: "fact",
									content: "灯塔计划预算 120 万元，供应商编号 VN-2026-409，后端负责人周工",
									keywords: ["灯塔计划", "120 万", "VN-2026-409", "周工"],
									aliases: ["Lighthouse"],
									sourceEntryId: "1",
								},
							],
						}),
					);
				}
				if (sys.includes("context summarization assistant") || sys.includes("seamless window handoff summarizer")) {
					return fauxAssistantMessage(
						"## Goal\n推进灯塔计划下周上线与法务双签\n\n## Progress & Key Decisions\n- 后端负责人周工，预算 120 万，灰度节奏 5% -> 25% -> 100%\n\n## Open Items & Next Steps\n- 周五下午五点前完成补充协议双签",
					);
				}
				chatTurn += 1;
				if (chatTurn === 1) {
					return fauxAssistantMessage(`收到，已记录灯塔计划的核心安排和负责人信息。${"我会持续跟进关键里程碑和预算节点。".repeat(6)}`);
				}
				if (chatTurn === 2) {
					return fauxAssistantMessage(`了解，灰度发布节奏与降级方案很清晰。${"建议在 5% 灰度阶段重点观察错误率与延迟。".repeat(6)}`);
				}
				return fauxAssistantMessage("好的，已记下补充协议双签节点。");
			};
			faux1.setResponses(Array.from({ length: 16 }, () => router1));
		}

		const defaultModel1 =
			liveConfig !== undefined ? liveConfig.defaultModel : { provider: "faux", modelId: faux1.getModel().id };

		const host1 = await openNodeJeheeHost(
			{
				sqlitePath,
				models: models1,
				defaultModel: defaultModel1,
				instructions,
				memory: makeMemory(),
				handoff: handoffConfig,
				telemetry: recorder.telemetry,
			},
			BACKGROUND_CONTEXT,
		);

		await host1.sendMessage(
			{
				text:
					"我们启动灯塔计划（Lighthouse），总预算 120 万元，合作供应商编号是 VN-2026-409，后端架构由周工牵头。第一阶段要完成核心账务服务拆分、数据库双写校验、以及灰度流量镜像验证，确保核心链路零资损，同时补齐压测报告和回滚演练清单。",
			},
			BACKGROUND_CONTEXT,
		);
		await host1.sendMessage(
			{
				text:
					"关于下周上线窗口，网关限流按 5% -> 25% -> 100% 三段灰度推进，每一段观察 24 小时核心接口 P99 延迟和错误率；一旦 P99 超过 180ms 或 5xx 比例高于 0.2%，自动切回旧集群并冻结发布窗口，值班同学同步在告警群复盘。",
			},
			BACKGROUND_CONTEXT,
		);

		if (enableHandoff) {
			await host1.waitForCompaction(BACKGROUND_CONTEXT);
		}
		const statusPhase1 = await host1.getContextStatus(BACKGROUND_CONTEXT);
		tokensAfterPhase1 = statusPhase1.activeTokens;
		autoCompactionTriggered = statusPhase1.totalCompactions >= 1;
		if (enableHandoff && !autoCompactionTriggered) {
			notes.push(`auto-compaction did not trigger after phase 1 (activeTokens=${tokensAfterPhase1})`);
		}

		const memInspect = await host1.inspectMemory(BACKGROUND_CONTEXT, 30);
		if (memInspect.kind === "atomic") {
			const allItems = [...memInspect.snapshot.coreItems, ...memInspect.snapshot.recentItems];
			for (const item of allItems) {
				recalledMemoryItems.push(`[${item.id}] (${item.kind}) ${item.content}`);
			}
			preCompactionMemoryFlushed = allItems.some(
				(item) =>
					item.content.includes("灯塔") ||
					item.content.includes("Lighthouse") ||
					item.content.includes("VN-2026-409") ||
					item.content.includes("周工") ||
					item.content.includes("120"),
			);
			if (enableHandoff && !preCompactionMemoryFlushed) {
				notes.push("pre-compaction memory consolidation did not capture Lighthouse details");
			}
		}

		// Phase 2: One more turn with a legal agreement code, then explicit manual handoff (Arm B only).
		await host1.sendMessage(
			{
				text: "另外法务陈律师刚刚确认，补充协议编号 SUP-991 需要在本周五下午五点前完成双签盖章，才能放行下周上线。",
			},
			BACKGROUND_CONTEXT,
		);

		if (enableHandoff) {
			await host1.waitForCompaction(BACKGROUND_CONTEXT);
			manualHandoffReport = await host1.handoffWindow(BACKGROUND_CONTEXT, {
				focus: "聚焦灯塔计划下周上线与法务补充协议双签",
			});
			const afterHandoff = await host1.getContextStatus(BACKGROUND_CONTEXT);
			tokensAfterHandoff = afterHandoff.activeTokens;
			activeEntriesAfterHandoff = afterHandoff.activeEntries;
			manualHandoffReducedWindow =
				manualHandoffReport.status === "ok" &&
				manualHandoffReport.tokensAfter < manualHandoffReport.tokensBefore &&
				afterHandoff.totalManualHandoffs === 1;
			if (!manualHandoffReducedWindow) {
				notes.push(`manual handoff check failed: ${JSON.stringify(manualHandoffReport)}`);
			}
		} else {
			const afterNoHandoff = await host1.getContextStatus(BACKGROUND_CONTEXT);
			tokensAfterHandoff = afterNoHandoff.activeTokens;
			activeEntriesAfterHandoff = afterNoHandoff.activeEntries;
		}

		await host1.close(BACKGROUND_CONTEXT);

		// Phase 3: Reopen SQLite file, verify HandoffDoc + PortableSnapshot compatibility, and ask for verbatim recall.
		const faux2 = fauxProvider();
		const models2 = useLive ? createJeheeModels(liveEnvDict) : createModels();
		if (!useLive) {
			models2.setProvider(faux2.provider);
			faux2.setResponses([
				(ctx) => {
					const hasToolResult = ctx.messages.some((m) => m.role === "toolResult");
					if (enableHandoff && !hasToolResult) {
						return fauxAssistantMessage([fauxToolCall(HISTORY_SEARCH_TOOL, { query: "供应商编号" })], {
							stopReason: "toolUse",
						});
					}
					return fauxAssistantMessage("原话记录里的供应商编号是 VN-2026-409。");
				},
				() => fauxAssistantMessage("经核对历史原文，最早提到的供应商编号是 VN-2026-409。"),
			]);
		}

		const defaultModel2 =
			liveConfig !== undefined ? liveConfig.defaultModel : { provider: "faux", modelId: faux2.getModel().id };

		const host2 = await openNodeJeheeHost(
			{
				sqlitePath,
				models: models2,
				defaultModel: defaultModel2,
				instructions,
				memory: makeMemory(),
				handoff: handoffConfig,
				telemetry: recorder.telemetry,
			},
			BACKGROUND_CONTEXT,
		);

		const persistedStatus = await host2.getContextStatus(BACKGROUND_CONTEXT);
		totalCompactions = persistedStatus.totalCompactions;
		totalManualHandoffs = persistedStatus.totalManualHandoffs;

		const activeSnap = await host2.exportPortableSnapshot(BACKGROUND_CONTEXT, { transcriptScope: "active" });
		const fullSnap = await host2.exportPortableSnapshot(BACKGROUND_CONTEXT, { transcriptScope: "full" });
		activeSnapshotTurns = activeSnap.context.turns.length;
		fullSnapshotTurns = fullSnap.context.turns.length;

		const hasSummaryInActive = activeSnap.context.turns.some((t) => t.role === "summary");
		const hasVerbatimTurn1InFull = fullSnap.context.turns.some(
			(t) => t.role === "user" && t.text.includes("VN-2026-409"),
		);
		persistedAndSnapshotCompatible = enableHandoff
			? totalCompactions >= 1 && totalManualHandoffs === 1 && hasSummaryInActive && hasVerbatimTurn1InFull
			: hasVerbatimTurn1InFull;

		const recallTurn = await host2.sendMessage(
			{
				text: "前面最开始聊灯塔计划时，我提到的合作供应商编号原话是什么？麻烦核对一下历史原文告诉我。",
			},
			BACKGROUND_CONTEXT,
		);
		recallReply = recallTurn.replyText;

		await host2.close(BACKGROUND_CONTEXT);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}

	const traces = await recorder.listTraces(200);
	const allSpans = traces.flatMap((t) => t.spans);
	const metrics = computeTraceMetrics(allSpans);
	const contextSpanCounts = {
		handoff: allSpans.filter((s) => s.name === "jehee.context.handoff").length,
		historySearch: allSpans.filter((s) => s.name === "jehee.context.history_search").length,
		memoryConsolidate: allSpans.filter((s) => s.name === "jehee.memory.consolidate").length,
	};

	const mentionsCode = recallReply.includes("VN-2026-409");
	verbatimRecallAcrossHandoff = enableHandoff
		? mentionsCode && contextSpanCounts.historySearch >= 1
		: mentionsCode;
	if (enableHandoff && !verbatimRecallAcrossHandoff) {
		notes.push(
			`verbatim recall mismatch: mentionsCode=${mentionsCode}, historySearchSpans=${contextSpanCounts.historySearch}, reply="${recallReply.slice(0, 120)}"`,
		);
	}

	const checks = {
		autoCompactionTriggered,
		preCompactionMemoryFlushed,
		manualHandoffReducedWindow,
		persistedAndSnapshotCompatible,
		verbatimRecallAcrossHandoff,
		// Populated once both arms finish so we compare Arm B against Arm A directly.
		activeWindowBounded: false,
	};

	return {
		armId,
		label: enableHandoff ? "Seamless Handoff (Slice 5D)" : "No-Handoff (Baseline)",
		modelLabel,
		checks,
		rubricScorePct: 0,
		passed: false,
		windowStats: {
			tokensAfterPhase1,
			tokensAfterHandoff,
			activeEntriesAfterHandoff,
			totalCompactions,
			totalManualHandoffs,
			fullSnapshotTurns,
			activeSnapshotTurns,
		},
		contextSpanCounts,
		metrics,
		diagnostics: {
			...(manualHandoffReport !== undefined ? { manualHandoffReport } : {}),
			recallReply,
			recalledMemoryItems,
			notes,
		},
	};
}

function finalizeScores(baseline: HandoffEvalResult, handoff: HandoffEvalResult): [HandoffEvalResult, HandoffEvalResult] {
	const score = (r: HandoffEvalResult, activeWindowBounded: boolean): HandoffEvalResult => {
		const checks = { ...r.checks, activeWindowBounded };
		const total = Object.keys(checks).length;
		const passedCount = Object.values(checks).filter(Boolean).length;
		return {
			...r,
			checks,
			rubricScorePct: Math.round((passedCount / total) * 1000) / 10,
			passed: passedCount === total,
		};
	};
	const bounded = handoff.windowStats.tokensAfterHandoff < baseline.windowStats.tokensAfterHandoff;
	return [score(baseline, false), score(handoff, bounded)];
}

async function main(): Promise<void> {
	const isLive = process.env.JEHEE_EVAL_LIVE === "1";
	const dotEnv = isLive ? await loadDotEnvFile(join(appDir, ".env")) : undefined;
	const mergedEnv: EnvDictionary | undefined = isLive ? { ...dotEnv, ...process.env } : undefined;

	const rawBaseline = await runArm("no-handoff", mergedEnv);
	const rawHandoff = await runArm("seamless-handoff", mergedEnv);
	const results = finalizeScores(rawBaseline, rawHandoff);

	const modelBanner = results[0].modelLabel;
	console.log(
		`\n=== Eval-0003: No-Handoff Baseline vs Seamless Handoff (Slice 5D) [${isLive ? `LIVE: ${modelBanner}` : "OFFLINE DETERMINISTIC"}] ===\n`,
	);

	const header = [
		"| Arm | Score | AutoCompact | PreFlushMem | ManualHandoff | Persist+Snap | VerbatimRecall | WindowBounded | Tok(Ph1->Post) | Comp/Hand | Prefill | CacheHit(All/2+) | Cost(USD) | Wall(ms) | Spans(h/q/c) |",
		"| :--- | ---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | ---: | :---: | ---: | ---: | :---: |",
	];
	const rows = results.map((r) => {
		const c = r.checks;
		const w = r.windowStats;
		const m = r.metrics;
		const s = r.contextSpanCounts;
		const b = (v: boolean) => (v ? "Y" : "N");
		return `| ${r.label} | ${r.rubricScorePct}% | ${b(c.autoCompactionTriggered)} | ${b(c.preCompactionMemoryFlushed)} | ${b(c.manualHandoffReducedWindow)} | ${b(c.persistedAndSnapshotCompatible)} | ${b(c.verbatimRecallAcrossHandoff)} | ${b(c.activeWindowBounded)} | ${w.tokensAfterPhase1} -> ${w.tokensAfterHandoff} | ${w.totalCompactions}/${w.totalManualHandoffs} | ${m.prefillTokens} | ${pct(m.cacheHitRate)} / ${pct(m.postWarmupCacheHitRate)} | $${m.costUsd.toFixed(5)} | ${m.wallTimeMs.toFixed(0)} | ${s.handoff}/${s.historySearch}/${s.memoryConsolidate} |`;
	});
	console.log([...header, ...rows].join("\n"));

	if (isLive) {
		for (const r of results) {
			console.log(`\n--- Diagnostics: ${r.label} ---`);
			console.log("Window stats:", JSON.stringify(r.windowStats));
			console.log("Recall reply:", r.diagnostics.recallReply);
			if (r.diagnostics.recalledMemoryItems.length > 0) {
				console.log("Consolidated memory items:", r.diagnostics.recalledMemoryItems);
			}
			if (r.diagnostics.notes.length > 0) {
				console.log("Notes:", r.diagnostics.notes);
			}
		}
	}

	const artifactsDir = join(appDir, ".artifacts", "evals");
	await mkdir(artifactsDir, { recursive: true });
	const outFile = isLive ? "latest-handoff-eval-live.json" : "latest-handoff-eval.json";
	const outPath = join(artifactsDir, outFile);
	await writeFile(
		outPath,
		`${JSON.stringify({ generatedAt: new Date().toISOString(), isLive, results }, null, 2)}\n`,
		"utf8",
	);
	console.log(`\nSaved report to ${outPath}`);

	const handoffResult = results[1];
	if (!handoffResult.passed) {
		process.exitCode = 1;
	}
}

await main();
