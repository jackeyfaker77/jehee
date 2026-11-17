# ADR-0003：双栖云拓扑（Cloudflare DO + InstaBox Free）与平台无关渠道网关（Telegram 首发）

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-18
- **关联需求**：[PRD v1.0 — Slice 2](../PRD.md)

---

## 1. 背景与问题（Context & Problem）

在 Slice 1 跑通 `JeheeHost` 内核与可插拔记忆底座并推送基线（`a41a02597`）后，进入 Slice 2 需要同时敲定两个紧密关联的架构决策：

1. **云端部署拓扑怎么摆？**
   用户拥有 **InstaBox 免费计划**（4 vCPU / 8 GiB RAM、20 GiB `/data` 持久化盘，但限制最多 1 台机器、闲置 30 分钟自动暂停、单次最长运行 120–480 分钟），同时希望控制面保持零/极低月租成本且 7×24 小时在线。
2. **首发接入 Telegram 后，未来如何平滑切换或并存接入 QQ（官方 QQBot / NapCat）而不丢失上下文与记忆？**
   在前代项目 `Kaze` 中，会话主键直接绑定了平台前缀（如 `telegram:<chat_id>` vs `qq:<user_id>`），导致更换聊天软件就像换了一个失忆的新 Bot；同时重型第三方 Bot SDK 体积庞大且依赖 Node 专属 API，不利于部署到边缘 Serverless 环境。

---

## 2. 备选方案对比（Alternatives Considered）

### 2.1 云端运行拓扑选型

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：把 `JeheeHost` 直接部署进 InstaBox 虚拟机内部** | 只有一个部署节点，本地直调文件与命令 | InstaBox 免费计划闲置 30 分钟强制 `idle pause` 且有单次运行上限，无法 7×24 接收聊天消息；且违背“状态与沙箱解耦（沙箱随时可重置而不丢大脑状态）”原则。 |
| **方案 B（最终采用）：控制面双栖（本地 Node SQLite / Cloudflare Workers Free SQLite DO）+ 执行面按需唤醒 InstaBox Free（`/data` 多 Git Worktree）** | 0 美元月租即可实现 24h 云端待命；CF 边缘天然直连 Telegram 与海外模型 API；平时对话不唤醒 InstaBox 省算力配额，工坊重活才通过 HTTPS 唤醒 4C8G 云电脑 | 控制面与渠道层必须只使用跨运行时标准 Web API（`fetch`、Web Crypto），不依赖 Node 专属重型 SDK 或本地 `ssh` 子进程。 |

### 2.2 Telegram 接入与多渠道演进方案选型

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 1：直接引入 `grammy` / `telegraf` 等全功能框架并把逻辑写在回调里** | 现成中间件多 | 增加外部依赖与 Worker 打包体积（CF Free 限制压缩后 3 MB）；且容易把防抖、鉴权、指令处理写死在 Telegram 专属对象上，后续迁移 QQ 需重写一遍。 |
| **方案 2（最终采用）：极薄平台无关 `ChannelGateway` + 零依赖纯 `fetch` `TelegramAdapter`** | 零新增第三方依赖（体积仅数 KB，Node 24 与 CF Workers 100% 通用）；鉴权、连发合并、Staging 发送锁、忙时自动 `steer`、指令处理全部沉在平台无关的 `ChannelGateway`；未来转 QQ 只需新增一个百行级的 `QQAdapter` | 需要自行处理 Telegram Webhook 验签与 4096 字符长文本分片（逻辑简单明确，约 120 行代码即可完备覆盖）。 |

---

## 3. 决策与核心依据（Why — 为什么这么设计）

### 3.1 为什么换平台（Telegram → QQ）能做到“零失忆、零业务改动”？

Jehee 是**面向单主人的个人伙伴**，而不是多租户 SaaS 客服系统。因此我们在 `ChannelGateway` 中确立了 **「身份归一、回复原路」** 原则：
1. **入站身份归一**：无论消息来自 `telegram` 还是未来的 `qq`，只要发送者通过了对应渠道的主人白名单校验，全部归一投递进 `JeheeHost` 的**同一个 `root` 主会话**（保留来源渠道标签），因此你在 Telegram 聊了一半的事，切到 QQ 问进展完全在同一个上下文与记忆里。
2. **出站原路投递 + Staging 发送锁**：回复默认沿触发该轮对话的 `channel + chatId` 原路发回，并更新 `lastActiveRoute` 供后台工坊或主动提醒投递；同时参考 `jiajia.fun` 实战经验，内置 **Staging 发送保护锁**（开启后仅允许发往指定测试 `chatId`，杜绝调试误发）。

### 3.2 为什么把「连发合并（Debounce）」和「忙时自动 Steer」放在网关层？

真实聊天时，人经常分两三行短消息把一件事说完（例如先发“帮我改下登录页”，2 秒后补一句“顺便加上单测”）：
- 若网关逐条秒推入核，第一句刚触发模型请求，第二句就变成了打断或排队，浪费一次完整 Prefill；
- 若会话当前空闲，网关开启一个极短的可配防抖窗口（如线上 600–1000ms，单测可控），把同一用户连发的几句话合并为单次换行拼接请求；
- 若主会话**当前已经在忙**（例如正在调用慢工具或派发工坊），则无需防抖等待，网关立即以 `whenBusy: "steer"` 塞入当前回合实时纠偏！

### 3.3 InstaBox 免费计划在后续工坊切片（Slice 3）中的固定边界

在此一并锁定云工坊对接契约（供 Slice 3 直接实现）：
- 通信统一走 InstaBox HTTPS REST API（`https://api.instabox.sh/v1` + `Idempotency-Key`），确保本地 Node 与 Cloudflare DO 双栖可用；
- 针对免费计划“单机上限 1 台 + 20 GiB `/data` 持久盘”的限制，工坊默认采用**单机按需 `resume` 唤醒 + `/data/jehee/worktrees/<task-id>` 多 Git Worktree 隔离**（避开受限的 `/tmp` 内存盘）。

---

## 4. 具体设计方案（How — 怎么设计）

### 4.1 新增模块结构（`apps/jehee/src/channels/`）

```text
apps/jehee/src/channels/
├── contract.ts      # 平台无关渠道契约：ChannelId, InboundMessage, OutboundMessage, ChannelTransport
├── gateway.ts       # 核心单入口网关：白名单鉴权、连发合并、/stop 与 /status 控制指令、忙时自动 steer、Staging 发送锁
└── telegram.ts      # 纯 fetch Telegram 适配器：Webhook 验签与 Update 解析、4096 字符智能分片发送、本地 getUpdates 轮询器
```

### 4.2 核心流程与接口要点

1. **`ChannelTransport`（任意新平台只需实现这 1 个接口即可接入）**：
   ```typescript
   export interface ChannelTransport {
   	readonly channel: string;
   	sendText(chatId: string, text: string, options?: { readonly replyToMessageId?: string }): Promise<void>;
   	sendTyping?(chatId: string): Promise<void>;
   }
   ```
   未来接入官方 QQBot 或 NapCat WebSocket 转发器时，只需提供一个 `channel: "qq"` 的 `ChannelTransport` 实现，并将收到的 QQ 事件转成 `InboundChannelMessage` 喂给 `gateway.ingest(msg, context)`。
2. **`ChannelGateway` 控制流**：
   - **白名单拦截**：检查 `allowFrom[msg.channel]` 是否包含 `msg.senderId`，未授权静默丢弃并计数（不调模型、不回错防探测）。
   - **确定性斜杠指令（零 Token 消耗）**：
     - `/status`：直接返回当前运行状态、主对话 ID、活跃记忆插件 ID 与是否忙碌。
     - `/stop`：调用 `JeheeHost.abortRoot(context)` 立即中止当前在途回合与队列，并回执“已停止当前任务”。
   - **空闲连发防抖 vs 忙时直通 Steer**：
     - 若宿主空闲且配置了 `debounceMs > 0`，同一 `(channel, chatId)` 的连续消息合并为 `\n` 分隔的一条完整输入，以首条 `messageId` 构造幂等 `requestId = "${channel}:${chatId}:${firstMessageId}"`；
     - 若宿主正忙（`host.isBusy(context)`），立即以 `whenBusy: "steer"` 提交，不让插话干等。
   - **Staging 发送保护锁**：当 `stagingAllowedChats` 非空时，任何发往名单外 `(channel, chatId)` 的出站消息将被拦截并记录告警，绝不外发。
3. **`TelegramTransport` 细节**：
   - Webhook 校验：校验 HTTP Header `x-telegram-bot-api-secret-token`（恒定时间字节比对防时序侧信道）；
   - 长消息分片：Telegram `sendMessage` 限制单条最多 4096 UTF-16 字符；超过阈值时优先按段落/换行边界切分，依次发送；
   - 双模式运行：既提供无状态 `handleTelegramWebhook(request)`（直接挂进 Cloudflare Worker `fetch` handler），又提供 `pollTelegramUpdates()`（供本地无公网 IP 时开发联调）。

---

## 5. 风险、权衡与验收标准（Consequences & Verification）

### 5.1 已知边界
- 当前 Slice 2 优先打通文本消息、斜杠控制指令、防抖合并、忙时插话与跨渠道切换；图片/PDF 附件经 Cloudflare R2 中转将在后续多模态扩展切片中按需补齐。
- `JeheeHost` 需补充两个轻量公开方法：`isBusy(context)`（读取 `LiveDoc` 判断根会话是否在途运行）与 `abort(context)`（供 `/stop` 指令安全中止当前运行）。

### 5.2 Slice 2 验收门禁清单
- [x] `npm run check`（Biome + `tsc --noEmit`）零警告、零错误通过。
- [x] 零新增外部 npm 依赖，根仓 `check-pinned-deps.mjs` 通过。
- [x] 新增 `features/channel-gateway.feature`（覆盖 Telegram Webhook 验签与分片、陌生人拦截、连发防抖合并、`/status` 与 `/stop` 指令、Staging 发送保护锁、以及 **Telegram 无缝切换至 QQ 渠道不断记忆**），全量 Cucumber BDD 场景绿色通过。
