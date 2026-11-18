// Runtime environment parser shared between local Node CLI (`bin.ts`) and Cloudflare Workers (`worker.ts`).

import type { ModelRef } from "@earendil-works/pi-durable";
import type { WriteApprovalPolicy } from "../governance/approvals.ts";
import { type ProactiveQuietPolicy, parseQuietHoursWindow } from "../governance/quiet-gate.ts";
import { type ParsedStdioServerInput, parseMcpConfigJson, parseMcpExposureEnv } from "../mcp/config.ts";
import type { JeheeMcpExposure, JeheeMcpOptions, JeheeMcpServerSpec } from "../mcp/contract.ts";
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
	readonly mcp?: JeheeMcpOptions;
	readonly mcpExposure?: JeheeMcpExposure;
	readonly writeGate?: WriteApprovalPolicy;
	readonly quietPolicy?: ProactiveQuietPolicy;
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
export function parseJeheeEnvConfig(
	env: EnvDictionary,
	options?: {
		readonly stdioFactory?: (input: ParsedStdioServerInput) => JeheeMcpServerSpec;
	},
): JeheeRuntimeConfig {
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

	const mcpExposure = parseMcpExposureEnv(env.JEHEE_MCP_EXPOSURE);
	const rawWriteGate = env.JEHEE_MCP_WRITE_GATE?.trim();
	let writeGate: WriteApprovalPolicy | undefined;
	if (rawWriteGate !== undefined && rawWriteGate.length > 0) {
		if (rawWriteGate === "off") {
			writeGate = { mode: "off" };
		} else if (rawWriteGate === "confirm-writes") {
			const exempt = splitCsv(env.JEHEE_MCP_WRITE_EXEMPT);
			writeGate = {
				mode: "confirm-writes",
				...(exempt.length > 0 ? { exemptTools: exempt } : {}),
			};
		} else {
			throw new Error(`Invalid JEHEE_MCP_WRITE_GATE "${rawWriteGate}": expected "confirm-writes" or "off"`);
		}
	}

	const rawMcpJson = env.JEHEE_MCP_SERVERS?.trim();
	const parsedMcp =
		rawMcpJson !== undefined && rawMcpJson.length > 0
			? parseMcpConfigJson(rawMcpJson, {
					env,
					sourceLabel: "JEHEE_MCP_SERVERS",
					...(mcpExposure !== undefined ? { exposureOverride: mcpExposure } : {}),
					...(options?.stdioFactory !== undefined ? { stdioFactory: options.stdioFactory } : {}),
				})
			: undefined;
	const mcp = parsedMcp !== undefined && writeGate !== undefined ? { ...parsedMcp, writeGate } : parsedMcp;

	const rawQuietHours = env.JEHEE_QUIET_HOURS?.trim();
	const tzOffset = env.JEHEE_TZ_OFFSET?.trim() || "+08:00";
	const quietHours =
		rawQuietHours !== undefined && rawQuietHours.length > 0
			? parseQuietHoursWindow(rawQuietHours, tzOffset)
			: undefined;

	const rawCooldown = env.JEHEE_PROACTIVE_COOLDOWN_MS?.trim();
	const cooldownMs = rawCooldown !== undefined && rawCooldown.length > 0 ? Number(rawCooldown) : undefined;
	if (cooldownMs !== undefined && (!Number.isFinite(cooldownMs) || cooldownMs < 0)) {
		throw new Error(`Invalid JEHEE_PROACTIVE_COOLDOWN_MS "${rawCooldown}": must be a non-negative number`);
	}

	const quietPolicy: ProactiveQuietPolicy | undefined =
		quietHours !== undefined || cooldownMs !== undefined
			? {
					...(quietHours !== undefined ? { quietHours } : {}),
					...(cooldownMs !== undefined ? { minIntervalMs: cooldownMs } : {}),
				}
			: undefined;

	return {
		defaultModel,
		instructions: env.JEHEE_INSTRUCTIONS?.trim() || DEFAULT_JEHEE_INSTRUCTIONS,
		coreMemoryPrompt: env.JEHEE_CORE_MEMORY?.trim() ?? "",
		...(telegram !== undefined ? { telegram } : {}),
		stagingAllowedRoutes: splitCsv(env.JEHEE_STAGING_ROUTES),
		debounceMs,
		...(instabox !== undefined ? { instabox } : {}),
		...(mcp !== undefined ? { mcp } : {}),
		...(mcpExposure !== undefined ? { mcpExposure } : {}),
		...(writeGate !== undefined ? { writeGate } : {}),
		...(quietPolicy !== undefined ? { quietPolicy } : {}),
	};
}
