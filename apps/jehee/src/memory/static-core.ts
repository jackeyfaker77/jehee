// Baseline memory provider that keeps a static L1 core prompt warm in the KV-cache and records completed turns.

import type { MemoryProvider, TurnCompletedEvent } from "./contract.ts";

/** Options for creating a StaticCoreMemoryProvider. */
export type StaticCoreMemoryOptions = {
	readonly id?: string;
	readonly corePrompt: string;
	readonly onTurn?: (event: TurnCompletedEvent) => void | Promise<void>;
};

/** Default zero-magic memory provider used out of the box before specialized drawer strategies are mounted. */
export class StaticCoreMemoryProvider implements MemoryProvider {
	readonly id: string;
	readonly #corePrompt: string;
	readonly #onTurn: ((event: TurnCompletedEvent) => void | Promise<void>) | undefined;
	readonly #archivedTurns: TurnCompletedEvent[] = [];

	constructor(options: StaticCoreMemoryOptions) {
		this.id = options.id ?? "static-core";
		this.#corePrompt = options.corePrompt;
		this.#onTurn = options.onTurn;
	}

	/** Snapshot of turns recorded by this provider instance. */
	get archivedTurns(): readonly TurnCompletedEvent[] {
		return this.#archivedTurns;
	}

	/** Returns the static core prompt; omitted when blank so empty prompts add no section tag. */
	renderCorePrompt(): string | undefined {
		const trimmed = this.#corePrompt.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}

	/** Records the completed turn in memory and forwards to any configured observer. */
	async onTurnCompleted(event: TurnCompletedEvent): Promise<void> {
		this.#archivedTurns.push(event);
		if (this.#onTurn !== undefined) {
			await this.#onTurn(event);
		}
	}
}
