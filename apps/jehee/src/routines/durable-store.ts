// Session-scoped `pi-durable` documents storing Jehee's scheduled routines and last active owner delivery route
// across restarts, process crashes, and Cloudflare Durable Object hibernations. 100% Web/Edge portable.

import { defineDoc } from "@earendil-works/pi-durable";
import type { LastRouteState, RoutineStoreState } from "./contract.ts";
import { createEmptyLastRouteState, createEmptyRoutineStoreState } from "./scheduler.ts";

/** Durable session-scoped document holding all scheduled reminders/routines and the single-flight scheduler task ID. */
export const RoutineDoc = defineDoc<RoutineStoreState>({
	kind: "jehee.routines",
	version: 1,
	scope: "session",
	initial: () => createEmptyRoutineStoreState(),
	checkpointWhen: () => false,
});

/** Durable session-scoped document persisting the owner's last active `{ channel, chatId }` delivery route. */
export const LastRouteDoc = defineDoc<LastRouteState>({
	kind: "jehee.last_route",
	version: 1,
	scope: "session",
	initial: () => createEmptyLastRouteState(),
	checkpointWhen: () => false,
});
