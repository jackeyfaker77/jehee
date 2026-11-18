// Node 24 runtime helpers: opens local SQLite-backed JeheeHost instances, loads `.env` files without external packages,
// and runs the local Telegram `getUpdates` long-polling loop.

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ChannelGateway } from "../channels/gateway.ts";
import { pollTelegramUpdatesOnce, TelegramTransport } from "../channels/telegram.ts";
import { JeheeHost, type JeheeHostOptions } from "../core/host.ts";
import { StaticCoreMemoryProvider } from "../memory/static-core.ts";
import { InstaBoxClient } from "../workshop/instabox-client.ts";
import { SingleBoxWorktreeProvisioner } from "../workshop/provisioner.ts";
import { parseJeheeEnvConfig } from "./config.ts";
import { createJeheeModels, type EnvDictionary } from "./models.ts";

/** Options for opening a local Node SQLite-backed JeheeHost. */
export type NodeJeheeHostOptions = Omit<JeheeHostOptions, "storage" | "env"> & {
	readonly sqlitePath: string;
};

/** Opens a `JeheeHost` backed by a local SQLite WAL file and `NodeExecutionEnv`. */
export async function openNodeJeheeHost(options: NodeJeheeHostOptions, context: Context): Promise<JeheeHost> {
	await mkdir(dirname(options.sqlitePath), { recursive: true });
	const storage = await openNodeSqliteStorage(options.sqlitePath);
	const defaultCwd = options.cwd ?? process.cwd();
	return JeheeHost.open(
		{
			...options,
			storage: { kind: "custom", storage },
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? defaultCwd }),
		},
		context,
	);
}

/** Parses a simple UTF-8 `.env` file if present; missing files return an empty object. */
export async function loadDotEnvFile(filePath: string): Promise<Record<string, string>> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch {
		return {};
	}
	const result: Record<string, string> = {};
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx <= 0) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		let val = trimmed.slice(eqIdx + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		result[key] = val;
	}
	return result;
}

/** Assembles a complete Node runtime (`JeheeHost` + optional `ChannelGateway` + optional InstaBox Workshop) from `env`. */
export async function assembleNodeRuntime(
	options: {
		readonly env: EnvDictionary;
		readonly sqlitePath: string;
	},
	context: Context,
): Promise<{
	readonly host: JeheeHost;
	readonly gateway: ChannelGateway;
	readonly botToken?: string;
}> {
	const config = parseJeheeEnvConfig(options.env);
	const models = createJeheeModels(options.env);
	const memory = new StaticCoreMemoryProvider({ corePrompt: config.coreMemoryPrompt });

	const workshop =
		config.instabox !== undefined
			? (() => {
					const client = new InstaBoxClient({
						apiKey: config.instabox.apiKey,
						...(config.instabox.baseUrl !== undefined ? { baseUrl: config.instabox.baseUrl } : {}),
					});
					const provisioner = new SingleBoxWorktreeProvisioner({
						client,
						machineId: config.instabox.machineId,
						...(config.instabox.worktreesRoot !== undefined
							? { worktreesRoot: config.instabox.worktreesRoot }
							: {}),
					});
					return { client, provisioner };
				})()
			: undefined;

	const host = await openNodeJeheeHost(
		{
			sqlitePath: options.sqlitePath,
			models,
			defaultModel: config.defaultModel,
			instructions: config.instructions,
			memory,
			...(workshop !== undefined ? { workshop } : {}),
		},
		context,
	);

	const gateway = new ChannelGateway({
		host,
		allowFrom: {
			telegram: config.telegram?.allowedUsers ?? [],
			cli: ["local-owner"],
		},
		debounceMs: config.debounceMs,
		stagingAllowedRoutes: config.stagingAllowedRoutes,
	});

	if (config.telegram !== undefined) {
		gateway.registerTransport(new TelegramTransport({ botToken: config.telegram.botToken }));
	}

	return {
		host,
		gateway,
		...(config.telegram !== undefined ? { botToken: config.telegram.botToken } : {}),
	};
}

/** Continuously long-polls Telegram `getUpdates` until `signal` aborts. */
export async function runTelegramPollingDaemon(
	options: {
		readonly botToken: string;
		readonly gateway: ChannelGateway;
		readonly signal: AbortSignal;
	},
	context: Context,
): Promise<void> {
	let offset: number | undefined;
	while (!options.signal.aborted) {
		try {
			offset = await pollTelegramUpdatesOnce(
				{
					botToken: options.botToken,
					gateway: options.gateway,
					...(offset !== undefined ? { offset } : {}),
					timeoutSeconds: 20,
					signal: options.signal,
					onError: (err, msg) => {
						if (!options.signal.aborted) {
							console.error(`[jehee/telegram] background turn error (msg=${msg.messageId}):`, err);
						}
					},
				},
				context,
			);
		} catch (err) {
			if (options.signal.aborted) break;
			console.error("[jehee/telegram] poll error, retrying in 3s:", err);
			await new Promise((resolve) => setTimeout(resolve, 3000));
		}
	}
}
