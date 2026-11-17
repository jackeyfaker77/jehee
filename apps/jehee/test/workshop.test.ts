// Unit tests for Workshop path-traversal guards, task slug validation, and InstaBox API wire behavior.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InstaBoxClient, resolveScopedSandboxPath, validateTaskSlug } from "../src/index.ts";

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
});
