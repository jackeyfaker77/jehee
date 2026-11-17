// Single-entry channel gateway: enforces sender allowlists, Staging outbound protection, rapid-message debouncing,
// deterministic slash commands (/status, /stop), busy-turn steering, and cross-platform root-session continuity.

import type { Context } from "@earendil-works/chord/context";
import type { JeheeHost } from "../core/host.ts";
import {
	type ChannelRoute,
	type ChannelSendOptions,
	type ChannelTransport,
	formatRouteKey,
	type InboundChannelMessage,
} from "./contract.ts";

/** Per-channel allowlist mapping channel names (e.g. `"telegram"`, `"qq"`) to authorized owner sender IDs. */
export type ChannelAllowlist = Readonly<Record<string, readonly string[]>>;

/** Configuration options for ChannelGateway. */
export type ChannelGatewayOptions = {
	readonly host: JeheeHost;
	readonly allowFrom: ChannelAllowlist;
	/** Coalesce consecutive idle messages from the same route within this window (ms). 0 disables debouncing. */
	readonly debounceMs?: number;
	/** Non-empty list activates Staging outbound lock: only `"<channel>:<chatId>"` keys listed here may receive messages. */
	readonly stagingAllowedRoutes?: readonly string[];
};

/** Outcome reported after ingesting or flushing an inbound message. */
export type IngestResult =
	| { readonly kind: "unauthorized" }
	| { readonly kind: "ignored_empty" }
	| { readonly kind: "command_handled"; readonly command: "status" | "stop" }
	| { readonly kind: "replied"; readonly replyText: string }
	| { readonly kind: "unanswered"; readonly reason: string };

type CoalesceBucket = {
	readonly channel: string;
	readonly chatId: string;
	readonly firstMessageId: string;
	readonly texts: string[];
	readonly resolvers: Array<(result: IngestResult) => void>;
	readonly rejecters: Array<(error: unknown) => void>;
	timer: ReturnType<typeof setTimeout> | undefined;
};

/** Platform-agnostic gateway connecting one or more chat transports to a single JeheeHost root conversation. */
export class ChannelGateway {
	readonly #host: JeheeHost;
	readonly #allowFrom: Map<string, ReadonlySet<string>>;
	readonly #debounceMs: number;
	readonly #stagingRoutes: ReadonlySet<string> | undefined;
	readonly #transports = new Map<string, ChannelTransport>();
	readonly #buckets = new Map<string, CoalesceBucket>();
	readonly #deliveredAnswerIds = new Set<number>();
	readonly #unsubscribeProactive: () => void;
	#lastActiveRoute: ChannelRoute | undefined;
	#blockedStagingDeliveries = 0;

	constructor(options: ChannelGatewayOptions) {
		this.#host = options.host;
		this.#allowFrom = new Map(Object.entries(options.allowFrom).map(([ch, ids]) => [ch, new Set(ids)]));
		this.#debounceMs = options.debounceMs ?? 0;
		this.#stagingRoutes =
			options.stagingAllowedRoutes !== undefined && options.stagingAllowedRoutes.length > 0
				? new Set(options.stagingAllowedRoutes)
				: undefined;
		this.#unsubscribeProactive = this.#host.onProactiveReply(async (replyText) => {
			if (this.#lastActiveRoute !== undefined) {
				await this.pushMessage(this.#lastActiveRoute, replyText);
			}
		});
	}

	/** Most recent authorized route that interacted with Jehee, used as default target for background notifications. */
	get lastActiveRoute(): ChannelRoute | undefined {
		return this.#lastActiveRoute;
	}

	/** Count of outbound messages suppressed by the Staging outbound lock. */
	get blockedStagingDeliveries(): number {
		return this.#blockedStagingDeliveries;
	}

	/** Registers or replaces an outbound transport for `transport.channel` (e.g. `"telegram"` or `"qq"`). */
	registerTransport(transport: ChannelTransport): void {
		this.#transports.set(transport.channel, transport);
	}

	/** Ingests one normalized platform message, applying auth, commands, debouncing, steering, and reply routing. */
	async ingest(message: InboundChannelMessage, context: Context): Promise<IngestResult> {
		const allowed = this.#allowFrom.get(message.channel);
		if (allowed === undefined || !allowed.has(message.senderId)) {
			return { kind: "unauthorized" };
		}
		const trimmed = message.text.trim();
		if (trimmed.length === 0) {
			return { kind: "ignored_empty" };
		}
		this.#lastActiveRoute = { channel: message.channel, chatId: message.chatId };

		if (trimmed === "/status" || trimmed === "/stop") {
			return this.#handleCommand(trimmed, message, context);
		}

		const busy = await this.#host.isBusy(context);
		if (busy) {
			return this.#dispatchTurn(
				{
					channel: message.channel,
					chatId: message.chatId,
					requestId: `${message.channel}:${message.chatId}:${message.messageId}`,
					replyToMessageId: message.messageId,
					text: trimmed,
					whenBusy: "steer",
				},
				context,
			);
		}

		if (this.#debounceMs <= 0) {
			return this.#dispatchTurn(
				{
					channel: message.channel,
					chatId: message.chatId,
					requestId: `${message.channel}:${message.chatId}:${message.messageId}`,
					replyToMessageId: message.messageId,
					text: trimmed,
				},
				context,
			);
		}

		return this.#enqueueDebounced(message, trimmed, context);
	}

	/** Pushes a proactive or workshop notification out through a target route, subject to the Staging outbound guard. */
	async pushMessage(route: ChannelRoute, text: string, options?: ChannelSendOptions): Promise<boolean> {
		return this.#deliverOutbound(route.channel, route.chatId, text, options);
	}

	/** Cancels any pending debounce timers and detaches background listeners cleanly during shutdown. */
	dispose(): void {
		this.#unsubscribeProactive();
		for (const bucket of this.#buckets.values()) {
			if (bucket.timer !== undefined) clearTimeout(bucket.timer);
		}
		this.#buckets.clear();
	}

	async #handleCommand(
		cmd: "/status" | "/stop",
		message: InboundChannelMessage,
		context: Context,
	): Promise<IngestResult> {
		if (cmd === "/stop") {
			await this.#host.abort(context);
			await this.#deliverOutbound(message.channel, message.chatId, "已停止当前在途任务。", {
				replyToMessageId: message.messageId,
			});
			return { kind: "command_handled", command: "stop" };
		}
		const busy = await this.#host.isBusy(context);
		const memoryId = this.#host.memoryProvider?.id ?? "none";
		const statusText = `status: ${busy ? "busy" : "idle"}\nconversation: ${String(this.#host.rootConversationId)}\nmemory: ${memoryId}`;
		await this.#deliverOutbound(message.channel, message.chatId, statusText, {
			replyToMessageId: message.messageId,
		});
		return { kind: "command_handled", command: "status" };
	}

	#enqueueDebounced(message: InboundChannelMessage, trimmedText: string, context: Context): Promise<IngestResult> {
		const routeKey = formatRouteKey(message.channel, message.chatId);
		let bucket = this.#buckets.get(routeKey);
		if (bucket === undefined) {
			bucket = {
				channel: message.channel,
				chatId: message.chatId,
				firstMessageId: message.messageId,
				texts: [],
				resolvers: [],
				rejecters: [],
				timer: undefined,
			};
			this.#buckets.set(routeKey, bucket);
		}
		bucket.texts.push(trimmedText);
		if (bucket.timer !== undefined) {
			clearTimeout(bucket.timer);
		}
		return new Promise<IngestResult>((resolve, reject) => {
			bucket.resolvers.push(resolve);
			bucket.rejecters.push(reject);
			bucket.timer = setTimeout(() => {
				this.#buckets.delete(routeKey);
				const mergedText = bucket.texts.join("\n");
				void this.#dispatchTurn(
					{
						channel: bucket.channel,
						chatId: bucket.chatId,
						requestId: `${bucket.channel}:${bucket.chatId}:${bucket.firstMessageId}`,
						replyToMessageId: bucket.firstMessageId,
						text: mergedText,
					},
					context,
				).then(
					(res) => {
						for (const r of bucket.resolvers) r(res);
					},
					(err: unknown) => {
						for (const rj of bucket.rejecters) rj(err);
					},
				);
			}, this.#debounceMs);
		});
	}

	async #dispatchTurn(
		params: {
			readonly channel: string;
			readonly chatId: string;
			readonly requestId: string;
			readonly replyToMessageId: string;
			readonly text: string;
			readonly whenBusy?: "steer" | "followUp";
		},
		context: Context,
	): Promise<IngestResult> {
		const transport = this.#transports.get(params.channel);
		if (transport?.sendTyping !== undefined && this.#isRouteAllowedInStaging(params.channel, params.chatId)) {
			await transport.sendTyping(params.chatId);
		}
		const outcome = await this.#host.sendMessage(
			{
				text: params.text,
				requestId: params.requestId,
				...(params.whenBusy !== undefined ? { whenBusy: params.whenBusy } : {}),
			},
			context,
		);
		if (outcome.status === "done") {
			const numericAnswerId = Number(outcome.answerEntryId);
			if (outcome.replyText.trim().length > 0 && !this.#deliveredAnswerIds.has(numericAnswerId)) {
				this.#deliveredAnswerIds.add(numericAnswerId);
				await this.#deliverOutbound(params.channel, params.chatId, outcome.replyText, {
					replyToMessageId: params.replyToMessageId,
				});
			}
			return { kind: "replied", replyText: outcome.replyText };
		}
		return { kind: "unanswered", reason: outcome.reason };
	}

	#isRouteAllowedInStaging(channel: string, chatId: string): boolean {
		if (this.#stagingRoutes === undefined) return true;
		return this.#stagingRoutes.has(formatRouteKey(channel, chatId));
	}

	async #deliverOutbound(
		channel: string,
		chatId: string,
		text: string,
		options?: ChannelSendOptions,
	): Promise<boolean> {
		if (!this.#isRouteAllowedInStaging(channel, chatId)) {
			this.#blockedStagingDeliveries += 1;
			return false;
		}
		const transport = this.#transports.get(channel);
		if (transport === undefined) {
			throw new Error(`No ChannelTransport registered for channel "${channel}"`);
		}
		await transport.sendText(chatId, text, options);
		return true;
	}
}
