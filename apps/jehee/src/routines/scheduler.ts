// Pure deterministic schedule engine for Slice 6A routines:
// next-run calculation using explicit UTC offsets (zero host OS timezone dependency),
// tail/user-side local clock anchor formatting, RoutineStoreState mutations, and `/routines` reply formatters.

import { parseUtcOffsetMinutes } from "../governance/quiet-gate.ts";
import type {
	LastRouteState,
	RoutineCreateInput,
	RoutineCreateResult,
	RoutineDeleteResult,
	RoutineItem,
	RoutineRunOutcome,
	RoutineSchedule,
	RoutineStoreState,
} from "./contract.ts";

/** Default fixed UTC offset in minutes (`+08:00` = `480`). */
export const DEFAULT_UTC_OFFSET_MINUTES = 480;

/** Minimum allowed interval in milliseconds for `interval` schedules (50 ms supports fast deterministic tests). */
export const MIN_ROUTINE_INTERVAL_MS = 50;

/** Prefix marker identifying a Jehee tail/user-side local clock anchor block. */
export const LOCAL_CLOCK_LINE_PREFIX = "[Local Time: ";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NAIVE_ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const EXPLICIT_TZ_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Re-export of UTC offset parser for routine schedule consumers. */
export { parseUtcOffsetMinutes };

/** Creates a fresh empty `RoutineStoreState`. */
export function createEmptyRoutineStoreState(): RoutineStoreState {
	return { seq: 0, items: {} };
}

/** Creates a fresh empty `LastRouteState`. */
export function createEmptyLastRouteState(): LastRouteState {
	return {};
}

/** Formats a UTC offset in minutes (e.g. `480`, `-330`, `0`) into `"UTC+08:00"`, `"UTC-05:30"`, `"UTC+00:00"`. */
export function formatUtcOffset(utcOffsetMinutes: number): string {
	const sign = utcOffsetMinutes < 0 ? "-" : "+";
	const abs = Math.abs(Math.trunc(utcOffsetMinutes));
	const hours = String(Math.floor(abs / 60)).padStart(2, "0");
	const mins = String(abs % 60).padStart(2, "0");
	return `UTC${sign}${hours}:${mins}`;
}

/** Parses a 24-hour `"HH:MM"` string into `{ hour, minute }`. */
export function parseTimeOfDay(raw: string): { readonly hour: number; readonly minute: number } {
	const trimmed = raw.trim();
	const match = TIME_OF_DAY_PATTERN.exec(trimmed);
	if (!match) {
		throw new Error(`Invalid timeOfDay "${raw}": expected 24-hour "HH:MM" (e.g. "09:00")`);
	}
	return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Parses an ISO-8601 timestamp string into epoch milliseconds.
 * Strings with explicit timezone (`Z` or `±HH:MM`) are parsed directly; naive local timestamps
 * (`"YYYY-MM-DD HH:MM"` or `"YYYY-MM-DDTHH:MM[:SS]"`) are interpreted in `defaultUtcOffsetMinutes`.
 */
export function parseIsoTimestampMs(raw: string, defaultUtcOffsetMinutes: number = DEFAULT_UTC_OFFSET_MINUTES): number {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new Error("Timestamp must not be empty");
	}
	if (EXPLICIT_TZ_PATTERN.test(trimmed)) {
		const parsed = Date.parse(trimmed);
		if (!Number.isFinite(parsed)) {
			throw new Error(`Invalid ISO timestamp "${raw}"`);
		}
		return parsed;
	}
	const naive = NAIVE_ISO_PATTERN.exec(trimmed);
	if (!naive) {
		throw new Error(
			`Invalid timestamp "${raw}": expected ISO-8601 with offset (e.g. "2026-11-25T15:00:00+08:00") or local "YYYY-MM-DD HH:MM"`,
		);
	}
	const year = Number(naive[1]);
	const month = Number(naive[2]);
	const day = Number(naive[3]);
	const hour = Number(naive[4]);
	const minute = Number(naive[5]);
	const second = naive[6] !== undefined ? Number(naive[6]) : 0;
	const localUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
	// Reject calendar overflows like Feb 30.
	const check = new Date(localUtcMs);
	if (
		check.getUTCFullYear() !== year ||
		check.getUTCMonth() !== month - 1 ||
		check.getUTCDate() !== day ||
		check.getUTCHours() !== hour ||
		check.getUTCMinutes() !== minute ||
		check.getUTCSeconds() !== second
	) {
		throw new Error(`Invalid calendar date/time "${raw}"`);
	}
	return localUtcMs - defaultUtcOffsetMinutes * MINUTE_MS;
}

/** Formats an epoch timestamp as `"YYYY-MM-DD HH:MM UTC±HH:MM"` using pure UTC offset arithmetic. */
export function formatLocalDateTime(
	timestampMs: number,
	utcOffsetMinutes: number = DEFAULT_UTC_OFFSET_MINUTES,
): string {
	const local = new Date(timestampMs + utcOffsetMinutes * MINUTE_MS);
	const y = String(local.getUTCFullYear()).padStart(4, "0");
	const mo = String(local.getUTCMonth() + 1).padStart(2, "0");
	const d = String(local.getUTCDate()).padStart(2, "0");
	const h = String(local.getUTCHours()).padStart(2, "0");
	const mi = String(local.getUTCMinutes()).padStart(2, "0");
	return `${y}-${mo}-${d} ${h}:${mi} ${formatUtcOffset(utcOffsetMinutes)}`;
}

/**
 * Formats the concise user-side local clock anchor injected into inbound user messages
 * (never placed in the L1 Core system prefix so KV-cache hit rate stays intact).
 */
export function formatLocalClockLine(nowMs: number, utcOffsetMinutes: number = DEFAULT_UTC_OFFSET_MINUTES): string {
	const local = new Date(nowMs + utcOffsetMinutes * MINUTE_MS);
	const y = String(local.getUTCFullYear()).padStart(4, "0");
	const mo = String(local.getUTCMonth() + 1).padStart(2, "0");
	const d = String(local.getUTCDate()).padStart(2, "0");
	const h = String(local.getUTCHours()).padStart(2, "0");
	const mi = String(local.getUTCMinutes()).padStart(2, "0");
	const weekday = WEEKDAY_NAMES[local.getUTCDay()] ?? "Sun";
	return `${LOCAL_CLOCK_LINE_PREFIX}${y}-${mo}-${d} ${h}:${mi} (${weekday}, ${formatUtcOffset(utcOffsetMinutes)})]`;
}

/** Validates a `RoutineSchedule`, returning an error string if malformed or `undefined` when valid. */
export function validateRoutineSchedule(schedule: RoutineSchedule): string | undefined {
	if (schedule.kind === "once") {
		if (!Number.isFinite(schedule.runAtMs) || schedule.runAtMs <= 0) {
			return "once schedule requires a positive finite runAtMs";
		}
		return undefined;
	}
	if (schedule.kind === "daily") {
		if (!Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23) {
			return "daily schedule hour must be an integer in [0, 23]";
		}
		if (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) {
			return "daily schedule minute must be an integer in [0, 59]";
		}
		if (!Number.isFinite(schedule.utcOffsetMinutes) || Math.abs(schedule.utcOffsetMinutes) > 14 * 60) {
			return "daily schedule utcOffsetMinutes must be within [-840, 840]";
		}
		return undefined;
	}
	if (schedule.kind === "weekly") {
		if (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6) {
			return "weekly schedule weekday must be an integer in [0, 6] (0=Sun..6=Sat)";
		}
		if (!Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23) {
			return "weekly schedule hour must be an integer in [0, 23]";
		}
		if (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) {
			return "weekly schedule minute must be an integer in [0, 59]";
		}
		if (!Number.isFinite(schedule.utcOffsetMinutes) || Math.abs(schedule.utcOffsetMinutes) > 14 * 60) {
			return "weekly schedule utcOffsetMinutes must be within [-840, 840]";
		}
		return undefined;
	}
	// schedule.kind === "interval"
	if (!Number.isFinite(schedule.intervalMs) || schedule.intervalMs < MIN_ROUTINE_INTERVAL_MS) {
		return `interval schedule intervalMs must be >= ${MIN_ROUTINE_INTERVAL_MS}`;
	}
	if (schedule.anchorMs !== undefined && !Number.isFinite(schedule.anchorMs)) {
		return "interval schedule anchorMs must be finite when provided";
	}
	return undefined;
}

/**
 * Computes the next strictly future execution timestamp (`> afterMs`) for `schedule`
 * using pure UTC offset arithmetic (never reads host OS local timezone).
 * Returns `undefined` when a `once` schedule is already at or before `afterMs`.
 */
export function computeNextRunAtMs(schedule: RoutineSchedule, afterMs: number): number | undefined {
	if (schedule.kind === "once") {
		return schedule.runAtMs > afterMs ? schedule.runAtMs : undefined;
	}
	if (schedule.kind === "daily") {
		const offsetMs = schedule.utcOffsetMinutes * MINUTE_MS;
		const localAfterMs = afterMs + offsetMs;
		const local = new Date(localAfterMs);
		let candidateLocalMs = Date.UTC(
			local.getUTCFullYear(),
			local.getUTCMonth(),
			local.getUTCDate(),
			schedule.hour,
			schedule.minute,
			0,
			0,
		);
		if (candidateLocalMs <= localAfterMs) {
			candidateLocalMs += DAY_MS;
		}
		return candidateLocalMs - offsetMs;
	}
	if (schedule.kind === "weekly") {
		const offsetMs = schedule.utcOffsetMinutes * MINUTE_MS;
		const localAfterMs = afterMs + offsetMs;
		const local = new Date(localAfterMs);
		const currentWeekday = local.getUTCDay();
		const dayDelta = (schedule.weekday - currentWeekday + 7) % 7;
		let candidateLocalMs = Date.UTC(
			local.getUTCFullYear(),
			local.getUTCMonth(),
			local.getUTCDate() + dayDelta,
			schedule.hour,
			schedule.minute,
			0,
			0,
		);
		if (candidateLocalMs <= localAfterMs) {
			candidateLocalMs += 7 * DAY_MS;
		}
		return candidateLocalMs - offsetMs;
	}
	// schedule.kind === "interval"
	const anchor = schedule.anchorMs ?? afterMs;
	if (afterMs < anchor) {
		return anchor;
	}
	const steps = Math.floor((afterMs - anchor) / schedule.intervalMs) + 1;
	return anchor + steps * schedule.intervalMs;
}

/** Produces a concise human-readable description of `schedule`. */
export function formatScheduleDescription(schedule: RoutineSchedule): string {
	if (schedule.kind === "once") {
		return `once @ ${new Date(schedule.runAtMs).toISOString()}`;
	}
	if (schedule.kind === "daily") {
		const hh = String(schedule.hour).padStart(2, "0");
		const mm = String(schedule.minute).padStart(2, "0");
		return `daily ${hh}:${mm} ${formatUtcOffset(schedule.utcOffsetMinutes)}`;
	}
	if (schedule.kind === "weekly") {
		const hh = String(schedule.hour).padStart(2, "0");
		const mm = String(schedule.minute).padStart(2, "0");
		const day = WEEKDAY_NAMES[schedule.weekday] ?? "Sun";
		return `weekly ${day} ${hh}:${mm} ${formatUtcOffset(schedule.utcOffsetMinutes)}`;
	}
	const ms = schedule.intervalMs;
	if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`;
	if (ms % 60_000 === 0) return `every ${ms / 60_000}m`;
	if (ms % 1_000 === 0) return `every ${ms / 1_000}s`;
	return `every ${ms}ms`;
}

/** Clones a `RoutineItem` plain object so it can safely cross transaction boundaries. */
export function cloneRoutineItem(item: RoutineItem): RoutineItem {
	return {
		...item,
		schedule: { ...item.schedule },
	};
}

/** Creates and registers a new routine item in `state` (mutates `state` inside a durable tx). */
export function createRoutineInState(
	state: RoutineStoreState,
	input: RoutineCreateInput,
	nowMs: number,
): RoutineCreateResult {
	const title = input.title.trim();
	if (title.length === 0) {
		return { ok: false, reason: "invalid_input", message: "Routine title must not be empty." };
	}
	const payload = input.payload.trim();
	if (payload.length === 0) {
		return { ok: false, reason: "invalid_input", message: "Routine payload must not be empty." };
	}
	const scheduleErr = validateRoutineSchedule(input.schedule);
	if (scheduleErr !== undefined) {
		return { ok: false, reason: "invalid_input", message: scheduleErr };
	}

	const normalizedSchedule: RoutineSchedule =
		input.schedule.kind === "interval" && input.schedule.anchorMs === undefined
			? { kind: "interval", intervalMs: input.schedule.intervalMs, anchorMs: nowMs }
			: { ...input.schedule };

	const nextRunAtMs =
		normalizedSchedule.kind === "once" ? normalizedSchedule.runAtMs : computeNextRunAtMs(normalizedSchedule, nowMs);

	if (nextRunAtMs === undefined) {
		return { ok: false, reason: "invalid_input", message: "Routine schedule has no upcoming execution time." };
	}

	state.seq += 1;
	const id = `rtn_${String(state.seq).padStart(4, "0")}`;
	const item: RoutineItem = {
		id,
		title,
		mode: input.mode,
		payload,
		schedule: normalizedSchedule,
		urgency: input.urgency ?? "normal",
		enabled: true,
		nextRunAtMs,
		runCount: 0,
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
	};
	state.items[id] = item;
	return { ok: true, item: cloneRoutineItem(item) };
}

/** Lists routines from `state` ordered by `nextRunAtMs` (enabled first), then `id`. */
export function listRoutinesFromState(state: RoutineStoreState, includeDisabled: boolean = false): RoutineItem[] {
	return Object.values(state.items)
		.filter((item) => includeDisabled || item.enabled)
		.sort((a, b) => {
			if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
			const aNext = a.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
			const bNext = b.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
			if (aNext !== bNext) return aNext - bNext;
			return a.id.localeCompare(b.id);
		})
		.map(cloneRoutineItem);
}

/** Deletes (cancels) a routine by ID from `state`. */
export function deleteRoutineInState(state: RoutineStoreState, id: string): RoutineDeleteResult {
	const trimmed = id.trim();
	const found = Object.hasOwn(state.items, trimmed) ? state.items[trimmed] : undefined;
	if (found === undefined) {
		return { ok: false, reason: "not_found", id: trimmed };
	}
	const cloned = cloneRoutineItem(found);
	delete state.items[trimmed];
	return { ok: true, item: cloned };
}

/** Returns the earliest `nextRunAtMs` across all enabled routines, or `undefined` when none are pending. */
export function findEarliestNextRunAtMs(state: RoutineStoreState): number | undefined {
	let earliest: number | undefined;
	for (const item of Object.values(state.items)) {
		if (!item.enabled || item.nextRunAtMs === undefined) continue;
		if (earliest === undefined || item.nextRunAtMs < earliest) {
			earliest = item.nextRunAtMs;
		}
	}
	return earliest;
}

/**
 * Advances all routines due at or before `nowMs` inside a transaction and returns cloned dispatch entries.
 * Each due routine is atomically advanced (`runCount`, `lastRunAtMs`, `lastFiredKey`, next `nextRunAtMs` or disabled for `once`)
 * before leaving the commit so crashes mid-dispatch cannot double-advance the schedule.
 */
export function claimDueRoutinesInState(
	state: RoutineStoreState,
	nowMs: number,
): Array<{ readonly item: RoutineItem; readonly fireAtMs: number }> {
	const due = Object.values(state.items)
		.filter((item) => item.enabled && item.nextRunAtMs !== undefined && item.nextRunAtMs <= nowMs)
		.sort((a, b) => (a.nextRunAtMs ?? 0) - (b.nextRunAtMs ?? 0) || a.id.localeCompare(b.id));

	const claimed: Array<{ readonly item: RoutineItem; readonly fireAtMs: number }> = [];
	for (const item of due) {
		const fireAtMs = item.nextRunAtMs!;
		const firedKey = `${item.id}:${fireAtMs}`;
		if (item.lastFiredKey === firedKey) {
			// Guard against duplicate claim for the exact same slot.
			if (item.schedule.kind === "once") {
				item.enabled = false;
				delete item.nextRunAtMs;
			} else {
				item.nextRunAtMs = computeNextRunAtMs(item.schedule, Math.max(nowMs, fireAtMs));
			}
			continue;
		}
		item.runCount += 1;
		item.lastRunAtMs = fireAtMs;
		item.lastFiredKey = firedKey;
		item.updatedAtMs = nowMs;
		if (item.schedule.kind === "once") {
			item.enabled = false;
			delete item.nextRunAtMs;
		} else {
			item.nextRunAtMs = computeNextRunAtMs(item.schedule, Math.max(nowMs, fireAtMs));
		}
		claimed.push({ item: cloneRoutineItem(item), fireAtMs });
	}
	return claimed;
}

/** Builds the idempotent prompt text submitted to the root conversation for an `agent_prompt` routine. */
export function buildRoutineAgentPrompt(
	item: Pick<RoutineItem, "id" | "title" | "payload">,
	fireAtMs: number,
	utcOffsetMinutes: number = DEFAULT_UTC_OFFSET_MINUTES,
): string {
	return [
		`[Scheduled Routine ${item.id}: ${item.title}]`,
		`Triggered at: ${formatLocalDateTime(fireAtMs, utcOffsetMinutes)}`,
		`Instruction: ${item.payload}`,
		'If there is nothing actionable or noteworthy to notify the owner about right now, reply with exactly "[SILENT]" (and nothing else) so the owner is not disturbed.',
	].join("\n");
}

/** Formats `/routines list` reply cleanly for chat channels. */
export function formatRoutineListReply(
	items: readonly RoutineItem[],
	utcOffsetMinutes: number = DEFAULT_UTC_OFFSET_MINUTES,
): string {
	if (items.length === 0) {
		return "[Routines] 当前没有启用的定时提醒或周期任务。";
	}
	const lines = [`[Routines] 共 ${items.length} 项任务：`];
	for (const item of items) {
		const nextLabel =
			item.nextRunAtMs !== undefined ? formatLocalDateTime(item.nextRunAtMs, utcOffsetMinutes) : "已完成/已停用";
		const modeLabel = item.mode === "direct_notify" ? "direct" : "agent";
		const schedLabel =
			item.schedule.kind === "once"
				? `once @ ${formatLocalDateTime(item.schedule.runAtMs, utcOffsetMinutes)}`
				: formatScheduleDescription(item.schedule);
		lines.push(`- ${item.id} | ${item.title} [${modeLabel}, ${schedLabel}] -> 下次: ${nextLabel}`);
	}
	return lines.join("\n");
}

/** Formats `/routines cancel <id>` reply cleanly for chat channels. */
export function formatRoutineDeleteReply(result: RoutineDeleteResult): string {
	if (!result.ok) {
		return `未找到定时任务 "${result.id}"。`;
	}
	return `已取消定时任务 ${result.item.id}（${result.item.title}）。`;
}

/** Formats `/routines run <id>` reply cleanly for chat channels. */
export function formatRoutineRunReply(outcome: RoutineRunOutcome): string {
	if (!outcome.ok) {
		if (outcome.reason === "not_found") {
			return `未找到定时任务 "${outcome.id}"。`;
		}
		return `执行定时任务 ${outcome.routineId} 失败：${outcome.message}`;
	}
	if (outcome.mode === "direct_notify") {
		return `已立即触发直推提醒 ${outcome.routineId}（${outcome.title}）。`;
	}
	if (outcome.suppressedSilent) {
		return `已执行例行检查 ${outcome.routineId}（${outcome.title}）：无需打扰（[SILENT]）。`;
	}
	return `已执行例行任务 ${outcome.routineId}（${outcome.title}）。`;
}
