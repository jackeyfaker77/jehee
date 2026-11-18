// Portable MCP configuration parser (`mcp.json` and `JEHEE_MCP_SERVERS`) shared across Node 24 and Cloudflare Workers.
// Uses `@earendil-works/pi-mcp`'s `validateMcpServerConfig` and injects `stdioFactory` only from Node entrypoints.

import { validateMcpServerConfig } from "@earendil-works/pi-mcp";
import type { JeheeMcpExposure, JeheeMcpOptions, JeheeMcpServerSpec } from "./contract.ts";
import { validateMcpServerSpecs } from "./hub.ts";

/** Validated stdio server fields passed to a Node-only `stdioFactory` (`stdioMcpServer`). */
export type ParsedStdioServerInput = {
	readonly name: string;
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
	readonly description?: string;
	readonly includeTools?: readonly string[];
	readonly excludeTools?: readonly string[];
	readonly requestTimeoutMs?: number;
};

/** Options controlling MCP configuration parsing and `${ENV_VAR}` substitution. */
export type ParseMcpConfigOptions = {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly sourceLabel?: string;
	readonly exposureOverride?: JeheeMcpExposure;
	readonly stdioFactory?: (input: ParsedStdioServerInput) => JeheeMcpServerSpec;
};

const ENV_PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseExposureValue(raw: unknown, label: string): JeheeMcpExposure {
	if (raw === "deferred" || raw === "eager") return raw;
	throw new Error(`${label}: exposure must be "deferred" or "eager"`);
}

function parseOptionalStringList(raw: unknown, fieldName: string, label: string): readonly string[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string" && item.trim().length > 0)) {
		throw new Error(`${label}: ${fieldName} must be an array of non-empty strings`);
	}
	return raw.map((item) => item.trim());
}

/** Expands `${VAR_NAME}` placeholders from `env`, throwing if a referenced variable is unset or empty. */
export function interpolateMcpEnvString(
	raw: string,
	env: Readonly<Record<string, string | undefined>>,
	contextLabel: string,
): string {
	return raw.replace(ENV_PLACEHOLDER_PATTERN, (_match, varName: string) => {
		const resolved = env[varName];
		if (resolved === undefined || resolved.length === 0) {
			throw new Error(`Missing environment variable "${varName}" referenced in ${contextLabel}`);
		}
		return resolved;
	});
}

function interpolateRecord(
	record: Readonly<Record<string, string>> | undefined,
	env: Readonly<Record<string, string | undefined>>,
	contextLabel: string,
): Record<string, string> | undefined {
	if (record === undefined) return undefined;
	const out: Record<string, string> = {};
	for (const [key, val] of Object.entries(record)) {
		out[key] = interpolateMcpEnvString(val, env, `${contextLabel}.${key}`);
	}
	return out;
}

/** Parses a `JEHEE_MCP_EXPOSURE` environment string if present. */
export function parseMcpExposureEnv(raw: string | undefined): JeheeMcpExposure | undefined {
	const trimmed = raw?.trim();
	if (trimmed === undefined || trimmed.length === 0) return undefined;
	return parseExposureValue(trimmed, "JEHEE_MCP_EXPOSURE");
}

/**
 * Parses a standard `{ "mcpServers": { ... } }` JSON string into portable `JeheeMcpOptions`.
 * Returns `undefined` when no enabled servers are present.
 */
export function parseMcpConfigJson(rawJson: string, options?: ParseMcpConfigOptions): JeheeMcpOptions | undefined {
	const label = options?.sourceLabel ?? "mcp config";
	const env = options?.env ?? {};
	const stripped = rawJson.charCodeAt(0) === 0xfeff ? rawJson.slice(1) : rawJson;

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped);
	} catch (error) {
		throw new Error(`${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!isPlainRecord(parsed)) {
		throw new Error(`${label}: expected a top-level JSON object`);
	}
	if (parsed.mcpServers !== undefined && !isPlainRecord(parsed.mcpServers)) {
		throw new Error(`${label}: "mcpServers" must be an object mapping server names to configurations`);
	}

	const docExposure = parsed.exposure !== undefined ? parseExposureValue(parsed.exposure, label) : undefined;
	const thresholdRaw = parsed.blobOffloadThresholdBytes;
	if (
		thresholdRaw !== undefined &&
		(typeof thresholdRaw !== "number" || !Number.isInteger(thresholdRaw) || thresholdRaw < 0)
	) {
		throw new Error(`${label}: "blobOffloadThresholdBytes" must be a non-negative integer`);
	}
	const blobOffloadThresholdBytes = thresholdRaw as number | undefined;

	const servers: JeheeMcpServerSpec[] = [];
	const rawServers = (parsed.mcpServers ?? {}) as Record<string, unknown>;

	for (const [rawName, rawEntry] of Object.entries(rawServers)) {
		const name = rawName.trim();
		const entryLabel = `${label} server "${name}"`;
		const validated = validateMcpServerConfig(name, rawEntry);
		if (validated.kind === "invalid") {
			throw new Error(`${label}: ${validated.error}`);
		}
		if (validated.config.enabled === false) {
			continue;
		}

		const includeTools = parseOptionalStringList(validated.config.includeTools, "includeTools", entryLabel);
		const excludeTools = parseOptionalStringList(validated.config.excludeTools, "excludeTools", entryLabel);
		const requestTimeoutMs =
			validated.config.timeout !== undefined ? Math.round(validated.config.timeout * 1000) : undefined;
		const description = validated.config.description?.trim() || undefined;

		if (validated.kind === "http") {
			const url = interpolateMcpEnvString(validated.config.url, env, `${entryLabel}.url`);
			const headers = interpolateRecord(validated.config.headers, env, `${entryLabel}.headers`);
			servers.push({
				name,
				...(description !== undefined ? { description } : {}),
				...(includeTools !== undefined ? { includeTools } : {}),
				...(excludeTools !== undefined ? { excludeTools } : {}),
				...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
				transport: {
					kind: "http",
					url,
					...(headers !== undefined ? { headers } : {}),
				},
			});
			continue;
		}

		if (options?.stdioFactory === undefined) {
			throw new Error(
				`${label}: MCP server "${name}" uses stdio ("command"), which is only supported in local Node runtimes; use a Streamable HTTP ("url") server on Cloudflare Workers`,
			);
		}
		const command = interpolateMcpEnvString(validated.config.command, env, `${entryLabel}.command`);
		const args = validated.config.args?.map((arg, idx) =>
			interpolateMcpEnvString(arg, env, `${entryLabel}.args[${idx}]`),
		);
		const childEnv = interpolateRecord(validated.config.env, env, `${entryLabel}.env`);
		const cwd =
			validated.config.cwd !== undefined
				? interpolateMcpEnvString(validated.config.cwd, env, `${entryLabel}.cwd`)
				: undefined;

		servers.push(
			options.stdioFactory({
				name,
				command,
				...(args !== undefined ? { args } : {}),
				...(childEnv !== undefined ? { env: childEnv } : {}),
				...(cwd !== undefined ? { cwd } : {}),
				...(description !== undefined ? { description } : {}),
				...(includeTools !== undefined ? { includeTools } : {}),
				...(excludeTools !== undefined ? { excludeTools } : {}),
				...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
			}),
		);
	}

	if (servers.length === 0) {
		return undefined;
	}
	validateMcpServerSpecs(servers);

	const effectiveExposure = options?.exposureOverride ?? docExposure ?? "deferred";
	return {
		servers,
		exposure: effectiveExposure,
		...(blobOffloadThresholdBytes !== undefined ? { blobOffloadThresholdBytes } : {}),
	};
}

/** Merges file-based and inline-env `JeheeMcpOptions` (`override` entries replace same-name `base` entries). */
export function mergeJeheeMcpOptions(
	base: JeheeMcpOptions | undefined,
	override: JeheeMcpOptions | undefined,
	exposureOverride?: JeheeMcpExposure,
): JeheeMcpOptions | undefined {
	if (base === undefined && override === undefined) return undefined;
	const byName = new Map<string, JeheeMcpServerSpec>();
	for (const srv of base?.servers ?? []) {
		byName.set(srv.name, srv);
	}
	for (const srv of override?.servers ?? []) {
		byName.set(srv.name, srv);
	}
	const servers = [...byName.values()];
	if (servers.length === 0) return undefined;
	validateMcpServerSpecs(servers);
	const threshold = override?.blobOffloadThresholdBytes ?? base?.blobOffloadThresholdBytes;
	return {
		servers,
		exposure: exposureOverride ?? override?.exposure ?? base?.exposure ?? "deferred",
		...(threshold !== undefined ? { blobOffloadThresholdBytes: threshold } : {}),
	};
}
