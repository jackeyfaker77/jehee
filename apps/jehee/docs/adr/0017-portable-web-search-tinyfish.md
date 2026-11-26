# ADR-0017：可移植实时联网搜索 `web_search`（TinyFish TinySearch 首发接入，Slice 6D-1）

- **状态**：Accepted
- **日期**：2026-11-27
- **所属切片**：Slice 6D-1（联网搜索闭环）
- **关联文档**：[PRD.md](../PRD.md)、[ADR-0015（Telegram 多模态与防 SSRF `web_fetch`）](./0015-multimodal-channels-and-web-fetch.md)、[Audit-0009](../evals/0009-slice-6d-web-search-postmortem.md)

---

## 1. Context（背景与约束）

完成 Slice 6B 后，Jehee 具备了防 SSRF 的只读网页抓取工具 `web_fetch`，但必须依赖用户给出精确 URL。日常个人助理（PA）高频问题（实时新闻、天气、最新框架文档、报错排查、行程与价格信息）需要模型具备「**先全网检索候选链接 → 再按需 `web_fetch` 精读正文**」的完整信息获取闭环。

约束条件：
1. **双栖零 Node 依赖**：必须同时运行在 Node 24 与 Cloudflare Workers（`workerd`），`fetch` 必须以未绑定上下文（`this === undefined`）调用，且严禁引入额外 npm SDK（防止 Worker 包体膨胀与边缘兼容隐患）。
2. **上下文与凭据安全**：返回结果条数、单条摘要长度与上游 JSON 响应字节数必须有硬上限；API Key 仅通过 `X-API-Key` 请求头传递，任何异常与上游错误文案返回模型前均须主动脱敏。
3. **稀疏首轮与工坊隔离不回退**：未配置 `TINYFISH_API_KEY` 时不向模型暴露 `web_search` 工具（保持 Slice 4 纯 MCP 首轮 `["tool_search"]` 门禁）；工坊子会话通过既有的 `JEHEE_WEB_EXTENSION_HANDLE` 自动排除 `web_search`。

---

## 2. Why（为什么选 TinyFish TinySearch + 复用 `"jehee.web"` 扩展槽）

### 2.1 搜索后端选型
- 首发接入 **TinyFish TinySearch**（`GET https://api.search.tinyfish.ai`，`X-API-Key` 鉴权）：纯 REST JSON 接口、原生支持 `domain_type`（`web`/`news`/`research_paper`）、`recency_minutes`、`after_date`/`before_date`、`include_domains`/`exclude_domains`、`language`/`location`，免费/Hobby 额度提供 `30 req/min` 且附赠起始余额，零 SDK 依赖直接 `fetch` 即可运行在 Cloudflare Workers。
- 类型层保留 `provider: "tinyfish"` 判别字段，后续若扩展 Tavily / Brave / Exa 可直接无缝挂载多后端而不破坏工具契约。

### 2.2 挂载策略
- 直接挂载在现有 `"jehee.web"` 扩展（[extension.ts](../../src/web/extension.ts)）内而非新建第二个扩展槽：
  1. `workshop/extension.ts` 已通过 `JEHEE_WEB_EXTENSION_HANDLE` 移除 `"jehee.web"`，工坊子会话天然获得 `web_fetch` + `web_search` 双工具隔离；
  2. `web_fetch` 与 `web_search` 各自独立开关（`webSearch` 仅在配置了非空 `apiKey` 时暴露），不影响纯 MCP 测试与未配置 Key 的环境。

---

## 3. How（模块边界与契约）

1. **[`src/web/web-search.ts`](../../src/web/web-search.ts)**：
   - 导出 `searchWeb(input, options)`，校验查询长度（`<= 500`）、日期格式（`YYYY-MM-DD`）、`recencyMinutes` 与非负 `page`；
   - 有界读取上游响应（上限 `512 KiB`），兼容实网 TinySearch 响应结构（顶层 `total_results`/`page` 可选、条目 `date` 兼容 ISO 与英文日期字符串、跳过缺 `title`/`url` 的畸形项）；
   - 将 HTTP `429` 映射为 `error: "rate_limited"`，并对所有上游错误文本擦除 `apiKey`。
2. **[`src/web/extension.ts`](../../src/web/extension.ts)**：
   - 导出 `WEB_SEARCH_TOOL = "web_search"` 与 `CreateWebSearchToolOptions`；
   - 将 `web_search`（`replay: "safe"`）注册至 `"jehee.web"`，并在描述中显式引导模型配合 `web_fetch` 精读具体链接。
3. **运行时装配（[`src/runtime/config.ts`](../../src/runtime/config.ts)、[`src/core/host.ts`](../../src/core/host.ts)、[`worker.ts`](../../worker.ts)、[`src/runtime/node.ts`](../../src/runtime/node.ts)）**：
   - 环境变量：`TINYFISH_API_KEY`（通过 `wrangler secret put` 加密配置，禁止入库），可选 `TINYFISH_SEARCH_BASE_URL`、`JEHEE_WEB_SEARCH_LANGUAGE`、`JEHEE_WEB_SEARCH_LOCATION`。

---

## 4. Verification & Risks（验收清单）

- [x] 单测（`test/web-search.test.ts`）：参数序列化、实网响应形态（无 `total_results`/`page` + 混合 `date`）、条数/摘要截断、HTTP `429` 与 `apiKey` 脱敏、超时、严格 `this === undefined` `fetch`、`parseJeheeEnvConfig` 与 `JeheeHost` `web_search -> web_fetch` 串联。
- [x] BDD（`features/web-search.feature`）：`web_search -> web_fetch` 完整闭环与 `429 rate_limited` 零凭据泄漏。
- [x] 实网联调与部署：直接实测 `GET https://api.search.tinyfish.ai` 验证真实响应契约，配置 Cloudflare Secret `TINYFISH_API_KEY` 并发布 Worker 完成 Telegram 真机联网搜索验收。
