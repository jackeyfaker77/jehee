// Single-entry channel gateway: enforces sender allowlists, Staging outbound protection, rapid-message debouncing,
// deterministic slash commands (/status, /stop, /approve, /reject, /flush), inline button callbacks, proactive quiet
// governance ("It knows when to be quiet"), busy-turn steering, and cross-platform root-session continuity.

import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ImageContent } from "@earendil-works/pi-ai";
import { formatHandoffReply } from "../context/handoff.ts";
import type { JeheeHost, JeheePendingTurn } from "../core/host.ts";
import type { ApprovalTicket } from "../governance/approvals.ts";
import {
	formatMcpStatusReply,
	formatModelListReply,
	formatModelRef,
	formatModelStatusReply,
} from "../governance/durable-store.ts";
import {
	formatHeldNotificationBatches,
	type HeldProactiveMessage,
	ProactiveNotificationGovernor,
	type ProactiveQuietPolicy,
} from "../governance/quiet-gate.ts";
import type { OutboundMediaDeliveryResult, OutboundMediaPayload } from "../media/extension.ts";
import { formatMemoryInspectReply, formatMemorySearchReply } from "../memory/atomic-memory.ts";
import { formatConsolidationReportReply } from "../memory/consolidator.ts";
import { renderPortableSnapshotMarkdown, serializePortableSnapshotJson } from "../memory/portable-snapshot.ts";
import { formatRoutineDeleteReply, formatRoutineListReply, formatRoutineRunReply } from "../routines/scheduler.ts";
import { formatTraceDetailReply, formatTraceListReply } from "../telemetry/durable-store.ts";
import {
	type ChannelAttachment,
	type ChannelRoute,
	type ChannelSendOptions,
	type ChannelTransport,
	type DownloadedChannelFile,
	formatRouteKey,
	type InboundCallbackAction,
	type InboundChannelMessage,
} from "./contract.ts";
import { formatInboundAttachmentsContext } from "./telegram.ts";

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

/** Deterministic slash commands handled directly by `ChannelGateway`. */
export type GatewaySlashCommand =
	| "status"
	| "stop"
	| "approve"
	| "reject"
	| "flush"
	| "memory"
	| "handoff"
	| "trace"
	| "routines"
	| "mcp"
	| "model";

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
	readonly attachments: ChannelAttachment[];
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
	if (trimmed === "/memory" || trimmed.startsWith("/memory ")) {
		const arg = trimmed.slice("/memory".length).trim();
		return arg.length > 0 ? { cmd: "memory", arg } : { cmd: "memory" };
	}
	if (trimmed === "/handoff" || trimmed.startsWith("/handoff ")) {
		const arg = trimmed.slice("/handoff".length).trim();
		return arg.length > 0 ? { cmd: "handoff", arg } : { cmd: "handoff" };
	}
	if (trimmed === "/trace" || trimmed.startsWith("/trace ")) {
		const arg = trimmed.slice("/trace".length).trim();
		return arg.length > 0 ? { cmd: "trace", arg } : { cmd: "trace" };
	}
	if (trimmed === "/routines" || trimmed.startsWith("/routines ")) {
		const arg = trimmed.slice("/routines".length).trim();
		return arg.length > 0 ? { cmd: "routines", arg } : { cmd: "routines" };
	}
	if (trimmed === "/mcp" || trimmed.startsWith("/mcp ")) {
		const arg = trimmed.slice("/mcp".length).trim();
		return arg.length > 0 ? { cmd: "mcp", arg } : { cmd: "mcp" };
	}
	if (trimmed === "/model" || trimmed.startsWith("/model ")) {
		const arg = trimmed.slice("/model".length).trim();
		return arg.length > 0 ? { cmd: "model", arg } : { cmd: "model" };
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
	readonly #deliveredDirectKeys = new Set<string>();
	readonly #unsubscribeProactive: () => void;
	readonly #unsubscribeDirectNotify: () => void;
	readonly #unsubscribeApproval: () => void;
	readonly #unsubscribeQuietFlush: () => void;
	readonly #unsubscribeOutboundMedia: () => void;
	#lastActiveRoute: ChannelRoute | undefined;
	#blockedStagingDeliveries = 0;
	#foregroundTurnCount = 0;
	#cachedHeldCount = 0;

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

		this.#unsubscribeProactive = this.#host.onProactiveReply(async (replyText, answerEntryId, opts) => {
			const numericAnswerId = Number(answerEntryId);
			if (this.#deliveredAnswerIds.has(numericAnswerId)) return;
			// Claim synchronously before any await so coalesced concurrent reporters cannot race past dedup.
			this.#deliveredAnswerIds.add(numericAnswerId);
			const route = await this.#resolveProactiveRoute(BACKGROUND_CONTEXT);
			if (route === undefined) {
				this.#deliveredAnswerIds.delete(numericAnswerId);
				return;
			}
			await this.pushMessage(route, replyText, opts?.urgency !== undefined ? { urgency: opts.urgency } : undefined);
		});

		this.#unsubscribeDirectNotify = this.#host.onDirectNotify(async (event) => {
			if (this.#deliveredDirectKeys.has(event.dedupeKey)) return;
			this.#deliveredDirectKeys.add(event.dedupeKey);
			const route = await this.#resolveProactiveRoute(BACKGROUND_CONTEXT);
			if (route === undefined) {
				this.#deliveredDirectKeys.delete(event.dedupeKey);
				return;
			}
			await this.pushMessage(route, event.text, { urgency: event.urgency });
		});

		this.#unsubscribeApproval = this.#host.onApprovalRequested(async (ticket) => {
			const route = await this.#resolveProactiveRoute(BACKGROUND_CONTEXT);
			if (route === undefined) return;
			await this.pushMessage(route, formatApprovalPromptCard(ticket), {
				urgency: "urgent",
				buttons: [
					[
						{ label: "确认执行", callbackData: `apv:ok:${ticket.id}` },
						{ label: "取消", callbackData: `apv:no:${ticket.id}` },
					],
				],
			});
		});

		this.#unsubscribeQuietFlush = this.#host.onQuietFlushDue(
			async (nowMs, ctx) => {
				if (!this.#governor.isOutsideQuietHours(nowMs)) return;
				const outcome = await this.#flushHeldInternal(undefined, ctx);
				if (outcome.firstError !== undefined) {
					throw outcome.firstError;
				}
			},
			this.#governor.quietHours !== undefined ? { quietHours: this.#governor.quietHours } : undefined,
		);

		this.#unsubscribeOutboundMedia = this.#host.onOutboundMedia((payload, ctx) =>
			this.#handleOutboundMedia(payload, ctx),
		);
	}

	/** Most recent authorized route that interacted with Jehee, used as default target for background notifications. */
	get lastActiveRoute(): ChannelRoute | undefined {
		return this.#lastActiveRoute;
	}

	/** Count of outbound messages suppressed by the Staging outbound lock. */
	get blockedStagingDeliveries(): number {
		return this.#blockedStagingDeliveries;
	}

	/** Last observed count of durable deferred proactive notifications held in `HeldNotificationsDoc`. */
	get heldProactiveCount(): number {
		return this.#cachedHeldCount;
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
		const hasAttachments = message.attachments !== undefined && message.attachments.length > 0;
		if (trimmed.length === 0 && !hasAttachments) {
			return { settled: Promise.resolve({ kind: "ignored_empty" }) };
		}
		const route: ChannelRoute = { channel: message.channel, chatId: message.chatId };
		this.#lastActiveRoute = route;
		await this.#host.setLastActiveRoute(route, context);

		const parsedCmd = parseSlashCommand(trimmed);
		if (parsedCmd !== undefined) {
			return this.#handleCommand(parsedCmd.cmd, parsedCmd.arg, message, context);
		}

		// When the owner interacts outside quiet hours, deliver any buffered durable digests first.
		if (this.#governor.isOutsideQuietHours(this.#now())) {
			const held = await this.#host.listHeldNotifications(context);
			this.#cachedHeldCount = held.length;
			if (held.length > 0) {
				await this.flushHeldNotifications(route, context);
			}
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
					...(hasAttachments ? { attachments: message.attachments } : {}),
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
					...(hasAttachments ? { attachments: message.attachments } : {}),
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
		const callbackRoute: ChannelRoute = { channel: callback.channel, chatId: callback.chatId };
		this.#lastActiveRoute = callbackRoute;
		await this.#host.setLastActiveRoute(callbackRoute, context);

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

	/** Flushes durable deferred proactive notifications (for `route` or all routes) immediately, preserving items whose delivery fails. */
	async flushHeldNotifications(route?: ChannelRoute, context: Context = BACKGROUND_CONTEXT): Promise<number> {
		const outcome = await this.#flushHeldInternal(route, context);
		return outcome.deliveredCount;
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
	 * 3. Quiet-hours, busy-turn yield, and cooldown governance backed by durable `HeldNotificationsDoc`
	 *    (unless `options?.urgency === "urgent"`).
	 */
	async pushMessage(route: ChannelRoute, text: string, options?: ChannelSendOptions): Promise<boolean> {
		if (!this.#isRouteAllowedInStaging(route.channel, route.chatId)) {
			this.#blockedStagingDeliveries += 1;
			return false;
		}
		const nowMs = this.#now();
		const isBusy = this.#foregroundTurnCount > 0 || this.#buckets.size > 0;
		const decision = this.#governor.classify({
			route,
			text,
			...(options?.urgency !== undefined ? { urgency: options.urgency } : {}),
			isBusy,
			nowMs,
		});
		if (decision.action === "drop_silent") {
			return false;
		}
		if (decision.action === "hold") {
			const quietEndMs = decision.reason === "quiet_hours" ? this.#governor.nextQuietEndMs(nowMs) : undefined;
			await this.#host.appendHeldNotification(
				{
					route: { channel: route.channel, chatId: route.chatId },
					text: text.trim(),
					reason: decision.reason,
					heldAtMs: nowMs,
				},
				BACKGROUND_CONTEXT,
				quietEndMs,
			);
			this.#cachedHeldCount = (await this.#host.listHeldNotifications(BACKGROUND_CONTEXT)).length;
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
		this.#unsubscribeDirectNotify();
		this.#unsubscribeApproval();
		this.#unsubscribeQuietFlush();
		this.#unsubscribeOutboundMedia();
		this.#cancelAllBuckets("disposed");
	}

	async #flushHeldInternal(
		route: ChannelRoute | undefined,
		context: Context,
	): Promise<{ readonly deliveredCount: number; readonly failedCount: number; readonly firstError?: unknown }> {
		const drained = await this.#host.drainHeldNotifications(context, route);
		if (drained.length === 0) {
			this.#cachedHeldCount = (await this.#host.listHeldNotifications(context)).length;
			return { deliveredCount: 0, failedCount: 0 };
		}

		const grouped = new Map<string, { route: ChannelRoute; items: HeldProactiveMessage[] }>();
		for (const item of drained) {
			const key = formatRouteKey(item.route.channel, item.route.chatId);
			let bucket = grouped.get(key);
			if (bucket === undefined) {
				bucket = { route: { channel: item.route.channel, chatId: item.route.chatId }, items: [] };
				grouped.set(key, bucket);
			}
			bucket.items.push(item);
		}

		let deliveredCount = 0;
		const failedItems: HeldProactiveMessage[] = [];
		let firstError: unknown;

		for (const group of grouped.values()) {
			if (!this.#isRouteAllowedInStaging(group.route.channel, group.route.chatId)) {
				this.#blockedStagingDeliveries += 1;
				continue;
			}
			const batch = formatHeldNotificationBatches(group.items)[0];
			if (batch === undefined) continue;
			try {
				const sent = await this.#deliverOutbound(batch.route.channel, batch.route.chatId, batch.digestText);
				if (sent) {
					this.#governor.recordDelivered(batch.route, this.#now());
					deliveredCount += batch.count;
				}
			} catch (error) {
				failedItems.push(...group.items);
				if (firstError === undefined) firstError = error;
			}
		}

		if (failedItems.length > 0) {
			for (const item of failedItems) {
				await this.#host.appendHeldNotification(item, context);
			}
		}

		this.#cachedHeldCount = (await this.#host.listHeldNotifications(context)).length;
		return {
			deliveredCount,
			failedCount: failedItems.length,
			...(firstError !== undefined ? { firstError } : {}),
		};
	}

	async #handleOutboundMedia(
		payload: OutboundMediaPayload,
		context: Context,
		explicitRoute?: ChannelRoute,
	): Promise<OutboundMediaDeliveryResult> {
		const route = explicitRoute ?? (await this.#resolveProactiveRoute(context));
		if (route === undefined) {
			return { ok: false, reason: "No target messaging route available for outbound media delivery." };
		}
		const routeKey = formatRouteKey(route.channel, route.chatId);
		if (!this.#isRouteAllowedInStaging(route.channel, route.chatId)) {
			this.#blockedStagingDeliveries += 1;
			return {
				ok: false,
				reason: `Outbound media delivery blocked by staging lock for route "${routeKey}".`,
			};
		}
		const transport = this.#transports.get(route.channel);
		if (transport === undefined) {
			return { ok: false, reason: `No ChannelTransport registered for channel "${route.channel}".` };
		}
		try {
			if (payload.kind === "photo") {
				if (transport.sendPhoto === undefined) {
					return { ok: false, reason: `Channel transport "${route.channel}" does not support sendPhoto.` };
				}
				await transport.sendPhoto(route.chatId, {
					bytes: payload.bytes,
					mimeType: payload.mimeType,
					...(payload.fileName !== undefined ? { fileName: payload.fileName } : {}),
					...(payload.caption !== undefined ? { caption: payload.caption } : {}),
				});
				return { ok: true, route: routeKey };
			}
			if (transport.sendDocument === undefined) {
				return { ok: false, reason: `Channel transport "${route.channel}" does not support sendDocument.` };
			}
			await transport.sendDocument(route.chatId, {
				bytes: payload.bytes,
				mimeType: payload.mimeType,
				fileName: payload.fileName,
				...(payload.caption !== undefined ? { caption: payload.caption } : {}),
			});
			return { ok: true, route: routeKey };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	async #resolveProactiveRoute(context: Context): Promise<ChannelRoute | undefined> {
		if (this.#lastActiveRoute !== undefined) {
			return this.#lastActiveRoute;
		}
		const persisted = await this.#host.getLastActiveRoute(context);
		if (persisted !== undefined && this.#transports.has(persisted.channel)) {
			this.#lastActiveRoute = persisted;
			return persisted;
		}
		const tgAllow = this.#allowFrom.get("telegram");
		if (tgAllow !== undefined && tgAllow.size > 0 && this.#transports.has("telegram")) {
			const firstOwner = tgAllow.values().next().value;
			if (firstOwner !== undefined) {
				return { channel: "telegram", chatId: firstOwner };
			}
		}
		return persisted;
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
			const outcome = await this.#flushHeldInternal({ channel: message.channel, chatId: message.chatId }, context);
			if (outcome.deliveredCount === 0 && outcome.failedCount === 0) {
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

		if (cmd === "memory") {
			return this.#handleMemoryCommand(arg, message, context);
		}

		if (cmd === "handoff") {
			const report = await this.#host.handoffWindow(context, {
				...(arg !== undefined && arg.length > 0 ? { focus: arg } : {}),
			});
			await this.#deliverOutbound(message.channel, message.chatId, formatHandoffReply(report), {
				replyToMessageId: message.messageId,
			});
			return { settled: Promise.resolve({ kind: "command_handled", command: "handoff" }) };
		}

		if (cmd === "trace") {
			const trimmedArg = arg?.trim() ?? "";
			let reply: string;
			if (trimmedArg.toLowerCase() === "list") {
				const entries = await this.#host.listTraces(context, 10);
				reply = formatTraceListReply(entries);
			} else if (trimmedArg.length === 0) {
				const latest = await this.#host.getTrace(context);
				reply = formatTraceDetailReply(latest);
			} else if (/^#?\d+$/.test(trimmedArg)) {
				const requestedId = Number.parseInt(trimmedArg.replace(/^#/, ""), 10);
				const entry = await this.#host.getTrace(context, requestedId);
				reply = formatTraceDetailReply(entry, requestedId);
			} else {
				reply = "用法：/trace（最新一轮决策树）| /trace list（最近 10 轮摘要）| /trace <编号>";
			}
			await this.#deliverOutbound(message.channel, message.chatId, reply, {
				replyToMessageId: message.messageId,
			});
			return { settled: Promise.resolve({ kind: "command_handled", command: "trace" }) };
		}

		if (cmd === "routines") {
			return this.#handleRoutinesCommand(arg, message, context);
		}

		if (cmd === "mcp") {
			return this.#handleMcpCommand(arg, message, context);
		}

		if (cmd === "model") {
			return this.#handleModelCommand(arg, message, context);
		}

		const busy = await this.#host.isBusy(context);
		const currentModel = await this.#host.getCurrentModel(context);
		const memoryId = this.#host.memoryProvider?.id ?? "none";
		const mcpServers = this.#host.mcpServerNames;
		const mcpLabel = mcpServers.length > 0 ? mcpServers.join(", ") : "none";
		const pendingApprovals = await this.#host.listPendingApprovals(context);
		const activeRoutines = await this.#host.listRoutines(context);
		const heldItems = await this.#host.listHeldNotifications(context);
		this.#cachedHeldCount = heldItems.length;
		const contextStatus = await this.#host.getContextStatus(context);
		const usage = await this.#host.getUsageSummary(context);
		const cachePct = (usage.cacheHitRate * 100).toFixed(1);
		const sweetSpotLabel = contextStatus.sweetSpotTokens > 0 ? String(contextStatus.sweetSpotTokens) : "off";
		const statusText = [
			`status: ${busy ? "busy" : "idle"}`,
			`conversation: ${String(this.#host.rootConversationId)}`,
			`model: ${formatModelRef(currentModel.active)}`,
			`memory: ${memoryId}`,
			`context: ${contextStatus.activeTokens}/${sweetSpotLabel} tok (handoffs=${contextStatus.totalHandoffs})`,
			`mcp: ${mcpLabel}`,
			`routines: ${activeRoutines.length}`,
			`pending_approvals: ${pendingApprovals.length}`,
			`held_proactive: ${heldItems.length}`,
			`cache_hit: ${cachePct}% (prefill=${usage.prefillTokens})`,
			`cost_usd: ${usage.costUsd.toFixed(6)}`,
		].join("\n");
		await this.#deliverOutbound(message.channel, message.chatId, statusText, {
			replyToMessageId: message.messageId,
		});
		return { settled: Promise.resolve({ kind: "command_handled", command: "status" }) };
	}

	async #handleMcpCommand(
		arg: string | undefined,
		message: InboundChannelMessage,
		context: Context,
	): Promise<AdmittedIngest> {
		const sendOpts: ChannelSendOptions = { replyToMessageId: message.messageId };
		const trimmed = (arg ?? "").trim().toLowerCase();

		if (trimmed.length === 0 || trimmed === "status") {
			const status = this.#host.getMcpStatus();
			await this.#deliverOutbound(message.channel, message.chatId, formatMcpStatusReply(status), sendOpts);
			return { settled: Promise.resolve({ kind: "command_handled", command: "mcp" }) };
		}

		if (trimmed === "reconnect") {
			const report = await this.#host.reconnectMcp(context);
			await this.#deliverOutbound(
				message.channel,
				message.chatId,
				formatMcpStatusReply({ ...report, reconnected: true }),
				sendOpts,
			);
			return { settled: Promise.resolve({ kind: "command_handled", command: "mcp" }) };
		}

		await this.#deliverOutbound(message.channel, message.chatId, "用法：/mcp [reconnect]", sendOpts);
		return { settled: Promise.resolve({ kind: "command_handled", command: "mcp" }) };
	}

	async #handleModelCommand(
		arg: string | undefined,
		message: InboundChannelMessage,
		context: Context,
	): Promise<AdmittedIngest> {
		const sendOpts: ChannelSendOptions = { replyToMessageId: message.messageId };
		const trimmed = (arg ?? "").trim();

		if (trimmed.length === 0) {
			const status = await this.#host.getCurrentModel(context);
			await this.#deliverOutbound(message.channel, message.chatId, formatModelStatusReply(status), sendOpts);
			return { settled: Promise.resolve({ kind: "command_handled", command: "model" }) };
		}

		const spaceIdx = trimmed.indexOf(" ");
		const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
		const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

		if (sub === "list") {
			const status = await this.#host.getCurrentModel(context);
			const models = this.#host.listAvailableModels(rest.length > 0 ? rest : undefined);
			await this.#deliverOutbound(
				message.channel,
				message.chatId,
				formatModelListReply(models, status.active),
				sendOpts,
			);
			return { settled: Promise.resolve({ kind: "command_handled", command: "model" }) };
		}

		if (sub === "reset") {
			const reset = await this.#host.resetModel(context);
			const reply = reset.wasOverride
				? `[Model] 已恢复默认模型：${formatModelRef(reset.model)}`
				: `[Model] 当前已是默认模型：${formatModelRef(reset.model)}`;
			await this.#deliverOutbound(message.channel, message.chatId, reply, sendOpts);
			return { settled: Promise.resolve({ kind: "command_handled", command: "model" }) };
		}

		const updated = await this.#host.setModel(trimmed, context);
		const reply = updated.ok
			? `[Model] 已切换模型：${formatModelRef(updated.model)}（原模型：${formatModelRef(updated.previous)}）`
			: `[Model] 切换失败：${updated.message}`;
		await this.#deliverOutbound(message.channel, message.chatId, reply, sendOpts);
		return { settled: Promise.resolve({ kind: "command_handled", command: "model" }) };
	}

	async #handleRoutinesCommand(
		arg: string | undefined,
		message: InboundChannelMessage,
		context: Context,
	): Promise<AdmittedIngest> {
		const sendOpts: ChannelSendOptions = { replyToMessageId: message.messageId };
		const trimmed = arg?.trim() ?? "";

		if (trimmed.length === 0 || trimmed.toLowerCase() === "list") {
			const items = await this.#host.listRoutines(context);
			const reply = formatRoutineListReply(items, this.#host.utcOffsetMinutes);
			await this.#deliverOutbound(message.channel, message.chatId, reply, sendOpts);
			return { settled: Promise.resolve({ kind: "command_handled", command: "routines" }) };
		}

		const spaceIdx = trimmed.indexOf(" ");
		const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
		const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

		if (sub === "cancel" || sub === "delete") {
			if (rest.length === 0) {
				await this.#deliverOutbound(message.channel, message.chatId, "用法：/routines cancel <id>", sendOpts);
				return { settled: Promise.resolve({ kind: "command_handled", command: "routines" }) };
			}
			const deleted = await this.#host.deleteRoutine(rest, context);
			await this.#deliverOutbound(message.channel, message.chatId, formatRoutineDeleteReply(deleted), sendOpts);
			return { settled: Promise.resolve({ kind: "command_handled", command: "routines" }) };
		}

		if (sub === "run") {
			if (rest.length === 0) {
				await this.#deliverOutbound(message.channel, message.chatId, "用法：/routines run <id>", sendOpts);
				return { settled: Promise.resolve({ kind: "command_handled", command: "routines" }) };
			}
			const outcome = await this.#host.runRoutineNow(rest, context);
			await this.#deliverOutbound(message.channel, message.chatId, formatRoutineRunReply(outcome), sendOpts);
			return { settled: Promise.resolve({ kind: "command_handled", command: "routines" }) };
		}

		await this.#deliverOutbound(
			message.channel,
			message.chatId,
			"用法：/routines [list | cancel <id> | run <id>]",
			sendOpts,
		);
		return { settled: Promise.resolve({ kind: "command_handled", command: "routines" }) };
	}

	async #handleMemoryCommand(
		arg: string | undefined,
		message: InboundChannelMessage,
		context: Context,
	): Promise<AdmittedIngest> {
		const sendOpts: ChannelSendOptions = { replyToMessageId: message.messageId };
		const trimmed = arg?.trim() ?? "";

		if (trimmed.length === 0 || trimmed === "list") {
			const inspected = await this.#host.inspectMemory(context);
			const reply =
				inspected.kind === "atomic"
					? formatMemoryInspectReply(inspected.snapshot, inspected.consolidation)
					: `[Memory] provider=${inspected.providerId} (static)\n${inspected.corePrompt ?? "(empty)"}`;
			await this.#deliverOutbound(message.channel, message.chatId, reply, sendOpts);
			return { settled: Promise.resolve({ kind: "command_handled", command: "memory" }) };
		}

		const spaceIdx = trimmed.indexOf(" ");
		const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
		const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

		if (sub === "consolidate") {
			const force = rest === "--force" || rest === "force";
			const report = await this.#host.consolidateMemory(context, { ...(force ? { force: true } : {}) });
			await this.#deliverOutbound(message.channel, message.chatId, formatConsolidationReportReply(report), sendOpts);
			return { settled: Promise.resolve({ kind: "command_handled", command: "memory" }) };
		}

		if (sub === "export") {
			const fmt = rest.toLowerCase() === "json" ? "json" : "md";
			const snapshot = await this.#host.exportPortableSnapshot(context, { transcriptScope: "active" });
			const rendered =
				fmt === "json" ? serializePortableSnapshotJson(snapshot, true) : renderPortableSnapshotMarkdown(snapshot);
			const maxChatChars = 3_500;
			const reply =
				rendered.length <= maxChatChars
					? rendered.trimEnd()
					: `${rendered.slice(0, maxChatChars)}\n...\n[已截断，完整快照请运行: npm --prefix apps/jehee run jehee -- export snapshot.${fmt}]`;
			await this.#deliverOutbound(message.channel, message.chatId, reply, sendOpts);
			return { settled: Promise.resolve({ kind: "command_handled", command: "memory" }) };
		}

		if (sub === "search") {
			if (rest.length === 0) {
				await this.#deliverOutbound(message.channel, message.chatId, "用法：/memory search <关键词>", sendOpts);
				return { settled: Promise.resolve({ kind: "command_handled", command: "memory" }) };
			}
			const result = await this.#host.searchMemory({ query: rest }, context);
			const reply =
				result.kind === "atomic"
					? formatMemorySearchReply(rest, result.hits)
					: `当前记忆插件 "${result.providerId}" 不支持按需检索。`;
			await this.#deliverOutbound(message.channel, message.chatId, reply, sendOpts);
			return { settled: Promise.resolve({ kind: "command_handled", command: "memory" }) };
		}

		if (sub === "forget") {
			if (rest.length === 0) {
				await this.#deliverOutbound(message.channel, message.chatId, "用法：/memory forget <id>", sendOpts);
				return { settled: Promise.resolve({ kind: "command_handled", command: "memory" }) };
			}
			const result = await this.#host.forgetMemory(rest, context, "owner_command");
			let reply: string;
			if (result.ok) {
				reply = result.alreadyForgotten
					? `记忆 ${result.item.id} 已处于遗忘状态。`
					: `已遗忘记忆 ${result.item.id}（${result.item.kind}）：${result.item.content}`;
			} else if (result.reason === "not_found") {
				reply = `未找到记忆 "${result.id}"。`;
			} else {
				reply = "当前记忆插件不支持遗忘操作。";
			}
			await this.#deliverOutbound(message.channel, message.chatId, reply, sendOpts);
			return { settled: Promise.resolve({ kind: "command_handled", command: "memory" }) };
		}

		if (sub === "restore") {
			if (rest.length === 0) {
				await this.#deliverOutbound(message.channel, message.chatId, "用法：/memory restore <id>", sendOpts);
				return { settled: Promise.resolve({ kind: "command_handled", command: "memory" }) };
			}
			const result = await this.#host.restoreMemory(rest, context);
			const reply = result.ok
				? result.alreadyActive
					? `记忆 ${result.item.id} 当前已是活跃状态。`
					: `已恢复记忆 ${result.item.id}（${result.item.kind}）：${result.item.content}`
				: `恢复失败：${result.message}`;
			await this.#deliverOutbound(message.channel, message.chatId, reply, sendOpts);
			return { settled: Promise.resolve({ kind: "command_handled", command: "memory" }) };
		}

		await this.#deliverOutbound(
			message.channel,
			message.chatId,
			"用法：/memory [list | search <关键词> | forget <id> | restore <id> | consolidate [--force] | export [md|json]]",
			sendOpts,
		);
		return { settled: Promise.resolve({ kind: "command_handled", command: "memory" }) };
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
				attachments: [],
				resolvers: [],
				rejecters: [],
				timer: undefined,
			};
			this.#buckets.set(routeKey, bucket);
		}
		if (trimmedText.length > 0) {
			bucket.texts.push(trimmedText);
		}
		if (message.attachments !== undefined && message.attachments.length > 0) {
			bucket.attachments.push(...message.attachments);
		}
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
				...(bucket.attachments.length > 0 ? { attachments: bucket.attachments } : {}),
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
			readonly attachments?: readonly ChannelAttachment[];
			readonly whenBusy?: "steer" | "followUp";
		},
		context: Context,
	): Promise<AdmittedIngest> {
		let textToSubmit = params.text;
		let images: readonly ImageContent[] | undefined;

		if (params.attachments !== undefined && params.attachments.length > 0) {
			const transport = this.#transports.get(params.channel);
			const downloaded = new Map<string, DownloadedChannelFile>();
			const failedIds = new Set<string>();
			const failedNotes: string[] = [];

			if (transport?.downloadFile !== undefined) {
				for (const att of params.attachments) {
					if (att.kind === "voice" || att.kind === "audio") continue;
					try {
						const file = await transport.downloadFile(att.fileId);
						downloaded.set(att.fileId, file);
					} catch (error) {
						failedIds.add(att.fileId);
						const reason = error instanceof Error ? error.message : String(error);
						failedNotes.push(
							`[Attachment download failed (${att.kind}): ${att.fileName ?? att.fileId} — ${reason}]`,
						);
					}
				}
			}

			const remaining =
				failedIds.size > 0 ? params.attachments.filter((att) => !failedIds.has(att.fileId)) : params.attachments;
			const formatted = formatInboundAttachmentsContext(remaining, downloaded);
			const allNotes = [...formatted.textNotes, ...failedNotes];
			const textAppendix = allNotes.join("\n\n");
			if (textAppendix.length > 0) {
				textToSubmit = textToSubmit.length > 0 ? `${textToSubmit}\n\n${textAppendix}` : textAppendix;
			}
			if (formatted.images.length > 0) {
				images = formatted.images;
			}
		}

		const pending = await this.#host.submitMessage(
			{
				text: textToSubmit,
				...(images !== undefined ? { images } : {}),
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
