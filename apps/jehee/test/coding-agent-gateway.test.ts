// Unit tests for external Coding Agent CLI driver presets (`pi`, `opencode`, `antigravity`, `claude`, `codex`, `custom`),
// `InstaBoxWorkshopBackend` detached job lifecycle, and real `LocalWorktreeBackend` Git worktree isolation.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	buildCodingAgentArgv,
	composeWorkshopPrompt,
	InstaBoxClient,
	InstaBoxWorkshopBackend,
	SingleBoxWorktreeProvisioner,
	truncateWorkshopAgentOutput,
} from "../src/index.ts";
import { LocalWorktreeBackend } from "../src/workshop/node-local-backend.ts";

describe("CodingAgentDriver argv presets and prompt isolation", () => {
	it("builds exact initial and continuation argv vectors for pi, opencode, antigravity, claude, codex, and custom", () => {
		assert.deepEqual(
			buildCodingAgentArgv({
				driver: "pi",
				prompt: "Fix login",
				cwd: "/wt/a",
				isContinuation: false,
				model: "opencode-go/glm-5.3",
			}),
			["pi", "--print", "--model", "opencode-go/glm-5.3", "--", "Fix login"],
		);
		assert.deepEqual(
			buildCodingAgentArgv({
				driver: "pi",
				prompt: "Add unit test",
				cwd: "/wt/a",
				isContinuation: true,
			}),
			["pi", "--continue", "--print", "--", "Add unit test"],
		);

		assert.deepEqual(
			buildCodingAgentArgv({
				driver: "opencode",
				prompt: "Refactor router",
				cwd: "/wt/b",
				isContinuation: false,
				model: "opencode-go/deepseek-v4.1-flash",
			}),
			["opencode", "run", "--auto", "-m", "opencode-go/deepseek-v4.1-flash", "--", "Refactor router"],
		);
		assert.deepEqual(
			buildCodingAgentArgv({
				driver: "opencode",
				prompt: "Fix lint",
				cwd: "/wt/b",
				isContinuation: true,
			}),
			["opencode", "run", "--auto", "-c", "--", "Fix lint"],
		);

		assert.deepEqual(
			buildCodingAgentArgv({
				driver: "antigravity",
				prompt: "Implement feature",
				cwd: "/wt/agy",
				isContinuation: false,
				model: "gemini-2.5-pro",
			}),
			[
				"agy",
				"--print",
				"--dangerously-skip-permissions",
				"--add-dir",
				"/wt/agy",
				"--model",
				"gemini-2.5-pro",
				"--",
				"Implement feature",
			],
		);
		assert.deepEqual(
			buildCodingAgentArgv({
				driver: "antigravity",
				prompt: "Follow up fix",
				cwd: "/wt/agy",
				isContinuation: true,
			}),
			[
				"agy",
				"--print",
				"--dangerously-skip-permissions",
				"--add-dir",
				"/wt/agy",
				"--continue",
				"--",
				"Follow up fix",
			],
		);

		assert.deepEqual(
			buildCodingAgentArgv({
				driver: "claude",
				prompt: "Audit auth",
				cwd: "/wt/c",
				isContinuation: true,
			}),
			["claude", "--continue", "--print", "--dangerously-skip-permissions", "--", "Audit auth"],
		);

		assert.deepEqual(
			buildCodingAgentArgv({
				driver: "codex",
				prompt: "Update schema",
				cwd: "/wt/d",
				isContinuation: true,
			}),
			["codex", "exec", "resume", "--last", "--dangerously-bypass-approvals-and-sandbox", "--", "Update schema"],
		);

		assert.deepEqual(
			buildCodingAgentArgv({
				driver: "custom",
				prompt: "Custom task",
				cwd: "/wt/custom",
				isContinuation: true,
				customTemplate: {
					initialArgv: ["my-agent", "run", "--cwd", "{cwd}"],
					continueArgv: ["my-agent", "continue", "--cwd", "{cwd}", "{prompt}"],
				},
			}),
			["my-agent", "continue", "--cwd", "/wt/custom", "Custom task"],
		);
	});

	it("injects core preferences only on turn 1 and truncates oversized raw compiler logs cleanly", () => {
		const t1 = composeWorkshopPrompt({
			message: "Add parser",
			corePrompt: "No any; erasable TypeScript only.",
			isContinuation: false,
		});
		assert.ok(t1.includes("[Owner Core Preferences]"));
		assert.ok(t1.includes("erasable TypeScript"));

		const t2 = composeWorkshopPrompt({
			message: "Rename helper",
			corePrompt: "No any; erasable TypeScript only.",
			isContinuation: true,
		});
		assert.equal(t2, "Rename helper");

		const hugeStdout = `HEAD_MARKER\n${"x".repeat(20_000)}\nTAIL_SUMMARY`;
		const bounded = truncateWorkshopAgentOutput(hugeStdout, "", 0, 1_000);
		assert.ok(bounded.length <= 1_050);
		assert.ok(bounded.includes("HEAD_MARKER"));
		assert.ok(bounded.includes("TAIL_SUMMARY"));
		assert.ok(bounded.includes("truncated"));
	});
});

describe("InstaBoxWorkshopBackend and LocalWorktreeBackend", () => {
	it("drives detached POSIX job start, polling, stop, and git summary over InstaBoxWorkshopBackend", async () => {
		const recordedArgvs: Array<readonly string[]> = [];
		let pollCount = 0;
		const client = new InstaBoxClient({
			apiKey: "ibk_test",
			fetchImpl: async (input, init) => {
				const url = new URL(String(input));
				if (url.pathname === "/v1/machines/m_1" && init?.method === "GET") {
					return Response.json({ id: "m_1", state: "running" });
				}
				if (url.pathname === "/v1/machines/m_1/exec") {
					const body = JSON.parse(String(init?.body)) as { argv?: string[] };
					const argv = body.argv ?? [];
					recordedArgvs.push(argv);
					if (argv[3] === "jehee-launch") {
						return Response.json({ stdout: "4321", stderr: "", exitCode: 0, timedOut: false, truncated: false });
					}
					if (argv[3] === "jehee-poll") {
						pollCount += 1;
						return Response.json({
							stdout: pollCount === 1 ? "RUNNING" : "0",
							stderr: "",
							exitCode: 0,
							timedOut: false,
							truncated: false,
						});
					}
					if (argv[3] === "jehee-out") {
						return Response.json({
							stdout: "Implemented feature via agy.",
							stderr: "",
							exitCode: 0,
							timedOut: false,
							truncated: false,
						});
					}
					if (argv[0] === "git" && argv[3] === "status") {
						return Response.json({
							stdout: " M src/feature.ts\n?? .jehee-workshop/job-1/pid\n",
							stderr: "",
							exitCode: 0,
							timedOut: false,
							truncated: false,
						});
					}
					if (argv[0] === "git" && argv[3] === "diff") {
						return Response.json({
							stdout: " src/feature.ts | 10 ++++++++++\n 1 file changed, 10 insertions(+)\n",
							stderr: "",
							exitCode: 0,
							timedOut: false,
							truncated: false,
						});
					}
					return Response.json({ stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false });
				}
				return new Response("not found", { status: 404 });
			},
		});
		const provisioner = new SingleBoxWorktreeProvisioner({ client, machineId: "m_1" });
		const backend = new InstaBoxWorkshopBackend({ client, provisioner, defaultRepoPath: "/data/repo" });

		const ws = await backend.prepareWorkspace({ taskName: "feat-agy", idempotencyKey: "k1" });
		const job = await backend.startJob(ws, {
			jobId: "job-1",
			argv: ["agy", "--print", "--", "quote 'hazard' $(uname)"],
		});
		assert.equal(job.pid, 4321);

		// First poll is still running; second poll finishes cleanly.
		assert.equal((await backend.pollJob(ws, job)).state, "running");
		const done = await backend.pollJob(ws, job);
		assert.equal(done.state, "finished");
		if (done.state === "finished") {
			assert.equal(done.exitCode, 0);
			assert.equal(done.stdout, "Implemented feature via agy.");
		}

		const gitSummary = await backend.inspectGitSummary(ws);
		assert.ok(gitSummary?.includes("M src/feature.ts"));
		assert.ok(!gitSummary?.includes(".jehee-workshop"), "Internal .jehee-workshop files must be filtered out");

		await backend.stopJob(ws, job);
		assert.ok(recordedArgvs.some((a) => a[3] === "jehee-stop" && a[4] === "4321"));
	});

	it("creates real local Git worktrees, runs child CLI jobs, inspects clean git diffs, and removes worktrees", async () => {
		const rootTmp = await mkdtemp(join(tmpdir(), "jehee-local-wt-"));
		const repoDir = join(rootTmp, "origin-repo");
		const wtRoot = join(rootTmp, "worktrees");
		try {
			await mkdtemp(join(rootTmp, "init-")).catch(() => undefined);
			execFileSync("git", ["init", repoDir], { stdio: "ignore" });
			execFileSync("git", ["-C", repoDir, "config", "user.email", "test@jehee.local"], { stdio: "ignore" });
			execFileSync("git", ["-C", repoDir, "config", "user.name", "Jehee Test"], { stdio: "ignore" });
			await writeFile(join(repoDir, "hello.txt"), "v1\n", "utf8");
			execFileSync("git", ["-C", repoDir, "add", "hello.txt"], { stdio: "ignore" });
			execFileSync("git", ["-C", repoDir, "commit", "-m", "initial"], { stdio: "ignore" });

			const backend = new LocalWorktreeBackend({
				worktreesRoot: wtRoot,
				defaultRepoPath: repoDir,
			});
			const ws = await backend.prepareWorkspace({ taskName: "local-fix", idempotencyKey: "loc-1" });
			assert.equal(ws.branchName, "jehee/local-fix");

			const job = await backend.startJob(ws, {
				jobId: "job-local-1",
				argv: [
					process.execPath,
					"-e",
					'const fs = require("node:fs"); fs.writeFileSync("hello.txt", "v2-updated-by-agent\\n"); console.log("Updated hello.txt successfully.");',
				],
			});

			let poll: Awaited<ReturnType<typeof backend.pollJob>> = { state: "running" };
			for (let i = 0; i < 50 && poll.state === "running"; i++) {
				await new Promise((r) => setTimeout(r, 25));
				poll = await backend.pollJob(ws, job);
			}
			assert.equal(poll.state, "finished");
			if (poll.state === "finished") {
				assert.equal(poll.exitCode, 0);
				assert.ok(poll.stdout.includes("Updated hello.txt successfully."));
			}

			const summary = await backend.inspectGitSummary(ws);
			assert.ok(summary?.includes("branch=jehee/local-fix"));
			assert.ok(summary?.includes("M hello.txt"));
			assert.ok(!summary?.includes(".jehee-workshop"));

			await backend.cleanupWorkspace(ws);
		} finally {
			await rm(rootTmp, { recursive: true, force: true });
		}
	});
});
