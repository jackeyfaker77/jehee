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

/** Decision returned by `ProactiveNotificationGovernor.classify` (pure, without mutating in-memory held queue). */
export type ProactiveClassification =
	| { readonly action: "drop_silent" }
	| { readonly action: "deliver" }
	| { readonly action: "hold"; readonly reason: ProactiveHoldReason };

/** Decision returned by `ProactiveNotificationGovernor.evaluate`. */
export type ProactiveGateDecision =
	| { readonly action: "drop_silent" }
	| { readonly action: "deliver" }
	| { readonly action: "hold"; readonly reason: ProactiveHoldReason; readonly heldCount: number };

/** Grouped outbound digest batch formatted from one or more deferred proactive notifications for a single route. */
export type HeldNotificationBatch = {
	readonly route: ChannelRoute;
	readonly digestText: string;
	readonly count: number;
};

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
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
	const totalMinutesUtc = Math.floor(timestampMs / MINUTE_MS);
	const localMinute = (((totalMinutesUtc + window.utcOffsetMinutes) % 1440) + 1440) % 1440;
	if (window.startMinute < window.endMinute) {
		return localMinute >= window.startMinute && localMinute < window.endMinute;
	}
	// Overnight wrap (e.g. 23:00 -> 08:00).
	return localMinute >= window.startMinute || localMinute < window.endMinute;
}

/**
 * Computes the exact epoch millisecond timestamp when `window` next ends (`> nowMs`) using pure UTC-offset arithmetic
 * (zero host OS timezone dependency). When `isWithinQuietHours(nowMs, window)` is true, this is the exact end of the
 * active quiet window; otherwise it is the end of the next upcoming quiet window.
 */
export function computeNextQuietEndMs(window: QuietHoursWindow, nowMs: number): number {
	const offsetMs = window.utcOffsetMinutes * MINUTE_MS;
	const localNowMs = nowMs + offsetMs;
	const local = new Date(localNowMs);
	const endHour = Math.floor(window.endMinute / 60);
	const endMinute = window.endMinute % 60;
	let candidateLocalMs = Date.UTC(
		local.getUTCFullYear(),
		local.getUTCMonth(),
		local.getUTCDate(),
		endHour,
		endMinute,
		0,
		0,
	);
	if (candidateLocalMs <= localNowMs) {
		candidateLocalMs += DAY_MS;
	}
	return candidateLocalMs - offsetMs;
}

/** Groups deferred proactive notifications by route key and formats each route's digest message. */
export function formatHeldNotificationBatches(items: readonly HeldProactiveMessage[]): HeldNotificationBatch[] {
	if (items.length === 0) return [];
	const grouped = new Map<string, { route: ChannelRoute; texts: string[] }>();
	for (const item of items) {
		const key = formatRouteKey(item.route.channel, item.route.chatId);
		let bucket = grouped.get(key);
		if (bucket === undefined) {
			bucket = { route: { channel: item.route.channel, chatId: item.route.chatId }, texts: [] };
			grouped.set(key, bucket);
		}
		bucket.texts.push(item.text);
	}

	const out: HeldNotificationBatch[] = [];
	for (const { route, texts } of grouped.values()) {
		const digestText =
			texts.length === 1
				? `[暂存通知补发]\n${texts[0]!}`
				: `[暂存通知汇总（共 ${texts.length} 条）]\n${texts.map((t, i) => `${i + 1}. ${t}`).join("\n\n")}`;
		out.push({ route, digestText, count: texts.length });
	}
	return out;
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

	/** Configured quiet-hours window, if any. */
	get quietHours(): QuietHoursWindow | undefined {
		return this.#policy.quietHours;
	}

	/** Current count of deferred proactive notifications held across all routes. */
	get heldCount(): number {
		return this.#held.length;
	}

	/** Read-only snapshot of currently held proactive notifications. */
	heldMessages(): readonly HeldProactiveMessage[] {
		return [...this.#held];
	}

	/**
	 * Evaluates the policy action (`drop_silent` / `deliver` / `hold`) without mutating the in-memory held buffer,
	 * enabling durable callers backed by `HeldNotificationsDoc` to persist held items directly.
	 */
	classify(params: {
		readonly route: ChannelRoute;
		readonly text: string;
		readonly urgency?: "normal" | "urgent";
		readonly isBusy: boolean;
		readonly nowMs: number;
	}): ProactiveClassification {
		if (isSilentReplyText(params.text)) {
			return { action: "drop_silent" };
		}
		if (params.urgency === "urgent") {
			return { action: "deliver" };
		}
		if (this.#policy.quietHours !== undefined && isWithinQuietHours(params.nowMs, this.#policy.quietHours)) {
			return { action: "hold", reason: "quiet_hours" };
		}
		const yieldWhenBusy = this.#policy.yieldWhenBusy ?? true;
		if (yieldWhenBusy && params.isBusy) {
			return { action: "hold", reason: "busy_yield" };
		}
		const minInterval = this.#policy.minIntervalMs ?? 0;
		const routeKey = formatRouteKey(params.route.channel, params.route.chatId);
		const lastSent = this.#lastSentAtByRoute.get(routeKey);
		if (minInterval > 0 && lastSent !== undefined && params.nowMs - lastSent < minInterval) {
			return { action: "hold", reason: "rate_cooldown" };
		}
		return { action: "deliver" };
	}

	/** Evaluates whether a proactive notification should be dropped (`[SILENT]`), held, or delivered now. */
	evaluate(params: {
		readonly route: ChannelRoute;
		readonly text: string;
		readonly urgency?: "normal" | "urgent";
		readonly isBusy: boolean;
		readonly nowMs: number;
	}): ProactiveGateDecision {
		const decision = this.classify(params);
		if (decision.action !== "hold") {
			return decision;
		}
		this.#held.push({
			route: { channel: params.route.channel, chatId: params.route.chatId },
			text: params.text.trim(),
			reason: decision.reason,
			heldAtMs: params.nowMs,
		});
		return { action: "hold", reason: decision.reason, heldCount: this.#held.length };
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

	/** Computes the next quiet-hours window end timestamp (`> nowMs`), or `undefined` if no quiet window is configured. */
	nextQuietEndMs(nowMs: number): number | undefined {
		if (this.#policy.quietHours === undefined) return undefined;
		return computeNextQuietEndMs(this.#policy.quietHours, nowMs);
	}

	/** Drains held notifications (optionally filtered to one `route`) grouped by route key. */
	drainHeld(targetRoute?: ChannelRoute): readonly HeldNotificationBatch[] {
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

		return formatHeldNotificationBatches(matched);
	}
}
