// Local CLI entrypoint for Jehee (`models`, `chat`, `telegram`).
// Run from apps/jehee:
//   npm run jehee -- models opencode-go
//   npm run start:cli
//   npm run start:telegram

import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createJeheeModels } from "./src/runtime/models.ts";
import { assembleNodeRuntime, loadDotEnvFile, runTelegramPollingDaemon } from "./src/runtime/node.ts";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)));

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

	const sqlitePath = mergedEnv.JEHEE_SQLITE_PATH?.trim() || join(appDir, ".jehee-data", "jehee.sqlite");

	if (subcommand === "chat") {
		const { host, gateway } = await assembleNodeRuntime({ env: mergedEnv, sqlitePath }, BACKGROUND_CONTEXT);
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
		const { host, gateway, botToken } = await assembleNodeRuntime({ env: mergedEnv, sqlitePath }, BACKGROUND_CONTEXT);
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
		}
		return;
	}

	console.log(
		[
			"Usage: npm --prefix apps/jehee run jehee -- <command>",
			"",
			"Commands:",
			"  models [provider]   List available models (e.g. `models opencode-go`)",
			"  chat                Interactive local terminal chat backed by SQLite",
			"  telegram            Start persistent Telegram getUpdates long-polling bot",
		].join("\n"),
	);
}

await main();
