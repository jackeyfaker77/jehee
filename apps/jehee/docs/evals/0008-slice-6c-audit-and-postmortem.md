# 审计与复盘-0008：Slice 6C 联合集成审计、全量门禁实测与 5 项缺陷复盘

- **关联立项**：[ADR-0016（Slice 6C：静默时段持久化自动补发、MCP 自愈重连、运行时模型热切与出站富媒体交付）](../adr/0016-resilient-pa-ops-and-outbound-media.md)
- **执行日期**：2026-11-26 ～ 2026-11-27
- **审计范围**：Slice 6C 两条并行开发分支（`ops6c` 与 `mcp6c`）经 `ver6c` 独立审校后合入主工作区并完成 `JeheeHost`、`ChannelGateway`、`Workshop`、`worker.ts`、`node.ts` 与公共导出集成的全量自动化门禁（格式、类型、Edge Worker 打包、全量单测、全量 BDD、四项离线 Eval、仓根 `npm run check`），以及全过程暴露的 5 项典型缺陷（含 Windows worktree 清理跨越 NTFS Junction 误删根工作区上游包）的四要素问题留痕。

---

## 1. 联合集成交付与门禁实测总览

Slice 6C 完成全链路集成与回归补强后，全部自动化门禁退出码均为 `0`：

| 检查项 | 执行范围与结果 | 关键量化指标 |
| :--- | :--- | :--- |
| **Jehee Biome 格式化与静态检查** | `npm --prefix apps/jehee run format && check` | `85` files checked，`0` 错误，`0` 警告 |
| **Jehee TypeScript 类型检查** | `tsc --noEmit`（严格模式 + 可擦除语法） | `0` 编译错误 |
| **Cloudflare Worker 边缘打包门禁** | `scripts/check-worker-bundle.ts`（`platform: "browser"`） | **`2014.3 KiB` minified（`2,062,604` bytes）**；零 `node:sqlite` 与 `node:child_process` 残留 |
| **单元测试（`node:test`）** | **`107/107` 通过**（`31` suites，耗时 `4.25s`） | 新增 `test/quiet-autoflush.test.ts`、`test/outbound-media.test.ts`、`test/slice-6c-integration.test.ts` 及 `test/mcp.test.ts` 脱敏/LRU 回归，覆盖跨夜/负偏移/半小时偏移静默边界、事务级唤醒防丢、Staging 锁、工坊隔离、失败静默补发保留重试与并发 `reconnectMcp` 串行化 |
| **Cucumber BDD 验收** | **`57/57` 场景（`373/373` 步骤）全部通过**（耗时 `4.44s`） | 新增 `features/pa-ops-and-media.feature`（4 场景）；既有 `features/mcp-connector.feature` 首轮仅 `["tool_search"]` 门禁零回归 |
| **离线 Eval-0001（`eval:mcp`）** | `evals/mcp-exposure-eval.ts` 4 组通过 | Arm C（`deferred + $jehee_blob`）`100%` 通过，相对 Arm A Prefill 降 **`89.2%`**（`127,450 -> 13,780`），参考成本降 **`85.7%`**（`\$0.03495 -> \$0.00500`） |
| **离线 Eval-0002（`eval:memory`）** | `evals/memory-eval.ts` 3 臂通过 | `StaticCore 14.3%` -> `AtomicMemory (5C-1) 57.1%` -> `Consolidated (5C-2) 100%` |
| **离线 Eval-0003（`eval:handoff`）** | `evals/handoff-eval.ts` 2 臂通过 | `No-Handoff 33.3%` -> `Seamless Handoff (5D) 100%`（活跃窗口 `2128 -> 138` tok） |
| **离线 Eval-0004（`eval:prod-memory`）** | `evals/prod-memory-switch-eval.ts` 2 臂通过 | `BEFORE (static-core) 33.3%` -> `AFTER (atomic + idle 10m) 100%`（`Turn1Prefill +623` tok，空闲定时器 `600000ms`） |
| **仓根全量门禁（`npm run check`）** | 根目录 Biome + 依赖锁定 + TS 相对导入 + 全仓类型检查 | 零错误、零警告，全部工作区改动严格限定在 `apps/jehee/` 内且零越界提交 |

### 关键集成不变量核验
1. **Slice 4 纯 MCP 首轮稀疏门禁未被破坏**：`JeheeHost` 中 `enableMedia = options.enableMedia ?? (options.enableRoutines === true || options.memory?.atomic !== undefined || options.handoff !== undefined)`，同时支持通过 `options.extensions` 注入自定义 `"jehee.media"`；当仅挂载 MCP 时首轮可见工具严格保持 `["tool_search"]`（同时在 `features/mcp-connector.feature` 与 `test/slice-6c-integration.test.ts` 双重验证）。
2. **工坊子会话最小权限隔离**：内置工坊子会话配置（`src/workshop/extension.ts`）移除 `JEHEE_MEDIA_EXTENSION_HANDLE`，并在 `test/slice-6c-integration.test.ts` 中端到端断言主会话包含 `send_media` 而子会话不包含。
3. **静默持久化与失败无损保留**：`ChannelGateway` 通过 `JeheeHost` 读写会话级 `HeldNotificationsDoc`，静默期暂存同步驱动单活 `RoutineSchedulerTask` 在 `quietEndMs` 唤醒；投递异常时原子回写失败条目并向调度器抛错触发持久化退避，绝不静默丢弃；`waitForDueRoutines` 基于 `wake().at <= nowMs + 250` 精准收敛，避免退避休眠或空闲时误等 25 秒超时。
4. **MCP 热重连串行化与最新 `blobVault` 绑定**：`JeheeHost.reconnectMcp` 通过串行链防止并发竞态，先关闭旧连接、以 `bestEffort: true` 重连、卸载旧 `extensionHandles` 并安装新扩展、调用 `root.configure({ extensions })`（保留 `removedOnRoot` 防止工坊沙箱工具泄漏到主会话），且 `send_media` 的 `resolveBlob` 与 `host.close()` 始终指向最新活跃 `mcpState`。

---

## 2. 全过程捕获的 5 项非平凡缺陷与四要素复盘（Mandatory Issue Traceability）

### Issue 1（工程环境）：Windows `git worktree` 路径长度超过 `MAX_PATH` 导致长名并行工作区创建失败
1. **现象与原始报错**：在 Windows 主机为多代理并行开发创建独立 `git worktree` 时，一旦 worker 名称长度超过 7 个字符（叠加仓库父目录与上游长路径夹具 `apps/p2/test/fixtures/...`），`git worktree add` 直接失败并报错：`error: unable to create file apps/p2/test/fixtures/...: Filename too long`（Win32 `MAX_PATH = 260` 限制）。
2. **根因定位**：Windows 默认文件系统 API 限制单路径最大 260 字符（在未全局开启 `core.longpaths=true` 或路径前缀较深时触发）；上游 `apps/p2/test/fixtures/...` 含有较深嵌套文件名，当 worktree 目录名本身再拼接较长的 worker 标识与随机后缀时，检出路径突破 260 字符上限。
3. **修复落点**：
   - 并行协作命名规范：在 Windows 主机上为独立 worktree worker 采用紧凑短名（长度 `<= 7` 字符，如 `ops6c`、`mcp6c`、`ver6c`、`int6c`），并在需要时确认工作区根目录前缀足够短；
   - 严守 `apps/jehee/` 隔离，不修改上游 `apps/p2/test/fixtures/...`。
4. **防复发规则**：在 Windows 宿主机上创建 `git worktree` / 隔离 share 工作区时，worker 名称统一限制在 5–7 个 ASCII 字符内（禁止冗长命名），以防叠加仓库内上游深层夹具路径触发 `Filename too long`。

### Issue 2（Slice 6C 审校 `ver6c #25`）：`sanitizeMcpErrorMessage` 存在多类凭据脱敏盲区
1. **现象与原始报错**：独立审校 `apps/jehee/src/mcp/hub.ts` 初版 `sanitizeMcpErrorMessage` 时发现，以下形态的敏感凭据在 `McpConnectorHub.failedServers()` 返回的诊断文案中会被原样透出给 `/mcp`：
   - JSON 带引号键：`{"token":"jtok1"}`、`{"api_key":"jkey2"}`、`{"authorization":"Bearer jauth3"}`（原正则 `key\s*[:=]` 未覆盖紧挨 `:` 前的闭合引号 `"`）；
   - URL 查询参数：`https://host/mcp?key=secret123&auth=qauth8`（既未覆盖 `?key=`/`?auth=`，也未主动擦除 `spec.transport.url` 中携带的敏感 query 参数原始值与 URL 编码值）；
   - 含冒号 Token 与自定义认证头方案：`Bearer sk:live:secret123`（原字符类 `[A-Za-z0-9._~+/=-]` 遇 `:` 提前截断，导致 `:secret123` 泄漏）以及 `X-Custom-Auth: Token <secret>`（原头部分割仅识别 `bearer|basic`）。
2. **根因定位**：初版脱敏逻辑假设错误文案仅出现无引号 `key=value`、纯 URL-safe Bearer Token 与标准 `Bearer`/`Basic` 前缀，且未基于已配置的 `spec.transport.url` 与敏感 Header 值做精确字符串擦除；初版单测只验证了单一简单 `Bearer` 字符串且报错较长时可能因 300 字符截断掩盖尾部泄漏。
3. **修复落点**：
   - [`apps/jehee/src/mcp/hub.ts`](../../src/mcp/hub.ts)（`sanitizeMcpErrorMessage`）：基于 `new URL(spec.transport.url)` 主动擦除 `password`、`username:password` 及敏感 `searchParams` 的原值与 `encodeURIComponent` 编码值；对所有敏感 Header 支持通用 `<scheme> <token>` 拆分擦除；扩展通用正则匹配 JSON 引号键、URL `?key=`/`?auth=` 及非空白 Bearer/Basic Token（含 `:`）；
   - [`apps/jehee/test/mcp.test.ts`](../../test/mcp.test.ts)：补充非截断复合脱敏回归用例，逐一断言 11 类敏感凭据片段全部不可出现在 `failedServers()[0].error` 中且明确出现 `[redacted]`。
4. **防复发规则**：凡向用户可见通道回显外部连接/HTTP 错误前，必须同时执行「配置源精确值擦除（URL userinfo、敏感 query 参数原值与编码值、敏感 Header 全值与方案后段）」与「通用正则兜底（含 JSON 引号键、query 参数与含特殊符号 Token）」，且脱敏回归单测必须断言结果未被截断（`!err.endsWith("…")`）以防截断掩盖尾部漏网凭据。

### Issue 3（Slice 6C 审校 `ver6c #25`）：`McpBlobVault` 内存无界、畸形 Base64 崩溃与 `send_media` 预分配/文件名校验缺口
1. **现象与原始报错**：独立审校在 `McpBlobVault`、`jehee.mcp` 与 `jehee.media` 发现四处边界安全隐患：
   - `McpBlobVault.#entries` 缺少条目数与总字节上限，长生命周期会话或 `128 MiB` Cloudflare Workers Isolate 中持续接收 MCP 截图会导致内存无界增长；
   - `storeBase64` 此前使用宽松的 `Buffer.from(base64, "base64")`，而 `getBlob()` 使用严格 `atob()`；若远端 MCP 返回畸形 Base64 或 URL-safe Base64（含 `-`/`_`），句柄仍会被注册并在后续 `send_media` 调用 `resolveBlob` 时抛出未捕获的 `InvalidCharacterError` 崩溃；
   - `send_media` 在校验 `maxBytes` 前先调用 `textEncoder.encode(args.textContent)`，面对超大字符串会先产生巨额瞬时内存分配；
   - `sanitizeFileName` 放行了 `"."`、`".."`（含 `"foo/.."`）、引号 `"` / `'` 以及 ASCII 控制字符（`CR/LF/NUL`），存在 multipart header 注入与非法文件名风险。
2. **根因定位**：初版假设上游 MCP 工具始终返回规范标准 Base64 且会话短生命周期，并复用后置字节校验代替前置长度守卫，忽视了边缘运行时内存约束与不可信外部输入边界。
3. **修复落点**：
   - [`apps/jehee/src/mcp/blob-vault.ts`](../../src/mcp/blob-vault.ts)：新增 `normalizeBase64`（兼容标准与 Base64URL `-`/`_` 及省略补齐，拒绝畸形输入）、安全 `tryStoreBase64`、异常安全的 `getBlob()`，以及默认 `64` 条 / `32 MiB` 的有界 LRU 淘汰机制（`totalBytes` 精确记账与访问续期）；
   - [`apps/jehee/src/mcp/extension.ts`](../../src/mcp/extension.ts)：对 MCP `ImageContent` 改用 `tryStoreBase64`，畸形图像原样透传而不注册损坏的 `$jehee_blob:` 句柄；
   - [`apps/jehee/src/media/extension.ts`](../../src/media/extension.ts)：对 `options.resolveBlob(handle)` 包裹 `try/catch` 返回结构化 `isError: true`（`blob_resolve_failed`）；在 `textEncoder.encode` 之前先检查 `textContent.length > maxBytes`；强化 `sanitizeFileName` 剥离控制字符与引号并拒绝纯点号段（`.`、`..`、`foo/..`）；
   - [`apps/jehee/test/mcp.test.ts`](../../test/mcp.test.ts) 与 [`apps/jehee/test/outbound-media.test.ts`](../../test/outbound-media.test.ts)：补齐 LRU 淘汰、Base64URL、畸形图像透传、抛错 `resolveBlob`、超长文本前置拦截及非法文件名清洗单测。
4. **防复发规则**：所有会话级内存缓存必须具备硬性条目数与总字节 LRU 上限；跨编解码器（`Buffer` vs Web `atob`）必须在写入入口做统一格式归一化校验；所有大小上限校验必须在解码或编码分配内存之前前置执行；任何透传至 HTTP multipart `filename` 的用户输入必须剥离控制字符与引号并拒绝 `.`/`..` 路径段。

### Issue 4（Slice 6C 审校 `ver6c #26`）：`RoutineSchedulerTask` 静默补发存在事务外唤醒丢失竞态、无回调忙等与跨 `dispatch` 退避丢失
1. **现象与原始报错**：独立审校 `apps/jehee/src/routines/extension.ts` 初版静默自动补发集成时发现四类调度状态机缺陷：
   - **唤醒丢失竞态**：`getNextQuietFlushAtMs(nowMs)` 在 `runtime.commit(tx)` 外部异步读取 `HeldNotificationsDoc`；若在读取之后、`commit` 之前并发写入一条新的静默暂存通知并调用 `syncRoutineSchedulerInTx`，后者看到调度器处于 `status: "running"` 不会发送 `RoutineWakeSignal`，随后 `phases.wait` 基于过期 `undefined` 提交 `terminal/completed` 或越过 `quietEndMs` 的休眠，永久丢失静默结束 Alarm；
   - **忙等死循环**：当 `getNextQuietFlushAtMs` 返回 `<= nowMs` 但未提供 `onQuietFlushDue` 时，跳过投递后仍把 `nextWakeAt <= nowMs` 判为立即 `status: "running"`，陷入无限空转；
   - **lookup 未隔离**：`getNextQuietFlushAtMs` 抛出非 abort 瞬态错误时直接击穿单活调度器进入 `faulted` 终态；
   - **跨 `dispatch` 退避丢失**：退避时间仅存于局部变量，若同一 tick 内有到期 Routine 切入 `phase: "dispatch"`，返回 `wait` 时退避失效并立即重复轰炸失败的 `onQuietFlushDue`。
2. **根因定位**：单活调度器的休眠/终止决策依赖两个数据源（`RoutineDoc` 与 `HeldNotificationsDoc`），初版只将前者纳入 `runtime.commit(tx)` 序列化边界，并将退避状态放在内存栈帧而非 `pi-durable` checkpoint 中。
3. **修复落点**：
   - [`apps/jehee/src/routines/extension.ts`](../../src/routines/extension.ts)：将 `getNextQuietFlushAtMs(nowMs, tx)` 移入 `phases.wait` 的同一个 `runtime.commit(tx)` 事务内原子读取；仅当 `getNextQuietFlushAtMs` 与 `onQuietFlushDue` 同时配置时激活静默检查；新增独立 `phase: "flushQuiet"` 在事务外带 `tracker.beginDispatch()` 与非 abort `try/catch` 执行投递；将 `quietFlushBackoffUntilMs` 持久化至 `RoutineSchedulerState` checkpoint 并跨 `wait`/`dispatch` 保留，同时隔离 lookup 瞬态异常；
   - [`apps/jehee/test/quiet-autoflush.test.ts`](../../test/quiet-autoflush.test.ts)：新增并发 `running` 态暂存防丢、跨同 tick `dispatch` 保留退避、`getNextQuietFlushAtMs` 瞬态异常隔离及省略 `onQuietFlushDue` 零忙等回归单测。
4. **防复发规则**：凡 `pi-durable` 单活调度任务基于多份文档决定 `sleeping` / `terminal` 状态迁移，必须把所有决策读取收口进同一个 `runtime.commit(tx)` 事务内，外部 I/O 拆入独立运行 phase，并将重试退避时间戳持久化进任务 checkpoint 以跨越其它 phase 与 DO 休眠重启。

### Issue 5（OS/运行时边界）：Windows 清理 `workspace: "share"` 工作树时跨越 NTFS Junction 误删主仓 `node_modules` 与 11 个上游 Workspace 包
1. **现象与原始报错**：Slice 6C 合入主工作区并并行 `kill` 两个 `workspace: "share"` 工作树代理（`ops6c`、`mcp6c`）后，部署前例行 `git status --short` 突现 3,142 条非预期工作区删除（` D `），波及 `apps/p3` 及 `packages/{agent,ai,chord,codemode,coding-agent,durable,env,evals,mcp,schema}` 共 11 个上游目录，同时根 `node_modules` 按字母序丢失 `@a*` 至 `@earendil-works/pi-mcp`（停在 `pi-schema`）；`apps/jehee/` 全部 24 个 Slice 6C 文件完好无损。
2. **根因定位**：Windows 下 npm workspaces 会在 `node_modules/@earendil-works/*` 中创建指向 `E:\CODE\jehee\packages\*` 与 `apps/p3` 的 NTFS 目录联接（Directory Junction）；当 `workspace: "share"` 工作树挂载或联接主仓 `node_modules` 并在销毁工作树时递归删除目录，Windows 文件删除沿 Junction 穿透至主仓 `node_modules` 及被联接的上游 workspace 源码目录。该故障仅在真实 Windows 文件系统销毁阶段触发，离线单测与单 worktree 测试无法暴露。
3. **修复落点**：
   - 使用精确路径恢复命令 `git restore --worktree -- apps/p3 packages/agent packages/ai packages/chord packages/codemode packages/coding-agent packages/durable packages/env packages/evals packages/mcp packages/schema` 无损还原全部 11 个上游目录（未触碰 `apps/jehee/` 任何改动或暂存区）；
   - 执行 `npm ci --ignore-scripts` 完整重建根 `node_modules` 与 workspace 联接，随后运行 `npm run hydrate:model-data` 恢复被 gitignore 的 `packages/ai/src/providers/data/*.json` 模型数据并重建上游依赖包 `dist/`（`telemetry`/`schema`/`chord`/`codemode`/`mcp`/`ai`/`durable`），复验 `apps/jehee` `npm run check`（Biome + `tsc` + `check:worker-bundle`）后再执行 Cloudflare Worker 部署；
   - 补录至本复盘文档 [`apps/jehee/docs/evals/0008-slice-6c-audit-and-postmortem.md`](./0008-slice-6c-audit-and-postmortem.md)。
4. **防复发规则**：在 Windows npm-workspace 仓库中销毁任何 `workspace: "share"` 并行工作树后，执行部署或提交前必须先运行 `git status --short` 核验工作区边界；若发现 NTFS Junction 穿透误删，严禁执行 `git checkout .` / `git reset --hard`，必须用定向 `git restore --worktree -- <受影响目录>` 恢复上游跟踪文件，再依次执行 `npm ci --ignore-scripts`、`npm run hydrate:model-data` 与上游包 `dist/` 重建，复验打包门禁通过后再部署。

---

## 3. 线上生产部署与真机验证状态

- **Cloudflare Workers 部署结果（2026-11-27）**：已通过 `wrangler deploy`（`4.155.0`）发布至 `https://jehee-bot.jehee-bot.workers.dev`，**Version ID：`1803a3a8-7326-40a6-8f04-559625eef435`**（上传 `4561.89 KiB` / gzip `765.08 KiB`，Worker Startup `23 ms`）。
- **生产冷启动与 DO 存活实测**：`GET https://jehee-bot.jehee-bot.workers.dev/health` 返回 `{"ok":true,"busy":false}`，验证 `JeheeSessionDO` 单例 SQLite 挂载、`RuntimeModelDoc`/`HeldNotificationsDoc` 初始化、`jehee.media` 扩展装配、`RoutineSchedulerTask` 静默告警联动及 `JEHEE_MCP_SERVERS` 韧性连接全部正常冷启动。
- **Telegram 真机冒烟待续**：可在 Telegram 对话中直接实测 `/mcp`、`/mcp reconnect`、`/model list`、`/model <provider/modelId>`、`/status` 及让 Jehee 调手机截屏并用 `send_media` 回传图片。
