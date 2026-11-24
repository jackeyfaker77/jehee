# ADR-0015：Telegram 多模态收发通道与防 SSRF 可移植 `web_fetch` 工具（Slice 6B）

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-24
- **关联需求**：[PRD](../PRD.md)、[ADR-0003](./0003-cloud-topology-and-channel-gateway.md)、[ADR-0005](./0005-runtime-entrypoints-and-opencode-go.md)、[Postmortem-0004](../evals/0004-cloudflare-workers-fetch-postmortem.md)

---

## 1. 背景与问题（Context & Problem）

截至 Slice 5D，Jehee 的 Telegram 适配器与主会话已具备稳定文本对话、写操作审批与无感换窗能力，但作为 7×24 个人常驻助手仍存在两处高频体感缺口：

1. **渠道多模态收发断层**：
   - 现有 `parseTelegramUpdate` 仅提取 `message.text ?? message.caption`，导致用户直接发送**无配文图片、文档、语音或音频**时消息被静默丢弃；
   - `ChannelTransport` 仅有 `sendText`，缺少统一的附件下载契约（`downloadFile`）与图片/文档回发契约（`sendPhoto` / `sendDocument`），也缺少将入站附件归一化为 `pi-ai` `ImageContent` 与有界文本摘录的纯函数层。
2. **公网只读网页抓取缺失**：
   - 用户经常在对话中直接丢给 Jehee 一条技术文档、公告或 JSON 接口链接，但主会话在没有外部 MCP 浏览器时无法直接读取公开网页正文；
   - 网页抓取工具必须同时兼容 **Node 24** 与 **Cloudflare Workers (`workerd`)**（零 Node 专有模块、严守 `fetch` 箭头函数包装规则），并在每次请求与重定向跳数上强制执行 **SSRF 防护**，杜绝模型被提示注入诱导探测内网或云元数据服务（如 `169.254.169.254`、`127.0.0.1`、`localhost`、`::1`）。

---

## 2. 备选方案对比（Alternatives Considered）

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：在 Telegram 适配器中引入 `node-telegram-bot-api` 或 `grammy`，网页抓取引入 `jsdom`/`cheerio` + Node `dns.lookup`** | 生态成熟 | 破坏 Cloudflare Workers `workerd` 零 Node 依赖门禁（`check:worker-bundle`），包体积暴涨且无法在边缘运行。 |
| **方案 B：网页抓取直接透传 `fetch(url)`（依赖默认 `redirect: "follow"`）** | 代码最短 | 存在严重 SSRF 漏洞：公网 URL 可通过 `302 Location: http://169.254.169.254/...` 绕过首跳 URL 校验；且未限制响应字节与正文长度，极易触发 OOM 或上下文溢出。 |
| **方案 C（最终采用）：纯 Web 标准双向多模态契约 + 手动逐跳 SSRF 校验的便携 `web_fetch` 扩展** | 100% 兼容 Cloudflare Workers 与 Node 24；`ChannelContract` 向后兼容零破坏；`FormData`/`Blob` 与 `TextDecoder`/`btoa` 零第三方依赖；`redirect: "manual"` 逐跳检验公网 URL，字节与字符双封顶 | HTML 提取采用确定性轻量正则/实体解码而非完整 DOM 排版引擎，对纯 SPA 客户端渲染页面覆盖有限（此类场景留给专门 MCP/浏览器工具）。 |

---

## 3. 决策与核心依据（Why — 为什么这么设计）

### 3.1 向后兼容的渠道多模态契约（`src/channels/contract.ts`）
- 新增 `ChannelAttachment`（`kind: "image" | "document" | "audio" | "voice"`、`fileId`、`mimeType?`、`fileName?`、`sizeBytes?`、`durationSeconds?`），以可选字段 `attachments?: readonly ChannelAttachment[]` 挂在 `InboundChannelMessage` 上。纯文本消息不填充该字段，现有调用方与测试零改动。
- 新增 `DownloadedChannelFile`、`OutboundPhotoPayload`、`OutboundDocumentPayload`，并在 `ChannelTransport` 上以可选方法形式扩展 `downloadFile?`、`sendPhoto?`、`sendDocument?`，其他渠道适配器（如 CLI、QQ）按需实现。

### 3.2 Telegram 多模态入站、有界下载与出站（`src/channels/telegram.ts`）
- **无配文附件不再丢弃**：`parseTelegramUpdate` 扩展解析 `photo`（从尺寸数组中选取最大分辨率/字节项）、`document`、`voice` 与 `audio`。当 `text` 与 `caption` 均为空但存在附件时，自动合成简明占位文本（如 `[User sent a photo]`），确保消息可顺利通过网关非空校验并附带结构化 `attachments`。
- **有界文件下载（`TelegramTransport.downloadFile`）**：两阶段调用 Telegram Bot API（`/getFile` → `/file/bot<token>/<file_path>`），默认上限 `10 MiB`。在下载前同时校验 `getFile` 返回的 `file_size` 与响应头 `content-length`，并在流式读取响应体时实时累计字节上限，防止畸形或超大文件耗尽 Worker 内存。
- **Web 标准多部分上传（`sendPhoto` / `sendDocument`）**：基于标准 `FormData` + `Blob` 构造 `multipart/form-data`，支持可选 `caption`、`reply_parameters` 与 `reply_markup`，并延续 [Postmortem-0004](../evals/0004-cloudflare-workers-fetch-postmortem.md) 规范，所有 `fetch` 调用保持独立箭头函数包装，杜绝 `workerd` 下 `TypeError: Illegal invocation`。
- **纯函数上下文整形（`formatInboundAttachmentsContext`）**：
  - 图片附件（`kind === "image"` 或 `image/*` 光栅图）通过分块 `btoa`（避免大数组 `String.fromCharCode` 栈溢出）转为 `pi-ai` 标准 `ImageContent`（`{ type: "image", data, mimeType }`）；
  - 可读文本类文档（`text/*`、`application/json`、`text/markdown`、`text/csv` 及常见源码/配置后缀）解码为 UTF-8 并按字符上限截断（默认 `12_000` 字符）；
  - 语音/音频与未知二进制文档输出清晰降级说明，提示当前未配置 ASR 或无法直接按纯文本解析。

### 3.3 防 SSRF 可移植 `web_fetch` 与 `jehee.web` 扩展（`src/web/*`）
- **严格 SSRF 护栏（`validatePublicHttpUrl`）**：
  - 仅允许 `http:` 与 `https:` 协议；
  - 拦截 `localhost`、`*.localhost`、`*.local`、`*.internal`；
  - 拦截非公网 IPv4：`0.0.0.0/8`、`10.0.0.0/8`、`100.64.0.0/10`（CGNAT）、`127.0.0.0/8`（Loopback）、`169.254.0.0/16`（Link-Local / 云元数据）、`172.16.0.0/12`、`192.168.0.0/16`、多播与保留段；
  - 拦截非公网 IPv6：`::`、`::1`、`fc00::/7`（ULA）、`fe80::/10`（Link-Local）、`ff00::/8`，并解包 IPv4-mapped IPv6（`::ffff:0:0/96`）与 NAT64（`64:ff9b::/96`）复用同一套 IPv4 校验，防止 `http://[::ffff:127.0.0.1]` 或 `http://[::ffff:169.254.169.254]` 绕过；
  - 请求使用 `redirect: "manual"`，最多追踪 `5` 跳，每一跳的 `Location` 经相对路径解析后均重新经过 `validatePublicHttpUrl`。
- **可读正文提取与双限幅（`extractReadableWebText` / `fetchWebPage`）**：
  - 支持 `text/html`、`application/xhtml+xml`、`text/plain`、`text/markdown`、`text/csv`、`application/json`（自动格式化缩进）与 XML，拒绝二进制 MIME（如 PDF、图片、可执行流）；
  - HTML 模式保留 `<title>`，剥离 `<script>`、`<style>`、`<noscript>`、`<svg>`、`<template>` 与 HTML 注释，将块级标签转换为换行，解码常见命名与数字 HTML 实体并折叠冗余空白；
  - 默认单次流式下载上限 `512 KiB`（`maxBytes`），输出正文上限 `12_000` 字符（`maxChars`），超时默认 `15s` 并联动 `context.abortSignal`。
- **`pi-durable` 只读扩展（`src/web/extension.ts`）**：
  - 导出 `JEHEE_WEB_EXTENSION_NAME = "jehee.web"`、`JEHEE_WEB_EXTENSION_HANDLE`（供工坊子会话按需移除）与 `WEB_FETCH_TOOL = "web_fetch"`；
  - `createWebExtension(options)` 注册 `replay: "safe"` 的只读 `web_fetch` 工具，严格按 `pi-durable` 契约返回 `{ output: [...] }`。

---

## 4. 具体设计方案（How — 怎么设计）

```text
apps/jehee/
├── docs/adr/
│   └── 0015-multimodal-channels-and-web-fetch.md
├── src/
│   ├── channels/
│   │   ├── contract.ts       # ChannelAttachment、DownloadedChannelFile、OutboundPhoto/DocumentPayload 及 ChannelTransport 可选多模态方法
│   │   └── telegram.ts       # TelegramUpdate 多模态字段、parseTelegramUpdate 附件提取、downloadFile/sendPhoto/sendDocument、formatInboundAttachmentsContext
│   └── web/
│       ├── web-fetch.ts      # validatePublicHttpUrl、extractReadableWebText、fetchWebPage（纯 Web 标准，零 Node 依赖）
│       └── extension.ts      # JEHEE_WEB_EXTENSION_NAME / HANDLE、WEB_FETCH_TOOL、createWebExtension
└── test/
    ├── telegram.test.ts      # 多模态入站、有界下载、multipart 发送、strict `this === undefined` fetch 与 ImageContent 转换单测
    └── web-fetch.test.ts     # SSRF（含重定向至元数据/回环/IPv6）、HTML/JSON/纯文本提取、截断、超时、strict fetch 与 web_fetch 扩展单测
```

---

## 5. 风险、权衡与验收标准（Verification & Risks）

### 5.1 风险与缓冲
- **DNS Rebinding 边界**：纯 Web/Edge 环境中不存在同步/可控的底层 `dns.lookup` 钩子，因此静态 URL 校验覆盖所有显式内网域名后缀与 IP 字面量（含重定向链路与 IPv4-mapped IPv6）；在 Cloudflare Workers 生产环境中，出站 `fetch` 由 Cloudflare 边缘网络层额外隔离内网路由，形成纵深防护。
- **`workerd` 非法调用回归**：所有新增的 `downloadFile`、`sendPhoto`、`sendDocument` 与 `fetchWebPage` 均通过独立箭头函数包装 `fetch`，并在单元测试中注入断言 `this === undefined` 的 `strictFetch` 强制回归。
- **大图内存与上下文膨胀**：`downloadFile` 默认限制 `10 MiB`；`formatInboundAttachmentsContext` 与 `web_fetch` 分别限制文本摘录与网页正文长度，避免单条附件或网页击穿模型上下文甜点。

### 5.2 Slice 6B 验收门禁清单
- [x] `npm --prefix apps/jehee run format && npm --prefix apps/jehee run check`（Biome + `tsc --noEmit` + `check:worker-bundle`）零错误通过。
- [x] `npm --prefix apps/jehee run test:unit` 全量通过，覆盖 `test/telegram.test.ts`（含 `ChannelGateway` 附件防抖合并与失败降级隔离）与 `test/web-fetch.test.ts`（含 IPv4/IPv6/重定向 SSRF 回归）。
- [x] `npm --prefix apps/jehee run test:bdd` 全量通过，覆盖新增 `features/multimodal-and-web.feature`（无配文图片 + 文档多模态入站、单文件失败降级、`web_fetch` 公网抓取 / `169.254.169.254` SSRF 拦截 / 工坊子会话隔离）与既有 `features/mcp-connector.feature` 首轮仅 `["tool_search"]` 门禁。
