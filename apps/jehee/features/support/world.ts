// Cucumber World context managing isolated temporary SQLite files, deterministic faux model steps, and JeheeHost teardown.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { After, setWorldConstructor, World } from "@cucumber/cucumber";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep, Message, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Extension } from "@earendil-works/pi-durable";
import { JeheeHost, type JeheePendingTurn, type JeheeTurnReply } from "../../src/core/host.ts";
import type { MemoryProvider } from "../../src/memory/contract.ts";
import type { StaticCoreMemoryProvider } from "../../src/memory/static-core.ts";

/** Shared scenario state for Jehee BDD steps. */
export class JeheeWorld extends World {
	readonly ctx = BACKGROUND_CONTEXT;
	readonly faux: FauxProviderHandle = fauxProvider();
	readonly models = createModels();
	readonly capturedContexts: TranscriptContext[] = [];
	tempDir: string | undefined;
	sqlitePath: string | undefined;
	host: JeheeHost | undefined;
	staticMemory: StaticCoreMemoryProvider | undefined;
	scriptedReplies: FauxResponseStep[] = [];
	lastReply: JeheeTurnReply | undefined;
	duplicateReply: JeheeTurnReply | undefined;
	pendingFirstTurn: JeheePendingTurn | undefined;
	pendingSteerTurn: JeheePendingTurn | undefined;
	toolEntered: Promise<void> | undefined;
	releaseSlowTool: (() => void) | undefined;
	customExtensions: Extension[] = [];

	constructor(options: ConstructorParameters<typeof World>[0]) {
		super(options);
		this.models.setProvider(this.faux.provider);
	}

	/** Installs scripted responses wrapped to record every TranscriptContext sent to the model. */
	installScriptedSteps(steps: readonly FauxResponseStep[]): void {
		const wrapped: FauxResponseStep[] = steps.map((step) => {
			if (typeof step === "function") {
				return async (context, options, state, model) => {
					this.capturedContexts.push(context);
					return step(context, options, state, model);
				};
			}
			return (context) => {
				this.capturedContexts.push(context);
				return step;
			};
		});
		this.faux.setResponses(wrapped);
	}

	/** Opens a JeheeHost against memory or a scenario-scoped temporary SQLite file. */
	async openHost(mode: "memory" | "sqlite", memory?: MemoryProvider): Promise<JeheeHost> {
		if (mode === "sqlite" && this.sqlitePath === undefined) {
			this.tempDir = await mkdtemp(join(tmpdir(), "jehee-bdd-"));
			this.sqlitePath = join(this.tempDir, "jehee.sqlite");
		}
		const storage =
			mode === "memory" ? ({ kind: "memory" } as const) : ({ kind: "sqlite", path: this.sqlitePath! } as const);
		this.host = await JeheeHost.open(
			{
				storage,
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				memory,
				extensions: this.customExtensions,
			},
			this.ctx,
		);
		return this.host;
	}

	/** Extracts all rendered text from every system message in the latest captured model request. */
	latestSystemSnapshot(): string {
		const latest = this.capturedContexts.at(-1);
		if (latest === undefined) return "";
		const parts: string[] = [];
		for (const msg of latest.messages) {
			if (msg.role !== "system") continue;
			if (typeof msg.content === "string") {
				parts.push(msg.content);
			} else {
				for (const item of msg.content) {
					parts.push(item.text);
				}
			}
			if (msg.sections !== undefined) {
				for (const [key, val] of Object.entries(msg.sections)) {
					if (val !== null) parts.push(`<${key}>\n${val}\n</${key}>`);
				}
			}
		}
		return parts.join("\n");
	}

	/** Flattens all user message texts in the latest captured model request. */
	latestRequestUserTexts(): string[] {
		const latest = this.capturedContexts.at(-1);
		if (latest === undefined) return [];
		return collectUserTexts(latest.messages);
	}

	/** Cleans up any running host and temporary SQLite directory after each scenario. */
	async cleanup(): Promise<void> {
		if (this.releaseSlowTool !== undefined) {
			this.releaseSlowTool();
			this.releaseSlowTool = undefined;
		}
		if (this.host !== undefined) {
			await this.host.close(this.ctx);
			this.host = undefined;
		}
		if (this.tempDir !== undefined) {
			await rm(this.tempDir, { recursive: true, force: true });
			this.tempDir = undefined;
			this.sqlitePath = undefined;
		}
	}
}

function collectUserTexts(messages: readonly Message[]): string[] {
	const texts: string[] = [];
	for (const msg of messages) {
		if (msg.role !== "user") continue;
		if (typeof msg.content === "string") {
			texts.push(msg.content);
		} else {
			for (const block of msg.content) {
				if (block.type === "text") texts.push(block.text);
			}
		}
	}
	return texts;
}

setWorldConstructor(JeheeWorld);

After(async function (this: JeheeWorld) {
	await this.cleanup();
});
