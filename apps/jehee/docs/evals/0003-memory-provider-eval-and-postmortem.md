# Eval-0002 与复盘-0003：热插拔持久化原子记忆插件（`StaticCore` vs `5C-1` vs `5C-2`）双轨评测与问题留痕

- **关联 ADR**：[ADR-0010（Slice 5C-1）](../adr/0010-atomic-memory-and-eval.md)、[ADR-0011（Slice 5C-2）](../adr/0011-background-memory-consolidation.md)
- **执行日期**：2026-11-24
- **复现命令**：
  - 离线确定性：`npm --prefix apps/jehee run eval:memory`
  - 真模型实测：`JEHEE_EVAL_LIVE=1 npm --prefix apps/jehee run eval:memory`（实测模型：`opencode-go/deepseek-v4.1-flash`）
- **产物文件**：
  - 离线：`apps/jehee/.artifacts/evals/latest-memory-eval.json`
  - 真机：`apps/jehee/.artifacts/evals/latest-memory-eval-live.json`

---

## 1. 真模型实测结果（`opencode-go/deepseek-v4.1-flash`，修复后第 4 轮最终基线）

| 实验组 | 得分 | 跨重启 Core | 别名+时间溯源 | 遗忘撤回 | 前缀稳定 | 隐性提炼 | 去重+消冲突 | 幂等 `noop` | Prefill | CacheHit (All/2+) | 真实账单 | 耗时 | Span (`s/q/f/c`) |
| :--- | ---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | ---: | :---: | ---: | ---: | :---: |
| **Arm A：`StaticCore`（基线）** | `14.3%` | N | N | N | Y | N | N | N | `1,430` | `44.8% / 52.7%` | `\$0.00069` | `16.8s` | `0/0/0/0` |
| **Arm B：`AtomicMemory`（5C-1）** | `71.4%` | Y | Y | Y | Y | Y | N | N | `16,478` | `59.8% / 64.0%` | `\$0.00180` | `25.3s` | `4/1/1/0` |
| **Arm C：`AtomicMemory + Consolidation`（5C-2）** | `100%` | Y | Y | Y | Y | Y | Y | Y | `21,408` | `48.4% / 51.0%` | `\$0.00314` | `37.6s` | `5/1/1/2` |

## 2. 离线确定性回归结果（`faux/deterministic`）

| 实验组 | 得分 | 跨重启 Core | 别名+时间溯源 | 遗忘撤回 | 前缀稳定 | 隐性提炼 | 去重+消冲突 | 幂等 `noop` | Prefill | CacheHit (All/2+) | Span (`s/q/f/c`) |
| :--- | ---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | ---: | :---: | :---: |
| **Arm A：`StaticCore`（基线）** | `14.3%` | N | N | N | Y | N | N | N | `692` | `47.3% / 60.1%` | `0/0/0/0` |
| **Arm B：`AtomicMemory`（5C-1）** | `57.1%` | Y | Y | Y | Y | N | N | N | `7,519` | `73.2% / 81.5%` | `2/1/1/0` |
| **Arm C：`AtomicMemory + Consolidation`（5C-2）** | `100%` | Y | Y | Y | Y | Y | Y | Y | `8,215` | `67.0% / 73.9%` | `2/1/1/2` |

---

## 3. 真机实测迭代留痕（Live Run #1 → #4 问题追踪表）

以下完整记录 `JEHEE_EVAL_LIVE=1` 从首次暴露线上故障到最终 100% 绿灯的四轮演化过程与根因定性：

| 编号 | 发现轮次 | 失败表象与原始报错 | 根因定位 | 修复落点与防复发规则 |
| :--- | :--- | :--- | :--- | :--- |
| **L1** | Live Run #1（Arm C `57.1%`） | `consolidateMemory()` 返回 `status: "error"`：`400: MissingSessionID — Request is missing x-opencode-session`。 | `executeMemoryConsolidation` 调用 `models.completeSimple` 时遗漏 `sessionId`；离线 `fauxProvider` 不校验此请求头，仅在真实 `opencode-go` 网关暴露。 | 在 [bridge.ts](../../src/memory/bridge.ts) 补齐 `sessionId: "jehee-memory-consolidation-<conversationId>"`（对齐 `pi-durable/compaction.ts`）。<br>**规则**：凡直接调用 `models.completeSimple` / `stream`，必须显式透传确定性 `sessionId` 且至少过一轮 `JEHEE_EVAL_LIVE=1` 真网关验证。 |
| **L2** | Live Run #2（Arm C `71.4%`） | 整理模型成功 `merge=1`、二次整理返回 `noop`，但 `added=0, superseded=0`，摘要写明：“新对话中的住址迁移与周报安排因用户明确表示不调用记忆工具且未确认，暂不存储。” | **Eval 题面污染**：为了不让 Arm B 前台调用 `memory_save`，测试脚本在用户原话里人为写入了“闲聊一下，不用调用记忆工具”，导致后台整理模型理性尊重“不要存”的指令。 | 在 [memory-eval.ts](../../evals/memory-eval.ts) 改为真实自然闲聊话术，去除人为测试操控语。<br>**规则**：Eval 语料必须贴近真实用户表达，严禁在对话正文里注入测试控制词。 |
| **L3** | Live Run #3（Arm C `85.7%`） | 整理模型新增 `mem_0008`：“用户当前居住在深圳南山（本周刚搬入，旧住址为上海浦东）”，未淘汰 `mem_0004` 且 `pudongHits=2`（旧条目与新条目同时命中“浦东”）。 | 双重根因：<br>1. **Prompt 缺约束**：未告知整理模型“旧值已由墓碑留存，`supersede` 新条目禁止在括号中复述过时旧值”；<br>2. **样本非真冲突**：预埋条目写“旧住址在上海浦东”（本身带“旧”字），模型理性判定与“现居深圳南山”不矛盾，故用 `add` 替代了 `supersede`。 | 1. 在 [consolidator.ts](../../src/memory/consolidator.ts) `CONSOLIDATION_SYSTEM_PROMPT` 规则 5 明确要求 `supersede` 的 `replacement.content` 只陈述最新状态、不复述旧值；<br>2. 将 [memory-eval.ts](../../evals/memory-eval.ts) 预埋事实修正为“目前居住在上海浦东”。<br>Live Run #4 复测即达 `merged=1, superseded=1, skipped=0`、`pudongHits=0`，Arm C 升至 **`100%`**。 |

---

## 4. Slice 5C-1 / 5C-2 开发期 `pi-durable` 契约坑留痕（供 Slice 5D 避坑）

在落地 5C-1 与 5C-2 期间，通过单元测试、BDD 与 `tsc --noEmit` 暴露并一次性修复了以下 5 个底层基座契约细节：

| 编号 | 问题现象 | 根因 | 修复与避坑规则 |
| :--- | :--- | :--- | :--- |
| **D1** | 后台 `MemoryConsolidatorTask` 跑 `run` 阶段时 `MemoryStorage` 抛 `TypeError: Cannot read properties of undefined (reading 'length')` 导致 `SessionFailed`。 | `Conversation.commit` 返回任意泛型 `T`，而 `TaskRuntime.commit` 的语义是**回调返回任何非空对象即替换当前 `TaskState`**；将返回业务对象的回调直接透传给 `runtime.commit` 破坏了任务状态。 | 在 [bridge.ts](../../src/memory/bridge.ts) 的 `MemoryConsolidatorTask` 中改用外层变量捕获回调返回值、保证 `runtime.commit` 回调本身返回 `undefined`（仅在明确切换 `sleeping`/`running`/`terminal` 时返回状态对象）。 |
| **D2** | `buildConsolidationUserPrompt` 读取 `item.keywords` 时抛 `TypeError: Cannot use a settled overlay`。 | `tx.doc(MemoryDoc)` 返回的是事务级可变代理（Overlay），事务提交即失效，不能把内部对象引用带出 `commit` 回调。 | 在 `stage1` 的 `commit` 回调内将 `MemoryItem`（含 `keywords`、`aliases` 数组）深拷贝为纯对象后再返回。 |
| **D3** | `host.waitForMemoryConsolidation` 报 `Error: Task 13 does not exist`。 | `pi-durable` 的 `TaskId` 运行时底层是**数字**，但 `MemoryConsolidationDoc` 将其 `String(taskId)` 存成字符串导致存储查找键类型不匹配。 | `MemoryConsolidationState.scheduledTaskId` 改为 `number` 存储（对齐 `WorkshopRegistryDoc`），同时 `tx.task(id)` / `page.next` 对齐精确上游签名。 |
| **D4** | `host.consolidateMemory(BACKGROUND_CONTEXT)` 未在 `JeheeTraceRecorder` 中录得 `jehee.memory.consolidate` Span。 | `BACKGROUND_CONTEXT` 携带默认 noop telemetry，宿主手动方法直接读取入参 `context.telemetry` 而未回退 `JeheeHost` 实例保存的 `options.telemetry`。 | 在 [host.ts](../../src/core/host.ts) 持久化 `this.#telemetry`，并在手动整理与后台整理任务中统一回退 `this.#telemetry ?? context.telemetry`；同时 `completeSimple` 传 `telemetry: span` 以建立父子嵌套。 |
| **D5** | `MemoryDoc` 写入报 `checkpointWhen is not a function`；`builtin` 工坊子会话隔离时传字符串扩展名失效。 | `defineDoc` 即使 `scope: "session"` 也要求显式声明 `checkpointWhen`；`configure({ extensions: { remove } })` 只接受 `Extension` 实例而非字符串名；`ToolExecutionResult` 字段为 `output` 而非 `content`。 | 在 [durable-store.ts](../../src/memory/durable-store.ts) 补齐 `checkpointWhen: () => false`；导出 `JEHEE_MEMORY_TOOLS_EXTENSION_HANDLE` 供 [extension.ts](../../src/workshop/extension.ts) 传参；[bridge.ts](../../src/memory/bridge.ts) 统一返回 `{ output: [...] }`。 |

---

## 5. 净增益与成本评估

- **能力跃升**：即便强模型在 5C-1 下已能部分主动写入日常事实（真机 `71.4%`），但仍会残留重复项（两条张伟记录）与矛盾旧事实（上海浦东与深圳南山并存）；5C-2 整理在单次约 `\$0.0013` 的增量调用内完成 `merge=1` + `supersede=1` 且尊重已遗忘的 `pnpm` 规则，全项达 `100%`，二次触发零调用返回 `noop`。
- **KV-Cache 稳定度**：5C-1 日常对话 `post_warmup_cache_hit_rate` 达 `64.0%`；5C-2 后台整理显式设置 `cacheRetention: "none"` 且仅在空闲窗口异步执行，不干扰前台会话缓存。
- **全量门禁留档（2026-11-24）**：`apps/jehee` `npm run check`（Biome + `tsc` + Worker 包 `1902.1 KiB`）、根仓 `npm run check`（`2628` 文件）、单测 `45/45`、BDD `40/40` 场景（`283/283` 步骤）、离线与真机双轨 `Eval-0002` 全绿。
