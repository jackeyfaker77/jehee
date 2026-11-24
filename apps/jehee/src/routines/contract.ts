// Pure contract types for Slice 6A proactive scheduled reminders, recurring routines, and persisted delivery route.
// Kept 100% Web/Edge portable (zero `pi-durable` or `node:*` imports).

/** Supported execution modes when a scheduled routine fires. */
export type RoutineMode = "direct_notify" | "agent_prompt";

/** Urgency level determining whether proactive delivery respects quiet hours (`"normal"`) or bypasses them (`"urgent"`). */
export type RoutineUrgency = "normal" | "urgent";

/** Declarative schedule specification evaluated deterministically using explicit UTC offsets. */
export type RoutineSchedule =
	| {
			readonly kind: "once";
			/** Target execution timestamp in epoch milliseconds. */
			readonly runAtMs: number;
	  }
	| {
			readonly kind: "daily";
			/** Local hour `[0, 23]`. */
			readonly hour: number;
			/** Local minute `[0, 59]`. */
			readonly minute: number;
			/** Fixed UTC offset in minutes (e.g. `480` for `UTC+08:00`). */
			readonly utcOffsetMinutes: number;
	  }
	| {
			readonly kind: "weekly";
			/** Local day of week `0` (Sunday) through `6` (Saturday). */
			readonly weekday: number;
			/** Local hour `[0, 23]`. */
			readonly hour: number;
			/** Local minute `[0, 59]`. */
			readonly minute: number;
			/** Fixed UTC offset in minutes (e.g. `480` for `UTC+08:00`). */
			readonly utcOffsetMinutes: number;
	  }
	| {
			readonly kind: "interval";
			/** Repeat interval in milliseconds (`>= 50`). */
			readonly intervalMs: number;
			/** Optional anchor timestamp in epoch ms aligning periodic slots. */
			readonly anchorMs?: number;
	  };

/** One durable scheduled reminder or recurring routine persisted in `RoutineDoc`. */
export type RoutineItem = {
	id: string;
	title: string;
	mode: RoutineMode;
	payload: string;
	schedule: RoutineSchedule;
	urgency: RoutineUrgency;
	enabled: boolean;
	nextRunAtMs?: number;
	lastRunAtMs?: number;
	lastFiredKey?: string;
	runCount: number;
	createdAtMs: number;
	updatedAtMs: number;
};

/** Persistent state stored in `RoutineDoc` (`kind: "jehee.routines"`, `scope: "session"`). */
export type RoutineStoreState = {
	seq: number;
	items: Record<string, RoutineItem>;
	/** Numeric `TaskId` of the active single-flight `RoutineSchedulerTask`, if scheduled. */
	scheduledTaskId?: number;
	/** Earliest timestamp currently awaited by the single-flight scheduler task. */
	scheduledForMs?: number;
	/** Active wake signal key listened on by the sleeping scheduler task for early reschedule. */
	wakeSignalKey?: string;
};

/** Persistent last active owner delivery route stored in `LastRouteDoc` (`kind: "jehee.last_route"`, `scope: "session"`). */
export type LastRouteState = {
	channel?: string;
	chatId?: string;
	updatedAtMs?: number;
};

/** Input payload for creating a new routine via `JeheeHost.createRoutine` or `routine_create`. */
export type RoutineCreateInput = {
	readonly title: string;
	readonly mode: RoutineMode;
	readonly payload: string;
	readonly schedule: RoutineSchedule;
	readonly urgency?: RoutineUrgency;
};

/** Outcome of creating a routine item inside `RoutineStoreState`. */
export type RoutineCreateResult =
	| { readonly ok: true; readonly item: RoutineItem }
	| { readonly ok: false; readonly reason: "invalid_input"; readonly message: string };

/** Outcome of deleting (cancelling) a routine item by ID. */
export type RoutineDeleteResult =
	| { readonly ok: true; readonly item: RoutineItem }
	| { readonly ok: false; readonly reason: "not_found"; readonly id: string };

/** Zero-token direct notification payload emitted when a `direct_notify` routine fires. */
export type DirectNotifyEvent = {
	readonly routineId: string;
	readonly title: string;
	readonly text: string;
	readonly urgency: RoutineUrgency;
	readonly fireAtMs: number;
	readonly dedupeKey: string;
};

/** Listener invoked when a `direct_notify` routine fires (zero LLM tokens). */
export type DirectNotifyListener = (event: DirectNotifyEvent) => void | Promise<void>;

/** Settled outcome of manually running a routine via `JeheeHost.runRoutineNow` or `/routines run <id>`. */
export type RoutineRunOutcome =
	| { readonly ok: false; readonly reason: "not_found"; readonly id: string }
	| {
			readonly ok: true;
			readonly routineId: string;
			readonly title: string;
			readonly mode: "direct_notify";
			readonly deliveredText: string;
			readonly fireAtMs: number;
	  }
	| {
			readonly ok: true;
			readonly routineId: string;
			readonly title: string;
			readonly mode: "agent_prompt";
			readonly suppressedSilent: boolean;
			readonly replyText: string;
			readonly fireAtMs: number;
	  }
	| {
			readonly ok: false;
			readonly reason: "unanswered";
			readonly routineId: string;
			readonly message: string;
	  };
