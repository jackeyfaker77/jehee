// Remote sandbox tools (`box_exec`, `box_read`, `box_write`) offered exclusively to Workshop subagent conversations,
// strictly scoped to each subagent's assigned worktree directory on InstaBox.

import { posix } from "node:path";
import { defineDoc, defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import type { InstaBoxClient } from "./instabox-client.ts";

/** Per-subagent durable document storing its assigned InstaBox machine and worktree root. */
export type WorkshopBindingState = {
	machineId: string;
	cwd: string;
	repoPath?: string;
};

export const WorkshopBindingDoc = defineDoc<WorkshopBindingState>({
	kind: "jehee.workshop.binding",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ machineId: "", cwd: "" }),
	checkpointWhen: () => false,
});

/** Resolves `targetPath` against `worktreeCwd` and rejects traversal outside `worktreeCwd`. */
export function resolveScopedSandboxPath(worktreeCwd: string, targetPath: string): string {
	const root = posix.resolve("/", worktreeCwd);
	const resolved = targetPath.startsWith("/") ? posix.resolve(targetPath) : posix.resolve(root, targetPath);
	if (resolved !== root && !resolved.startsWith(`${root}/`)) {
		throw new Error(`Path "${targetPath}" escapes assigned workshop worktree "${root}"`);
	}
	return resolved;
}

/** Creates the sandbox toolset extension installed only on Workshop subagent conversations. */
export function createWorkshopSandboxExtension(client: InstaBoxClient): Extension {
	const boxExec = defineTool({
		name: "box_exec",
		description: "Run a shell command inside your assigned InstaBox workshop worktree.",
		parameters: obj({
			command: str(),
			timeoutSeconds: opt(num()),
		}),
		replay: "unsafe",
		execute: async (args, api, context) => {
			const binding = await api.snapshot(WorkshopBindingDoc, api.conversationId, context);
			if (!binding || binding.machineId.length === 0 || binding.cwd.length === 0) {
				return {
					isError: true,
					output: [{ type: "text", text: "No workshop sandbox bound to this conversation." }],
				};
			}
			await client.ensureRunning(binding.machineId, `tool:${api.taskId}`);
			const res = await client.exec(binding.machineId, {
				cmd: args.command,
				cwd: binding.cwd,
				...(args.timeoutSeconds !== undefined ? { timeoutSeconds: args.timeoutSeconds } : {}),
			});
			const combined = [res.stdout, res.stderr].filter((s) => s.length > 0).join("\n");
			return {
				isError: res.exitCode !== 0,
				output: [{ type: "text", text: `exitCode=${res.exitCode}\n${combined}`.trim() }],
			};
		},
	});

	const boxRead = defineTool({
		name: "box_read",
		description: "Read a UTF-8 file inside your assigned InstaBox workshop worktree.",
		parameters: obj({
			path: str(),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const binding = await api.snapshot(WorkshopBindingDoc, api.conversationId, context);
			if (!binding || binding.machineId.length === 0 || binding.cwd.length === 0) {
				return {
					isError: true,
					output: [{ type: "text", text: "No workshop sandbox bound to this conversation." }],
				};
			}
			const safePath = resolveScopedSandboxPath(binding.cwd, args.path);
			await client.ensureRunning(binding.machineId, `tool:${api.taskId}`);
			const content = await client.readFileText(binding.machineId, safePath);
			return { output: [{ type: "text", text: content }] };
		},
	});

	const boxWrite = defineTool({
		name: "box_write",
		description: "Atomically write a UTF-8 file inside your assigned InstaBox workshop worktree.",
		parameters: obj({
			path: str(),
			content: str(),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const binding = await api.snapshot(WorkshopBindingDoc, api.conversationId, context);
			if (!binding || binding.machineId.length === 0 || binding.cwd.length === 0) {
				return {
					isError: true,
					output: [{ type: "text", text: "No workshop sandbox bound to this conversation." }],
				};
			}
			const safePath = resolveScopedSandboxPath(binding.cwd, args.path);
			await client.ensureRunning(binding.machineId, `tool:${api.taskId}`);
			await client.writeFileText(binding.machineId, safePath, args.content);
			return { output: [{ type: "text", text: `Wrote ${safePath}` }] };
		},
	});

	return defineExtension({
		name: "jehee.workshop.sandbox",
		tools: [boxExec, boxRead, boxWrite],
	});
}
