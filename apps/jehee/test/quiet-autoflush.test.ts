// Unit and durable integration tests for Slice 6C (ADR-0016):
// - Pure `computeNextQuietEndMs` across overnight, daytime, negative, and half-hour UTC offsets;
// - `HeldNotificationsDoc` FIFO cap/eviction (50) and detached-clone safety outside `pi-durable` tx overlays;
// - `RuntimeModelDoc` persistence and `/model` + `/mcp` reply formatters;
// - Single-flight `RoutineSchedulerTask` automatic quiet-hours flush via `syncRoutineSchedulerInTx` / `RoutineWakeSignal`
//   with `wake().active === false` sleeping alarm behavior and transient delivery error isolation.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import {
	appendHeldNotificationInState,
	createEmptyHeldNotificationsState,
	drainHeldNotificationsInState,
	formatMcpStatusReply,
	formatModelListReply,
	formatModelStatusReply,
	HeldNotificationsDoc,
	listHeldNotificationsFromState,
	MAX_HELD_NOTIFICATIONS,
	parseModelRefSpec,
	RuntimeModelDoc,
	readRuntimeModelOverride,
} from "../src/governance/durable-store.ts";
import {
	computeNextQuietEndMs,
	formatHeldNotificationBatches,
	type HeldProactiveMessage,
	isWithinQuietHours,
	ProactiveNotificationGovernor,
	parseQuietHoursWindow,
} from "../src/governance/quiet-gate.ts";
import type { DirectNotifyEvent } from "../src/routines/contract.ts";
import { RoutineDoc } from "../src/routines/durable-store.ts";
import {
	createRoutineSchedulerTask,
	createRoutineSchedulerTracker,
	createRoutinesExtension,
	syncRoutineSchedulerInTx,
} from "../src/routines/extension.ts";
import { createRoutineInState } from "../src/routines/scheduler.ts";

async function waitForCondition(predicate: () => boolean, timeoutMs: number = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

describe("computeNextQuietEndMs and composable ProactiveNotificationGovernor", () => {
	it("computes exact overnight quiet-window end for 23:00-08:00 (+08:00) across all boundary times", () => {
		const overnight = parseQuietHoursWindow("23:00-08:00", "+08:00");
		const nextMorning0800 = Date.parse("2026-11-19T00:00:00.000Z"); // 2026-11-19 08:00:00+08:00
		const followingMorning0800 = Date.parse("2026-11-20T00:00:00.000Z"); // 2026-11-20 08:00:00+08:00

		// 23:30+08:00 on Nov 18 (inside overnight window) -> Nov 19 08:00+08:00
		const at2330 = Date.parse("2026-11-18T15:30:00.000Z");
		assert.equal(isWithinQuietHours(at2330, overnight), true);
		assert.equal(computeNextQuietEndMs(overnight, at2330), nextMorning0800);

		// 02:15+08:00 on Nov 19 (inside overnight window after midnight) -> Nov 19 08:00+08:00
		const at0215 = Date.parse("2026-11-18T18:15:00.000Z");
		assert.equal(isWithinQuietHours(at0215, overnight), true);
		assert.equal(computeNextQuietEndMs(overnight, at0215), nextMorning0800);

		// 07:59+08:00 on Nov 19 (1 minute before window end) -> Nov 19 08:00+08:00
		const at0759 = Date.parse("2026-11-18T23:59:00.000Z");
		assert.equal(isWithinQuietHours(at0759, overnight), true);
		assert.equal(computeNextQuietEndMs(overnight, at0759), nextMorning0800);

		// 08:00:00.000+08:00 on Nov 19 (exact exclusive end) -> next upcoming end is Nov 20 08:00+08:00
		assert.equal(isWithinQuietHours(nextMorning0800, overnight), false);
		assert.equal(computeNextQuietEndMs(overnight, nextMorning0800), followingMorning0800);

		// 14:00+08:00 on Nov 19 (midday outside window) -> next upcoming end is Nov 20 08:00+08:00
		const at1400 = Date.parse("2026-11-19T06:00:00.000Z");
		assert.equal(isWithinQuietHours(at1400, overnight), false);
		assert.equal(computeNextQuietEndMs(overnight, at1400), followingMorning0800);
	});

	it("computes exact daytime quiet-window end for 13:00-14:00 (+08:00)", () => {
		const daytime = parseQuietHoursWindow("13:00-14:00", "+08:00");
		const today1400 = Date.parse("2026-11-18T06:00:00.000Z"); // 2026-11-18 14:00+08:00
		const tomorrow1400 = Date.parse("2026-11-19T06:00:00.000Z"); // 2026-11-19 14:00+08:00

		// 10:00+08:00 (before daytime window) -> today 14:00+08:00
		const at1000 = Date.parse("2026-11-18T02:00:00.000Z");
		assert.equal(isWithinQuietHours(at1000, daytime), false);
		assert.equal(computeNextQuietEndMs(daytime, at1000), today1400);

		// 13:30+08:00 (inside daytime window) -> today 14:00+08:00
		const at1330 = Date.parse("2026-11-18T05:30:00.000Z");
		assert.equal(isWithinQuietHours(at1330, daytime), true);
		assert.equal(computeNextQuietEndMs(daytime, at1330), today1400);

		// 14:00+08:00 (exact exclusive end) -> tomorrow 14:00+08:00
		assert.equal(isWithinQuietHours(today1400, daytime), false);
		assert.equal(computeNextQuietEndMs(daytime, today1400), tomorrow1400);

		// 16:00+08:00 (after window) -> tomorrow 14:00+08:00
		const at1600 = Date.parse("2026-11-18T08:00:00.000Z");
		assert.equal(computeNextQuietEndMs(daytime, at1600), tomorrow1400);
	});

	it("handles negative (-05:00) and half-hour (+05:30, -03:30) UTC offsets deterministically", () => {
		// New York UTC-05:00 overnight 23:00-08:00
		const nyWindow = parseQuietHoursWindow("23:00-08:00", "-05:00");
		// 2026-11-19T04:30:00Z == 2026-11-18 23:30 UTC-05:00
		const ny2330 = Date.parse("2026-11-19T04:30:00.000Z");
		// Next 08:00 UTC-05:00 == 2026-11-19T13:00:00Z
		const nyEnd = computeNextQuietEndMs(nyWindow, ny2330);
		assert.equal(nyEnd, Date.parse("2026-11-19T13:00:00.000Z"));
		assert.equal(isWithinQuietHours(nyEnd - 1, nyWindow), true);
		assert.equal(isWithinQuietHours(nyEnd, nyWindow), false);

		// India UTC+05:30 overnight 23:00-08:00
		const istWindow = parseQuietHoursWindow("23:00-08:00", "+05:30");
		// 2026-11-18T18:00:00Z == 2026-11-18 23:30 UTC+05:30
		const ist2330 = Date.parse("2026-11-18T18:00:00.000Z");
		// Next 08:00 UTC+05:30 == 2026-11-19T02:30:00Z
		const istEnd = computeNextQuietEndMs(istWindow, ist2330);
		assert.equal(istEnd, Date.parse("2026-11-19T02:30:00.000Z"));
		assert.equal(isWithinQuietHours(istEnd - 1, istWindow), true);
		assert.equal(isWithinQuietHours(istEnd, istWindow), false);

		// Newfoundland UTC-03:30 daytime 13:00-14:15
		const nstWindow = parseQuietHoursWindow("13:00-14:15", "-03:30");
		// 2026-11-18T17:00:00Z == 2026-11-18 13:30 UTC-03:30
		const nst1330 = Date.parse("2026-11-18T17:00:00.000Z");
		// End at 14:15 UTC-03:30 == 2026-11-18T17:45:00Z
		const nstEnd = computeNextQuietEndMs(nstWindow, nst1330);
		assert.equal(nstEnd, Date.parse("2026-11-18T17:45:00.000Z"));
		assert.equal(isWithinQuietHours(nstEnd - 1, nstWindow), true);
		assert.equal(isWithinQuietHours(nstEnd, nstWindow), false);
	});

	it("keeps ProactiveNotificationGovernor.classify non-mutating and exposes quietHours/nextQuietEndMs", () => {
		const window = parseQuietHoursWindow("23:00-08:00", "+08:00");
		const gov = new ProactiveNotificationGovernor({ quietHours: window });
		const route = { channel: "telegram", chatId: "chat-1" };
		const at2330 = Date.parse("2026-11-18T15:30:00.000Z");

		assert.deepEqual(gov.quietHours, window);
		assert.equal(gov.nextQuietEndMs(at2330), Date.parse("2026-11-19T00:00:00.000Z"));

		const decision = gov.classify({ route, text: "夜间通知", isBusy: false, nowMs: at2330 });
		assert.deepEqual(decision, { action: "hold", reason: "quiet_hours" });
		assert.equal(gov.heldCount, 0, "classify must not mutate the in-memory held queue");
	});
});

describe("HeldNotificationsDoc, RuntimeModelDoc, detached clones, and reply formatters", () => {
	it("enforces FIFO cap at MAX_HELD_NOTIFICATIONS (50) and supports route-scoped vs full draining", () => {
		const state = createEmptyHeldNotificationsState();
		for (let i = 1; i <= 55; i += 1) {
			appendHeldNotificationInState(state, {
				route: { channel: "telegram", chatId: i % 2 === 0 ? "chat-even" : "chat-odd" },
				text: `  msg-${i}  `,
				reason: "quiet_hours",
				heldAtMs: 1_000 + i,
			});
		}
		assert.equal(MAX_HELD_NOTIFICATIONS, 50);
		assert.equal(state.items.length, 50);
		assert.equal(state.items[0]?.text, "msg-6");
		assert.equal(state.items[49]?.text, "msg-55");

		const oddOnly = listHeldNotificationsFromState(state, { channel: "telegram", chatId: "chat-odd" });
		assert.equal(oddOnly.length, 25);

		const drainedOdd = drainHeldNotificationsInState(state, { channel: "telegram", chatId: "chat-odd" });
		assert.equal(drainedOdd.length, 25);
		assert.equal(state.items.length, 25);
		assert.ok(state.items.every((item) => item.route.chatId === "chat-even"));

		const drainedRest = drainHeldNotificationsInState(state);
		assert.equal(drainedRest.length, 25);
		assert.equal(state.items.length, 0);

		const batches = formatHeldNotificationBatches(drainedRest);
		assert.equal(batches.length, 1);
		assert.equal(batches[0]?.count, 25);
		assert.ok(batches[0]?.digestText.includes("共 25 条"));
	});

	it("persists HeldNotificationsDoc and RuntimeModelDoc inside pi-durable and returns detached clones (never settled proxies)", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);

		try {
			const root = await harness.root(BACKGROUND_CONTEXT, {
				agent: { model: { provider: "faux", modelId: faux.getModel().id } },
			});

			const appended = await root.commit(async (tx) => {
				const doc = await tx.doc(HeldNotificationsDoc);
				return appendHeldNotificationInState(doc, {
					route: { channel: "telegram", chatId: "owner-chat" },
					text: "凌晨巡检发现 1 封重要邮件",
					reason: "quiet_hours",
					heldAtMs: 1_700_000_000_000,
				});
			}, BACKGROUND_CONTEXT);

			// Accessing nested fields outside the settled transaction must succeed (no settled-overlay proxy error).
			assert.deepEqual(appended, {
				route: { channel: "telegram", chatId: "owner-chat" },
				text: "凌晨巡检发现 1 封重要邮件",
				reason: "quiet_hours",
				heldAtMs: 1_700_000_000_000,
			});

			const drained = await root.commit(async (tx) => {
				const doc = await tx.doc(HeldNotificationsDoc);
				return drainHeldNotificationsInState(doc);
			}, BACKGROUND_CONTEXT);

			assert.equal(drained.length, 1);
			assert.equal(drained[0]?.route.channel, "telegram");
			assert.equal(drained[0]?.route.chatId, "owner-chat");
			assert.equal(drained[0]?.text, "凌晨巡检发现 1 封重要邮件");

			// Persist and read RuntimeModelDoc override with detached clone safety.
			await root.commit(async (tx) => {
				const doc = await tx.doc(RuntimeModelDoc);
				doc.override = { provider: "opencode-go", modelId: "kimi-k2.5" };
				doc.updatedAtMs = 1_700_000_123_000;
			}, BACKGROUND_CONTEXT);

			const readBack = await root.commit(async (tx) => {
				const doc = await tx.doc(RuntimeModelDoc);
				return readRuntimeModelOverride(doc);
			}, BACKGROUND_CONTEXT);
			assert.deepEqual(readBack, { provider: "opencode-go", modelId: "kimi-k2.5" });

			await root.commit(async (tx) => {
				const doc = await tx.doc(RuntimeModelDoc);
				delete doc.override;
				delete doc.updatedAtMs;
			}, BACKGROUND_CONTEXT);

			const cleared = await harness.snapshot(RuntimeModelDoc, BACKGROUND_CONTEXT);
			assert.equal(cleared?.override, undefined);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("formats /model, /model list, /mcp replies and parses provider/modelId specs cleanly", () => {
		assert.deepEqual(parseModelRefSpec("opencode-go/kimi-k2.5"), {
			provider: "opencode-go",
			modelId: "kimi-k2.5",
		});
		assert.deepEqual(parseModelRefSpec("openrouter/anthropic/claude-sonnet-4"), {
			provider: "openrouter",
			modelId: "anthropic/claude-sonnet-4",
		});
		assert.equal(parseModelRefSpec("invalid-no-slash"), undefined);
		assert.equal(parseModelRefSpec("/missing-provider"), undefined);

		const defaultStatus = formatModelStatusReply({
			active: { provider: "opencode-go", modelId: "kimi-k2.5" },
			defaultModel: { provider: "opencode-go", modelId: "kimi-k2.5" },
			isOverride: false,
		});
		assert.ok(defaultStatus.includes("opencode-go/kimi-k2.5"));
		assert.ok(defaultStatus.includes("默认模型"));

		const overrideStatus = formatModelStatusReply({
			active: { provider: "opencode-go", modelId: "glm-5" },
			defaultModel: { provider: "opencode-go", modelId: "kimi-k2.5" },
			isOverride: true,
			updatedAtMs: Date.parse("2026-11-26T01:00:00Z"),
			utcOffsetMinutes: 480,
		});
		assert.ok(overrideStatus.includes("opencode-go/glm-5"));
		assert.ok(overrideStatus.includes("opencode-go/kimi-k2.5"));
		assert.ok(overrideStatus.includes("2026-11-26 09:00 UTC+08:00"));

		assert.ok(formatModelListReply([]).includes("暂无可用模型"));
		const modelList = formatModelListReply(
			[
				{ provider: "opencode-go", modelId: "kimi-k2.5", name: "Kimi K2.5" },
				{ provider: "opencode-go", modelId: "glm-5" },
			],
			{ provider: "opencode-go", modelId: "glm-5" },
		);
		assert.ok(modelList.includes("opencode-go/kimi-k2.5 (Kimi K2.5)"));
		assert.ok(modelList.includes("opencode-go/glm-5 [当前]"));

		assert.ok(formatMcpStatusReply({ connected: [], failed: [] }).includes("未配置任何 MCP 服务"));
		const mcpStatus = formatMcpStatusReply({
			connected: [{ name: "mail", toolCount: 6 }],
			failed: [{ name: "miu-bridge", error: "connection refused" }],
		});
		assert.ok(mcpStatus.includes("已连接 1 个，失败 1 个"));
		assert.ok(mcpStatus.includes("[OK] mail（6 个工具）"));
		assert.ok(mcpStatus.includes("[FAIL] miu-bridge：connection refused"));
		assert.ok(mcpStatus.includes("/mcp reconnect"));

		const mcpReconnected = formatMcpStatusReply({
			connected: [
				{ name: "mail", toolCount: 6 },
				{ name: "miu-bridge", toolCount: 4 },
			],
			failed: [],
			reconnected: true,
		});
		assert.ok(mcpReconnected.includes("重连完成"));
		assert.ok(!mcpReconnected.includes("/mcp reconnect"));
	});
});

describe("RoutineSchedulerTask quiet-hours auto-flush integration", () => {
	it("wakes precisely at quietFlushAt via syncRoutineSchedulerInTx with 0 routines and keeps wake().active === false while sleeping", async () => {
		const quietWindow = parseQuietHoursWindow("23:00-08:00", "+08:00");
		let fakeNow = Date.parse("2026-11-18T15:30:00.000Z"); // 23:30+08:00 (inside quiet window)
		const expectedQuietEnd = computeNextQuietEndMs(quietWindow, fakeNow); // 2026-11-19T00:00:00.000Z

		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		const flushedDigests: Array<{ readonly atMs: number; readonly items: HeldProactiveMessage[] }> = [];
		const tracker = createRoutineSchedulerTracker();
		let harnessRef: Harness | undefined;
		let rootConvId: Awaited<ReturnType<Harness["root"]>>["id"] | undefined;

		const schedulerTask = createRoutineSchedulerTask({
			getUtcOffsetMinutes: () => 480,
			getTelemetry: () => undefined,
			tracker,
			onDirectNotify: async () => undefined,
			onAgentProactiveReply: async () => undefined,
		});

		const registry = createRegistry();
		registry.install(
			createRoutinesExtension({
				enableRoutineTools: false,
				enableClockAnchor: false,
				schedulerTask,
				getUtcOffsetMinutes: () => 480,
				getNow: () => fakeNow,
				isRootConversation: (id) => id === rootConvId,
				getNextQuietFlushAtMs: async (nowMs, tx) => {
					const doc =
						tx !== undefined
							? await tx.doc(HeldNotificationsDoc)
							: await harnessRef?.snapshot(HeldNotificationsDoc, BACKGROUND_CONTEXT);
					if (doc === undefined || doc.items.length === 0) return undefined;
					return isWithinQuietHours(nowMs, quietWindow) ? computeNextQuietEndMs(quietWindow, nowMs) : nowMs;
				},
				onQuietFlushDue: async (nowMs, ctx) => {
					const root = await harnessRef!.root(ctx);
					const items = await root.commit(async (tx) => {
						const doc = await tx.doc(HeldNotificationsDoc);
						return drainHeldNotificationsInState(doc);
					}, ctx);
					flushedDigests.push({ atMs: nowMs, items });
				},
			}),
		);

		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, now: () => fakeNow },
			BACKGROUND_CONTEXT,
		);
		harnessRef = harness;

		try {
			const root = await harness.root(BACKGROUND_CONTEXT, {
				agent: { model: { provider: "faux", modelId: faux.getModel().id } },
			});
			rootConvId = root.id;
			harness.resume();

			// Hold a quiet-hours notification with ZERO scheduled routines, and wake the single-flight scheduler.
			await root.commit(async (tx) => {
				const heldDoc = await tx.doc(HeldNotificationsDoc);
				appendHeldNotificationInState(heldDoc, {
					route: { channel: "telegram", chatId: "owner-chat" },
					text: "夜间 CI 构建成功",
					reason: "quiet_hours",
					heldAtMs: fakeNow,
				});
				await syncRoutineSchedulerInTx(tx, schedulerTask, fakeNow, expectedQuietEnd);
			}, BACKGROUND_CONTEXT);

			// Wait until the scheduler enters `sleeping` at the exact quiet-window end timestamp.
			await waitForCondition(() => {
				const w = harness.wake();
				return w.active === false && w.at === expectedQuietEnd;
			});

			const sleepingWake = harness.wake();
			assert.equal(sleepingWake.active, false, "Sleeping scheduler must keep wake().active === false");
			assert.equal(sleepingWake.at, expectedQuietEnd);
			assert.equal(flushedDigests.length, 0);

			// Advance fake clock to exact quiet window end (08:00+08:00) and trigger DO alarm resume.
			fakeNow = expectedQuietEnd;
			harness.resume();

			await waitForCondition(() => flushedDigests.length === 1 && harness.wake().active === false);

			assert.equal(flushedDigests[0]?.atMs, expectedQuietEnd);
			assert.equal(flushedDigests[0]?.items.length, 1);
			assert.equal(flushedDigests[0]?.items[0]?.text, "夜间 CI 构建成功");

			// With queue empty and 0 routines, scheduler terminates cleanly and clears DO alarm.
			const finalWake = harness.wake();
			assert.equal(finalWake.active, false);
			assert.equal(finalWake.at, undefined);
			const remainingDoc = await harness.snapshot(HeldNotificationsDoc, BACKGROUND_CONTEXT);
			assert.equal(remainingDoc?.items.length ?? 0, 0);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("reschedules via RoutineWakeSignal for earlier quietFlushAt and isolates transient onQuietFlushDue errors without faulting subsequent routines", async () => {
		let fakeNow = Date.parse("2026-11-18T16:00:00.000Z"); // 00:00+08:00
		const routineFireAt = fakeNow + 300_000; // +5 min
		const quietFlushAt = fakeNow + 60_000; // +1 min (earlier than routine)
		const retryBackoffMs = 120_000; // +2 min backoff -> +3 min (still earlier than routine at +5 min)

		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		let flushAttempts = 0;
		const deliveredFlushes: HeldProactiveMessage[][] = [];
		const directNotifies: DirectNotifyEvent[] = [];
		const tracker = createRoutineSchedulerTracker();
		let harnessRef: Harness | undefined;
		let rootConvId: Awaited<ReturnType<Harness["root"]>>["id"] | undefined;

		const schedulerTask = createRoutineSchedulerTask({
			getUtcOffsetMinutes: () => 480,
			getTelemetry: () => undefined,
			tracker,
			onDirectNotify: async (event) => {
				directNotifies.push(event);
			},
			onAgentProactiveReply: async () => undefined,
		});

		const registry = createRegistry();
		registry.install(
			createRoutinesExtension({
				enableRoutineTools: false,
				enableClockAnchor: false,
				schedulerTask,
				getUtcOffsetMinutes: () => 480,
				getNow: () => fakeNow,
				isRootConversation: (id) => id === rootConvId,
				quietFlushRetryBackoffMs: retryBackoffMs,
				getNextQuietFlushAtMs: async (_nowMs, tx) => {
					const doc =
						tx !== undefined
							? await tx.doc(HeldNotificationsDoc)
							: await harnessRef?.snapshot(HeldNotificationsDoc, BACKGROUND_CONTEXT);
					if (doc === undefined || doc.items.length === 0) return undefined;
					return quietFlushAt;
				},
				onQuietFlushDue: async (_nowMs, ctx) => {
					flushAttempts += 1;
					if (flushAttempts === 1) {
						throw new Error("Simulated transient Telegram 502");
					}
					const root = await harnessRef!.root(ctx);
					const items = await root.commit(async (tx) => {
						const doc = await tx.doc(HeldNotificationsDoc);
						return drainHeldNotificationsInState(doc);
					}, ctx);
					deliveredFlushes.push(items);
				},
			}),
		);

		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, now: () => fakeNow },
			BACKGROUND_CONTEXT,
		);
		harnessRef = harness;

		try {
			const root = await harness.root(BACKGROUND_CONTEXT, {
				agent: { model: { provider: "faux", modelId: faux.getModel().id } },
			});
			rootConvId = root.id;
			harness.resume();

			// 1. Schedule a routine 5 minutes in the future.
			await root.commit(async (tx) => {
				const rDoc = await tx.doc(RoutineDoc);
				const created = createRoutineInState(
					rDoc,
					{
						title: "喝水提醒",
						mode: "direct_notify",
						payload: "记得喝水",
						schedule: { kind: "once", runAtMs: routineFireAt },
					},
					fakeNow,
				);
				assert.equal(created.ok, true);
				await syncRoutineSchedulerInTx(tx, schedulerTask, fakeNow);
			}, BACKGROUND_CONTEXT);

			await waitForCondition(() => harness.wake().active === false && harness.wake().at === routineFireAt);

			// 2. Hold a quiet-hours notification due earlier (+1 min) and wake the sleeping scheduler via RoutineWakeSignal.
			await root.commit(async (tx) => {
				const hDoc = await tx.doc(HeldNotificationsDoc);
				appendHeldNotificationInState(hDoc, {
					route: { channel: "telegram", chatId: "owner-chat" },
					text: "静默期暂存摘要",
					reason: "quiet_hours",
					heldAtMs: fakeNow,
				});
				await syncRoutineSchedulerInTx(tx, schedulerTask, fakeNow, quietFlushAt);
			}, BACKGROUND_CONTEXT);

			await waitForCondition(() => harness.wake().active === false && harness.wake().at === quietFlushAt);

			// 3. Advance to quietFlushAt (+1 min): first flush attempt throws; scheduler stays alive and backs off to +3 min.
			fakeNow = quietFlushAt;
			harness.resume();

			const expectedRetryAt = quietFlushAt + retryBackoffMs;
			await waitForCondition(
				() => flushAttempts === 1 && harness.wake().active === false && harness.wake().at === expectedRetryAt,
			);
			assert.equal(deliveredFlushes.length, 0);
			assert.equal(directNotifies.length, 0);

			// 4. Advance to retry time (+3 min): second flush succeeds and scheduler sleeps until routineFireAt (+5 min).
			fakeNow = expectedRetryAt;
			harness.resume();

			await waitForCondition(
				() =>
					flushAttempts === 2 &&
					deliveredFlushes.length === 1 &&
					harness.wake().active === false &&
					harness.wake().at === routineFireAt,
			);
			assert.equal(deliveredFlushes[0]?.length, 1);
			assert.equal(deliveredFlushes[0]?.[0]?.text, "静默期暂存摘要");

			// 5. Advance to routineFireAt (+5 min): subsequent scheduled routine fires cleanly.
			fakeNow = routineFireAt;
			harness.resume();

			await waitForCondition(
				() => directNotifies.length === 1 && harness.wake().active === false && harness.wake().at === undefined,
			);
			assert.equal(directNotifies[0]?.text, "记得喝水");
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("never loses a quiet-hours wakeup when a notification is held while RoutineSchedulerTask is actively running", async () => {
		const quietWindow = parseQuietHoursWindow("23:00-08:00", "+08:00");
		let fakeNow = Date.parse("2026-11-18T15:30:00.000Z"); // 23:30+08:00
		const quietEndMs = computeNextQuietEndMs(quietWindow, fakeNow); // 2026-11-19T00:00:00.000Z

		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		const flushed: HeldProactiveMessage[][] = [];
		const tracker = createRoutineSchedulerTracker();
		let harnessRef: Harness | undefined;
		let rootConvId: Awaited<ReturnType<Harness["root"]>>["id"] | undefined;
		let releaseNotify!: () => void;
		let notifyStarted!: () => void;
		const notifyStartedPromise = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		const notifyGate = new Promise<void>((resolve) => {
			releaseNotify = resolve;
		});

		const schedulerTask = createRoutineSchedulerTask({
			getUtcOffsetMinutes: () => 480,
			getTelemetry: () => undefined,
			tracker,
			onDirectNotify: async () => {
				notifyStarted();
				await notifyGate;
			},
			onAgentProactiveReply: async () => undefined,
		});

		const registry = createRegistry();
		registry.install(
			createRoutinesExtension({
				enableRoutineTools: false,
				enableClockAnchor: false,
				schedulerTask,
				getUtcOffsetMinutes: () => 480,
				getNow: () => fakeNow,
				isRootConversation: (id) => id === rootConvId,
				getNextQuietFlushAtMs: async (nowMs, tx) => {
					const doc =
						tx !== undefined
							? await tx.doc(HeldNotificationsDoc)
							: await harnessRef?.snapshot(HeldNotificationsDoc, BACKGROUND_CONTEXT);
					if (doc === undefined || doc.items.length === 0) return undefined;
					return isWithinQuietHours(nowMs, quietWindow) ? computeNextQuietEndMs(quietWindow, nowMs) : nowMs;
				},
				onQuietFlushDue: async (_nowMs, ctx) => {
					const root = await harnessRef!.root(ctx);
					const items = await root.commit(async (tx) => {
						const doc = await tx.doc(HeldNotificationsDoc);
						return drainHeldNotificationsInState(doc);
					}, ctx);
					flushed.push(items);
				},
			}),
		);

		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, now: () => fakeNow },
			BACKGROUND_CONTEXT,
		);
		harnessRef = harness;

		try {
			const root = await harness.root(BACKGROUND_CONTEXT, {
				agent: { model: { provider: "faux", modelId: faux.getModel().id } },
			});
			rootConvId = root.id;
			harness.resume();

			// Trigger an immediately-due routine so RoutineSchedulerTask stays in `status: "running"` (dispatch phase).
			await root.commit(async (tx) => {
				const rDoc = await tx.doc(RoutineDoc);
				createRoutineInState(
					rDoc,
					{
						title: "并发测试提醒",
						mode: "direct_notify",
						payload: "正在投递",
						schedule: { kind: "once", runAtMs: fakeNow },
					},
					fakeNow,
				);
				await syncRoutineSchedulerInTx(tx, schedulerTask, fakeNow);
			}, BACKGROUND_CONTEXT);

			await notifyStartedPromise;

			// While scheduler task is `running` (so syncRoutineSchedulerInTx cannot send a sleep signal), hold a quiet notification.
			await root.commit(async (tx) => {
				const hDoc = await tx.doc(HeldNotificationsDoc);
				appendHeldNotificationInState(hDoc, {
					route: { channel: "telegram", chatId: "owner-chat" },
					text: "并发暂存的夜间告警",
					reason: "quiet_hours",
					heldAtMs: fakeNow,
				});
				await syncRoutineSchedulerInTx(tx, schedulerTask, fakeNow, quietEndMs);
			}, BACKGROUND_CONTEXT);

			// Release the in-flight routine dispatch; `wait` reads HeldNotificationsDoc atomically inside `tx` and sleeps until quietEndMs.
			releaseNotify();
			await waitForCondition(() => harness.wake().active === false && harness.wake().at === quietEndMs);
			assert.equal(flushed.length, 0);

			// Advance to quietEndMs and confirm the concurrently held item flushes cleanly.
			fakeNow = quietEndMs;
			harness.resume();
			await waitForCondition(
				() => flushed.length === 1 && harness.wake().active === false && harness.wake().at === undefined,
			);
			assert.equal(flushed[0]?.[0]?.text, "并发暂存的夜间告警");
		} finally {
			releaseNotify();
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("preserves quiet-flush retry backoff across same-tick routine dispatch and isolates transient getNextQuietFlushAtMs errors", async () => {
		let fakeNow = Date.parse("2026-11-19T00:00:00.000Z"); // 08:00+08:00
		const retryBackoffMs = 90_000;

		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		let lookupCalls = 0;
		let flushAttempts = 0;
		const deliveredFlushes: HeldProactiveMessage[][] = [];
		const directNotifies: DirectNotifyEvent[] = [];
		const tracker = createRoutineSchedulerTracker();
		let harnessRef: Harness | undefined;
		let rootConvId: Awaited<ReturnType<Harness["root"]>>["id"] | undefined;

		const schedulerTask = createRoutineSchedulerTask({
			getUtcOffsetMinutes: () => 480,
			getTelemetry: () => undefined,
			tracker,
			onDirectNotify: async (event) => {
				directNotifies.push(event);
			},
			onAgentProactiveReply: async () => undefined,
		});

		const registry = createRegistry();
		registry.install(
			createRoutinesExtension({
				enableRoutineTools: false,
				enableClockAnchor: false,
				schedulerTask,
				getUtcOffsetMinutes: () => 480,
				getNow: () => fakeNow,
				isRootConversation: (id) => id === rootConvId,
				quietFlushRetryBackoffMs: retryBackoffMs,
				getNextQuietFlushAtMs: async (nowMs, tx) => {
					lookupCalls += 1;
					// Fail the very first lookup transiently to verify lookup error isolation without faulting the task.
					if (lookupCalls === 1) {
						throw new Error("Simulated transient quiet-flush lookup error");
					}
					const doc =
						tx !== undefined
							? await tx.doc(HeldNotificationsDoc)
							: await harnessRef?.snapshot(HeldNotificationsDoc, BACKGROUND_CONTEXT);
					if (doc === undefined || doc.items.length === 0) return undefined;
					return nowMs;
				},
				onQuietFlushDue: async (_nowMs, ctx) => {
					flushAttempts += 1;
					if (flushAttempts === 1) {
						throw new Error("Simulated transient flush error");
					}
					const root = await harnessRef!.root(ctx);
					const items = await root.commit(async (tx) => {
						const doc = await tx.doc(HeldNotificationsDoc);
						return drainHeldNotificationsInState(doc);
					}, ctx);
					deliveredFlushes.push(items);
				},
			}),
		);

		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, now: () => fakeNow },
			BACKGROUND_CONTEXT,
		);
		harnessRef = harness;

		try {
			const root = await harness.root(BACKGROUND_CONTEXT, {
				agent: { model: { provider: "faux", modelId: faux.getModel().id } },
			});
			rootConvId = root.id;
			harness.resume();

			// Hold an already-due notification + schedule a routine at the first backoff wake timestamp.
			const firstBackoffAt = fakeNow + retryBackoffMs;
			await root.commit(async (tx) => {
				const hDoc = await tx.doc(HeldNotificationsDoc);
				appendHeldNotificationInState(hDoc, {
					route: { channel: "telegram", chatId: "owner-chat" },
					text: "跨 dispatch 退避测试",
					reason: "quiet_hours",
					heldAtMs: fakeNow - 1_000,
				});
				const rDoc = await tx.doc(RoutineDoc);
				createRoutineInState(
					rDoc,
					{
						title: "同刻提醒",
						mode: "direct_notify",
						payload: "同刻直推",
						schedule: { kind: "once", runAtMs: firstBackoffAt },
					},
					fakeNow,
				);
				await syncRoutineSchedulerInTx(tx, schedulerTask, fakeNow, fakeNow);
			}, BACKGROUND_CONTEXT);

			// Lookup #1 threw transiently -> task did NOT fault; backed off to firstBackoffAt.
			await waitForCondition(
				() => lookupCalls >= 1 && harness.wake().active === false && harness.wake().at === firstBackoffAt,
			);
			assert.equal(flushAttempts, 0);

			// Advance to firstBackoffAt: BOTH quiet flush and the routine are due at the exact same tick.
			// Flush #1 fails -> sets backoff until firstBackoffAt + retryBackoffMs -> routine dispatches ->
			// returning to `wait` MUST preserve backoff (flushAttempts stays 1, does NOT retry immediately).
			fakeNow = firstBackoffAt;
			harness.resume();
			const secondBackoffAt = firstBackoffAt + retryBackoffMs;
			await waitForCondition(
				() =>
					directNotifies.length === 1 && harness.wake().active === false && harness.wake().at === secondBackoffAt,
			);
			assert.equal(flushAttempts, 1, "Backoff must persist across same-tick routine dispatch");
			assert.equal(directNotifies[0]?.text, "同刻直推");
			assert.equal(deliveredFlushes.length, 0);

			// Advance to secondBackoffAt: flush #2 succeeds and scheduler terminates cleanly.
			fakeNow = secondBackoffAt;
			harness.resume();
			await waitForCondition(
				() =>
					flushAttempts === 2 &&
					deliveredFlushes.length === 1 &&
					harness.wake().active === false &&
					harness.wake().at === undefined,
			);
			assert.equal(deliveredFlushes[0]?.[0]?.text, "跨 dispatch 退避测试");
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("does not busy-spin when getNextQuietFlushAtMs is provided without onQuietFlushDue", async () => {
		const fakeNow = Date.parse("2026-11-19T00:00:00.000Z");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		let lookupCalls = 0;
		const directNotifies: DirectNotifyEvent[] = [];
		const tracker = createRoutineSchedulerTracker();
		let rootConvId: Awaited<ReturnType<Harness["root"]>>["id"] | undefined;

		const schedulerTask = createRoutineSchedulerTask({
			getUtcOffsetMinutes: () => 480,
			getTelemetry: () => undefined,
			tracker,
			onDirectNotify: async (event) => {
				directNotifies.push(event);
			},
			onAgentProactiveReply: async () => undefined,
		});

		const registry = createRegistry();
		registry.install(
			createRoutinesExtension({
				enableRoutineTools: false,
				enableClockAnchor: false,
				schedulerTask,
				getUtcOffsetMinutes: () => 480,
				getNow: () => fakeNow,
				isRootConversation: (id) => id === rootConvId,
				getNextQuietFlushAtMs: async () => {
					lookupCalls += 1;
					return fakeNow - 1_000;
				},
				// Intentionally omit `onQuietFlushDue`.
			}),
		);

		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, now: () => fakeNow },
			BACKGROUND_CONTEXT,
		);

		try {
			const root = await harness.root(BACKGROUND_CONTEXT, {
				agent: { model: { provider: "faux", modelId: faux.getModel().id } },
			});
			rootConvId = root.id;
			harness.resume();

			await root.commit(async (tx) => {
				const rDoc = await tx.doc(RoutineDoc);
				createRoutineInState(
					rDoc,
					{
						title: "无回调安全测试",
						mode: "direct_notify",
						payload: "正常投递",
						schedule: { kind: "once", runAtMs: fakeNow },
					},
					fakeNow,
				);
				await syncRoutineSchedulerInTx(tx, schedulerTask, fakeNow);
			}, BACKGROUND_CONTEXT);

			await waitForCondition(
				() => directNotifies.length === 1 && harness.wake().active === false && harness.wake().at === undefined,
			);
			assert.equal(
				lookupCalls,
				0,
				"Unactionable getNextQuietFlushAtMs must be skipped when onQuietFlushDue is omitted",
			);
			assert.equal(directNotifies[0]?.text, "正常投递");
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});
});
