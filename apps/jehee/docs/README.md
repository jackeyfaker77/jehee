# Jehee 工程文档与标准开发流程

Jehee 是基于 `@earendil-works/pi-durable` 构建的 **7×24 常驻个人伙伴型 Bot（Always-on Personal Colleague）**，遵循 **「产品体验驱动、薄补偿层、厚承载层、记忆可插拔」** 的工程原则。

> **核心定位声明**：我们是为了做一个真正能长期托付日常与工程事务的 **Bot 产品** 而构建 Jehee；专项评测（Eval）只是产品主体成型后，用来横向优选可替换部件（如不同记忆策略）的辅助工具之一，绝不本末倒置。

---

## 1. 标准软件工程流程（PRD → ADR → BDD → 实现 → 门禁）

本项目采用规范化的正向研发闭环，确保每一步“做什么、为什么这么设计、怎么设计、怎么验收”都有据可查：

1. **产品需求对齐（[PRD](./PRD.md)）**
   明确用户真实痛点、核心交互体感、功能板块边界、明确不做的“补偿层”事项，以及垂直交付切片（Slices）顺序。
2. **架构决策立项（[ADR](./adr/)）**
   每个切片或关键设计动工前，先编写 `adr/NNNN-<topic>.md`，固定记录四部分：
   - **Context（背景与约束）**：当前切片要解决什么业务与工程问题？
   - **Why（为什么这么设计 & 淘汰了什么）**：对比备选方案，写明取舍理由。
   - **How（具体怎么设计）**：模块边界、TypeScript 接口签名、状态流向与目录结构。
   - **Verification & Risks（风险与验收标准）**：风险缓冲机制、回退路径与对应的 BDD 验收场景。
3. **可观测性埋点与指标口径锁定（Observability & Metric Dictionary）**
   在编写评测与复杂能力前，先打通父子 Span 决策树（`pi-telemetry`）并锁定统一指标公式，确保任何功能改动与策略切换均可被白盒追踪。
4. **行为驱动规格（BDD + Cucumber）**
   在 `apps/jehee/features/*.feature` 中使用 Gherkin 编写业务可读的可执行验收规格（`Feature / Scenario / Given / When / Then`），覆盖正常流、忙时插话、崩溃恢复与插件替换边界。
5. **垂直切片实现（Vertical Slice Implementation）**
   - 严守上游隔离原则：业务代码仅落在 `apps/jehee/` 内，不直接污染上游 `packages/*`。
   - 严守根仓编码规范（见根目录 [`AGENTS.md`](../../../AGENTS.md)）：仅使用可擦除 TypeScript 语法（Node 24 strip-types 兼容）、顶层静态导入、禁用无依据的 `any`、所有依赖精确锁定版本号。
6. **静态门禁与自动化验收（Check & BDD Gate）**
   运行 Biome 格式/静态检查、TypeScript 类型检查、Worker 边缘打包纯净度检查、依赖精确锁定检查，以及 Cucumber BDD 全量验收测试。
7. **对比评测与五类失败复盘（Comparative Eval & Failure Postmortem）**
   针对工具暴露模式、附件流转、记忆策略等存在取舍空间的部件，基于统一指标口径运行 A/B 对比实验，并将未满分样本导出完整决策树归入标准根因桶。
8. **问题留痕与避坑归档（Mandatory Issue Traceability）**
   每个切片在开发、门禁排查或真机实测中遇到的**所有非平凡缺陷、上游基座契约坑（如 `pi-durable` / `pi-ai` / Provider 网关约束）与评测失败轮次**，必须在切片收口前留痕归档至 `apps/jehee/docs/evals/NNNN-*-postmortem.md` 并登记到本索引，固定包含四要素：**现象与报错、根因定位、修复落点、防复发规则**。

---

## 2. 文档总索引

### 产品文档
- **[PRD.md — Jehee 产品需求文档](./PRD.md)**：产品愿景、四大核心板块、非目标边界与分阶段交付路线图。

### 架构决策记录（ADR）

| 编号 | 标题 | 状态 | 日期 | 摘要 |
| :--- | :--- | :--- | :--- | :--- |
| [ADR-0001](./adr/0001-foundation-and-repo-isolation.md) | 基座选型（`@earendil-works/pi-durable`）与上游源码隔离策略 | Accepted | 2026-11-18 | 确立从 `earendil-works/pi` Fork 构建 `jehee`，采用 `apps/jehee` Workspace 物理隔离上游源码、防误推双远端配置及薄胶水层隔离 Experimental API。 |
| [ADR-0002](./adr/0002-host-skeleton-and-bdd-cucumber.md) | 最小常驻宿主骨架（`JeheeHost`）与 BDD + Cucumber 验收体系设计 | Accepted | 2026-11-18 | 设计 Slice 1 宿主内核、可热插拔 `MemoryProvider` 防腐接口，以及基于 `@cucumber/cucumber` + Node 24 原生 TS + `fauxProvider` 的确定性 BDD 验收架构。 |
| [ADR-0003](./adr/0003-cloud-topology-and-channel-gateway.md) | 双栖云拓扑（Cloudflare DO + InstaBox Free）与平台无关渠道网关（Telegram 首发） | Accepted | 2026-11-18 | 确立本地/CF DO 双栖控制面 + InstaBox 免费单机多 Worktree 云工坊拓扑；实现平台无关 `ChannelGateway`（白名单、防抖合并、Staging 锁、跨平台共用会话）与零依赖纯 `fetch` Telegram 适配器。 |
| [ADR-0004](./adr/0004-instabox-cloud-workshop.md) | InstaBox 免费版云工坊板块（按需唤醒、`/data` 多 Worktree 隔离与后台协同治理） | Accepted | 2026-11-18 | 基于纯 `fetch` 对接 InstaBox OpenAPI v1，实现免费单机透明唤醒、`/data/jehee/worktrees` Git Worktree 隔离、仅继承 Core 记忆的后台子会话及跨渠道完工主动回推。 |
| [ADR-0005](./adr/0005-runtime-entrypoints-and-opencode-go.md) | 双栖真机运行入口（本地 CLI / Telegram 轮询 + Cloudflare DO）与 OpenCode Go 模型装配 | Accepted | 2026-11-18 | 纯化 `JeheeHost` 跨平台内核，原生接入 `opencode-go` 模型目录，交付本地 `bin.ts`（`models`/`chat`/`telegram`）与 Cloudflare `worker.ts` + `wrangler.jsonc` 部署入口及边缘打包门禁。 |
| [ADR-0006](./adr/0006-nonblocking-telegram-polling-and-cli-boundary.md) | Telegram 本地长轮询非阻塞两阶段入站与本地 CLI 同步边界 | Accepted | 2026-11-18 | 将 `ChannelGateway` 拆分为有序毫秒级准入 `admit` 与后台结算 `settled`，打通本地 Telegram 轮询下的连发防抖、忙时实时 `steer` 插话与 `/stop` 紧急中止，同时明确本地 CLI 保持精简同步交互。 |
| [ADR-0007](./adr/0007-mcp-connector-skeleton-and-eval.md) | 双栖 MCP 连接器骨架、Trace 可观测性与暴露策略对比 Eval | Accepted | 2026-11-18 | 打通 `JeheeHost` 父子 Span 决策树与标准指标字典；基于 `@earendil-works/pi-mcp` 与 `tool_search` 构建双栖多实例 MCP 连接器、资源三工具与大附件句柄暂存，并落地 `eager` vs `deferred` 对比 Eval 与五类失败复盘。 |
| [ADR-0008](./adr/0008-write-approval-and-quiet-governance.md) | 确定性写操作人工确认闭环与主动打扰静默门控（Slice 5A） | Accepted | 2026-11-18 | 基于 SQLite `ApprovalDoc` 与 SHA-256 业务参数指纹实现零阻塞单次写操作审批票据（打通 Telegram 内联按钮 `callback_query` 与 `/approve`、`/reject`），并落地静默时段、忙时让路、频控冷却与 `[SILENT]` 暂存治理。 |
| [ADR-0009](./adr/0009-external-coding-agent-workshop-gateway.md) | 工坊升级为双执行面外部 Coding Agent 网关（Slice 5B） | Accepted | 2026-11-18 | 抽象跨平台 `WorkshopExecutionBackend`（云端 InstaBox + 本机 Git Worktree），内置 `pi`、`opencode`、`antigravity` (`agy`)、`claude`、`codex` 与自定义驱动器，实现后台 PID 轮询与确定性 Git Diff 验收回执。 |
| [ADR-0010](./adr/0010-atomic-memory-and-eval.md) | 可插拔持久化原子记忆插件（L1 Core 一页纸 + 按需检索 + `/memory`）与 `Eval-0002`（Slice 5C-1） | Accepted | 2026-11-24 | 基于 `pi-durable` `MemoryDoc` 实现 100% 双栖可移植的原子记忆存储、低频 L1 Core 立即刷新、中英关键词/别名/时间检索与 `sourceEntryId` 溯源、软删除墓碑及 `/memory` 确定性指令，并规划 `Eval-0002` 对比评测。 |
| [ADR-0011](./adr/0011-background-memory-consolidation.md) | 后台空闲/定时异步记忆整理（去重、冲突消解与隐性事实提炼）（Slice 5C-2） | Accepted | 2026-11-24 | 基于 `MemoryConsolidationDoc` 增量水位线、`pi-durable` 单活空闲休眠任务与严格 JSON Patch 校验器，实现零重复扫描的隐性事实提炼、重复合并、冲突消解（墓碑可逆恢复）及 `/memory consolidate` 确定性指令。 |
| [ADR-0012](./adr/0012-portable-context-memory-snapshot.md) | 上下文与记忆的可移植快照（Portable Export / Import）（Slice 5C-3） | Accepted | 2026-11-24 | 定义 Harness/模型无关的 `jehee.portable.snapshot` v1 格式（无损 JSON + 人类/外部 Agent 可读 Markdown），实现 `JeheeHost` 事务级 `exportPortableSnapshot` / `importPortableSnapshot`（`merge`/`replace` 双模式）、CLI `export`/`import` 与 `/memory export` 白名单指令。 |
| [ADR-0013](./adr/0013-seamless-window-handoff.md) | 单窗口无感换窗（Seamless Handoff）、换窗前记忆落盘与底层原话回查（Slice 5D） | Accepted | 2026-11-24 | 基于 `pi-durable` 原生 `CompactionTask` + `Conversation.reset(handoff)` 实现甜点水位自动压缩与 `/handoff` 整窗交接，通过 `beforeCompact` 先落盘 5C-2 原子记忆，并提供跨换窗 `history_search` 原话回查工具与 `Eval-0003` 双轨评测。 |
| [ADR-0014](./adr/0014-proactive-routines-and-clock.md) | 主动定时提醒、周期例行任务、尾部本地时钟锚点、持久化投递路由与 DO Alarm 守护（Slice 6A） | Accepted | 2026-11-25 | 基于单活 `RoutineSchedulerTask` + `RoutineWakeSignal` 与 `RoutineDoc` / `LastRouteDoc` 实现 `once`/`daily`/`weekly`/`interval` 定时任务、`direct_notify` 零 Token 直推与 `agent_prompt` `[SILENT]` 抑制、用户侧不可变本地时钟锚点、`/routines` 指令及 Cloudflare DO `alarm()` `ctx.waitUntil` 守护。 |
| [ADR-0015](./adr/0015-multimodal-channels-and-web-fetch.md) | Telegram 多模态收发通道与防 SSRF 可移植 `web_fetch` 工具（Slice 6B） | Accepted | 2026-11-25 | 扩展 `ChannelAttachment` / `downloadFile` / `sendPhoto` / `sendDocument` 多模态契约与 `ChannelGateway` 附件下载、防抖保留与 `ImageContent` 多段入站；实现双栖零 Node 依赖且覆盖 IPv4/IPv6/重定向的防 SSRF 只读 `web_fetch` 扩展与工坊子会话隔离。 |
| [ADR-0016](./adr/0016-resilient-pa-ops-and-outbound-media.md) | 静默时段持久化自动补发、MCP 自愈重连、运行时模型热切与出站富媒体交付（Slice 6C） | Accepted | 2026-11-26 | 落地会话级 `HeldNotificationsDoc` 与单活调度器静默窗口结束自动补发、`/mcp` 脱敏失败诊断与 `/mcp reconnect` 原子热替换、`RuntimeModelDoc` 持久化 `/model` 热切，以及直连 `McpBlobVault` 的可移植 `send_media` 出站富媒体扩展与工坊子会话隔离。 |

### 评测结论与失败复盘记录（Evals & Postmortems）

| 编号 | 标题 | 关联 ADR | 日期 | 核心结论摘要 |
| :--- | :--- | :--- | :--- | :--- |
| [Eval-0001](./evals/0001-mcp-exposure-and-blob-postmortem.md) | MCP 工具暴露策略与二进制附件句柄对比评测及失败复盘 | [ADR-0007](./adr/0007-mcp-connector-skeleton-and-eval.md) | 2026-11-18 | `opencode-go/deepseek-v4.1-flash` 真机与离线双轨实测：70 工具拓扑下默认 `deferred + $jehee_blob:` 相比基线降低 **95.2% 输入 Token**（`492,557 -> 23,648`）、**96.0% 真实账单**（`\$0.03791 -> \$0.00152`）与 **90.6% 耗时**（`342.1s -> 32.1s`），消除 20 KiB 截断诱发的思考螺旋与 `integrity_mismatch`。 |
| [Audit-0002](./evals/0002-adr-0006-to-0009-gate-audit-and-postmortem.md) | ADR-0006 至 ADR-0009 验收门禁补齐记录与根因复盘 | [ADR-0006](./adr/0006-nonblocking-telegram-polling-and-cli-boundary.md)–[0009](./adr/0009-external-coding-agent-workshop-gateway.md) | 2026-11-24 | 补齐 06–09 轮询守护、默认 `deferred` 资源发现、`approved` 重启消费、`/reject`/`/flush`/忙时与冷却治理、6 驱动首轮参数与 `followUp`/`steer` 全量验证（`33/33` 单测、`32/32` BDD），并修复 Worker 包 `node:child_process` 残留（`1861.6 KiB`）、Windows `stopJob` `EBUSY` 竞态及 `info/exclude` 隔离。 |
| [Eval-0002](./evals/0003-memory-provider-eval-and-postmortem.md) | 热插拔持久化原子记忆插件（`StaticCore` vs `5C-1` vs `5C-2`）双轨三臂对比评测 | [ADR-0010](./adr/0010-atomic-memory-and-eval.md)–[0011](./adr/0011-background-memory-consolidation.md) | 2026-11-24 | `opencode-go/deepseek-v4.1-flash` 真机与离线双轨实测：`StaticCore` `14.3%` -> `AtomicMemory (5C-1)` `71.4%`（离线 `57.1%`）-> `5C-2 Consolidation` `100%`（单次全程账单 `\$0.00314`、`merged=1/superseded=1/skipped=0`），并借真机修复 `opencode-go` `MissingSessionID` 与替换旧值复述问题。 |
| [Postmortem-0004](./evals/0004-cloudflare-workers-fetch-postmortem.md) | Cloudflare Workers 首次上线 `fetch` 非法调用故障复盘 | [ADR-0003](./adr/0003-cloud-topology-and-channel-gateway.md)–[0005](./adr/0005-runtime-entrypoints-and-opencode-go.md) | 2026-11-24 | 排查线上 Telegram Webhook `500`（`TypeError: Illegal invocation`），修复 `TelegramTransport` 与 `InstaBoxClient` 将 `globalThis.fetch` 作为实例字段直接调用的问题并补充严格 `this === undefined` 回归单测。 |
| [Eval-0003](./evals/0005-handoff-eval-and-postmortem.md) | 单窗口无感换窗（`No-Handoff` vs `Seamless Handoff` 5D）双轨对比评测与复盘 | [ADR-0013](./adr/0013-seamless-window-handoff.md) | 2026-11-24 | `opencode-go/deepseek-v4.1-flash` 真机与离线双轨实测：`No-Handoff` `50%`（离线 `33.3%`，活跃窗口涨至 `3613` tok）-> `Seamless Handoff` `100%`（活跃窗口压降至 `778` tok，`-78.5%`，换窗重启后经 `history_search` 零失真逐字回查 `entryId=7` 原话），并归档 6 项问题留痕。 |
| [Eval-0004](./evals/0006-prod-atomic-memory-switch-eval.md) | 线上 Worker 记忆切换前后对比评测（`static-core` -> `atomic + idle 10m`） | [ADR-0010](./adr/0010-atomic-memory-and-eval.md)–[0013](./adr/0013-seamless-window-handoff.md) | 2026-11-24 | 真机对比 `wrangler.jsonc` 切换前后：评分 `50% -> 100%`，换窗冷重启后从 `5` 次暴力 `history_search` 降至 `2` 次精准 `memory_search`，首轮工具 Schema 增量 `+785` tok、全程账单 `+\$0.00085`，确认 DO 10 分钟空闲 Alarm 休眠收口 `active: false` 后完成线上发布（`bbc62ecb`）。 |
| [Audit-0007](./evals/0007-slice-6a-6b-audit-and-postmortem.md) | Slice 6A + 6B 联合集成审计、全量门禁实测与 4 项审查缺陷复盘 | [ADR-0014](./adr/0014-proactive-routines-and-clock.md)–[0015](./adr/0015-multimodal-channels-and-web-fetch.md) | 2026-11-25 | 汇总 Slice 6A（主动 Routines + 本地时钟锚点 + DO Alarm 守护）与 Slice 6B（Telegram 多模态收发 + 防 SSRF `web_fetch`）全量门禁、单测、BDD 与四项离线 Eval 结果，并按四要素归档审校阶段捕获的 4 项真实缺陷（IPv6 SSRF 绕过、图片 MIME 优先级与 SVG 路由、冷启动提前 `resume` 丢提醒、瞬态出站异常击穿单活调度器）。 |
| [Audit-0008](./evals/0008-slice-6c-audit-and-postmortem.md) | Slice 6C 联合集成审计、全量门禁实测与 5 项缺陷复盘 | [ADR-0016](./adr/0016-resilient-pa-ops-and-outbound-media.md) | 2026-11-27 | 汇总 Slice 6C（持久化静默自动补发、`/mcp` 自愈重连、持久化 `/model` 热切与 `send_media` 出站富媒体）全量门禁、单测、BDD 与四项离线 Eval 实测，并按四要素留痕 Windows `git worktree` `MAX_PATH` 限制、MCP 凭据脱敏补漏、`McpBlobVault`/`send_media` 安全加固、`RoutineSchedulerTask` 事务级唤醒竞态与 Windows `share` 工作树清理跨越 NTFS Junction 误删根工作区上游包恢复复盘。 |

---

## 3. 可观测性、标准指标口径与失败复盘规范

### 3.1 Trace 决策树分层（基于 `@earendil-works/pi-telemetry`）

一次外部请求或任务对应该回合的一条完整 `StoredTrace`，父子 Span 结构固定为：
- `pi.durable.submit`（根 Span：记录 `conversation.id`、`submission.id`、`answer.entry_id`）
  - `pi.durable.phase`（`task.name="pi.generation"`：每轮模型推理阶段）
    - `pi.ai.request`（记录 `model`、`stop`、`usage.input`、`usage.output`、`usage.cache_read`、`usage.cache_write`、`cost.total` 及首字事件 `pi.ai.first_chunk`）
  - `pi.durable.phase`（`task.name="pi.tool"`：每次工具执行，记录 `tool.name`、`tool.call_id`、`outcome`）
    - `jehee.mcp.call` / `jehee.mcp.resource_read`（MCP 子 Span：记录 `server`、`tool`/`uri`、`mcp.status`、`is_error`、`blob.offloaded_bytes`、`gate.action`）

### 3.2 统一指标口径（Metric Dictionary）

注意 `@earendil-works/pi-ai` 中 `usage.input` 表示**未命中缓存的新增输入 Token**，所有统计与 Eval 报告统一按以下公式计算：
- `prefill_tokens = usage.input + usage.cache_read + usage.cache_write`
- `cache_hit_rate = usage.cache_read / prefill_tokens`（当 `prefill_tokens === 0` 时记为 `0`）
- `post_warmup_cache_hit_rate`：仅统计同一任务第 2 轮及之后的 `pi.ai.request` 的 `cache_read / prefill_tokens`，排除首轮冷启动影响，用于检测前缀破坏 Bug
- `llm_turns`：该 Trace 内 `pi.ai.request` Span 总数
- `tool_calls`：该 Trace 内 `task.name === "pi.tool"` 的 Span 总数（其中单列 `tool_search_calls` 与 `mcp_calls`）
- `ttft_p50_ms`：`pi.ai.first_chunk` 相对请求起点的延迟中位数
- `wall_time_ms`：根 Span 起止耗时（毫秒）
- `cost_usd`：所有 `pi.ai.request` 的 `cost.total` 之和
- 质量门禁指标：`pass_rate`（全门禁通过率）、`rubric_score`（分步得分均值）、`error_recovery_rate`（遇到 `stale_version` 等可恢复报错后最终提交成功的比例）、`boundary_violations`（越权或未确认即触发高风险写操作的次数）

### 3.3 五类失败复盘根因桶（Failure Root-Cause Taxonomy）

任何未达到满分的 Eval 样本均须自动产出复盘视图（`renderTrace` 决策树 + 关联的工具调用详情 + 状态快照差异），并归入以下 5 类标准根因之一：
1. `discovery_miss`：`tool_search` 未检索出目标工具 -> 优化工具描述或摘要目录；
2. `arg_or_version_error`：工具参数或乐观锁版本号传错且未能自愈 -> 检查报错结构透传或 Schema 归一化；
3. `payload_overflow`：大输出或二进制附件挤占窗口导致信息丢失 -> 调整输出截断或 Blob 句柄阈值；
4. `boundary_violation`：未经用户确认执行不可逆写操作或越权访问 -> 加厚确定性 `beforeWriteToolCall` 门控；
5. `model_reasoning`：工具、报错与上下文均完整准确，纯属当前模型推理失误 -> 不堆砌手写补偿规则，保留作为换强模型的代际增益对照题。

---

## 4. 后续计划立项队列

- 暂无待立项核心切片（Slice 1–6C 覆盖 PRD 全部四大功能板块及主动例行任务、多模态双向收发、防 SSRF 网页抓取、静默持久化自动补发、MCP 自愈重连与运行态 `/model` 热切，后续按真实 7×24 使用反馈迭代语音转写或新渠道适配器）。
