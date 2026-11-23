// Cucumber step definitions verifying Slice 5C-3 Portable Context & Memory Snapshot:
// cross-host & cross-model lossless migration with tombstone restore, idempotent merge import with ID collision safety,
// and Markdown export + Telegram `/memory export` owner allowlist protection.

import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ChannelGateway, type IngestResult } from "../../src/channels/gateway.ts";
import { JeheeHost } from "../../src/core/host.ts";
import { AtomicMemoryProvider } from "../../src/memory/atomic-memory.ts";
import {
	buildPortableSnapshot,
	type ImportSnapshotResult,
	parsePortableSnapshotJson,
	serializePortableSnapshotJson,
} from "../../src/memory/portable-snapshot.ts";
import type { JeheeWorld } from "../support/world.ts";

let snapHostA: JeheeHost | undefined;
let snapHostB: JeheeHost | undefined;
let snapFauxMulti: ReturnType<typeof fauxProvider> | undefined;
let snapModelsMulti: ReturnType<typeof createModels> | undefined;
let snapCapturedBeta: TranscriptContext[] = [];
let snapMergeFirst: ImportSnapshotResult | undefined;
let snapMergeSecond: ImportSnapshotResult | undefined;
let snapTgReplies: string[] = [];
let snapUnauthResult: IngestResult | undefined;

async function closeExtraSnapHosts(world: JeheeWorld): Promise<void> {
	if (snapHostA !== undefined) {
		await snapHostA.close(world.ctx);
		snapHostA = undefined;
	}
	if (snapHostB !== undefined) {
		await snapHostB.close(world.ctx);
		snapHostB = undefined;
	}
}

Given(
	"已在宿主 A 上存入核心偏好 {string}、一条已遗忘旧事实 {string} 并完成 1 轮项目对话",
	async function (this: JeheeWorld, corePref: string, forgottenFact: string) {
		await closeExtraSnapHosts(this);
		snapCapturedBeta = [];
		snapFauxMulti = fauxProvider({
			models: [
				{ id: "model-alpha", name: "Model Alpha" },
				{ id: "model-beta", name: "Model Beta" },
			],
		});
		snapModelsMulti = createModels();
		snapModelsMulti.setProvider(snapFauxMulti.provider);

		snapHostA = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: snapModelsMulti,
				defaultModel: { provider: "faux", modelId: "model-alpha" },
				memory: new AtomicMemoryProvider(),
			},
			this.ctx,
		);
		await snapHostA.saveMemory({ kind: "core", content: corePref, keywords: ["pnpm"] }, this.ctx);
		await snapHostA.saveMemory({ kind: "fact", content: forgottenFact, keywords: ["staging"] }, this.ctx);
		await snapHostA.forgetMemory("mem_0002", this.ctx, "retired");

		snapFauxMulti.setResponses([fauxAssistantMessage("明白，Apollo 项目目标已记录。")]);
		const reply = await snapHostA.sendMessage({ text: "我们在推进 Apollo 迁移计划" }, this.ctx);
		assert.equal(reply.status, "done");
	},
);

When(
	"从宿主 A 导出可移植 JSON 快照并以 replace 模式导入挂载新模型 {string} 的全新宿主 B",
	async function (this: JeheeWorld, newModelId: string) {
		const rawJson = serializePortableSnapshotJson(await snapHostA!.exportPortableSnapshot(this.ctx));
		const parsed = parsePortableSnapshotJson(rawJson);
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;

		snapHostB = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: snapModelsMulti!,
				defaultModel: { provider: "faux", modelId: newModelId },
				memory: new AtomicMemoryProvider(),
			},
			this.ctx,
		);
		const imported = await snapHostB.importPortableSnapshot(parsed.snapshot, this.ctx, { mode: "replace" });
		assert.equal(imported.ok, true);
		if (imported.ok) {
			assert.equal(imported.memoriesImported, 2);
			assert.equal(imported.contextTurnsImported, 2);
		}
	},
);

Then(
	"宿主 B 的后续对话请求自动携带 L1 Core 偏好与迁移前的历史对话，且可通过 restoreMemory 恢复 {string}",
	async function (this: JeheeWorld, tombstoneId: string) {
		try {
			snapFauxMulti!.setResponses([
				(ctx) => {
					snapCapturedBeta.push(ctx);
					return fauxAssistantMessage("继续按 pnpm 推进 Apollo 迁移。");
				},
			]);
			const reply = await snapHostB!.sendMessage({ text: "回顾一下我们刚聊的项目" }, this.ctx);
			assert.equal(reply.status, "done");
			const payload = JSON.stringify(snapCapturedBeta[0]?.messages ?? []);
			assert.ok(payload.includes("统一使用 pnpm"));
			assert.ok(payload.includes("我们在推进 Apollo 迁移计划"));

			const restored = await snapHostB!.restoreMemory(tombstoneId, this.ctx);
			assert.equal(restored.ok, true);
			const search = await snapHostB!.searchMemory({ query: "staging-01" }, this.ctx);
			assert.equal(search.kind, "atomic");
			if (search.kind === "atomic") {
				assert.equal(search.hits.length, 1);
			}
		} finally {
			await closeExtraSnapHosts(this);
		}
	},
);

Given("宿主 B 已有本地记忆 mem_0001 {string}", async function (this: JeheeWorld, localFact: string) {
	this.host = await this.openHost("memory", new AtomicMemoryProvider());
	const saved = await this.host.saveMemory({ kind: "fact", content: localFact, keywords: ["本地"] }, this.ctx);
	assert.equal(saved.ok, true);
});

When(
	"将包含 mem_0001 {string} 与重复内容 {string} 的快照以 merge 模式连续导入宿主 B 两次",
	async function (this: JeheeWorld, externalFact: string, duplicateFact: string) {
		const snap = buildPortableSnapshot({
			exportedAtMs: 5_000,
			memoryProviderId: "atomic-memory",
			memoryState: {
				seq: 2,
				items: {
					mem_0001: {
						id: "mem_0001",
						kind: "fact",
						content: externalFact,
						keywords: ["规范"],
						aliases: [],
						status: "active",
						createdAtMs: 1_000,
						updatedAtMs: 1_000,
					},
					mem_0002: {
						id: "mem_0002",
						kind: "fact",
						content: duplicateFact,
						keywords: ["本地"],
						aliases: [],
						status: "active",
						createdAtMs: 2_000,
						updatedAtMs: 2_000,
					},
				},
			},
			scope: "active",
			turns: [],
		});
		snapMergeFirst = await this.host!.importPortableSnapshot(snap, this.ctx, { mode: "merge" });
		snapMergeSecond = await this.host!.importPortableSnapshot(snap, this.ctx, { mode: "merge" });
	},
);

Then(
	"本地 mem_0001 保持原内容不被覆盖，{string} 自动分配新 ID，且二次导入全部按重复跳过",
	async function (this: JeheeWorld, externalFact: string) {
		assert.equal(snapMergeFirst?.ok, true);
		if (snapMergeFirst?.ok) {
			assert.equal(snapMergeFirst.memoriesImported, 1);
			assert.equal(snapMergeFirst.memoriesSkippedDuplicates, 1);
			assert.equal(snapMergeFirst.memoriesReassignedIds, 1);
		}
		assert.equal(snapMergeSecond?.ok, true);
		if (snapMergeSecond?.ok) {
			assert.equal(snapMergeSecond.memoriesImported, 0);
			assert.equal(snapMergeSecond.memoriesSkippedDuplicates, 2);
		}
		const hits = await this.host!.searchMemory({ query: externalFact }, this.ctx);
		assert.equal(hits.kind, "atomic");
		if (hits.kind === "atomic") {
			assert.equal(hits.hits.length, 1);
			assert.equal(hits.hits[0]!.item.id, "mem_0002");
		}
		const localHits = await this.host!.searchMemory({ query: "本地独有备注" }, this.ctx);
		assert.equal(localHits.kind, "atomic");
		if (localHits.kind === "atomic") {
			assert.equal(localHits.hits.length, 1);
			assert.equal(localHits.hits[0]!.item.id, "mem_0001");
		}
	},
);

Given(
	"已启动挂载原子记忆的宿主与 Telegram 渠道网关（快照授权主人 {string}）",
	async function (this: JeheeWorld, ownerId: string) {
		snapTgReplies = [];
		snapUnauthResult = undefined;
		this.host = await this.openHost("memory", new AtomicMemoryProvider());
		await this.host.saveMemory({ kind: "core", content: "输出保持简洁技术风格", keywords: ["风格"] }, this.ctx);
		this.installScriptedSteps([fauxAssistantMessage("已收到，准备导出测试。")]);
		await this.host.sendMessage({ text: "记录一条测试对话" }, this.ctx);

		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [ownerId] },
		});
		this.gateway.registerTransport({
			channel: "telegram",
			sendText: async (_chatId, text) => {
				snapTgReplies.push(text);
			},
		});
	},
);

When("陌生人 {string} 发送 {string}", async function (this: JeheeWorld, strangerId: string, cmd: string) {
	snapUnauthResult = await this.gateway!.ingest(
		{
			channel: "telegram",
			chatId: "chat-snap",
			senderId: strangerId,
			messageId: "snap-u1",
			text: cmd,
			timestampMs: 1_000,
		},
		this.ctx,
	);
});

Then("陌生人导出请求返回 unauthorized 且不泄露任何快照内容", () => {
	assert.deepEqual(snapUnauthResult, { kind: "unauthorized" });
	assert.equal(snapTgReplies.length, 0);
});

When("主人 {string} 发送 {string}", async function (this: JeheeWorld, ownerId: string, cmd: string) {
	const res = await this.gateway!.ingest(
		{
			channel: "telegram",
			chatId: "chat-snap",
			senderId: ownerId,
			messageId: "snap-o1",
			text: cmd,
			timestampMs: 2_000,
		},
		this.ctx,
	);
	assert.deepEqual(res, { kind: "command_handled", command: "memory" });
});

Then("渠道返回包含 L1 Core 与对话记录的可读 Markdown 快照", () => {
	const md = snapTgReplies.at(-1) ?? "";
	assert.ok(md.includes("# Jehee Portable Context & Memory Snapshot"), `Unexpected reply:\n${md}`);
	assert.ok(md.includes("## L1 Core Memory"));
	assert.ok(md.includes("输出保持简洁技术风格"));
	assert.ok(md.includes("记录一条测试对话"));
});
