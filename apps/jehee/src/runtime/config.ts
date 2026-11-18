// Runtime environment parser shared between local Node CLI (`bin.ts`) and Cloudflare Workers (`worker.ts`).

import type { ModelRef } from "@earendil-works/pi-durable";
import { createJeheeModels, DEFAULT_JEHEE_MODEL_SPEC, type EnvDictionary, resolveModelSpec } from "./models.ts";

/** Parsed and validated configuration driving a Jehee runtime instance. */
export type JeheeRuntimeConfig = {
	readonly defaultModel: ModelRef;
	readonly instructions: string;
	readonly coreMemoryPrompt: string;
	readonly telegram?: {
		readonly botToken: string;
		readonly webhookSecret?: string;
		readonly allowedUsers: readonly string[];
	};
	readonly stagingAllowedRoutes: readonly string[];
	readonly debounceMs: number;
	readonly instabox?: {
		readonly apiKey: string;
		readonly machineId: string;
		readonly baseUrl?: string;
		readonly worktreesRoot?: string;
	};
};

const DEFAULT_JEHEE_INSTRUCTIONS =
	"You are Jehee, an always-on personal colleague. Reply concisely and directly. Delegate heavy coding or shell tasks to the workshop tool when available instead of blocking the main chat.";

function splitCsv(raw: string | undefined): string[] {
	if (raw === undefined) return [];
	return raw
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

/** Parses and validates a `JeheeRuntimeConfig` from an environment dictionary. */
export function parseJeheeEnvConfig(env: EnvDictionary): JeheeRuntimeConfig {
	const models = createJeheeModels(env);
	const modelSpec = env.JEHEE_MODEL?.trim() || DEFAULT_JEHEE_MODEL_SPEC;
	const defaultModel = resolveModelSpec(modelSpec, models);

	const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
	const telegram =
		botToken !== undefined && botToken.length > 0
			? {
					botToken,
					...(env.TELEGRAM_WEBHOOK_SECRET?.trim() ? { webhookSecret: env.TELEGRAM_WEBHOOK_SECRET.trim() } : {}),
					allowedUsers: splitCsv(env.TELEGRAM_ALLOWED_USERS),
				}
			: undefined;

	const ibKey = env.INSTABOX_API_KEY?.trim();
	const ibMachine = env.INSTABOX_MACHINE_ID?.trim();
	const instabox =
		ibKey !== undefined && ibKey.length > 0 && ibMachine !== undefined && ibMachine.length > 0
			? {
					apiKey: ibKey,
					machineId: ibMachine,
					...(env.INSTABOX_BASE_URL?.trim() ? { baseUrl: env.INSTABOX_BASE_URL.trim() } : {}),
					...(env.INSTABOX_WORKTREES_ROOT?.trim() ? { worktreesRoot: env.INSTABOX_WORKTREES_ROOT.trim() } : {}),
				}
			: undefined;

	const rawDebounce = env.JEHEE_DEBOUNCE_MS?.trim();
	const debounceMs = rawDebounce !== undefined && rawDebounce.length > 0 ? Number(rawDebounce) : 0;
	if (!Number.isFinite(debounceMs) || debounceMs < 0) {
		throw new Error(`Invalid JEHEE_DEBOUNCE_MS "${rawDebounce}": must be a non-negative number`);
	}

	return {
		defaultModel,
		instructions: env.JEHEE_INSTRUCTIONS?.trim() || DEFAULT_JEHEE_INSTRUCTIONS,
		coreMemoryPrompt: env.JEHEE_CORE_MEMORY?.trim() ?? "",
		...(telegram !== undefined ? { telegram } : {}),
		stagingAllowedRoutes: splitCsv(env.JEHEE_STAGING_ROUTES),
		debounceMs,
		...(instabox !== undefined ? { instabox } : {}),
	};
}
