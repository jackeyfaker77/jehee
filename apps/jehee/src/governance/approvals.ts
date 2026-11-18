// Durable write-confirmation gate backed by `pi-durable` `ApprovalDoc` and SHA-256 business-intent digests.
// Prevents head-of-line blocking on the single-entry root conversation while guaranteeing one-shot, tamper-proof execution.

import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type ToolExecutionApi } from "@earendil-works/pi-durable";

/** Default time-to-live (24 hours) for an unapproved or unconsumed write ticket. */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Lifecycle state of a write-approval ticket stored in `ApprovalDoc`. */
export type ApprovalTicketStatus = "pending" | "approved" | "rejected" | "consumed";

/** Persisted record for one gated mutating MCP tool invocation. */
export type ApprovalTicket = {
	id: string;
	server: string;
	tool: string;
	intentDigest: string;
	summary: string;
	status: ApprovalTicketStatus;
	createdAtMs: number;
	expiresAtMs: number;
};

/** Declarative policy governing which mutating (`readOnlyHint !== true`) MCP tools require human approval. */
export type WriteApprovalPolicy =
	| { readonly mode: "off" }
	| {
			readonly mode: "confirm-writes";
			/** Optional patterns (`"*"`, `"<server>/*"`, `"<server>/<tool>"`, or `"<tool>"`) exempt from approval. */
			readonly exemptTools?: readonly string[];
			/** Optional subset of patterns requiring approval; defaults to all mutating tools when omitted. */
			readonly matchTools?: readonly string[];
			/** Ticket validity window in ms (defaults to 24 hours). */
			readonly ttlMs?: number;
	  };

/** Listener notified whenever a new pending approval ticket is created and needs owner confirmation. */
export type ApprovalRequestListener = (ticket: ApprovalTicket) => void | Promise<void>;

/** Outcome of checking or creating a durable approval ticket inside a mutating MCP tool call. */
export type WriteApprovalCheckResult =
	| { readonly action: "allow"; readonly consumedTicketId?: string }
	| { readonly action: "block"; readonly ticket: ApprovalTicket; readonly isNewTicket: boolean };

/** Conversation-scoped durable document storing approval tickets across restarts and DO hibernations. */
export const ApprovalDoc = defineDoc<{
	seq: number;
	tickets: Record<string, ApprovalTicket>;
}>({
	kind: "jehee.governance.approvals",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ seq: 0, tickets: {} }),
	checkpointWhen: () => false,
});

const EPHEMERAL_CONCURRENCY_KEYS = new Set(["request_id", "expected_version"]);

function canonicalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => canonicalizeJson(item));
	}
	if (typeof value === "object" && value !== null) {
		const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
		const out: Record<string, unknown> = {};
		for (const key of sortedKeys) {
			const v = (value as Record<string, unknown>)[key];
			if (v !== undefined) {
				out[key] = canonicalizeJson(v);
			}
		}
		return out;
	}
	return value;
}

/**
 * Computes a deterministic SHA-256 hex digest over `(server, tool, businessArgs)`.
 * Strips top-level `request_id` and `expected_version` so optimistic-lock retries after approval match,
 * while any change to business fields (`id`, `to`, `subject`, `body`, `files`, etc.) produces a distinct digest.
 */
export function computeWriteIntentDigest(
	server: string,
	tool: string,
	args: Readonly<Record<string, unknown>>,
): string {
	const businessArgs: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(args)) {
		if (EPHEMERAL_CONCURRENCY_KEYS.has(key)) continue;
		if (val !== undefined) {
			businessArgs[key] = canonicalizeJson(val);
		}
	}
	const payload = JSON.stringify({
		server,
		tool,
		args: canonicalizeJson(businessArgs),
	});
	return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Builds a bounded, human-readable one-line summary of a write tool call for chat approval cards. */
export function summarizeWriteCall(
	server: string,
	tool: string,
	args: Readonly<Record<string, unknown>>,
	maxValueChars: number = 80,
): string {
	const preview: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(args)) {
		if (EPHEMERAL_CONCURRENCY_KEYS.has(key)) continue;
		if (typeof val === "string" && val.length > maxValueChars) {
			preview[key] = `${val.slice(0, maxValueChars)}…(${val.length} chars)`;
		} else if (Array.isArray(val)) {
			preview[key] = `[${val.length} item(s)]`;
		} else {
			preview[key] = val;
		}
	}
	const serialized = JSON.stringify(preview);
	const capped = serialized.length > 240 ? `${serialized.slice(0, 239)}…` : serialized;
	return `${server}/${tool} ${capped}`;
}

/** Checks whether `(server, tool)` matches any pattern in `patterns` (`"*"`, `"<server>/*"`, `"<server>/<tool>"`, `"<tool>"`). */
export function matchesWriteToolPattern(server: string, tool: string, patterns: readonly string[]): boolean {
	const qualified = `${server}/${tool}`;
	for (const raw of patterns) {
		const pat = raw.trim();
		if (pat.length === 0) continue;
		if (pat === "*" || pat === qualified || pat === tool) return true;
		if (pat.endsWith("/*") && pat.slice(0, -2) === server) return true;
	}
	return false;
}

/** Determines whether a mutating MCP call requires human confirmation under `policy`. */
export function requiresWriteApproval(policy: WriteApprovalPolicy | undefined, server: string, tool: string): boolean {
	if (policy === undefined || policy.mode === "off") return false;
	if (policy.exemptTools !== undefined && matchesWriteToolPattern(server, tool, policy.exemptTools)) {
		return false;
	}
	if (policy.matchTools !== undefined && policy.matchTools.length > 0) {
		return matchesWriteToolPattern(server, tool, policy.matchTools);
	}
	return true;
}

/** Prunes expired non-consumed tickets in place to keep `ApprovalDoc` compact over months of uptime. */
export function pruneExpiredTickets(tickets: Record<string, ApprovalTicket>, nowMs: number): void {
	for (const [id, ticket] of Object.entries(tickets)) {
		if (ticket.expiresAtMs <= nowMs) {
			delete tickets[id];
		}
	}
}

/**
 * Atomically evaluates a mutating MCP tool call against `ApprovalDoc`:
 * - Consumes a matching `"approved"` ticket (one-shot) and returns `"allow"`;
 * - Otherwise reuses an active `"pending"` ticket or creates a new one and returns `"block"`.
 */
export async function checkOrCreateWriteApproval(params: {
	readonly api: ToolExecutionApi;
	readonly context: Context;
	readonly policy: WriteApprovalPolicy | undefined;
	readonly server: string;
	readonly tool: string;
	readonly args: Readonly<Record<string, unknown>>;
	readonly rawArgsForSummary?: Readonly<Record<string, unknown>>;
}): Promise<WriteApprovalCheckResult> {
	const { api, context, policy, server, tool, args, rawArgsForSummary } = params;
	if (policy === undefined || policy.mode === "off" || !requiresWriteApproval(policy, server, tool)) {
		return { action: "allow" };
	}

	const ttlMs = policy.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
	const intentDigest = computeWriteIntentDigest(server, tool, args);
	const summary = summarizeWriteCall(server, tool, rawArgsForSummary ?? args);

	return api.commit(async (tx) => {
		const nowMs = api.now();
		const convId: ConversationId = api.conversationId;
		const doc = await tx.doc(ApprovalDoc, convId);
		pruneExpiredTickets(doc.tickets, nowMs);

		for (const ticket of Object.values(doc.tickets)) {
			if (ticket.status === "approved" && ticket.intentDigest === intentDigest) {
				ticket.status = "consumed";
				return { action: "allow", consumedTicketId: ticket.id } as const;
			}
		}

		for (const ticket of Object.values(doc.tickets)) {
			if (ticket.status === "pending" && ticket.intentDigest === intentDigest) {
				return { action: "block", ticket: { ...ticket }, isNewTicket: false } as const;
			}
		}

		doc.seq += 1;
		const id = `apv_${doc.seq}_${intentDigest.slice(0, 6)}`;
		const created: ApprovalTicket = {
			id,
			server,
			tool,
			intentDigest,
			summary,
			status: "pending",
			createdAtMs: nowMs,
			expiresAtMs: nowMs + ttlMs,
		};
		doc.tickets[id] = created;
		return { action: "block", ticket: { ...created }, isNewTicket: true } as const;
	}, context);
}
