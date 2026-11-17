// Workspace provisioning strategy for Jehee's Workshop. Default implementation targets InstaBox Free Plan (1 machine,
// 20 GiB persistent `/data` disk) by waking the single machine on demand and isolating tasks via Git worktrees.

import { posix } from "node:path";
import type { InstaBoxClient } from "./instabox-client.ts";

/** Metadata describing an isolated cloud workspace allocated to one Workshop subagent. */
export type ProvisionedWorkspace = {
	readonly machineId: string;
	readonly cwd: string;
	readonly repoPath?: string;
	readonly branchName?: string;
};

/** Request parameters for provisioning a Workshop workspace. */
export type ProvisionWorkspaceRequest = {
	readonly taskName: string;
	readonly idempotencyKey: string;
	readonly repoPath?: string;
	readonly baseRef?: string;
};

/** Pluggable strategy so single-box worktrees can be swapped for multi-machine `fork` on paid plans without touching orchestration. */
export interface WorkshopProvisioner {
	prepareWorkspace(request: ProvisionWorkspaceRequest): Promise<ProvisionedWorkspace>;
	cleanupWorkspace(workspace: ProvisionedWorkspace, idempotencyKey: string): Promise<void>;
}

const TASK_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** Validates and normalizes a human task name into a safe directory/branch slug. */
export function validateTaskSlug(name: string): string {
	const trimmed = name.trim();
	if (!TASK_SLUG_PATTERN.test(trimmed)) {
		throw new Error(`Invalid workshop task name "${name}": use 1-64 ASCII letters, digits, '.', '_', or '-'`);
	}
	return trimmed;
}

/** Options for `SingleBoxWorktreeProvisioner`. */
export type SingleBoxWorktreeOptions = {
	readonly client: InstaBoxClient;
	readonly machineId: string;
	/** Root directory on InstaBox's persistent `/data` disk (never `/tmp` RAM tmpfs). Defaults to `/data/jehee/worktrees`. */
	readonly worktreesRoot?: string;
};

/** Wakes a single InstaBox machine on demand and isolates concurrent Workshop tasks under `/data/jehee/worktrees/<name>`. */
export class SingleBoxWorktreeProvisioner implements WorkshopProvisioner {
	readonly #client: InstaBoxClient;
	readonly #machineId: string;
	readonly #worktreesRoot: string;

	constructor(options: SingleBoxWorktreeOptions) {
		this.#client = options.client;
		this.#machineId = options.machineId;
		this.#worktreesRoot = options.worktreesRoot ?? "/data/jehee/worktrees";
	}

	/** Wakes the machine if paused/stopped and creates an isolated git worktree (or scratch folder when `repoPath` is omitted). */
	async prepareWorkspace(request: ProvisionWorkspaceRequest): Promise<ProvisionedWorkspace> {
		const slug = validateTaskSlug(request.taskName);
		await this.#client.ensureRunning(this.#machineId, request.idempotencyKey);
		const cwd = posix.join(this.#worktreesRoot, slug);

		if (request.repoPath === undefined || request.repoPath.trim().length === 0) {
			const mkdirRes = await this.#client.exec(this.#machineId, {
				argv: ["mkdir", "-p", cwd],
			});
			if (mkdirRes.exitCode !== 0) {
				throw new Error(`Failed to create workshop directory ${cwd}: ${mkdirRes.stderr}`);
			}
			return { machineId: this.#machineId, cwd };
		}

		const repoPath = posix.normalize(request.repoPath.trim());
		const branchName = `jehee/${slug}`;
		await this.#client.exec(this.#machineId, {
			argv: ["mkdir", "-p", this.#worktreesRoot],
		});

		// Idempotent check: if the worktree already exists from an interrupted attempt, reuse it cleanly.
		const checkExisting = await this.#client.exec(this.#machineId, {
			argv: ["test", "-e", posix.join(cwd, ".git")],
		});
		if (checkExisting.exitCode === 0) {
			return { machineId: this.#machineId, cwd, repoPath, branchName };
		}

		const gitArgs =
			request.baseRef !== undefined && request.baseRef.trim().length > 0
				? ["git", "-C", repoPath, "worktree", "add", "-B", branchName, cwd, request.baseRef.trim()]
				: ["git", "-C", repoPath, "worktree", "add", "-B", branchName, cwd];
		const wtRes = await this.#client.exec(this.#machineId, { argv: gitArgs });
		if (wtRes.exitCode !== 0) {
			throw new Error(`Failed to create git worktree at ${cwd}: ${wtRes.stderr || wtRes.stdout}`);
		}
		return { machineId: this.#machineId, cwd, repoPath, branchName };
	}

	/** Removes the isolated git worktree or scratch directory on the woke machine. */
	async cleanupWorkspace(workspace: ProvisionedWorkspace, idempotencyKey: string): Promise<void> {
		await this.#client.ensureRunning(workspace.machineId, idempotencyKey);
		if (workspace.repoPath !== undefined) {
			const res = await this.#client.exec(workspace.machineId, {
				argv: ["git", "-C", workspace.repoPath, "worktree", "remove", "--force", workspace.cwd],
			});
			if (res.exitCode !== 0) {
				throw new Error(`Failed to remove git worktree ${workspace.cwd}: ${res.stderr || res.stdout}`);
			}
			return;
		}
		await this.#client.exec(workspace.machineId, {
			argv: ["rm", "-rf", workspace.cwd],
		});
	}
}
