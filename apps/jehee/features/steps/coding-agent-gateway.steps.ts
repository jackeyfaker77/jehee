// Cucumber step definitions verifying LocalWorktreeBackend Git worktree isolation, L1 Core prompt injection without
// chat leakage, `--continue` multi-turn session continuation, side-by-side `antigravity` + `opencode` drivers, and PID stop.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChannelGateway } from "../../src/channels/gateway.ts";
import { JeheeHost } from "../../src/core/host.ts";
import { StaticCoreMemoryProvider } from "../../src/memory/static-core.ts";
import type {
	StartedWorkshopJob,
	StartWorkshopJobRequest,
	WorkshopExecutionBackend,
	WorkshopJobPollResult,
} from "../../src/workshop/backend.ts";
import { LocalWorktreeBackend } from "../../src/workshop/node-local-backend.ts";
import type { ProvisionedWorkspace, ProvisionWorkspaceRequest } from "../../src/workshop/provisioner.ts";
import type { JeheeWorld } from "../support/world.ts";

let originRepoDir = "";
let worktreesDir = "";
let cliInvocationsLogPath = "";
let tgOutbox: string[] = [];
let lastStatusToolOutput = "";

type RecordedCliStart = {
	readonly workspaceCwd: string;
	readonly argv: readonly string[];
	readonly pid: number;
};

let mockBackendStarts: RecordedCliStart[] = [];
let mockStoppedPids: number[] = [];

function latestNonSystemText(ctx: TranscriptContext): { readonly role: string; readonly text: string } {
	for (let i = ctx.messages.length - 1; i >= 0; i--) {
		const m = ctx.messages[i]!;
		if (m.role === "system") continue;
		const text =
			typeof m.content === "string"
				? m.content
				: m.content
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join("\n");
		return { role: m.role, text };
	}
	return { role: "none", text: "" };
}

async function setupLocalGitRepoAndMockCli(world: JeheeWorld): Promise<string> {
	world.tempDir = await mkdtemp(join(tmpdir(), "jehee-bdd-5b-"));
	originRepoDir = join(world.tempDir, "repo");
	worktreesDir = join(world.tempDir, "wts");
	cliInvocationsLogPath = join(world.tempDir, "cli-invocations.jsonl");
	const mockCliScript = join(world.tempDir, "mock-coding-cli.mjs");

	await mkdir(join(originRepoDir, "src"), { recursive: true });
	await writeFile(join(originRepoDir, "src", "app.ts"), 'export const title = "v1";\n', "utf8");
	execFileSync("git", ["init", originRepoDir], { stdio: "ignore" });
	execFileSync("git", ["-C", originRepoDir, "config", "user.email", "bdd@jehee.local"], { stdio: "ignore" });
	execFileSync("git", ["-C", originRepoDir, "config", "user.name", "Jehee BDD"], { stdio: "ignore" });
	execFileSync("git", ["-C", originRepoDir, "add", "."], { stdio: "ignore" });
	execFileSync("git", ["-C", originRepoDir, "commit", "-m", "init"], { stdio: "ignore" });

	await writeFile(
		mockCliScript,
		[
			'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
			"const args = process.argv.slice(2);",
			`appendFileSync(${JSON.stringify(cliInvocationsLogPath)}, JSON.stringify({ cwd: process.cwd(), args }) + "\\n");`,
			"const isContinue = args.includes('--continue');",
			"const current = readFileSync('src/app.ts', 'utf8');",
			"if (!isContinue) {",
			"  writeFileSync('src/app.ts', current.replace('v1', 'v2'));",
			"  console.log('Updated title to v2 in isolated worktree.');",
			"} else {",
			"  writeFileSync('src/app.ts', current + '// continued-v2.1\\n');",
			"  console.log('Appended continuation comment.');",
			"}",
		].join("\n"),
		"utf8",
	);

	return mockCliScript;
}

Given(
	"已初始化真实本地 Git 仓库并挂载 LocalWorktreeBackend 与 L1 核心记忆 {string}",
	async function (this: JeheeWorld, coreRule: string) {
		tgOutbox = [];
		const mockCliScript = await setupLocalGitRepoAndMockCli(this);
		const backend = new LocalWorktreeBackend({
			worktreesRoot: worktreesDir,
			defaultRepoPath: originRepoDir,
		});
		const memory = new StaticCoreMemoryProvider({ corePrompt: coreRule });

		const router: FauxResponseStep = (ctx) => {
			this.capturedContexts.push(ctx);
			const last = latestNonSystemText(ctx);
			if (last.role === "toolResult") {
				return fauxAssistantMessage("工坊 fix-header 已在后台启动。");
			}
			if (last.text.includes("牛肉火锅")) {
				return fauxAssistantMessage("牛肉火锅不错，记得点吊龙。");
			}
			if (last.text.includes("[workshop:fix-header completed")) {
				return fauxAssistantMessage("工坊 fix-header 已完成修改并通过 Git 变更校验（src/app.ts 已更新为 v2）。");
			}
			if (last.text.includes("fix-header")) {
				return fauxAssistantMessage(
					[
						fauxToolCall("workshop", {
							action: "spawn",
							name: "fix-header",
							driver: "custom",
							message: "把 src/app.ts 里的标题改成 v2",
						}),
					],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("收到。");
		};
		this.faux.setResponses(Array.from({ length: 10 }, () => router));

		this.host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				memory,
				workshop: {
					backend,
					defaultDriver: "custom",
					pollIntervalMs: 30,
					customTemplate: {
						initialArgv: [process.execPath, mockCliScript, "--print", "--", "{prompt}"],
						continueArgv: [process.execPath, mockCliScript, "--continue", "--print", "--", "{prompt}"],
					},
				},
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: ["owner-1"] },
		});
		this.gateway.registerTransport({
			channel: "telegram",
			sendText: async (_chatId, text) => {
				tgOutbox.push(text);
			},
		});
	},
);

Given(
	"主人先在 Telegram 会话 {string} 聊过日常闲聊 {string}",
	async function (this: JeheeWorld, chatId: string, casualText: string) {
		assert.ok(this.gateway);
		await this.gateway.ingest(
			{
				channel: "telegram",
				chatId,
				senderId: "owner-1",
				messageId: "m-casual-hotpot",
				text: casualText,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
	},
);

When("主人发送工坊需求 {string}", async function (this: JeheeWorld, reqText: string) {
	assert.ok(this.gateway);
	await this.gateway.ingest(
		{
			channel: "telegram",
			chatId: "chat-600",
			senderId: "owner-1",
			messageId: "m-spawn-wt",
			text: reqText,
			timestampMs: Date.now(),
		},
		this.ctx,
	);
});

When("等待后台外部 Coding Agent CLI 任务执行与主会话汇总完毕", async function (this: JeheeWorld) {
	assert.ok(this.host && this.gateway);
	await this.host.waitForWorkshopSettled(this.ctx);
	await this.gateway.drain();
});

Then(
	"外部 CLI 在独立分支 {string} 收到了 L1 偏好 {string}，且未收到主窗口闲聊 {string}",
	async (_expectedBranch: string, expectedCore: string, forbiddenChat: string) => {
		const rawLog = await readFile(cliInvocationsLogPath, "utf8");
		const entries = rawLog
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { cwd: string; args: string[] });
		assert.equal(entries.length, 1);
		const promptArg = entries[0]!.args.at(-1) ?? "";
		assert.ok(promptArg.includes(expectedCore), `Expected core rule in prompt:\n${promptArg}`);
		assert.ok(!promptArg.includes(forbiddenChat), `Casual chat leaked into workshop CLI:\n${promptArg}`);
	},
);

Then(
	"原始主仓库的 {string} 保持未改动，而工坊分支的 {string} 已更新为含 {string} 内容",
	async (relPath: string, wtRelPath: string, expectedToken: string) => {
		const mainContent = await readFile(join(originRepoDir, relPath), "utf8");
		assert.ok(mainContent.includes('"v1"'), `Origin repo should remain untouched, got: ${mainContent}`);
		const wtContent = await readFile(join(worktreesDir, "fix-header", wtRelPath), "utf8");
		assert.ok(wtContent.includes(expectedToken), `Worktree file should contain ${expectedToken}, got: ${wtContent}`);
	},
);

Then(
	"Telegram 会话 {string} 收到主动完工汇报，且主会话收到的工坊回执包含确定性 {string} 与 {string} 变更统计",
	function (this: JeheeWorld, _chatId: string, expectedBranchMark: string, expectedFileMark: string) {
		assert.ok(tgOutbox.some((t) => t.includes("已完成修改并通过 Git 变更校验")));
		const allInputs = this.capturedContexts
			.flatMap((c) => c.messages)
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
			.join("\n");
		assert.ok(allInputs.includes(expectedBranchMark), `Missing ${expectedBranchMark} in:\n${allInputs}`);
		assert.ok(allInputs.includes(expectedFileMark), `Missing ${expectedFileMark} in:\n${allInputs}`);
	},
);

Given("已初始化真实本地 Git 仓库并挂载 LocalWorktreeBackend 与外部 CLI 驱动", async function (this: JeheeWorld) {
	tgOutbox = [];
	lastStatusToolOutput = "";
	const mockCliScript = await setupLocalGitRepoAndMockCli(this);
	const backend = new LocalWorktreeBackend({
		worktreesRoot: worktreesDir,
		defaultRepoPath: originRepoDir,
	});
	const memory = new StaticCoreMemoryProvider({ corePrompt: "保持简洁函数式" });

	const router: FauxResponseStep = (ctx) => {
		const last = latestNonSystemText(ctx);
		if (last.role === "toolResult") {
			if (last.text.includes("iter-feature:")) {
				lastStatusToolOutput = last.text;
			}
			return fauxAssistantMessage(`OK: ${last.text}`);
		}
		if (last.text.includes("启动 iter-feature")) {
			return fauxAssistantMessage(
				[fauxToolCall("workshop", { action: "spawn", name: "iter-feature", message: "第一轮把 v1 改成 v2" })],
				{ stopReason: "toolUse" },
			);
		}
		if (last.text.includes("继续在 src/app.ts")) {
			return fauxAssistantMessage(
				[fauxToolCall("workshop", { action: "send", name: "iter-feature", message: "追加版本号注释" })],
				{ stopReason: "toolUse" },
			);
		}
		if (last.text.includes("查一下工坊状态")) {
			return fauxAssistantMessage([fauxToolCall("workshop", { action: "status", name: "iter-feature" })], {
				stopReason: "toolUse",
			});
		}
		return fauxAssistantMessage("已收到工坊完工汇报。");
	};
	this.faux.setResponses(Array.from({ length: 14 }, () => router));

	this.host = await JeheeHost.open(
		{
			storage: { kind: "memory" },
			models: this.models,
			defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
			memory,
			workshop: {
				backend,
				defaultDriver: "custom",
				pollIntervalMs: 30,
				customTemplate: {
					initialArgv: [process.execPath, mockCliScript, "--print", "--", "{prompt}"],
					continueArgv: [process.execPath, mockCliScript, "--continue", "--print", "--", "{prompt}"],
				},
			},
		},
		this.ctx,
	);
});

When(
	"主人先启动工坊任务 {string} 完成第一轮修改，再追加指令 {string}",
	async function (this: JeheeWorld, taskName: string, followUpText: string) {
		assert.ok(this.host);
		await this.host.sendMessage({ text: `启动 ${taskName}` }, this.ctx);
		await this.host.waitForWorkshopSettled(this.ctx);

		await this.host.sendMessage({ text: followUpText }, this.ctx);
	},
);

When("等待后台外部 Coding Agent CLI 续聊轮执行与主会话汇总完毕", async function (this: JeheeWorld) {
	assert.ok(this.host);
	await this.host.waitForWorkshopSettled(this.ctx);
	await this.host.sendMessage({ text: "查一下工坊状态" }, this.ctx);
	await this.host.waitForIdle(this.ctx);
});

Then("第二轮外部 CLI 调用自动携带了 {string} 续聊标志且未重复拼接首轮核心提示头", async (expectedFlag: string) => {
	const rawLog = await readFile(cliInvocationsLogPath, "utf8");
	const calls = rawLog
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { args: string[] });
	assert.equal(calls.length, 2);
	assert.ok(calls[1]!.args.includes(expectedFlag), `Expected ${expectedFlag} in ${JSON.stringify(calls[1]!.args)}`);
	const secondPrompt = calls[1]!.args.at(-1) ?? "";
	assert.ok(!secondPrompt.includes("[Owner Core Preferences]"));
});

Then("工坊状态查询显示任务 {string} 已累计完成 {string}", (taskName: string, expectedTurns: string) => {
	assert.ok(lastStatusToolOutput.includes(taskName));
	assert.ok(lastStatusToolOutput.includes(expectedTurns), `Expected ${expectedTurns} in: ${lastStatusToolOutput}`);
});

Given("已挂载支持记录命令行的模拟执行后端（默认驱动 {string}）", async function (this: JeheeWorld, defaultDrv: string) {
	mockBackendStarts = [];
	mockStoppedPids = [];
	lastStatusToolOutput = "";
	let pidCounter = 7000;

	const mockBackend: WorkshopExecutionBackend = {
		kind: "instabox",
		prepareWorkspace: async (req: ProvisionWorkspaceRequest): Promise<ProvisionedWorkspace> => ({
			machineId: "m_sim",
			cwd: `/data/jehee/worktrees/${req.taskName}`,
			repoPath: "/data/repo",
			branchName: `jehee/${req.taskName}`,
		}),
		cleanupWorkspace: async () => undefined,
		startJob: async (ws: ProvisionedWorkspace, req: StartWorkshopJobRequest): Promise<StartedWorkshopJob> => {
			pidCounter += 1;
			mockBackendStarts.push({ workspaceCwd: ws.cwd, argv: req.argv, pid: pidCounter });
			return { jobId: req.jobId, pid: pidCounter };
		},
		pollJob: async (ws: ProvisionedWorkspace, _job: StartedWorkshopJob): Promise<WorkshopJobPollResult> => {
			if (ws.cwd.endsWith("/ui-agy")) {
				return { state: "finished", exitCode: 0, stdout: "Antigravity UI done.", stderr: "" };
			}
			// `api-oc` simulates a long-running OpenCode job until explicitly stopped.
			return { state: "running" };
		},
		stopJob: async (_ws: ProvisionedWorkspace, job: StartedWorkshopJob): Promise<void> => {
			if (job.pid !== undefined) mockStoppedPids.push(job.pid);
		},
		inspectGitSummary: async (ws: ProvisionedWorkspace) =>
			`[git verification | branch=${ws.branchName}]\n M ui.tsx\n 1 file changed`,
	};

	const router: FauxResponseStep = (ctx) => {
		const last = latestNonSystemText(ctx);
		if (last.role === "toolResult") {
			if (last.text.includes("api-oc:")) {
				lastStatusToolOutput = last.text;
			}
			return fauxAssistantMessage(`Done: ${last.text}`);
		}
		if (last.text.includes("并行派生")) {
			return fauxAssistantMessage(
				[
					fauxToolCall("workshop", {
						action: "spawn",
						name: "ui-agy",
						driver: "antigravity",
						message: "Build dashboard UI",
					}),
					fauxToolCall("workshop", {
						action: "spawn",
						name: "api-oc",
						driver: "opencode",
						message: "Audit all API endpoints",
					}),
				],
				{ stopReason: "toolUse" },
			);
		}
		if (last.text.includes("停止 api-oc")) {
			return fauxAssistantMessage([fauxToolCall("workshop", { action: "stop", name: "api-oc" })], {
				stopReason: "toolUse",
			});
		}
		if (last.text.includes("查看 api-oc 状态")) {
			return fauxAssistantMessage([fauxToolCall("workshop", { action: "status", name: "api-oc" })], {
				stopReason: "toolUse",
			});
		}
		return fauxAssistantMessage("Noted.");
	};
	this.faux.setResponses(Array.from({ length: 14 }, () => router));

	this.host = await JeheeHost.open(
		{
			storage: { kind: "memory" },
			models: this.models,
			defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
			workshop: {
				backend: mockBackend,
				defaultDriver: defaultDrv === "opencode" ? "opencode" : "pi",
				pollIntervalMs: 40,
			},
		},
		this.ctx,
	);
});

When(
	"主会话同时派生指定驱动 {string} 的工坊 {string} 与指定驱动 {string} 的慢速工坊 {string}",
	async function (this: JeheeWorld, _d1: string, _n1: string, _d2: string, _n2: string) {
		assert.ok(this.host);
		await this.host.sendMessage({ text: "并行派生两个异构工坊" }, this.ctx);
		// Let both background CLI runner tasks execute their `start` phase.
		for (let i = 0; i < 30 && mockBackendStarts.length < 2; i++) {
			await new Promise((r) => setTimeout(r, 15));
		}
	},
);

Then("后端分别收到了 {string} 与 {string} 的隔离启动命令", (expectedAgyPrefix: string, expectedOcPrefix: string) => {
	assert.equal(mockBackendStarts.length, 2);
	const joinedCmds = mockBackendStarts.map((s) => s.argv.join(" "));
	assert.ok(
		joinedCmds.some((cmd) => cmd.startsWith(expectedAgyPrefix)),
		`Expected "${expectedAgyPrefix}" in ${JSON.stringify(joinedCmds)}`,
	);
	assert.ok(
		joinedCmds.some((cmd) => cmd.startsWith(expectedOcPrefix)),
		`Expected "${expectedOcPrefix}" in ${JSON.stringify(joinedCmds)}`,
	);
});

When(
	"在慢速工坊 {string} 仍在运行期间主会话调用 {string} 终止 {string}",
	async function (this: JeheeWorld, _runningName: string, _action: string, targetName: string) {
		assert.ok(this.host);
		await this.host.sendMessage({ text: `停止 ${targetName}` }, this.ctx);
		await this.host.waitForWorkshopSettled(this.ctx);
		await this.host.sendMessage({ text: `查看 ${targetName} 状态` }, this.ctx);
		await this.host.waitForIdle(this.ctx);
	},
);

Then(
	"后端收到了针对 {string} 进程 PID 的终止指令，且工坊状态查询显示 {string}",
	(targetName: string, expectedIdle: string) => {
		const ocStart = mockBackendStarts.find((s) => s.workspaceCwd.endsWith(`/${targetName}`));
		assert.ok(ocStart);
		assert.ok(
			mockStoppedPids.includes(ocStart.pid),
			`Expected PID ${ocStart.pid} in stopped PIDs ${JSON.stringify(mockStoppedPids)}`,
		);
		assert.ok(lastStatusToolOutput.includes(expectedIdle), `Expected "${expectedIdle}" in: ${lastStatusToolOutput}`);
	},
);
