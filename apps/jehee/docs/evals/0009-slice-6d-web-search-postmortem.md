# 审计与复盘-0009：Slice 6D-1 `web_search`（TinyFish TinySearch）实网联调与问题复盘

- **关联立项**：[ADR-0017（Slice 6D-1：可移植实时联网搜索 `web_search`）](../adr/0017-portable-web-search-tinyfish.md)
- **执行日期**：2026-11-27
- **审计范围**：TinyFish TinySearch 实网 API 探针、双栖 `web_search` 客户端与 `"jehee.web"` 扩展集成、单测/BDD/边缘打包/仓根门禁，以及 Cloudflare Secret 加密上线与线上真机验证。

---

## 1. 全过程捕获的 2 项非平凡问题与四要素复盘（Mandatory Issue Traceability）

### Issue 1（Mock vs Live 契约偏差）：TinyFish TinySearch 实网响应结构与公开文档存在字段差异
1. **现象与原始报错**：联网文档声称 `GET https://api.search.tinyfish.ai` 顶层固定返回 `{ query, total_results, page, results }` 且条目字段为 `{ position, site_name, title, snippet, url }`；但首次以真实 `TINYFISH_API_KEY` 实网探测 `GET https://api.search.tinyfish.ai?query=Cloudflare+Workers+Durable+Objects&language=en` 时，实际返回顶层**不含** `total_results` 与 `page`，而每条 `results[i]` 额外包含异构格式的 `date` 字段（同时出现 ISO-8601 `"2026-11-21T00:26:58Z"` 与英文自然日期 `"Oct 12, 2026"`）。
2. **根因定位**：第三方搜索 API 线上演进常先于公开摘要文档更新；若离线单测仅按文档 Schema 编写强校验（如强制要求 `total_results` 为 number），上线后会直接把全部正常搜索结果误判为 `invalid_response`。
3. **修复落点**：
   - [`apps/jehee/src/web/web-search.ts`](../../src/web/web-search.ts)（`parseTinySearchResponse`）：仅强制校验 `results` 数组存在，将顶层 `total_results`/`page` 与条目 `date`/`site_name`/`position` 全部作为可选字段解析，保留原始 `date` 字符串供模型判断时效性，并安全跳过缺少 `title`/`url` 的异常条目；
   - [`apps/jehee/test/web-search.test.ts`](../../test/web-search.test.ts)：将实网响应样本（缺 `total_results`/`page` 且混含 ISO 与英文日期）固化为回归单测。
4. **防复发规则**：凡接入外部 HTTP/LLM/搜索 API，写解析器前必须先以真实凭据做一次最小只读实网探测并比对实际 JSON；解析器只对业务必需核心字段做强断言，元信息字段一律按可选防御解析。

### Issue 2（浏览器认证边界）：嵌入式 Webview 触发 Google OAuth 出现白屏且无法自动完成登录
1. **现象与原始报错**：在内置浏览器中打开 `https://agent.tinyfish.ai/api-keys` 并尝试通过 Google OAuth 登录时，弹窗标签页 `accounts.google.com/signin/oauth/id` 停留在白屏，控制台记录 `[GSI_LOGGER]: Failed to display picker. The list of sessions received from the server was empty.`，TinyFish 主标签页仍重定向回 `/sign-in`。
2. **根因定位**：Google Identity Services（GSI）在隔离的嵌入式浏览器会话中无宿主机 Google Cookie 且对嵌入式 Webview OAuth 回调窗口存在兼容限制。
3. **修复落点**：
   - 引导用户改用邮箱/GitHub 或在登录页完成授权跳转至 `https://agent.tinyfish.ai/api-keys` 后，由浏览器子代理从活动标签页读取已授权的控制台与 API Key；
   - 凭据仅通过 `wrangler secret put TINYFISH_API_KEY` 加密写入 Cloudflare Worker，严禁写入源码或提交至 Git。
4. **防复发规则**：内置浏览器自动化遇到第三方登录页（尤其是 Google OAuth）白屏或会话空列表时，优先建议邮箱/GitHub 登录或在宿主机常规浏览器完成认证，不尝试绕过身份校验。

---

## 2. 门禁与线上真机验收结果

| 检查项 | 执行范围与结果 | 关键量化指标 |
| :--- | :--- | :--- |
| **Jehee Biome + `tsc` + Edge 打包** | `npm --prefix apps/jehee run check` | `88` files Biome `0` 错误；`tsc --noEmit` `0` 错误；Worker bundle `2020.0 KiB` minified（`2,068,497` bytes） |
| **单元测试（`node:test`）** | **`111/111` 通过**（`33` suites，`5.73s`） | 新增 `test/web-search.test.ts`（覆盖 TinySearch 参数、实网 JSON 结构、`429` 与 `apiKey` 脱敏、超时、严格 `this === undefined` `fetch`、`parseJeheeEnvConfig` 与 `web_search -> web_fetch` 串联） |
| **Cucumber BDD 验收** | **`59/59` 场景（`382/382` 步骤）通过**（`5.60s`） | 新增 `features/web-search.feature`（2 场景）；Slice 4 首轮纯 MCP 仅 `["tool_search"]` 门禁零回归 |
| **四项离线 Eval** | `eval:mcp` / `eval:memory` / `eval:handoff` / `eval:prod-memory` | 全量退出码 `0`，全部维持 `100%` 目标臂得分 |
| **Cloudflare Secret & 生产部署** | `wrangler secret put TINYFISH_API_KEY` + `wrangler deploy` | Version ID：`e4b43ffe-2dc6-4133-ba3a-d9315434fa8c`（上传 `4578.61 KiB` / gzip `768.39 KiB`，启动 `22 ms`）；`GET /health` 返回 `{"ok":true,"busy":false}` |
| **Telegram 线上真机实测** | 真机提问 + `/trace` 决策树核验 | `[Trace #7]` 实测调用 `tool.name="web_search"`（`1508ms`，`outcome="done"`，`turns=2`，`tools=1`，`err=0`，`wall=6019ms`，`cost=\$0.002478`），准确返回 Cloudflare Docs 真实链接与 `date` 更新时间 |
