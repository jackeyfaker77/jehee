// Session-scoped `pi-durable` governance documents for Slice 6C (ADR-0016):
// - `HeldNotificationsDoc`: durable FIFO-capped buffer for quiet-hours / busy-yield / cooldown proactive notifications;
// - `RuntimeModelDoc`: durable runtime `/model` override persisted across restarts and Cloudflare DO hibernations;
// - Pure detached-clone state helpers and slash-command reply formatters (`/model`, `/model list`, `/mcp`).
// 100% Web/Edge portable (zero Node-specific imports).

import { defineDoc, type ModelRef } from "@earendil-works/pi-durable";
import { type ChannelRoute, formatRouteKey } from "../channels/contract.ts";
import { DEFAULT_UTC_OFFSET_MINUTES, formatLocalDateTime } from "../routines/scheduler.ts";
import type { HeldProactiveMessage } from "./quiet-gate.ts";

/** Maximum number of deferred proactive notifications retained in `HeldNotificationsDoc` (FIFO eviction past cap). */
export const MAX_HELD_NOTIFICATIONS = 50;

/** Persistent state stored in `HeldNotificationsDoc` (`kind: "jehee.held_notifications"`, `scope: "session"`). */
export type HeldNotificationsState = {
	items: HeldProactiveMessage[];
};

/** Persistent state stored in `RuntimeModelDoc` (`kind: "jehee.runtime_model"`, `scope: "session"`). */
export type RuntimeModelState = {
	override?: ModelRef;
	updatedAtMs?: number;
};

/** Summary payload consumed by `formatModelStatusReply`. */
export type ModelStatusSummary = {
	readonly active: ModelRef;
	readonly defaultModel: ModelRef;
	readonly isOverride: boolean;
	readonly updatedAtMs?: number;
	readonly utcOffsetMinutes?: number;
};

/** One selectable model entry rendered by `formatModelListReply`. */
export type AvailableModelEntry = {
	readonly provider: string;
	readonly modelId: string;
	readonly name?: string;
};

/** Connected MCP server count entry rendered by `formatMcpStatusReply`. */
export type McpConnectedServerSummary = {
	readonly name: string;
	readonly toolCount: number;
};

/** Failed MCP server diagnostic entry rendered by `formatMcpStatusReply`. */
export type McpFailedServerSummary = {
	readonly name: string;
	readonly error: string;
};

/** Snapshot payload consumed by `formatMcpStatusReply` (structurally compatible with `McpReconnectReport`). */
export type McpStatusReplyInput = {
	readonly connected: readonly McpConnectedServerSummary[];
	readonly failed: readonly McpFailedServerSummary[];
	readonly reconnected?: boolean;
};

/** Creates a fresh empty `HeldNotificationsState`. */
export function createEmptyHeldNotificationsState(): HeldNotificationsState {
	return { items: [] };
}

/** Creates a fresh empty `RuntimeModelState`. */
export function createEmptyRuntimeModelState(): RuntimeModelState {
	return {};
}

/** Durable session-scoped document storing deferred proactive notifications across restarts and DO hibernations. */
export const HeldNotificationsDoc = defineDoc<HeldNotificationsState>({
	kind: "jehee.held_notifications",
	version: 1,
	scope: "session",
	initial: createEmptyHeldNotificationsState,
	checkpointWhen: () => false,
});

/** Durable session-scoped document persisting the owner's runtime `/model` override across restarts and DO hibernations. */
export const RuntimeModelDoc = defineDoc<RuntimeModelState>({
	kind: "jehee.runtime_model",
	version: 1,
	scope: "session",
	initial: createEmptyRuntimeModelState,
	checkpointWhen: () => false,
});

/** Returns a detached plain-data clone of a `HeldProactiveMessage` (safe to pass outside a `pi-durable` tx). */
export function cloneHeldNotification(item: HeldProactiveMessage): HeldProactiveMessage {
	return {
		route: { channel: item.route.channel, chatId: item.route.chatId },
		text: item.text,
		reason: item.reason,
		heldAtMs: item.heldAtMs,
	};
}

/** Returns a detached plain-data clone of a `ModelRef` (safe to pass outside a `pi-durable` tx). */
export function cloneModelRef(ref: ModelRef): ModelRef {
	return { provider: ref.provider, modelId: ref.modelId };
}

/**
 * Appends one deferred proactive notification into `state` inside a durable transaction, evicting the oldest entries
 * past `maxItems` (default `MAX_HELD_NOTIFICATIONS = 50`). Always returns a detached plain clone, never a tx proxy.
 */
export function appendHeldNotificationInState(
	state: HeldNotificationsState,
	item: HeldProactiveMessage,
	maxItems: number = MAX_HELD_NOTIFICATIONS,
): HeldProactiveMessage {
	const normalized: HeldProactiveMessage = {
		route: { channel: item.route.channel, chatId: item.route.chatId },
		text: item.text.trim(),
		reason: item.reason,
		heldAtMs: item.heldAtMs,
	};
	state.items.push(normalized);
	const cap = Math.max(1, Math.floor(maxItems));
	if (state.items.length > cap) {
		state.items.splice(0, state.items.length - cap);
	}
	return cloneHeldNotification(normalized);
}

/** Returns detached clones of held notifications in `state` (optionally filtered to `targetRoute`). */
export function listHeldNotificationsFromState(
	state: HeldNotificationsState,
	targetRoute?: ChannelRoute,
): HeldProactiveMessage[] {
	if (state.items.length === 0) return [];
	const targetKey = targetRoute !== undefined ? formatRouteKey(targetRoute.channel, targetRoute.chatId) : undefined;
	const out: HeldProactiveMessage[] = [];
	for (const item of state.items) {
		const cloned = cloneHeldNotification(item);
		if (targetKey === undefined || formatRouteKey(cloned.route.channel, cloned.route.chatId) === targetKey) {
			out.push(cloned);
		}
	}
	return out;
}

/**
 * Removes and returns held notifications from `state` (all routes, or only `targetRoute` when provided).
 * Every returned item is a detached plain clone, never a `pi-durable` transaction overlay proxy.
 */
export function drainHeldNotificationsInState(
	state: HeldNotificationsState,
	targetRoute?: ChannelRoute,
): HeldProactiveMessage[] {
	if (state.items.length === 0) return [];
	const targetKey = targetRoute !== undefined ? formatRouteKey(targetRoute.channel, targetRoute.chatId) : undefined;
	const drained: HeldProactiveMessage[] = [];
	const remaining: HeldProactiveMessage[] = [];
	for (const item of state.items) {
		const cloned = cloneHeldNotification(item);
		if (targetKey === undefined || formatRouteKey(cloned.route.channel, cloned.route.chatId) === targetKey) {
			drained.push(cloned);
		} else {
			remaining.push(cloned);
		}
	}
	state.items = remaining;
	return drained;
}

/** Reads a detached `ModelRef` override from `RuntimeModelState`, or `undefined` when using the host default model. */
export function readRuntimeModelOverride(state: RuntimeModelState): ModelRef | undefined {
	return state.override !== undefined ? cloneModelRef(state.override) : undefined;
}

/** Formats a `ModelRef` as `"<provider>/<modelId>"`. */
export function formatModelRef(ref: ModelRef): string {
	return `${ref.provider}/${ref.modelId}`;
}

/** Parses `"<provider>/<modelId>"` (splitting on the first `/`) into a `ModelRef`, or `undefined` if malformed. */
export function parseModelRefSpec(raw: string): ModelRef | undefined {
	const trimmed = raw.trim();
	const slashIdx = trimmed.indexOf("/");
	if (slashIdx <= 0 || slashIdx >= trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, slashIdx).trim();
	const modelId = trimmed.slice(slashIdx + 1).trim();
	if (provider.length === 0 || modelId.length === 0) return undefined;
	return { provider, modelId };
}

/** Formats `/model` status reply showing active model, default model, override state, and usage hint. */
export function formatModelStatusReply(status: ModelStatusSummary): string {
	const activeLabel = formatModelRef(status.active);
	const defaultLabel = formatModelRef(status.defaultModel);
	const lines: string[] = [];
	if (status.isOverride) {
		const updatedPart =
			status.updatedAtMs !== undefined
				? `，更新于 ${formatLocalDateTime(status.updatedAtMs, status.utcOffsetMinutes ?? DEFAULT_UTC_OFFSET_MINUTES)}`
				: "";
		lines.push(`[Model] 当前模型：${activeLabel}（运行时覆盖；默认：${defaultLabel}${updatedPart}）`);
	} else {
		lines.push(`[Model] 当前模型：${activeLabel}（默认模型）`);
	}
	lines.push("用法：/model [list | <provider>/<modelId> | reset]");
	return lines.join("\n");
}

/** Formats `/model list` reply enumerating available registry models and highlighting the active model. */
export function formatModelListReply(models: readonly AvailableModelEntry[], active?: ModelRef): string {
	if (models.length === 0) {
		return "[Model] 当前注册表中暂无可用模型。";
	}
	const lines = [`[Model] 可用模型（共 ${models.length} 个）：`];
	for (const entry of models) {
		const isCurrent = active !== undefined && active.provider === entry.provider && active.modelId === entry.modelId;
		const namePart =
			entry.name !== undefined && entry.name.trim().length > 0 && entry.name.trim() !== entry.modelId
				? ` (${entry.name.trim()})`
				: "";
		lines.push(`- ${entry.provider}/${entry.modelId}${namePart}${isCurrent ? " [当前]" : ""}`);
	}
	lines.push("切换模型：/model <provider>/<modelId>（恢复默认：/model reset）");
	return lines.join("\n");
}

/** Formats `/mcp` or `/mcp reconnect` status reply with connected tool counts and sanitized failed-server diagnostics. */
export function formatMcpStatusReply(status: McpStatusReplyInput): string {
	const connectedCount = status.connected.length;
	const failedCount = status.failed.length;
	const prefix = status.reconnected === true ? "[MCP] 重连完成" : "[MCP] 状态";
	if (connectedCount === 0 && failedCount === 0) {
		return `${prefix}：当前未配置任何 MCP 服务。`;
	}
	const lines = [`${prefix}：已连接 ${connectedCount} 个，失败 ${failedCount} 个`];
	for (const server of status.connected) {
		lines.push(`- [OK] ${server.name}（${server.toolCount} 个工具）`);
	}
	for (const failed of status.failed) {
		lines.push(`- [FAIL] ${failed.name}：${failed.error}`);
	}
	if (failedCount > 0 && status.reconnected !== true) {
		lines.push("提示：可发送 /mcp reconnect 尝试重新连接失败的 MCP 服务。");
	}
	return lines.join("\n");
}
