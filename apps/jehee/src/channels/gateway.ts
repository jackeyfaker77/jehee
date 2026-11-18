// Single-entry channel gateway: enforces sender allowlists, Staging outbound protection, rapid-message debouncing,
// deterministic slash commands (/status, /stop), two-phase ordered admission vs async settlement, busy-turn steering,
// and cross-platform root-session continuity.

import type { Context } from "@earendil-works/chord/context";
import type { JeheeHost, JeheePendingTurn } from "../core/host.ts";
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

/** Handle returned once an inbound message is durably admitted (or placed in a debounce bucket) without blocking on turn completion. */
export type AdmittedIngest = {
	readonly settled: Promise<IngestResult>;
};

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
	readonly #inFlight = new Set<Promise<unknown>>();
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
		this.#unsubscribeProactive = this.#host.onProactiveReply(async (replyText, answerEntryId) => {
			const numericAnswerId = Number(answerEntryId);
			if (this.#deliveredAnswerIds.has(numericAnswerId)) return;
			if (this.#lastActiveRoute !== undefined) {
				this.#deliveredAnswerIds.add(numericAnswerId);
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

	/** Admits one normalized message in order (auth, slash commands, debounce bucket, or durable `submitMessage`) and returns its background settlement handle. */
	async admit(message: InboundChannelMessage, context: Context): Promise<AdmittedIngest> {
		const allowed = this.#allowFrom.get(message.channel);
		if (allowed === undefined || !allowed.has(message.senderId)) {
			return { settled: Promise.resolve({ kind: "unauthorized" }) };
		}
		const trimmed = message.text.trim();
		if (trimmed.length === 0) {
			return { settled: Promise.resolve({ kind: "ignored_empty" }) };
		}
		this.#lastActiveRoute = { channel: message.channel, chatId: message.chatId };

		if (trimmed === "/status" || trimmed === "/stop") {
			const commandOutcome = await this.#handleCommand(trimmed, message, context);
			return { settled: Promise.resolve(commandOutcome) };
		}

		const busy = await this.#host.isBusy(context);
		if (busy) {
			return this.#admitTurn(
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
			return this.#admitTurn(
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

		return { settled: this.#enqueueDebounced(message, trimmed, context) };
	}

	/** Ingests one normalized platform message and waits until its turn (or command) has settled and replied. */
	async ingest(message: InboundChannelMessage, context: Context): Promise<IngestResult> {
		const admitted = await this.admit(message, context);
		return admitted.settled;
	}

	/** Waits until all currently admitted or debounced background turns and outbound deliveries have settled. */
	async drain(): Promise<void> {
		while (this.#inFlight.size > 0) {
			await Promise.allSettled([...this.#inFlight]);
		}
	}

	/** Pushes a proactive or workshop notification out through a target route, subject to the Staging outbound guard. */
	async pushMessage(route: ChannelRoute, text: string, options?: ChannelSendOptions): Promise<boolean> {
		return this.#deliverOutbound(route.channel, route.chatId, text, options);
	}

	/** Cancels any pending debounce timers and detaches background listeners cleanly during shutdown. */
	dispose(): void {
		this.#unsubscribeProactive();
		this.#cancelAllBuckets("disposed");
	}

	#cancelAllBuckets(reason: string): void {
		for (const bucket of this.#buckets.values()) {
			if (bucket.timer !== undefined) clearTimeout(bucket.timer);
			for (const resolve of bucket.resolvers) {
				resolve({ kind: "unanswered", reason });
			}
		}
		this.#buckets.clear();
	}

	#trackInFlight<T>(promise: Promise<T>): Promise<T> {
		const tracked = promise.finally(() => {
			this.#inFlight.delete(tracked);
		});
		// Guard against unhandled rejection warnings when callers fire-and-forget `admit()`.
		tracked.catch(() => undefined);
		this.#inFlight.add(tracked);
		return promise;
	}

	async #handleCommand(
		cmd: "/status" | "/stop",
		message: InboundChannelMessage,
		context: Context,
	): Promise<IngestResult> {
		if (cmd === "/stop") {
			this.#cancelAllBuckets("aborted");
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
		const settled = new Promise<IngestResult>((resolve, reject) => {
			bucket.resolvers.push(resolve);
			bucket.rejecters.push(reject);
			bucket.timer = setTimeout(() => {
				this.#buckets.delete(routeKey);
				const mergedText = bucket.texts.join("\n");
				void this.#flushBucket(bucket, mergedText, context).then(
					(res) => {
						for (const r of bucket.resolvers) r(res);
					},
					(err: unknown) => {
						for (const rj of bucket.rejecters) rj(err);
					},
				);
			}, this.#debounceMs);
		});
		return this.#trackInFlight(settled);
	}

	async #flushBucket(bucket: CoalesceBucket, mergedText: string, context: Context): Promise<IngestResult> {
		const busyNow = await this.#host.isBusy(context);
		const admitted = await this.#admitTurn(
			{
				channel: bucket.channel,
				chatId: bucket.chatId,
				requestId: `${bucket.channel}:${bucket.chatId}:${bucket.firstMessageId}`,
				replyToMessageId: bucket.firstMessageId,
				text: mergedText,
				...(busyNow ? { whenBusy: "steer" } : {}),
			},
			context,
		);
		return admitted.settled;
	}

	async #admitTurn(
		params: {
			readonly channel: string;
			readonly chatId: string;
			readonly requestId: string;
			readonly replyToMessageId: string;
			readonly text: string;
			readonly whenBusy?: "steer" | "followUp";
		},
		context: Context,
	): Promise<AdmittedIngest> {
		const pending = await this.#host.submitMessage(
			{
				text: params.text,
				requestId: params.requestId,
				...(params.whenBusy !== undefined ? { whenBusy: params.whenBusy } : {}),
			},
			context,
		);
		return { settled: this.#trackInFlight(this.#settleTurn(pending, params, context)) };
	}

	async #settleTurn(
		pending: JeheePendingTurn,
		params: {
			readonly channel: string;
			readonly chatId: string;
			readonly replyToMessageId: string;
		},
		context: Context,
	): Promise<IngestResult> {
		const transport = this.#transports.get(params.channel);
		if (transport?.sendTyping !== undefined && this.#isRouteAllowedInStaging(params.channel, params.chatId)) {
			await transport.sendTyping(params.chatId);
		}
		const outcome = await pending.wait(context);
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
