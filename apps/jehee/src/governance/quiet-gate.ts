// Deterministic proactive notification governance ("It knows when to be quiet"):
// enforces quiet-hours windows, foreground busy-turn yielding, per-route cooldowns, `[SILENT]` suppression,
// and lossless held-digest buffering.

import { type ChannelRoute, formatRouteKey } from "../channels/contract.ts";

/** Sentinel reply token indicating a background check intentionally chose not to disturb the owner. */
export const SILENT_REPLY_TOKEN = "[SILENT]";

/** Local time-of-day Do-Not-Disturb window (supports overnight wrap such as 23:00-08:00). */
export type QuietHoursWindow = {
	/** Inclusive start minute of day `[0, 1439]` (e.g. `1380` for `23:00`). */
	readonly startMinute: number;
	/** Exclusive end minute of day `[0, 1439]` (e.g. `480` for `08:00`). */
	readonly endMinute: number;
	/** Fixed UTC offset in minutes (e.g. `480` for `UTC+08:00`). */
	readonly utcOffsetMinutes: number;
};

/** Declarative policy governing unsolicited/proactive outbound pushes (`ChannelGateway.pushMessage`). */
export type ProactiveQuietPolicy = {
	readonly quietHours?: QuietHoursWindow;
	/** Minimum interval in ms between consecutive normal proactive pushes to the same route. */
	readonly minIntervalMs?: number;
	/** Hold normal proactive pushes while the root conversation is actively busy with foreground work. Defaults to true. */
	readonly yieldWhenBusy?: boolean;
};

/** Reason why a proactive push was deferred into the held digest buffer. */
export type ProactiveHoldReason = "quiet_hours" | "busy_yield" | "rate_cooldown";

/** One deferred proactive notification waiting for quiet hours / busy state / cooldown to clear. */
export type HeldProactiveMessage = {
	readonly route: ChannelRoute;
	readonly text: string;
	readonly reason: ProactiveHoldReason;
	readonly heldAtMs: number;
};

/** Decision returned by `ProactiveNotificationGovernor.evaluate`. */
export type ProactiveGateDecision =
	| { readonly action: "drop_silent" }
	| { readonly action: "deliver" }
	| { readonly action: "hold"; readonly reason: ProactiveHoldReason; readonly heldCount: number };

const HH_MM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WINDOW_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const OFFSET_PATTERN = /^([+-])([01]\d|2[0-3])(?::?([0-5]\d))?$/;

/** Parses a UTC offset string such as `"+08:00"`, `"-05:00"`, `"+05:30"`, or `"UTC"` into minutes. */
export function parseUtcOffsetMinutes(raw: string = "+08:00"): number {
	const trimmed = raw.trim().toUpperCase();
	if (trimmed === "UTC" || trimmed === "Z" || trimmed === "+00:00" || trimmed === "-00:00") {
		return 0;
	}
	const match = OFFSET_PATTERN.exec(trimmed);
	if (!match) {
		throw new Error(`Invalid UTC offset "${raw}": expected "+HH:MM", "-HH:MM", or "UTC"`);
	}
	const sign = match[1] === "-" ? -1 : 1;
	const hours = Number(match[2]);
	const minutes = match[3] !== undefined ? Number(match[3]) : 0;
	const total = sign * (hours * 60 + minutes);
	if (total < -14 * 60 || total > 14 * 60) {
		throw new Error(`UTC offset "${raw}" is out of range [-14:00, +14:00]`);
	}
	return total;
}

/** Parses a `"HH:MM-HH:MM"` quiet-hours string and optional UTC offset into a `QuietHoursWindow`. */
export function parseQuietHoursWindow(windowSpec: string, utcOffsetSpec: string = "+08:00"): QuietHoursWindow {
	const trimmed = windowSpec.trim();
	const match = WINDOW_PATTERN.exec(trimmed);
	if (!match) {
		throw new Error(
			`Invalid quiet hours "${windowSpec}": expected "HH:MM-HH:MM" (24-hour clock, e.g. "23:00-08:00")`,
		);
	}
	const startMinute = Number(match[1]) * 60 + Number(match[2]);
	const endMinute = Number(match[3]) * 60 + Number(match[4]);
	if (startMinute === endMinute) {
		throw new Error(`Invalid quiet hours "${windowSpec}": start and end times must differ`);
	}
	return {
		startMinute,
		endMinute,
		utcOffsetMinutes: parseUtcOffsetMinutes(utcOffsetSpec),
	};
}

/** Formats a minute-of-day `[0, 1439]` back into `"HH:MM"` for status display. */
export function formatMinuteOfDay(minute: number): string {
	const h = String(Math.floor(minute / 60)).padStart(2, "0");
	const m = String(minute % 60).padStart(2, "0");
	return HH_MM_PATTERN.test(`${h}:${m}`) ? `${h}:${m}` : "00:00";
}

/** True when `timestampMs` falls inside `window` in the window's configured local UTC offset. */
export function isWithinQuietHours(timestampMs: number, window: QuietHoursWindow): boolean {
	const totalMinutesUtc = Math.floor(timestampMs / 60_000);
	const localMinute = (((totalMinutesUtc + window.utcOffsetMinutes) % 1440) + 1440) % 1440;
	if (window.startMinute < window.endMinute) {
		return localMinute >= window.startMinute && localMinute < window.endMinute;
	}
	// Overnight wrap (e.g. 23:00 -> 08:00).
	return localMinute >= window.startMinute || localMinute < window.endMinute;
}

/** True when a background turn's text is empty or equals the `[SILENT]` no-op sentinel. */
export function isSilentReplyText(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.length === 0 || trimmed === SILENT_REPLY_TOKEN;
}

/** Stateful deterministic governor managing proactive rate cooldowns and held-notification digests. */
export class ProactiveNotificationGovernor {
	readonly #policy: ProactiveQuietPolicy;
	readonly #lastSentAtByRoute = new Map<string, number>();
	readonly #held: HeldProactiveMessage[] = [];

	constructor(policy?: ProactiveQuietPolicy) {
		this.#policy = policy ?? {};
	}

	/** Current count of deferred proactive notifications held across all routes. */
	get heldCount(): number {
		return this.#held.length;
	}

	/** Read-only snapshot of currently held proactive notifications. */
	heldMessages(): readonly HeldProactiveMessage[] {
		return [...this.#held];
	}

	/** Evaluates whether a proactive notification should be dropped (`[SILENT]`), held, or delivered now. */
	evaluate(params: {
		readonly route: ChannelRoute;
		readonly text: string;
		readonly urgency?: "normal" | "urgent";
		readonly isBusy: boolean;
		readonly nowMs: number;
	}): ProactiveGateDecision {
		if (isSilentReplyText(params.text)) {
			return { action: "drop_silent" };
		}
		if (params.urgency === "urgent") {
			return { action: "deliver" };
		}
		if (this.#policy.quietHours !== undefined && isWithinQuietHours(params.nowMs, this.#policy.quietHours)) {
			this.#held.push({
				route: params.route,
				text: params.text.trim(),
				reason: "quiet_hours",
				heldAtMs: params.nowMs,
			});
			return { action: "hold", reason: "quiet_hours", heldCount: this.#held.length };
		}
		const yieldWhenBusy = this.#policy.yieldWhenBusy ?? true;
		if (yieldWhenBusy && params.isBusy) {
			this.#held.push({
				route: params.route,
				text: params.text.trim(),
				reason: "busy_yield",
				heldAtMs: params.nowMs,
			});
			return { action: "hold", reason: "busy_yield", heldCount: this.#held.length };
		}
		const minInterval = this.#policy.minIntervalMs ?? 0;
		const routeKey = formatRouteKey(params.route.channel, params.route.chatId);
		const lastSent = this.#lastSentAtByRoute.get(routeKey);
		if (minInterval > 0 && lastSent !== undefined && params.nowMs - lastSent < minInterval) {
			this.#held.push({
				route: params.route,
				text: params.text.trim(),
				reason: "rate_cooldown",
				heldAtMs: params.nowMs,
			});
			return { action: "hold", reason: "rate_cooldown", heldCount: this.#held.length };
		}
		return { action: "deliver" };
	}

	/** Records that a proactive notification was actually transmitted to `route` at `nowMs`. */
	recordDelivered(route: ChannelRoute, nowMs: number): void {
		this.#lastSentAtByRoute.set(formatRouteKey(route.channel, route.chatId), nowMs);
	}

	/** True when `nowMs` is currently outside the configured quiet-hours window (safe for automatic digest flush). */
	isOutsideQuietHours(nowMs: number): boolean {
		if (this.#policy.quietHours === undefined) return true;
		return !isWithinQuietHours(nowMs, this.#policy.quietHours);
	}

	/** Drains held notifications (optionally filtered to one `route`) grouped by route key. */
	drainHeld(targetRoute?: ChannelRoute): ReadonlyArray<{
		readonly route: ChannelRoute;
		readonly digestText: string;
		readonly count: number;
	}> {
		if (this.#held.length === 0) return [];
		const targetKey = targetRoute !== undefined ? formatRouteKey(targetRoute.channel, targetRoute.chatId) : undefined;
		const matched: HeldProactiveMessage[] = [];
		const remaining: HeldProactiveMessage[] = [];

		for (const item of this.#held) {
			const key = formatRouteKey(item.route.channel, item.route.chatId);
			if (targetKey === undefined || key === targetKey) {
				matched.push(item);
			} else {
				remaining.push(item);
			}
		}
		this.#held.length = 0;
		this.#held.push(...remaining);

		const grouped = new Map<string, { route: ChannelRoute; texts: string[] }>();
		for (const item of matched) {
			const key = formatRouteKey(item.route.channel, item.route.chatId);
			let bucket = grouped.get(key);
			if (bucket === undefined) {
				bucket = { route: item.route, texts: [] };
				grouped.set(key, bucket);
			}
			bucket.texts.push(item.text);
		}

		const out: Array<{ route: ChannelRoute; digestText: string; count: number }> = [];
		for (const { route, texts } of grouped.values()) {
			const digestText =
				texts.length === 1
					? `[暂存通知补发]\n${texts[0]!}`
					: `[暂存通知汇总（共 ${texts.length} 条）]\n${texts.map((t, i) => `${i + 1}. ${t}`).join("\n\n")}`;
			out.push({ route, digestText, count: texts.length });
		}
		return out;
	}
}
