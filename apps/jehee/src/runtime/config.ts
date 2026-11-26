// Runtime environment parser shared between local Node CLI (`bin.ts`) and Cloudflare Workers (`worker.ts`).

import type { ModelRef } from "@earendil-works/pi-durable";
import {
	DEFAULT_HANDOFF_KEEP_RECENT_TOKENS,
	DEFAULT_HANDOFF_SWEET_SPOT_TOKENS,
	type HandoffPolicy,
	resolveHandoffPolicy,
} from "../context/handoff.ts";
import type { WriteApprovalPolicy } from "../governance/approvals.ts";
import { type ProactiveQuietPolicy, parseQuietHoursWindow, parseUtcOffsetMinutes } from "../governance/quiet-gate.ts";
import { type ParsedStdioServerInput, parseMcpConfigJson, parseMcpExposureEnv } from "../mcp/config.ts";
import type { JeheeMcpExposure, JeheeMcpOptions, JeheeMcpServerSpec } from "../mcp/contract.ts";
import { DEFAULT_MAX_CORE_CHARS, parseMemoryProviderEnv } from "../memory/atomic-memory.ts";
import { DEFAULT_CONSOLIDATION_MIN_TURNS } from "../memory/consolidator.ts";
import type { MemoryConsolidationPolicy } from "../memory/contract.ts";
import {
	type CustomCodingAgentTemplate,
	parseWorkshopDriverName,
	type WorkshopDriverName,
} from "../workshop/coding-agent-driver.ts";
import { createJeheeModels, DEFAULT_JEHEE_MODEL_SPEC, type EnvDictionary, resolveModelSpec } from "./models.ts";

/** Parsed and validated configuration driving a Jehee runtime instance. */
export type JeheeRuntimeConfig = {
	readonly defaultModel: ModelRef;
	readonly instructions: string;
	readonly coreMemoryPrompt: string;
	readonly memoryProvider: "atomic" | "static";
	readonly memoryCoreMaxChars: number;
	readonly memoryConsolidation: MemoryConsolidationPolicy;
	readonly handoff: HandoffPolicy;
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
	readonly localWorkshop?: {
		readonly worktreesRoot: string;
		readonly defaultRepoPath?: string;
	};
	readonly workshopDriver?: WorkshopDriverName;
	readonly workshopAgentModel?: string;
	readonly workshopDefaultRepo?: string;
	readonly workshopCustomTemplate?: CustomCodingAgentTemplate;
	readonly mcp?: JeheeMcpOptions;
	readonly mcpExposure?: JeheeMcpExposure;
	readonly writeGate?: WriteApprovalPolicy;
	readonly quietPolicy?: ProactiveQuietPolicy;
	/** Optional live `web_search` configuration parsed from `TINYFISH_API_KEY`. */
	readonly webSearch?: {
		readonly provider: "tinyfish";
		readonly apiKey: string;
		readonly baseUrl?: string;
		readonly defaultLanguage?: string;
		readonly defaultLocation?: string;
	};
	/** Parsed fixed UTC offset in minutes from `JEHEE_TZ_OFFSET` (defaults to `+08:00` = `480`). */
	readonly utcOffsetMinutes: number;
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

function parseCustomAgentTemplateEnv(raw: string | undefined): CustomCodingAgentTemplate | undefined {
	const trimmed = raw?.trim();
	if (trimmed === undefined || trimmed.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		throw new Error(
			`Invalid JEHEE_WORKSHOP_CUSTOM_ARGV JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string") && parsed.length > 0) {
		return { initialArgv: parsed };
	}
	if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
		const rec = parsed as Record<string, unknown>;
		if (
			Array.isArray(rec.initialArgv) &&
			rec.initialArgv.every((x) => typeof x === "string") &&
			rec.initialArgv.length > 0
		) {
			const cont =
				rec.continueArgv !== undefined
					? Array.isArray(rec.continueArgv) && rec.continueArgv.every((x) => typeof x === "string")
						? (rec.continueArgv as string[])
						: undefined
					: undefined;
			if (rec.continueArgv !== undefined && cont === undefined) {
				throw new Error("JEHEE_WORKSHOP_CUSTOM_ARGV.continueArgv must be an array of strings");
			}
			return {
				initialArgv: rec.initialArgv as string[],
				...(cont !== undefined ? { continueArgv: cont } : {}),
			};
		}
	}
	throw new Error(
		'JEHEE_WORKSHOP_CUSTOM_ARGV must be a non-empty string array or `{ "initialArgv": [...], "continueArgv"?: [...] }`',
	);
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

	const workshopDefaultRepo = env.JEHEE_WORKSHOP_DEFAULT_REPO?.trim() || undefined;
	const localRoot = env.JEHEE_WORKSHOP_LOCAL_ROOT?.trim();
	const localWorkshop =
		localRoot !== undefined && localRoot.length > 0
			? {
					worktreesRoot: localRoot,
					...(workshopDefaultRepo !== undefined ? { defaultRepoPath: workshopDefaultRepo } : {}),
				}
			: undefined;

	const rawDriver = env.JEHEE_WORKSHOP_DRIVER?.trim();
	const workshopDriver =
		rawDriver !== undefined && rawDriver.length > 0
			? parseWorkshopDriverName(rawDriver, "JEHEE_WORKSHOP_DRIVER")
			: undefined;
	const workshopAgentModel = env.JEHEE_WORKSHOP_AGENT_MODEL?.trim() || undefined;
	const workshopCustomTemplate = parseCustomAgentTemplateEnv(env.JEHEE_WORKSHOP_CUSTOM_ARGV);

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
	const utcOffsetMinutes = parseUtcOffsetMinutes(tzOffset);
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

	const memoryProvider = parseMemoryProviderEnv(env.JEHEE_MEMORY_PROVIDER) ?? "static";
	const rawCoreMaxChars = env.JEHEE_MEMORY_CORE_MAX_CHARS?.trim();
	const memoryCoreMaxChars =
		rawCoreMaxChars !== undefined && rawCoreMaxChars.length > 0 ? Number(rawCoreMaxChars) : DEFAULT_MAX_CORE_CHARS;
	if (!Number.isFinite(memoryCoreMaxChars) || memoryCoreMaxChars < 100) {
		throw new Error(`Invalid JEHEE_MEMORY_CORE_MAX_CHARS "${rawCoreMaxChars}": must be a number >= 100`);
	}

	const rawConsolIdle = env.JEHEE_MEMORY_CONSOLIDATION_IDLE_MS?.trim();
	const consolidationIdleMs = rawConsolIdle !== undefined && rawConsolIdle.length > 0 ? Number(rawConsolIdle) : 0;
	if (!Number.isFinite(consolidationIdleMs) || consolidationIdleMs < 0) {
		throw new Error(`Invalid JEHEE_MEMORY_CONSOLIDATION_IDLE_MS "${rawConsolIdle}": must be a non-negative number`);
	}

	const rawConsolMinTurns = env.JEHEE_MEMORY_CONSOLIDATION_MIN_TURNS?.trim();
	const consolidationMinTurns =
		rawConsolMinTurns !== undefined && rawConsolMinTurns.length > 0
			? Number(rawConsolMinTurns)
			: DEFAULT_CONSOLIDATION_MIN_TURNS;
	if (!Number.isFinite(consolidationMinTurns) || consolidationMinTurns < 1) {
		throw new Error(`Invalid JEHEE_MEMORY_CONSOLIDATION_MIN_TURNS "${rawConsolMinTurns}": must be a number >= 1`);
	}

	const rawConsolModel = env.JEHEE_MEMORY_CONSOLIDATION_MODEL?.trim();
	const consolidationModel =
		rawConsolModel !== undefined && rawConsolModel.length > 0 ? resolveModelSpec(rawConsolModel, models) : undefined;

	const memoryConsolidation: MemoryConsolidationPolicy = {
		idleDelayMs: Math.floor(consolidationIdleMs),
		minNewTurns: Math.floor(consolidationMinTurns),
		...(consolidationModel !== undefined ? { model: consolidationModel } : {}),
	};

	const rawSweetSpot = env.JEHEE_HANDOFF_SWEET_SPOT_TOKENS?.trim();
	const sweetSpotTokens =
		rawSweetSpot !== undefined && rawSweetSpot.length > 0 ? Number(rawSweetSpot) : DEFAULT_HANDOFF_SWEET_SPOT_TOKENS;
	if (!Number.isFinite(sweetSpotTokens) || sweetSpotTokens < 0) {
		throw new Error(`Invalid JEHEE_HANDOFF_SWEET_SPOT_TOKENS "${rawSweetSpot}": must be a non-negative number`);
	}

	const rawKeepRecent = env.JEHEE_HANDOFF_KEEP_RECENT_TOKENS?.trim();
	const keepRecentTokens =
		rawKeepRecent !== undefined && rawKeepRecent.length > 0
			? Number(rawKeepRecent)
			: DEFAULT_HANDOFF_KEEP_RECENT_TOKENS;
	if (!Number.isFinite(keepRecentTokens) || keepRecentTokens < 0) {
		throw new Error(`Invalid JEHEE_HANDOFF_KEEP_RECENT_TOKENS "${rawKeepRecent}": must be a non-negative number`);
	}

	const rawHandoffConsol = env.JEHEE_HANDOFF_CONSOLIDATE?.trim().toLowerCase();
	let consolidateBeforeHandoff = true;
	if (rawHandoffConsol !== undefined && rawHandoffConsol.length > 0) {
		if (rawHandoffConsol === "true" || rawHandoffConsol === "1") {
			consolidateBeforeHandoff = true;
		} else if (rawHandoffConsol === "false" || rawHandoffConsol === "0") {
			consolidateBeforeHandoff = false;
		} else {
			throw new Error(`Invalid JEHEE_HANDOFF_CONSOLIDATE "${rawHandoffConsol}": expected "true" or "false"`);
		}
	}

	const rawHandoffModel = env.JEHEE_HANDOFF_MODEL?.trim();
	const handoffModel =
		rawHandoffModel !== undefined && rawHandoffModel.length > 0
			? resolveModelSpec(rawHandoffModel, models)
			: undefined;

	const handoff = resolveHandoffPolicy({
		sweetSpotTokens,
		keepRecentTokens,
		consolidateBeforeHandoff,
		...(handoffModel !== undefined ? { model: handoffModel } : {}),
	});

	const tinyfishApiKey = env.TINYFISH_API_KEY?.trim();
	const tinyfishBaseUrl = env.TINYFISH_SEARCH_BASE_URL?.trim();
	const webSearchLanguage = env.JEHEE_WEB_SEARCH_LANGUAGE?.trim();
	const webSearchLocation = env.JEHEE_WEB_SEARCH_LOCATION?.trim();
	const webSearch =
		tinyfishApiKey !== undefined && tinyfishApiKey.length > 0
			? {
					provider: "tinyfish" as const,
					apiKey: tinyfishApiKey,
					...(tinyfishBaseUrl !== undefined && tinyfishBaseUrl.length > 0 ? { baseUrl: tinyfishBaseUrl } : {}),
					...(webSearchLanguage !== undefined && webSearchLanguage.length > 0
						? { defaultLanguage: webSearchLanguage }
						: {}),
					...(webSearchLocation !== undefined && webSearchLocation.length > 0
						? { defaultLocation: webSearchLocation }
						: {}),
				}
			: undefined;

	return {
		defaultModel,
		instructions: env.JEHEE_INSTRUCTIONS?.trim() || DEFAULT_JEHEE_INSTRUCTIONS,
		coreMemoryPrompt: env.JEHEE_CORE_MEMORY?.trim() ?? "",
		memoryProvider,
		memoryCoreMaxChars: Math.floor(memoryCoreMaxChars),
		memoryConsolidation,
		handoff,
		...(telegram !== undefined ? { telegram } : {}),
		stagingAllowedRoutes: splitCsv(env.JEHEE_STAGING_ROUTES),
		debounceMs,
		...(instabox !== undefined ? { instabox } : {}),
		...(localWorkshop !== undefined ? { localWorkshop } : {}),
		...(workshopDriver !== undefined ? { workshopDriver } : {}),
		...(workshopAgentModel !== undefined ? { workshopAgentModel } : {}),
		...(workshopDefaultRepo !== undefined ? { workshopDefaultRepo } : {}),
		...(workshopCustomTemplate !== undefined ? { workshopCustomTemplate } : {}),
		...(mcp !== undefined ? { mcp } : {}),
		...(mcpExposure !== undefined ? { mcpExposure } : {}),
		...(writeGate !== undefined ? { writeGate } : {}),
		...(quietPolicy !== undefined ? { quietPolicy } : {}),
		...(webSearch !== undefined ? { webSearch } : {}),
		utcOffsetMinutes,
	};
}
