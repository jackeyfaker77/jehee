# 审计与复盘-0010：Slice 6D-2 Telegram 引用/转发、`/` 指令菜单与可移植 PDF 读取验收复盘

- **关联立项**：[ADR-0018（Slice 6D-2）](../adr/0018-telegram-ux-and-portable-pdf.md)
- **执行日期**：2026-11-27
- **审计范围**：Telegram `reply_to_message`/`quote`/`forward_origin` 上下文保留、`setMyCommands` 11 条指令菜单自动注册、纯 Web 标准 `extractPdfText`（FlateDecode + `/ToUnicode` CMap），全量门禁与线上生产部署实测。

---

## 1. 设计与实现阶段前置规避的 2 项典型工程坑（Issue Traceability）

### Issue 1（向后兼容与异步边界）：同步 `formatInboundAttachmentsContext` 与 Web `DecompressionStream` 异步解压冲突
1. **现象与原始报错**：既有 `formatInboundAttachmentsContext` 为同步函数且被 `test/telegram.test.ts` 用 4 字节桩数据 `new Uint8Array([0x25, 0x50, 0x44, 0x46])` 断言返回二进制提示；而 Cloudflare Workers 与 Node 24 通用解压 `/FlateDecode` PDF 流依赖 Web 标准异步 `DecompressionStream("deflate")`，若直接将原函数改为 `async` 会破坏既有同步调用契约。
2. **根因定位**：边缘可移植运行时无同步 zlib API（`node:zlib` 在 Cloudflare Workers 打包门禁中应尽量避免以保零 Node 依赖）。
3. **修复落点**：
   - 新增独立异步模块 [`apps/jehee/src/channels/pdf-text.ts`](../../src/channels/pdf-text.ts)（`extractPdfText`）与 [`apps/jehee/src/channels/telegram.ts`](../../src/channels/telegram.ts) 中的 `formatInboundAttachmentsContextAsync`；
   - [`apps/jehee/src/channels/gateway.ts`](../../src/channels/gateway.ts)（`#admitTurn`）切换为 `await formatInboundAttachmentsContextAsync(...)`，同时保留同步 `formatInboundAttachmentsContext` 向后兼容。
4. **防复发规则**：向既有同步辅助函数引入 Web Streams 异步能力时，优先提供显式 `*Async` 变体并在网关异步边界接入，避免静默破坏同步单测与调用方。

### Issue 2（真实 PDF 边界）：`/FlateDecode` 流尾部填充字节与多字体 CID 编号冲突
1. **现象与原始报错**：真实 PDF 生成器（Chrome / WPS / Word）常在 `stream ... endstream` 尾部保留额外 `\r\n`/空字节，导致严格模式的 `DecompressionStream("deflate")` 在 flush 阶段抛异常；此外中英文混排 PDF 中不同字体常共用 `<0001>` 等低位 CID 编号，若全局混用一张 CMap 表会导致中英字符互相覆盖。
2. **根因定位**：PDF 流边界与底层 zlib EOF 不总严格对齐，且 `/ToUnicode` CMap 按字体对象（`/Font << /F1 <obj> 0 R >>`）作用域生效。
3. **修复落点**：
   - [`apps/jehee/src/channels/pdf-text.ts`](../../src/channels/pdf-text.ts)：在 `decompressWithFormat` 中保留 flush 报错前已成功产出的全部解压字节，并实现字体对象索引 `buildFontToCMapIndex` + `Tf` 算子切换当前字体 CMap（找不到时再回退合并 CMap）；
   - [`apps/jehee/test/pdf-text.test.ts`](../../test/pdf-text.test.ts)：固化「尾部填充字节 + 双字体共享 `<0001>` CID 中英混排 FlateDecode PDF」回归单测。
4. **防复发规则**：手写轻量 PDF 解析器必须同时做「zlib 尾部容错」与「按 `Tf` 字体作用域解析 `/ToUnicode` CMap」，并用真实 `CompressionStream("deflate")` 生成的压缩 PDF 验证。

---

## 2. 门禁与线上生产实测结果

| 检查项 | 执行范围与结果 | 关键量化指标 |
| :--- | :--- | :--- |
| **Jehee Biome + `tsc` + Edge 打包** | `npm --prefix apps/jehee run check` | `91` files Biome `0` 错误；`tsc --noEmit` `0` 错误；Worker bundle `2036.1 KiB` minified（`2,084,972` bytes，较 6D-1 仅增 `16.1 KiB`） |
| **单元测试（`node:test`）** | **`115/115` 通过**（`34` suites，`4.66s`） | 新增 `test/pdf-text.test.ts`（3 项：未压缩 PDF、FlateDecode + 双字体 `/ToUnicode` 中文/拉丁 + 尾部填充、加密/扫描/非法/截断）及 `test/telegram.test.ts` 引用/局部引文/4 类转发/斜杠指令兼容/`setMyCommands` 回归 |
| **Cucumber BDD 验收** | **`62/62` 场景（`393/393` 步骤）通过**（`5.10s`） | 新增 `features/telegram-ux-and-pdf.feature`（3 场景全绿） |
| **四项离线 Eval** | `eval:mcp` / `eval:memory` / `eval:handoff` / `eval:prod-memory` | 全量退出码 `0`，全部维持 `100%` 目标臂得分 |
| **工作区隔离检查** | `git status --short` | 15 个改动/新增文件全部严格位于 `apps/jehee/` 内，零上游越界 |
