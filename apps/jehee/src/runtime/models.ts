// Curated, Edge-friendly model catalog for Jehee with first-class support for OpenCode Go (`opencode-go`) alongside
// OpenCode, DeepSeek, OpenAI, Anthropic, Google, and OpenRouter. Avoids importing heavy enterprise SDKs like AWS Bedrock
// so Cloudflare Workers bundles stay well under the 3 MB Free Plan limit.

import type { AuthContext, Models, MutableModels } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ModelRef } from "@earendil-works/pi-durable";

/** Default model specification when `JEHEE_MODEL` is unset. */
export const DEFAULT_JEHEE_MODEL_SPEC = "opencode-go/glm-5.3-flash";

/** Environment dictionary accepted by both Node (`process.env` / `.env`) and Cloudflare Workers (`env` bindings). */
export type EnvDictionary = Readonly<Record<string, string | undefined>>;

function createEnvAuthContext(envMap: EnvDictionary): AuthContext {
	return {
		async env(name: string): Promise<string | undefined> {
			const direct = readNonEmpty(envMap[name]);
			if (direct !== undefined) return direct;
			if (name === "OPENCODE_API_KEY") {
				const alias = readNonEmpty(envMap.OPENCODE_GO_API_KEY);
				if (alias !== undefined) return alias;
			}
			const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
			const fromProcess = readNonEmpty(proc?.env?.[name]);
			if (fromProcess !== undefined) return fromProcess;
			if (name === "OPENCODE_API_KEY") {
				return readNonEmpty(proc?.env?.OPENCODE_GO_API_KEY);
			}
			return undefined;
		},
		async fileExists(): Promise<boolean> {
			return false;
		},
	};
}

function readNonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Creates a `Models` registry populated with `opencode-go` and core providers, wired to `envMap` credentials. */
export function createJeheeModels(envMap: EnvDictionary = {}): MutableModels {
	const models = createModels({
		authContext: createEnvAuthContext(envMap),
		identity: { attribution: { name: "jehee", url: "https://github.com/jackeyfaker77/jehee" } },
	});
	models.setProvider(opencodeGoProvider());
	models.setProvider(opencodeProvider());
	models.setProvider(deepseekProvider());
	models.setProvider(openaiProvider());
	models.setProvider(anthropicProvider());
	models.setProvider(googleProvider());
	models.setProvider(openrouterProvider());
	return models;
}

/** Parses and validates a `"<provider>/<modelId>"` string against `models`, throwing a helpful error on typos. */
export function resolveModelSpec(spec: string, models: Models): ModelRef {
	const trimmed = spec.trim();
	const slashIdx = trimmed.indexOf("/");
	if (slashIdx <= 0 || slashIdx === trimmed.length - 1) {
		throw new Error(
			`Invalid JEHEE_MODEL "${spec}": expected "<provider>/<modelId>", e.g. "${DEFAULT_JEHEE_MODEL_SPEC}"`,
		);
	}
	const provider = trimmed.slice(0, slashIdx);
	const modelId = trimmed.slice(slashIdx + 1);
	const providerObj = models.getProvider(provider);
	if (providerObj === undefined) {
		const known = models
			.getProviders()
			.map((p) => p.id)
			.join(", ");
		throw new Error(`Unknown model provider "${provider}". Registered providers: ${known}`);
	}
	const found = models.getModel(provider, modelId);
	if (found === undefined) {
		const candidates = models
			.getModels(provider)
			.slice(0, 12)
			.map((m) => `${provider}/${m.id}`)
			.join(", ");
		throw new Error(`Model "${modelId}" not found under provider "${provider}". Available examples: ${candidates}`);
	}
	return { provider, modelId };
}
