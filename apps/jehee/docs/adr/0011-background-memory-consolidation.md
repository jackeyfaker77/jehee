# ADR-0011：后台空闲/定时异步记忆整理（去重、冲突消解与隐性事实提炼）（Slice 5C-2）

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-24
- **关联需求**：[PRD v1.3 — 板块三 & Slice 5C-2](../PRD.md)、[ADR-0010](./0010-atomic-memory-and-eval.md)

---

## 1. 背景与问题（Context & Problem）

Slice 5C-1（[ADR-0010](./0010-atomic-memory-and-eval.md)）交付了确定性原子记忆存储（`MemoryDoc`）、`memory_save` / `memory_search` / `memory_forget` 工具与 `/memory` 指令。在实际 7×24 长期共事场景中，纯会话内显式写入仍存在三类缺口：

1. **隐性事实与偏好流失**：用户在日常对话中随口提及重要事实或工作偏好（例如“下周三飞北京见王总，以后周报用 bullet list 发我”），但未明说“记住”。主对话为保持稀疏（Sparse）与低延迟，不宜每轮额外多跑一次写记忆工具。
2. **近似重复条目随时间堆积**：跨周对话中容易沉淀多条语义重复的原子记忆（如两条不同措辞的“统一使用 pnpm”），稀释检索排序并占用 L1 Core 额度。
3. **新旧事实冲突未自动消解**：当用户搬家、更换项目负责人或调整习惯时，若未显式调用 `memory_forget`，新旧两条矛盾事实会同时留在活跃集合中误导后续检索。

---

## 2. 备选方案对比（Alternatives Considered）

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：每轮对话结束同步调一次 LLM 写记忆** | 延迟最低 | 每轮都额外消耗一次模型调用、拖慢前台体感；连发多句日常闲聊时频繁产生噪音写入，且每轮改写 L1 Core 会击穿 KV-Cache。 |
| **方案 B：让后台整理 LLM 直接全量重写整个 Markdown / `MemoryDoc`** | Prompt 简单 | 非确定性覆盖风险极高——模型一次幻觉或截断就可能静默抹掉几十条旧记忆，且无法逐条审计与恢复。 |
| **方案 C（最终采用）：增量水位线（`MemoryConsolidationDoc`）+ `pi-durable` 单活空闲休眠任务 + 严格 JSON Patch（`add`/`update`/`merge`/`supersede`/`forget`）+ 确定性事务校验与墓碑保留** | 零重复扫描历史；在本地 Node 与 Cloudflare DO（Alarm 唤醒）均能空闲触发不扰前台；所有去重与冲突替换均保留墓碑，用户随时可用 `/memory restore <id>` 撤销误整理；支持独立廉价整理模型与手动 `/memory consolidate` | 需设计独立的增量水位线文档、结构化 Patch 校验器与单活防抖调度任务。 |

---

## 3. 决策与核心依据（Why — 为什么这么设计）

### 3.1 独立水位线文档（`MemoryConsolidationDoc`）保持 `MemoryDoc` 纯净
- 新增 `scope: "session"` 的 `MemoryConsolidationDoc`，记录 `lastConsolidatedEntryId`（增量扫描水位线）、`lastActivityAtMs`、`scheduledTaskId`、`scheduledForMs` 以及最近一次整理统计与状态。
- 每次整理仅扫描 `lastConsolidatedEntryId` 之后新增的可见用户与助手消息，绝不重复扫描全量历史；整理结果与新水位线在**同一个 `tx.commit` 事务**内提交，确保崩溃或 DO 休眠重启后绝不重复落盘。

### 3.2 严格 JSON Patch + 确定性护栏（绝不全量覆写）
整理模型只允许输出有界 JSON 操作列表（`ConsolidationPlan`），支持的原语限定为五种：
- `add`：从新对话中提炼隐性事实/偏好（自动关联对应对话的 `sourceEntryId`；若与现有活跃记忆归一化内容完全重复则确定性去重跳过）；
- `update`：按 `id` 补充或修正现有条目的表述、关键词、别名或时间区间；
- `merge`：保留 `keepId` 并用合并后的内容更新，将 `dropIds` 全部软删除并记录原因 `merged_into:<keepId>`；
- `supersede`：将过时冲突的 `oldId` 软删除（原因 `superseded_by:<newId>: <reason>`），同时写入新事实 `replacement`；
- `forget`：当用户在近期对话中明确否定旧事实时，软删除 `oldId`。

所有被淘汰条目一律走软删除墓碑（不物理删除），天然支持 `/memory restore <id>` 人工回滚；若某条 `core` 操作超出 `maxCoreChars`，仅跳过该条并记录 `skipped` 警告，不回滚同批其他合法操作；若模型返回非法 JSON，不推进水位线并记录错误状态供下次重试。

### 3.3 双栖单活空闲调度（`pi-durable` Sleeping Task）+ `/memory consolidate` 手动触发
- **空闲自动触发**：当配置 `idleDelayMs > 0`（如 `JEHEE_MEMORY_CONSOLIDATION_IDLE_MS=900000`，默认 `0` 保持显式 opt-in）时，每次主对话 `afterRun` 结束后更新 `lastActivityAtMs` 并确保仅有一个后台 `MemoryConsolidatorTask` 处于 `sleeping` 状态等待至 `lastActivityAtMs + idleDelayMs`。
- **忙时让路与防抖顺延**：定时器到期唤醒时若根会话正 `busy` 或期间又有新消息进来，任务自动重新 `sleeping` 顺延，绝不抢占前台对话；在 Cloudflare Workers 上自动复用 `JeheeSessionDO` Alarm 唤醒，零常驻内存费用。
- **手动确定性触发**：提供 `host.consolidateMemory()` 与 Telegram/CLI 斜杠指令 `/memory consolidate`（受主人白名单保护），立即对增量对话或存量活跃记忆执行一次整理并回报结构化结果。

### 3.4 可选独立整理模型与完整 Trace 观测
- 支持通过 `JEHEE_MEMORY_CONSOLIDATION_MODEL` 指定更低成本的后台整理模型（缺省复用 `defaultModel`）；调用 `models.completeSimple` 时显式设置 `cacheRetention: "none"` 避免污染前台 KV-Cache。
- 新增 `jehee.memory.consolidate` Telemetry Span，完整记录扫描回合数、应用/跳过操作数及各类操作计数，并将后台模型调用 `pi.ai.request` 挂在其子层级下。

---

## 4. 具体设计方案（How — 怎么设计）

### 4.1 模块结构演进

```text
apps/jehee/
├── src/
│   ├── memory/
│   │   ├── contract.ts       # 补充 ConsolidationOp、ConsolidationPlan、MemoryConsolidationState、MemoryConsolidationReport
│   │   ├── consolidator.ts   # 纯 TS：整理 Prompt 构造、严格 JSON Patch 解析校验、确定性应用器（含精确去重与墓碑原因）与报告格式化
│   │   ├── durable-store.ts  # 新增 MemoryConsolidationDoc（scope: "session"）
│   │   ├── atomic-memory.ts  # AtomicMemoryOptions 支持可选 consolidation 配置（idleDelayMs / minNewTurns / model）
│   │   └── bridge.ts         # 注册 MemoryConsolidatorTask（单活空闲休眠任务）、afterRun 触发调度与 executeMemoryConsolidation
│   ├── core/
│   │   └── host.ts           # 新增 consolidateMemory() 与 getMemoryConsolidationState()
│   ├── channels/
│   │   └── gateway.ts        # /memory consolidate 指令与 /memory 巡检附带最近整理状态
│   ├── telemetry/
│   │   └── recorder.ts       # JEHEE_MEMORY_TELEMETRY_SCHEMA 新增 jehee.memory.consolidate Span
│   └── runtime/
│       ├── config.ts         # 解析 JEHEE_MEMORY_CONSOLIDATION_IDLE_MS、JEHEE_MEMORY_CONSOLIDATION_MIN_TURNS、JEHEE_MEMORY_CONSOLIDATION_MODEL
│       └── node.ts           # 装配 AtomicMemoryProvider.consolidation
├── worker.ts                 # Cloudflare DO 同步透传 consolidation 配置
├── evals/
│   └── memory-eval.ts        # 升级为三臂对比：StaticCore vs AtomicMemory (5C-1) vs AtomicMemory + Consolidation (5C-2)
├── features/
│   └── memory-consolidation.feature
└── test/
    └── memory-consolidation.test.ts
```

### 4.2 新增环境变量（`.env` / `wrangler.jsonc`）
- `JEHEE_MEMORY_CONSOLIDATION_IDLE_MS`：空闲多少毫秒后自动触发后台整理（如 `900000` 表示 15 分钟；`0` 或未设置表示仅手动 `/memory consolidate` 触发）；
- `JEHEE_MEMORY_CONSOLIDATION_MIN_TURNS`：自动空闲整理所需的最小新增回合数（默认 `2`，避免单句寒暄频繁触发；手动 `/memory consolidate` 不受此下限限制）；
- `JEHEE_MEMORY_CONSOLIDATION_MODEL`：可选后台整理专用模型（如 `opencode-go/deepseek-v4.1-flash`，未设置时复用 `JEHEE_MODEL`）。

---

## 5. 风险、权衡与验收标准（Verification & Risks）

### 5.1 风险与缓冲
- **整理模型输出非 JSON 或引用不存在的 `id`**：解析器剥离代码块后做严格结构校验，坏 JSON 立即终止且不推进水位线；单个非法操作（如未知 `id` 或超 `maxCoreChars`）计入 `skipped` 而不破坏同批其他有效操作。
- **高频闲聊导致后台任务堆积**：`MemoryConsolidationDoc` 仅维护单一 `scheduledTaskId`，重复回合仅刷新 `lastActivityAtMs` 不新建任务；到期唤醒若未满 `idleDelayMs` 或前台正忙则原任务顺延休眠。
- **误合并或误替换导致记忆丢失**：`merge`、`supersede`、`forget` 全部保留软删除墓碑与来源原因，用户可通过 `/memory restore <id>` 无损恢复。

### 5.2 Slice 5C-2 验收门禁清单
- [x] `npm run check`（Biome + `tsc --noEmit` + `check:worker-bundle`）与根仓 `npm run check` 零错误通过。
- [x] 单元测试（`test/memory-consolidation.test.ts`）覆盖：JSON Patch 解析与围栏剥离、非法 JSON 防御、确定性精确去重、`merge`/`supersede`/`forget` 墓碑与 `/memory restore` 回滚、`maxCoreChars` 越界跳过、水位线增量幂等、以及 `JEHEE_MEMORY_CONSOLIDATION_*` 配置解析（`45/45` 单测全通过）。
- [x] Cucumber BDD（`features/memory-consolidation.feature`）端到端验证（`40/40` 场景、`283/283` 步骤全通过）：
  1. 对话中未显式调用 `memory_save` 的隐性事实与偏好，经整理后自动沉淀至 `MemoryDoc`（带 `sourceEntryId`）并推进水位线，二次触发整理返回 `noop` 零模型调用；
  2. 重复记忆经整理自动 `merge`、新旧冲突事实经整理自动 `supersede`（旧条目从检索消失但可通过 `/memory restore` 恢复）；
  3. 空闲防抖后台整理任务在 `idleDelayMs` 后自动唤醒执行（期间新消息自动顺延），且 Telegram `/memory consolidate` 受主人白名单保护、未授权用户拒绝。
- [x] 升级 `Eval-0002`（三臂对比：`StaticCore` `14.3%` vs `AtomicMemory 5C-1` `57.1%` vs `AtomicMemory + Consolidation 5C-2` `100%`）运行通过并归档至 [0003-memory-provider-eval-and-postmortem.md](../evals/0003-memory-provider-eval-and-postmortem.md)。
