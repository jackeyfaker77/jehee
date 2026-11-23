// Unit and end-to-end tests for Slice 5C-3 Portable Context & Memory Snapshot (JSON/Markdown export, strict validation,
// merge/replace atomic import, cross-host & cross-model continuity, busy protection, telemetry spans, and CLI round-trip).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { JeheeHost } from "../src/core/host.ts";
import { AtomicMemoryProvider, createEmptyMemoryStoreState } from "../src/memory/atomic-memory.ts";
import {
	applyPortableMemoryImport,
	buildPortableSnapshot,
	formatImportSnapshotReply,
	PORTABLE_SNAPSHOT_SCHEMA,
	PORTABLE_SNAPSHOT_VERSION,
	parsePortableSnapshotJson,
	renderPortableSnapshotMarkdown,
	serializePortableSnapshotJson,
} from "../src/memory/portable-snapshot.ts";
import { StaticCoreMemoryProvider } from "../src/memory/static-core.ts";
import { openNodeJeheeHost } from "../src/runtime/node.ts";
import { JeheeTraceRecorder } from "../src/telemetry/recorder.ts";

const execFileAsync = promisify(execFile);
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("portable-snapshot pure parser, renderer, and memory applier", () => {
	it("round-trips valid snapshots and rejects malformed or unsupported JSON", () => {
		const state = createEmptyMemoryStoreState();
		state.seq = 2;
		state.items.mem_0001 = {
			id: "mem_0001",
			kind: "core",
			content: "Reply in concise technical Chinese",
			keywords: ["language", "style"],
			aliases: ["中文"],
			status: "active",
			createdAtMs: 1_000,
			updatedAtMs: 1_000,
		};
		state.items.mem_0002 = {
			id: "mem_0002",
			kind: "fact",
			content: "Old office in Shanghai",
			keywords: ["office"],
			aliases: [],
			status: "forgotten",
			createdAtMs: 2_000,
			updatedAtMs: 3_000,
			forgottenAtMs: 3_000,
			forgetReason: "moved",
		};

		const snap = buildPortableSnapshot({
			exportedAtMs: 10_000,
			memoryProviderId: "atomic-memory",
			defaultModel: { provider: "faux", modelId: "model-a" },
			conversationId: "1",
			seedCorePrompt: "Seed persona",
			corePrompt: "Seed persona\n\n- [mem_0001] Reply in concise technical Chinese",
			memoryState: state,
			scope: "active",
			turns: [
				{ id: "1", role: "user", text: "Hello", timestampMs: 1_000 },
				{
					id: "2",
					role: "assistant",
					text: "Hi there",
					timestampMs: 1_100,
					model: { provider: "faux", modelId: "model-a" },
				},
			],
		});

		const json = serializePortableSnapshotJson(snap);
		const parsed = parsePortableSnapshotJson(json);
		assert.equal(parsed.ok, true);
		if (parsed.ok) {
			assert.equal(parsed.snapshot.schema, PORTABLE_SNAPSHOT_SCHEMA);
			assert.equal(parsed.snapshot.version, PORTABLE_SNAPSHOT_VERSION);
			assert.equal(parsed.snapshot.memory.items.length, 2);
			assert.equal(parsed.snapshot.memory.items[1]!.status, "forgotten");
			assert.equal(parsed.snapshot.memory.items[1]!.forgetReason, "moved");
			assert.equal(parsed.snapshot.context.turns.length, 2);
		}

		assert.equal(parsePortableSnapshotJson("").ok, false);
		assert.equal(parsePortableSnapshotJson("{bad").ok, false);
		assert.equal(parsePortableSnapshotJson(JSON.stringify({ schema: "other", version: 1 })).ok, false);
		assert.equal(
			parsePortableSnapshotJson(JSON.stringify({ schema: PORTABLE_SNAPSHOT_SCHEMA, version: 99 })).ok,
			false,
		);
		assert.equal(
			parsePortableSnapshotJson(
				JSON.stringify({
					schema: PORTABLE_SNAPSHOT_SCHEMA,
					version: 1,
					exportedAt: "2026-11-24T00:00:00.000Z",
					memory: { items: [{ id: "mem_1", kind: "invalid", content: "x", createdAtMs: 1 }] },
					context: { scope: "active", turns: [] },
				}),
			).ok,
			false,
		);
		assert.equal(
			parsePortableSnapshotJson(
				JSON.stringify({
					schema: PORTABLE_SNAPSHOT_SCHEMA,
					version: 1,
					exportedAt: "2026-11-24T00:00:00.000Z",
					memory: { items: [] },
					context: { scope: "active", turns: [{ id: "1", role: "tool", text: "nope" }] },
				}),
			).ok,
			false,
		);
	});

	it("renders human- and external-agent-readable Markdown with core, atomic, tombstones, and turns", () => {
		const state = createEmptyMemoryStoreState();
		state.seq = 3;
		state.items.mem_0001 = {
			id: "mem_0001",
			kind: "core",
			content: "Use pnpm everywhere",
			keywords: ["pnpm"],
			aliases: [],
			status: "active",
			createdAtMs: 1_000,
			updatedAtMs: 1_000,
		};
		state.items.mem_0002 = {
			id: "mem_0002",
			kind: "fact",
			content: "Project Phoenix launches 2026-12-01",
			keywords: ["phoenix"],
			aliases: ["PX"],
			validFrom: "2026-12-01",
			sourceEntryId: "12",
			status: "active",
			createdAtMs: 2_000,
			updatedAtMs: 2_000,
		};
		state.items.mem_0003 = {
			id: "mem_0003",
			kind: "fact",
			content: "Legacy fact",
			keywords: [],
			aliases: [],
			status: "forgotten",
			createdAtMs: 3_000,
			updatedAtMs: 4_000,
			forgottenAtMs: 4_000,
			forgetReason: "superseded",
		};

		const snap = buildPortableSnapshot({
			exportedAtMs: 10_000,
			memoryProviderId: "atomic-memory",
			defaultModel: { provider: "opencode-go", modelId: "deepseek-v4.1-flash" },
			seedCorePrompt: "Personal colleague",
			memoryState: state,
			scope: "active",
			turns: [
				{ id: "10", role: "user", text: "When does PX launch?", timestampMs: 5_000 },
				{
					id: "11",
					role: "assistant",
					text: "2026-12-01.",
					timestampMs: 5_500,
					model: { provider: "opencode-go", modelId: "deepseek-v4.1-flash" },
				},
			],
		});

		const md = renderPortableSnapshotMarkdown(snap);
		assert.ok(md.includes("# Jehee Portable Context & Memory Snapshot"));
		assert.ok(md.includes("## L1 Core Memory"));
		assert.ok(md.includes("- [seed] Personal colleague"));
		assert.ok(md.includes("- [mem_0001] Use pnpm everywhere"));
		assert.ok(md.includes("## Atomic Memories"));
		assert.ok(md.includes("aliases: PX"));
		assert.ok(md.includes("## Forgotten Memories (Tombstones)"));
		assert.ok(md.includes("reason: superseded"));
		assert.ok(md.includes("## Conversation Context (active)"));
		assert.ok(md.includes("### USER (#10"));
		assert.ok(md.includes("When does PX launch?"));
	});

	it("applies merge with deduplication, collision-safe ID reassignment, core limit guardrail, and replace mode", () => {
		const local = createEmptyMemoryStoreState();
		local.seq = 1;
		local.items.mem_0001 = {
			id: "mem_0001",
			kind: "fact",
			content: "Local existing fact",
			keywords: ["local"],
			aliases: [],
			status: "active",
			createdAtMs: 1_000,
			updatedAtMs: 1_000,
		};

		const incoming = [
			// Duplicate content with different casing/spacing -> skipped
			{
				id: "mem_0099",
				kind: "fact" as const,
				content: "  local   existing fact ",
				keywords: [],
				aliases: [],
				status: "active" as const,
				createdAtMs: 1_500,
				updatedAtMs: 1_500,
			},
			// Collides with local mem_0001 ID but has different content -> reassigned to mem_0002
			{
				id: "mem_0001",
				kind: "fact" as const,
				content: "Imported fact colliding on id",
				keywords: ["imported"],
				aliases: [],
				status: "active" as const,
				createdAtMs: 2_000,
				updatedAtMs: 2_000,
			},
			// Core item exceeding tight maxCoreChars -> skipped
			{
				id: "mem_0005",
				kind: "core" as const,
				content: "X".repeat(120),
				keywords: [],
				aliases: [],
				status: "active" as const,
				createdAtMs: 2_500,
				updatedAtMs: 2_500,
			},
		];

		const mergeOutcome = applyPortableMemoryImport(local, incoming, { mode: "merge", maxCoreChars: 80 });
		assert.equal(mergeOutcome.imported, 1);
		assert.equal(mergeOutcome.skippedDuplicates, 1);
		assert.equal(mergeOutcome.reassignedIds, 1);
		assert.equal(mergeOutcome.skippedCoreLimit, 1);
		assert.equal(local.items.mem_0001!.content, "Local existing fact");
		assert.equal(local.items.mem_0002!.content, "Imported fact colliding on id");

		// Re-running merge with the same incoming records is idempotent
		const secondMerge = applyPortableMemoryImport(local, incoming, { mode: "merge", maxCoreChars: 80 });
		assert.equal(secondMerge.imported, 0);
		assert.equal(secondMerge.skippedDuplicates, 2);

		// Replace mode wipes local state and preserves incoming IDs cleanly
		const replaceOutcome = applyPortableMemoryImport(local, incoming.slice(1, 2), { mode: "replace" });
		assert.equal(replaceOutcome.imported, 1);
		assert.deepEqual(Object.keys(local.items), ["mem_0001"]);
		assert.equal(local.items.mem_0001!.content, "Imported fact colliding on id");
	});
});

describe("JeheeHost portable export/import end-to-end", () => {
	it("migrates atomic memories, tombstones, and dialogue across hosts and continues cleanly on a different model", async () => {
		const fauxA = fauxProvider({
			models: [
				{ id: "model-alpha", name: "Model Alpha" },
				{ id: "model-beta", name: "Model Beta" },
			],
		});
		const models = createModels();
		models.setProvider(fauxA.provider);

		const recorder = new JeheeTraceRecorder();
		const hostA = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: "model-alpha" },
				memory: new AtomicMemoryProvider({ seedCorePrompt: "Be crisp" }),
				telemetry: recorder.telemetry,
			},
			BACKGROUND_CONTEXT,
		);

		try {
			await hostA.saveMemory(
				{ kind: "core", content: "Prefer pnpm over npm", keywords: ["pnpm"] },
				BACKGROUND_CONTEXT,
			);
			await hostA.saveMemory(
				{ kind: "fact", content: "Old staging server is box-1", keywords: ["staging"] },
				BACKGROUND_CONTEXT,
			);
			await hostA.forgetMemory("mem_0002", BACKGROUND_CONTEXT, "decommissioned");

			fauxA.setResponses([fauxAssistantMessage("Noted! We are planning the Q4 launch together.")]);
			const r1 = await hostA.sendMessage({ text: "We are planning the Q4 launch." }, BACKGROUND_CONTEXT);
			assert.equal(r1.status, "done");

			const exported = await hostA.exportPortableSnapshot(BACKGROUND_CONTEXT);
			assert.equal(exported.memory.items.length, 2);
			assert.equal(exported.context.turns.length, 2);
			assert.equal(exported.context.turns[1]!.model?.modelId, "model-alpha");

			// Export with includeForgotten: false omits tombstones
			const activeOnly = await hostA.exportPortableSnapshot(BACKGROUND_CONTEXT, {
				includeForgotten: false,
				maxTurns: 1,
			});
			assert.equal(activeOnly.memory.items.length, 1);
			assert.equal(activeOnly.context.turns.length, 1);
			assert.equal(activeOnly.context.turns[0]!.role, "assistant");

			const serialized = serializePortableSnapshotJson(exported);
			const parsed = parsePortableSnapshotJson(serialized);
			assert.equal(parsed.ok, true);
			if (!parsed.ok) return;

			// Open completely independent Host B using a DIFFERENT model (`model-beta`)
			const capturedByBeta: TranscriptContext[] = [];
			const hostB = await JeheeHost.open(
				{
					storage: { kind: "memory" },
					models,
					defaultModel: { provider: "faux", modelId: "model-beta" },
					memory: new AtomicMemoryProvider({ seedCorePrompt: "Be crisp" }),
					telemetry: recorder.telemetry,
				},
				BACKGROUND_CONTEXT,
			);

			try {
				const imported = await hostB.importPortableSnapshot(parsed.snapshot, BACKGROUND_CONTEXT, {
					mode: "replace",
				});
				assert.equal(imported.ok, true);
				if (imported.ok) {
					assert.equal(imported.memoriesImported, 2);
					assert.equal(imported.contextTurnsImported, 2);
					assert.ok(formatImportSnapshotReply(imported).includes("mode=replace"));
				}

				// Tombstone survived cross-host migration and can be restored on Host B
				const restored = await hostB.restoreMemory("mem_0002", BACKGROUND_CONTEXT);
				assert.equal(restored.ok, true);
				const hits = await hostB.searchMemory({ query: "box-1" }, BACKGROUND_CONTEXT);
				assert.equal(hits.kind, "atomic");
				if (hits.kind === "atomic") {
					assert.equal(hits.hits.length, 1);
				}

				// Continue conversation on Host B with model-beta and verify both L1 Core & imported turns reach the model
				fauxA.setResponses([
					(ctx) => {
						capturedByBeta.push(ctx);
						return fauxAssistantMessage("Continuing Q4 launch with pnpm!");
					},
				]);
				const r2 = await hostB.sendMessage({ text: "What are we planning?" }, BACKGROUND_CONTEXT);
				assert.equal(r2.status, "done");

				assert.equal(capturedByBeta.length, 1);
				const reqMessages = capturedByBeta[0]!.messages;
				const serializedReq = JSON.stringify(reqMessages);
				assert.ok(serializedReq.includes("Prefer pnpm over npm"), "L1 Core memory must be injected on Host B");
				assert.ok(
					serializedReq.includes("We are planning the Q4 launch."),
					"Imported user turn must reach Model Beta",
				);
				assert.ok(
					serializedReq.includes("Noted! We are planning the Q4 launch together."),
					"Imported assistant turn must reach Model Beta",
				);

				// Verify active vs full transcript scope after a second replace reset
				const emptyResetSnap = buildPortableSnapshot({
					exportedAtMs: 20_000,
					memoryProviderId: "atomic-memory",
					scope: "active",
					turns: [{ id: "s1", role: "summary", text: "Handoff summary: Q4 launch ready", timestampMs: 19_000 }],
				});
				const resetRes = await hostB.importPortableSnapshot(emptyResetSnap, BACKGROUND_CONTEXT, {
					mode: "replace",
					includeMemory: false,
					includeContext: true,
				});
				assert.equal(resetRes.ok, true);
				if (resetRes.ok) {
					assert.equal(resetRes.contextResetApplied, true);
				}

				const activeAfterReset = await hostB.exportPortableSnapshot(BACKGROUND_CONTEXT, {
					transcriptScope: "active",
				});
				assert.equal(activeAfterReset.context.turns.length, 1);
				assert.equal(activeAfterReset.context.turns[0]!.role, "summary");

				const fullAfterReset = await hostB.exportPortableSnapshot(BACKGROUND_CONTEXT, { transcriptScope: "full" });
				assert.ok(fullAfterReset.context.turns.length >= 4);

				// Telemetry spans emitted for both export and import
				const traces = await recorder.listTraces(100);
				const spanNames = traces.flatMap((trace) => trace.spans.map((s) => s.name));
				assert.ok(spanNames.includes("jehee.memory.export"));
				assert.ok(spanNames.includes("jehee.memory.import"));
			} finally {
				await hostB.close(BACKGROUND_CONTEXT);
			}
		} finally {
			await hostA.close(BACKGROUND_CONTEXT);
		}
	});

	it("rejects context import while root conversation is busy and degrades cleanly on StaticCoreMemoryProvider", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		let releaseTool!: () => void;
		let signalEntered!: () => void;
		const entered = new Promise<void>((res) => {
			signalEntered = res;
		});
		const slowExt = defineExtension({
			name: "test.slow-import-guard",
			tools: [
				defineTool({
					name: "slow_wait",
					description: "Blocks until released.",
					parameters: obj({}),
					execute: async () => {
						signalEntered();
						await new Promise<void>((res) => {
							releaseTool = res;
						});
						return { output: [{ type: "text", text: "done" }] };
					},
				}),
			],
		});

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				memory: new StaticCoreMemoryProvider({ corePrompt: "Static persona" }),
				extensions: [slowExt],
			},
			BACKGROUND_CONTEXT,
		);

		const snap = buildPortableSnapshot({
			exportedAtMs: 1_000,
			memoryProviderId: "atomic-memory",
			memoryState: {
				seq: 1,
				items: {
					mem_0001: {
						id: "mem_0001",
						kind: "fact",
						content: "Atomic fact",
						keywords: [],
						aliases: [],
						status: "active",
						createdAtMs: 500,
						updatedAtMs: 500,
					},
				},
			},
			scope: "active",
			turns: [{ id: "1", role: "user", text: "Imported hello", timestampMs: 900 }],
		});

		try {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("slow_wait", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("All done."),
			]);
			const pending = await host.submitMessage({ text: "Run slow tool" }, BACKGROUND_CONTEXT);
			await entered;

			const busyResult = await host.importPortableSnapshot(snap, BACKGROUND_CONTEXT, { mode: "merge" });
			assert.equal(busyResult.ok, false);
			if (!busyResult.ok) {
				assert.equal(busyResult.reason, "host_busy");
			}

			releaseTool();
			await pending.wait(BACKGROUND_CONTEXT);

			// Now idle: static provider skips atomic memories gracefully while importing context turns
			const staticResult = await host.importPortableSnapshot(snap, BACKGROUND_CONTEXT, { mode: "merge" });
			assert.equal(staticResult.ok, true);
			if (staticResult.ok) {
				assert.equal(staticResult.memoryUnsupported, true);
				assert.equal(staticResult.memoriesSkipped, 1);
				assert.equal(staticResult.contextTurnsImported, 1);
			}
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}
	});

	it("exports and imports real SQLite snapshots via bin.ts CLI subcommands", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "jehee-portable-cli-"));
		const dbA = join(workDir, "a.sqlite");
		const dbB = join(workDir, "b.sqlite");
		const jsonFile = join(workDir, "backup.json");
		const mdFile = join(workDir, "backup.md");

		try {
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			const hostA = await openNodeJeheeHost(
				{
					sqlitePath: dbA,
					models,
					defaultModel: { provider: "faux", modelId: faux.getModel().id },
					memory: new AtomicMemoryProvider(),
				},
				BACKGROUND_CONTEXT,
			);
			await hostA.saveMemory({ kind: "core", content: "CLI exported rule", keywords: ["cli"] }, BACKGROUND_CONTEXT);
			faux.setResponses([fauxAssistantMessage("CLI dialogue reply")]);
			await hostA.sendMessage({ text: "CLI dialogue question" }, BACKGROUND_CONTEXT);
			await hostA.close(BACKGROUND_CONTEXT);

			const cliBase = ["--conditions=source", "--disable-warning=ExperimentalWarning", join(appDir, "bin.ts")];

			// Export JSON and Markdown from dbA offline (without requiring MCP servers)
			const expJson = await execFileAsync(process.execPath, [...cliBase, "export", jsonFile, "--db", dbA], {
				cwd: appDir,
			});
			assert.ok(expJson.stdout.includes("memories=1, turns=2"));

			const expMd = await execFileAsync(process.execPath, [...cliBase, "export", mdFile, "--db", dbA], {
				cwd: appDir,
			});
			assert.ok(expMd.stdout.includes("(md,"));
			const mdText = await readFile(mdFile, "utf8");
			assert.ok(mdText.includes("CLI exported rule"));
			assert.ok(mdText.includes("CLI dialogue question"));

			// Import JSON into fresh dbB offline
			const impRes = await execFileAsync(
				process.execPath,
				[...cliBase, "import", jsonFile, "--mode", "replace", "--db", dbB],
				{
					cwd: appDir,
				},
			);
			assert.ok(impRes.stdout.includes("+1 imported"));
			assert.ok(impRes.stdout.includes("+2 turn(s)"));

			// Verify dbB contents via JeheeHost
			const hostB = await openNodeJeheeHost(
				{
					sqlitePath: dbB,
					models,
					defaultModel: { provider: "faux", modelId: faux.getModel().id },
					memory: new AtomicMemoryProvider(),
				},
				BACKGROUND_CONTEXT,
			);
			try {
				const inspected = await hostB.inspectMemory(BACKGROUND_CONTEXT);
				assert.equal(inspected.kind, "atomic");
				if (inspected.kind === "atomic") {
					assert.equal(inspected.snapshot.totalActive, 1);
					assert.equal(inspected.snapshot.coreItems[0]!.content, "CLI exported rule");
				}
				const history = await hostB.getVisibleHistory(BACKGROUND_CONTEXT);
				assert.equal(history.length, 2);
				assert.equal(history[0]!.text, "CLI dialogue question");
				assert.equal(history[1]!.text, "CLI dialogue reply");
			} finally {
				await hostB.close(BACKGROUND_CONTEXT);
			}
		} finally {
			await rm(workDir, { recursive: true, force: true });
		}
	});
});
