// Session-scoped `pi-durable` documents storing Jehee's atomic memory items and consolidation high-water mark
// across restarts, DO hibernations, and future conversation handoffs. Kept 100% Web/Edge portable (zero `node:*` imports).

import { defineDoc } from "@earendil-works/pi-durable";
import { createEmptyMemoryStoreState } from "./atomic-memory.ts";
import { createEmptyConsolidationState } from "./consolidator.ts";
import type { MemoryConsolidationState, MemoryStoreState } from "./contract.ts";

/** Durable session-scoped document holding all atomic memory records and their monotonic ID counter. */
export const MemoryDoc = defineDoc<MemoryStoreState>({
	kind: "jehee.memory.store",
	version: 1,
	scope: "session",
	initial: () => createEmptyMemoryStoreState(),
	checkpointWhen: () => false,
});

/** Durable session-scoped document holding background consolidation watermark, idle schedule, and cumulative counters. */
export const MemoryConsolidationDoc = defineDoc<MemoryConsolidationState>({
	kind: "jehee.memory.consolidation",
	version: 1,
	scope: "session",
	initial: () => createEmptyConsolidationState(),
	checkpointWhen: () => false,
});
