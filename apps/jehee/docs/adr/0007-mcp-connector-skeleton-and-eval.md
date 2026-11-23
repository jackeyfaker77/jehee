# ADR-0007：双栖 MCP 连接器骨架、Trace 可观测性与暴露策略对比 Eval

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-18
- **关联需求**：[PRD v1.1 — Slice 4](../PRD.md)、[工程规范与指标字典](../README.md#3-可观测性标准指标口径与失败复盘规范)、[ADR-0005](./0005-runtime-entrypoints-and-opencode-go.md)、[ADR-0006](./0006-nonblocking-telegram-polling-and-cli-boundary.md)

---

## 1. 背景与问题（Context & Problem）

在完成 Slice 1–3.6（`JeheeHost` 常驻宿主、双栖非阻塞渠道网关、InstaBox 云工坊与 OpenCode Go 运行入口）后，我们已经明确了 Jehee 的核心产品边界：

1. **不做 Coding Agent 的替代品，而做个人总管与上层网关**：代码修改交由工坊（及后续演进接入的外部 Coding Agent CLI）处理；Jehee 主体聚焦于代表个人跨时间、跨日常应用（邮件、日历、账单、医保、药房、出行等）协调事务。
2. **优先打通外部生活应用连接器并对齐 PALE 场景**：要参与 [PALE（Personal Agents' Last Exam）](https://github.com/MatrAIx-ai/Personal-Agents-Last-Exam) 评测并连接真实日常服务，当前工具层最核心的缺口是 **MCP（Model Context Protocol）客户端连接器骨架**；而记忆层由于已具备热插拔 `MemoryProvider` 接口，可在后续周期按需通过 Eval 渐进迭代。

设计这一层连接器骨架必须同时解决五个具体的工程问题：

1. **多应用挂载时的上下文膨胀与 KV-Cache 破坏**：
   单个 PALE 任务或日常助理常同时连接 4–8 个服务（仅一个医保门户就有 21 个工具，合计可达 60–100+ 工具）。若全量直铺 JSON Schema，会挤占大量输入 Token、降低选词准确率，且服务重连可能扰动前缀缓存。
2. **PALE 写操作的乐观锁版本链与结构化错误透传**：
   PALE 环境的所有写工具强制校验 `expected_version: { epoch, revision }` 与幂等 `request_id`，并在冲突或需确认时通过 `isError: true` 返回结构化业务状态（如 `{ status: "stale_version", current_version }`、`confirmation_required`、`not_authorized`）。连接器绝不能吞掉错误载荷或丢失 `structuredContent`。
3. **跨应用大附件无损流转（防上下文爆窗且保 SHA-256 一致）**：
   PALE 场景（如收据入账：从 Mail 读取 `receipt.pdf` 与 `delivery.ics`，再导入 Calendar 并挂载原 PDF）同时使用业务工具与 MCP `resources/read`（`pale://<run>/<app>/assets/<id>`），且接收端严格校验文件字节的 `sha256`。若将数百 KB 的 Base64 直接灌入模型上下文会瞬间爆窗；若仅做文本截断则会丢失原始字节导致下游写入失败。
4. **多实例账号隔离与双栖运行时纯净度**：
   同一服务可能同时挂载多个账号实例（如个人邮箱与工作邮箱、PALE 双邮箱交互）；同时内核必须保持零 `node:child_process` 耦合以通过 Cloudflare Workers 打包门禁，而在本地运行或跑 PALE 评测时又需无缝支持 `stdio` 子进程 MCP Server。
5. **如何客观量化不同工具暴露策略的优劣（Comparative Eval）**：
   “全量暴露（`eager`）”与“摘要常驻 + 按需检索（`deferred + tool_search`）”及“附件句柄暂存”到底省多少 Token、是否影响任务成功率，需要一套不依赖主观裁判的对比评测方法。

---

## 2. 备选方案对比（Alternatives Considered）

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：自研轻量 JSON-RPC MCP 客户端并全量注入所有工具 Schema** | 无需引入新包，少一跳 `tool_search` | 重复造协议握手与分页轮子；挂载 5 个以上服务时每次请求白烧数万 Schema Token，违背“主 Agent 保持稀疏”原则。 |
| **方案 B：直接照搬同仓 `apps/p2/plugins/mcp` 的完整架构** | 已有租约管理、远程守护进程与 OAuth 路由 | `p2` 面向多工作区与多主体 Chord 服务网，耦合 `@p2/app` 内部框架，且其 `tools.ts` 未桥接 MCP `resources/*` 与二进制附件句柄，对单主人 Jehee 过重。 |
| **方案 C（最终采用）：复用同仓 `@earendil-works/pi-mcp` + `@earendil-works/pi-durable/tool-search`，构建双栖 `src/mcp/` 骨架 + 会话级附件句柄暂存 + 可切换暴露模式的对比 Eval** | 协议层 100% 标准兼容（含 `2025-11-25` 握手）；Transport 注入保住 Worker 边缘纯净度；原生支持 `eager` / `deferred` 开关直接跑 A/B 对比评测 | 需编写约 350 行桥接层处理资源工具、Base64 句柄自动展开与只读/写策略包装。 |

---

## 3. 决策与核心依据（Why — 为什么这么设计）

### 3.1 复用 `@earendil-works/pi-mcp` 并通过 Transport 注入保持双栖纯净
- `@earendil-works/pi-mcp`（`package.json` 声明 `"sideEffects": false`）已完整实现 MCP `2025-11-25` 握手（`initialize` + `notifications/initialized`）、工具与资源分页、`createMcpToolName` 64 字符防碰撞命名、`normalizeMcpInputSchema` 与 `limitMcpContent`。
- `apps/jehee/src/mcp/` 核心模块**仅导入纯协议类与 `StreamableHttpTransport`**，绝不引用 `StdioTransport`；本地 `stdio` 装配单独放在 Node 专属模块 `src/mcp/node-stdio.ts`（与 `src/runtime/node.ts` 同级隔离），确保 `worker.ts` 经 esbuild 摇树后零 `child_process` / `cross-spawn` 残留。

### 3.2 对齐模型预训练分布的资源工具三件套 + 会话级 Blob 句柄
- 参考同仓 `packages/coding-agent/src/extensions/mcp/resources.ts`，当任意已连接 MCP Server 具备资源能力时，统一注册 **`list_mcp_resources`**、**`list_mcp_resource_templates`** 与 **`read_mcp_resource`**（接收 `server` 与 `uri` 参数），直接复用前沿模型在 Codex / OpenCode 上的预训练工具习惯。
- **大二进制附件句柄机制（Blob Handle Vault）**：
  - 当 MCP `tools/call` 返回的 `structuredContent` 或 `resources/read` 返回的 `blob` 中包含超过阈值（如 4 KiB）的 Base64 二进制载荷（如 PDF、音频、大二进制），且非直接文本（`text/*`、`application/json`、`text/calendar` 解码为可读 UTF-8 展示）时：
  - 连接器将完整原始 Base64 存入当前宿主会话内存/文档映射表，分配稳定引用标识 `"$jehee_blob:<sha256_prefix>"`，并在返回给模型的文本视图中替换为该句柄与元信息（字节长度、MIME、`sha256`）；
  - 当模型在后续任意 MCP 写工具（如 `calendar.attachment.add`）参数中传入 `"$jehee_blob:<id>"` 字符串时，连接器在发往 MCP Server 前自动递归展开还原为原始 Base64 字符串——既把单次附件上下文开销压到百字节级，又保证接收端 `sha256` 100% 精确匹配。

### 3.3 保留完整结构化报错与只读/写策略钩子
- 当 `CallToolResult.isError === true` 时，原样保留服务端返回的文本 JSON 与 `structuredContent`（不覆写吞没），确保模型能直接读取 PALE 的 `current_version`、`confirmation_required` 或字段级权限错误。
- 连接器支持为每个实例配置 `includeTools` / `excludeTools` 以及统一的 `beforeWriteCall` 钩子（基于 MCP `annotations.readOnlyHint !== true` 识别写操作），为后续高风险操作草稿确认门控留好干净挂载点。

### 3.4 前置打通父子 Span 决策树与五类失败复盘（Observability First）
- `JeheeHostOptions` 透传 `telemetry?: TelemetryContext` 至底层 `Harness.open()`，补齐此前缺失的观测链路，自动激活 `pi.durable.submit -> pi.durable.phase -> pi.ai.request / pi.tool` 决策树，并在 `JeheeHost` 上暴露会话级累计账单查询 `getUsageSummary()`（同步增强 `/status` 指令回显缓存命中率与花费）。
- 在 `src/telemetry/recorder.ts` 中定义 `JEHEE_MCP_TELEMETRY_SCHEMA`（`jehee.mcp.call` 与 `jehee.mcp.resource_read` 子 Span），并提供 `JeheeTraceRecorder`、`computeTraceMetrics`（严格遵循 `prefill_tokens = input + cache_read + cache_write` 口径）以及五类失败根因归类与复盘渲染器（`discovery_miss` / `arg_or_version_error` / `payload_overflow` / `boundary_violation` / `model_reasoning`）。

### 3.5 内置可切换 `exposure` 模式的客观对比测试方法（MCP Comparative Eval）
之所以连接器层非常适合做对比 Eval，是因为工具暴露方式做成显式配置参数 `exposure: "eager" | "deferred"` 后，可以在**完全相同的模型、提示词、初始环境种子与确定性状态验收器**下跑严格控制变量实验：

1. **自变量（对比组设置）**：
   - **Group A（`eager` 全量直铺组）**：关闭 `tool_search`，将全部已挂载 MCP 工具（含目标 App 与若干干扰域 App，共 50+ 工具）直接暴露给模型。
   - **Group B（`deferred` 按需检索组，默认推荐）**：注入极简 `mcp_servers` 摘要目录，所有 MCP 业务工具设为 `deferred: true`，挂载 `createToolSearchExtension()` 按需加载。
   - **附件消融对比（`blobVault: off` vs `on`）**：在含 PDF + ICS 跨应用流转场景下对比是否启用二进制句柄暂存。
2. **测试基准环境（零主观裁判）**：
   - 直接驱动 PALE 本地参考运行时（`mail` + `calendar` 及干扰环境）：每轮测试前通过 `--role infra` 调用 `env.reset` + `env.load_seed` 锁定初始状态与虚拟时钟；
   - Jehee 仅持 `--role agent` 连接执行用户任务；
   - 回合结束后通过 `--role infra` 调用 `env.snapshot` 做**确定性状态断言**（邮件是否读对、日历事件 UID/时间是否准确、PDF 附件 `sha256` 是否一致、是否发生越权或版本冲突未恢复）。
3. **核心度量指标（直接由 `pi-durable` Usage 与快照算出）**：
   - **任务完全通过率（Pass Rate）** 与 **分步得分（Rubric Score）**；
   - **总输入 Token（Input Tokens）** 与 **KV-Cache 命中率（`cacheRead / (input + cacheRead)`）**；
   - **总轮次数（LLM Turns）**、**工具调用次数（Tool Calls）** 与 **单任务真实美元成本（Cost）**；
   - **强弱模型增益差（Peak Ji 指标）**：在 `opencode-go` 下对比轻量模型（如 `glm-5.3-flash`）与主力强模型在同一组配置下的得分差与成本比。

---

## 4. 具体设计方案（How — 怎么设计）

### 4.1 新增目录与模块结构

```text
apps/jehee/
├── src/
│   ├── telemetry/
│   │   └── recorder.ts        # JEHEE_MCP_TELEMETRY_SCHEMA、JeheeTraceRecorder、统一指标计算与五类失败复盘导出
│   └── mcp/
│       ├── contract.ts        # MCP 实例配置、暴露模式（eager/deferred）、写操作门控钩子与附件句柄类型
│       ├── config.ts          # 跨平台 mcpServers JSON 配置解析、${ENV_VAR} 占位符替换与双栖 stdio 工厂注入
│       ├── blob-vault.ts      # 会话级大 Base64 载荷提取、句柄替换与出站参数递归还原
│       ├── hub.ts             # 跨平台 McpConnectorHub：管理多实例 McpClient 握手、HTTP 传输、工具/资源快照与关闭
│       ├── extension.ts       # 将 McpConnectorHub 桥接为 pi-durable Extension（含 mcp_servers 目录段、资源三工具与 tool_search 联动）
│       └── node-stdio.ts      # 仅限本地 Node / PALE 评测导入：基于 StdioTransport 构建本地子进程 MCP 连接
├── features/
│   ├── mcp-connector.feature  # BDD 验收场景：Trace 决策树采集、多实例 tool_search 发现、乐观锁自愈、PDF/ICS 句柄跨应用流转与写门控
│   └── steps/
│       └── mcp.steps.ts
├── test/
│   └── mcp.test.ts            # 单元测试：Blob 句柄提取/还原、统一指标口径公式与失败根因分类器
└── evals/
    └── mcp-exposure-eval.ts   # 可运行对比评测脚本：跑 eager vs deferred + 附件消融对比表，自动输出失败样本 Trace 复盘
```

### 4.2 核心接口签名草案（`src/mcp/contract.ts`）

```typescript
import type { McpTransport } from "@earendil-works/pi-mcp";

/** How MCP tools are exposed to the root conversation. */
export type JeheeMcpExposure = "deferred" | "eager";

/** Configuration for one named MCP server instance (e.g. `"mail"`, `"mail_work"`, `"calendar"`). */
export type JeheeMcpServerSpec = {
	readonly name: string;
	readonly description?: string;
	readonly transport:
		| { readonly kind: "http"; readonly url: string; readonly headers?: Readonly<Record<string, string>> }
		| { readonly kind: "custom"; readonly create: () => McpTransport };
	readonly includeTools?: readonly string[];
	readonly excludeTools?: readonly string[];
	readonly requestTimeoutMs?: number;
};

/** Policy decision returned by `beforeWriteToolCall` before executing a mutating MCP tool. */
export type McpWriteGateDecision =
	| { readonly action: "allow" }
	| { readonly action: "block"; readonly reason: string };

/** Options for mounting the MCP connector layer onto `JeheeHost`. */
export type JeheeMcpOptions = {
	readonly servers: readonly JeheeMcpServerSpec[];
	/** Defaults to `"deferred"` (summary section + `tool_search` on-demand loading). */
	readonly exposure?: JeheeMcpExposure;
	/** Threshold in bytes above which binary Base64 fields are replaced with `$jehee_blob:<id>` handles. Defaults to 4096. */
	readonly blobOffloadThresholdBytes?: number;
	/** Optional deterministic gate invoked before non-readOnly MCP tools execute. */
	readonly beforeWriteToolCall?: (call: {
		readonly server: string;
		readonly tool: string;
		readonly args: Readonly<Record<string, unknown>>;
	}) => McpWriteGateDecision | Promise<McpWriteGateDecision>;
};
```

> **双栖解耦关键点**：`JeheeMcpServerSpec.transport` 在跨平台层仅包含 `"http"` 与通用工厂 `"custom"`；本地 `node-stdio.ts` 提供辅助函数 `stdioMcpServer({ name, command, args, cwd, env })` 返回 `{ kind: "custom", create: () => new StdioTransport(...) }`。这样 `JeheeHost` 与 `worker.ts` 完全不接触 `StdioTransport`。

---

## 5. 风险、权衡与验收标准（Verification & Risks）

### 5.1 风险与缓冲
1. **依赖门禁与打包体积**：`apps/jehee/package.json` 新增同仓内部依赖 `"@earendil-works/pi-mcp": "1.5.2"`，需同步更新 `package-lock.json`（若需要）并通过 `check-worker-bundle.ts` 校验——同时在 `check-worker-bundle.ts` 中显式禁止 `node:child_process` 与 `cross-spawn` 进入 Worker 产物。
2. **Base64 误判防护**：`blob-vault.ts` 仅对明确匹配附件结构（含 `base64` / `blob` 字段且非纯文本 MIME）或超长合法 Base64 二进制块启用句柄替换，对 `text/calendar`（ICS）、`text/plain`、`application/json` 自动解码或保留可读文本，避免遮挡模型需要阅读的正文信息。

### 5.2 Slice 4 验收门禁清单（已全部达成，详见 [Eval-0001](../evals/0001-mcp-exposure-and-blob-postmortem.md) 与 [Audit-0002](../evals/0002-adr-0006-to-0009-gate-audit-and-postmortem.md)）
- [x] `npm run check`（Biome + `tsc --noEmit` + `check-worker-bundle`）零错误通过，且 Worker 包（经 `Audit-0002` `platform: "browser"` 加固后为 `1861.6 KiB`）不含保留的 `node:sqlite`、`node:child_process`、`stdio.ts` 与 `cross-spawn`。
- [x] 资源工具三件套（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`）与 `jehee.mcp.resource_read` 子 Span 完整对齐，并在 `eager` 与默认 `deferred + tool_search` 双模式下通过单测验证（含五类失败根因分类器全 5 桶测试）。
- [x] Cucumber BDD（`features/mcp-connector.feature`）通过确定性内存/本地传输验证：
  1. 同时挂载多个 MCP 实例时，`deferred` 模式初始仅展示 `mcp_servers` 摘要，模型通过 `tool_search` 按需加载目标工具并完成调用；
  2. PALE 风格的乐观锁冲突（`stale_version` 含 `current_version`）完整透传给模型，模型可读取最新版本号在下一轮成功提交；
  3. 跨服务附件搬运（从 Mail 读取大 PDF + ICS -> 解码导入 Calendar -> 通过 `$jehee_blob` 句柄将原 PDF 无损写入 Calendar 附件），接收端 `sha256` 100% 一致且主对话历史不含原始长 Base64 串；
  4. `beforeWriteToolCall` 门控可拦截非只读工具并返回需要用户确认的明确提示，而只读工具（`readOnlyHint: true`）直接放行。
- [x] 提供可独立运行的 `evals/mcp-exposure-eval.ts` 脚本并归档 [Eval-0001](../evals/0001-mcp-exposure-and-blob-postmortem.md)：支持一键在模拟多 App（70 注册工具）与真实模型（`JEHEE_EVAL_LIVE=1`）上跑出 `eager` vs `deferred` 及附件消融对比报告与失败样本 Span 复盘。
