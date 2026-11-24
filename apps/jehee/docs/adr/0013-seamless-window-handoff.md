# ADR-0013：单窗口无感换窗（Seamless Handoff）、换窗前记忆落盘与底层原话回查（Slice 5D）

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-24
- **关联需求**：[PRD v1.3 — 板块一 & 板块三](../PRD.md)、[ADR-0010](./0010-atomic-memory-and-eval.md)、[ADR-0011](./0011-background-memory-consolidation.md)、[ADR-0012](./0012-portable-context-memory-snapshot.md)

---

## 1. 背景与问题（Context & Problem）

截至 Slice 5C-3，Jehee 已具备可插拔原子记忆、后台异步整理与可移植快照能力，但单入口主对话仍缺少**单窗口上下文水位治理（Seamless Handoff）**：

1. **大窗模型的“注意力甜点”与成本漂移**：主流模型物理上下文窗口普遍在 `128K–1M` tokens，`pi-durable` 默认的 `CompactionTask` 仅在逼近物理上限（`contextWindow - reserveTokens - backgroundTokens`）时触发。在 7×24 单入口长期对话中，单窗容易累积到十万级 token，导致注意力稀释、响应变慢与账单飙升。
2. **直接压缩存在记忆断层风险**：如果旧对话前缀直接被压缩摘要取代，尚未经过空闲整理沉淀的隐性事实或冲突更新可能随压缩细节一起流失。
3. **压缩/换窗后原话回查缺口**：Slice 5C-1 已在每条原子记忆上保留了 `sourceEntryId`，但模型尚无确定性只读工具跨越 `CompactionEntry` / `ResetEntry` 头标记去回查底层 SQLite 中的逐字原话。

---

## 2. 备选方案对比（Alternatives Considered）

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：自建自定义对话分片表，每次换窗新建一条 `Conversation`** | 物理隔离彻底 | 破坏 `JeheeHost` 单根会话模型，需额外维护跨 Conversation 路由、幂等请求号映射与提交顺序，违背“薄补偿层，厚承载层”原则。 |
| **方案 B：仅依赖 `pi-durable` 默认物理上限压缩，不做甜点门控与原话回查** | 零开发量 | `200K` 模型要到 `~150K` 才压缩，远超注意力与成本甜点；压缩前不会先落盘 5C-2 原子记忆；模型也无法按 `sourceEntryId` 回查被压掉的逐字原话。 |
| **方案 C（最终采用）：复用 `pi-durable` 原生 `CompactionTask`（自动甜点压缩）+ `Conversation.reset(handoff)`（显式 `/handoff` 整窗交接）+ `CompactionTask.beforeCompact` 自动先跑 5C-2 记忆整理 + 只读 `history_search` 底层原话回查** | 单根会话 ID 永不变、前端聊天框 100% 无感；压缩前强制落盘记忆零流失；底层 SQLite 保留全量不可变原话并打通 `sourceEntryId` 证据链；与 [ADR-0012](./0012-portable-context-memory-snapshot.md) 可移植快照的 `CompactionEntry`/`ResetEntry`（`role: "summary"`）及 `active`/`full` 双视图天然兼容；100% Web/Edge 可移植 | 需实现纯 TS 活跃窗口 Token 估算、甜点水位触发、交接摘要生成（带 `sessionId`）与跨换窗原话检索工具。 |

---

## 3. 决策与核心依据（Why — 为什么这么设计）

### 3.1 自动无感甜点压缩（`CompactionTask`）与显式整窗交接（`reset(handoff)`）分工互补
- **自动无感压缩（`afterRun` 甜点监测 → `root.compact()`）**：
  - 每次根会话 `afterRun` 完成后估算当前活跃窗口 Token（优先以最近一条带 `usage` 的助手消息实际总 Token 为锚点 + 后续消息字符估算，不依赖无 source 导出的 `@earendil-works/pi-ai/utils/*`）。
  - 当活跃 Token 达到 `sweetSpotTokens`（默认 `48_000`，`0` 关闭）且存在足够可切分前缀且当前无在途压缩任务时，自动发起非阻塞 `root.compact(...)`，原样保留最近 `keepRecentTokens`（默认 `12_000`）上下文并将更早内容折叠为 `CompactionEntry` 摘要，在下一轮边界无缝生效，不打断用户当前讨论。
- **显式整窗交接（`host.handoffWindow()` / `/handoff [focus]`）**：
  - 当用户主动切换大话题或希望彻底清空当前窗口噪音时，生成一份聚焦目标、进展、待办与可选 `focus` 的紧凑交接简报（`Handoff Brief`），通过 `root.reset(handoffBrief, context)` 写入 `ResetEntry` 头标记，瞬间将活跃窗口重置为「L1 Core 一页纸 + 交接简报」，前端单入口对话完全连续。

### 3.2 换窗/压缩前自动触发 5C-2 记忆整理（零记忆流失）
- 在 `jehee.context` 扩展中注册 `hook(CompactionTask, { beforeCompact })`，并在 `host.handoffWindow()` 执行 `root.reset()` 之前同样触发：
  - 若当前挂载了 `AtomicMemoryProvider` 且 `consolidateBeforeHandoff !== false`，先执行一次增量 `executeMemoryConsolidation`（`trigger: "manual"`），确保即将移出活跃窗口的隐性事实、重复合并与冲突消解全部落入 `MemoryDoc`（`scope: "session"`），换窗后 L1 Core 与 `memory_search` 无损延续。
  - 若配置了独立摘要模型 `JEHEE_HANDOFF_MODEL`，`beforeCompact` 直接用该模型生成摘要并返回 `{ summary }`（显式传确定性 `sessionId` 与 `cacheRetention: "none"`）。

### 3.3 底层原话随时回查（`history_search` + `host.lookupHistory`）
- `pi-durable` 的 `CompactionEntry` 与 `ResetEntry` 只移动活跃窗口起点，绝不删除历史条目；`root.entries()` 始终能读到全量不可变原话。
- 在 `jehee.context` 扩展中提供只读工具 `history_search`（工坊子会话通过 `JEHEE_CONTEXT_EXTENSION_HANDLE` 显式移除，不污染工坊）：
  - **按 `entryId` 精准定位**：直接承接 Slice 5C-1 记忆条目中的 `sourceEntryId`，返回该条原话及前后可选 `contextWindow`（默认 `1`）条邻近消息；
  - **按 `query` 关键词检索**：复用中英分词打分跨越全部历史换窗边界倒序扫描 `UserEntry` 与 `AssistantEntry` 原话，返回命中的逐字片段与 `entryId`。

### 3.4 状态持久化与白盒可观测性
- 新增 `HandoffDoc`（`kind: "jehee.context.handoff"`, `scope: "session"`, `checkpointWhen: () => false`），持久化 `totalCompactions`、`totalManualHandoffs`、`lastHandoffAtMs`、`lastTokensBefore`、`lastTokensAfter`、`lastHandoffKind` 与 `lastSummaryPreview`。
- `ChannelGateway` 新增白名单指令 `/handoff [focus]`，并在 `/status` 中补充 `context: <activeTokens>/<sweetSpotTokens> tok (handoffs=<N>)`。
- 新增 `JEHEE_CONTEXT_TELEMETRY_SCHEMA`（`jehee.context.handoff`、`jehee.context.history_search`），直接融入现有 Trace 决策树。

---

## 4. 具体设计方案（How — 怎么设计）

### 4.1 模块结构演进

```text
apps/jehee/
├── src/
│   ├── context/
│   │   ├── handoff.ts        # 纯 TS：Token 估算、甜点判定、交接 Prompt 构造、跨窗原话检索评分与 /handoff 回复格式化
│   │   ├── durable-store.ts  # pi-durable HandoffDoc（scope: "session", checkpointWhen: () => false）
│   │   └── extension.ts      # jehee.context 扩展：CompactionTask.beforeCompact 钩子、history_search 工具与 Handoff 执行器
│   ├── core/
│   │   └── host.ts           # 接入 HandoffPolicy、afterRun 甜点自动压缩、handoffWindow / compactWindow / lookupHistory / getContextStatus
│   ├── channels/
│   │   └── gateway.ts        # 接入 /handoff [focus] 白名单指令，并在 /status 展示活跃窗口水位与换窗计数
│   ├── telemetry/
│   │   └── recorder.ts       # 新增 JEHEE_CONTEXT_TELEMETRY_SCHEMA（jehee.context.handoff / jehee.context.history_search）
│   ├── workshop/
│   │   └── extension.ts      # builtin 工坊子会话移除 JEHEE_CONTEXT_EXTENSION_HANDLE
│   └── runtime/
│       ├── config.ts         # 解析 JEHEE_HANDOFF_SWEET_SPOT_TOKENS、JEHEE_HANDOFF_KEEP_RECENT_TOKENS、JEHEE_HANDOFF_CONSOLIDATE、JEHEE_HANDOFF_MODEL
│       └── node.ts           # 装配 JeheeHost.handoff
├── worker.ts                 # Cloudflare DO 同步透传 handoff 配置
├── evals/
│   └── handoff-eval.ts       # Eval-0003：NoHandoff vs SeamlessHandoff 离线 + JEHEE_EVAL_LIVE=1 真机对比评测
├── features/
│   ├── seamless-handoff.feature
│   └── steps/
│       └── handoff.steps.ts
└── test/
    └── handoff.test.ts
```

### 4.2 新增环境变量（`.env` / `wrangler.jsonc`）
- `JEHEE_HANDOFF_SWEET_SPOT_TOKENS`：单窗口注意力甜点上限（默认 `48000`；设为 `0` 关闭自动甜点压缩）；
- `JEHEE_HANDOFF_KEEP_RECENT_TOKENS`：自动压缩时原样保留的最近上下文预算（默认 `12000`）；
- `JEHEE_HANDOFF_CONSOLIDATE`：换窗/压缩前是否自动先执行 5C-2 记忆整理（默认 `"true"`；设为 `"false"` 关闭）；
- `JEHEE_HANDOFF_MODEL`：可选独立换窗摘要模型（如 `opencode-go/deepseek-v4.1-flash`，缺省复用 `JEHEE_MODEL`）。

---

## 5. 风险、权衡与验收标准（Verification & Risks）

### 5.1 风险与缓冲
- **换窗摘要调用缺 `sessionId` 被 `opencode-go` 拒绝**：所有直接调用 `models.completeSimple` 的换窗摘要均显式传入确定性 `sessionId: "jehee-handoff-<conversationId>"`、`cacheRetention: "none"` 与 `telemetry: span`（遵循 `apps/jehee/AGENTS.md`）。
- **低阈值下重复触发自动压缩**：在 `afterRun` 检查 `LiveDoc.compactions.length === 0` 且仅当 `activeTokens >= sweetSpotTokens` 且存在可切分历史前缀时触发；压缩完成后 `activeTokens` 回落至 `keepRecentTokens + summary`，不会死循环。
- **工坊子会话隔离**：内置工坊子会话显式移除 `JEHEE_CONTEXT_EXTENSION_HANDLE`，防止子任务读取主会话聊天原话或干扰主窗口压缩。
- **可移植快照天然兼容**：由于直接复用 `pi-durable` 原生 `CompactionEntry` 与 `ResetEntry`，`exportPortableSnapshot` 自动将换窗摘要导出为 `role: "summary"`，同时支持 `active`（当前甜点窗口）与 `full`（全量底层原话）双视角导出。

### 5.2 Slice 5D 验收门禁清单
- [x] `apps/jehee` `npm run check`（Biome + `tsc --noEmit` + `check:worker-bundle`）与根仓 `npm run check` 零错误通过。
- [x] 单元测试（`test/handoff.test.ts`）覆盖：活跃窗口 Token 估算、甜点判定、交接摘要与 `root.reset(handoff)` 窗口压降、换窗前自动记忆整理、跨越多次换窗的 `entryId` / 关键词底层原话检索、`HandoffDoc` SQLite 重启持久化、与 `exportPortableSnapshot` 的兼容联动及环境变量校验。
- [x] Cucumber BDD（`features/seamless-handoff.feature`）端到端验证：
  1. 活跃窗口越过 `sweetSpotTokens` 甜点上限后自动先整理记忆再无感压缩，后续对话上下文 Token 明显下降且用户无感；
  2. 主人发送 `/handoff [focus]` 生成交接简报并重置活跃窗口，`/status` 显示最新窗口水位与换窗计数，陌生人发 `/handoff` 被白名单拒绝；
  3. 换窗后通过 `history_search` 按 `sourceEntryId` 与关键词仍可精准回查被压缩前的逐字原话，且工坊子会话不暴露 `history_search`。
- [x] 完成 `Eval-0003`（`eval:handoff`，离线确定性 + `JEHEE_EVAL_LIVE=1` 真模型实测），将结果与全部问题留痕归档至 `apps/jehee/docs/evals/0005-handoff-eval-and-postmortem.md` 并登记索引。
