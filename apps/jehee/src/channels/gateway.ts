// Single-entry channel gateway: enforces sender allowlists, Staging outbound protection, rapid-message debouncing,
// deterministic slash commands (/status, /stop, /approve, /reject, /flush), inline button callbacks, proactive quiet
// governance ("It knows when to be quiet"), busy-turn steering, and cross-platform root-session continuity.

import type { Context } from "@earendil-works/chord/context";
import type { JeheeHost, JeheePendingTurn } from "../core/host.ts";
import type { ApprovalTicket } from "../governance/approvals.ts";
import { ProactiveNotificationGovernor, type ProactiveQuietPolicy } from "../governance/quiet-gate.ts";
import {
	type ChannelRoute,
	type ChannelSendOptions,
	type ChannelTransport,
	formatRouteKey,
	type InboundCallbackAction,
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
	/** Deterministic Do-Not-Disturb, foreground-yield, and cooldown policy for unsolicited proactive pushes. */
	readonly quietPolicy?: ProactiveQuietPolicy;
	/** Optional clock override for deterministic quiet-hours and cooldown testing. */
	readonly now?: () => number;
};

/**Deterministic slash commands handled directly by `ChannelGateway`. */
export type GatewaySlashCommand = "status" | "stop" | "approve" | "reject" | "flush";

/** Outcome reported after ingesting or flushing an inbound message or button callback. */
export type IngestResult =
	| { readonly kind: "unauthorized" }
	| { readonly kind: "ignored_empty" }
	| { readonly kind: "command_handled"; readonly command: GatewaySlashCommand }
	| { readonly kind: "replied"; readonly replyText: string }
	| { readonly kind: "unanswered"; readonly reason: string };

/** Handle returned once an inbound message or callback is durably admitted without blocking on turn completion. */
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

function parseSlashCommand(trimmed: string): { readonly cmd: GatewaySlashCommand; readonly arg?: string } | undefined {
	if (trimmed === "/status") return { cmd: "status" };
	if (trimmed === "/stop") return { cmd: "stop" };
	if (trimmed === "/flush") return { cmd: "flush" };
	if (trimmed === "/approve" || trimmed.startsWith("/approve ")) {
		const arg = trimmed.slice("/approve".length).trim();
		return arg.length > 0 ? { cmd: "approve", arg } : { cmd: "approve" };
	}
	if (trimmed === "/reject" || trimmed.startsWith("/reject ")) {
		const arg = trimmed.slice("/reject".length).trim();
		return arg.length > 0 ? { cmd: "reject", arg } : { cmd: "reject" };
	}
	return undefined;
}

function formatApprovalPromptCard(ticket: ApprovalTicket): string {
	return [
		`[待确认写操作 ${ticket.id}]`,
		`目标：${ticket.summary}`,
		`确认可执行：点击下方按钮，或回复 /approve ${ticket.id}（取消回复 /reject ${ticket.id}）`,
	].join("\n");
}

/** Platform-agnostic gateway connecting one or more chat transports to a single JeheeHost root conversation. */
export class ChannelGateway {
	readonly #host: JeheeHost;
	readonly #allowFrom: Map<string, ReadonlySet<string>>;
	readonly #debounceMs: number;
	readonly #stagingRoutes: ReadonlySet<string> | undefined;
	readonly #governor: ProactiveNotificationGovernor;
	readonly #now: () => number;
	readonly #transports = new Map<string, ChannelTransport>();
	readonly #buckets = new Map<string, CoalesceBucket>();
	readonly #inFlight = new Set<Promise<unknown>>();
	readonly #deliveredAnswerIds = new Set<number>();
	readonly #unsubscribeProactive: () => void;
	readonly #unsubscribeApproval: () => void;
	#lastActiveRoute: ChannelRoute | undefined;
	#blockedStagingDeliveries = 0;
	#foregroundTurnCount = 0;

	constructor(options: ChannelGatewayOptions) {
		this.#host = options.host;
		this.#allowFrom = new Map(Object.entries(options.allowFrom).map(([ch, ids]) => [ch, new Set(ids)]));
		this.#debounceMs = options.debounceMs ?? 0;
		this.#stagingRoutes =
			options.stagingAllowedRoutes !== undefined && options.stagingAllowedRoutes.length > 0
				? new Set(options.stagingAllowedRoutes)
				: undefined;
		this.#governor = new ProactiveNotificationGovernor(options.quietPolicy);
		this.#now = options.now ?? Date.now;

		this.#unsubscribeProactive = this.#host.onProactiveReply(async (replyText, answerEntryId) => {
			const numericAnswerId = Number(answerEntryId);
			if (this.#deliveredAnswerIds.has(numericAnswerId)) return;
			if (this.#lastActiveRoute !== undefined) {
				this.#deliveredAnswerIds.add(numericAnswerId);
				await this.pushMessage(this.#lastActiveRoute, replyText);
			}
		});

		this.#unsubscribeApproval = this.#host.onApprovalRequested(async (ticket) => {
			if (this.#lastActiveRoute === undefined) return;
			await this.pushMessage(this.#lastActiveRoute, formatApprovalPromptCard(ticket), {
				urgency: "urgent",
				buttons: [
					[
						{ label: "确认执行", callbackData: `apv:ok:${ticket.id}` },
						{ label: "取消", callbackData: `apv:no:${ticket.id}` },
					],
				],
			});
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

	/** Count of proactive background notifications currently held by quiet-hours, busy-yield, or cooldown rules. */
	get heldProactiveCount(): number {
		return this.#governor.heldCount;
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
		const route: ChannelRoute = { channel: message.channel, chatId: message.chatId };
		this.#lastActiveRoute = route;

		const parsedCmd = parseSlashCommand(trimmed);
		if (parsedCmd !== undefined) {
			return this.#handleCommand(parsedCmd.cmd, parsedCmd.arg, message, context);
		}

		// When the owner interacts outside quiet hours, deliver any buffered background digests first.
		if (this.#governor.heldCount > 0 && this.#governor.isOutsideQuietHours(this.#now())) {
			await this.flushHeldNotifications(route);
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

	/** Admits an interactive inline button callback (e.g. `apv:ok:<id>` / `apv:no:<id>`) with owner allowlist enforcement. */
	async admitCallback(callback: InboundCallbackAction, context: Context): Promise<AdmittedIngest> {
		const transport = this.#transports.get(callback.channel);
		const allowed = this.#allowFrom.get(callback.channel);
		if (allowed === undefined || !allowed.has(callback.senderId)) {
			await transport?.answerCallback?.(callback.callbackId, "未授权操作");
			return { settled: Promise.resolve({ kind: "unauthorized" }) };
		}
		this.#lastActiveRoute = { channel: callback.channel, chatId: callback.chatId };

		if (callback.data.startsWith("apv:ok:") || callback.data.startsWith("apv:no:")) {
			const isApprove = callback.data.startsWith("apv:ok:");
			const ticketId = callback.data.slice(7).trim();
			const admitted = await this.#resolveAndRespondApproval(
				{
					decision: isApprove ? "approve" : "reject",
					ticketId,
					channel: callback.channel,
					chatId: callback.chatId,
					...(callback.messageId !== undefined ? { replyToMessageId: callback.messageId } : {}),
					callbackId: callback.callbackId,
				},
				context,
			);
			return admitted;
		}

		await transport?.answerCallback?.(callback.callbackId);
		return { settled: Promise.resolve({ kind: "ignored_empty" }) };
	}

	/** Ingests an interactive inline button callback and waits until any resumed execution settles. */
	async ingestCallback(callback: InboundCallbackAction, context: Context): Promise<IngestResult> {
		const admitted = await this.admitCallback(callback, context);
		return admitted.settled;
	}

	/** Flushes deferred proactive notifications (for `route` or all routes) immediately, returning the count of flushed items. */
	async flushHeldNotifications(route?: ChannelRoute): Promise<number> {
		const batches = this.#governor.drainHeld(route);
		let totalCount = 0;
		for (const batch of batches) {
			const sent = await this.#deliverOutbound(batch.route.channel, batch.route.chatId, batch.digestText);
			if (sent) {
				this.#governor.recordDelivered(batch.route, this.#now());
				totalCount += batch.count;
			}
		}
		return totalCount;
	}

	/** Waits until all currently admitted or debounced background turns and outbound deliveries have settled. */
	async drain(): Promise<void> {
		while (this.#inFlight.size > 0) {
			await Promise.allSettled([...this.#inFlight]);
		}
	}

	/**
	 * Pushes a proactive or workshop notification out through a target route, subject to:
	 * 1. Staging outbound route lock;
	 * 2. `[SILENT]` sentinel suppression;
	 * 3. Quiet-hours, busy-turn yield, and cooldown governance (unless `options?.urgency === "urgent"`).
	 */
	async pushMessage(route: ChannelRoute, text: string, options?: ChannelSendOptions): Promise<boolean> {
		if (!this.#isRouteAllowedInStaging(route.channel, route.chatId)) {
			this.#blockedStagingDeliveries += 1;
			return false;
		}
		const nowMs = this.#now();
		const isBusy = this.#foregroundTurnCount > 0 || this.#buckets.size > 0;
		const gate = this.#governor.evaluate({
			route,
			text,
			...(options?.urgency !== undefined ? { urgency: options.urgency } : {}),
			isBusy,
			nowMs,
		});
		if (gate.action !== "deliver") {
			return false;
		}
		const delivered = await this.#deliverOutbound(route.channel, route.chatId, text, options);
		if (delivered && options?.urgency !== "urgent") {
			this.#governor.recordDelivered(route, nowMs);
		}
		return delivered;
	}

	/** Cancels any pending debounce timers and detaches background listeners cleanly during shutdown. */
	dispose(): void {
		this.#unsubscribeProactive();
		this.#unsubscribeApproval();
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
		cmd: GatewaySlashCommand,
		arg: string | undefined,
		message: InboundChannelMessage,
		context: Context,
	): Promise<AdmittedIngest> {
		if (cmd === "stop") {
			this.#cancelAllBuckets("aborted");
			await this.#host.abort(context);
			await this.#deliverOutbound(message.channel, message.chatId, "已停止当前在途任务。", {
				replyToMessageId: message.messageId,
			});
			return { settled: Promise.resolve({ kind: "command_handled", command: "stop" }) };
		}

		if (cmd === "flush") {
			const flushed = await this.flushHeldNotifications({ channel: message.channel, chatId: message.chatId });
			if (flushed === 0) {
				await this.#deliverOutbound(message.channel, message.chatId, "当前没有暂存通知。", {
					replyToMessageId: message.messageId,
				});
			}
			return { settled: Promise.resolve({ kind: "command_handled", command: "flush" }) };
		}

		if (cmd === "approve" || cmd === "reject") {
			return this.#resolveAndRespondApproval(
				{
					decision: cmd,
					...(arg !== undefined ? { ticketId: arg } : {}),
					channel: message.channel,
					chatId: message.chatId,
					replyToMessageId: message.messageId,
				},
				context,
			);
		}

		const busy = await this.#host.isBusy(context);
		const memoryId = this.#host.memoryProvider?.id ?? "none";
		const mcpServers = this.#host.mcpServerNames;
		const mcpLabel = mcpServers.length > 0 ? mcpServers.join(", ") : "none";
		const pendingApprovals = await this.#host.listPendingApprovals(context);
		const usage = await this.#host.getUsageSummary(context);
		const cachePct = (usage.cacheHitRate * 100).toFixed(1);
		const statusText = [
			`status: ${busy ? "busy" : "idle"}`,
			`conversation: ${String(this.#host.rootConversationId)}`,
			`memory: ${memoryId}`,
			`mcp: ${mcpLabel}`,
			`pending_approvals: ${pendingApprovals.length}`,
			`held_proactive: ${this.#governor.heldCount}`,
			`cache_hit: ${cachePct}% (prefill=${usage.prefillTokens})`,
			`cost_usd: ${usage.costUsd.toFixed(6)}`,
		].join("\n");
		await this.#deliverOutbound(message.channel, message.chatId, statusText, {
			replyToMessageId: message.messageId,
		});
		return { settled: Promise.resolve({ kind: "command_handled", command: "status" }) };
	}

	async #resolveAndRespondApproval(
		params: {
			readonly decision: "approve" | "reject";
			readonly ticketId?: string;
			readonly channel: string;
			readonly chatId: string;
			readonly replyToMessageId?: string;
			readonly callbackId?: string;
		},
		context: Context,
	): Promise<AdmittedIngest> {
		const transport = this.#transports.get(params.channel);
		const resolved = await this.#host.resolveApproval(
			{
				...(params.ticketId !== undefined ? { ticketId: params.ticketId } : {}),
				decision: params.decision,
			},
			context,
		);
		const sendOpts: ChannelSendOptions | undefined =
			params.replyToMessageId !== undefined ? { replyToMessageId: params.replyToMessageId } : undefined;

		if (resolved.kind === "none_pending") {
			await transport?.answerCallback?.(params.callbackId ?? "", "当前无待确认操作");
			await this.#deliverOutbound(params.channel, params.chatId, "当前没有待确认的写操作。", sendOpts);
			return { settled: Promise.resolve({ kind: "command_handled", command: params.decision }) };
		}
		if (resolved.kind === "not_found") {
			await transport?.answerCallback?.(params.callbackId ?? "", "未找到该票据或已过期");
			await this.#deliverOutbound(
				params.channel,
				params.chatId,
				`未找到待确认票据 "${resolved.ticketId}"（可能已过期）。`,
				sendOpts,
			);
			return { settled: Promise.resolve({ kind: "command_handled", command: params.decision }) };
		}
		if (resolved.kind === "ambiguous") {
			const ids = resolved.pending.map((t) => `${t.id} (${t.server}/${t.tool})`).join(", ");
			await transport?.answerCallback?.(params.callbackId ?? "", "请指定具体票据编号");
			await this.#deliverOutbound(
				params.channel,
				params.chatId,
				`当前有多项待确认操作，请指定编号：${ids}`,
				sendOpts,
			);
			return { settled: Promise.resolve({ kind: "command_handled", command: params.decision }) };
		}
		if (resolved.kind === "already_settled") {
			await transport?.answerCallback?.(params.callbackId ?? "", `该票据状态已为 ${resolved.ticket.status}`);
			return { settled: Promise.resolve({ kind: "command_handled", command: params.decision }) };
		}
		if (resolved.kind === "rejected") {
			await transport?.answerCallback?.(params.callbackId ?? "", `已取消 ${resolved.ticket.id}`);
			await this.#deliverOutbound(
				params.channel,
				params.chatId,
				`已取消待确认写操作 ${resolved.ticket.id}（${resolved.ticket.server}/${resolved.ticket.tool}）。`,
				sendOpts,
			);
			return { settled: Promise.resolve({ kind: "command_handled", command: "reject" }) };
		}

		// `resolved.kind === "approved"`
		if (params.callbackId !== undefined) {
			await transport?.answerCallback?.(params.callbackId, `已批准 ${resolved.ticket.id}，正在执行`);
		}
		if (resolved.pendingTurn === undefined) {
			return { settled: Promise.resolve({ kind: "command_handled", command: "approve" }) };
		}
		return {
			settled: this.#trackInFlight(
				this.#settleTurn(
					resolved.pendingTurn,
					{
						channel: params.channel,
						chatId: params.chatId,
						...(params.replyToMessageId !== undefined ? { replyToMessageId: params.replyToMessageId } : {}),
					},
					context,
				),
			),
		};
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
			readonly replyToMessageId?: string;
		},
		context: Context,
	): Promise<IngestResult> {
		this.#foregroundTurnCount += 1;
		try {
			const transport = this.#transports.get(params.channel);
			if (transport?.sendTyping !== undefined && this.#isRouteAllowedInStaging(params.channel, params.chatId)) {
				await transport.sendTyping(params.chatId);
			}
			const outcome = await pending.wait(context);
			if (outcome.status === "done") {
				const numericAnswerId = Number(outcome.answerEntryId);
				if (outcome.replyText.trim().length > 0 && !this.#deliveredAnswerIds.has(numericAnswerId)) {
					this.#deliveredAnswerIds.add(numericAnswerId);
					await this.#deliverOutbound(
						params.channel,
						params.chatId,
						outcome.replyText,
						params.replyToMessageId !== undefined ? { replyToMessageId: params.replyToMessageId } : undefined,
					);
				}
				return { kind: "replied", replyText: outcome.replyText };
			}
			return { kind: "unanswered", reason: outcome.reason };
		} finally {
			this.#foregroundTurnCount -= 1;
		}
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
