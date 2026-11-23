# 复盘-0004：Cloudflare Workers 首次上线 `TelegramTransport` / `InstaBoxClient` `fetch` 非法调用故障

- **关联立项**：[ADR-0003](../adr/0003-cloud-topology-and-channel-gateway.md)、[ADR-0004](../adr/0004-instabox-cloud-workshop.md)、[ADR-0005](../adr/0005-runtime-entrypoints-and-opencode-go.md)
- **执行日期**：2026-11-24
- **验证环境**：Cloudflare Workers Free (`jehee-bot.jehee-bot.workers.dev`) + Telegram Webhook (`@jehee3_bot`)

---

## 1. 现象与原始报错（Symptom & Raw Error）

首次将 `jehee-bot` 部署至 Cloudflare Workers 并完成 `setWebhook` 后，`GET /health` 返回 `200 {"ok":true,"busy":false}`，但在 Telegram 私聊发送 `/status` 与 `你好` 无任何回复。

1. **Telegram `getWebhookInfo` 原始返回**：
   ```json
   {
     "pending_update_count": 2,
     "last_error_message": "Wrong response from the webhook: 500 Internal Server Error"
   }
   ```
2. **Cloudflare `wrangler tail` 原始堆栈**：
   ```text
   POST https://jehee-bot.jehee-bot.workers.dev/webhook/telegram - Exception Thrown
   X [ERROR] TypeError: Illegal invocation: function called with incorrect `this` reference.
         at TelegramTransport.sendText (src\channels\telegram.ts:168:32)
         at #deliverOutbound (src\channels\gateway.ts:607:19)
         at #handleCommand (src\channels\gateway.ts:386:14)
         at async ChannelGateway.ingest (src\channels\gateway.ts:212:20)
         at async handleTelegramWebhook (src\channels\telegram.ts:227:3)
   ```

---

## 2. 根因定位（Root Cause）

1. **错误绑定 `this` 触发 `workerd` Web IDL 校验**：
   `TelegramTransport` 与同类 HTTP 客户端 `InstaBoxClient` 在构造函数中直接保存了 `this.#fetch = options.fetchImpl ?? globalThis.fetch`，随后以成员方法形式调用 `this.#fetch(...)`。在 JavaScript 语义下，这会把 `this` 绑定为 `TelegramTransport` / `InstaBoxClient` 实例而非 `globalThis`。Cloudflare Workers（`workerd`）对 `globalThis.fetch` 严格执行 Web IDL receiver 校验，因此直接抛出 `TypeError: Illegal invocation`。
2. **为什么离线单测与本机真机未拦截到**：
   - Node 24 的 `undici` 实现对 `globalThis.fetch` 不强制校验 `this` receiver，因此本机 `start:telegram` 真机与默认单测全部通过；
   - 现有单测注入的 mock `fetchImpl` 均为箭头函数，不依赖 `this`，未模拟 `workerd` 的严格 receiver 检查。

---

## 3. 修复落点（Fix Location）

1. **[src/channels/telegram.ts](../../src/channels/telegram.ts)**：在 `TelegramTransport` 构造函数中改为通过箭头函数包装调用（`customFetch !== undefined ? (input, init) => customFetch(input, init) : (input, init) => globalThis.fetch(input, init)`），确保 `fetch` 永远不以类实例作为 `this` 调用。
2. **[src/workshop/instabox-client.ts](../../src/workshop/instabox-client.ts)**：对同类 `InstaBoxClient` 同步应用相同修复，避免云工坊在 Cloudflare Workers 唤醒时触发同样故障。
3. **[test/telegram.test.ts](../../test/telegram.test.ts)** 与 **[test/workshop.test.ts](../../test/workshop.test.ts)**：新增严格 receiver 回归单测（`strictFetch` 在 `this !== undefined` 时抛出 `TypeError("Illegal invocation")`），覆盖 `sendTyping` / `sendText` / `answerCallback` 与 `getMachine`。
4. **[wrangler.jsonc](../../wrangler.jsonc)**：同步线上默认模型为 `opencode-go/deepseek-v4.1-flash`。

---

## 4. 防复发规则（Prevention Rule）

- **禁止裸存 `globalThis.fetch` 作为对象属性/私有字段直接调用**：所有双栖（Node + Cloudflare Workers）HTTP 客户端必须通过 `(input, init) => globalThis.fetch(input, init)`（或对自定义 `fetchImpl` 同样包装为独立函数调用）剥离实例 `this`。
- **单测模拟 `workerd` 严格 receiver**：凡接受 `fetchImpl` 的跨平台客户端类，单测必须包含一条断言 `this === undefined` 的普通函数 `strictFetch` 用例。
- **线上真机闭环验证**：首次或改动 Worker 运行时边界后，必须结合 `wrangler tail` 与真实 Webhook 流量确认 `200 Ok` 与 `pending_update_count: 0`，不得仅以 Node 单测或 `/health` 代替出站链路验证。
