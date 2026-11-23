# ADR-0008：确定性写操作人工确认闭环与主动打扰静默门控（Slice 5A）

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-18
- **关联需求**：[PRD v1.2 — 板块四 & Slice 5A](../PRD.md)、[ADR-0003](./0003-cloud-topology-and-channel-gateway.md)、[ADR-0006](./0006-nonblocking-telegram-polling-and-cli-boundary.md)、[ADR-0007](./0007-mcp-connector-skeleton-and-eval.md)

---

## 1. 背景与问题（Context & Problem）

在 Slice 4 打通双栖 MCP 连接器与真机运行入口后，Jehee 已具备连接真实个人邮箱、日历、账单服务的能力，同时也能在后台工坊完工后通过 `ChannelGateway` 主动向用户发消息。在把真实个人账号 7×24 小时托付给 Jehee 前，必须补齐**不依赖大模型自觉性的确定性治理护栏**：

1. **不可逆写操作的队头阻塞（Head-of-Line Blocking）与篡改风险**：
   - 在 Slice 4 中，`JeheeMcpOptions.beforeWriteToolCall` 提供了底层拦截钩子，但尚未与 Telegram / CLI 渠道形成「拦截生成待确认单 -> 用户跨小时拍板 -> 自动恢复执行」的产品闭环。
   - **单入口特殊约束**：Jehee 全程只有一个根会话窗口。如果直接在 `beforeTool` 里将工具任务休眠挂起（`sleep`）8 小时等待用户审批，根会话在整个等待期内会一直处于 `busy` 状态，导致用户期间无法正常聊任何其他话题。
   - **防调包与防重放**：用户批准的是“发送草稿 `msg-draft-1`”，绝不能允许模型在重试时偷换参数改成“发送 `msg-secret-2`”，也不能允许同一张批准票据被重复消费发送两次；同时票据必须落入 SQLite，跨越本地进程重启或 Cloudflare DO 休眠回收不丢失。
2. **后台主动推送的打扰失控（*"It knows when to be quiet"*）**：
   - 后台工坊汇报或定时巡检通过 `ChannelGateway.pushMessage` 主动发往用户手机。若仅靠提示词叮嘱模型“半夜别吵我”，无法杜绝凌晨弹窗、用户正在打字交互时强行插嘴，或多个后台子任务几秒内连环轰炸。
   - 被静默门控拦下的有效汇报**不能静默丢弃**，必须暂存并在合适时机（如用户下次主动交互或手动 `/flush`）汇总交付。

---

## 2. 备选方案对比（Alternatives Considered）

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：工具层直接 `sleep` 原地泊车等待 `harness.signal`** | 代码最少，复用 `pi-durable` 内置工具休眠 | **阻塞单入口聊天**：工具槽 `sleeping` 期间当前生成轮未结束，根会话保持 `busy`，用户在审批前发任何日常消息都会卡在工具轮后面无法即时问答。 |
| **方案 B：在内存 `Map` 中维护待确认单与免打扰队列，靠提示词约束参数** | 实现简单 | 进程重启或 Cloudflare DO 休眠释放后丢失全部待批单据；无参数哈希绑定，存在模型重试时改写收件人/正文的调包隐患。 |
| **方案 C（最终采用）：SQLite 持久化单次审批票据（`ApprovalDoc` + 业务参数指纹）+ Telegram 内联按钮 / 斜杠双通道闭环 + 三重确定性静默暂存门控** | 审批等待期主会话立即回到 `idle` 零阻塞；SHA-256 业务参数指纹防调包且单次消费防重放；支持 Telegram 一键点按钮（`callback_query`）与 `/approve` 通用指令；免打扰暂存零丢信 | 需在 `src/governance/` 编写约 250 行票据状态机与静默队列逻辑，并为 Telegram 适配器补齐 `inline_keyboard` 与 `callback_query`。 |

---

## 3. 决策与核心依据（Why — 为什么这么设计）

### 3.1 「草稿退回 + SQLite 单次票据 + 业务意图指纹」替代原地阻塞泊车
- **零队头阻塞**：当模型调用受控写工具（`readOnlyHint !== true`）且尚无已批准票据时，门控在同一 SQLite 事务（`ApprovalDoc`）中写入一张 `status: "pending"` 票据（如 `apv_3f8a91b2`），向活跃渠道推送**待确认卡片**，并立即向模型返回 `confirmation_required` 结束本轮。根会话瞬间恢复 `idle`，用户在审批前可随时正常对话。
- **剥离并发元数据的业务意图指纹（`intentDigest`）**：
  - 对 `(server, tool, sanitizedArgs)` 计算规范化 JSON 的 SHA-256 摘要，其中显式剔除每次重试都会变化的乐观锁与幂等字段（`expected_version`、`request_id`），完整锁死所有业务字段（如 `id`、`to`、`subject`、`body`、`files`）。
  - 这样既保证用户点击批准后，模型携带最新 `expected_version` 与新 `request_id` 重试时 100% 匹配放行；又保证一旦模型篡改任意业务字段（如换了收件人或邮件 ID），指纹立即失配并重新拦截。
- **单次原子消费（One-Shot Consumption）**：匹配放行时在 `ApprovalDoc` 事务内原子将票据置为 `"consumed"`，杜绝二次重放。

### 3.2 Telegram 内联按钮（`callback_query`）与全平台斜杠指令对齐
- 在 Telegram 上，待确认卡片自动附带底部内联按钮 `[确认执行]`（`apv:ok:<id>`）与 `[取消]`（`apv:no:<id>`）；用户点按后经由相同的 `allowFrom` 主人白名单鉴权、调用 `answerCallbackQuery` 消除加载转圈，并在批准时以幂等 `requestId: "approval-resume:<id>"` 自动唤醒主对话完成真实写入。
- 在本地 CLI、QQ 或纯文本场景下，提供完全等价的确定性指令 `/approve [id]` 与 `/reject [id]`（当仅存在 1 张待批票据时可省略 `id` 直接发 `/approve`），`/reject` 零模型调用直接作废票据。

### 3.3 三重确定性主动打扰门控 + `[SILENT]` 哨兵 + 零丢失暂存
仅针对**后台主动推送**（`ChannelGateway.pushMessage` 且 `urgency !== "urgent"`；用户主动发消息的直接回复与用户刚触发的审批卡片永不拦截）：
1. **`[SILENT]` 静默哨兵**：若后台唤醒回合模型判定无需打扰并输出 `[SILENT]`（或空文本），网关直接静默归档，不发任何出站请求。
2. **三重确定性拦截条件**：
   - **静默时段（`quietHours`）**：如配置 `23:00-08:00`（支持跨零点与指定时区偏移，默认 `UTC+08:00`），落入窗口内的普通后台汇报转入暂存队列（`reason: "quiet_hours"`）；
   - **忙时让路（`yieldWhenBusy`）**：当根会话正在处理前台任务（`host.isBusy === true`）时，后台通知暂存让路（`reason: "busy_yield"`）；
   - **同路由冷却频控（`minIntervalMs`）**：距离同一会话上次主动推送不足冷却间隔时暂存防刷屏（`reason: "rate_cooldown"`）。
3. **零丢失汇总交付**：被暂存的通知保留在队列中（`/status` 可见 `held_proactive` 数量）；当用户在非静默时段再次与该会话交互，或主动发送 `/flush` 指令时，自动合并投递暂存摘要。

---

## 4. 具体设计方案（How — 怎么设计）

### 4.1 新增与调整模块结构

```text
apps/jehee/
├── src/
│   ├── governance/
│   │   ├── approvals.ts      # ApprovalDoc (defineDoc)、computeWriteIntentDigest、WriteApprovalGate 与票据状态流转
│   │   └── quiet-gate.ts     # ProactiveQuietPolicy、跨零点静默窗口判定、频控冷却与暂存队列管理
│   ├── channels/
│   │   ├── contract.ts       # 新增 ChannelInlineButton、InboundCallbackAction 与 answerCallback 可选接口
│   │   ├── telegram.ts       # 支持 inline_keyboard 发送、callback_query 解析与 answerCallbackQuery
│   │   └── gateway.ts        # 接入 /approve、/reject、/flush 指令，callback_query 鉴权分发与三重静默门控
│   ├── core/
│   │   └── host.ts           # 持久化审批读写 API（listPendingApprovals / resolveApproval）与 onApprovalRequested 事件
│   └── runtime/
│       └── config.ts         # 解析 JEHEE_MCP_WRITE_GATE、JEHEE_MCP_WRITE_EXEMPT、JEHEE_QUIET_HOURS、JEHEE_TZ_OFFSET、JEHEE_PROACTIVE_COOLDOWN_MS
├── features/
│   ├── governance-and-approvals.feature
│   └── steps/
│       └── governance.steps.ts
└── test/
    └── governance.test.ts
```

### 4.2 核心配置项（`.env` / `wrangler.jsonc`）
- `JEHEE_MCP_WRITE_GATE`：`"confirm-writes"`（拦截非只读 MCP 工具生成确认票据）或 `"off"`；
- `JEHEE_MCP_WRITE_EXEMPT`：可选逗号分隔白名单（如 `"calendar/calendar.import_ics,notes/*"`），允许低风险内部写操作免批直通，而外发邮件等高危写操作强制审批；
- `JEHEE_QUIET_HOURS`：可选 `"HH:MM-HH:MM"`（如 `"23:00-08:00"`）；
- `JEHEE_TZ_OFFSET`：时区偏移（默认 `"+08:00"`）；
- `JEHEE_PROACTIVE_COOLDOWN_MS`：同会话主动推送最小间隔毫秒数（默认 `0`）。

---

## 5. 风险、权衡与验收标准（Verification & Risks）

### 5.1 风险与缓冲
- **Telegram 按钮连点幂等**：用户网络卡顿时可能连续点击两次 `[确认执行]`。第二次点击命中的票据已处于 `"approved"` 或 `"consumed"`，网关仅回复 `answerCallbackQuery("该操作已在处理中")` 并复用同一 `requestId: "approval-resume:<id>"`，绝不触发二次模型推理或二次发信。
- **程序化基准评测兼容性**：`JeheeHost.open` 在未显式开启 `writeGate: { mode: "confirm-writes" }` 时保持默认直通，确保无人值守的 `eval:mcp` 与历史套件零破坏。

### 5.2 Slice 5A 验收门禁清单（补充复核记录见 [Audit-0002](../evals/0002-adr-0006-to-0009-gate-audit-and-postmortem.md)）
- [x] `npm run check`（Biome + `tsc --noEmit` + `check-worker-bundle`）零错误通过（经 `Audit-0002` 加固后 Worker 包 `1861.6 KiB`）。
- [x] 单元测试（`test/governance.test.ts`）覆盖：跨零点与日内静默窗口计算、参数指纹对 `request_id`/`expected_version` 的豁免与业务字段防篡改、冷却频控与 `[SILENT]` 过滤、Telegram `inline_keyboard` 与 `callback_query`、多待批 `ambiguous` 提示、`/approve`、`/reject` 与空 `/flush`。
- [x] Cucumber BDD（`features/governance-and-approvals.feature`）端到端验证：
  1. 高危写操作被拦截生成 `apv_...` 卡片后主对话保持 `idle` 可自由穿插日常闲聊，点击 Telegram 内联批准按钮（或发 `/approve`）后自动续跑落库，且单次票据消费后不可重放；
  2. 批准草稿 A 后若模型尝试篡改参数发送草稿 B，参数指纹失配被再次确定性拦截；宿主 SQLite 重启后待批（`pending`）与已批（`approved`）票据均不丢失且可消费放行，`exemptTools` 豁免直通、`apv:no:<id>` 取消作废；
  3. 未授权陌生人点击 Telegram 批准按钮或发送 `/approve` 指令均被白名单直接拒绝，零状态变更；
  4. 静默时段（`23:00-08:00`）、忙时让路（`busy_yield`）与频控冷却（`rate_cooldown`）准确暂存后台通知且不拦截用户正常问答，发送 `/flush` 或非静默时段交互时完整投递暂存摘要，`[SILENT]` 哨兵实现零打扰。
