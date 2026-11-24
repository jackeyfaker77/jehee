# 审计与复盘-0007：Slice 6A + 6B 联合集成审计、全量门禁实测与 4 项审查缺陷复盘

- **关联立项**：[ADR-0014（Slice 6A：主动定时提醒、周期例行任务、时钟锚点、持久化路由与 DO Alarm 守护）](../adr/0014-proactive-routines-and-clock.md)、[ADR-0015（Slice 6B：Telegram 多模态收发通道与防 SSRF 可移植 `web_fetch`）](../adr/0015-multimodal-channels-and-web-fetch.md)
- **执行日期**：2026-11-25
- **审计范围**：Slice 6A 与 Slice 6B 合并集成后的完整工作区门禁（格式、类型、Edge Worker 打包、全量单测、全量 BDD、四项离线 Eval、仓根 `npm run check`），以及审校阶段捕获并修复的 4 项真实缺陷的四要素问题留痕。

---

## 1. 联合集成交付与门禁实测总览

Slice 6A 与 Slice 6B 合并并完成 `JeheeHost`、`ChannelGateway`、`Workshop` 隔离与公共导出集成后，全部自动化门禁退出码均为 `0`：

| 检查项 | 执行范围与结果 | 关键量化指标 |
| :--- | :--- | :--- |
| **Jehee Biome 格式化与静态检查** | `npm --prefix apps/jehee run format && check` | `79` files checked，`0` 错误，`0` 警告 |
| **Jehee TypeScript 类型检查** | `tsc --noEmit`（严格模式 + 可擦除语法） | `0` 编译错误 |
| **Cloudflare Worker 边缘打包门禁** | `scripts/check-worker-bundle.ts`（`platform: "browser"`） | **`1989.9 KiB` minified（`2,037,681` bytes）**；零 `node:sqlite` 与 `node:child_process` 残留 |
| **单元测试（`node:test`）** | **`79/79` 通过**（`26` suites，耗时 `5.33s`） | 覆盖 Routines 纯算法/重启/冷唤醒/故障隔离、Telegram 多模态收发/网关防抖与失败隔离、`web_fetch` IPv4/IPv6/重定向 SSRF 与严格 `this === undefined` |
| **Cucumber BDD 验收** | **`53/53` 场景（`350/350` 步骤）全部通过**（耗时 `6.27s`） | 新增 `routines.feature`（4 场景）与 `multimodal-and-web.feature`（3 场景）；`mcp-connector.feature` 首轮仅 `["tool_search"]` 门禁零回归 |
| **离线 Eval-0001（`eval:mcp`）** | `evals/mcp-exposure-eval.ts` 4 组通过 | Arm C（`deferred + $jehee_blob`）`100%` 通过，相对 Arm A Prefill 降 **`89.2%`**（`127,450 -> 13,780`），参考成本降 **`85.7%`**（`\$0.03495 -> \$0.00500`） |
| **离线 Eval-0002（`eval:memory`）** | `evals/memory-eval.ts` 3 臂通过 | `StaticCore 14.3%` -> `AtomicMemory (5C-1) 57.1%` -> `Consolidated (5C-2) 100%` |
| **离线 Eval-0003（`eval:handoff`）** | `evals/handoff-eval.ts` 2 臂通过 | `No-Handoff 33.3%` -> `Seamless Handoff (5D) 100%`（活跃窗口 `1812 -> 138` tok） |
| **离线 Eval-0004（`eval:prod-memory`）** | `evals/prod-memory-switch-eval.ts` 2 臂通过 | `BEFORE (static-core) 33.3%` -> `AFTER (atomic + idle 10m) 100%`（`Turn1Prefill +623` tok，空闲定时器 `600000ms`） |
| **仓根全量门禁（`npm run check`）** | 根目录 Biome + 依赖锁定 + TS 相对导入 + 全仓类型检查 | 零错误、零警告，且全部改动严格限定在 `apps/jehee/` 内 |

### 关键集成不变量核验
1. **纯 MCP 首轮稀疏门禁未被破坏**：`JeheeHost` 中 `enableRoutineTools` 与 `enableWebFetch` 均默认受 `options.enableRoutines === true || options.memory?.atomic !== undefined || options.handoff !== undefined` 门控（同时允许调用方通过 `options.extensions` 注入自定义 `"jehee.web"` 扩展而不被内置默认槽位覆盖），确保 Slice 4 纯 MCP 场景首轮可见工具仍严格等于 `["tool_search"]`。
2. **工坊子会话最小权限隔离**：内置工坊子会话配置（`src/workshop/extension.ts`）同时移除 `JEHEE_ROUTINES_EXTENSION_HANDLE` 与 `JEHEE_WEB_EXTENSION_HANDLE`，并在 `test/routines.test.ts` 与 `features/multimodal-and-web.feature` 中端到端断言。
3. **多模态附件全链路零丢失**：`ChannelGateway` 在直通（`debounceMs === 0`）、忙时插话（`whenBusy: "steer"`）与防抖合并（`CoalesceBucket`）三条入站路径均完整保留 `attachments`，单文件下载异常时写入 `[Attachment download failed ...]` 降级提示而不丢弃整条消息，并向 `JeheeHost.submitMessage` 传递 `images?: readonly ImageContent[]`（无图时保持纯字符串 `content`，有图时转为 multipart 数组）。

---

## 2. 审校捕获的 4 项真实缺陷与四要素复盘（Mandatory Issue Traceability）

以下 4 项缺陷均在并行交付后的独立代码审校阶段被精准捕获、修复并补充了自动化回归测试：

### Issue 1（Slice 6B）：IPv6 特殊地址段与 IPv4 嵌入形式绕过 `web_fetch` SSRF 校验
1. **现象与原始表现**：审校检查 `validatePublicHttpUrl` 发现，以下非公网或内嵌回环/云元数据 IPv4 的 IPv6 地址均返回 `{ ok: true }` 未被 `ssrf_blocked` 拦截：
   - 废弃的 IPv4-compatible IPv6（`::/96`）：`http://[::127.0.0.1]/`、`http://[::169.254.169.254]/`、`http://[::7f00:1]/`；
   - IPv4-translated IPv6（`::ffff:0:0:0/96`）：`http://[::ffff:0:127.0.0.1]/`、`http://[::ffff:0:169.254.169.254]/`；
   - 本地 NAT64（`64:ff9b:1::/48`）：`http://[64:ff9b:1::127.0.0.1]/`；
   - 6to4 嵌入私有 IPv4（`2002::/16`）：`http://[2002:7f00:0001::]/`、`http://[2002:a9fe:a9fe::]/`；
   - 废弃 site-local（`fec0::/10`）与丢弃专用段（`100::/64`）：`http://[fec0::1]/`、`http://[100::1]/`。
2. **根因定位**：初版 `classifyBlockedIpv6` 仅覆盖了 `::`、`::1`、`fc00::/7`、`fe80::/10`、`ff00::/8` 以及 `::ffff:0:0/96` 与 `64:ff9b::/96`，遗漏了 RFC 规定的其余 IPv4 嵌入过渡段与特殊保留前缀；初版单测只验证了标准 `::1` 与 `::ffff:127.0.0.1`，未覆盖上述变体及八进制/十六进制/缩写 IPv4（`0177.0.0.1`、`0x7f000001`、`127.1`）。
3. **修复落点**：
   - [`apps/jehee/src/web/web-fetch.ts`](../../src/web/web-fetch.ts)（`classifyBlockedIpv6`）：显式封禁 `::/96`、`100::/64`、`fec0::/10`、`::ffff:0:0:0/96`、`64:ff9b:1::/48`，并对 `2002::/16`（6to4）提取 `groups[1..2]` 复用 `classifyBlockedIpv4` 校验；
   - [`apps/jehee/test/web-fetch.test.ts`](../../test/web-fetch.test.ts)：补充全部 IPv6 绕过变体与八进制/十六进制/缩写 IPv4 回归用例。
4. **防复发规则**：凡涉及 SSRF IP 过滤器的实现，必须对照 IANA IPv4/IPv6 Special-Purpose Address Registry 逐项覆盖所有过渡/嵌入前缀（`::/96`、`::ffff:0:0/96`、`::ffff:0:0:0/96`、`64:ff9b::/96`、`64:ff9b:1::/48`、`2002::/16`）并在单测中枚举八进制、十六进制与缩写形式。

### Issue 2（Slice 6B）：下载图片 MIME 优先级倒置与 `image/svg+xml` 误走视觉通道
1. **现象与原始表现**：
   - 将 `parseTelegramUpdate` 解析出的图片附件与 `downloadFile` 返回的真实 `image/png` 文件传入 `formatInboundAttachmentsContext` 时，输出 `ImageContent.mimeType` 被错误标为 `"image/jpeg"`（而非 `"image/png"`），在 Anthropic 等严格校验魔数字节的视觉 API 上会触发 `image media type mismatch` 报错；
   - 当 `kind === "image"` 的附件实际为 `image/svg+xml` 时，误输出为 `ImageContent`（主流多模态视觉 API 仅接受光栅图 `jpeg/png/webp/gif`），未能回退到文本摘录通道。
2. **根因定位**：Telegram `PhotoSize` 对象本身不携带 MIME，因此 `parseTelegramUpdate` 只能填默认猜测值 `mimeType: "image/jpeg"`；而 `formatInboundAttachmentsContext` 初版优先取了 `att.mimeType` 再回退 `file.mimeType`，导致猜测值压过了下载响应头与 `file_path` 扩展名推断出的真实 MIME。同时分支条件仅判断 `att.kind === "image" || effectiveMime.startsWith("image/")`，未将 `image/svg+xml` 从光栅图集合中排除。
3. **修复落点**：
   - [`apps/jehee/src/channels/telegram.ts`](../../src/channels/telegram.ts)（`formatInboundAttachmentsContext`）：调整优先级为优先采用 `downloadFile` 观测到的非 `application/octet-stream` 具体 MIME（`fileMime`），其次再回退 `attMime`；并将视觉图片分支严格收窄至 `RASTER_VISION_IMAGE_MIMES`（`jpeg`/`jpg`/`png`/`webp`/`gif`），使 `image/svg+xml` 自动落入可读文本文档摘录分支；
   - [`apps/jehee/test/telegram.test.ts`](../../test/telegram.test.ts)：新增将 `parseTelegramUpdate` 图片与下载 `image/png`、以及 `image/svg+xml` 配对校验的回归测试。
4. **防复发规则**：多模态附件元数据合并必须遵循「传输下载观测到的真实字节/响应头 MIME 优先于入站信封默认猜测值」原则，且发往模型 `ImageContent` 的 MIME 必须使用显式光栅白名单而非 `image/*` 前缀匹配。

### Issue 3（Slice 6A）：冷重启或 Cloudflare DO 休眠唤醒时过早 `harness.resume()` 导致到期提醒静默丢失
1. **现象与原始表现**：当一条 `once` 类型的 `direct_notify` 提醒在宿主关闭/DO 休眠期间到期，随后重开宿主并装配 `ChannelGateway` 时，提醒被调度器消费推进且 `RoutineDoc` 标记已执行，但 Telegram 侧收到 **0 条**消息（静默丢单）。
2. **根因定位**：`JeheeHost.open` 末尾此前无条件调用 `harness.resume()`；而 `JeheeSessionDO`（`worker.ts`）与 `assembleNodeRuntime`（`src/runtime/node.ts`）均在 `await JeheeHost.open(...)` 返回**之后**才构造 `ChannelGateway`（注册 `onDirectNotify` / `onProactiveReply` 监听器）并注册 `TelegramTransport`。因此冷唤醒瞬间，`RoutineSchedulerTask` 在监听器与传输器尚未就绪前便已唤醒、在 SQLite 事务中原子认领并禁用了到期 `once` 任务，随后向空的 `#directNotifyListeners` 集合派发完毕。
3. **修复落点**：
   - [`apps/jehee/src/core/host.ts`](../../src/core/host.ts)：在 `JeheeHostOptions` 新增可选 `readonly autoResume?: boolean`（默认 `true`），当 `options.autoResume === false` 时跳过 `JeheeHost.open` 内的即时 `harness.resume()`；
   - [`apps/jehee/worker.ts`](../../worker.ts) 与 [`apps/jehee/src/runtime/node.ts`](../../src/runtime/node.ts)：装配宿主时传入 `autoResume: false`，待 `ChannelGateway` 构造与 `TelegramTransport` 注册全部完成后再显式调用 `host.resume()`；
   - [`apps/jehee/test/routines.test.ts`](../../test/routines.test.ts)：新增 SQLite 冷重启回归用例（在宿主关闭期间令 `once` 提醒过期 -> 以 `autoResume: false` 重开 -> 挂载网关与传输器 -> 调用 `host.resume()` -> 断言 0 LLM 调用且成功送达 `LastRouteDoc` 持久化路由）。
4. **防复发规则**：任何在进程启动/DO 唤醒阶段会驱动外部监听器副作用的持久化后台任务，宿主初始化必须支持延迟恢复（`autoResume: false`），并严格遵循「打开宿主 -> 挂载全部网关监听器与传输器 -> 显式 `resume()`」的启动时序，且必须配有关停期间任务过期的真实冷重启测试。

### Issue 4（Slice 6A）：单次出站瞬态异常永久击穿单活 `RoutineSchedulerTask`
1. **现象与原始表现**：当同一批次或连续周期中某条提醒的出站推送抛出异常（如 Telegram API 瞬态 `500` 或网络抖动：`Error: Telegram sendMessage failed (500)`）时，`RoutineSchedulerTask` 立即进入 `pi-durable` 的 `status: "faulted"` 终态，导致同批次剩余提醒以及后续所有 `daily`/`weekly`/`interval` 例行任务全部停止调度，直到用户手动新增或删除任务才被动重建。
2. **根因定位**：`RoutineSchedulerTask` 的 `phases.dispatch` 直接 `await dispatchRoutineExecution(...)` 而未捕获非取消类异常；根据 `pi-durable` 调度器契约，未捕获的 phase 异常会将整个任务标记为 `faulted` 终态。由于 `jehee.routines.scheduler` 是全会话唯一的单活调度任务，单条提醒的瞬态网络报错直接扩大为全局调度器停摆。
3. **修复落点**：
   - [`apps/jehee/src/routines/extension.ts`](../../src/routines/extension.ts)：`dispatchRoutineExecution` 在 `catch` 中向 `jehee.routine.fire` Span 记录 `routine.outcome: "error"` 与错误状态后重抛；`RoutineSchedulerTask` 的 `phases.dispatch` 捕获所有非中止错误（仅在 `runtime.signal.aborted || context.abortSignal?.aborted` 时向上抛出），继续推进 `index` 并在批次结束后安全回到 `wait` 阶段调度后续任务；
   - [`apps/jehee/test/routines.test.ts`](../../test/routines.test.ts)：新增故障隔离回归测试，模拟首条提醒 `sendText` 抛出瞬态异常，断言首条产出 `jehee.routine.fire` error Span 且后续第二条提醒仍按期成功送达。
4. **防复发规则**：凡 `pi-durable` 单活后台守护任务（调度器、整理器、轮询器）在派发外部 I/O 副作用时，必须在单条作业粒度做异常隔离并写入 Telemetry Error Span，严禁让单条外部网络失败把共享守护任务打入 `faulted` 终态。

---

## 3. 在线真机边界说明

本次 Slice 6A + 6B 集成审计未向公网发起真实 Telegram Bot / 外部 LLM 扣费调用（离线门禁与 4 项 Eval 均基于确定性 `fauxProvider` 与受控 `fetchImpl` 完成全链路验证）。待部署至 Cloudflare Workers 或接入真实凭证后，可在生产环境补跑一轮真实 Telegram 图片/文档收发、公网 `web_fetch` 与 DO Alarm 定时提醒冒烟验证并按需追加真机实测记录。
