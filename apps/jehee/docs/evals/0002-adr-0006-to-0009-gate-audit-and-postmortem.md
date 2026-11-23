# 审计与复盘-0002：ADR-0006 至 ADR-0009 验收门禁补齐记录与根因复盘

- **关联立项**：[ADR-0006](../adr/0006-nonblocking-telegram-polling-and-cli-boundary.md)、[ADR-0007](../adr/0007-mcp-connector-skeleton-and-eval.md)、[ADR-0008](../adr/0008-write-approval-and-quiet-governance.md)、[ADR-0009](../adr/0009-external-coding-agent-workshop-gateway.md)
- **执行日期**：2026-11-24
- **审计范围**：逐项核对 `ADR-0006`–`ADR-0009` 验收门禁清单与设计正文对代码的实际断言覆盖度，并在补齐验证过程中排查暴露出的真实缺陷。

---

## 1. 审计结论总览（Conclusions）

1. **原状态定位**：在本次补齐前，现有构建门禁（`biome`、`tsc`）、`30` 条单测与 `29` 条 BDD 场景虽全绿通过，但多份 ADR 清单存在**“设计/文案范围大于实际用例覆盖”**的虚高勾选；同时 `scripts/check-worker-bundle.ts` 的 `platform: "neutral"` 配置与 `FORBIDDEN_EDGE_BUILTINS` 漏项掩盖了边缘包中残留 `node:child_process` 的隐患。
2. **通过补齐测试直接暴露并修复的 3 个真实工程问题**：
   - **Worker 包误留 `node:child_process`（来自 `@anthropic-ai/sdk`）**：当把 [check-worker-bundle.ts](../../scripts/check-worker-bundle.ts) 从 `platform: "neutral"` 切为对齐 Wrangler 边缘行为的 `platform: "browser"`、并按构建产物 `outputs[*].imports` 严格拦截 `node:child_process` / `child_process` 后，发现 `@anthropic-ai/sdk` 此前因未命中 `package.json` 的 `"browser"` 映射而保留了 `internal/node.mjs` 与 `tools/agent-toolset/node.mjs`（含 `import * as cp from "node:child_process"`）。切换映射后，`worker.ts` 压缩产物从 **`1898.8 KiB`（1,944,321 B）降至 `1861.6 KiB`（1,906,295 B）**，保留外部导入仅剩 `cloudflare:workers`、`node:crypto`、`node:path`（与 `node:fs` 懒引用），零 `node:sqlite` 与 `node:child_process`。
   - **Windows 下 `LocalWorktreeBackend.stopJob` 未等待进程树退出的 `EBUSY` 竞态**：补齐真实本机 Git Worktree 的 `stopJob -> cleanupWorkspace` 单测后，在 Windows 上直接复现了 `EBUSY: resource busy or locked, rmdir`——原 `killChildTree` 以 fire-and-forget 方式异步启动 `taskkill /T /F`，导致目录句柄尚未释放时即执行 `git worktree remove`；同时 `taskkill /F` 强制结束返回 OS 退出码 `1`，在先等待结束时覆盖了规范退出码 `143`。现已在 [node-local-backend.ts](../../src/workshop/node-local-backend.ts) 中改为先写入 `exitCode: 143` 终态，再 `await killChildTree(...)` 等待子进程关闭（并附带 `rm` 的 `maxRetries: 5` 保护）。
   - **本机 Worktree 缺失 Git Exclude 配置**：原实现仅在 Jehee 自身的 `buildGitSummaryBlock` 中过滤 `.jehee-workshop/`，外部 CLI 在同一 Worktree 内直接运行 `git status` 时仍能看到未跟踪目录。现已于 [node-local-backend.ts](../../src/workshop/node-local-backend.ts) 创建 Worktree 后自动向 `git rev-parse --git-path info/exclude` 幂等写入 `.jehee-workshop/`，单测已验证原生 `git status --short` 仅输出源码改动 `M hello.txt`。

---

## 2. 逐切片缺口核对与补齐细节（Verification Details）

| 切片 / ADR | 原核查发现的门禁缺口 | 补齐落地内容 | 验证位置 |
| :--- | :--- | :--- | :--- |
| **ADR-0006**（Slice 3.6） | `pollTelegramUpdatesOnce` 的 `callback_query` 非阻塞入站分支，以及 `runTelegramPollingDaemon` 的异常重试循环与 `AbortSignal` 退出未覆盖。 | 为 [node.ts](../../src/runtime/node.ts) 的 `runTelegramPollingDaemon` 注入可选 `fetchImpl` 与 `retryDelayMs` 以便确定性测试；在单测中覆盖 `callback_query` 即时推进 `offset` 语义与守护循环 HTTP 500 重试恢复后响应 `AbortSignal` 停机。 | [telegram.test.ts](../../test/telegram.test.ts) |
| **ADR-0007**（Slice 4） | 1. `check-worker-bundle.ts` 未对 `node:child_process` 做产出级硬拦截且采用 `platform: "neutral"`；<br>2. 资源三件套仅测 `eager` 模式，未测默认 `deferred` 下的 `tool_search` 发现；<br>3. `classifyFailureRootCause` 仅测 5 桶中的 3 桶。 | 1. 修复 [check-worker-bundle.ts](../../scripts/check-worker-bundle.ts) 为 `platform: "browser"` + `output.imports` 强校验；<br>2. 新增默认 `deferred` 模式下经 `tool_search` 发现并调用 `list_mcp_resources` / `read_mcp_resource`（含 `$jehee_blob:` 卸载与 `jehee.mcp.resource_read` Span）单测；<br>3. 补齐 `boundary_violation` 与 `arg_or_version_error` 分类器断言。 | [check-worker-bundle.ts](../../scripts/check-worker-bundle.ts)<br>[mcp.test.ts](../../test/mcp.test.ts) |
| **ADR-0008**（Slice 5A） | 1. 仅测 `pending` 票据跨 SQLite 重启，未测 `approved`（已批待消费）票据跨重启执行；<br>2. BDD 未端到端验证 `busy_yield` 与 `rate_cooldown`（仅测了静默时段）；<br>3. `/flush`、`/reject`、`apv:no:<id>` 取消按钮、`ambiguous` 多票据歧义提示与 `exemptTools` 均无端到端或单测覆盖。 | 1. 单测新增双待批 `ambiguous` 提示、`/approve`、`/reject` 零模型调用撤单、`apv:no:<id>` 按钮及空队列 `/flush`；<br>2. BDD 新增 `Scenario 5` 验证 `exemptTools` 免批直通、Telegram 取消按钮作废票据、`approved` 票据跨越 SQLite 重启自动消费放行；<br>3. BDD 新增 `Scenario 6` 验证真实 `ChannelGateway` 下的 `busy_yield`、`rate_cooldown` 与 `/flush` 手动汇总补发。 | [governance.test.ts](../../test/governance.test.ts)<br>[governance-and-approvals.feature](../../features/governance-and-approvals.feature)<br>[governance.steps.ts](../../features/steps/governance.steps.ts) |
| **ADR-0009**（Slice 5B） | 1. `claude` / `codex` / `custom` 未测首轮（`isContinuation: false`）与 `--resume` 会话参数；<br>2. 未测本机 Worktree 原生 `git status` 对 `.jehee-workshop/` 的隔离；<br>3. 运行中 `send` 的 `followUp: true` 排队与 `followUp: false` 停旧启新、以及本机真实 `stopJob` 按 PID 杀进程树未验证。 | 1. 单测补全 6 类驱动首轮/续聊/`externalSessionId` 参数向量；<br>2. 本机 `LocalWorktreeBackend` 写入 `info/exclude` 并校验原生 `git status --short` 干净及真实 `stopJob -> pollJob(143) -> cleanupWorkspace` 流程；<br>3. BDD 新增 `Scenario 4` 验证运行中 `followUp: true` 排队按序接续 `--continue` 与 `followUp: false` 立即停旧重启。 | [node-local-backend.ts](../../src/workshop/node-local-backend.ts)<br>[coding-agent-gateway.test.ts](../../test/coding-agent-gateway.test.ts)<br>[coding-agent-gateway.feature](../../features/coding-agent-gateway.feature)<br>[coding-agent-gateway.steps.ts](../../features/steps/coding-agent-gateway.steps.ts) |

---

## 3. 全量门禁实测结果（2026-11-24，修复后重跑全绿）

在 `E:\CODE\jehee\apps\jehee` 及仓根分别执行全套静态门禁、单测、BDD 与离线对比评测，全部退出码为 `0`：

| 检查项 | 执行范围与结果 | 关键量化指标 |
| :--- | :--- | :--- |
| **Biome 检查** | `52` files（`apps/jehee` 范围）/ `2628` files（全仓）全部通过 | `0` 错误，`0` 警告 |
| **TypeScript 类型检查** | `tsc --noEmit`（`apps/jehee` 严格模式）通过 | `0` 编译错误 |
| **依赖与导入门禁** | `check-pinned-deps` / `check-runtime-deps` / `check-ts-relative-imports` 全部通过 | 依赖版本 100% 精确锁定 |
| **Worker 边缘打包门禁** | `scripts/check-worker-bundle.ts`（`platform: "browser"`）通过 | `1861.6 KiB`（`1,906,295` bytes）；零 `node:sqlite` 与 `node:child_process` 保留导入 |
| **单元测试（`node:test`）** | **`33/33` 通过**（`10` suites，耗时 `2.36s`） | 较补齐前新增 3 条完整用例并扩展多驱动/5桶断言 |
| **Cucumber BDD 验收** | **`32/32` 场景（`233/233` 步骤）全部通过**（耗时 `3.46s`） | 新增治理与外部 CLI 编排 3 条端到端场景 |
| **离线 MCP 对比评测** | `evals/mcp-exposure-eval.ts` 4 组跑通 | Arm C 相比 Arm A Prefill 降 **`89.2%`**（`127,450 -> 13,780`），参考成本降 **`85.7%`**（`\$0.03495 -> \$0.00500`） |

---

## 4. 失败根因与流程复盘（Postmortem & Takeaways）

### 4.1 为什么会出现「门禁勾选 `[x]` 但验证实际不全」？
1. **“按概念命名写概括条目”替代了“按边界分支核对用例”**：
   例如 ADR-0008 清单写“验证待批/已批票据不丢失、忙时让路、频控冷却、`/flush`”，但在编写 BDD 时只覆盖了静默时段和待批票据这两个主路径，其余分支仅在单测测了局部纯函数或在开发时人工心算正确后就直接勾选 `[x]`。
2. **打包门禁的 `platform` 与树摇（Tree-Shaking）口径错配**：
   此前 `check-worker-bundle.ts` 采用 `platform: "neutral"` 且把 `node:sqlite` 列入 pre-shake 黑名单、忽略了 `node:child_process`——因为 `@earendil-works/pi-mcp` 入口 barrel re-export 了 `StdioTransport`，一旦在 pre-shake 阶段封禁 `node:child_process` 就会被误伤报错，从而错失了对产物级（`outputs[*].imports`）残留 `node:child_process` 的校验，使得 `@anthropic-ai/sdk` 在 `neutral` 模式下绕过 `"browser"` 映射悄悄带入 `node:child_process` 而未被察觉。
3. **测试工具路由器（Faux Router）使用每轮独立局部状态引发隐蔽假阳性风险**：
   在补齐 `governance.steps.ts` 的重启后继续审批场景时，最初写成 `Array.from({ length: 12 }, () => createRouter(0))`，导致多轮调用中每次进入新的闭包实例都误用 `prev = 0`。改为直接依据上下文最后一条消息角色（`ctx.messages.at(-1)?.role === "user"`）路由后消除了跨闭包状态漂移。

### 4.2 后续交付硬规则（从 Slice 5C / ADR-0010 起强制执行）
1. **一清单项一实证索引**：ADR 清单的每条 `[x]` 必须能够直接指向具体测试文件名与测试标题/场景名；未端到端测试的分支不得打包写进同一条 `[x]` 里。
2. **边缘产物与原生资源生命周期强验证**：所有平台相关模块（Worker Edge 打包、Windows/POSIX 子进程树终止、Git Worktree 清理）必须以真实 OS 进程 / 真实产物构建流验证（如本次暴露出的 `stopJob -> cleanupWorkspace` 句柄锁与 `outputs[*].imports`）。
3. **文档状态与实现严格同步**：先跑全量门禁和核对每条分支覆盖，再将 ADR 清单置为 `[x]`。
