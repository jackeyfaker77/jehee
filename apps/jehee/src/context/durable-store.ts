// Session-scoped `pi-durable` document tracking seamless window handoff and compaction metrics.
// Kept 100% Web/Edge portable (zero `node:*` imports).

import { defineDoc } from "@earendil-works/pi-durable";
import { createEmptyHandoffState, type HandoffState } from "./handoff.ts";

/** Durable session-scoped document recording compaction and manual handoff counts, timestamps, and token savings. */
export const HandoffDoc = defineDoc<HandoffState>({
	kind: "jehee.context.handoff",
	version: 1,
	scope: "session",
	initial: () => createEmptyHandoffState(),
	checkpointWhen: () => false,
});
