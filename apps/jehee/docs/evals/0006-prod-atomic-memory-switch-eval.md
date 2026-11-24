# Eval-0004: 线上 Worker 记忆配置切换前后对比评测（`static-core` -> `atomic + idle 10m`）

- **评测编号**：Eval-0004
- **关联立项**：[ADR-0010（Slice 5C-1）](../adr/0010-atomic-memory-and-eval.md)、[ADR-0011（Slice 5C-2）](../adr/0011-background-memory-consolidation.md)、[ADR-0013（Slice 5D）](../adr/0013-seamless-window-handoff.md)
- **评测脚本**：[`apps/jehee/evals/prod-memory-switch-eval.ts`](../../evals/prod-memory-switch-eval.ts)（`npm --prefix apps/jehee run eval:prod-memory` / `JEHEE_EVAL_LIVE=1`）
- **配置变更**：[`apps/jehee/wrangler.jsonc`](../../wrangler.jsonc) 新增 `JEHEE_MEMORY_PROVIDER = "atomic"` 与 `JEHEE_MEMORY_CONSOLIDATION_IDLE_MS = "600000"`
- **部署版本**：切换前 `c7c88eb5-9366-482c-bdb4-7ceb27cd6c92` -> 切换后 `bbc62ecb-55d3-44e5-83ed-72c431942e63`（`https://jehee-bot.jehee-bot.workers.dev`）
- **实测日期**：2026-11-24
- **真机模型**：`opencode-go/deepseek-v4.1-flash`

---

## 1. 评测目标与对照基线

按 [`worker.ts`](../../worker.ts) 线上真实装配路径（`parseJeheeEnvConfig` + `JeheeHost` + `ChannelGateway` + SQLite 冷重启模拟 Cloudflare DO 休眠唤醒），在完全一致的 4 轮业务场景（显式偏好 + 客户合同事实 + 口头隐性日程 + `/handoff` 换窗 + 冷重启后 `/status`、`/memory` 与跨窗回忆）下，对比切换前后两套线上配置：

- **BEFORE（`static-core`）**：原线上配置（仅设 `JEHEE_MODEL` 与 `JEHEE_CORE_MEMORY`，未设 `JEHEE_MEMORY_PROVIDER`）。
- **AFTER（`atomic + idle(10m)`）**：目标线上配置（保留原 `JEHEE_CORE_MEMORY` 作为 `seedCorePrompt`，开启 `JEHEE_MEMORY_PROVIDER="atomic"` 与 `JEHEE_MEMORY_CONSOLIDATION_IDLE_MS="600000"`）。

---

## 2. 切换前后定量对比

### 2.1 离线确定性基线（`faux/deterministic`）

| Arm | Score | SeedCore | ExplicitSave | PreHandoffConsol | PostRestartRecall | Forget/Restore | Cmds | Turn1Prefill | TotalPrefill | CacheHit(All/2+) | Cost(USD) | Wall(ms) | Spans(ms/mq/mc/h/hq) |
| :--- | ---: | :---: | :---: | :---: | :---: | :---: | :---: | ---: | ---: | :---: | ---: | ---: | :---: |
| BEFORE: `static-core` | 33.3% | Y | N | N | N | N | Y | 399 | 1286 | 24.1% / 31.8% | \$0.00000 | 92 | 0/0/0/1/0 |
| AFTER: `atomic + idle(10m)` | **100%** | Y | Y | Y | Y | Y | Y | 1022 | 6136 | 49.3% / 58.0% | \$0.00000 | 96 | 2/2/1/1/0 |

### 2.2 真机实测（`JEHEE_EVAL_LIVE=1`，`opencode-go/deepseek-v4.1-flash`）

| Arm | Score | SeedCore | ExplicitSave | PreHandoffConsol | PostRestartRecall | Forget/Restore | Cmds | Turn1Prefill | TotalPrefill | CacheHit(All/2+) | Cost(USD) | Wall(ms) | Spans(ms/mq/mc/h/hq) |
| :--- | ---: | :---: | :---: | :---: | :---: | :---: | :---: | ---: | ---: | :---: | ---: | ---: | :---: |
| BEFORE: `static-core` | 50.0% | Y | N | N | Y | N | Y | 1030 | 8869 | 53.4% / 57.1% | \$0.00199 | 34375 | 0/0/0/1/5 |
| AFTER: `atomic + idle(10m)` | **100%** | Y | Y | Y | Y | Y | Y | 1815 | 13604 | 40.5% / 44.5% | \$0.00283 | 38263 | 4/2/1/1/0 |

### 2.3 收益与代价权衡（Delta: AFTER − BEFORE）
- **质量与结构化能力**：评分 `50.0% -> 100.0%`；完整保留原 `[seed]` 核心设定，沉淀 5 条结构化原子记忆（含 `pnpm` L1 Core 偏好、`星河科技 / 赵敏 / XH-2026-312`、`周二上午牙科复诊` 与中英别名/原话 `src` 溯源），支持可逆 `/memory forget` / `restore`。
- **换窗重启后检索效率**：`BEFORE` 组无原子记忆，模型被迫在换窗后发起 **5 次 `history_search`** 暴力翻检历史原话才拼出答案；`AFTER` 组仅通过 **2 次 `memory_search`**（`hq=0`）即一次命全全部 3 项细节。
- **首轮工具 Schema 开销与账单代价**：挂载 `memory_save` / `memory_search` / `memory_forget` 后，首轮 Prefill 增加 **`+785 tokens`**（`1030 -> 1815`），完整 4 轮 + 换窗 + 记忆整理实测总账单增加 **`+\$0.00085`**（`\$0.00199 -> \$0.00283`），端到端耗时增加 `+3.9s`。
- **Cloudflare DO 零成本休眠核验**：实测 2 轮对话后 `host.wake()` 在微任务落定后收口为 `{ active: false, at: now + 600_000 }`，DO 关闭 60 秒心跳、仅挂单一 10 分钟 Alarm 后进入休眠，不产生空转计费。

---

## 3. 线上切换前后实测记录

- **切换前（版本 `c7c88eb5-9366-482c-bdb4-7ceb27cd6c92`）**：
  - Telegram `@jehee3_bot` 实测 `/status`：`memory: static-core`、`context: 431/48000 tok (handoffs=0)`、`prefill=404`、`cost_usd: 0.000074`；
  - `/memory`：`[Memory] provider=static-core (static)`。
- **切换后（版本 `bbc62ecb-55d3-44e5-83ed-72c431942e63`）**：
  - 产物 `4393.03 KiB / gzip 726.24 KiB`，冷启动 `30 ms`；
  - `GET /health` 返回 `200 {"ok":true,"busy":false}`，线上 `JEHEE_MEMORY_PROVIDER="atomic"` 与 `JEHEE_MEMORY_CONSOLIDATION_IDLE_MS="600000"` 已绑定生效；
  - Telegram `@jehee3_bot` 实机回执核验：
    - `/status`：`memory: atomic-memory`、`context: 431/48000 tok (handoffs=0)`、`conversation: 1`、`prefill=404`、`cost_usd: 0.000074`（历史会话与累计统计无损衔接）；
    - `/memory`：`[Memory] active=0, forgotten=0, core=25/4000 chars`，`L1 Core` 完整保留 `- [seed] 回答简洁直接，工程任务优先派发工坊在独立目录执行。`。

---

## 4. 评测期间发现与留痕（Issue Traceability）

### Issue 1：评测脚本未在 `finally` 中先关闭 `JeheeHost` 导致 Windows SQLite `EBUSY` 掩盖原始异常
1. **现象与报错**：首次运行 `eval:prod-memory` 在清理临时目录时抛出 `Error: EBUSY: resource busy or locked, unlink '...\jehee.sqlite'`，吞掉了 `try` 块内的原始 `TypeError`（误访问了不存在的 `inspect.snapshot.corePrompt`）。
2. **根因定位**：Windows 上 `node:sqlite` 打开文件句柄期间不允许 `rm(tempDir)` 删除 `.sqlite`；异常跳出 `try` 时若 `finally` 未先 `await openHost.close()`，后抛的 `EBUSY` 会覆盖真正报错。
3. **修复落点**：[`apps/jehee/evals/prod-memory-switch-eval.ts`](../../evals/prod-memory-switch-eval.ts) 增加 `openHost` 追踪并在 `finally` 中先安全 `close()` 再 `rm(tempDir)`；改用 `exportPortableSnapshot().memory.corePrompt` 核验渲染后的真实 `L1 Core` 文本。
4. **防复发规则**：所有使用临时 SQLite 文件的测试与 Eval 脚本必须在 `finally` 中先关闭活跃 `JeheeHost` 再删除临时目录。

### Issue 2：`waitForCompaction` 返回瞬间读取 `host.wake()` 早于微任务 `onWake` 结算
1. **现象与报错**：`Eval-0004` 在 `waitForCompaction()` 下一行同步读取 `host.wake()` 得到 `{ active: true, atDeltaMs: 590525 }`，触发诊断告警 `unexpected DO idle wake after turn 2`。
2. **根因定位**：`pi-durable` 的 `TaskScheduler` 在 `waitForIdle` resolve 后的下一个微任务才完成 `#end(invocation)` 并触发 `onWake({ active: false, at })`（见 `packages/durable/src/harness/scheduler.ts:1830`）。
3. **修复落点**：独立复测验证 `onWake` 终态确为 `{ active: false, at: now + 600_000 }`，并在 [`apps/jehee/evals/prod-memory-switch-eval.ts`](../../evals/prod-memory-switch-eval.ts) 中于 `waitForCompaction` 后让出 25ms 再采样 `host.wake()`。
4. **防复发规则**：断言 `Harness.wake().active === false` 时需在 `waitForIdle` 后等待微任务/短 tick 结算，或直接监听 `onWake` 回调序列。
