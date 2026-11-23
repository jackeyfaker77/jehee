// Local CLI entrypoint for Jehee (`models`, `mcp`, `chat`, `telegram`, `export`, `import`).
// Run from apps/jehee:
//   npm run jehee -- models opencode-go
//   npm run jehee -- export snapshot.json
//   npm run jehee -- import snapshot.json --mode merge
//   npm run start:cli
//   npm run start:telegram

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { McpConnectorHub } from "./src/mcp/hub.ts";
import { AtomicMemoryProvider } from "./src/memory/atomic-memory.ts";
import {
	formatImportSnapshotReply,
	type ImportSnapshotMode,
	type PortableTranscriptScope,
	parsePortableSnapshotJson,
	renderPortableSnapshotMarkdown,
	serializePortableSnapshotJson,
} from "./src/memory/portable-snapshot.ts";
import { parseJeheeEnvConfig } from "./src/runtime/config.ts";
import { createJeheeModels } from "./src/runtime/models.ts";
import {
	assembleNodeRuntime,
	loadDotEnvFile,
	loadNodeMcpOptions,
	openNodeJeheeHost,
	runTelegramPollingDaemon,
} from "./src/runtime/node.ts";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)));
const defaultMcpConfigPath = join(appDir, "mcp.json");

async function main(): Promise<void> {
	const dotEnv = await loadDotEnvFile(join(appDir, ".env"));
	const mergedEnv: Record<string, string | undefined> = {
		...process.env,
		...dotEnv,
	};

	const [subcommand = "help", arg1] = process.argv.slice(2);

	if (subcommand === "models") {
		const models = createJeheeModels(mergedEnv);
		const providerFilter = arg1?.trim();
		const list = models.getModels(providerFilter);
		if (list.length === 0) {
			console.log(providerFilter ? `No models found for provider "${providerFilter}".` : "No models registered.");
			return;
		}
		for (const model of list) {
			console.log(`${model.provider}/${model.id}\t(${model.name})`);
		}
		return;
	}

	if (subcommand === "mcp") {
		const mcp = await loadNodeMcpOptions({
			env: mergedEnv,
			defaultConfigPath: defaultMcpConfigPath,
		});
		if (mcp === undefined) {
			console.log(
				`No MCP servers configured. Copy mcp.example.json to ${defaultMcpConfigPath} or set JEHEE_MCP_SERVERS.`,
			);
			return;
		}
		console.log(`Connecting ${mcp.servers.length} MCP server(s) [exposure=${mcp.exposure ?? "deferred"}]...`);
		const hub = await McpConnectorHub.connect(mcp.servers);
		try {
			for (const srv of hub.servers()) {
				const toolNames = srv.tools.map((t) => t.name).join(", ") || "none";
				console.log(
					`- ${srv.name}: ${srv.tools.length} tool(s), resources=${srv.hasResources}${srv.summary ? ` — ${srv.summary}` : ""}\n    tools: ${toolNames}`,
				);
			}
		} finally {
			await hub.close();
		}
		return;
	}

	const sqlitePath =
		process.env.JEHEE_SQLITE_PATH?.trim() ||
		mergedEnv.JEHEE_SQLITE_PATH?.trim() ||
		join(appDir, ".jehee-data", "jehee.sqlite");
	const extraArgs = process.argv.slice(3);

	if (subcommand === "export") {
		let outPath: string | undefined;
		let dbPathOverride: string | undefined;
		let format: "json" | "md" | undefined;
		let scope: PortableTranscriptScope = "active";
		let includeForgotten = true;
		let maxTurns: number | undefined;
		for (let i = 0; i < extraArgs.length; i += 1) {
			const token = extraArgs[i]!;
			if (token === "--format" && extraArgs[i + 1] !== undefined) {
				const rawFmt = extraArgs[++i]!.toLowerCase();
				if (rawFmt !== "json" && rawFmt !== "md" && rawFmt !== "markdown") {
					throw new Error(`Invalid --format "${rawFmt}": expected "json" or "md".`);
				}
				format = rawFmt === "json" ? "json" : "md";
			} else if (token === "--scope" && extraArgs[i + 1] !== undefined) {
				const rawScope = extraArgs[++i]!.toLowerCase();
				if (rawScope !== "active" && rawScope !== "full") {
					throw new Error(`Invalid --scope "${rawScope}": expected "active" or "full".`);
				}
				scope = rawScope;
			} else if (token === "--db" && extraArgs[i + 1] !== undefined) {
				dbPathOverride = extraArgs[++i]!;
			} else if (token === "--no-forgotten") {
				includeForgotten = false;
			} else if (token === "--max-turns" && extraArgs[i + 1] !== undefined) {
				const parsedTurns = Number(extraArgs[++i]);
				if (!Number.isFinite(parsedTurns) || parsedTurns < 0) {
					throw new Error("Invalid --max-turns: expected a non-negative integer.");
				}
				maxTurns = Math.floor(parsedTurns);
			} else if (!token.startsWith("-") && outPath === undefined) {
				outPath = token;
			} else {
				throw new Error(`Unknown export argument: "${token}"`);
			}
		}
		const resolvedFormat: "json" | "md" = format ?? (outPath?.toLowerCase().endsWith(".md") ? "md" : "json");
		const config = parseJeheeEnvConfig(mergedEnv);
		const models = createJeheeModels(mergedEnv);
		const host = await openNodeJeheeHost(
			{
				sqlitePath: dbPathOverride !== undefined ? resolve(dbPathOverride) : sqlitePath,
				models,
				defaultModel: config.defaultModel,
				instructions: config.instructions,
				memory: new AtomicMemoryProvider({
					seedCorePrompt: config.coreMemoryPrompt,
					maxCoreChars: config.memoryCoreMaxChars,
					consolidation: config.memoryConsolidation,
				}),
			},
			BACKGROUND_CONTEXT,
		);
		try {
			const snapshot = await host.exportPortableSnapshot(BACKGROUND_CONTEXT, {
				transcriptScope: scope,
				includeForgotten,
				...(maxTurns !== undefined ? { maxTurns } : {}),
			});
			const output =
				resolvedFormat === "md"
					? renderPortableSnapshotMarkdown(snapshot)
					: serializePortableSnapshotJson(snapshot, true);
			if (outPath !== undefined) {
				const absOut = resolve(outPath);
				await mkdir(dirname(absOut), { recursive: true });
				await writeFile(absOut, output, "utf8");
				console.log(
					`Exported portable snapshot (${resolvedFormat}, scope=${snapshot.context.scope}, memories=${snapshot.memory.items.length}, turns=${snapshot.context.turns.length}) -> ${absOut}`,
				);
			} else {
				process.stdout.write(output);
			}
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}
		return;
	}

	if (subcommand === "import") {
		let inPath: string | undefined;
		let dbPathOverride: string | undefined;
		let mode: ImportSnapshotMode = "merge";
		let includeMemory = true;
		let includeContext = true;
		let respectCoreLimit = true;
		for (let i = 0; i < extraArgs.length; i += 1) {
			const token = extraArgs[i]!;
			if (token === "--mode" && extraArgs[i + 1] !== undefined) {
				const rawMode = extraArgs[++i]!.toLowerCase();
				if (rawMode !== "merge" && rawMode !== "replace") {
					throw new Error(`Invalid --mode "${rawMode}": expected "merge" or "replace".`);
				}
				mode = rawMode;
			} else if (token === "--db" && extraArgs[i + 1] !== undefined) {
				dbPathOverride = extraArgs[++i]!;
			} else if (token === "--memory-only") {
				includeContext = false;
			} else if (token === "--context-only") {
				includeMemory = false;
			} else if (token === "--no-core-limit") {
				respectCoreLimit = false;
			} else if (!token.startsWith("-") && inPath === undefined) {
				inPath = token;
			} else {
				throw new Error(`Unknown import argument: "${token}"`);
			}
		}
		if (inPath === undefined) {
			throw new Error(
				"Usage: jehee import <snapshot.json> [--mode merge|replace] [--memory-only|--context-only] [--db <sqlite>]",
			);
		}
		const rawJson = await readFile(resolve(inPath), "utf8");
		const parsed = parsePortableSnapshotJson(rawJson);
		if (!parsed.ok) {
			throw new Error(`Failed to parse portable snapshot "${inPath}": ${parsed.error}`);
		}
		const config = parseJeheeEnvConfig(mergedEnv);
		const models = createJeheeModels(mergedEnv);
		const host = await openNodeJeheeHost(
			{
				sqlitePath: dbPathOverride !== undefined ? resolve(dbPathOverride) : sqlitePath,
				models,
				defaultModel: config.defaultModel,
				instructions: config.instructions,
				memory: new AtomicMemoryProvider({
					seedCorePrompt: config.coreMemoryPrompt,
					maxCoreChars: config.memoryCoreMaxChars,
					consolidation: config.memoryConsolidation,
				}),
			},
			BACKGROUND_CONTEXT,
		);
		try {
			const result = await host.importPortableSnapshot(parsed.snapshot, BACKGROUND_CONTEXT, {
				mode,
				includeMemory,
				includeContext,
				respectCoreLimit,
			});
			console.log(formatImportSnapshotReply(result));
			if (!result.ok) {
				process.exitCode = 1;
			}
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}
		return;
	}

	if (subcommand === "chat") {
		const { host, gateway } = await assembleNodeRuntime(
			{ env: mergedEnv, sqlitePath, mcpConfigPath: defaultMcpConfigPath },
			BACKGROUND_CONTEXT,
		);
		gateway.registerTransport({
			channel: "cli",
			sendText: async (_chatId, text) => {
				console.log(`\njehee> ${text}\n`);
			},
		});
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		console.log(`Jehee CLI ready (db: ${sqlitePath}). Type /status, /stop, or /quit to exit.\n`);
		let msgCounter = 1;
		try {
			while (true) {
				const line = (await rl.question("you> ")).trim();
				if (line === "/quit" || line === "/exit") break;
				if (line.length === 0) continue;
				await gateway.ingest(
					{
						channel: "cli",
						chatId: "local-terminal",
						senderId: "local-owner",
						messageId: `cli-${Date.now()}-${msgCounter++}`,
						text: line,
						timestampMs: Date.now(),
					},
					BACKGROUND_CONTEXT,
				);
			}
		} finally {
			rl.close();
			gateway.dispose();
			await host.close(BACKGROUND_CONTEXT);
		}
		return;
	}

	if (subcommand === "telegram") {
		const { host, gateway, botToken } = await assembleNodeRuntime(
			{ env: mergedEnv, sqlitePath, mcpConfigPath: defaultMcpConfigPath },
			BACKGROUND_CONTEXT,
		);
		if (botToken === undefined) {
			gateway.dispose();
			await host.close(BACKGROUND_CONTEXT);
			throw new Error("TELEGRAM_BOT_TOKEN is required in .env or environment to run `telegram` mode.");
		}
		const controller = new AbortController();
		const stop = () => controller.abort();
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		console.log(`Jehee Telegram long-polling started (db: ${sqlitePath}). Press Ctrl+C to stop.`);
		try {
			await runTelegramPollingDaemon({ botToken, gateway, signal: controller.signal }, BACKGROUND_CONTEXT);
		} finally {
			gateway.dispose();
			await host.close(BACKGROUND_CONTEXT);
			await gateway.drain();
		}
		return;
	}

	console.log(
		[
			"Usage: npm --prefix apps/jehee run jehee -- <command>",
			"",
			"Commands:",
			"  models [provider]   List available models (e.g. `models opencode-go`)",
			"  mcp                 Verify configured MCP servers (handshake, tools, and resources)",
			"  export [file]       Export portable context & memory snapshot (--format json|md, --scope active|full, --no-forgotten)",
			"  import <file>       Import portable JSON snapshot (--mode merge|replace, --memory-only, --context-only)",
			"  chat                Interactive local terminal chat backed by SQLite",
			"  telegram            Start persistent Telegram getUpdates long-polling bot",
		].join("\n"),
	);
}

await main();
