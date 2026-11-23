// Node-only local Git Worktree and child-process execution backend for Jehee's Workshop gateway.
// Kept strictly outside `src/core/host.ts` and `worker.ts` so Cloudflare Workers bundles remain 100% free of `child_process`.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
	buildGitSummaryBlock,
	type StartedWorkshopJob,
	type StartWorkshopJobRequest,
	WORKSHOP_META_DIR,
	type WorkshopExecutionBackend,
	type WorkshopJobPollResult,
} from "./backend.ts";
import { type ProvisionedWorkspace, type ProvisionWorkspaceRequest, validateTaskSlug } from "./provisioner.ts";

/** Options configuring a local-machine Git Worktree Workshop backend. */
export type LocalWorktreeBackendOptions = {
	/** Root directory where isolated `<slug>` worktrees are created (e.g. `E:/CODE/.jehee-worktrees`). */
	readonly worktreesRoot: string;
	/** Optional default Git repository path used when `workshop(spawn)` omits `repoPath`. */
	readonly defaultRepoPath?: string;
	/** Optional base environment merged into spawned Coding Agent CLI child processes. */
	readonly env?: Readonly<Record<string, string | undefined>>;
};

type ActiveLocalProcess = {
	readonly child: ChildProcess;
	settled: WorkshopJobPollResult | undefined;
};

const SAFE_JOB_ID = /^[a-zA-Z0-9._-]+$/;
const MAX_CAPTURE_CHARS = 24_576;

function appendBounded(current: string, chunk: string, limit: number): string {
	const next = current + chunk;
	return next.length <= limit ? next : next.slice(next.length - limit);
}

function resolveWindowsExecutable(
	command: string,
	envPath: string | undefined,
): {
	readonly file: string;
	readonly isCmdShim: boolean;
} {
	const lowerExt = extname(command).toLowerCase();
	if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
		return { file: command, isCmdShim: lowerExt === ".cmd" || lowerExt === ".bat" };
	}
	if (lowerExt.length > 0) {
		return { file: command, isCmdShim: lowerExt === ".cmd" || lowerExt === ".bat" };
	}
	const dirs = (envPath ?? process.env.PATH ?? "").split(delimiter).filter((d) => d.length > 0);
	for (const dir of dirs) {
		for (const ext of [".exe", ".cmd", ".bat"]) {
			const candidate = join(dir, `${command}${ext}`);
			if (existsSync(candidate)) {
				return { file: candidate, isCmdShim: ext === ".cmd" || ext === ".bat" };
			}
		}
	}
	return { file: command, isCmdShim: false };
}

function quoteCmdArg(arg: string): string {
	if (arg.length > 0 && !/[ \t\n\v"^&|<>()%!]/.test(arg)) {
		return arg;
	}
	// Escape internal quotes and trailing backslashes, then escape cmd.exe metacharacters outside quotes.
	const inner = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
	return `"${inner}"`.replace(/([()%!^"<>&|])/g, "^$1");
}

function spawnCrossPlatform(
	argv: readonly string[],
	options: {
		readonly cwd: string;
		readonly env: NodeJS.ProcessEnv;
	},
): ChildProcess {
	const [cmd, ...args] = argv;
	if (cmd === undefined || cmd.length === 0) {
		throw new Error("Cannot spawn empty argv");
	}
	if (process.platform === "win32") {
		const resolved = resolveWindowsExecutable(cmd, options.env.PATH ?? options.env.Path);
		if (resolved.isCmdShim) {
			const cmdLine = [quoteCmdArg(resolved.file), ...args.map(quoteCmdArg)].join(" ");
			return spawn(options.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${cmdLine}"`], {
				cwd: options.cwd,
				env: options.env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				windowsVerbatimArguments: true,
			});
		}
		return spawn(resolved.file, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	}

	return spawn(cmd, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
}

async function killChildTree(pid: number | undefined, child?: ChildProcess): Promise<void> {
	if (pid === undefined || pid <= 0) return;
	const waitForChildClose =
		child !== undefined && child.exitCode === null && child.signalCode === null
			? new Promise<void>((resolveClose) => {
					const timer = setTimeout(resolveClose, 2_000);
					child.once("close", () => {
						clearTimeout(timer);
						resolveClose();
					});
				})
			: Promise.resolve();

	if (process.platform === "win32") {
		await new Promise<void>((resolveKill) => {
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.once("error", () => resolveKill());
			killer.once("close", () => resolveKill());
		});
		await waitForChildClose;
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			child?.kill("SIGTERM");
		} catch {}
	}
	await waitForChildClose;
}

async function runShortCommand(
	argv: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawnCrossPlatform(argv, { cwd, env });
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout = appendBounded(stdout, chunk, MAX_CAPTURE_CHARS);
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr = appendBounded(stderr, chunk, MAX_CAPTURE_CHARS);
		});
		child.on("error", rejectPromise);
		child.on("close", (code) => {
			resolvePromise({ exitCode: code ?? 1, stdout, stderr });
		});
	});
}

/** Local machine implementation of `WorkshopExecutionBackend` isolating each task in its own Git worktree. */
export class LocalWorktreeBackend implements WorkshopExecutionBackend {
	readonly kind = "local" as const;
	readonly #worktreesRoot: string;
	readonly #defaultRepoPath: string | undefined;
	readonly #baseEnv: NodeJS.ProcessEnv;
	readonly #activeJobs = new Map<string, ActiveLocalProcess>();

	constructor(options: LocalWorktreeBackendOptions) {
		this.#worktreesRoot = resolve(options.worktreesRoot);
		this.#defaultRepoPath = options.defaultRepoPath !== undefined ? resolve(options.defaultRepoPath) : undefined;
		this.#baseEnv = {
			...process.env,
			...(options.env ?? {}),
		};
	}

	async prepareWorkspace(request: ProvisionWorkspaceRequest): Promise<ProvisionedWorkspace> {
		const slug = validateTaskSlug(request.taskName);
		await mkdir(this.#worktreesRoot, { recursive: true });
		const cwd = join(this.#worktreesRoot, slug);
		const rawRepo = request.repoPath?.trim() || this.#defaultRepoPath;

		if (rawRepo === undefined || rawRepo.length === 0) {
			await mkdir(cwd, { recursive: true });
			return { machineId: "local", cwd };
		}

		const repoPath = resolve(rawRepo);
		const branchName = `jehee/${slug}`;
		if (existsSync(join(cwd, ".git"))) {
			return { machineId: "local", cwd, repoPath, branchName };
		}

		const gitArgs =
			request.baseRef !== undefined && request.baseRef.trim().length > 0
				? ["git", "-C", repoPath, "worktree", "add", "-B", branchName, cwd, request.baseRef.trim()]
				: ["git", "-C", repoPath, "worktree", "add", "-B", branchName, cwd];
		const res = await runShortCommand(gitArgs, this.#worktreesRoot, this.#baseEnv);
		if (res.exitCode !== 0) {
			throw new Error(`Failed to create local git worktree at "${cwd}": ${res.stderr || res.stdout}`);
		}
		await this.#ensureExcludeEntry(cwd);
		return { machineId: "local", cwd, repoPath, branchName };
	}

	async #ensureExcludeEntry(worktreeCwd: string): Promise<void> {
		const excludePathRes = await runShortCommand(
			["git", "-C", worktreeCwd, "rev-parse", "--git-path", "info/exclude"],
			worktreeCwd,
			this.#baseEnv,
		);
		if (excludePathRes.exitCode !== 0) return;
		const rawPath = excludePathRes.stdout.trim();
		if (rawPath.length === 0) return;
		const excludeFile = isAbsolute(rawPath) ? rawPath : resolve(worktreeCwd, rawPath);
		await mkdir(dirname(excludeFile), { recursive: true });
		const existing = await readFile(excludeFile, "utf8").catch(() => "");
		const entries = existing.split(/\r?\n/).map((line) => line.trim());
		if (entries.includes(WORKSHOP_META_DIR) || entries.includes(`${WORKSHOP_META_DIR}/`)) {
			return;
		}
		const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
		await writeFile(excludeFile, `${existing}${sep}${WORKSHOP_META_DIR}/\n`, "utf8");
	}

	async cleanupWorkspace(workspace: ProvisionedWorkspace): Promise<void> {
		if (workspace.repoPath !== undefined) {
			const res = await runShortCommand(
				["git", "-C", workspace.repoPath, "worktree", "remove", "--force", workspace.cwd],
				dirname(workspace.cwd),
				this.#baseEnv,
			);
			if (res.exitCode !== 0 && existsSync(workspace.cwd)) {
				await rm(workspace.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
			}
			return;
		}
		await rm(workspace.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}

	async startJob(workspace: ProvisionedWorkspace, request: StartWorkshopJobRequest): Promise<StartedWorkshopJob> {
		if (!SAFE_JOB_ID.test(request.jobId)) {
			throw new Error(`Invalid workshop jobId "${request.jobId}"`);
		}
		const jobDir = join(workspace.cwd, WORKSHOP_META_DIR, request.jobId);
		await mkdir(jobDir, { recursive: true });

		const mergedEnv: NodeJS.ProcessEnv = {
			...this.#baseEnv,
			...(request.env ?? {}),
		};
		const child = spawnCrossPlatform(request.argv, { cwd: workspace.cwd, env: mergedEnv });
		child.unref();

		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout = appendBounded(stdout, chunk, MAX_CAPTURE_CHARS);
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr = appendBounded(stderr, chunk, MAX_CAPTURE_CHARS);
		});

		const tracked: ActiveLocalProcess = { child, settled: undefined };
		this.#activeJobs.set(request.jobId, tracked);

		const finalize = async (exitCode: number, extraErr?: string) => {
			if (tracked.settled !== undefined) return;
			const finalErr = extraErr ? appendBounded(stderr, `\n${extraErr}`, MAX_CAPTURE_CHARS) : stderr;
			tracked.settled = { state: "finished", exitCode, stdout, stderr: finalErr };
			try {
				await writeFile(join(jobDir, "stdout.log"), stdout, "utf8");
				await writeFile(join(jobDir, "stderr.log"), finalErr, "utf8");
				const tmpExit = join(jobDir, "exit.tmp");
				await writeFile(tmpExit, String(exitCode), "utf8");
				await rename(tmpExit, join(jobDir, "exit.code"));
			} catch {
				// Workspace may have been cleaned up concurrently during `cleanup`.
			}
		};

		child.on("error", (err) => {
			void finalize(127, err.message);
		});
		child.on("close", (code) => {
			void finalize(code ?? 1);
		});

		const pid = child.pid;
		if (pid !== undefined) {
			await writeFile(join(jobDir, "pid"), String(pid), "utf8").catch(() => undefined);
		}
		return {
			jobId: request.jobId,
			...(pid !== undefined ? { pid } : {}),
		};
	}

	async pollJob(workspace: ProvisionedWorkspace, job: StartedWorkshopJob): Promise<WorkshopJobPollResult> {
		const inMemory = this.#activeJobs.get(job.jobId);
		if (inMemory !== undefined) {
			if (inMemory.settled !== undefined) {
				this.#activeJobs.delete(job.jobId);
				return inMemory.settled;
			}
			return { state: "running" };
		}

		const jobDir = join(workspace.cwd, WORKSHOP_META_DIR, job.jobId);
		let rawExit: string;
		try {
			rawExit = await readFile(join(jobDir, "exit.code"), "utf8");
		} catch {
			return { state: "running" };
		}
		const exitCode = Number.parseInt(rawExit.trim(), 10);
		const [stdout, stderr] = await Promise.all([
			readFile(join(jobDir, "stdout.log"), "utf8").catch(() => ""),
			readFile(join(jobDir, "stderr.log"), "utf8").catch(() => ""),
		]);
		return {
			state: "finished",
			exitCode: Number.isInteger(exitCode) ? exitCode : 1,
			stdout,
			stderr,
		};
	}

	async stopJob(workspace: ProvisionedWorkspace, job: StartedWorkshopJob): Promise<void> {
		const inMemory = this.#activeJobs.get(job.jobId);
		if (inMemory !== undefined && inMemory.settled === undefined) {
			inMemory.settled = { state: "finished", exitCode: 143, stdout: "", stderr: "Stopped by owner." };
		}
		await killChildTree(job.pid ?? inMemory?.child.pid, inMemory?.child);
		const jobDir = join(workspace.cwd, WORKSHOP_META_DIR, job.jobId);
		await mkdir(jobDir, { recursive: true }).catch(() => undefined);
		await writeFile(join(jobDir, "exit.code"), "143", "utf8").catch(() => undefined);
	}

	async inspectGitSummary(workspace: ProvisionedWorkspace): Promise<string | undefined> {
		if (workspace.repoPath === undefined) return undefined;
		const [statusRes, diffRes] = await Promise.all([
			runShortCommand(
				["git", "-C", workspace.cwd, "status", "--short", "--untracked-files=normal"],
				workspace.cwd,
				this.#baseEnv,
			),
			runShortCommand(["git", "-C", workspace.cwd, "diff", "--stat"], workspace.cwd, this.#baseEnv),
		]);
		if (statusRes.exitCode !== 0) return undefined;
		return buildGitSummaryBlock({
			...(workspace.branchName !== undefined ? { branchName: workspace.branchName } : {}),
			statusShort: statusRes.stdout,
			diffStat: diffRes.stdout,
		});
	}
}
