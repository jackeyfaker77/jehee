// Cucumber step definitions for OpenCode Go model resolution, runtime env config parsing, and Cloudflare Worker bundle purity.

import assert from "node:assert/strict";
import { type DataTable, Given, Then, When } from "@cucumber/cucumber";
import type { Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { inspectWorkerBundle, type WorkerBundleReport } from "../../scripts/check-worker-bundle.ts";
import { type JeheeRuntimeConfig, parseJeheeEnvConfig } from "../../src/runtime/config.ts";
import { createJeheeModels, resolveModelSpec } from "../../src/runtime/models.ts";

let currentEnvDict: Record<string, string | undefined> = {};
let runtimeModels: Models | undefined;
let resolvedRef: ModelRef | undefined;
let resolutionError: Error | undefined;
let parsedConfig: JeheeRuntimeConfig | undefined;
let bundleReport: WorkerBundleReport | undefined;

Given("运行时环境变量配置了 OpenCode Go 密钥别名 {string} 为 {string}", (keyName: string, secretVal: string) => {
	currentEnvDict = { [keyName]: secretVal };
	runtimeModels = createJeheeModels(currentEnvDict);
	resolvedRef = undefined;
	resolutionError = undefined;
});

When("解析模型配置 {string}", (spec: string) => {
	assert.ok(runtimeModels);
	resolvedRef = resolveModelSpec(spec, runtimeModels);
});

Then("成功定位到提供商 {string} 下的模型 {string}", (expectedProvider: string, expectedModelId: string) => {
	assert.deepEqual(resolvedRef, { provider: expectedProvider, modelId: expectedModelId });
});

Then("通过模型集合查询 {string} 的认证状态为已配置可用", async (providerId: string) => {
	assert.ok(runtimeModels);
	const auth = await runtimeModels.getAuth(providerId);
	assert.ok(auth !== undefined, `Expected auth for ${providerId} to be configured`);
});

When("尝试解析不存在的错误模型配置 {string}", (badSpec: string) => {
	assert.ok(runtimeModels);
	try {
		resolveModelSpec(badSpec, runtimeModels);
		resolutionError = undefined;
	} catch (err) {
		resolutionError = err as Error;
	}
});

Then("立即抛出包含候选模型提示的清晰配置错误", () => {
	assert.ok(resolutionError !== undefined);
	assert.ok(resolutionError.message.includes("Available examples:"));
	assert.ok(resolutionError.message.includes("opencode-go/"));
});

Given("提供如下环境变量配置字典:", (table: DataTable) => {
	currentEnvDict = {};
	for (const row of table.hashes()) {
		if (row.key !== undefined) {
			currentEnvDict[row.key] = row.value;
		}
	}
});

When("解析 Jehee 运行时配置", () => {
	parsedConfig = parseJeheeEnvConfig(currentEnvDict);
});

Then(
	"解析出的默认模型为 provider {string} 与 modelId {string}",
	(expectedProvider: string, expectedModelId: string) => {
		assert.ok(parsedConfig);
		assert.deepEqual(parsedConfig.defaultModel, {
			provider: expectedProvider,
			modelId: expectedModelId,
		});
	},
);

Then("Telegram 白名单包含用户 {string} 与 {string}", (u1: string, u2: string) => {
	assert.ok(parsedConfig?.telegram);
	assert.deepEqual(parsedConfig.telegram.allowedUsers, [u1, u2]);
});

Then("InstaBox 云工坊配置已自动启用并绑定机器 {string}", (expectedMachineId: string) => {
	assert.ok(parsedConfig?.instabox);
	assert.equal(parsedConfig.instabox.machineId, expectedMachineId);
});

When("对 Cloudflare 部署入口 {string} 执行边缘环境打包检查", async (_entryFile: string) => {
	bundleReport = await inspectWorkerBundle();
});

Then("打包成功且产物不包含任何 {string} 或 {string} 外部残留", (forbiddenA: string, forbiddenB: string) => {
	assert.ok(bundleReport);
	assert.ok(!bundleReport.externalNodeBuiltins.includes(forbiddenA));
	assert.ok(!bundleReport.externalNodeBuiltins.includes(forbiddenB));
});

Then("打包后的脚本总字节数小于 {int} 字节", (maxBytes: number) => {
	assert.ok(bundleReport);
	assert.ok(
		bundleReport.byteLength > 0 && bundleReport.byteLength < maxBytes,
		`Expected bundle size ${bundleReport.byteLength} to be < ${maxBytes}`,
	);
});
