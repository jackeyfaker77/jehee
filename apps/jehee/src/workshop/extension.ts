// Main-conversation `workshop` orchestration extension: spawns isolated background subagents backed by InstaBox worktrees,
// steers/stops/cleans them up, and durably reports completed outcomes back to the main agent and active chat channel.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	type Extension,
	LiveDoc,
	type TaskId,
} from "@earendil-works/pi-durable";
import { bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { extractAssistantText } from "../memory/contract.ts";
import type { InstaBoxClient } from "./instabox-client.ts";
import type { ProvisionedWorkspace, WorkshopProvisioner } from "./provisioner.ts";
import { createWorkshopSandboxExtension, WorkshopBindingDoc } from "./sandbox-tools.ts";

/** Tracked metadata for one named Workshop subagent registered on the main conversation. */
export type WorkshopTaskEntry = {
	conversationId: ConversationId;
	workspace: ProvisionedWorkspace;
	reported: EntryId[];
};

export const WorkshopRegistryDoc = defineDoc<{
	tasks: Record<string, WorkshopTaskEntry>;
	reporters: Record<string, TaskId>;
}>({
	kind: "jehee.workshop.registry",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ tasks: {}, reporters: {} }),
	checkpointWhen: () => false,
});

const WorkshopAnchor = defineTask<null, { phase: "done" }, null>({
	name: "jehee.workshop.anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, ctx) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
	},
	abort: (_anchor, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

type ReporterInput = {
	name: string;
	conversationId: ConversationId;
	message: string;
	followUp: boolean;
};

type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

/** Options for creating the Workshop runtime bundle. */
export type WorkshopBundleOptions = {
	readonly client: InstaBoxClient;
	readonly provisioner: WorkshopProvisioner;
	readonly onProactiveReply?: (replyText: string, answerEntryId: EntryId) => void | Promise<void>;
};

/** Both extensions installed into the Harness registry (sandbox tools stay off the root conversation). */
export type WorkshopBundle = {
	readonly orchestratorExtension: Extension;
	readonly sandboxExtension: Extension;
};

/** Builds the Workshop orchestrator extension (for root) and sandbox tools extension (for subagents only). */
export function createWorkshopBundle(options: WorkshopBundleOptions): WorkshopBundle {
	const sandboxExtension = createWorkshopSandboxExtension(options.client);

	const WorkshopReporter = defineTask<ReporterInput, ReporterState, null>({
		name: "jehee.workshop.reporter",
		version: 1,
		initial: () => ({ phase: "deliver" }),
		phases: {
			deliver: async (reporter, runtime, taskContext) => {
				const { name, conversationId, message, followUp } = reporter.input;
				const subagent = (await runtime.conversation(conversationId, taskContext))!;
				const submission = await subagent.submit(
					{
						type: "input",
						content: message,
						whenBusy: followUp ? "followUp" : "steer",
						requestId: `workshop-sub:${reporter.id}`,
					},
					taskContext,
				);
				const settled = await submission.wait(taskContext);
				await runtime.commit(async (tx) => {
					const next = (report?: string) =>
						({ status: "running", checkpoint: { phase: "report", report } }) as const;
					if (settled.status === "unanswered") {
						return next(
							settled.reason === "aborted" ? undefined : `[workshop:${name} failed] reason=${settled.reason}`,
						);
					}
					if (settled.type !== "input") return next();
					const entry = (await tx.doc(WorkshopRegistryDoc, runtime.conversationId)).tasks[name];
					if (entry === undefined || entry.reported.includes(settled.answer)) return next();
					entry.reported.push(settled.answer);
					const answerModel = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
						| AssistantMessage
						| undefined;
					const text = answerModel !== undefined ? extractAssistantText(answerModel) : "";
					return next(`[workshop:${name} completed] ${text}`);
				}, taskContext);
			},
			report: async (reporter, runtime, taskContext) => {
				const report = reporter.state.checkpoint.report;
				if (report !== undefined) {
					const main = (await runtime.conversation(runtime.conversationId, taskContext))!;
					const followUpSub = await main.submit(
						{
							type: "input",
							content: report,
							whenBusy: "followUp",
							requestId: `workshop-report:${reporter.id}`,
						},
						taskContext,
					);
					const mainSettled = await followUpSub.wait(taskContext);
					if (
						mainSettled.status === "done" &&
						mainSettled.type === "input" &&
						options.onProactiveReply !== undefined
					) {
						const ansEntry = await runtime.entry(AssistantEntry, mainSettled.answer, taskContext);
						const msg = ansEntry?.model?.[0];
						const mainReplyText = msg?.role === "assistant" ? extractAssistantText(msg) : "";
						if (mainReplyText.trim().length > 0) {
							await options.onProactiveReply(mainReplyText, mainSettled.answer);
						}
					}
				}
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
					taskContext,
				);
			},
		},
		abort: (_reporter, runtime, taskContext) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
	});

	let orchestratorExtension!: Extension;

	const workshopTool = defineTool({
		name: "workshop",
		description:
			"Manage isolated background cloud workshop tasks on InstaBox. Actions: spawn (name, message, optional repoPath/baseRef), " +
			"send (name, message, optional followUp), status (optional name), stop (name), cleanup (name).",
		parameters: obj({
			action: oneOf(["spawn", "send", "status", "stop", "cleanup"]),
			name: opt(str()),
			message: opt(str()),
			repoPath: opt(str()),
			baseRef: opt(str()),
			followUp: opt(bool()),
		}),
		replay: "unsafe",
		execute: async (args, api, callContext) => {
			const { action, name, message, repoPath, baseRef, followUp } = args;
			const respond = (text: string) => ({ output: [{ type: "text" as const, text }] });

			const snapshot = (await api.snapshot(WorkshopRegistryDoc, api.conversationId, callContext)) ?? {
				tasks: {},
				reporters: {},
			};

			if (action === "status") {
				const names = name === undefined ? Object.keys(snapshot.tasks) : [name];
				const lines: string[] = [];
				for (const each of names) {
					const found = Object.hasOwn(snapshot.tasks, each) ? snapshot.tasks[each] : undefined;
					if (found === undefined) continue;
					const busy = (await api.snapshot(LiveDoc, found.conversationId, callContext))?.run !== undefined;
					lines.push(`${each}: ${busy ? "working" : "idle"} (${found.workspace.cwd})`);
				}
				return respond(lines.length === 0 ? "No active workshop tasks." : lines.join("\n"));
			}

			if (name === undefined || name.trim().length === 0) {
				return { isError: true, ...respond(`Action "${action}" requires a task name.`) };
			}
			const existing = Object.hasOwn(snapshot.tasks, name) ? snapshot.tasks[name] : undefined;
			if (action !== "spawn" && existing === undefined) {
				return { isError: true, ...respond(`No workshop task named "${name}".`) };
			}

			if (action === "stop") {
				await (await api.conversation(existing!.conversationId, callContext))!.abort(callContext);
				return respond(`Stopped workshop task "${name}".`);
			}

			if (action === "cleanup") {
				await (await api.conversation(existing!.conversationId, callContext))!.abort(callContext);
				await options.provisioner.cleanupWorkspace(existing!.workspace, `cleanup:${api.taskId}:${name}`);
				await api.commit(async (tx) => {
					const doc = await tx.doc(WorkshopRegistryDoc, api.conversationId);
					delete doc.tasks[name];
				}, callContext);
				return respond(`Cleaned up workshop task "${name}" (${existing!.workspace.cwd}).`);
			}

			if (message === undefined || message.trim().length === 0) {
				return { isError: true, ...respond(`Action "${action}" requires a message.`) };
			}

			let provisioned: ProvisionedWorkspace | undefined;
			if (action === "spawn") {
				if (existing !== undefined) {
					return { isError: true, ...respond(`Workshop task "${name}" already exists; use send.`) };
				}
				provisioned = await options.provisioner.prepareWorkspace({
					taskName: name,
					idempotencyKey: `spawn:${api.taskId}:${name}`,
					...(repoPath !== undefined ? { repoPath } : {}),
					...(baseRef !== undefined ? { baseRef } : {}),
				});
			}

			const replyLine = await api.commit(async (tx) => {
				const doc = await tx.doc(WorkshopRegistryDoc, api.conversationId);
				const bg = { ownership: { kind: "conversation" }, background: true } as const;
				if (action === "spawn") {
					if (Object.hasOwn(doc.tasks, name)) {
						return `Workshop task "${name}" already exists; use send.`;
					}
					const ws = provisioned!;
					const anchor = await tx.createTask(WorkshopAnchor, null, bg);
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
					await configure(tx, child.id, {
						extensions: { remove: [orchestratorExtension], add: [sandboxExtension] },
						cwd: ws.cwd,
						instructions: `You are Jehee Workshop subagent "${name}" operating exclusively inside isolated worktree "${ws.cwd}". Complete the delegated task and return a concise factual summary.`,
					});
					const binding = await tx.doc(WorkshopBindingDoc, child.id);
					binding.machineId = ws.machineId;
					binding.cwd = ws.cwd;
					if (ws.repoPath !== undefined) binding.repoPath = ws.repoPath;
					doc.tasks[name] = { conversationId: child.id, workspace: ws, reported: [] };
				}
				const targetConvId = doc.tasks[name]!.conversationId;
				const repId = await tx.createTask(
					WorkshopReporter,
					{
						name,
						conversationId: targetConvId,
						message,
						followUp: action === "send" && followUp === true,
					},
					bg,
				);
				doc.reporters[String(api.taskId)] = repId;
				return action === "spawn"
					? `Started workshop task "${name}" in ${doc.tasks[name]!.workspace.cwd}.`
					: `Sent message to workshop task "${name}".`;
			}, callContext);

			return respond(replyLine);
		},
	});

	orchestratorExtension = defineExtension({
		name: "jehee.workshop.orchestrator",
		tasks: [WorkshopAnchor, WorkshopReporter],
		tools: [workshopTool],
	});

	return { orchestratorExtension, sandboxExtension };
}
