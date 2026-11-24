// Before-vs-After Production Config Eval (`Eval-0004`) for flipping Cloudflare Worker `wrangler.jsonc`
// from `static-core` (Before) to `JEHEE_MEMORY_PROVIDER=atomic` + `JEHEE_MEMORY_CONSOLIDATION_IDLE_MS=600000` (After).
// Mirrors `worker.ts` assembly (`parseJeheeEnvConfig` + `JeheeHost` + `ChannelGateway` + SQLite restart)
// so both quality gains and real Prefill / Cache / Cost / Latency trade-offs are measured apples-to-apples.
//
// Run offline (deterministic, 0 API cost):
//   npm --prefix apps/jehee run eval:prod-memory
// Run against the live production model configured in `apps/jehee/.env`:
//   JEHEE_EVAL_LIVE=1 npm --prefix apps/jehee run eval:prod-memory

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChannelGateway } from "../src/channels/gateway.ts";
import { HISTORY_SEARCH_TOOL } from "../src/context/extension.ts";
import { AtomicMemoryProvider } from "../src/memory/atomic-memory.ts";
import { MEMORY_SAVE_TOOL, MEMORY_SEARCH_TOOL } from "../src/memory/bridge.ts";
import { StaticCoreMemoryProvider } from "../src/memory/static-core.ts";
import { parseJeheeEnvConfig } from "../src/runtime/config.ts";
import { createJeheeModels, type EnvDictionary } from "../src/runtime/models.ts";
import { loadDotEnvFile, openNodeJeheeHost } from "../src/runtime/node.ts";
import { computeTraceMetrics, type JeheeTraceMetrics, JeheeTraceRecorder } from "../src/telemetry/recorder.ts";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type ProdConfigArmId = "before-static-core" | "after-atomic-idle";

type ProdMemorySwitchEvalResult = {
	readonly armId: ProdConfigArmId;
	readonly label: string;
	readonly modelLabel: string;
	readonly parsedConfig: {
		readonly memoryProvider: "static" | "atomic";
		readonly idleDelayMs: number;
		readonly sweetSpotTokens: number;
		readonly keepRecentTokens: number;
		readonly consolidateBeforeHandoff: boolean;
	};
	readonly checks: {
		readonly seedCorePreserved: boolean;
		readonly explicitFactSavedAndPersisted: boolean;
		readonly implicitFactConsolidatedPreHandoff: boolean;
		readonly crossRestartAndHandoffRecallAccurate: boolean;
		readonly memoryForgetAndRestoreReversible: boolean;
		readonly prodStatusAndMemoryCommandsHealthy: boolean;
	};
	readonly rubricScorePct: number;
	readonly passed: boolean;
	readonly turn1PrefillTokens: number;
	readonly statusReply: string;
	readonly memoryReply: string;
	readonly recallReply: string;
	readonly activeMemoryCount: number;
	readonly idleWakeSnapshot: { readonly active: boolean; readonly atDeltaMs?: number };
	readonly spanCounts: {
		readonly memorySave: number;
		readonly memorySearch: number;
		readonly memoryConsolidate: number;
		readonly handoff: number;
		readonly historySearch: number;
	};
	readonly metrics: JeheeTraceMetrics;
	readonly notes: readonly string[];
};

const PROD_SEED_CORE = "回答简洁直接，工程任务优先派发工坊在独立目录执行。";

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

function buildSimulatedWorkerEnv(
	armId: ProdConfigArmId,
	baseEnv: EnvDictionary | undefined,
): EnvDictionary {
	const cleanBase: Record<string, string | undefined> = {};
	if (baseEnv !== undefined) {
		for (const [k, v] of Object.entries(baseEnv)) {
			if (
				k === "JEHEE_MEMORY_PROVIDER" ||
				k === "JEHEE_MEMORY_CONSOLIDATION_IDLE_MS" ||
				k === "JEHEE_MEMORY_CONSOLIDATION_MIN_TURNS" ||
				k === "JEHEE_CORE_MEMORY" ||
				k === "JEHEE_HANDOFF_SWEET_SPOT_TOKENS" ||
				k === "JEHEE_HANDOFF_KEEP_RECENT_TOKENS" ||
				k === "JEHEE_HANDOFF_CONSOLIDATE"
			) {
				continue;
			}
			cleanBase[k] = v;
		}
	}
	cleanBase.JEHEE_MODEL = baseEnv?.JEHEE_MODEL?.trim() || "opencode-go/deepseek-v4.1-flash";
	cleanBase.JEHEE_CORE_MEMORY = PROD_SEED_CORE;
	if (armId === "after-atomic-idle") {
		cleanBase.JEHEE_MEMORY_PROVIDER = "atomic";
		cleanBase.JEHEE_MEMORY_CONSOLIDATION_IDLE_MS = "600000";
	}
	return cleanBase;
}

async function runArm(
	armId: ProdConfigArmId,
	liveEnvDict: EnvDictionary | undefined,
): Promise<ProdMemorySwitchEvalResult> {
	const tempDir = await mkdtemp(join(tmpdir(), `jehee-eval-prod-${armId}-`));
	const sqlitePath = join(tempDir, "jehee.sqlite");
	const recorder = new JeheeTraceRecorder();
	const useLive = liveEnvDict !== undefined;
	const isAtomic = armId === "after-atomic-idle";

	const workerEnv = buildSimulatedWorkerEnv(armId, liveEnvDict);
	const parsed = parseJeheeEnvConfig(workerEnv);
	const modelLabel = useLive
		? `${parsed.defaultModel.provider}/${parsed.defaultModel.modelId}`
		: "faux/deterministic";

	// Mirror worker.ts assembly exactly (except idleDelayMs is read from parsed config and kept real).
	const buildMemory = () =>
		parsed.memoryProvider === "atomic"
			? new AtomicMemoryProvider({
					seedCorePrompt: parsed.coreMemoryPrompt,
					maxCoreChars: parsed.memoryCoreMaxChars,
					consolidation: parsed.memoryConsolidation,
				})
			: new StaticCoreMemoryProvider({ corePrompt: parsed.coreMemoryPrompt });

	let seedCorePreserved = false;
	let explicitFactSavedAndPersisted = false;
	let implicitFactConsolidatedPreHandoff = false;
	let crossRestartAndHandoffRecallAccurate = false;
	let memoryForgetAndRestoreReversible = false;
	let prodStatusAndMemoryCommandsHealthy = false;
	let statusReply = "";
	let memoryReply = "";
	let recallReply = "";
	let activeMemoryCount = 0;
	let idleWakeSnapshot: { readonly active: boolean; readonly atDeltaMs?: number } = { active: false };
	const notes: string[] = [];
	let openHost: Awaited<ReturnType<typeof openNodeJeheeHost>> | undefined;

	try {
		// Phase 1: Initial conversation turns + explicit /handoff (exact Worker.ts behavior).
		const faux1 = fauxProvider();
		const models1 = useLive ? createJeheeModels(workerEnv) : createModels();
		if (!useLive) {
			models1.setProvider(faux1.provider);
			let chatCount = 0;
			const router1 = (ctx: TranscriptContext) => {
				const sys = extractSystemText(ctx);
				if (sys.includes("background memory consolidation engine")) {
					return fauxAssistantMessage(
						JSON.stringify({
							summary: "换窗前沉淀每周二牙科复诊与星河科技合同信息",
							ops: [
								{
									op: "add",
									kind: "active",
									content: "下个月起每周二上午固定有牙科复诊，不要安排会议",
									keywords: ["牙科", "复诊", "周二", "不要排会"],
								},
							],
						}),
					);
				}
				if (sys.includes("seamless window handoff summarizer")) {
					return fauxAssistantMessage(
						"## Goal\n跟进星河科技下周三项目评审\n\n## Progress & Key Decisions\n- 已明确团队协作偏好与下周安排\n\n## Open Items & Next Steps\n- 推进评审准备",
					);
				}
				const hasToolResult = ctx.messages.some((m) => m.role === "toolResult");
				if (isAtomic && chatCount === 0 && !hasToolResult) {
					chatCount += 1;
					return fauxAssistantMessage(
						[
							fauxToolCall(MEMORY_SAVE_TOOL, {
								kind: "core",
								content: "项目包管理偏好使用 pnpm",
								keywords: ["pnpm"],
							}),
							fauxToolCall(MEMORY_SAVE_TOOL, {
								kind: "fact",
								content: "星河科技对接人赵敏，合同号 XH-2026-312，下周三评审",
								keywords: ["星河科技", "赵敏", "XH-2026-312"],
								aliases: ["Xinghe"],
							}),
						],
						{ stopReason: "toolUse" },
					);
				}
				chatCount += 1;
				if (chatCount <= 2) {
					return fauxAssistantMessage("收到，已记下你的偏好和星河科技评审安排。");
				}
				return fauxAssistantMessage("好的，下个月每周二上午我帮你避开排会。");
			};
			faux1.setResponses(Array.from({ length: 14 }, () => router1));
		}

		const defaultModel1 = useLive ? parsed.defaultModel : { provider: "faux", modelId: faux1.getModel().id };
		const host1 = await openNodeJeheeHost(
			{
				sqlitePath,
				models: models1,
				defaultModel: defaultModel1,
				instructions: parsed.instructions,
				memory: buildMemory(),
				handoff: parsed.handoff,
				telemetry: recorder.telemetry,
			},
			BACKGROUND_CONTEXT,
		);
		openHost = host1;

		// Turn 1: Natural realistic message with preference + client fact.
		await host1.sendMessage(
			{
				text: "帮我记一下：以后代码项目统一优先用 pnpm；另外客户星河科技的对接人是赵敏，合同号 XH-2026-312，下周三下午做方案评审。",
			},
			BACKGROUND_CONTEXT,
		);

		// Turn 2: Natural casual message sharing a recurring schedule without asking to save.
		await host1.sendMessage(
			{
				text: "对了，下个月开始我每周二上午固定要去医院做牙科复诊，帮我留意一下，那个时段别排会议。",
			},
			BACKGROUND_CONTEXT,
		);
		// Wait for GenerationTask afterRun hook and the microtask wake settlement before inspecting DO alarm state.
		await host1.waitForCompaction(BACKGROUND_CONTEXT);
		await new Promise((resolveTimer) => setTimeout(resolveTimer, 25));
		const wake = host1.wake();
		idleWakeSnapshot = {
			active: wake.active,
			...(wake.at !== undefined ? { atDeltaMs: Math.max(0, wake.at - Date.now()) } : {}),
		};
		if (isAtomic && (wake.active || wake.at === undefined || wake.at - Date.now() < 540_000)) {
			notes.push(`unexpected DO idle wake after turn 2: ${JSON.stringify(idleWakeSnapshot)}`);
		}

		// Turn 3: Explicit window handoff (mirrors /handoff on Worker DO: triggers pre-handoff consolidation on atomic,
		// then replaces active context with concise handoff brief while preserving raw SQLite transcript).
		const handoffReport = await host1.handoffWindow(BACKGROUND_CONTEXT, {
			focus: "聚焦下周三评审准备，开启干净新窗口",
		});
		if (handoffReport.status !== "ok") {
			notes.push(`handoffWindow returned ${handoffReport.status}: ${JSON.stringify(handoffReport)}`);
		}

		await host1.close(BACKGROUND_CONTEXT);
		openHost = undefined;

		// Phase 2: Cold restart SQLite (simulating Cloudflare DO hibernation & wake), verify commands & recall.
		const faux2 = fauxProvider();
		const models2 = useLive ? createJeheeModels(workerEnv) : createModels();
		if (!useLive) {
			models2.setProvider(faux2.provider);
			faux2.setResponses([
				(ctx) => {
					const hasToolResult = ctx.messages.some((m) => m.role === "toolResult");
					if (isAtomic && !hasToolResult) {
						return fauxAssistantMessage(
							[
								fauxToolCall(MEMORY_SEARCH_TOOL, { query: "星河科技" }),
								fauxToolCall(MEMORY_SEARCH_TOOL, { query: "牙科" }),
							],
							{ stopReason: "toolUse" },
						);
					}
					if (!isAtomic && !hasToolResult) {
						// Under static-core, worker still has history_search enabled because handoff config is passed,
						// OR if the model doesn't know to search history it can only read the brief.
						return fauxAssistantMessage("当前交接摘要里只有下周三评审，没有记下具体对接人、合同号或周二复诊细节。");
					}
					return fauxAssistantMessage(
						"星河科技对接人是赵敏，合同号 XH-2026-312；下个月每周二上午你有固定牙科复诊，已避开排会。",
					);
				},
				() =>
					fauxAssistantMessage(
						"星河科技对接人是赵敏，合同号 XH-2026-312；下个月每周二上午固定有牙科复诊，不会排会。",
					),
			]);
		}

		const defaultModel2 = useLive ? parsed.defaultModel : { provider: "faux", modelId: faux2.getModel().id };
		const host2 = await openNodeJeheeHost(
			{
				sqlitePath,
				models: models2,
				defaultModel: defaultModel2,
				instructions: parsed.instructions,
				memory: buildMemory(),
				handoff: parsed.handoff,
				telemetry: recorder.telemetry,
			},
			BACKGROUND_CONTEXT,
		);
		openHost = host2;

		// Exercise exact Telegram command path via ChannelGateway.
		const replies: string[] = [];
		const gateway = new ChannelGateway({
			host: host2,
			allowFrom: { telegram: ["10001"] },
			debounceMs: 0,
		});
		gateway.registerTransport({
			channel: "telegram",
			sendText: async (_chatId, text) => {
				replies.push(text);
			},
		});

		await gateway.ingest(
			{ channel: "telegram", chatId: "10001", senderId: "10001", text: "/status", requestId: "eval-status-1" },
			BACKGROUND_CONTEXT,
		);
		await gateway.ingest(
			{ channel: "telegram", chatId: "10001", senderId: "10001", text: "/memory", requestId: "eval-memory-1" },
			BACKGROUND_CONTEXT,
		);
		statusReply = replies[0] ?? "";
		memoryReply = replies[1] ?? "";

		const expectedMemHeader = isAtomic ? "memory: atomic-memory" : "memory: static-core";
		prodStatusAndMemoryCommandsHealthy =
			statusReply.includes(expectedMemHeader) &&
			statusReply.includes("context:") &&
			statusReply.includes("handoffs=1") &&
			memoryReply.includes("[Memory]");

		const inspect = await host2.inspectMemory(BACKGROUND_CONTEXT, 30);
		const snapCheck = await host2.exportPortableSnapshot(BACKGROUND_CONTEXT, { transcriptScope: "active" });
		seedCorePreserved = snapCheck.memory.corePrompt?.includes(PROD_SEED_CORE) ?? false;
		if (inspect.kind === "atomic") {
			const allItems = [...inspect.snapshot.coreItems, ...inspect.snapshot.recentItems];
			activeMemoryCount = inspect.snapshot.totalActive;
			explicitFactSavedAndPersisted = allItems.some(
				(i) => i.content.includes("赵敏") || i.content.includes("XH-2026-312") || i.content.includes("星河"),
			);
			implicitFactConsolidatedPreHandoff = allItems.some(
				(i) => i.content.includes("牙科") || i.content.includes("复诊") || i.content.includes("周二"),
			);

			// Verify reversible forget + restore on a live persisted item (without altering recall state).
			const sample = allItems[0];
			if (sample !== undefined) {
				const fg = await host2.forgetMemory(sample.id, BACKGROUND_CONTEXT, "eval reversibility check");
				const afterForget = await host2.searchMemory({ query: sample.content.slice(0, 6) }, BACKGROUND_CONTEXT);
				const hidden =
					afterForget.kind === "atomic" && !afterForget.hits.some((h) => h.item.id === sample.id);
				const rs = await host2.restoreMemory(sample.id, BACKGROUND_CONTEXT);
				memoryForgetAndRestoreReversible = fg.ok && hidden && rs.ok;
			}
		}

		// Turn 4 (after handoff + restart): Ask about all 3 earlier details naturally.
		const recallTurn = await host2.sendMessage(
			{
				text: "星河科技的对接人是谁、合同号多少？另外我下个月每周二上午有什么固定安排来着？",
			},
			BACKGROUND_CONTEXT,
		);
		recallReply = recallTurn.replyText;
		const hasZhao = recallReply.includes("赵敏");
		const hasContract = recallReply.includes("XH-2026-312");
		const hasDental = recallReply.includes("牙科") || recallReply.includes("复诊");
		crossRestartAndHandoffRecallAccurate = hasZhao && hasContract && hasDental;
		if (!crossRestartAndHandoffRecallAccurate) {
			notes.push(
				`recall check partial: zhao=${hasZhao}, contract=${hasContract}, dental=${hasDental}, reply="${recallReply.slice(0, 140)}"`,
			);
		}

		await host2.close(BACKGROUND_CONTEXT);
		openHost = undefined;
	} finally {
		if (openHost !== undefined) {
			await openHost.close(BACKGROUND_CONTEXT).catch(() => undefined);
		}
		await rm(tempDir, { recursive: true, force: true });
	}

	const traces = await recorder.listTraces(200);
	const allSpans = traces.flatMap((t) => t.spans);
	const metrics = computeTraceMetrics(allSpans);
	const aiSpans = allSpans
		.filter((s) => s.name === "pi.ai.request")
		.sort((a, b) => a.startTimeMs - b.startTimeMs);
	const firstAi = aiSpans[0];
	const turn1PrefillTokens =
		firstAi !== undefined
			? Number(firstAi.attributes["usage.input"] ?? 0) +
				Number(firstAi.attributes["usage.cache_read"] ?? 0) +
				Number(firstAi.attributes["usage.cache_write"] ?? 0)
			: 0;

	const spanCounts = {
		memorySave: allSpans.filter((s) => s.name === "jehee.memory.save").length,
		memorySearch: allSpans.filter((s) => s.name === "jehee.memory.search").length,
		memoryConsolidate: allSpans.filter((s) => s.name === "jehee.memory.consolidate").length,
		handoff: allSpans.filter((s) => s.name === "jehee.context.handoff").length,
		historySearch: allSpans.filter((s) => s.name === "jehee.context.history_search").length,
	};

	const checks = {
		seedCorePreserved,
		explicitFactSavedAndPersisted,
		implicitFactConsolidatedPreHandoff,
		crossRestartAndHandoffRecallAccurate,
		memoryForgetAndRestoreReversible,
		prodStatusAndMemoryCommandsHealthy,
	};
	const totalChecks = Object.keys(checks).length;
	const passedCount = Object.values(checks).filter(Boolean).length;
	const rubricScorePct = Math.round((passedCount / totalChecks) * 1000) / 10;

	return {
		armId,
		label: isAtomic ? "AFTER: atomic + idle(10m)" : "BEFORE: static-core",
		modelLabel,
		parsedConfig: {
			memoryProvider: parsed.memoryProvider,
			idleDelayMs: parsed.memoryConsolidation.idleDelayMs,
			sweetSpotTokens: parsed.handoff.sweetSpotTokens,
			keepRecentTokens: parsed.handoff.keepRecentTokens,
			consolidateBeforeHandoff: parsed.handoff.consolidateBeforeHandoff,
		},
		checks,
		rubricScorePct,
		passed: passedCount === totalChecks,
		turn1PrefillTokens,
		statusReply,
		memoryReply,
		recallReply,
		activeMemoryCount,
		idleWakeSnapshot,
		spanCounts,
		metrics,
		notes,
	};
}

// Keep unused import guard clean when offline router references tool constants.
void HISTORY_SEARCH_TOOL;

async function main(): Promise<void> {
	const isLive = process.env.JEHEE_EVAL_LIVE === "1";
	const dotEnv = isLive ? await loadDotEnvFile(join(appDir, ".env")) : undefined;
	const mergedEnv: EnvDictionary | undefined = isLive ? { ...dotEnv, ...process.env } : undefined;

	const results: ProdMemorySwitchEvalResult[] = [
		await runArm("before-static-core", mergedEnv),
		await runArm("after-atomic-idle", mergedEnv),
	];

	const modelBanner = results[0]?.modelLabel ?? "unknown";
	console.log(
		`\n=== Eval-0004: Prod Worker Config BEFORE (static-core) vs AFTER (atomic + idle 10m) [${isLive ? `LIVE: ${modelBanner}` : "OFFLINE DETERMINISTIC"}] ===\n`,
	);

	const header = [
		"| Arm | Score | SeedCore | ExplicitSave | PreHandoffConsol | PostRestartRecall | Forget/Restore | Cmds | Turn1Prefill | TotalPrefill | CacheHit(All/2+) | Cost(USD) | Wall(ms) | Spans(ms/mq/mc/h/hq) |",
		"| :--- | ---: | :---: | :---: | :---: | :---: | :---: | :---: | ---: | ---: | :---: | ---: | ---: | :---: |",
	];
	const rows = results.map((r) => {
		const c = r.checks;
		const m = r.metrics;
		const s = r.spanCounts;
		const b = (v: boolean) => (v ? "Y" : "N");
		return `| ${r.label} | ${r.rubricScorePct}% | ${b(c.seedCorePreserved)} | ${b(c.explicitFactSavedAndPersisted)} | ${b(c.implicitFactConsolidatedPreHandoff)} | ${b(c.crossRestartAndHandoffRecallAccurate)} | ${b(c.memoryForgetAndRestoreReversible)} | ${b(c.prodStatusAndMemoryCommandsHealthy)} | ${r.turn1PrefillTokens} | ${m.prefillTokens} | ${pct(m.cacheHitRate)} / ${pct(m.postWarmupCacheHitRate)} | $${m.costUsd.toFixed(5)} | ${m.wallTimeMs.toFixed(0)} | ${s.memorySave}/${s.memorySearch}/${s.memoryConsolidate}/${s.handoff}/${s.historySearch} |`;
	});
	console.log([...header, ...rows].join("\n"));

	const before = results[0]!;
	const after = results[1]!;
	const prefillDelta = after.turn1PrefillTokens - before.turn1PrefillTokens;
	const costDelta = after.metrics.costUsd - before.metrics.costUsd;
	console.log(
		`\nDelta (AFTER - BEFORE): Score ${before.rubricScorePct}% -> ${after.rubricScorePct}%, Turn1Prefill ${prefillDelta >= 0 ? "+" : ""}${prefillDelta} tok (tool schema tax), Cost ${costDelta >= 0 ? "+" : ""}$${costDelta.toFixed(5)}, ActiveMemories 0 -> ${after.activeMemoryCount}, IdleTimer 0ms -> ${after.parsedConfig.idleDelayMs}ms`,
	);

	if (isLive) {
		for (const r of results) {
			console.log(`\n--- Diagnostics: ${r.label} ---`);
			console.log("Parsed config:", JSON.stringify(r.parsedConfig));
			console.log("DO wake() after turn 2:", JSON.stringify(r.idleWakeSnapshot));
			console.log("/status:\n" + r.statusReply);
			console.log("/memory:\n" + r.memoryReply);
			console.log("Recall reply:", r.recallReply);
			if (r.notes.length > 0) console.log("Notes:", r.notes);
		}
	}

	const artifactsDir = join(appDir, ".artifacts", "evals");
	await mkdir(artifactsDir, { recursive: true });
	const outFile = isLive ? "latest-prod-memory-eval-live.json" : "latest-prod-memory-eval.json";
	const outPath = join(artifactsDir, outFile);
	await writeFile(
		outPath,
		`${JSON.stringify({ generatedAt: new Date().toISOString(), isLive, results }, null, 2)}\n`,
		"utf8",
	);
	console.log(`\nSaved report to ${outPath}`);

	if (!after.passed) {
		process.exitCode = 1;
	}
}

await main();
