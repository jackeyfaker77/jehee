# ADR-0016：静默时段持久化自动补发、MCP 自愈重连、运行时模型热切与出站富媒体交付（Slice 6C）

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-26
- **关联需求**：[PRD](../PRD.md)、[ADR-0003](./0003-cloud-topology-and-channel-gateway.md)、[ADR-0007](./0007-mcp-connector-skeleton-and-eval.md)、[ADR-0008](./0008-write-approval-and-quiet-governance.md)、[ADR-0014](./0014-proactive-routines-and-clock.md)、[ADR-0015](./0015-multimodal-channels-and-web-fetch.md)、[Postmortem-0004](../evals/0004-cloudflare-workers-fetch-postmortem.md)

---

## 1. 背景与问题（Context & Problem）

截至 Slice 6B，Jehee 已具备 7×24 单入口对话、双栖工坊、MCP 连接器、原子记忆、无感换窗、主动定时提醒（Slice 6A）与 Telegram 双向多模态基础设施（Slice 6B）。在面向真实 7×24 云端常驻个人助手（PA）运维推进时，仍有四个关键体验与韧性缺口需要闭环：

1. **静默时段暂存通知易丢失且缺少窗口结束自动补发**：
   - 现有 `ProactiveNotificationGovernor` 仅在内存中持有 `#held` 队列，且只在主人下次发言或手动执行 `/flush` 时才触发补发；
   - 一旦 Cloudflare Durable Object 夜间休眠或本地进程重启，静默时段内暂存的提醒与汇报会直接丢失；即使未重启，早晨 08:00 静默窗口结束时也不会自动送达汇总摘要。
2. **MCP 弱网/休眠后端缺少运行时诊断与免重启自愈**：
   - `bestEffortConnect: true` 允许不可达的 MCP 服务（如夜间休眠的手机端 Miu Bridge）在启动时被跳过，但此前既未保留脱敏的失败诊断原因，也缺少 `/mcp` 状态巡检与 `/mcp reconnect` 热重连能力；
   - 远端设备恢复在线后，主人只能重部署或重启宿主才能重新发现工具，且直接重装扩展容易残留失效的旧工具定义。
3. **运行时模型切换需改环境变量并重启**：
   - 日常使用中经常需要在低成本快速模型与高推理强模型之间按需切换，但此前 `defaultModel` 写死在启动配置中，缺少持久化的运行时模型覆盖（`/model`）与基于 `Models` 注册表的合法性校验。
4. **Agent 尚不能主动向主人回发图片与文档**：
   - Slice 6B 已在 `ChannelTransport` 与 `TelegramTransport` 上实现了 `sendPhoto` / `sendDocument`，但主会话模型尚无统一的 `send_media` 工具；
   - 当 MCP 工具（如 `phone_screenshot`）返回 `ImageContent` 截图时，若让模型直接复述 Base64 字符串既浪费数万 Token 又极易截断损坏，亟需与 `McpBlobVault` 的 `$jehee_blob:...` 句柄直连以实现零 Token 拷贝转发。

---

## 2. 备选方案对比（Alternatives Considered）

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：为静默自动补发再新增第二个后台休眠任务（`QuietFlushTask`）** | 与 `RoutineSchedulerTask` 代码解耦 | 增加额外的 Durable Task 生命周期与 Alarm 调度竞争；每个会话需要维护两个单活任务及各自的 `TaskId` / 唤醒信号，放大复杂度与 DO 状态体积。 |
| **方案 B：使用宿主 OS 时区 API（`Date.prototype.getHours()` / `Intl.DateTimeFormat`）推算静默结束时刻** | 写法简短 | 依赖运行宿主的系统时区与 ICU 行为，在本地开发机（UTC+8）与 Cloudflare Workers（UTC+0）间存在漂移风险；无法做到纯函数确定性回归。 |
| **方案 C：`/mcp reconnect` 与 `/model` 通过修改本地配置文件并重启进程生效** | 无需处理运行期状态热替换 | 在 Cloudflare Workers Durable Object 无状态代码部署模型下根本不可行；重启还会中断正在运行的后台工坊与路由上下文。 |
| **方案 D：让模型在 `send_media` 参数中自行复制 MCP 返回的完整 Base64 字符串** | 无需扩展 `McpBlobVault` | 手机截图或文档 Base64 动辄数十万字符，不仅造成巨额输出 Token 消耗与延迟，还容易被上下文截断导致图片损坏。 |
| **方案 E（最终采用）：复用单一单活 `RoutineSchedulerTask` 驱动 `HeldNotificationsDoc` 定时补发 + `McpConnectorHub` 脱敏失败诊断与 `Registry` 原子热换 + `RuntimeModelDoc` 持久化热切 + `send_media` 直连 `McpBlobVault`** | 100% Web/Edge 可移植（零 Node 专有依赖）；继续复用单一 Cloudflare DO Alarm 且休眠期严格满足 `wake().active === false`；MCP 故障可观测且免重启热恢复；模型覆盖跨休眠/重启持久生效；截图通过 `$jehee_blob:` 零 Base64 拷贝直达 Telegram | 需要在 `RoutineSchedulerTask` 中协调例行任务与静默补发的双唤醒源并做好错误退避隔离；需严格防止 `pi-durable` 事务代理对象越界泄漏。 |

---

## 3. 决策与核心依据（Why — 为什么这么设计）

### 3.1 支柱一：持久化 `HeldNotificationsDoc` 与静默结束自动补发

- **纯 UTC 偏移量窗口结束计算（`computeNextQuietEndMs`）**：
  - 在 `src/governance/quiet-gate.ts` 新增纯函数 `computeNextQuietEndMs(window: QuietHoursWindow, nowMs: number): number`；
  - 完全沿用 `timestampMs + utcOffsetMinutes * 60_000` 配合 `Date.UTC` / `getUTC*` 算术，零宿主 OS 时区依赖，精准支持跨午夜窗口（如 `23:00-08:00`）、日间窗口（如 `13:00-14:00`）、负偏移（如 `-05:00`）与半小时偏移（如 `+05:30`）；
  - 当 `isWithinQuietHours(nowMs, window)` 为 `true` 时返回当前静默窗口精确结束的毫秒时间戳（`endMinute:00.000`）；否则返回下一次静默窗口结束时间戳，并严格满足 `result > nowMs`、`isWithinQuietHours(result, window) === false`、`isWithinQuietHours(result - 1, window) === true`。
- **会话级持久化缓冲（`HeldNotificationsDoc`）**：
  - 在 `src/governance/durable-store.ts` 定义 `HeldNotificationsDoc`（`kind: "jehee.held_notifications"`, `version: 1`, `scope: "session"`, `checkpointWhen: () => false`），上限 `MAX_HELD_NOTIFICATIONS = 50`，超限时按 FIFO 淘汰最早条目防止 SQLite 文档无限膨胀；
  - 提供纯状态操作函数 `appendHeldNotificationInState` / `drainHeldNotificationsInState` / `listHeldNotificationsFromState`，所有返回值均为深拷贝的纯对象（detached clones），严格遵守 `pi-durable` 事务边界不泄漏 overlay 代理引用的铁律；
  - `ProactiveNotificationGovernor` 新增无副作用策略分类方法 `classify(...)`、`quietHours` 读取器、`nextQuietEndMs(nowMs)` 与公共 `formatHeldNotificationBatches(...)`，既 100% 兼容既有内存模式调用方与测试，又可与 `HeldNotificationsDoc` 无缝组合。
- **复用单一单活 `RoutineSchedulerTask`（零额外后台任务 / 单一 DO Alarm）**：
  - 在 `src/routines/extension.ts` 的 `CreateRoutinesExtensionOptions`（以及 `CreateRoutineSchedulerTaskOptions`）上以向后兼容的可选字段增加 `getNextQuietFlushAtMs?: (nowMs: number, tx?: Tx) => Promise<number | undefined>` 与 `onQuietFlushDue?: (nowMs: number, context: Context) => Promise<void>`；
  - `syncRoutineSchedulerInTx` 新增可选第 4 参数 `extraWakeAtMs?: number`，使仅存在静默暂存通知（即使 `RoutineDoc` 中尚无任何定时提醒）时也能创建或通过 `RoutineWakeSignal` 唤醒同一个单活调度任务；
  - 在 `RoutineSchedulerTask` `phases.wait` 的**同一个序列化 `runtime.commit(tx)` 事务内**同时读取 `RoutineDoc` 与 `await getNextQuietFlushAtMs(nowMs, tx)`（仅在 `onQuietFlushDue` 亦已配置时激活，消除 `wait` 决定休眠/结束前的并发唤醒丢失窗口，并隔离非 abort 查询异常）：
    1. 若 `quietFlushAt !== undefined && quietFlushAt <= nowMs` 且不在退避期内，原子切入 `phase: "flushQuiet"`；在 `flushQuiet` 阶段中于事务外通过 `tracker.beginDispatch()` 守护并包裹非 abort `try/catch` 调用 `onQuietFlushDue(dueAtMs, context)`（瞬时投递失败绝不令调度器 fault，也不会阻塞后续 Routine 执行）；完成后若失败或队列仍立即可发，将 `quietFlushBackoffUntilMs`（默认 60 秒）持久化进任务检查点（跨 `dispatch` 阶段保留），避免忙等死循环或立即重试风暴；
    2. 否则在事务内取 `min(earliestRoutineAt, quietFlushAt)` 进入 `status: "sleeping"`；若两者皆为 `undefined`，清理指针后优雅 `terminal/completed`。休眠期间严格保持 `wake().active === false`，仅占用单个 Cloudflare DO Alarm。

### 3.2 支柱二：MCP 自愈诊断（`/mcp` 与 `/mcp reconnect`）

- **结构化脱敏故障记录**：
  - 在 `src/mcp/contract.ts` 定义 `FailedMcpServer = { readonly name: string; readonly error: string }` 与 `McpReconnectReport = { readonly connected: readonly { readonly name: string; readonly toolCount: number }[]; readonly failed: readonly FailedMcpServer[] }`；
  - `McpConnectorHub.connect(..., { bestEffort: true })` 跳过不可达服务时，将脱敏后的错误摘要记录到 `failedServers()`，严禁在错误文案中泄漏 `Authorization` / `Bearer` Token 等凭据。
- **免重启原子热重连**：
  - `createMcpBundle` 暴露 `blobVault` 与 `extensionHandles`（确定性扩展句柄列表），使 `JeheeHost.reconnectMcp()` 可以先卸载旧 MCP 扩展、关闭旧连接、重新按配置 `McpConnectorHub.connect` 并注册新扩展，确保 `Registry` 与工具视图中不残留任何过期工具定义；
  - `ChannelGateway` 提供白名单指令 `/mcp`（展示已连接服务与工具数 + 失败服务诊断）与 `/mcp reconnect`（触发热重连并返回 `formatMcpStatusReply` 格式化结果）。

### 3.3 支柱三：持久化运行时模型热切（`/model` 与 `RuntimeModelDoc`）

- **会话级持久化覆盖（`RuntimeModelDoc`）**：
  - 在 `src/governance/durable-store.ts` 定义 `RuntimeModelState = { override?: ModelRef; updatedAtMs?: number }` 与 `RuntimeModelDoc`（`kind: "jehee.runtime_model"`, `version: 1`, `scope: "session"`, `checkpointWhen: () => false`）；
  - 当主人通过 `/model <provider>/<modelId>` 切换模型时，先针对宿主已注入的 `Models` 注册表校验 `provider` 与 `modelId` 确实存在（防止拼写错误导致后续所有回合失败），再持久化到 `RuntimeModelDoc` 并通过 `conversation.configure` 立即热生效；`/model reset` 清除覆盖恢复默认模型；
  - 宿主冷启动或 DO 休眠恢复时自动读取 `RuntimeModelDoc` 恢复覆盖配置；
  - 提供纯格式化函数 `formatModelStatusReply` 与 `formatModelListReply` 供 `/model` 与 `/model list` 输出。

### 3.4 支柱四：Agent 出站富媒体交付（`send_media` 工具与 `McpBlobVault` 桥接）

- **零 Base64 拷贝的 `McpBlobVault` 桥接**：
  - `McpBlobVault` 新增 Web 标准 `getBlob(handle)`（使用纯 Web `atob` / `Uint8Array` 解码，100% 兼容 `workerd`）；
  - 当 MCP 工具返回 `{ type: "image", data, mimeType }` 时，除向模型保留图像内容供视觉理解外，同步落入 `McpBlobVault` 并附加一行简短提示 `[Saved image handle: $jehee_blob:... — pass to send_media to deliver to user]`，使模型可直接把句柄传给 `send_media` 发给主人，无需复制 Base64。
- **可移植 `jehee.media` 扩展（`src/media/extension.ts`）**：
  - 导出 `JEHEE_MEDIA_EXTENSION_NAME = "jehee.media"`、`JEHEE_MEDIA_EXTENSION_HANDLE`（供工坊子会话隔离移除）与 `SEND_MEDIA_TOOL = "send_media"`；
  - `send_media` 支持 `kind: "photo" | "document"`，严格校验输入源必须恰好提供 `blobHandle`、`base64`、`textContent` 三者之一，强制执行字节上限（默认 `10 MiB`）及图片光栅 MIME 白名单（`image/jpeg`、`image/png`、`image/webp`、`image/gif`），通过 `deliverMedia` 桥接到 `ChannelTransport.sendPhoto` / `sendDocument`（走既有路由解析与 Staging 锁）；
  - 与 Slice 6A/6B 一致，遵循纯 MCP Slice 4 门禁：当未启用日常 PA 扩展（未开启 routines/memory/handoff/media）时保持首轮仅暴露 `["tool_search"]`。

---

## 4. 具体设计方案（How — 怎么设计）

### 4.1 模块与目录结构

```text
apps/jehee/
├── docs/adr/
│   └── 0016-resilient-pa-ops-and-outbound-media.md
├── src/
│   ├── governance/
│   │   ├── quiet-gate.ts       # 新增 computeNextQuietEndMs、formatHeldNotificationBatches、ProactiveNotificationGovernor.classify / quietHours / nextQuietEndMs
│   │   └── durable-store.ts    # 新增 HeldNotificationsDoc (cap=50)、RuntimeModelDoc、detached clone 读写助手、formatModelStatusReply / formatModelListReply / formatMcpStatusReply
│   ├── routines/
│   │   └── extension.ts        # CreateRoutinesExtensionOptions / RoutineSchedulerTask 新增 getNextQuietFlushAtMs & onQuietFlushDue；syncRoutineSchedulerInTx 支持 extraWakeAtMs
│   ├── mcp/
│   │   ├── contract.ts         # 新增 FailedMcpServer、McpReconnectReport
│   │   ├── blob-vault.ts       # 新增纯 Web getBlob(handle)
│   │   ├── hub.ts              # bestEffort 模式记录脱敏 failedServers()
│   │   └── extension.ts        # McpBundle 暴露 blobVault & extensionHandles；ImageContent 自动写入 Blob 句柄提示
│   ├── media/
│   │   └── extension.ts        # 新增 jehee.media 扩展与 send_media 工具（photo/document + blobHandle/base64/textContent）
│   ├── core/
│   │   └── host.ts             # 接入 HeldNotificationsDoc、RuntimeModelDoc、MCP reconnect、send_media 回调与模型热切 API
│   └── channels/
│       └── gateway.ts          # 接入 /mcp [reconnect]、/model [list|<provider/id>|reset]、持久化静默补发与出站媒体投递
└── test/
    ├── quiet-autoflush.test.ts # computeNextQuietEndMs、HeldNotificationsDoc、RuntimeModelDoc、formatters 与 RoutineSchedulerTask 自动静默唤醒集成测试
    ├── outbound-media.test.ts  # send_media 全路径校验与 McpBlobVault.getBlob 测试
    └── mcp.test.ts             # failedServers() 诊断与 ImageContent -> $jehee_blob 句柄测试
```

### 4.2 静默自动补发状态机时序

1. **夜间静默触发（例：23:30 UTC+08:00）**：后台提醒或工坊汇报进入 `ChannelGateway.pushMessage` → `governor.classify` 判定 `hold ("quiet_hours")` → 写入 `HeldNotificationsDoc`（上限 50 条）→ 在事务中调用 `syncRoutineSchedulerInTx(tx, schedulerTask, nowMs, computeNextQuietEndMs(window, nowMs))` → 单活 `RoutineSchedulerTask` 被创建或由 `RoutineWakeSignal` 唤醒并重算 `min(earliestRoutineAt, quietFlushAt)` → 休眠至次日 `08:00:00+08:00`（`wake().active === false`，仅 1 个 DO Alarm）。
2. **早晨 08:00 自动补发**：Alarm 唤醒 `RoutineSchedulerTask` → `phases.wait` 检测到 `quietFlushAt <= nowMs` → 在事务外执行 `onQuietFlushDue(nowMs, context)`，原子排空 `HeldNotificationsDoc` 并按路由分组发送汇总摘要 → 若无后续 Routine，调度器自然进入 `terminal/completed`；若有后续 Routine，则继续休眠至下一个 `earliestRoutineAt`。
3. **瞬时故障隔离**：若 08:00 时网络/Telegram 瞬时报错，`onQuietFlushDue` 抛出的非 abort 异常被隔离捕获并退避重试，绝不影响后续定时任务，也不造成 CPU 死循环。

### 4.3 新增与增强指令一览

| 指令 | 行为 |
| :--- | :--- |
| `/mcp` | 展示已连接 MCP 服务（含工具数）及启动/重连失败服务的脱敏诊断信息 |
| `/mcp reconnect` | 卸载旧 MCP 扩展并重新连接全部配置服务，原子热替换 `Registry` 后返回最新连接报告 |
| `/model` | 展示当前生效模型、默认模型及是否处于运行时覆盖状态 |
| `/model list` | 列出 `Models` 注册表中可用模型并标注当前激活项 |
| `/model <provider>/<modelId>` | 校验模型存在后持久化至 `RuntimeModelDoc` 并立即热生效 |
| `/model reset` | 清除 `RuntimeModelDoc` 覆盖并恢复启动默认模型 |
| `/flush` | 立即手工排空 `HeldNotificationsDoc` 中当前路由的暂存通知并推送 |

---

## 5. 风险、权衡与验收标准（Verification & Risks）

### 5.1 风险与缓冲

- **补发失败引发忙等死循环风险**：若 `onQuietFlushDue` 失败且暂存队列未被清空，再次读取 `getNextQuietFlushAtMs(nowMs)` 可能依然返回 `<= nowMs`。通过在单次 `wait` 执行中至多尝试一次补发并在失败/仍到期时强制退避（默认 `60_000 ms`），彻底消除紧循环与 DO CPU 耗尽风险。
- **`pi-durable` 事务代理泄漏风险**：`HeldNotificationsDoc` 与 `RuntimeModelDoc` 的所有辅助读写函数均构造并返回全新的纯对象深拷贝，杜绝跨出 `commit` 回调后触发 `Cannot use a settled overlay`。
- **MCP 错误信息泄漏凭据风险**：`McpConnectorHub` 记录 `FailedMcpServer.error` 时对 URL/Header/Token 等敏感片段进行脱敏截断，避免通过 `/mcp` 回显给聊天通道。
- **富媒体内存峰值与滥用风险**：`send_media` 严格限制单次负载大小（默认 `10 MiB`），拒绝同时传入多个内容源，并为 `photo` 强制限定光栅图片 MIME；`McpBlobVault` 仍受原有条目/容量淘汰保护。
- **Slice 4 延迟工具发现回归风险**：`jehee.media` 的 `send_media` 工具与 `jehee.routines` / `jehee.web` 采用一致的按需启用策略，确保未配置这些扩展时的纯 MCP 延迟发现测试首轮可见工具集合严格保持 `["tool_search"]`。

### 5.2 Slice 6C 验收门禁清单

- [x] `npm --prefix apps/jehee run format && npm --prefix apps/jehee run check`（Biome + `tsc --noEmit` + `check:worker-bundle`）零错误通过。
- [x] `apps/jehee/test/quiet-autoflush.test.ts` 覆盖：`computeNextQuietEndMs` 跨夜/日间/负偏移/半小时偏移边界、`HeldNotificationsDoc` 50 条 FIFO 淘汰与 detached clone 安全性、`RuntimeModelDoc` 持久化与三个纯格式化器、以及 `RoutineSchedulerTask` 精准按 `quietFlushAt` 唤醒执行 `onQuietFlushDue` 与错误隔离。
- [x] `apps/jehee/test/outbound-media.test.ts`、`apps/jehee/test/mcp.test.ts` 与 `apps/jehee/test/slice-6c-integration.test.ts` 覆盖：`send_media` 三种来源与校验、`McpBlobVault` 有界 LRU 与 `getBlob`、`ImageContent` 句柄注入、`McpConnectorHub.failedServers()` 凭据脱敏、Staging 锁、工坊子会话隔离、静默补发失败保留与 Slice 4 首轮 `["tool_search"]` 门禁。
- [x] `apps/jehee/features/pa-ops-and-media.feature` 全量 4 场景通过，且 `npm --prefix apps/jehee run test:unit && npm --prefix apps/jehee run test:bdd` 与四项离线 Eval、仓根 `npm run check` 全量通过（含既有 `features/mcp-connector.feature` 门禁）。
