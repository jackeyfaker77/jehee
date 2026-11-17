// Cucumber step definitions for InstaBox Cloud Workshop (lazy wake-up, `/data` git worktree isolation, Core-only memory inheritance, and background completion push).

import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChannelGateway } from "../../src/channels/gateway.ts";
import { TelegramTransport } from "../../src/channels/telegram.ts";
import { JeheeHost } from "../../src/core/host.ts";
import { StaticCoreMemoryProvider } from "../../src/memory/static-core.ts";
import {
	InstaBoxClient,
	type InstaBoxExecRequest,
	type InstaBoxMachineState,
} from "../../src/workshop/instabox-client.ts";
import { SingleBoxWorktreeProvisioner } from "../../src/workshop/provisioner.ts";
import type { JeheeWorld } from "../support/world.ts";

type MockInstaBoxState = {
	machineId: string;
	state: InstaBoxMachineState;
	resumeCalls: number;
	execLog: InstaBoxExecRequest[];
	existingWorktrees: Set<string>;
};

let boxState: MockInstaBoxState;
let subagentCapturedContext: TranscriptContext | undefined;
let lastStatusReply = "";
let releaseSlowSubagent: (() => void) | undefined;
let subagentEntered: Promise<void> | undefined;

function createMockInstaBoxClient(state: MockInstaBoxState): InstaBoxClient {
	const mockFetch: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";

		if (method === "GET" && url.pathname === `/v1/machines/${state.machineId}`) {
			return new Response(JSON.stringify({ id: state.machineId, state: state.state }), { status: 200 });
		}
		if (method === "POST" && url.pathname === `/v1/machines/${state.machineId}/resume`) {
			assert.ok(new Headers(init?.headers).get("idempotency-key"), "resume requires Idempotency-Key");
			state.resumeCalls += 1;
			state.state = "resuming";
			return new Response(JSON.stringify({ id: "op-resume-1", machineId: state.machineId, state: "running" }), {
				status: 202,
			});
		}
		if (method === "GET" && url.pathname === "/v1/operations/op-resume-1") {
			state.state = "running";
			return new Response(JSON.stringify({ id: "op-resume-1", machineId: state.machineId, state: "succeeded" }), {
				status: 200,
			});
		}
		if (method === "POST" && url.pathname === `/v1/machines/${state.machineId}/exec`) {
			assert.equal(state.state, "running", "exec must only hit a running machine");
			const body = JSON.parse(String(init?.body)) as InstaBoxExecRequest;
			state.execLog.push(body);
			if (body.argv !== undefined) {
				if (body.argv[0] === "test" && body.argv[1] === "-e") {
					const gitMarker = body.argv[2] ?? "";
					const exists = state.existingWorktrees.has(gitMarker);
					return new Response(
						JSON.stringify({
							stdout: "",
							stderr: "",
							exitCode: exists ? 0 : 1,
							timedOut: false,
							truncated: false,
						}),
						{ status: 200 },
					);
				}
				if (body.argv[0] === "git" && body.argv.includes("worktree") && body.argv.includes("add")) {
					const bIdx = body.argv.indexOf("-B");
					const cwdArg = bIdx >= 0 ? (body.argv[bIdx + 2] ?? "") : (body.argv.at(-1) ?? "");
					state.existingWorktrees.add(`${cwdArg}/.git`);
				}
				if (body.argv[0] === "git" && body.argv.includes("worktree") && body.argv.includes("remove")) {
					const cwdArg = body.argv.at(-1) ?? "";
					state.existingWorktrees.delete(`${cwdArg}/.git`);
				}
			}
			return new Response(
				JSON.stringify({
					stdout: "tests passed: 12/12",
					stderr: "",
					exitCode: 0,
					timedOut: false,
					truncated: false,
				}),
				{ status: 200 },
			);
		}
		return new Response("Not Found", { status: 404 });
	};
	return new InstaBoxClient({
		apiKey: "ibk_test_free",
		fetchImpl: mockFetch,
		operationWaitParam: "1s",
	});
}

function renderAllText(context: TranscriptContext): string {
	return context.messages
		.map((m) => {
			const base =
				typeof m.content === "string"
					? m.content
					: m.content.flatMap((c) => ("text" in c && typeof c.text === "string" ? [c.text] : [])).join("");
			const sections =
				m.role === "system" && m.sections !== undefined
					? Object.values(m.sections)
							.filter((v): v is string => v !== null)
							.join("\n")
					: "";
			return `${base}\n${sections}`;
		})
		.join("\n");
}

Given(
	"InstaBox 免费单机 {string} 当前处于 {string} 休眠状态",
	function (this: JeheeWorld, machineId: string, initialState: string) {
		boxState = {
			machineId,
			state: initialState as InstaBoxMachineState,
			resumeCalls: 0,
			execLog: [],
			existingWorktrees: new Set(),
		};
		subagentCapturedContext = undefined;
	},
);

Given(
	"Jehee 挂载核心记忆 {string} 并连接 Telegram 主人 {string}",
	async function (this: JeheeWorld, coreRule: string, tgOwner: string) {
		const client = createMockInstaBoxClient(boxState);
		const provisioner = new SingleBoxWorktreeProvisioner({
			client,
			machineId: boxState.machineId,
		});
		this.staticMemory = new StaticCoreMemoryProvider({ corePrompt: coreRule });

		// Route responses dynamically for casual chat, main orchestrator, subagent, and final report summary.
		let subagentToolCalled = false;
		const router: FauxResponseStep = (reqCtx) => {
			this.capturedContexts.push(reqCtx);
			const fullDump = renderAllText(reqCtx);
			const isSubagent = fullDump.includes('Jehee Workshop subagent "auth-fix"');

			if (isSubagent) {
				subagentCapturedContext = reqCtx;
				if (!subagentToolCalled) {
					subagentToolCalled = true;
					return fauxAssistantMessage([fauxToolCall("box_exec", { command: "npm test" })], {
						stopReason: "toolUse",
					});
				}
				return fauxAssistantMessage("已定位超时根因并修复，12 项单测通过。");
			}

			const lastNonSys = reqCtx.messages.findLast((m) => m.role !== "system");
			if (lastNonSys?.role === "toolResult") {
				return fauxAssistantMessage("已为你派发工坊任务 auth-fix，完成后我会主动通知你。");
			}
			const lastText =
				lastNonSys && typeof lastNonSys.content === "string"
					? lastNonSys.content
					: lastNonSys && Array.isArray(lastNonSys.content)
						? lastNonSys.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")
						: "";

			if (lastText.includes("中午想吃牛肉面")) {
				return fauxAssistantMessage("牛肉面不错！");
			}
			if (lastText.includes("开个工坊任务 auth-fix")) {
				return fauxAssistantMessage(
					[
						fauxToolCall("workshop", {
							action: "spawn",
							name: "auth-fix",
							message: "请修复登录超时并运行测试",
							repoPath: "/data/jehee/repos/app",
						}),
					],
					{ stopReason: "toolUse" },
				);
			}
			if (lastText.includes("[workshop:auth-fix completed]")) {
				return fauxAssistantMessage("工坊任务 auth-fix 已完成：修复了登录超时并通过单测");
			}
			return fauxAssistantMessage("收到。");
		};
		this.faux.setResponses(Array.from({ length: 20 }, () => router));

		this.host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models: this.models,
				defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
				memory: this.staticMemory,
				workshop: { client, provisioner },
			},
			this.ctx,
		);
		this.gateway = new ChannelGateway({
			host: this.host,
			allowFrom: { telegram: [tgOwner] },
		});
		this.gateway.registerTransport(
			new TelegramTransport({
				botToken: "test-token",
				fetchImpl: async (_url, init) => {
					if (init?.body !== undefined) {
						const parsed = JSON.parse(String(init.body)) as { chat_id?: string; text?: string };
						if (parsed.text !== undefined && parsed.chat_id !== undefined) {
							this.telegramSent.push({ chatId: parsed.chat_id, text: parsed.text });
						}
					}
					return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
				},
			}),
		);
	},
);

Given(
	"主对话在派发前已有日常闲聊 {string} -> {string}",
	async function (this: JeheeWorld, userChat: string, expectedReply: string) {
		assert.ok(this.gateway);
		const res = await this.gateway.ingest(
			{
				channel: "telegram",
				chatId: "tg-chat-1",
				senderId: "tg-owner-1",
				messageId: "casual-1",
				text: userChat,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		assert.equal(res.kind, "replied");
		if (res.kind === "replied") assert.equal(res.replyText, expectedReply);
	},
);

When(
	"主人 {string} 在 Telegram 会话 {string} 发送 {string}",
	async function (this: JeheeWorld, senderId: string, chatId: string, text: string) {
		assert.ok(this.gateway);
		const res = await this.gateway.ingest(
			{
				channel: "telegram",
				chatId,
				senderId,
				messageId: "spawn-1",
				text,
				timestampMs: Date.now(),
			},
			this.ctx,
		);
		assert.equal(res.kind, "replied", `Expected replied, got ${JSON.stringify(res)}`);
	},
);

Then("InstaBox 单机 {string} 被自动 resume 唤醒为 {string} 状态", (_machineId: string, expectedState: string) => {
	assert.ok(boxState.resumeCalls >= 1);
	assert.equal(boxState.state, expectedState);
});

Then("InstaBox 在持久化盘创建了独立 Git Worktree {string}", (expectedWorktree: string) => {
	assert.ok(boxState.existingWorktrees.has(`${expectedWorktree}/.git`));
});

Then("主入口先立即向 Telegram 会话 {string} 回复了派发确认消息", function (this: JeheeWorld, chatId: string) {
	const msgs = this.telegramSent.filter((m) => m.chatId === chatId);
	assert.ok(
		msgs.some((m) => m.text.includes("已为你派发工坊任务 auth-fix")),
		`Actual telegramSent for ${chatId}: ${JSON.stringify(msgs)}`,
	);
});

Then(
	"工坊子会话 {string} 的上下文包含核心记忆 {string}，但绝不包含主窗口闲聊 {string}",
	async function (this: JeheeWorld, _taskName: string, expectedCore: string, forbiddenChat: string) {
		assert.ok(this.host);
		await this.host.waitForWorkshopSettled(this.ctx);
		assert.ok(subagentCapturedContext, "Subagent must have executed");
		const dump = renderAllText(subagentCapturedContext);
		assert.ok(dump.includes(expectedCore), "Subagent should inherit L1 Core memory");
		assert.ok(!dump.includes(forbiddenChat), "Subagent must NOT inherit main chat banter");
	},
);

Then("工坊子会话在独立目录 {string} 内执行了修复脚本并完成任务", (expectedCwd: string) => {
	assert.ok(
		boxState.execLog.some((req) => req.cmd === "npm test" && req.cwd === expectedCwd),
		`Expected box_exec in cwd ${expectedCwd}`,
	);
});

Then(
	"等待后台工坊结算后，Telegram 会话 {string} 自动收到了工坊完工汇报 {string}",
	async function (this: JeheeWorld, chatId: string, expectedPush: string) {
		assert.ok(this.host);
		await this.host.waitForWorkshopSettled(this.ctx);
		const msgs = this.telegramSent.filter((m) => m.chatId === chatId).map((m) => m.text);
		assert.ok(
			msgs.includes(expectedPush),
			`Expected Telegram messages ${JSON.stringify(msgs)} to include ${expectedPush}`,
		);
	},
);

Given(
	"InstaBox 免费单机 {string} 当前处于 {string} 运行状态且配置了可控慢工坊模型",
	function (machineId: string, state: string) {
		boxState = {
			machineId,
			state: state as InstaBoxMachineState,
			resumeCalls: 0,
			execLog: [],
			existingWorktrees: new Set(),
		};
		let notifyEntered!: () => void;
		subagentEntered = new Promise<void>((resolve) => {
			notifyEntered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			releaseSlowSubagent = resolve;
		});

		const router: FauxResponseStep = async (reqCtx) => {
			const dump = renderAllText(reqCtx);
			if (dump.includes('Jehee Workshop subagent "refactor-db"')) {
				notifyEntered();
				await gate;
				return fauxAssistantMessage("done");
			}
			const lastNonSys = reqCtx.messages.findLast((m) => m.role !== "system");
			if (lastNonSys?.role === "toolResult") {
				const toolOut =
					typeof lastNonSys.content === "string"
						? lastNonSys.content
						: lastNonSys.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
				return fauxAssistantMessage(toolOut);
			}
			const userText = lastNonSys && typeof lastNonSys.content === "string" ? lastNonSys.content : "";
			if (userText === "CMD_SPAWN") {
				return fauxAssistantMessage(
					[
						fauxToolCall("workshop", {
							action: "spawn",
							name: "refactor-db",
							message: "重构数据库索引",
							repoPath: "/data/jehee/repos/app",
						}),
					],
					{ stopReason: "toolUse" },
				);
			}
			if (userText === "CMD_STATUS") {
				return fauxAssistantMessage([fauxToolCall("workshop", { action: "status" })], {
					stopReason: "toolUse",
				});
			}
			if (userText === "CMD_STOP_AND_CLEANUP") {
				return fauxAssistantMessage(
					[
						fauxToolCall("workshop", { action: "stop", name: "refactor-db" }),
						fauxToolCall("workshop", { action: "cleanup", name: "refactor-db" }),
					],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("ack");
		};
		this.faux.setResponses(Array.from({ length: 20 }, () => router));
	},
);

Given("Jehee 已启动云工坊板块", async function (this: JeheeWorld) {
	const client = createMockInstaBoxClient(boxState);
	const provisioner = new SingleBoxWorktreeProvisioner({
		client,
		machineId: boxState.machineId,
	});
	this.host = await JeheeHost.open(
		{
			storage: { kind: "memory" },
			models: this.models,
			defaultModel: { provider: "faux", modelId: this.faux.getModel().id },
			workshop: { client, provisioner },
		},
		this.ctx,
	);
});

When(
	"主入口派发后台工坊任务 {string}（仓库 {string}）且子任务正在执行中",
	async function (this: JeheeWorld, _taskName: string, _repoPath: string) {
		assert.ok(this.host && subagentEntered);
		await this.host.sendMessage({ text: "CMD_SPAWN" }, this.ctx);
		await subagentEntered;
	},
);

Then("查询工坊状态返回 {string}", async function (this: JeheeWorld, expectedStatus: string) {
	assert.ok(this.host);
	const res = await this.host.sendMessage({ text: "CMD_STATUS" }, this.ctx);
	assert.equal(res.status, "done");
	if (res.status === "done") {
		lastStatusReply = res.replyText;
	}
	assert.ok(
		lastStatusReply.includes(expectedStatus),
		`Expected status ${JSON.stringify(lastStatusReply)} to include ${expectedStatus}`,
	);
});

When(
	"主入口调用工坊 stop 停止任务 {string} 并调用 cleanup 清理其工作区",
	async function (this: JeheeWorld, _name: string) {
		assert.ok(this.host);
		if (releaseSlowSubagent !== undefined) {
			releaseSlowSubagent();
			releaseSlowSubagent = undefined;
		}
		await this.host.sendMessage({ text: "CMD_STOP_AND_CLEANUP" }, this.ctx);
	},
);

Then("InstaBox 执行了针对 {string} 的 git worktree 清理命令", (expectedWorktree: string) => {
	assert.ok(!boxState.existingWorktrees.has(`${expectedWorktree}/.git`));
	assert.ok(
		boxState.execLog.some(
			(req) =>
				req.argv !== undefined &&
				req.argv[0] === "git" &&
				req.argv.includes("remove") &&
				req.argv.includes(expectedWorktree),
		),
	);
});
