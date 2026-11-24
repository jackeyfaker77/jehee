# Eval-0003 & Postmortem: 单窗口无感换窗（Slice 5D）对比评测与问题留痕

- **评测编号**：Eval-0003
- **关联 ADR**：[ADR-0013（Slice 5D：单窗口无感换窗、换窗前记忆落盘与底层原话回查）](../adr/0013-seamless-window-handoff.md)
- **评测脚本**：[`apps/jehee/evals/handoff-eval.ts`](../../evals/handoff-eval.ts)（`npm --prefix apps/jehee run eval:handoff` / `JEHEE_EVAL_LIVE=1`）
- **实测日期**：2026-11-24
- **真机模型**：`opencode-go/deepseek-v4.1-flash`

---

## 1. 实验设计（两臂同题对照）

在完全相同的 3 阶段长对话 + SQLite 进程重启 + 跨换窗逐字原话核对场景下对比两套上下文策略：

1. **Arm A — `No-Handoff (Baseline)`**：`sweetSpotTokens: 0`（关闭自动甜点压缩），不执行手工 `/handoff`，活跃上下文随回合线性膨胀。
2. **Arm B — `Seamless Handoff (Slice 5D)`**：`sweetSpotTokens: 320`、`keepRecentTokens: 90`、`consolidateBeforeHandoff: true`，挂载 `AtomicMemoryProvider` 与 `"jehee.context"`（`CompactionTask.beforeCompact` + `GenerationTask.afterRun` + `history_search`）：
   - **Phase 1**：两轮包含项目编号（`VN-2026-409`）、预算（120 万元）、负责人（周工）及 5%->25%->100% 灰度限流方案的自然讨论，越过甜点水位触发自动压缩与压缩前记忆整理；
   - **Phase 2**：第三轮补充法务协议编号 `SUP-991`，执行显式 `host.handoffWindow(ctx, { focus })` 生成交接简报并写入 `ResetEntry`；
   - **Phase 3**：关闭并重开同一 SQLite 文件，核验 `HandoffDoc` 持久化与 `exportPortableSnapshot`（`active` 含 `role: "summary"`、`full` 保留第 1 轮逐字原话），随后在新窗口中自然追问第 1 轮提及的供应商编号原话，验证模型通过 `history_search` 精准回查。

评分 Rubric 共 6 项确定性门禁：
1. `AutoCompact`：越过 `sweetSpotTokens` 自动触发 `CompactionTask`（`totalCompactions >= 1`）；
2. `PreFlushMem`：压缩/换窗前已通过原子记忆沉淀关键项目事实；
3. `ManualHandoff`：显式换窗成功产出结构化简报、`tokensAfter < tokensBefore` 且 `totalManualHandoffs === 1`；
4. `Persist+Snap`：SQLite 重启后 `HandoffDoc` 计数不丢，且 `exportPortableSnapshot` 同时满足 `active` 摘要视图与 `full` 全量原话视图；
5. `VerbatimRecall`：换窗重启后的新窗口回答包含精确 `VN-2026-409`，且 Arm B 实际触发 `jehee.context.history_search` Span（`>= 1`）；
6. `WindowBounded`：Arm B 换窗后活跃窗口 Token 数严格低于 Arm A 未换窗基线。

---

## 2. 双轨评测定量结果

### 2.1 离线确定性基线（`faux/deterministic`，0 费用）

| Arm | Score | AutoCompact | PreFlushMem | ManualHandoff | Persist+Snap | VerbatimRecall | WindowBounded | Tok(Ph1->Post) | Comp/Hand | Prefill | CacheHit(All/2+) | Cost(USD) | Wall(ms) | Spans(h/q/c) |
| :--- | ---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | ---: | :---: | ---: | ---: | :---: |
| No-Handoff (Baseline) | 33.3% | N | N | N | Y | Y | N | 1073 -> 1095 | 0/0 | 4203 | 47.6% / 61.9% | \$0.00000 | 58 | 0/0/0 |
| Seamless Handoff (Slice 5D) | **100%** | Y | Y | Y | Y | Y | Y | **1073 -> 138** | 2/1 | 7821 | 37.8% / 43.1% | \$0.00000 | 70 | 3/1/3 |

### 2.2 真机实测（`JEHEE_EVAL_LIVE=1`，`opencode-go/deepseek-v4.1-flash`）

| Arm | Score | AutoCompact | PreFlushMem | ManualHandoff | Persist+Snap | VerbatimRecall | WindowBounded | Tok(Ph1->Post) | Comp/Hand | Prefill | CacheHit(All/2+) | Cost(USD) | Wall(ms) | Spans(h/q/c) |
| :--- | ---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | ---: | :---: | ---: | ---: | :---: |
| No-Handoff (Baseline) | 50.0% | N | Y | N | Y | Y | N | 2862 -> 3613 | 0/0 | 21660 | 79.2% / 84.2% | \$0.00199 | 21527 | 0/1/0 |
| Seamless Handoff (Slice 5D) | **100%** | Y | Y | Y | Y | Y | Y | **3068 -> 778** | 2/1 | 30687 | 50.1% / 52.2% | \$0.00761 | 78149 | 3/2/3 |

### 2.3 核心观察与结论
- **活跃窗口压降显著**：真机 Arm B 换窗后活跃上下文由 `3068 -> 778` tokens（**下降 74.6%**，相对 Arm A 的 `3613` tokens **下降 78.5%**），活跃条目收拢为 1 条 `ResetEntry` 交接简报（`activeEntries=1`），而底层全量快照保留全部 9 条历史记录（`fullSnapshotTurns=9`）。
- **跨换窗原话零失真**：重启 SQLite 进入全新的 1 条目交接窗口后，真机模型未受任何作弊提示，自主调用 `history_search` 2 次并定位到 `entryId=7` 的原始发言，逐字引用“合作供应商编号是 VN-2026-409”，还主动交叉核对了原子记忆 `mem_0001`。
- **缓存命中率与成本权衡说明**：本 4 轮压测刻意将 `sweetSpotTokens` 调极低（`320`）并叠加显式 `/handoff`，因此单次实测触发了 3 次摘要/整理调用（均设 `cacheRetention: "none"`）并新建 1 次前缀，使得极短对话下的整体 `CacheHit` 为 `50.1%`（Arm A 为 `79.2%`）；在真实 7×24 生产默认水位（`48,000` tokens）下，压缩每数十轮仅触发一次，长程 Prefill 账单与注意力稳定性收益远高于单次摘要开销。

---

## 3. Slice 5D 问题留痕与根因复盘（Mandatory Issue Traceability）

以下记录 Slice 5D 开发、单测/BDD 门禁及真机实测期间暴露的全部非平凡缺陷、上游契约坑与离线-真机差异：

### Issue 1：`LiveState.compactions` 可选字段缺空链导致 `GenerationTask.afterRun` 静默吞错
1. **现象与报错**：`test/handoff.test.ts` 与 `seamless-handoff.feature` 场景 1 断言 `totalCompactions >= 1` 失败（`AssertionError: Expected auto-compaction >= 1, got 0`），而手工调用 `host.compactWindow()` 正常。Trace 面板捕获到事件 `pi.durable.report { type: "extension_error", extension: "jehee.context" }`，`onReport` 打印原始报错：
   `TypeError: Cannot read properties of undefined (reading 'length') at onRootAfterRun`。
2. **根因定位**：`pi-durable` 的 `LiveState` 定义 `compactions?: CompactionStatus[]`（无运行中压缩任务时字段缺失）；`host.ts` 误写为 `(live?.compactions.length ?? 0) > 0`（仅对 `live` 做可选链，未对 `compactions` 做可选链）。同时 `pi-durable` 的 `runtime.hooks.each` 会隔离扩展异常并转为 `extension_error` 上报而不中断主对话，因此该 `TypeError` 在未跑 `tsc` 之前表现为“自动压缩静默未触发”。
3. **修复落点**：[`apps/jehee/src/core/host.ts`](../../src/core/host.ts) `onRootContextAfterRun` 改为 `const hasRunningCompaction = (live?.compactions?.length ?? 0) > 0;`。
4. **防复发规则**：修改核心宿主代码后必须优先执行 `npm run check`（`tsc --noEmit`）消除可选字段漏判；调试 `pi-durable` 扩展钩子未生效时，第一时间检查 `JeheeTraceRecorder` 中是否存在 `pi.durable.report`（`extension_error` / `task_faulted`）事件。

### Issue 2：无条件挂载 `history_search` 破坏 Slice 4 纯 MCP `deferred` 暴露不变量
1. **现象与报错**：运行全量 BDD 套件时，`features/mcp-connector.feature` 失败：
   `AssertionError: Expected values to be strictly deep-equal: ['history_search', 'tool_search'] !== ['tool_search']`。
2. **根因定位**：Slice 4 的 `deferred` MCP 场景未配置 `memory.atomic` 与 `handoff`，期望首轮仅向模型暴露 1 个 `tool_search` 元工具；`"jehee.context"` 扩展最初在所有 `JeheeHost` 上无条件挂载 `history_search`，导致纯 MCP 最小宿主的工具列表多出 1 个工具。
3. **修复落点**：[`apps/jehee/src/context/extension.ts`](../../src/context/extension.ts) 与 [`apps/jehee/src/core/host.ts`](../../src/core/host.ts) 增加 `enableHistoryTool: options.memory?.atomic !== undefined || options.handoff !== undefined`，仅在挂载原子记忆或显式配置换窗策略时向主会话暴露 `history_search`（同时仍可在 `host.lookupHistory()` 编程接口随时查询底层历史）。
4. **防复发规则**：向主会话默认扩展新增 eager 工具前，必须回归全量 BDD（特别是 `mcp-connector.feature` 的工具暴露基线），确认不破坏最小拓扑下的稀疏工具集假设。

### Issue 3：`sendMessage()` 结算早于 `GenerationTask.afterRun` 提交导致 `waitForCompaction` 竞态
1. **现象与报错**：单测在 `await host.sendMessage(...)` 后立即检查 `LiveDoc.compactions` 时偶发为空，未等到 `afterRun` 内创建的后台 `CompactionTask`。
2. **根因定位**：`pi-durable` 的 `GenerationTask` 采用两阶段结束（Commit A 结算用户 submission 并返回 `answer`，随后在 `finish` 阶段执行 `afterRun` 钩子）。因此 `sub.wait()` 返回瞬间 `afterRun` 尚未完成。
3. **修复落点**：[`apps/jehee/src/core/host.ts`](../../src/core/host.ts) 的 `waitForCompaction()` 先调用 `await this.#root.waitForIdle(context)` 等待前台 `finish`/`afterRun` 彻底落库，再等待 `LiveDoc.compactions` 与 `compactionTracker.lastTaskId` 全部终态，最后再 `waitForIdle`。
4. **防复发规则**：任何依赖 `GenerationTask.afterRun` 副作用（调度后台任务或触发压缩）的同步等待辅助方法，必须先 `await root.waitForIdle(context)` 再读取 `LiveDoc` 或任务句柄。

### Issue 4：Provider 上报部分/零 `usage.input` 导致活跃窗口 Token 估算严重偏低
1. **现象与报错**：在 `fauxProvider` 默认返回部分 `usage`（`input: 0, output: 34`）的集成测试中，两轮各数百字消息的 `estimateActiveContextTokens` 仅估算为 `~100` tokens，未能越过 `160` 甜点阈值。
2. **根因定位**：原实现一旦找到带 `usage > 0` 的最新 `AssistantMessage`，便直接以其 `usage` 覆盖全部历史字符估算，未考虑部分测试替身或非标网关仅回传 `output` 而 `input/cacheRead` 为 `0` 的情况。
3. **修复落点**：[`apps/jehee/src/context/handoff.ts`](../../src/context/handoff.ts) 的 `estimateActiveContextTokens` 同时计算字符兜底估算 `charEstimatedTotal` 与 Provider usage 锚定估算 `anchoredTotal`，返回 `Math.max(anchoredTotal, charEstimatedTotal)`。
4. **防复发规则**：所有基于外部 Provider `usage` 的阈值判定必须具备字符下界兜底，避免非标网关零报 `usage.input` 时触发机制失效。

### Issue 5：Cucumber 表达式中未转义 `/` 被解析为正则交替分支及 `SystemMessage.sections` 遗漏
1. **现象与报错**：运行 BDD 时出现：
   - 步骤匹配失败（`"/status"` 中的 `/` 被 Cucumber Expression 解析为可选词分隔符）；
   - 工坊子会话隔离断言失败（`ctx.messages` 仅拼接 `content` 未包含 `sections`，漏检系统提示段）。
2. **修复落点**：[`apps/jehee/features/steps/handoff.steps.ts`](../../features/steps/handoff.steps.ts) 将 Cucumber 表达式中的斜杠转义为 `\/status`，并在 `extractSystem(ctx)` 中合并 `msg.sections` 字符串值。
3. **防复发规则**：在 Cucumber Expression 中匹配以 `/` 开头的指令字面量时必须转义为 `\/`；检查 `pi-durable` 系统提示词时须同时读取 `content` 与 `sections`。

### Issue 6（离线 vs 真机差异）：同轮前台 `memory_save` 与压缩前整理产生近重复条目
1. **现象与观测**：`Eval-0003` 真机实测 Arm B 结束后，`MemoryDoc` 中同时存在 `[mem_0003] (active)`（第 2 轮前台模型主动 `memory_save` 写入的网关限流灰度策略）与 `[mem_0004] (fact)`（同轮触发的压缩前整理新增的几乎同义条目）。离线 mock 因固定脚本路由未暴露此现象。
2. **根因定位**：同一轮内前台模型先执行 `memory_save` 落库，随后 `beforeCompact` 整理器读取了未合并的对话增量与已有记忆，虽能正常工作且不影响检索准确度，但在高密同轮写入时整理 Prompt 倾向再新增一条 `fact` 补充条目而非复用/跳过。
3. **当前处理与防复发规则**：记录为已验证的离线-真机差异，不破坏现有单测与 100% 实测通过；后续迭代记忆整理 Prompt 时在“已存在语义等价的 `active`/`fact` 条目时优先 `update`/`merge` 或跳过”规则中进一步收敛，并由后续空闲整理轮次自动去重。
