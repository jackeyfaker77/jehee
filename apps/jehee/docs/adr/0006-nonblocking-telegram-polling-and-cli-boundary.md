# ADR-0006：Telegram 本地长轮询非阻塞两阶段入站与本地 CLI 同步边界

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-18
- **关联需求**：[PRD v1.0 — Slice 3.6](../PRD.md)、[ADR-0003](./0003-cloud-topology-and-channel-gateway.md)、[ADR-0005](./0005-runtime-entrypoints-and-opencode-go.md)

---

## 1. 背景与问题（Context & Problem）

在完成双栖入口交付（`6d96d3276`）后审查入站调用链时发现：虽然 `JeheeHost` 与 `ChannelGateway` 已经完整实现了连发防抖合并（Debounce）、忙时实时插话（`whenBusy: "steer"`）和紧急停止（`/stop`），且在 Cloudflare Workers Webhook 模式下因每次入站为独立并发 HTTP 请求而天然跑通，但**本地入口**存在两类问题：

### 1.1 Telegram 本地长轮询（`pollTelegramUpdatesOnce`）串行阻塞导致三大能力失效

此前 `src/channels/telegram.ts` 在遍历 `getUpdates` 返回列表时逐条执行了 `await options.gateway.ingest(inbound, context)`，而 `ingest()` 会一直等待整轮模型生成与工具执行完毕才返回：
1. **连发防抖合并失效**：用户在手机上半秒内连发 `m1`、`m2` 且开启了 `debounceMs`（如 800ms）时，`m1` 进入 `await ingest(m1)` 会阻塞到「800ms 防抖结束 + 整轮推理结束」才继续读取 `m2`（哪怕 `m2` 已经在同一次 `getUpdates` 响应数组里，或在服务端等待下一次 `getUpdates`），导致 `m2` 永远进不了同一个防抖桶。
2. **忙时实时插话（`steer`）无法触达**：当主会话正在执行慢工具（如唤醒休眠的 InstaBox 机器需 5–15 秒）时，轮询循环卡在首条消息的 `await ingest` 上不去拉取新 `getUpdates`，用户追发的补充要求要等首轮彻底跑完才被拉下来变成新的一轮。
3. **`/stop` 紧急刹车失效**：主会话卡在慢工具或慢响应时，用户发送 `/stop` 同样被堵在 Telegram 队列里无法进入网关，等被拉取时任务早已结束。

此外，审查 `ChannelGateway` 并发细节还暴露出两处需要一并收敛的微窗口边界：
- 原 `#dispatchTurn` 先 `await transport.sendTyping()`（一次外部 HTTPS 请求，耗时百毫秒级）再调用 `host.submitMessage()`，导致消息在网络抖动期间尚未落库标记为 `busy`，紧随其后的消息或 `/stop` 可能乱序超越；
- 原 `/stop` 仅调用 `host.abort()` 中止已提交任务，未清理仍处于 `debounceMs` 倒计时中的待发防抖桶。

### 1.2 本地终端 CLI（`bin.ts chat`）是否也要改成异步非阻塞？

本地 CLI 共用单一终端标准输入输出（`stdin`/`stdout`）。若强行改为后台异步跑回合的同时继续接收敲字，当后台输出 `jehee> ...` 时会直接冲乱用户正在输入到一半的命令行（Prompt Clobbering）；要解决这一问题就必须引入 ANSI 光标重绘或重型 TUI 框架。

---

## 2. 备选方案对比（Alternatives Considered）

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：在 `pollTelegramUpdatesOnce` 中直接裸调 `void gateway.ingest(...)` 完全不等待** | 改动最少（仅去掉 `await`） | 存在竞态缺陷：当同一次 `getUpdates` 批量返回 `[m1, m2]` 且 `debounceMs = 0` 时，`m1` 尚未完成 `host.submitMessage()` 落库，`m2` 已并发执行 `host.isBusy()` 并误判为空闲，破坏 `update_id` 的严格先后提交顺序。 |
| **方案 B：同时将本地 CLI（`bin.ts chat`）改造为异步输入 + 终端光标擦除重绘或引入 TUI** | 终端里也能边跑边敲第二句话 | CLI 仅为本地快速冒烟与排错工具，主力日常交互在 Telegram/QQ；引入终端 UI 状态管理属于典型的“可选补偿层复杂度”，违背 PRD 非目标原则。 |
| **方案 C（最终采用）：`ChannelGateway` 拆分为有序毫秒级准入 `admit()` + 后台结算 `settled` + `drain()`；Telegram 轮询仅 `await admit()`；本地 CLI 保持简单同步问答** | 既严格保证按 `update_id` 顺序落盘/入防抖桶，又在毫秒内释放轮询器继续拉取下一批消息（打通防抖、`steer`、`/stop`）；零新增第三方依赖，100% 兼容 Cloudflare Workers | 需在 `ChannelGateway` 内维护在途结算集合 `#inFlight` 以支持安全排空（`drain`）与优雅关停。 |

---

## 3. 决策与核心依据（Why — 为什么这么设计）

1. **「有序准入（Admission）」与「耗时结算（Settlement）」职责分离**：
   - **准入阶段（`admit`，耗时 < 2ms）**：完成白名单校验、斜杠指令（`/status`、`/stop`）、防抖入桶，或直接调用 `host.submitMessage()` 将本条消息持久化写入 `pi-durable` 收件箱并使会话立即进入 `busy` 状态；
   - **结算阶段（`settled`，耗时数秒至数分钟）**：异步发送 `typing` 状态、等待 `pending.wait()` 大模型与工具完成、按 `answerEntryId` 去重并分片投递回聊天平台。
   - 轮询循环只需逐条 `await gateway.admit(inbound, context)`，即可在严格保序的前提下立即推进 `offset` 并发起下一次 `getUpdates` 长轮询，使本地守护进程与线上 Cloudflare Webhook 行为完全一致。
2. **先落库 `submitMessage`、后发 `sendTyping`**：
   消除外部 `sendChatAction` 网络往返造成的空窗期，确保一旦 `admit()` 返回，`host.isBusy()` 必然已反映最新状态，后续消息稳定走 `steer` 分支，后续 `/stop` 稳定中止该回合。
3. **`/stop` 全链路刹车与 `AbortSignal` 透传**：
   - `/stop` 先清空所有待发防抖桶（将其 `settled` 结算为 `{ kind: "unanswered", reason: "aborted" }`），再调用 `host.abort()` 中止底层在途回合；
   - `pollTelegramUpdatesOnce` 接收可选 `AbortSignal` 并透传给 `fetch`，使用户在本地执行 `Ctrl+C` 停止 `start:telegram` 时立即中断 20 秒长轮询挂起连接，无需干等超时。
4. **本地 CLI 保持克制**：
   `bin.ts chat` 维持同步 `rl.question` → `await gateway.ingest` 循环，不引入任何终端重绘复杂度。

---

## 4. 具体设计方案（How — 怎么设计）

### 4.1 `ChannelGateway` 接口扩展（`src/channels/gateway.ts`）

```typescript
export type AdmittedIngest = {
	readonly settled: Promise<IngestResult>;
};

export class ChannelGateway {
	/** 毫秒级有序准入：完成鉴权、指令执行、防抖入桶或持久化 submitMessage，返回后台结算句柄。 */
	async admit(message: InboundChannelMessage, context: Context): Promise<AdmittedIngest>;

	/** 完整入站并等待回合结算与出站回复完成（保持与 Webhook 及既有调用方 100% 兼容）。 */
	async ingest(message: InboundChannelMessage, context: Context): Promise<IngestResult>;

	/** 等待当前所有已准入或防抖中的后台回合及出站投递全部结算完毕。 */
	async drain(): Promise<void>;
}
```

### 4.2 Telegram 轮询与本地守护进程接线（`src/channels/telegram.ts`、`src/runtime/node.ts`）

- `pollTelegramUpdatesOnce`：
  - 新增可选参数 `signal?: AbortSignal`（透传给 `getUpdates` 的 `fetch`）与 `onError?: (error: unknown, message: InboundChannelMessage) => void`；
  - 循环内改为 `const admitted = await options.gateway.admit(inbound, context)`，对 `admitted.settled` 挂载非阻塞错误回调，不再阻塞后续 `update` 或下一轮 `getUpdates`。
- `runTelegramPollingDaemon` 与 `bin.ts`：
  - 将进程级 `AbortController.signal` 传入 `pollTelegramUpdatesOnce`；
  - 退出时依次执行 `gateway.dispose()` → `host.close()` → `gateway.drain()`，保证毫秒级干净退出且无未捕获 Promise 拒绝。

---

## 5. 验收门禁清单（Verification）

- [x] `npm run check`（Biome + `tsc --noEmit` + Cloudflare Worker Edge 打包检查）零错误通过。
- [x] `features/channel-gateway.feature` 新增 3 条端到端 Cucumber BDD 场景并全部通过：
  1. **跨批轮询连发防抖合并**：模拟两次连续 `pollTelegramUpdatesOnce` 在防抖窗口内拉取两句短消息，首轮立即返回不阻塞，最终合并为 1 次模型调用并投递 1 条回复；
  2. **轮询期间慢工具实时 `steer` 插话**：首轮 `pollTelegramUpdatesOnce` 触发慢工具后立即返回 `offset`，慢工具未结束时第二轮 `pollTelegramUpdatesOnce` 拉取补充要求并触发 `steer`，最终仅投递 1 条合并后的回复；
  3. **轮询期间慢工具实时 `/stop` 紧急中止**：首轮触发慢工具阻塞期间，第二轮 `pollTelegramUpdatesOnce` 拉取 `/stop` 立即掐停在途任务并回执“已停止当前在途任务。”。
- [x] `test/telegram.test.ts` 补充防抖期内 `/stop` 拦截与 `AbortSignal` 中断轮询单测，全量单测与 BDD 门禁全绿。
