// Cloudflare Workers Free Plan entrypoint + SQLite-backed Durable Object (`JeheeSessionDO`).
// Hosts Jehee 24/7 at $0/month base cost: hibernates when idle, wakes via Telegram Webhook or Durable Object Alarm,
// and delegates heavy engineering tasks to InstaBox Free over HTTPS.

import { DurableObject, type DurableObjectNamespace, type DurableObjectState } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Wake } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { ChannelGateway } from "./src/channels/gateway.ts";
import { handleTelegramWebhook, TelegramTransport } from "./src/channels/telegram.ts";
import { JeheeHost } from "./src/core/host.ts";
import { AtomicMemoryProvider } from "./src/memory/atomic-memory.ts";
import { StaticCoreMemoryProvider } from "./src/memory/static-core.ts";
import { parseJeheeEnvConfig } from "./src/runtime/config.ts";
import { createJeheeModels, type EnvDictionary } from "./src/runtime/models.ts";
import { InstaBoxWorkshopBackend } from "./src/workshop/backend.ts";
import { InstaBoxClient } from "./src/workshop/instabox-client.ts";
import { SingleBoxWorktreeProvisioner } from "./src/workshop/provisioner.ts";

/** Bindings and secrets configured in `wrangler.jsonc` / `wrangler secret put`. */
export type JeheeWorkerEnv = {
	readonly JEHEE_DO: DurableObjectNamespace;
	readonly JEHEE_MODEL?: string;
	readonly JEHEE_INSTRUCTIONS?: string;
	readonly JEHEE_CORE_MEMORY?: string;
	readonly JEHEE_MEMORY_PROVIDER?: string;
	readonly JEHEE_MEMORY_CORE_MAX_CHARS?: string;
	readonly JEHEE_MEMORY_CONSOLIDATION_IDLE_MS?: string;
	readonly JEHEE_MEMORY_CONSOLIDATION_MIN_TURNS?: string;
	readonly JEHEE_MEMORY_CONSOLIDATION_MODEL?: string;
	readonly JEHEE_HANDOFF_SWEET_SPOT_TOKENS?: string;
	readonly JEHEE_HANDOFF_KEEP_RECENT_TOKENS?: string;
	readonly JEHEE_HANDOFF_CONSOLIDATE?: string;
	readonly JEHEE_HANDOFF_MODEL?: string;
	readonly JEHEE_STAGING_ROUTES?: string;
	readonly JEHEE_DEBOUNCE_MS?: string;
	readonly OPENCODE_API_KEY?: string;
	readonly OPENCODE_GO_API_KEY?: string;
	readonly DEEPSEEK_API_KEY?: string;
	readonly OPENAI_API_KEY?: string;
	readonly ANTHROPIC_API_KEY?: string;
	readonly GEMINI_API_KEY?: string;
	readonly OPENROUTER_API_KEY?: string;
	readonly TELEGRAM_BOT_TOKEN?: string;
	readonly TELEGRAM_WEBHOOK_SECRET?: string;
	readonly TELEGRAM_ALLOWED_USERS?: string;
	readonly INSTABOX_API_KEY?: string;
	readonly INSTABOX_MACHINE_ID?: string;
	readonly INSTABOX_BASE_URL?: string;
	readonly INSTABOX_WORKTREES_ROOT?: string;
	readonly JEHEE_WORKSHOP_DRIVER?: string;
	readonly JEHEE_WORKSHOP_AGENT_MODEL?: string;
	readonly JEHEE_WORKSHOP_DEFAULT_REPO?: string;
	readonly JEHEE_WORKSHOP_CUSTOM_ARGV?: string;
	readonly JEHEE_MCP_SERVERS?: string;
	readonly JEHEE_MCP_EXPOSURE?: string;
	readonly JEHEE_MCP_WRITE_GATE?: string;
	readonly JEHEE_MCP_WRITE_EXEMPT?: string;
	readonly JEHEE_QUIET_HOURS?: string;
	readonly JEHEE_TZ_OFFSET?: string;
	readonly JEHEE_PROACTIVE_COOLDOWN_MS?: string;
};

const RECOVERY_HEARTBEAT_MS = 60_000;

function extractEnvDict(env: JeheeWorkerEnv): EnvDictionary {
	const out: Record<string, string | undefined> = {};
	for (const [key, val] of Object.entries(env)) {
		if (typeof val === "string") {
			out[key] = val;
		}
	}
	return out;
}

/** Singleton owner Durable Object holding the persistent SQLite conversation state and task graph. */
export class JeheeSessionDO extends DurableObject<JeheeWorkerEnv> {
	readonly #state: DurableObjectState;
	readonly #envDict: EnvDictionary;
	#host!: JeheeHost;
	#gateway!: ChannelGateway;
	#webhookSecret: string | undefined;

	constructor(ctx: DurableObjectState, env: JeheeWorkerEnv) {
		super(ctx, env);
		this.#state = ctx;
		this.#envDict = extractEnvDict(env);

		void ctx.blockConcurrencyWhile(async () => {
			const fallback = Date.now() + RECOVERY_HEARTBEAT_MS;
			const currentAlarm = await ctx.storage.getAlarm();
			if (currentAlarm === null || currentAlarm > fallback) {
				await ctx.storage.setAlarm(fallback);
			}

			const config = parseJeheeEnvConfig(this.#envDict);
			this.#webhookSecret = config.telegram?.webhookSecret;
			const models = createJeheeModels(this.#envDict);
			const memory =
				config.memoryProvider === "atomic"
					? new AtomicMemoryProvider({
							seedCorePrompt: config.coreMemoryPrompt,
							maxCoreChars: config.memoryCoreMaxChars,
							consolidation: config.memoryConsolidation,
						})
					: new StaticCoreMemoryProvider({ corePrompt: config.coreMemoryPrompt });

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
							const backend = new InstaBoxWorkshopBackend({
								client,
								provisioner,
								...(config.workshopDefaultRepo !== undefined
									? { defaultRepoPath: config.workshopDefaultRepo }
									: {}),
							});
							return {
								backend,
								client,
								provisioner,
								...(config.workshopDriver !== undefined ? { defaultDriver: config.workshopDriver } : {}),
								...(config.workshopAgentModel !== undefined ? { agentModel: config.workshopAgentModel } : {}),
								...(config.workshopCustomTemplate !== undefined
									? { customTemplate: config.workshopCustomTemplate }
									: {}),
							};
						})()
					: undefined;

			const workerMcp =
				config.mcp !== undefined
					? {
							...config.mcp,
							bestEffortConnect: true,
							servers: config.mcp.servers.map((server) =>
								server.transport.kind === "http"
									? {
											...server,
											transport: {
												...server.transport,
												openGetStream: false,
											},
										}
									: server,
							),
						}
					: undefined;

			const storage = await openDurableObjectSqliteStorage(ctx.storage, { prefix: "jehee_" });
			this.#host = await JeheeHost.open(
				{
					storage: { kind: "custom", storage },
					models,
					defaultModel: config.defaultModel,
					instructions: config.instructions,
					memory,
					handoff: config.handoff,
					utcOffsetMinutes: config.utcOffsetMinutes,
					enableRoutines: true,
					autoResume: false,
					...(workerMcp !== undefined ? { mcp: workerMcp } : {}),
					...(workshop !== undefined ? { workshop } : {}),
					onWake: (wake) => {
						void this.#armAlarm(wake).catch(() => ctx.abort("Failed to arm Durable Object alarm"));
					},
				},
				BACKGROUND_CONTEXT,
			);

			this.#gateway = new ChannelGateway({
				host: this.#host,
				allowFrom: {
					telegram: config.telegram?.allowedUsers ?? [],
				},
				debounceMs: config.debounceMs,
				stagingAllowedRoutes: config.stagingAllowedRoutes,
				...(config.quietPolicy !== undefined ? { quietPolicy: config.quietPolicy } : {}),
			});
			if (config.telegram !== undefined) {
				this.#gateway.registerTransport(new TelegramTransport({ botToken: config.telegram.botToken }));
			}

			await this.#armAlarm(this.#host.wake());
			this.#host.resume();
		});
	}

	/** Handles incoming Webhook requests forwarded from the edge Worker router. */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/webhook/telegram") {
			await this.#armAlarm({ ...this.#host.wake(), active: true });
			return handleTelegramWebhook(
				request,
				{
					gateway: this.#gateway,
					...(this.#webhookSecret !== undefined ? { secretToken: this.#webhookSecret } : {}),
				},
				BACKGROUND_CONTEXT,
			);
		}
		if (url.pathname === "/health") {
			const busy = await this.#host.isBusy(BACKGROUND_CONTEXT);
			return Response.json({ ok: true, busy });
		}
		return new Response("Not Found", { status: 404 });
	}

	/** Resumes due sleeps and unfinished background tasks when the Durable Object Alarm fires, guarding completion via `waitUntil`. */
	async alarm(): Promise<void> {
		await this.#armAlarm({ ...this.#host.wake(), active: true });
		this.#host.resume();
		this.#state.waitUntil(
			(async () => {
				try {
					await this.#host.waitForDueRoutines(BACKGROUND_CONTEXT);
					await this.#gateway.drain();
				} finally {
					await this.#armAlarm(this.#host.wake());
				}
			})(),
		);
	}

	async #armAlarm(wake: Wake): Promise<void> {
		const heartbeat = wake.active ? Date.now() + RECOVERY_HEARTBEAT_MS : undefined;
		const nextAt =
			heartbeat === undefined || wake.at === undefined ? (heartbeat ?? wake.at) : Math.min(heartbeat, wake.at);
		if (nextAt === undefined) {
			await this.#state.storage.deleteAlarm();
		} else {
			await this.#state.storage.setAlarm(nextAt);
		}
	}
}

export default {
	async fetch(request: Request, env: JeheeWorkerEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health" || url.pathname === "/webhook/telegram") {
			const id = env.JEHEE_DO.idFromName("owner-root");
			return env.JEHEE_DO.get(id).fetch(request);
		}
		return new Response("Jehee Personal Agent Worker", { status: 200 });
	},
};
