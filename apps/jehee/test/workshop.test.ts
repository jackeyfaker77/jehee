// Unit tests for Workshop path-traversal guards, task slug validation, and InstaBox API wire behavior.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	ChannelGateway,
	InstaBoxClient,
	JeheeHost,
	resolveScopedSandboxPath,
	SingleBoxWorktreeProvisioner,
	validateTaskSlug,
} from "../src/index.ts";

describe("workshop sandbox safety and client", () => {
	it("validates task slugs and blocks shell/path metacharacters", () => {
		assert.equal(validateTaskSlug("auth-fix_01"), "auth-fix_01");
		assert.throws(() => validateTaskSlug("../escape"));
		assert.throws(() => validateTaskSlug("bad space"));
		assert.throws(() => validateTaskSlug(""));
	});

	it("confines relative and absolute file paths strictly inside assigned worktree", () => {
		assert.equal(
			resolveScopedSandboxPath("/data/jehee/worktrees/t1", "src/app.ts"),
			"/data/jehee/worktrees/t1/src/app.ts",
		);
		assert.equal(
			resolveScopedSandboxPath("/data/jehee/worktrees/t1", "/data/jehee/worktrees/t1/README.md"),
			"/data/jehee/worktrees/t1/README.md",
		);
		assert.throws(() => resolveScopedSandboxPath("/data/jehee/worktrees/t1", "../../secret.txt"));
		assert.throws(() => resolveScopedSandboxPath("/data/jehee/worktrees/t1", "/etc/passwd"));
	});

	it("sends X-API-Key and atomic PUT /files query parameters correctly", async () => {
		const calls: Array<{ url: string; method: string; apiKey: string | null }> = [];
		const client = new InstaBoxClient({
			apiKey: "ibk_unit_123",
			fetchImpl: async (input, init) => {
				calls.push({
					url: String(input),
					method: init?.method ?? "GET",
					apiKey: new Headers(init?.headers).get("x-api-key"),
				});
				return new Response("file-body", { status: 200 });
			},
		});
		await client.writeFileText("m-1", "/data/jehee/worktrees/t1/a.ts", "export const x = 1;");
		const content = await client.readFileText("m-1", "/data/jehee/worktrees/t1/a.ts");
		assert.equal(content, "file-body");
		assert.equal(calls.length, 2);
		assert.equal(calls[0]?.method, "PUT");
		assert.equal(calls[0]?.apiKey, "ibk_unit_123");
		assert.ok(calls[0]?.url.includes("/v1/machines/m-1/files?path="));
		assert.ok(calls[0]?.url.includes("parents=true"));
		assert.equal(calls[1]?.method, "GET");
		assert.ok(calls[1]?.url.includes("/v1/machines/m-1/files/content?path="));
	});

	it("resolves human machine names to canonical m_... IDs before resume and exec", async () => {
		const paths: string[] = [];
		let state: "suspended" | "running" = "suspended";
		const client = new InstaBoxClient({
			apiKey: "ibk_unit_123",
			fetchImpl: async (input, init) => {
				const url = new URL(String(input));
				const method = init?.method ?? "GET";
				paths.push(`${method} ${url.pathname}`);
				if (
					method === "GET" &&
					(url.pathname === "/v1/machines/achi" || url.pathname === "/v1/machines/m_real123")
				) {
					return Response.json({ id: "m_real123", name: "achi", state });
				}
				if (method === "POST" && url.pathname === "/v1/machines/m_real123/resume") {
					state = "running";
					return Response.json({ id: "op_1", machineId: "m_real123", state: "succeeded" });
				}
				if (method === "POST" && url.pathname === "/v1/machines/m_real123/exec") {
					return Response.json({ stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false });
				}
				return new Response("not found", { status: 404 });
			},
		});
		const provisioner = new SingleBoxWorktreeProvisioner({ client, machineId: "achi" });
		const ws = await provisioner.prepareWorkspace({ taskName: "smoke-verify", idempotencyKey: "idem-1" });
		assert.equal(ws.machineId, "m_real123");
		assert.deepEqual(paths, [
			"GET /v1/machines/achi",
			"POST /v1/machines/m_real123/resume",
			"GET /v1/machines/m_real123",
			"POST /v1/machines/m_real123/exec",
		]);
	});

	it("deduplicates proactive outbound pushes when multiple workshop reporters coalesce onto one main answer", async () => {
		const faux = fauxProvider();
		// Step 1 (main): spawn w1 and w2 in one turn -> creates two WorkshopReporter tasks
		// Step 2 & 3 (subagents w1 & w2): each finishes immediately
		// Step 4 (main): replies to user's initial spawn turn while both reporters queue followUp on main
		// Step 5 (main): single coalesced followUp answer covering both w1 and w2 reports
		let subTurn = 0;
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("workshop", { action: "spawn", name: "w1", message: "job 1" }),
					fauxToolCall("workshop", { action: "spawn", name: "w2", message: "job 2" }),
				],
				{ stopReason: "toolUse" },
			),
			(ctx) => {
				const sys = JSON.stringify(ctx.messages[0] ?? "");
				if (sys.includes("Workshop subagent")) {
					subTurn += 1;
					return fauxAssistantMessage(`subagent-done-${subTurn}`);
				}
				return fauxAssistantMessage("两个工坊任务均已启动。");
			},
			(ctx) => {
				const sys = JSON.stringify(ctx.messages[0] ?? "");
				if (sys.includes("Workshop subagent")) {
					subTurn += 1;
					return fauxAssistantMessage(`subagent-done-${subTurn}`);
				}
				return fauxAssistantMessage("两个工坊任务均已启动。");
			},
			fauxAssistantMessage("两个工坊任务均已启动。"),
			fauxAssistantMessage("汇总汇报：w1 与 w2 均已完成。"),
		]);

		const models = createModels();
		models.setProvider(faux.provider);

		const client = new InstaBoxClient({
			apiKey: "ibk_unit",
			fetchImpl: async () =>
				Response.json({
					id: "m_1",
					state: "running",
					stdout: "",
					stderr: "",
					exitCode: 0,
					timedOut: false,
					truncated: false,
				}),
		});
		const provisioner = new SingleBoxWorktreeProvisioner({ client, machineId: "m_1" });
		const host = await JeheeHost.open(
			{
				storage: { kind: "memory" },
				models,
				defaultModel: { provider: "faux", modelId: faux.getModel().id },
				workshop: { client, provisioner },
			},
			BACKGROUND_CONTEXT,
		);
		const pushed: string[] = [];
		const gateway = new ChannelGateway({
			host,
			allowFrom: { telegram: ["owner-1"] },
		});
		gateway.registerTransport({
			channel: "telegram",
			sendText: async (_chatId, text) => {
				pushed.push(text);
			},
		});

		try {
			await gateway.ingest(
				{
					channel: "telegram",
					chatId: "chat-1",
					senderId: "owner-1",
					messageId: "1",
					text: "同时开 w1 和 w2 两个工坊",
					timestampMs: Date.now(),
				},
				BACKGROUND_CONTEXT,
			);
			await host.waitForWorkshopSettled(BACKGROUND_CONTEXT);
			await gateway.drain();

			const summaryCount = pushed.filter((msg) => msg === "汇总汇报：w1 与 w2 均已完成。").length;
			assert.equal(summaryCount, 1, `Expected proactive summary once, got: ${JSON.stringify(pushed)}`);
		} finally {
			gateway.dispose();
			await host.close(BACKGROUND_CONTEXT);
			await gateway.drain();
		}
	});

	it("invokes fetch without binding `this` to the InstaBoxClient instance (Cloudflare Workers compatibility)", async () => {
		async function strictFetch(this: unknown): Promise<Response> {
			if (this !== undefined) {
				throw new TypeError("Illegal invocation");
			}
			return Response.json({ id: "m_1", name: "achi", state: "running" });
		}
		const client = new InstaBoxClient({ apiKey: "ibk_1", fetchImpl: strictFetch });
		const machine = await client.getMachine("achi");
		assert.equal(machine.id, "m_1");
	});
});
