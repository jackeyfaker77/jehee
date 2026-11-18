// Main-conversation `workshop` orchestration extension: acts as a dual-mode gateway driving either external Coding Agent
// CLIs (`pi`, `opencode`, `antigravity`, `claude`, `codex`, `custom`) or the legacy `"builtin"` sandbox subagent inside
// isolated Git worktrees (remote InstaBox or local machine), with durable PID polling and Git diff verification.

import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineSignal,
	defineTask,
	defineTool,
	type EntryId,
	type Extension,
	LiveDoc,
	type TaskId,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { extractAssistantText } from "../memory/contract.ts";
import { InstaBoxWorkshopBackend, type StartedWorkshopJob, type WorkshopExecutionBackend } from "./backend.ts";
import {
	ALL_WORKSHOP_DRIVER_NAMES,
	buildCodingAgentArgv,
	type CustomCodingAgentTemplate,
	composeWorkshopPrompt,
	type ExternalWorkshopDriverName,
	formatWorkshopCompletionReport,
	type WorkshopDriverName,
} from "./coding-agent-driver.ts";
import type { InstaBoxClient } from "./instabox-client.ts";
import type { ProvisionedWorkspace, WorkshopProvisioner } from "./provisioner.ts";
import { createWorkshopSandboxExtension, WorkshopBindingDoc } from "./sandbox-tools.ts";

/** Default background polling interval (ms) while waiting for a detached external Coding Agent CLI job. */
export const DEFAULT_WORKSHOP_POLL_INTERVAL_MS = 1_500;

/** Tracked metadata for one named Workshop workspace registered on the main conversation. */
export type WorkshopTaskEntry = {
	driver: WorkshopDriverName;
	workspace: ProvisionedWorkspace;
	/** Populated only when `driver === "builtin"` (in-process subagent conversation). */
	conversationId?: ConversationId;
	reported: EntryId[];
	completedTurns: number;
	activeRunnerTaskId?: TaskId;
	activeJob?: StartedWorkshopJob;
	activeSignalKey?: string;
	cancelledJobIds: string[];
	queuedFollowUps: string[];
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

const WorkshopCancelSignal = defineSignal({
	name: "jehee.workshop.cancel",
	version: 1,
	schema: obj({ stop: bool() }),
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

type CliRunnerInput = {
	name: string;
	driver: ExternalWorkshopDriverName;
	workspace: ProvisionedWorkspace;
	message: string;
	isContinuation: boolean;
	corePrompt?: string;
};

type CliRunnerState =
	| { phase: "start" }
	| { phase: "poll"; job: StartedWorkshopJob; pollSeq: number; signalKey: string }
	| { phase: "report"; report?: string };

/** Options for creating the Workshop runtime bundle. */
export type WorkshopBundleOptions = {
	/** Execution backend (`InstaBoxWorkshopBackend` or `LocalWorktreeBackend`). */
	readonly backend?: WorkshopExecutionBackend;
	/** Legacy InstaBox client (used if `backend` is omitted, and required only when `driver === "builtin"`). */
	readonly client?: InstaBoxClient;
	/** Legacy InstaBox provisioner (used if `backend` is omitted). */
	readonly provisioner?: WorkshopProvisioner;
	/** Default Coding Agent driver when `workshop(spawn)` omits `driver`. */
	readonly defaultDriver?: WorkshopDriverName;
	/** Optional `--model` / `-m` passed to external Coding Agent CLIs. */
	readonly agentModel?: string;
	/** Optional custom argv template used when `driver === "custom"`. */
	readonly customTemplate?: CustomCodingAgentTemplate;
	/** Polling interval in ms for detached external CLI jobs (defaults to 1500 ms). */
	readonly pollIntervalMs?: number;
	/** Optional callback returning current L1 Core memory prompt for turn-1 Workshop brief injection. */
	readonly getCorePrompt?: (conversationId: string) => string | undefined | Promise<string | undefined>;
	readonly onProactiveReply?: (replyText: string, answerEntryId: EntryId) => void | Promise<void>;
};

/** Extensions installed into the Harness registry (sandbox tools stay off the root conversation). */
export type WorkshopBundle = {
	readonly orchestratorExtension: Extension;
	readonly sandboxExtension?: Extension;
};

function resolveExecutionBackend(options: WorkshopBundleOptions): WorkshopExecutionBackend {
	if (options.backend !== undefined) return options.backend;
	if (options.client !== undefined && options.provisioner !== undefined) {
		return new InstaBoxWorkshopBackend({
			client: options.client,
			provisioner: options.provisioner,
		});
	}
	throw new Error("WorkshopBundleOptions requires either `backend` or both `client` and `provisioner`");
}

function resolveInstaBoxClient(
	options: WorkshopBundleOptions,
	backend: WorkshopExecutionBackend,
): InstaBoxClient | undefined {
	if (options.client !== undefined) return options.client;
	if (backend instanceof InstaBoxWorkshopBackend) return backend.client;
	return undefined;
}

/** Builds the Workshop orchestrator extension (for root) and optional builtin sandbox tools extension. */
export function createWorkshopBundle(options: WorkshopBundleOptions): WorkshopBundle {
	const backend = resolveExecutionBackend(options);
	const ibClient = resolveInstaBoxClient(options, backend);
	const sandboxExtension = ibClient !== undefined ? createWorkshopSandboxExtension(ibClient) : undefined;
	const defaultDriver: WorkshopDriverName = options.defaultDriver ?? (backend.kind === "local" ? "pi" : "builtin");
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WORKSHOP_POLL_INTERVAL_MS;

	type ReportRuntime = Pick<
		TaskRuntime<unknown, { phase: string }, null, Record<string, never>>,
		"conversationId" | "conversation" | "entry"
	>;

	async function deliverProactiveReportToMain(
		reportText: string | undefined,
		requestId: string,
		runtime: ReportRuntime,
		taskContext: Context,
	): Promise<void> {
		if (reportText === undefined) return;
		const main = (await runtime.conversation(runtime.conversationId, taskContext))!;
		const followUpSub = await main.submit(
			{
				type: "input",
				content: reportText,
				whenBusy: "followUp",
				requestId,
			},
			taskContext,
		);
		const mainSettled = await followUpSub.wait(taskContext);
		if (mainSettled.status === "done" && mainSettled.type === "input" && options.onProactiveReply !== undefined) {
			const ansEntry = await runtime.entry(AssistantEntry, mainSettled.answer, taskContext);
			const msg = ansEntry?.model?.[0];
			const mainReplyText = msg?.role === "assistant" ? extractAssistantText(msg) : "";
			if (mainReplyText.trim().length > 0) {
				await options.onProactiveReply(mainReplyText, mainSettled.answer);
			}
		}
	}

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
				await deliverProactiveReportToMain(
					reporter.state.checkpoint.report,
					`workshop-report:${reporter.id}`,
					runtime,
					taskContext,
				);
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
					taskContext,
				);
			},
		},
		abort: (_reporter, runtime, taskContext) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
	});

	const WorkshopCliRunner = defineTask<CliRunnerInput, CliRunnerState, null>({
		name: "jehee.workshop.cli-runner",
		version: 1,
		initial: () => ({ phase: "start" }),
		phases: {
			start: async (runner, runtime, taskContext) => {
				const { name, driver, workspace, message, isContinuation, corePrompt } = runner.input;
				const prompt = composeWorkshopPrompt({
					message,
					...(corePrompt !== undefined ? { corePrompt } : {}),
					isContinuation,
				});
				const argv = buildCodingAgentArgv({
					driver,
					prompt,
					cwd: workspace.cwd,
					isContinuation,
					...(options.agentModel !== undefined ? { model: options.agentModel } : {}),
					...(options.customTemplate !== undefined ? { customTemplate: options.customTemplate } : {}),
				});
				const job = await backend.startJob(workspace, {
					jobId: `job-${String(runner.id)}`,
					argv,
				});
				const signalKey = `stop-${String(runner.id)}-1`;
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(WorkshopRegistryDoc, runtime.conversationId);
					const entry = doc.tasks[name];
					if (entry === undefined || entry.cancelledJobIds.includes(job.jobId)) {
						return { status: "terminal", outcome: { status: "completed", result: null } } as const;
					}
					entry.activeRunnerTaskId = runner.id;
					entry.activeJob = job;
					entry.activeSignalKey = signalKey;
					return {
						status: "sleeping",
						signals: [WorkshopCancelSignal.key(signalKey)],
						until: runtime.now() + pollIntervalMs,
						checkpoint: { phase: "poll", job, pollSeq: 1, signalKey },
					} as const;
				}, taskContext);
			},

			poll: async (runner, runtime, taskContext) => {
				const { name, driver, workspace } = runner.input;
				const { job, pollSeq, signalKey } = runner.state.checkpoint;

				const sigState = await runtime.readSignal(WorkshopCancelSignal, signalKey, taskContext);
				if (sigState !== undefined && "value" in sigState && sigState.value.stop) {
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
						taskContext,
					);
					return;
				}

				const currentDoc = await runtime.snapshot(WorkshopRegistryDoc, runtime.conversationId, taskContext);
				const currentEntry = currentDoc?.tasks[name];
				if (currentEntry === undefined || currentEntry.cancelledJobIds.includes(job.jobId)) {
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
						taskContext,
					);
					return;
				}

				const polled = await backend.pollJob(workspace, job);
				if (polled.state === "running") {
					const nextSeq = pollSeq + 1;
					const nextKey = `stop-${String(runner.id)}-${nextSeq}`;
					await runtime.commit(async (tx) => {
						const doc = await tx.doc(WorkshopRegistryDoc, runtime.conversationId);
						const entry = doc.tasks[name];
						if (entry === undefined || entry.cancelledJobIds.includes(job.jobId)) {
							return { status: "terminal", outcome: { status: "completed", result: null } } as const;
						}
						entry.activeSignalKey = nextKey;
						return {
							status: "sleeping",
							signals: [WorkshopCancelSignal.key(nextKey)],
							until: runtime.now() + pollIntervalMs,
							checkpoint: { phase: "poll", job, pollSeq: nextSeq, signalKey: nextKey },
						} as const;
					}, taskContext);
					return;
				}

				const gitSummary = await backend.inspectGitSummary(workspace);
				const report = formatWorkshopCompletionReport({
					taskName: name,
					driver,
					cwd: workspace.cwd,
					exitCode: polled.exitCode,
					stdout: polled.stdout,
					stderr: polled.stderr,
					...(gitSummary !== undefined ? { gitSummary } : {}),
				});

				await runtime.commit(async (tx) => {
					const doc = await tx.doc(WorkshopRegistryDoc, runtime.conversationId);
					const entry = doc.tasks[name];
					if (entry === undefined || entry.cancelledJobIds.includes(job.jobId)) {
						return { status: "running", checkpoint: { phase: "report" } } as const;
					}
					entry.completedTurns += 1;
					entry.activeRunnerTaskId = undefined;
					entry.activeJob = undefined;
					entry.activeSignalKey = undefined;

					if (entry.queuedFollowUps.length > 0) {
						const nextInstruction = entry.queuedFollowUps.splice(0).join("\n\n");
						const bg = { ownership: { kind: "conversation" }, background: true } as const;
						const nextRunnerId = await tx.createTask(
							WorkshopCliRunner,
							{
								name,
								driver,
								workspace,
								message: nextInstruction,
								isContinuation: true,
							},
							bg,
						);
						entry.activeRunnerTaskId = nextRunnerId;
						doc.reporters[String(nextRunnerId)] = nextRunnerId;
					}
					return { status: "running", checkpoint: { phase: "report", report } } as const;
				}, taskContext);
			},

			report: async (runner, runtime, taskContext) => {
				await deliverProactiveReportToMain(
					runner.state.checkpoint.report,
					`workshop-cli-report:${runner.id}`,
					runtime,
					taskContext,
				);
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
					taskContext,
				);
			},
		},
		abort: async (runner, runtime, taskContext) => {
			if (runner.state.checkpoint.phase === "poll") {
				await backend.stopJob(runner.input.workspace, runner.state.checkpoint.job).catch(() => undefined);
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
		},
	});

	let orchestratorExtension!: Extension;

	const workshopTool = defineTool({
		name: "workshop",
		description:
			"Manage isolated background Workshop tasks in dedicated Git worktrees. Supports external Coding Agent CLIs " +
			"(`pi`, `opencode`, `antigravity`, `claude`, `codex`, `custom`) and `builtin`. Actions: spawn (name, message, optional driver/repoPath/baseRef), " +
			"send (name, message, optional followUp), status (optional name), stop (name), cleanup (name).",
		parameters: obj({
			action: oneOf(["spawn", "send", "status", "stop", "cleanup"]),
			name: opt(str()),
			message: opt(str()),
			driver: opt(oneOf([...ALL_WORKSHOP_DRIVER_NAMES])),
			repoPath: opt(str()),
			baseRef: opt(str()),
			followUp: opt(bool()),
		}),
		replay: "unsafe",
		execute: async (args, api, callContext) => {
			const { action, name, message, driver: requestedDriver, repoPath, baseRef, followUp } = args;
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
					if (found.driver === "builtin" && found.conversationId !== undefined) {
						const busy = (await api.snapshot(LiveDoc, found.conversationId, callContext))?.run !== undefined;
						lines.push(`${each}: ${busy ? "working" : "idle"} (${found.workspace.cwd})`);
					} else {
						const busy = found.activeRunnerTaskId !== undefined;
						const pidNote = found.activeJob?.pid !== undefined ? `, pid=${found.activeJob.pid}` : "";
						lines.push(
							`${each}: ${busy ? "working" : "idle"} [driver=${found.driver}, turns=${found.completedTurns}${pidNote}] (${found.workspace.cwd})`,
						);
					}
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

			const stopExternalRunnerIfActive = async (target: WorkshopTaskEntry) => {
				if (target.activeJob !== undefined) {
					await backend.stopJob(target.workspace, target.activeJob);
				}
				await api.commit(async (tx) => {
					if (target.activeRunnerTaskId !== undefined && target.activeSignalKey !== undefined) {
						await tx.signal(target.activeRunnerTaskId, WorkshopCancelSignal, target.activeSignalKey, {
							stop: true,
						});
					}
					const doc = await tx.doc(WorkshopRegistryDoc, api.conversationId);
					const liveEntry = doc.tasks[name];
					if (liveEntry !== undefined) {
						if (liveEntry.activeJob !== undefined) {
							liveEntry.cancelledJobIds.push(liveEntry.activeJob.jobId);
						}
						liveEntry.activeRunnerTaskId = undefined;
						liveEntry.activeJob = undefined;
						liveEntry.activeSignalKey = undefined;
						liveEntry.queuedFollowUps = [];
					}
				}, callContext);
			};

			if (action === "stop") {
				if (existing!.driver === "builtin" && existing!.conversationId !== undefined) {
					await (await api.conversation(existing!.conversationId, callContext))!.abort(callContext);
				} else {
					await stopExternalRunnerIfActive(existing!);
				}
				return respond(`Stopped workshop task "${name}".`);
			}

			if (action === "cleanup") {
				if (existing!.driver === "builtin" && existing!.conversationId !== undefined) {
					await (await api.conversation(existing!.conversationId, callContext))!.abort(callContext);
				} else {
					await stopExternalRunnerIfActive(existing!);
				}
				await backend.cleanupWorkspace(existing!.workspace, `cleanup:${api.taskId}:${name}`);
				await api.commit(async (tx) => {
					const doc = await tx.doc(WorkshopRegistryDoc, api.conversationId);
					delete doc.tasks[name];
				}, callContext);
				return respond(`Cleaned up workshop task "${name}" (${existing!.workspace.cwd}).`);
			}

			if (message === undefined || message.trim().length === 0) {
				return { isError: true, ...respond(`Action "${action}" requires a message.`) };
			}

			const chosenDriver: WorkshopDriverName =
				action === "spawn" ? (requestedDriver ?? defaultDriver) : existing!.driver;

			if (chosenDriver === "builtin" && sandboxExtension === undefined) {
				return {
					isError: true,
					...respond(
						'Workshop driver "builtin" requires an InstaBox sandbox client; select an external CLI driver (`pi`, `opencode`, `antigravity`, `claude`, `codex`).',
					),
				};
			}

			let provisioned: ProvisionedWorkspace | undefined;
			if (action === "spawn") {
				if (existing !== undefined) {
					return { isError: true, ...respond(`Workshop task "${name}" already exists; use send.`) };
				}
				provisioned = await backend.prepareWorkspace({
					taskName: name,
					idempotencyKey: `spawn:${api.taskId}:${name}`,
					...(repoPath !== undefined ? { repoPath } : {}),
					...(baseRef !== undefined ? { baseRef } : {}),
				});
			}

			// If `send` targets an active external CLI job with `followUp === false`, stop the active job before restarting with `--continue`.
			if (
				action === "send" &&
				chosenDriver !== "builtin" &&
				existing!.activeJob !== undefined &&
				followUp !== true
			) {
				await stopExternalRunnerIfActive(existing!);
			}

			const corePrompt = await options.getCorePrompt?.(String(api.conversationId));

			const replyLine = await api.commit(async (tx) => {
				const doc = await tx.doc(WorkshopRegistryDoc, api.conversationId);
				const bg = { ownership: { kind: "conversation" }, background: true } as const;

				if (chosenDriver === "builtin") {
					if (action === "spawn") {
						if (Object.hasOwn(doc.tasks, name)) {
							return `Workshop task "${name}" already exists; use send.`;
						}
						const ws = provisioned!;
						const anchor = await tx.createTask(WorkshopAnchor, null, bg);
						const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
						await configure(tx, child.id, {
							extensions: { remove: [orchestratorExtension], add: [sandboxExtension!] },
							cwd: ws.cwd,
							instructions: `You are Jehee Workshop subagent "${name}" operating exclusively inside isolated worktree "${ws.cwd}". Complete the delegated task and return a concise factual summary.`,
						});
						const binding = await tx.doc(WorkshopBindingDoc, child.id);
						binding.machineId = ws.machineId;
						binding.cwd = ws.cwd;
						if (ws.repoPath !== undefined) binding.repoPath = ws.repoPath;
						doc.tasks[name] = {
							driver: "builtin",
							conversationId: child.id,
							workspace: ws,
							reported: [],
							completedTurns: 0,
							cancelledJobIds: [],
							queuedFollowUps: [],
						};
					}
					const targetConvId = doc.tasks[name]!.conversationId!;
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
				}

				// External Coding Agent CLI gateway path (`pi`, `opencode`, `antigravity`, `claude`, `codex`, `custom`)
				if (action === "spawn") {
					if (Object.hasOwn(doc.tasks, name)) {
						return `Workshop task "${name}" already exists; use send.`;
					}
					const ws = provisioned!;
					doc.tasks[name] = {
						driver: chosenDriver,
						workspace: ws,
						reported: [],
						completedTurns: 0,
						cancelledJobIds: [],
						queuedFollowUps: [],
					};
				}

				const taskEntry = doc.tasks[name]!;
				if (action === "send" && taskEntry.activeRunnerTaskId !== undefined && followUp === true) {
					taskEntry.queuedFollowUps.push(message);
					return `Queued follow-up instruction for workshop task "${name}" [driver=${taskEntry.driver}].`;
				}

				const isContinuation = action === "send" || taskEntry.completedTurns > 0;
				const runnerId = await tx.createTask(
					WorkshopCliRunner,
					{
						name,
						driver: chosenDriver,
						workspace: taskEntry.workspace,
						message,
						isContinuation,
						...(corePrompt !== undefined ? { corePrompt } : {}),
					},
					bg,
				);
				taskEntry.activeRunnerTaskId = runnerId;
				doc.reporters[String(runnerId)] = runnerId;
				return action === "spawn"
					? `Started workshop task "${name}" [driver=${chosenDriver}] in ${taskEntry.workspace.cwd}.`
					: `Sent continuation instruction to workshop task "${name}" [driver=${chosenDriver}].`;
			}, callContext);

			return respond(replyLine);
		},
	});

	orchestratorExtension = defineExtension({
		name: "jehee.workshop.orchestrator",
		tasks: [WorkshopAnchor, WorkshopReporter, WorkshopCliRunner],
		tools: [workshopTool],
	});

	return {
		orchestratorExtension,
		...(sandboxExtension !== undefined ? { sandboxExtension } : {}),
	};
}
