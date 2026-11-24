# ADR-0014：主动定时提醒、周期例行任务、尾部本地时钟锚点、持久化投递路由与 DO Alarm 守护（Slice 6A）

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-25
- **关联需求**：[PRD v1.3 — 板块二（主动打扰治理）& 板块四（7×24 云端常驻）](../PRD.md)、[ADR-0003](./0003-cloud-topology-and-channel-gateway.md)、[ADR-0008](./0008-write-approval-and-quiet-governance.md)、[ADR-0011](./0011-background-memory-consolidation.md)

---

## 1. 背景与问题（Context & Problem）

截至 Slice 5D，Jehee 已实现 7×24 单入口对话、双栖工坊、MCP 连接器、原子记忆、后台整理、可移植快照与无感换窗，但在真实长期日常使用中，仍存在四个关键工程缺口：

1. **缺少原生的定时提醒与周期例行任务（Routines）**：用户无法让 Jehee 在“30 分钟后提醒喝水 / 每天 09:00 发晨报 / 每周一 10:00 巡检待办”，也无法在不需要 LLM 推理的简单提醒场景下做到零 Token 消耗。
2. **模型缺少本地时间感知且不能破坏前缀 KV-Cache**：若将动态当前时间写入系统提示词前缀（L1 Core System Prompt），会导致每轮请求的 Prompt 前缀变化，击穿高命中率（~97.9%）KV-Cache。
3. **Cloudflare DO 冷唤醒丢失主动推送目标路由**：`ChannelGateway` 此前仅在内存字段 `#lastActiveRoute` 中记录主人最近活跃的 `{ channel, chatId }`。Cloudflare Durable Object 休眠被 Alarm 冷唤醒时，内存字段为空，主动提醒与后台汇报无法投递。
4. **Cloudflare DO `alarm()` 存在提前回收风险**：此前 `worker.ts` 的 `alarm()` 仅同步调用 `this.#host.resume()` 后即返回，未通过 `ctx.waitUntil(...)` 等待到期的后台定时任务与 Telegram 出站推送完成，DO 在请求间隙可能提前挂起或回收导致推送丢失。

---

## 2. 备选方案对比（Alternatives Considered）

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：每个 Routine 各自启动一个独立 `pi-durable` 休眠任务** | 实现直观 | 任务数量随提醒数线性增长，取消或修改时间时需维护多个 TaskId 生命周期，且容易引发并发唤醒竞争。 |
| **方案 B：依赖外部 Cron Triggers（Cloudflare Cron）每分钟轮询** | 与 DO 内部状态解耦 | 绑定 Cloudflare 专有配置，无法在本地 Node CLI/Telegram 轮询模式复用；每分钟空转唤醒浪费配额；无法做到秒级/自定义时刻精准触发。 |
| **方案 C：把当前时间放进 `section("jehee_clock")` 系统提示词** | 改动最少 | 每次对话系统前缀变化，直接破坏模型 Provider 前缀 KV-Cache，显著抬高输入成本与首字延迟。 |
| **方案 D（最终采用）：单一单活 `RoutineSchedulerTask` + 唤醒信号 `RoutineWakeSignal` + `RoutineDoc` / `LastRouteDoc` 持久化 + 用户消息侧不可变时间戳锚点 + DO `alarm()` `ctx.waitUntil` 守护** | 100% 双栖可移植（本地 Node SQLite 与 Cloudflare DO Alarm 共享一套逻辑）；单活休眠任务 O(1) 资源占用且新增更早任务时通过 Signal 立即重算唤醒点；`direct_notify` 零 LLM Token、`agent_prompt` 幂等提交且原生联动 `[SILENT]` 与静默时段门控；用户侧时间锚点严格绑定每条消息自身不可变时间戳，完整保留系统前缀与历史轮次 KV-Cache 命中率 | 需实现纯 UTC 偏移量日期算法（零宿主本地时区依赖）、单活调度器状态机与 DO Alarm 结算等待逻辑。 |

---

## 3. 决策与核心依据（Why — 为什么这么设计）

### 3.1 双模式 Routine 调度（`direct_notify` vs `agent_prompt`）
- **`direct_notify`（零 Token 直推）**：适用于确定性提醒（如“15:00 开会”、“30 分钟后关火”）。到期后直接通过 `JeheeHost.onDirectNotify` 回调交由 `ChannelGateway.pushMessage` 经 `ProactiveNotificationGovernor`（静默时段、忙时让路、频控冷却、Staging 锁）外发，全程消耗 **0 LLM Token**。
- **`agent_prompt`（幂等主会话推理 + `[SILENT]` 静默抑制）**：适用于需要结合记忆或工具巡检的周期例行任务（如每日晨报、定时检查邮件/日历）。到期后向根会话提交携带确定性幂等号 `requestId: "routine:<id>:<fireAtMs>"`、`whenBusy: "followUp"` 的回合，并在指令中明确告知：若当前无可汇报事项则只回复 `[SILENT]`。回复为 `[SILENT]` 时在调度层与静默门控层双重拦截，不打扰主人。

### 3.2 单活休眠调度器（Single-Flight `RoutineSchedulerTask` + `RoutineWakeSignal`）
- 参考 Slice 5C-2 `MemoryConsolidatorTask` 与 Slice 5B `WorkshopCancelSignal` 模式，全局仅存在最多 1 个 `background: true` 的 `jehee.routines.scheduler` 任务，其 `scheduledTaskId`（数字类型）与 `wakeSignalKey` 持久化在 `RoutineDoc`（`scope: "session"`）。
- 调度器在 `wait` 阶段扫描 `RoutineDoc` 中所有启用任务的最早 `nextRunAtMs`：
  - 若无启用任务，清理 `scheduledTaskId` 后进入 `terminal/completed`（空闲零消耗）；
  - 若 `now < earliest`，带 `until: earliest` 与 `signals: [RoutineWakeSignal.key(signalKey)]` 进入 `sleeping`；新增更早任务或删除任务时，`syncRoutineSchedulerInTx` 发送唤醒信号使其立即重算下一次唤醒时间；
  - 若 `now >= earliest`，在**同一 SQLite 事务内**原子推进全部到期任务的 `runCount` / `lastRunAtMs` / `lastFiredKey` / `nextRunAtMs`（`once` 自动禁用），并将本批待投递项写入 `checkpoint: { phase: "dispatch", items, index: 0 }`，逐条投递并按索引持久化检查点，确保崩溃重启后不漏发、不重发。

### 3.3 尾部/用户侧本地时间锚点（零 KV-Cache 破坏）
- 在 `jehee.routines` 扩展的 `GenerationTask.beforeRequest` 钩子中（仅对根会话生效），为每条带时间戳的用户消息附加一个独立的 `{ type: "text", text: formatLocalClockLine(msg.timestamp, utcOffsetMinutes) }` 文本块（例如 `[Local Time: 2026-11-25 14:30 (Wed, UTC+08:00)]`）。
- 关键设计保障：
  1. **系统提示词前缀零改动**：L1 Core、工具定义与系统指令 100% 不变，维持 ~97.9% KV-Cache 命中率；
  2. **绑定每条消息自身不可变时间戳**：历史用户消息在后续轮次及同轮多步工具调用中保持字节级一致，不会击穿历史轮次缓存；
  3. **不污染持久化记录**：仅在请求构造阶段注入，SQLite `UserEntry`、可见历史投影与可移植快照保持纯净用户原话。

### 3.4 持久化最后活跃路由（`LastRouteDoc`）与冷启动回退
- 新增 `LastRouteDoc`（`kind: "jehee.last_route"`, `scope: "session"`, `checkpointWhen: () => false`）。
- `ChannelGateway` 每次受理授权主人的消息或内联按钮回调时，同步更新内存 `#lastActiveRoute` 并调用 `host.setLastActiveRoute(route, context)` 落盘。
- 主动推送（`onDirectNotify`、`onProactiveReply`、`onApprovalRequested`）解析目标路由时按优先级回退：
  1. 内存 `#lastActiveRoute`；
  2. SQLite `LastRouteDoc` 中持久化的 `{ channel, chatId }`；
  3. 若尚未交互过（冷 DO 首次 Alarm 唤醒），回退至 `allowFrom.telegram` 白名单首个主人 ID（且已注册 `telegram` 传输器）。

### 3.5 工具暴露边界与纯 MCP 切片兼容
- 根会话按需暴露 `routine_create`、`routine_list`、`routine_delete` 三个工具，并在内置工坊子会话（`src/workshop/extension.ts`）中通过 `JEHEE_ROUTINES_EXTENSION_HANDLE` 显式移除。
- 为保持 Slice 4 纯 MCP 延迟发现场景（未挂载原子记忆、换窗与 Routines 时首轮可见工具仅含 `["tool_search"]`）的严格门禁，`JeheeHost` 通过 `enableRoutineTools = options.enableRoutines ?? (options.memory?.atomic !== undefined || options.handoff !== undefined)` 门控工具暴露；标准运行入口（`node.ts` 与 `worker.ts`）默认启用 `enableRoutines: true`。

### 3.6 Cloudflare DO `alarm()` `ctx.waitUntil` 守护
- `worker.ts` 的 `alarm()` 唤醒 `this.#host.resume()` 后，立即通过 `this.#state.waitUntil(...)` 等待 `this.#host.waitForDueRoutines(BACKGROUND_CONTEXT)` 与 `this.#gateway.drain()` 完成，并在 `finally` 中根据 `this.#host.wake()` 重新设置下一次精确 Alarm 或清除冗余 Alarm。

---

## 4. 具体设计方案（How — 怎么设计）

### 4.1 模块与目录结构

```text
apps/jehee/
├── docs/adr/
│   └── 0014-proactive-routines-and-clock.md
├── src/
│   ├── routines/
│   │   ├── contract.ts       # 纯类型：RoutineSchedule (once|daily|weekly|interval)、RoutineItem、RoutineStoreState、LastRouteState
│   │   ├── scheduler.ts      # 纯函数：UTC 偏移量 nextRunAtMs 计算、formatLocalClockLine、状态增删改与 /routines 回复格式化
│   │   ├── durable-store.ts  # pi-durable RoutineDoc & LastRouteDoc（scope: "session", checkpointWhen: () => false）
│   │   └── extension.ts      # jehee.routines 扩展：单活 RoutineSchedulerTask、RoutineWakeSignal、beforeRequest 时钟注入、3 个根会话工具
│   ├── telemetry/
│   │   └── recorder.ts       # 新增 JEHEE_ROUTINE_TELEMETRY_SCHEMA（jehee.routine.fire）与 startJeheeRoutineSpan
│   ├── core/
│   │   └── host.ts           # 接入 utcOffsetMinutes / enableRoutines、createRoutine / listRoutines / deleteRoutine / runRoutineNow / getLastActiveRoute / setLastActiveRoute / waitForRoutineScheduler / waitForDueRoutines / onDirectNotify
│   ├── channels/
│   │   └── gateway.ts        # 持久化 LastRouteDoc、冷唤醒回退 allowFrom.telegram[0]、/routines [list|cancel|run]、direct_notify 与 agent_prompt 接入静默门控
│   ├── workshop/
│   │   └── extension.ts      # builtin 工坊子会话移除 JEHEE_ROUTINES_EXTENSION_HANDLE
│   ├── runtime/
│   │   ├── config.ts         # 校验并透出 JEHEE_TZ_OFFSET -> utcOffsetMinutes（默认 +08:00）
│   │   └── node.ts           # 透传 utcOffsetMinutes 与 enableRoutines: true
│   ├── cloudflare.d.ts       # 补充 DurableObjectState.waitUntil 类型声明
│   └── index.ts              # 统一公共导出
├── worker.ts                 # 透传 utcOffsetMinutes/enableRoutines，alarm() 增加 ctx.waitUntil 守护
├── wrangler.jsonc            # 默认 vars 补充 JEHEE_TZ_OFFSET (+08:00) 与 JEHEE_QUIET_HOURS (23:00-08:00)
├── .env.example              # 补充 JEHEE_TZ_OFFSET 与 JEHEE_QUIET_HOURS 示例说明
├── features/
│   ├── routines.feature
│   └── steps/
│       └── routines.steps.ts
└── test/
    └── routines.test.ts
```

### 4.2 新增与更新环境变量
- `JEHEE_TZ_OFFSET`：主人所在固定 UTC 偏移量（默认 `+08:00`），统一驱动本地时钟锚点、静默时段窗口与 `daily`/`weekly` 例行任务计算。
- `JEHEE_QUIET_HOURS`：静默免打扰时段（如 `23:00-08:00`），与 `direct_notify` / `agent_prompt` 主动推送联动；`urgency: "urgent"` 可穿透静默窗口。

---

## 5. 风险、权衡与验收标准（Verification & Risks）

### 5.1 风险与缓冲
- **时区漂移风险**：所有 `daily`/`weekly` 与本地时钟格式化均通过 `timestampMs + utcOffsetMinutes * 60_000` 配合 `Date.UTC` / `getUTC*` 纯算术完成，完全不依赖运行时宿主 OS 时区，确保本地 Windows/Linux 与 UTC Cloudflare Workers 行为 100% 一致。
- **离线漏触发风暴风险**：若宿主离线错过多个 `interval` 或 `daily` 周期，`computeNextRunAtMs` 仅将本次到期合并触发一次并直接推进到下一个严格大于 `nowMs` 的未来槽位，避免补偿风暴刷屏。
- **重复投递风险**：`agent_prompt` 使用确定性 `requestId: "routine:<id>:<fireAtMs>"` 交给 `pi-durable` 去重；`direct_notify` 携带 `dedupeKey: "routine:<id>:<fireAtMs>"` 在网关去重，同时调度器每条投递完成后即提交 checkpoint 索引。
- **DO Alarm 阻塞超时风险**：`waitForDueRoutines` 仅等待当前已到期或正在投递的批次及根会话当前回合结算，绝不等待数小时后的未来周期任务，随后在 `finally` 中重设下一次精准 Alarm。

### 5.2 Slice 6A 验收门禁清单
- [x] `npm --prefix apps/jehee run format && npm --prefix apps/jehee run check`（Biome + `tsc --noEmit` + `check:worker-bundle`）零错误通过。
- [x] 单元测试（`apps/jehee/test/routines.test.ts`）覆盖：四种调度类型纯计算与跨日/跨周边界、`formatLocalClockLine` 尾部锚点与系统前缀零变动、`RoutineDoc` 与 `LastRouteDoc` SQLite 重启持久化、单活定时器自动唤醒（含新增更早提醒提前唤醒）、`direct_notify` 零 Token 直推 vs `agent_prompt` 推理、`[SILENT]` 静默抑制、冷启动路由回退、`/routines` 白名单指令与工坊子会话隔离。
- [x] Cucumber BDD（`apps/jehee/features/routines.feature`）及既有全部 BDD（尤其 `features/mcp-connector.feature` 首轮仅 `["tool_search"]` 约束）100% 通过。
