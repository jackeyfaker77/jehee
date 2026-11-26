# ADR-0018：Telegram 引用/转发上下文保留、`/` 指令菜单自动注册与边缘可移植 PDF 文本读取（Slice 6D-2）

- **状态**：Accepted
- **日期**：2026-11-27
- **所属切片**：Slice 6D-2（Telegram 顺手度与 PDF 读取闭环）
- **关联文档**：[PRD.md](../PRD.md)、[ADR-0015（Telegram 多模态收发）](./0015-multimodal-channels-and-web-fetch.md)、[Audit-0010](../evals/0010-slice-6d-2-telegram-pdf-postmortem.md)

---

## 1. Context（背景与约束）

完成 Slice 6B/6C/6D-1 后，日常在 Telegram 中把 Jehee 当私人助理高频使用时，仍有三项顺手度断层：
1. **引用回复与转发来源丢失**：用户引用某条旧消息说“改到明天”或转发一篇文章/通知时，`parseTelegramUpdate` 只取 `text`/`caption`，模型不知道被引用原文和转发来源；
2. **输入 `/` 无补全菜单**：11 个内置指令需要靠记忆手敲，尚未调用 Telegram Bot API `setMyCommands` 注册；
3. **PDF 账单/行程单无法读取**：`application/pdf` 被视为不可读二进制附件跳过，但 Cloudflare Workers（`workerd`）边缘运行时又不能引入依赖 Node/Canvas 的重型 PDF 库（如 `pdf.js` 完整包）。

---

## 2. Why（设计取舍）

1. **元数据与正文解耦，绝不破坏斜杠指令**：
   - 在 `InboundChannelMessage` 上新增可选 `replyContext` 与 `forwardContext` 字段，保持 `message.text` 纯净。这样当用户引用某条旧消息回复 `/status` 或 `/stop` 时，`ChannelGateway` 仍能准确命中确定性斜杠指令；普通对话则在入队（直通、忙时 `steer`、防抖合并）前由 `formatInboundMessageContextPrefix` 注入结构化前缀。
2. **`setMyCommands` 异步非阻塞注册**：
   - 在 `JeheeSessionDO` 冷启动时通过 `ctx.waitUntil(telegramTransport.setMyCommands().catch(() => undefined))` 注册 11 条命令，既确保 Cloudflare 不会提前终止后台请求，又对 `blockConcurrencyWhile` 零阻塞，且容忍瞬态网络异常。
3. **零依赖纯 Web 标准 PDF 文本提取器（`src/channels/pdf-text.ts`）**：
   - 使用 Node 24 与 Cloudflare Workers 原生内置的 `DecompressionStream("deflate")` 解压 `/FlateDecode` 流，配合字体级 `/ToUnicode` CMap（`beginbfchar` / `beginbfrange`）解码中英文 CID 字体与 UTF-16BE BOM 字符串，仅增数 KB 包体且零外部依赖；对加密 PDF（`/Encrypt`）与纯扫描图片 PDF（无 `BT..ET` 文本层）明确给出可读降级说明，并设置单流 2 MiB / 总计 4 MiB 解压上限防御压缩炸弹。

---

## 3. How（模块边界）

- [`src/channels/pdf-text.ts`](../../src/channels/pdf-text.ts)：导出 `extractPdfText(bytes, options)`，支持未压缩与 `/FlateDecode` 流（含 zlib 尾部填充容错）、字体级 `/ToUnicode` CMap、`Tj`/`TJ`/`'`/`"`/`Td`/`TD`/`Tm`/`T*`、UTF-16BE BOM 与字数截断。
- [`src/channels/contract.ts`](../../src/channels/contract.ts)：新增 `InboundReplyContext` 与 `InboundForwardContext`。
- [`src/channels/telegram.ts`](../../src/channels/telegram.ts)：解析 `reply_to_message` / `quote` / `forward_origin`（4 类 Bot API 7.0+ 变体）及旧版 `forward_*` 字段；新增 `formatInboundMessageContextPrefix`、`formatInboundAttachmentsContextAsync`、`JEHEE_TELEGRAM_COMMANDS`（11 项）与 `TelegramTransport.setMyCommands`。
- [`src/channels/gateway.ts`](../../src/channels/gateway.ts)：在不破坏斜杠指令前提下为普通/插话/防抖消息注入引用与转发上下文，并切换至 `formatInboundAttachmentsContextAsync` 自动解析 PDF。
- [`worker.ts`](../../worker.ts) & [`src/runtime/node.ts`](../../src/runtime/node.ts)：启动时自动非阻塞注册 Telegram 指令菜单。

---

## 4. Verification（验收清单）

- [x] 单测（`test/pdf-text.test.ts` + `test/telegram.test.ts`）：未压缩 PDF、FlateDecode + 多字体 `/ToUnicode` 中文/拉丁 PDF、zlib 尾部填充容错、加密/扫描/非法 PDF 降级、引用/局部引文/4 类转发来源保留、引用回复不破坏 `/status`、`setMyCommands` 契约与严格 `this === undefined` `fetch`。
- [x] BDD（`features/telegram-ux-and-pdf.feature`）：3 个端到端场景全绿。
- [x] 全量门禁 + Cloudflare 线上部署 + Telegram 真机验证 `/` 指令菜单与引用回复。
