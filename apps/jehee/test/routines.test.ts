// Unit and durable integration tests for Slice 6A (ADR-0014):
// pure schedule/nextRunAtMs/UTC-offset clock calculations, user-side clock anchor without system prefix drift,
// durable SQLite restart for RoutineDoc & LastRouteDoc, single-flight timer wake & early reschedule signal,
// direct_notify (zero LLM tokens) vs agent_prompt + [SILENT] suppression, cold route fallback, /routines allowlist,
// LLM routine_* tools, and workshop subagent tool isolation.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChannelGateway } from "../src/channels/gateway.ts";
import { JeheeHost } from "../src/core/host.ts";
import { parseQuietHoursWindow } from "../src/governance/quiet-gate.ts";
import {
	computeNextRunAtMs,
	formatLocalClockLine,
	formatRoutineListReply,
	formatUtcOffset,
	LOCAL_CLOCK_LINE_PREFIX,
	parseIsoTimestampMs,
	parseTimeOfDay,
	ROUTINE_CREATE_TOOL,
	ROUTINE_DELETE_TOOL,
	ROUTINE_LIST_TOOL,
} from "../src/index.ts";
import { parseJeheeEnvConfig } from "../src/runtime/config.ts";
import { openNodeJeheeHost } from "../src/runtime/node.ts";
import { JeheeTraceRecorder } from "../src/telemetry/recorder.ts";
import { InstaBoxClient } from "../src/workshop/instabox-client.ts";
import { SingleBoxWorktreeProvisioner } from "../src/workshop/provisioner.ts";

function dumpSystemPrompt(ctx: TranscriptContext): string {
	const parts: string[] = [];
	for (const msg of ctx.messages) {
		if (msg.role !== "system") continue;
		if (typeof msg.content === "string") {
			parts.push(msg.content);
		} else {
			for (const b of msg.content) parts.push(b.text);
		}
		if (msg.sections !== undefined) {
			for (const [k, v] of Object.entries(msg.sections)) {
				if (v !== null) parts.push(`<${k}>${v}</${k}>`);
			}
		}
	}
	return parts.join("\n");
}

function dumpUserTexts(ctx: TranscriptContext): string[] {
	const out: string[] = [];
	for (const msg of ctx.messages) {
		if (msg.role !== "user") continue;
		if (typeof msg.content === "string") {
			out.push(msg.content);
		} else {
			for (const b of msg.content) {
				if (b.type === "text") out.push(b.text);
			}
		}
	}
	return out;
}

describe("routines pure schedule engine, clock anchor, and config parsing", () => {
	it("computes deterministic nextRunAtMs for once, daily, weekly, and interval schedules with UTC offsets", () => {
		// 2026-11-25 is Wednesday (UTC day 3).
		// 2026-11-25T00:30:00Z == 2026-11-25 08:30:00 UTC+08:00
		const wed0830Cst = Date.parse("2026-11-25T00:30:00Z");
		// 2026-11-25T01:00:00Z == 2026-11-25 09:00:00 UTC+08:00
		const wed0900Cst = Date.parse("2026-11-25T01:00:00Z");
		const thu0900Cst = Date.parse("2026-11-26T01:00:00Z");

		// once
		assert.equal(computeNextRunAtMs({ kind: "once", runAtMs: wed0900Cst }, wed0830Cst), wed0900Cst);
		assert.equal(computeNextRunAtMs({ kind: "once", runAtMs: wed0900Cst }, wed0900Cst), undefined);

		// daily (+08:00)
		const daily0900 = { kind: "daily" as const, hour: 9, minute: 0, utcOffsetMinutes: 480 };
		assert.equal(computeNextRunAtMs(daily0900, wed0830Cst), wed0900Cst);
		assert.equal(computeNextRunAtMs(daily0900, wed0900Cst), thu0900Cst);

		// daily with negative offset (-05:00): 2026-11-25T02:00:00Z == 2026-11-24 21:00 UTC-05:00
		const ny2100 = Date.parse("2026-11-25T02:00:00Z");
		const dailyNy0800 = { kind: "daily" as const, hour: 8, minute: 0, utcOffsetMinutes: -300 };
		// Next 08:00 UTC-05:00 is 2026-11-25 08:00-05:00 == 2026-11-25T13:00:00Z
		assert.equal(computeNextRunAtMs(dailyNy0800, ny2100), Date.parse("2026-11-25T13:00:00Z"));

		// weekly: Wednesday (3) 09:00+08:00 -> same day if before 09:00, else next Wednesday (+7d)
		const weeklyWed = { kind: "weekly" as const, weekday: 3, hour: 9, minute: 0, utcOffsetMinutes: 480 };
		assert.equal(computeNextRunAtMs(weeklyWed, wed0830Cst), wed0900Cst);
		assert.equal(computeNextRunAtMs(weeklyWed, wed0900Cst), Date.parse("2026-12-02T01:00:00Z"));

		// weekly: Friday (5) 10:30+08:00 from Wed 08:30+08:00 -> Fri 2026-11-27 10:30+08:00 == 02:30Z
		const weeklyFri = { kind: "weekly" as const, weekday: 5, hour: 10, minute: 30, utcOffsetMinutes: 480 };
		assert.equal(computeNextRunAtMs(weeklyFri, wed0830Cst), Date.parse("2026-11-27T02:30:00Z"));

		// interval: anchored & jumps missed slots cleanly without catch-up storm
		const interval5s = { kind: "interval" as const, intervalMs: 5_000, anchorMs: 1_000 };
		assert.equal(computeNextRunAtMs(interval5s, 500), 1_000);
		assert.equal(computeNextRunAtMs(interval5s, 1_000), 6_000);
		assert.equal(computeNextRunAtMs(interval5s, 22_000), 26_000);
	});

	it("formats local clock anchor, UTC offsets, ISO timestamps, and validates JEHEE_TZ_OFFSET", () => {
		const ts = Date.parse("2026-11-25T06:30:45Z"); // 2026-11-25 14:30 Wed UTC+08:00
		assert.equal(formatUtcOffset(480), "UTC+08:00");
		assert.equal(formatUtcOffset(-330), "UTC-05:30");
		assert.equal(formatUtcOffset(0), "UTC+00:00");
		assert.equal(formatLocalClockLine(ts, 480), "[Local Time: 2026-11-25 14:30 (Wed, UTC+08:00)]");
		assert.equal(formatLocalClockLine(ts, 0), "[Local Time: 2026-11-25 06:30 (Wed, UTC+00:00)]");

		assert.equal(parseIsoTimestampMs("2026-11-25 14:30", 480), Date.parse("2026-11-25T06:30:00Z"));
		assert.equal(parseIsoTimestampMs("2026-11-25T06:30:00Z", 480), Date.parse("2026-11-25T06:30:00Z"));
		assert.throws(() => parseIsoTimestampMs("2026-02-30 10:00", 480), /Invalid calendar date/);
		assert.deepEqual(parseTimeOfDay("09:05"), { hour: 9, minute: 5 });
		assert.throws(() => parseTimeOfDay("25:00"), /Invalid timeOfDay/);

		assert.equal(parseJeheeEnvConfig({}).utcOffsetMinutes, 480);
		assert.equal(parseJeheeEnvConfig({ JEHEE_TZ_OFFSET: "-05:00" }).utcOffsetMinutes, -300);
		assert.throws(() => parseJeheeEnvConfig({ JEHEE_TZ_OFFSET: "Mars/Olympus" }), /Invalid UTC offset/);
		assert.ok(formatRoutineListReply([], 480).includes("当前没有启用"));
	});
});

describe("user-side clock anchor preserves L1 Core system prefix", () => {
	it("injects [Local Time: ...] onto inbound user messages without mutating system prompt or persisted history", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		let fakeNow = Date.parse("2026-11-25T01:00:00Z"); // 09:00+08:00
		const captured: TranscriptContext[] = [];
		faux.setResponses([
			(ctx) => {
				captured.push(ctx);
				return fauxAssistantMessage("早安！");
			},
			(ctx) => {
				captured.push(ctx);
				return fauxAssistantMessage("下午好！");
			},
		]);

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				instructions: "Fixed L1 Core instructions.",
				utcOffsetMinutes: 480,
				enableRoutines: true,
				now: () => fakeNow,
			},
			BACKGROUND_CONTEXT,
		);

		try {
			await host.sendMessage({ text: "现在几点？" }, BACKGROUND_CONTEXT);
			fakeNow = Date.parse("2026-11-25T07:45:00Z"); // 15:45+08:00
			await host.sendMessage({ text: "现在又几点了？" }, BACKGROUND_CONTEXT);

			assert.equal(captured.length, 2);
			const sys1 = dumpSystemPrompt(captured[0]!);
			const sys2 = dumpSystemPrompt(captured[1]!);
			assert.equal(sys1, sys2, "System prompt prefix must remain byte-for-byte identical across turns");
			assert.ok(!sys1.includes(LOCAL_CLOCK_LINE_PREFIX), "Clock anchor must never be placed in system prompt");

			const usersTurn2 = dumpUserTexts(captured[1]!);
			assert.ok(usersTurn2.includes("[Local Time: 2026-11-25 09:00 (Wed, UTC+08:00)]"));
			assert.ok(usersTurn2.includes("[Local Time: 2026-11-25 15:45 (Wed, UTC+08:00)]"));

			// Persisted visible history stays clean without injected clock lines.
			const history = await host.getVisibleHistory(BACKGROUND_CONTEXT);
			assert.equal(history.length, 4);
			assert.equal(history[0]?.text, "现在几点？");
			assert.equal(history[2]?.text, "现在又几点了？");
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}
	});
});

describe("routines durable SQLite restart, single-flight scheduler, direct_notify vs agent_prompt, and /routines", () => {
	it("persists RoutineDoc and LastRouteDoc across SQLite restart, wakes early via RoutineWakeSignal, and fires direct_notify with 0 LLM tokens", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "jehee-routines-sqlite-"));
		const sqlitePath = join(tempDir, "jehee.sqlite");
		const recorder = new JeheeTraceRecorder();
		let openHost: JeheeHost | undefined;
		let openGateway: ChannelGateway | undefined;

		try {
			const faux1 = fauxProvider();
			const models1 = createModels();
			models1.setProvider(faux1.provider);
			faux1.setResponses([fauxAssistantMessage("收到，我记住了。")]);

			const host1 = await openNodeJeheeHost(
				{
					sqlitePath,
					models: models1,
					defaultModel: { provider: "faux", modelId: faux1.getModel().id },
					utcOffsetMinutes: 480,
					enableRoutines: true,
				},
				BACKGROUND_CONTEXT,
			);
			openHost = host1;

			const sent1: Array<{ chatId: string; text: string }> = [];
			const gw1 = new ChannelGateway({
				host: host1,
				allowFrom: { telegram: ["owner-42"] },
			});
			openGateway = gw1;
			gw1.registerTransport({
				channel: "telegram",
				sendText: async (chatId, text) => {
					sent1.push({ chatId, text });
				},
			});

			// Owner chats once -> persists LastRouteDoc { channel: "telegram", chatId: "chat-persisted-99" }.
			await gw1.ingest(
				{
					channel: "telegram",
					chatId: "chat-persisted-99",
					senderId: "owner-42",
					messageId: "m-1",
					text: "你好",
					timestampMs: Date.now(),
				},
				BACKGROUND_CONTEXT,
			);
			assert.deepEqual(await host1.getLastActiveRoute(BACKGROUND_CONTEXT), {
				channel: "telegram",
				chatId: "chat-persisted-99",
			});

			// Create a far-future daily routine first (so single-flight task sleeps far into the future).
			const dailyRes = await host1.createRoutine(
				{
					title: "每日晨报",
					mode: "agent_prompt",
					payload: "总结今日重点事项",
					schedule: { kind: "daily", hour: 9, minute: 0, utcOffsetMinutes: 480 },
				},
				BACKGROUND_CONTEXT,
			);
			assert.equal(dailyRes.ok, true);

			gw1.dispose();
			openGateway = undefined;
			await host1.close(BACKGROUND_CONTEXT);
			openHost = undefined;

			// Cold restart on the exact same SQLite file (simulates Cloudflare DO cold alarm wakeup).
			const faux2 = fauxProvider();
			const models2 = createModels();
			models2.setProvider(faux2.provider);

			const host2 = await openNodeJeheeHost(
				{
					sqlitePath,
					models: models2,
					defaultModel: { provider: "faux", modelId: faux2.getModel().id },
					utcOffsetMinutes: 480,
					enableRoutines: true,
					telemetry: recorder.telemetry,
				},
				BACKGROUND_CONTEXT,
			);
			openHost = host2;

			const sent2: Array<{ chatId: string; text: string }> = [];
			const gw2 = new ChannelGateway({
				host: host2,
				allowFrom: { telegram: ["owner-42"] },
			});
			openGateway = gw2;
			gw2.registerTransport({
				channel: "telegram",
				sendText: async (chatId, text) => {
					sent2.push({ chatId, text });
				},
			});

			// Notice gw2 has NO in-memory lastActiveRoute yet; LastRouteDoc must be restored from SQLite.
			assert.equal(gw2.lastActiveRoute, undefined);
			assert.equal((await host2.listRoutines(BACKGROUND_CONTEXT)).length, 1);

			// Add an earlier one-shot direct_notify reminder (due in 70ms) -> wakes sleeping scheduler early via RoutineWakeSignal!
			const onceRes = await host2.createRoutine(
				{
					title: "喝水提醒",
					mode: "direct_notify",
					payload: "该喝水休息一下啦！",
					schedule: { kind: "once", runAtMs: Date.now() + 70 },
				},
				BACKGROUND_CONTEXT,
			);
			assert.equal(onceRes.ok, true);

			await host2.waitForRoutineScheduler(BACKGROUND_CONTEXT);
			await gw2.drain();

			// Zero LLM calls on host2, yet Telegram received the direct reminder on the persisted chatId!
			assert.equal(faux2.state.callCount, 0);
			assert.equal(sent2.length, 1);
			assert.deepEqual(sent2[0], { chatId: "chat-persisted-99", text: "该喝水休息一下啦！" });

			// Telemetry recorded jehee.routine.fire span.
			const traces = await recorder.listTraces(100);
			const fireSpans = traces.flatMap((t) => t.spans).filter((s) => s.name === "jehee.routine.fire");
			assert.equal(fireSpans.length, 1);
			assert.equal(fireSpans[0]?.attributes["routine.mode"], "direct_notify");

			gw2.dispose();
			openGateway = undefined;
			await host2.close(BACKGROUND_CONTEXT);
			openHost = undefined;
		} finally {
			openGateway?.dispose();
			if (openHost !== undefined) {
				await openHost.close(BACKGROUND_CONTEXT);
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("dispatches agent_prompt with [SILENT] suppression, cold allowFrom.telegram fallback, quiet-hours governance, and /routines commands", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const recorder = new JeheeTraceRecorder();

		faux.setResponses([fauxAssistantMessage("[SILENT]"), fauxAssistantMessage("晨报：今天有 2 个重要会议。")]);

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				utcOffsetMinutes: 480,
				enableRoutines: true,
				telemetry: recorder.telemetry,
			},
			BACKGROUND_CONTEXT,
		);

		let gatewayNow = Date.parse("2026-11-25T02:00:00Z"); // 10:00+08:00 (outside quiet hours)
		const delivered: Array<{ chatId: string; text: string }> = [];
		const gateway = new ChannelGateway({
			host,
			allowFrom: { telegram: ["cold-owner-7"] },
			quietPolicy: { quietHours: parseQuietHoursWindow("23:00-08:00", "+08:00") },
			now: () => gatewayNow,
		});
		gateway.registerTransport({
			channel: "telegram",
			sendText: async (chatId, text) => {
				delivered.push({ chatId, text });
			},
		});

		try {
			// Cold wakeup with NO prior inbound message: proactive delivery falls back to allowFrom.telegram[0].
			const silentRoutine = await host.createRoutine(
				{
					title: "静默巡检",
					mode: "agent_prompt",
					payload: "检查收件箱有无紧急告警",
					schedule: { kind: "once", runAtMs: Date.now() + 50 },
				},
				BACKGROUND_CONTEXT,
			);
			assert.equal(silentRoutine.ok, true);
			await host.waitForRoutineScheduler(BACKGROUND_CONTEXT);
			assert.equal(delivered.length, 0, "[SILENT] reply must not be pushed to Telegram");

			// Second agent_prompt returns actionable briefing -> delivered to cold fallback "cold-owner-7".
			const briefingRoutine = await host.createRoutine(
				{
					title: "早间简报",
					mode: "agent_prompt",
					payload: "汇报今天的日程",
					schedule: { kind: "once", runAtMs: Date.now() + 50 },
				},
				BACKGROUND_CONTEXT,
			);
			assert.equal(briefingRoutine.ok, true);
			await host.waitForRoutineScheduler(BACKGROUND_CONTEXT);
			assert.equal(delivered.length, 1);
			assert.deepEqual(delivered[0], { chatId: "cold-owner-7", text: "晨报：今天有 2 个重要会议。" });

			// Create a recurring normal direct_notify routine to test /routines list, quiet-hours hold, /routines run, and /routines cancel.
			const recurring = await host.createRoutine(
				{
					title: "站立伸展",
					mode: "direct_notify",
					payload: "起来走动 5 分钟",
					schedule: { kind: "daily", hour: 15, minute: 0, utcOffsetMinutes: 480 },
				},
				BACKGROUND_CONTEXT,
			);
			assert.equal(recurring.ok, true);
			if (!recurring.ok) return;

			// Stranger rejected on /routines
			const unauth = await gateway.ingest(
				{
					channel: "telegram",
					chatId: "stranger-chat",
					senderId: "stranger-999",
					messageId: "m-u1",
					text: "/routines list",
					timestampMs: gatewayNow,
				},
				BACKGROUND_CONTEXT,
			);
			assert.deepEqual(unauth, { kind: "unauthorized" });

			// Owner /routines list (0 extra LLM calls)
			const callsBeforeCmd = faux.state.callCount;
			const listRes = await gateway.ingest(
				{
					channel: "telegram",
					chatId: "cold-owner-7",
					senderId: "cold-owner-7",
					messageId: "m-list",
					text: "/routines list",
					timestampMs: gatewayNow,
				},
				BACKGROUND_CONTEXT,
			);
			assert.deepEqual(listRes, { kind: "command_handled", command: "routines" });
			assert.equal(faux.state.callCount, callsBeforeCmd);
			assert.ok(delivered.at(-1)?.text.includes(recurring.item.id));
			assert.ok(delivered.at(-1)?.text.includes("站立伸展"));

			// Switch clock into quiet hours (01:00+08:00) and trigger /routines run -> direct_notify held by quiet gate!
			gatewayNow = Date.parse("2026-11-25T17:00:00Z");
			const runRes = await gateway.ingest(
				{
					channel: "telegram",
					chatId: "cold-owner-7",
					senderId: "cold-owner-7",
					messageId: "m-run",
					text: `/routines run ${recurring.item.id}`,
					timestampMs: gatewayNow,
				},
				BACKGROUND_CONTEXT,
			);
			assert.deepEqual(runRes, { kind: "command_handled", command: "routines" });
			assert.equal(gateway.heldProactiveCount, 1);

			// Cancel via /routines cancel <id>
			const cancelRes = await gateway.ingest(
				{
					channel: "telegram",
					chatId: "cold-owner-7",
					senderId: "cold-owner-7",
					messageId: "m-cancel",
					text: `/routines cancel ${recurring.item.id}`,
					timestampMs: gatewayNow,
				},
				BACKGROUND_CONTEXT,
			);
			assert.deepEqual(cancelRes, { kind: "command_handled", command: "routines" });
			assert.ok(delivered.at(-1)?.text.includes("已取消定时任务"));
			assert.equal((await host.listRoutines(BACKGROUND_CONTEXT)).length, 0);
		} finally {
			gateway.dispose();
			await host.close(BACKGROUND_CONTEXT);
		}
	});

	it("exposes routine_* tools on root conversation and excludes them from builtin workshop subagents", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		let workshopChildCtx: TranscriptContext | undefined;
		let createdRoutineId = "";

		const mockFetch: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/machines/m-rtn")) {
				return Response.json({ id: "m-rtn", name: "m-rtn", state: "running" });
			}
			if (url.endsWith("/exec")) {
				return Response.json({ exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false });
			}
			return Response.json({});
		};
		const client = new InstaBoxClient({ apiKey: "k", fetchImpl: mockFetch });
		const provisioner = new SingleBoxWorktreeProvisioner({ client, machineId: "m-rtn" });

		const router = (ctx: TranscriptContext) => {
			const sys = dumpSystemPrompt(ctx);
			if (sys.includes("Jehee Workshop subagent")) {
				workshopChildCtx = ctx;
				return fauxAssistantMessage("工坊子任务完成。");
			}
			const toolResults = ctx.messages.filter((m) => m.role === "toolResult");
			if (toolResults.length === 0) {
				return fauxAssistantMessage(
					[
						fauxToolCall(ROUTINE_CREATE_TOOL, {
							title: "每周复盘",
							mode: "direct_notify",
							payload: "开始本周复盘",
							scheduleKind: "weekly",
							weekday: 5,
							timeOfDay: "17:00",
						}),
					],
					{ stopReason: "toolUse" },
				);
			}
			if (toolResults.length === 1) {
				const firstRes = toolResults[0]!;
				const text = firstRes.content.map((b) => (b.type === "text" ? b.text : "")).join("");
				const parsed = JSON.parse(text) as { id: string };
				createdRoutineId = parsed.id;
				return fauxAssistantMessage([fauxToolCall(ROUTINE_LIST_TOOL, {})], { stopReason: "toolUse" });
			}
			if (toolResults.length === 2) {
				return fauxAssistantMessage(
					[fauxToolCall("workshop", { action: "spawn", name: "rtn-iso", message: "检查隔离" })],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage(`已创建每周复盘 ${createdRoutineId} 并派发工坊任务。`);
		};

		faux.setResponses(Array.from({ length: 8 }, () => router));

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				enableRoutines: true,
				utcOffsetMinutes: 480,
				workshop: { client, provisioner, defaultDriver: "builtin" },
			},
			BACKGROUND_CONTEXT,
		);

		try {
			const reply = await host.sendMessage({ text: "帮我建一个每周五下午五点的复盘提醒" }, BACKGROUND_CONTEXT);
			assert.equal(reply.status, "done");
			await host.waitForWorkshopSettled(BACKGROUND_CONTEXT);

			assert.equal(createdRoutineId, "rtn_0001");
			assert.equal((await host.listRoutines(BACKGROUND_CONTEXT)).length, 1);

			// Verify workshop subagent does NOT see routine_* tools.
			assert.ok(workshopChildCtx !== undefined, "Expected workshop child context");
			const childTools = new Set<string>();
			for (const msg of workshopChildCtx.messages) {
				if (msg.role !== "system") continue;
				for (const t of msg.toolsAdded ?? []) childTools.add(t.name);
				for (const t of msg.toolsRemoved ?? []) childTools.delete(t.name);
			}
			assert.ok(!childTools.has(ROUTINE_CREATE_TOOL));
			assert.ok(!childTools.has(ROUTINE_LIST_TOOL));
			assert.ok(!childTools.has(ROUTINE_DELETE_TOOL));
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}
	});

	it("delivers a due routine after cold SQLite restart when reopened with autoResume: false and resumed after gateway wiring", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "jehee-routines-cold-due-"));
		const sqlitePath = join(tempDir, "jehee.sqlite");
		let openHost: JeheeHost | undefined;
		let openGateway: ChannelGateway | undefined;

		try {
			const faux1 = fauxProvider();
			const models1 = createModels();
			models1.setProvider(faux1.provider);
			faux1.setResponses([fauxAssistantMessage("好的")]);

			const host1 = await openNodeJeheeHost(
				{
					sqlitePath,
					models: models1,
					defaultModel: { provider: "faux", modelId: faux1.getModel().id },
					utcOffsetMinutes: 480,
					enableRoutines: true,
				},
				BACKGROUND_CONTEXT,
			);
			openHost = host1;

			const gw1 = new ChannelGateway({
				host: host1,
				allowFrom: { telegram: ["cold-due-owner"] },
			});
			openGateway = gw1;
			gw1.registerTransport({
				channel: "telegram",
				sendText: async () => undefined,
			});

			// Persist LastRouteDoc.
			await gw1.ingest(
				{
					channel: "telegram",
					chatId: "chat-cold-due",
					senderId: "cold-due-owner",
					messageId: "m-cold-1",
					text: "记录路由",
					timestampMs: Date.now(),
				},
				BACKGROUND_CONTEXT,
			);

			// Schedule a once direct_notify 120ms in the future, then close immediately so it becomes due while offline.
			const created = await host1.createRoutine(
				{
					title: "离线到期提醒",
					mode: "direct_notify",
					payload: "离线期间到期的提醒已补发！",
					schedule: { kind: "once", runAtMs: Date.now() + 120 },
				},
				BACKGROUND_CONTEXT,
			);
			assert.equal(created.ok, true);

			gw1.dispose();
			openGateway = undefined;
			await host1.close(BACKGROUND_CONTEXT);
			openHost = undefined;

			// Wait until the scheduled timestamp has passed while the host is closed.
			await new Promise((resolve) => setTimeout(resolve, 160));

			const faux2 = fauxProvider();
			const models2 = createModels();
			models2.setProvider(faux2.provider);

			// Reopen with autoResume: false (mirrors worker.ts & assembleNodeRuntime), wire gateway + transport, THEN resume.
			const host2 = await openNodeJeheeHost(
				{
					sqlitePath,
					models: models2,
					defaultModel: { provider: "faux", modelId: faux2.getModel().id },
					utcOffsetMinutes: 480,
					enableRoutines: true,
					autoResume: false,
				},
				BACKGROUND_CONTEXT,
			);
			openHost = host2;

			const delivered: Array<{ chatId: string; text: string }> = [];
			const gw2 = new ChannelGateway({
				host: host2,
				allowFrom: { telegram: ["cold-due-owner"] },
			});
			openGateway = gw2;
			gw2.registerTransport({
				channel: "telegram",
				sendText: async (chatId, text) => {
					delivered.push({ chatId, text });
				},
			});

			// Give the event loop a tick before resume to confirm autoResume: false held dispatch until gateway wiring finished.
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(delivered.length, 0);

			host2.resume();
			await host2.waitForDueRoutines(BACKGROUND_CONTEXT);
			await gw2.drain();

			assert.equal(faux2.state.callCount, 0);
			assert.equal(delivered.length, 1);
			assert.deepEqual(delivered[0], { chatId: "chat-cold-due", text: "离线期间到期的提醒已补发！" });

			gw2.dispose();
			openGateway = undefined;
			await host2.close(BACKGROUND_CONTEXT);
			openHost = undefined;
		} finally {
			openGateway?.dispose();
			if (openHost !== undefined) {
				await openHost.close(BACKGROUND_CONTEXT);
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("isolates transient delivery errors so the single-flight RoutineSchedulerTask keeps dispatching subsequent routines", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const recorder = new JeheeTraceRecorder();

		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				utcOffsetMinutes: 480,
				enableRoutines: true,
				telemetry: recorder.telemetry,
			},
			BACKGROUND_CONTEXT,
		);

		let attempts = 0;
		const delivered: string[] = [];
		const gateway = new ChannelGateway({
			host,
			allowFrom: { telegram: ["owner-err-test"] },
		});
		gateway.registerTransport({
			channel: "telegram",
			sendText: async (_chatId, text) => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error("Simulated transient Telegram HTTP 500");
				}
				delivered.push(text);
			},
		});

		try {
			const now = Date.now();
			const first = await host.createRoutine(
				{
					title: "瞬时失败提醒",
					mode: "direct_notify",
					payload: "第一条提醒（会遇到 HTTP 500）",
					schedule: { kind: "once", runAtMs: now + 50 },
				},
				BACKGROUND_CONTEXT,
			);
			const second = await host.createRoutine(
				{
					title: "后续正常提醒",
					mode: "direct_notify",
					payload: "第二条提醒（调度器仍存活）",
					schedule: { kind: "once", runAtMs: now + 110 },
				},
				BACKGROUND_CONTEXT,
			);
			assert.equal(first.ok, true);
			assert.equal(second.ok, true);

			await host.waitForRoutineScheduler(BACKGROUND_CONTEXT);
			await gateway.drain();

			assert.equal(attempts, 2);
			assert.deepEqual(delivered, ["第二条提醒（调度器仍存活）"]);

			const traces = await recorder.listTraces(100);
			const fireSpans = traces.flatMap((t) => t.spans).filter((s) => s.name === "jehee.routine.fire");
			assert.equal(fireSpans.length, 2);
			assert.ok(fireSpans.some((s) => s.attributes["routine.outcome"] === "error" && s.status.status === "error"));
			assert.ok(fireSpans.some((s) => s.attributes["routine.outcome"] === "ok" && s.status.status === "ok"));
		} finally {
			gateway.dispose();
			await host.close(BACKGROUND_CONTEXT);
		}
	});
});
