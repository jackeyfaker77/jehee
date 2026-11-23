// Comparative Eval (`Eval-0002`) for Jehee's Pluggable Memory Layer (`ADR-0010` Slice 5C-1 & `ADR-0011` Slice 5C-2).
// Compares three arms on the exact same multi-phase scenario:
//   Arm A: `static-core`                  (Slice 1 baseline `StaticCoreMemoryProvider`)
//   Arm B: `atomic-memory`                (Slice 5C-1 `AtomicMemoryProvider` without background consolidation)
//   Arm C: `atomic-memory-consolidated`   (Slice 5C-2 `AtomicMemoryProvider` + background consolidation)
//
// Run offline (deterministic, 0 API cost):
//   npm --prefix apps/jehee run eval:memory
// Run against a real model configured in `apps/jehee/.env`:
//   JEHEE_EVAL_LIVE=1 npm --prefix apps/jehee run eval:memory

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AtomicMemoryProvider } from "../src/memory/atomic-memory.ts";
import { MEMORY_FORGET_TOOL, MEMORY_SAVE_TOOL, MEMORY_SEARCH_TOOL } from "../src/memory/bridge.ts";
import type { MemoryConsolidationReport, MemoryItem } from "../src/memory/contract.ts";
import { StaticCoreMemoryProvider } from "../src/memory/static-core.ts";
import { parseJeheeEnvConfig } from "../src/runtime/config.ts";
import { createJeheeModels, type EnvDictionary } from "../src/runtime/models.ts";
import { loadDotEnvFile, openNodeJeheeHost } from "../src/runtime/node.ts";
import { computeTraceMetrics, type JeheeTraceMetrics, JeheeTraceRecorder } from "../src/telemetry/recorder.ts";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type MemoryArmId = "static-core" | "atomic-memory" | "atomic-memory-consolidated";

type MemoryEvalResult = {
	readonly armId: MemoryArmId;
	readonly label: string;
	readonly modelLabel: string;
	readonly checks: {
		readonly corePersistedAcrossRestart: boolean;
		readonly aliasDateSearchWithProvenance: boolean;
		readonly forgetImmediateRetraction: boolean;
		readonly factWritePrefixStability: boolean;
		readonly implicitFactExtracted: boolean;
		readonly duplicateMergedAndConflictResolved: boolean;
		readonly watermarkIdempotentNoop: boolean;
	};
	readonly rubricScorePct: number;
	readonly passed: boolean;
	readonly memorySpanCounts: {
		readonly save: number;
		readonly search: number;
		readonly forget: number;
		readonly consolidate: number;
	};
	readonly metrics: JeheeTraceMetrics;
	readonly consolidationReport?: MemoryConsolidationReport;
	readonly diagnostics: {
		readonly coreItemsAfterPhase1: readonly string[];
		readonly coreItemsAfterForget: readonly string[];
		readonly finalActiveItems: readonly string[];
		readonly notes: readonly string[];
	};
};

function effectiveCoreSection(ctx: TranscriptContext): string | null | undefined {
	let current: string | null | undefined;
	for (const msg of ctx.messages) {
		if (msg.role !== "system" || msg.sections === undefined) continue;
		if (Object.hasOwn(msg.sections, "jehee_core_memory")) {
			current = msg.sections.jehee_core_memory;
		}
	}
	return current;
}

function summarizeItem(item: MemoryItem): string {
	const aliases = item.aliases.length > 0 ? ` aliases=${JSON.stringify(item.aliases)}` : "";
	const dates = item.validFrom !== undefined ? ` validFrom=${item.validFrom}` : "";
	const src = item.sourceEntryId !== undefined ? ` src=${item.sourceEntryId}` : "";
	return `[${item.id}] (${item.kind}) ${item.content}${aliases}${dates}${src}`;
}

function pct(rate: number | undefined): string {
	return rate === undefined ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

async function runArm(armId: MemoryArmId, liveEnvDict: EnvDictionary | undefined): Promise<MemoryEvalResult> {
	const tempDir = await mkdtemp(join(tmpdir(), `jehee-eval-mem-${armId}-`));
	const sqlitePath = join(tempDir, "jehee.sqlite");
	const recorder = new JeheeTraceRecorder();
	const captured1: TranscriptContext[] = [];
	const captured2: TranscriptContext[] = [];

	const useLive = liveEnvDict !== undefined;
	const isAtomic = armId !== "static-core";
	const useConsolidation = armId === "atomic-memory-consolidated";
	const liveConfig = useLive ? parseJeheeEnvConfig(liveEnvDict) : undefined;
	const modelLabel =
		liveConfig !== undefined
			? `${liveConfig.defaultModel.provider}/${liveConfig.defaultModel.modelId}`
			: "faux/deterministic";

	const makeProvider = () =>
		isAtomic
			? new AtomicMemoryProvider({
					seedCorePrompt: "身份：个人助理 Jehee",
					...(liveConfig?.memoryConsolidation.model !== undefined
						? { consolidation: { model: liveConfig.memoryConsolidation.model } }
						: {}),
				})
			: new StaticCoreMemoryProvider({ corePrompt: "身份：个人助理 Jehee" });

	let factWritePrefixStability = false;
	let corePersistedAcrossRestart = false;
	let aliasDateSearchWithProvenance = false;
	let forgetImmediateRetraction = false;
	let implicitFactExtracted = false;
	let duplicateMergedAndConflictResolved = false;
	let watermarkIdempotentNoop = false;
	let consolidationReport: MemoryConsolidationReport | undefined;
	const coreItemsAfterPhase1: string[] = [];
	const coreItemsAfterForget: string[] = [];
	const finalActiveItems: string[] = [];
	const notes: string[] = [];

	const instructions =
		"You are Jehee, an always-on personal colleague. Reply concisely in Chinese. When memory tools are available: use `memory_save` with kind='core' ONLY for stable long-term rules/preferences, and kind='fact'|'episode'|'active' for project facts/events (always populate `keywords`, `aliases`, and `validFrom` when dates/nicknames are given). When asked to forget a memory, call `memory_forget` with its exact ID.";

	try {
		// Phase 1: Teach Core preference + Fact with alias & date + seed duplicate/outdated facts,
		// then hold a casual turn sharing an implicit fact and an updated address WITHOUT asking to save.
		const faux1 = fauxProvider();
		const models1 = useLive ? createJeheeModels(liveEnvDict) : createModels();
		if (!useLive) {
			models1.setProvider(faux1.provider);
			if (isAtomic) {
				faux1.setResponses([
					(ctx) => {
						captured1.push(ctx);
						return fauxAssistantMessage(
							[
								fauxToolCall(MEMORY_SAVE_TOOL, {
									kind: "core",
									content: "回答简明扼要，统一使用 pnpm",
									keywords: ["pnpm", "风格"],
								}),
							],
							{ stopReason: "toolUse" },
						);
					},
					(ctx) => {
						captured1.push(ctx);
						return fauxAssistantMessage(
							[
								fauxToolCall(MEMORY_SAVE_TOOL, {
									kind: "fact",
									content: "张伟负责支付网关重构",
									keywords: ["支付网关", "重构"],
									aliases: ["老张", "Zhang"],
									validFrom: "2026-05-10",
								}),
							],
							{ stopReason: "toolUse" },
						);
					},
					(ctx) => {
						captured1.push(ctx);
						return fauxAssistantMessage("好的，已持久记住。");
					},
					(ctx) => {
						captured1.push(ctx);
						return fauxAssistantMessage("了解，祝搬家顺利！");
					},
				]);
			} else {
				faux1.setResponses([
					(ctx) => {
						captured1.push(ctx);
						return fauxAssistantMessage("好的（无持久化写入工具）。");
					},
					(ctx) => {
						captured1.push(ctx);
						return fauxAssistantMessage("了解。");
					},
				]);
			}
		}

		const defaultModel1 =
			liveConfig !== undefined ? liveConfig.defaultModel : { provider: "faux", modelId: faux1.getModel().id };

		const host1 = await openNodeJeheeHost(
			{
				sqlitePath,
				models: models1,
				defaultModel: defaultModel1,
				instructions,
				memory: makeProvider(),
				telemetry: recorder.telemetry,
			},
			BACKGROUND_CONTEXT,
		);

		await host1.sendMessage(
			{
				text: "请记住两件事：第一，长期偏好——以后回答简明扼要，代码统一使用 pnpm；第二，项目事实——从 2026-05-10 开始，张伟（大家常叫他老张）负责支付网关重构。",
			},
			BACKGROUND_CONTEXT,
		);

		if (isAtomic) {
			const snap1 = await host1.inspectMemory(BACKGROUND_CONTEXT, 20);
			if (snap1.kind === "atomic") {
				for (const item of snap1.snapshot.coreItems) {
					coreItemsAfterPhase1.push(summarizeItem(item));
				}
				const factStoredNonCore = snap1.snapshot.recentItems.some(
					(item) => item.content.includes("张伟") || item.content.includes("支付网关"),
				);
				if (!useLive && captured1.length >= 3) {
					const sysAfterCore = captured1[1]!.messages.filter((m) => m.role === "system").length;
					const sysAfterFact = captured1[2]!.messages.filter((m) => m.role === "system").length;
					factWritePrefixStability =
						factStoredNonCore &&
						sysAfterFact === sysAfterCore &&
						effectiveCoreSection(captured1[2]!) === effectiveCoreSection(captured1[1]!);
				} else {
					const leakedFactIntoCore = snap1.snapshot.coreItems.some(
						(item) => item.content.includes("张伟") || item.content.includes("支付网关"),
					);
					factWritePrefixStability = factStoredNonCore && !leakedFactIntoCore;
					if (leakedFactIntoCore) notes.push("live model mistakenly wrote project fact into kind='core'");
					if (!factStoredNonCore) notes.push("live model did not save project fact as non-core item");
				}
			}

			// Seed a near-duplicate of the payment-gateway owner fact and an outdated address for dedup & conflict testing.
			await host1.saveMemory(
				{ kind: "fact", content: "张伟是支付网关重构负责人", keywords: ["支付网关", "负责人"], aliases: ["老张"] },
				BACKGROUND_CONTEXT,
			);
			await host1.saveMemory(
				{ kind: "fact", content: "目前居住在上海浦东", keywords: ["住址", "浦东", "上海"] },
				BACKGROUND_CONTEXT,
			);
		} else {
			factWritePrefixStability = true;
		}

		// Casual turn: realistic casual remark sharing an updated address & recurring weekly cadence (not explicitly asking to remember).
		await host1.sendMessage(
			{ text: "对了，这周刚搬到深圳南山，收拾东西累坏了；另外团队新规定以后每周五下午固定要发周报，感觉周末前时间好紧。" },
			BACKGROUND_CONTEXT,
		);
		await host1.close(BACKGROUND_CONTEXT);

		// Phase 2: Reopen same SQLite file, verify L1 Core persistence, alias/date recall, immediate forget,
		// and (for Arm C) run consolidation + watermark idempotency check.
		const faux2 = fauxProvider();
		const models2 = useLive ? createJeheeModels(liveEnvDict) : createModels();
		if (!useLive) {
			models2.setProvider(faux2.provider);
			if (isAtomic) {
				const phase2Steps = [
					(ctx: TranscriptContext) => {
						captured2.push(ctx);
						return fauxAssistantMessage(
							[
								fauxToolCall(MEMORY_SEARCH_TOOL, {
									query: "老张",
									fromDate: "2026-05-01",
									toDate: "2026-05-31",
								}),
							],
							{ stopReason: "toolUse" },
						);
					},
					(ctx: TranscriptContext) => {
						captured2.push(ctx);
						return fauxAssistantMessage("张伟负责支付网关重构。");
					},
					(ctx: TranscriptContext) => {
						captured2.push(ctx);
						return fauxAssistantMessage([fauxToolCall(MEMORY_FORGET_TOOL, { id: "mem_0001", reason: "改为 bun" })], {
							stopReason: "toolUse",
						});
					},
					(ctx: TranscriptContext) => {
						captured2.push(ctx);
						return fauxAssistantMessage("已遗忘 mem_0001。");
					},
				];
				if (useConsolidation) {
					phase2Steps.push(() =>
						fauxAssistantMessage(
							JSON.stringify({
								summary: "提炼周五周报惯例、合并老张重复项并替换旧浦东住址为深圳南山",
								ops: [
									{
										op: "add",
										kind: "active",
										content: "每周五下午固定发团队周报",
										keywords: ["周五", "周报"],
										aliases: ["weekly report"],
										sourceEntryId: "6",
									},
									{
										op: "merge",
										keepId: "mem_0002",
										dropIds: ["mem_0003"],
										content: "张伟负责支付网关重构",
										keywords: ["支付网关", "负责人"],
									},
									{
										op: "supersede",
										oldId: "mem_0004",
										reason: "已搬迁至深圳南山",
										replacement: {
											kind: "fact",
											content: "现住址在深圳南山",
											keywords: ["住址", "深圳", "南山"],
										},
									},
								],
							}),
						),
					);
				}
				faux2.setResponses(phase2Steps);
			} else {
				faux2.setResponses([
					(ctx) => {
						captured2.push(ctx);
						return fauxAssistantMessage("无法按别名检索历史记忆。");
					},
					(ctx) => {
						captured2.push(ctx);
						return fauxAssistantMessage("无法动态遗忘记忆。");
					},
				]);
			}
		}

		const defaultModel2 =
			liveConfig !== undefined ? liveConfig.defaultModel : { provider: "faux", modelId: faux2.getModel().id };

		const host2 = await openNodeJeheeHost(
			{
				sqlitePath,
				models: models2,
				defaultModel: defaultModel2,
				instructions,
				memory: makeProvider(),
				telemetry: recorder.telemetry,
			},
			BACKGROUND_CONTEXT,
		);

		// Check 1 & 2 after SQLite reopen
		if (isAtomic) {
			const snapAfterRestart = await host2.inspectMemory(BACKGROUND_CONTEXT, 20);
			if (snapAfterRestart.kind === "atomic") {
				corePersistedAcrossRestart = snapAfterRestart.snapshot.coreItems.some((item) =>
					item.content.toLowerCase().includes("pnpm"),
				);
			}
			const aliasSearch = await host2.searchMemory(
				{ query: "老张", fromDate: "2026-05-01", toDate: "2026-05-31" },
				BACKGROUND_CONTEXT,
			);
			if (aliasSearch.kind === "atomic") {
				aliasDateSearchWithProvenance = aliasSearch.hits.some(
					(h) =>
						(h.item.content.includes("张伟") || h.item.content.includes("支付网关")) &&
						h.item.sourceEntryId !== undefined,
				);
				if (!aliasDateSearchWithProvenance) {
					notes.push(
						`alias/date search miss: hits=${aliasSearch.hits.map((h) => summarizeItem(h.item)).join(" ; ") || "none"}`,
					);
				}
			}
		}

		await host2.sendMessage({ text: "五月老张负责什么？请查一下记忆回答我。" }, BACKGROUND_CONTEXT);

		// Check 3: Forget pnpm core rule
		await host2.sendMessage({ text: "请调用 memory_forget 忘掉那条关于 pnpm 的长期偏好。" }, BACKGROUND_CONTEXT);

		if (isAtomic) {
			const snapAfterForget = await host2.inspectMemory(BACKGROUND_CONTEXT, 20);
			if (snapAfterForget.kind === "atomic") {
				for (const item of snapAfterForget.snapshot.coreItems) {
					coreItemsAfterForget.push(summarizeItem(item));
				}
				const stillHasPnpm = snapAfterForget.snapshot.coreItems.some((item) =>
					item.content.toLowerCase().includes("pnpm"),
				);
				forgetImmediateRetraction = !stillHasPnpm && snapAfterForget.snapshot.totalForgotten >= 1;
				if (!useLive && captured2[3] !== undefined) {
					const eff = effectiveCoreSection(captured2[3]);
					forgetImmediateRetraction =
						forgetImmediateRetraction && eff !== undefined && eff !== null && !eff.includes("pnpm");
				}
				if (!forgetImmediateRetraction) {
					notes.push(
						`forget check failed: stillHasPnpm=${stillHasPnpm}, totalForgotten=${snapAfterForget.snapshot.totalForgotten}`,
					);
				}
			}
		}

		// Check 5, 6, 7: Consolidation (Arm C only)
		if (useConsolidation) {
			const c1 = await host2.consolidateMemory(BACKGROUND_CONTEXT);
			consolidationReport = c1;
			const c2 = await host2.consolidateMemory(BACKGROUND_CONTEXT);
			watermarkIdempotentNoop = c1.status === "ok" && c2.status === "noop";
			if (!watermarkIdempotentNoop) {
				notes.push(`consolidation watermark check failed: c1=${c1.status}, c2=${c2.status}`);
			}
		}

		if (isAtomic) {
			const weeklySearch = await host2.searchMemory({ query: "周报" }, BACKGROUND_CONTEXT);
			implicitFactExtracted =
				weeklySearch.kind === "atomic" &&
				weeklySearch.hits.some((h) => h.item.content.includes("周五") || h.item.content.includes("周报"));

			const gatewaySearch = await host2.searchMemory({ query: "支付网关" }, BACKGROUND_CONTEXT);
			const pudongSearch = await host2.searchMemory({ query: "浦东" }, BACKGROUND_CONTEXT);
			const nanshanSearch = await host2.searchMemory({ query: "南山" }, BACKGROUND_CONTEXT);
			duplicateMergedAndConflictResolved =
				gatewaySearch.kind === "atomic" &&
				gatewaySearch.hits.length === 1 &&
				pudongSearch.kind === "atomic" &&
				pudongSearch.hits.length === 0 &&
				nanshanSearch.kind === "atomic" &&
				nanshanSearch.hits.length >= 1;
			if (useConsolidation && !duplicateMergedAndConflictResolved) {
				notes.push(
					`dedup/conflict mismatch: gatewayHits=${gatewaySearch.kind === "atomic" ? gatewaySearch.hits.length : -1}, pudongHits=${pudongSearch.kind === "atomic" ? pudongSearch.hits.length : -1}, nanshanHits=${nanshanSearch.kind === "atomic" ? nanshanSearch.hits.length : -1}`,
				);
			}

			const finalSnap = await host2.inspectMemory(BACKGROUND_CONTEXT, 30);
			if (finalSnap.kind === "atomic") {
				for (const item of [...finalSnap.snapshot.coreItems, ...finalSnap.snapshot.recentItems]) {
					finalActiveItems.push(summarizeItem(item));
				}
			}
		}

		await host2.close(BACKGROUND_CONTEXT);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}

	const traces = await recorder.listTraces(200);
	const allSpans = traces.flatMap((t) => t.spans);
	const metrics = computeTraceMetrics(allSpans);
	const memorySpanCounts = {
		save: allSpans.filter((s) => s.name === "jehee.memory.save").length,
		search: allSpans.filter((s) => s.name === "jehee.memory.search").length,
		forget: allSpans.filter((s) => s.name === "jehee.memory.forget").length,
		consolidate: allSpans.filter((s) => s.name === "jehee.memory.consolidate").length,
	};

	const checks = {
		corePersistedAcrossRestart,
		aliasDateSearchWithProvenance,
		forgetImmediateRetraction,
		factWritePrefixStability,
		implicitFactExtracted,
		duplicateMergedAndConflictResolved,
		watermarkIdempotentNoop,
	};
	const totalChecks = Object.keys(checks).length;
	const passedCount = Object.values(checks).filter(Boolean).length;
	const rubricScorePct = Math.round((passedCount / totalChecks) * 1000) / 10;

	const label =
		armId === "static-core"
			? "StaticCore (Baseline)"
			: armId === "atomic-memory"
				? "AtomicMemory (Slice 5C-1)"
				: "AtomicMemory + Consolidation (Slice 5C-2)";

	return {
		armId,
		label,
		modelLabel,
		checks,
		rubricScorePct,
		passed: passedCount === totalChecks,
		memorySpanCounts,
		metrics,
		...(consolidationReport !== undefined ? { consolidationReport } : {}),
		diagnostics: {
			coreItemsAfterPhase1,
			coreItemsAfterForget,
			finalActiveItems,
			notes,
		},
	};
}

async function main(): Promise<void> {
	const isLive = process.env.JEHEE_EVAL_LIVE === "1";
	const dotEnv = isLive ? await loadDotEnvFile(join(appDir, ".env")) : undefined;
	const mergedEnv: EnvDictionary | undefined = isLive ? { ...dotEnv, ...process.env } : undefined;

	const results: MemoryEvalResult[] = [
		await runArm("static-core", mergedEnv),
		await runArm("atomic-memory", mergedEnv),
		await runArm("atomic-memory-consolidated", mergedEnv),
	];

	const modelBanner = results[0]?.modelLabel ?? "unknown";
	console.log(
		`\n=== Eval-0002: StaticCore vs AtomicMemory (5C-1) vs Consolidated (5C-2) [${isLive ? `LIVE: ${modelBanner}` : "OFFLINE DETERMINISTIC"}] ===\n`,
	);

	const header = [
		"| Arm | Score | Persist | Alias+Date | Forget | PrefixStable | Implicit | Dedup+Conflict | Idempotent | Prefill | CacheHit(All/2+) | Cost(USD) | Wall(ms) | Spans(s/q/f/c) |",
		"| :--- | ---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | ---: | :---: | ---: | ---: | :---: |",
	];
	const rows = results.map((r) => {
		const c = r.checks;
		const m = r.metrics;
		const s = r.memorySpanCounts;
		const b = (v: boolean) => (v ? "Y" : "N");
		return `| ${r.label} | ${r.rubricScorePct}% | ${b(c.corePersistedAcrossRestart)} | ${b(c.aliasDateSearchWithProvenance)} | ${b(c.forgetImmediateRetraction)} | ${b(c.factWritePrefixStability)} | ${b(c.implicitFactExtracted)} | ${b(c.duplicateMergedAndConflictResolved)} | ${b(c.watermarkIdempotentNoop)} | ${m.prefillTokens} | ${pct(m.cacheHitRate)} / ${pct(m.postWarmupCacheHitRate)} | $${m.costUsd.toFixed(5)} | ${m.wallTimeMs.toFixed(0)} | ${s.save}/${s.search}/${s.forget}/${s.consolidate} |`;
	});
	console.log([...header, ...rows].join("\n"));

	if (isLive) {
		for (const r of results) {
			if (r.armId === "static-core") continue;
			console.log(`\n--- Diagnostics: ${r.label} ---`);
			console.log("Final active items:", r.diagnostics.finalActiveItems);
			if (r.consolidationReport !== undefined) {
				console.log("Consolidation report:", JSON.stringify(r.consolidationReport));
			}
			if (r.diagnostics.notes.length > 0) {
				console.log("Notes:", r.diagnostics.notes);
			}
		}
	}

	const artifactsDir = join(appDir, ".artifacts", "evals");
	await mkdir(artifactsDir, { recursive: true });
	const outFile = isLive ? "latest-memory-eval-live.json" : "latest-memory-eval.json";
	const outPath = join(artifactsDir, outFile);
	await writeFile(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), isLive, results }, null, 2)}\n`, "utf8");
	console.log(`\nSaved report to ${outPath}`);

	const consolidatedResult = results.find((r) => r.armId === "atomic-memory-consolidated");
	if (!isLive && (consolidatedResult === undefined || !consolidatedResult.passed)) {
		process.exitCode = 1;
	}
}

await main();
