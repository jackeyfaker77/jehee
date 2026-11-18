# Eval-0001：MCP 工具暴露策略与二进制附件句柄对比评测及失败复盘

- **关联立项**：[ADR-0007 — 双栖 MCP 连接器骨架、Trace 可观测性与暴露策略对比 Eval](../adr/0007-mcp-connector-skeleton-and-eval.md)
- **指标与复盘规范**：[工程规范第 3 节 — 可观测性、标准指标口径与失败复盘规范](../README.md#3-可观测性标准指标口径与失败复盘规范)
- **执行日期**：2026-11-18
- **评测脚本**：[`apps/jehee/evals/mcp-exposure-eval.ts`](../../evals/mcp-exposure-eval.ts)

---

## 1. 实验目标与控制变量设置

本实验旨在用确定性状态断言与统一 Telemetry 指标口径回答两个核心架构问题：
1. 当个人助理同时挂载多个日常服务（50+ 工具规模）时，默认的 **`deferred + tool_search`（摘要常驻 + 按需加载）** 相比 **`eager`（全量直铺 Schema）** 实际节省多少输入 Token 与成本，是否会破坏多轮前缀缓存？
2. 在跨应用搬运邮件附件（PDF 付款收据 + ICS 日历邀请）的 PALE 典型工作流中，**`$jehee_blob:<id>` 会话级句柄卸载** 相比原始 Base64 直传解决了什么定性与定量问题？

### 1.1 固定基准环境（零主观裁判）
- **挂载服务拓扑**：共 6 个 MCP Server 实例——`mail`（4 个业务工具 + 资源三件套 `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`）、`calendar`（3 个业务工具）及 5 个生活领域干扰服务（医保、药房、生鲜、水电网、健身，各 12 个工具），合计 **67 个业务工具 + 3 个资源工具 = 70 个注册工具**。
- **复合测试任务**：
  1. 检索收件箱定位改签航班确认邮件（`msg-flight-1`）；
  2. 读取邮件挂载的两份附件：`delivery.ics`（RFC 5545 日历事件）与 `receipt.pdf`（**24 KiB 二进制 PDF**，Base64 编码后约 **32.8 KiB**，带固定 `sha256` 摘要）；
  3. 将 ICS 导入日历（初始日历版本设为 `revision=1`，强制触发一次 `stale_version` 乐观锁冲突并验证读取 `current_version` 自愈重试）；
  4. 将原始 PDF 收据挂载到新建日历事件上，服务端严格校验解码字节的 `sha256` 一致性。
- **复现命令**：
  ```bash
  # 离线确定性基线（零 API 费用，精确对比前缀 Token、KV-Cache 与状态正确性）
  npm --prefix apps/jehee run eval:mcp

  # 真机模型对比（读取 apps/jehee/.env 中的模型与 API Key）
  JEHEE_EVAL_LIVE=1 npm --prefix apps/jehee run eval:mcp
  ```

---

## 2. 定量对比数据（按统一指标字典统计）

### 2.1 真机实测（Live Model：`opencode-go/deepseek-v4.1-flash`）

> 计费口径：直接读取 `opencode-go` 网关返回的真实账单 `cost.total`（USD）；`prefill_tokens = usage.input + usage.cache_read + usage.cache_write`。

| 实验组（Arm） | 通过 | Rubric 得分 | LLM Turns | Tool Calls (`search` / `mcp`) | Prefill Tokens | Output Tokens | Cache Hit (整体 / Turn 2+) | 真实账单 (USD) | 耗时 (s) |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Arm A**：`eager` + 原始 Base64 | FAIL | 50% | 11 | 17 (`0` / `11` + 5 资源工具) | 492,557 | 39,103 | 82.1% / 85.3% | \$0.03791 | 342.1 s |
| **Arm B**：`eager` + `$jehee_blob` | PASS | 100% | 8 | 10 (`0` / `10`) | 160,464 | 1,952 | 86.4% / 97.8% | \$0.00486 | 28.9 s |
| **Arm C（默认）**：`deferred` + `$jehee_blob` | PASS | **100%** | 8 | 10 (`2` / `8`) | **23,648** | **1,286** | 80.6% / 83.3% | **\$0.00152** | **32.1 s** |

### 2.2 离线确定性基线（Deterministic Harness：`fauxProvider`）

> 口径说明：固定脚本动作序列，用于 CI 零费用回归校验前缀 Token 膨胀与复盘分类器；离线参考单价按 `\$1.00 / 1M` 未缓存或写入输入、`\$0.10 / 1M` 缓存命中读取、`\$4.00 / 1M` 输出折算。

| 实验组（Arm） | 通过 | Rubric 得分 | LLM Turns | Tool Calls (`search` / `mcp`) | Prefill Tokens | Cache Hit (整体) | Cache Hit (Turn 2+) | 参考成本 (USD) | 耗时 (ms) |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Arm A**：`eager` + 原始 Base64 | FAIL | 50% | 6 | 6 (`0` / `6`) | 127,450 | 81.7% | 94.6% | \$0.03495 | 59.9 |
| **Arm B**：`eager` + `$jehee_blob` | PASS | 100% | 6 | 6 (`0` / `6`) | 107,101 | 83.0% | 99.1% | \$0.02832 | 30.0 |
| **Arm C（默认）**：`deferred` + `$jehee_blob` | PASS | **100%** | 7 | 7 (`1` / `6`) | **13,780** | 81.3% | 84.6% | **\$0.00500** | 31.0 |
| **Arm D**：诊断对照（模拟检索未命中） | FAIL | 0% | 2 | 1 (`1` / `0`) | 3,731 | 14.4% | 16.8% | \$0.00331 | 7.3 |

---

## 3. 实验结论与架构定型依据

1. **真机验证确认：`deferred + tool_search` 与 `$jehee_blob:` 组合降低 95.2% 输入 Token 与 96.0% 真实账单（25 倍降本）**：
   - **冷启动差距（24.4 倍）**：在 `opencode-go/deepseek-v4.1-flash` 真机测试中，Arm A/B 首轮直铺 70 个工具消耗 `usage.input=18,666` tokens；而默认方案 **Arm C 首轮仅消耗 `usage.input=764` tokens**，模型在首轮并发发出 2 次 `tool_search` 精准调入 `mail` 与 `calendar` 工具，总轮数与 Arm B 完全持平（同为 `8` 轮、`10` 次工具调用、`100%` 满分通过）。
   - **纯工具暴露收益（Arm C vs Arm B）**：在同样启用 `$jehee_blob:` 的前提下，单靠 `deferred + tool_search` 就将真机总 `prefill_tokens` 从 `160,464` 压至 **`23,648`（下降 85.3%）**，真实 API 账单从 `\$0.00486` 降至 **`\$0.00152`（下降 68.7%）**，Turn 2+ 缓存命中率保持在 **83.3%**。
2. **真机暴露的关键次生灾难：未卸载二进制截断会触发推理模型「思考螺旋（Thinking Spiral）」，放大 30 倍输出 Token 与 10.7 倍耗时**：
   - 离线假模型只体现了输入侧多烧约 2 万 Token；但在真实推理模型 `deepseek-v4.1-flash` 下，Arm A 的 24 KiB PDF（约 32.8 KiB Base64）撞上 `MCP_OUTPUT_MAX_BYTES = 20 KiB` 截断后，模型先是自主调用了新增的 **`list_mcp_resources`、`list_mcp_resource_templates` 与 `read_mcp_resource`** 试图从资源通道重读完整字节（顺带验证了资源工具三件套完全契合模型先验分布），发现仍被 20 KiB 上限截断后，陷入长达 4 分钟的思维链死磕（单轮 `task.id=56` 思考耗时 `129.5s`、单次输出 `16,253` tokens），导致整题输出暴涨至 **`39,103` tokens（Arm C 的 30.4 倍）**、耗时 **`342.1s`（Arm C 的 10.7 倍）**，最终仍因 `integrity_mismatch` 失败。
   - 启用 `McpBlobVault` 后（Arm B / Arm C）：不仅读取 `att-pdf` 时自动卸载 `24,576` 字节，连模型在最后一步调用 `calendar.list` 自检结果时返回列表里的附件也被自动二次卸载（`blob.offloaded_bytes=24576`），且模型零提示失误地将 `$jehee_blob:<16hex>` 句柄原样传入 `calendar.attachment.add`（`blob.restored_count=1`），实现零截断、零思考空转。
3. **版本意识与乐观锁协同**：
   - 真机轨迹显示 `deepseek-v4.1-flash` 在第 2 轮便主动并发调用 `calendar.list` 读取当前版本号 `{ epoch: 1, revision: 1 }` 再执行 `calendar.import_ics`（全程 `mcpErrors=0`）；同时离线套件持续回归锁定 `stale_version` 冲突报错透传后的自愈路径。

---

## 4. 失败样本复盘归档（Failure Postmortems）

### 4.1 样本一：`arm-a-eager-raw`（真机 `deepseek-v4.1-flash`）— 大附件截断引发资源回退与思考螺旋

- **根因分桶（Root Cause Bucket）**：`payload_overflow`
- **环境状态差异（State Diff）**：`missing_or_corrupt_pdf_attachment: attachments=0 | turn=done`（日历事件已成功导入，但 PDF 收据挂载失败）
- **真机关键父子 Span 决策树摘录**（Trace ID：`5dd25d4a-a31c-4961-862e-472f564325af:1`）：
  ```text
  pi.durable.submit submission.type="input" conversation.id=1 submission.id=8 result="placed" (3.403ms)
    pi.durable.phase task.id=9 task.name="pi.generation" phase="request" outcome="waiting" (3190.035ms)
      pi.ai.request provider="opencode-go" model="deepseek-v4.1-flash" stop="toolUse" usage.input=18666 usage.output=124 cost.total=0.002874 (3186.061ms)
      pi.durable.phase task.id=12 task.name="pi.tool" tool.name="mcp__mail__mail_search" outcome="done" (6.763ms)
        jehee.mcp.call server="mail" tool="mail.search" read_only=true mcp.status="ok" is_error=false (1.107ms)
    ...
    pi.durable.phase task.id=28 task.name="pi.generation" phase="request" outcome="waiting" (6311.956ms)
      pi.durable.phase task.id=30 task.name="pi.tool" tool.name="mcp__calendar__calendar_import_ics" outcome="done" (3.507ms)
        jehee.mcp.call server="calendar" tool="calendar.import_ics" read_only=false mcp.status="committed" is_error=false (0.38ms)
    pi.durable.phase task.id=34 task.name="pi.generation" phase="request" outcome="waiting" (3565.335ms)
      pi.durable.phase task.id=36 task.name="pi.tool" tool.name="list_mcp_resources" outcome="done" (4.036ms)
      pi.durable.phase task.id=37 task.name="pi.tool" tool.name="list_mcp_resource_templates" outcome="done" (3.848ms)
    pi.durable.phase task.id=40 task.name="pi.generation" phase="request" outcome="waiting" (2753.909ms)
      pi.durable.phase task.id=42 task.name="pi.tool" tool.name="read_mcp_resource" outcome="done" (1.691ms)
        jehee.mcp.resource_read server="mail" uri="pale://demo/mail/assets/att-pdf" mime_type="application/pdf" bytes=24576 blob.offloaded=false (0.535ms)
    ...
    pi.durable.phase task.id=56 task.name="pi.generation" phase="request" outcome="waiting" (129467.956ms)
      pi.ai.request provider="opencode-go" model="deepseek-v4.1-flash" stop="toolUse" usage.input=9686 usage.output=16253 usage.cache_read=52736 cost.total=0.011363 (129464.391ms)
        · pi.ai.block type="thinking" index=0 chars=29105 (+129464.147ms)
      pi.durable.phase task.id=58 task.name="pi.tool" tool.name="mcp__calendar__calendar_attachment_add" outcome="done" (6.918ms)
        jehee.mcp.call server="calendar" tool="calendar.attachment.add" read_only=false mcp.status="integrity_mismatch" is_error=true blob.offloaded_bytes=0 blob.restored_count=0 (2.29ms)
  ```
- **链路复盘**：
  1. 模型发现 `mail.attachment.get` 返回的 PDF Base64 被 20 KiB 输出上限截断后，展现了极强的工具探索能力：在 `task.id=36/37/42` 自主调用 `list_mcp_resources`、`list_mcp_resource_templates` 与 `read_mcp_resource` 尝试走 MCP 资源通道读取 `pale://demo/mail/assets/att-pdf`；
  2. 因 Arm A 关闭了句柄卸载（`blob.offloaded=false`），资源读取结果再次撞上 20 KiB 截断，诱发 `task.id=50/56/60` 三轮超长思考螺旋（仅 `task.id=56` 一轮就生成 `29,105` 字符思维链、耗时 `129.5s`、单轮耗资 `\$0.01136`，超过整个 Arm C 全程总账单的 7 倍），最终提交残缺数据触发 `integrity_mismatch`，被复盘器准确归入 `payload_overflow`；
  3. 对照真机 **Arm C**（Trace 中 `task.id=30` `blob.offloaded_bytes=24576` -> `task.id=39` `blob.restored_count=1 mcp.status="committed"`）：开启默认 4 KiB 句柄卸载后，同一模型 8 轮 32 秒一次过关，无任何重试或冗余思考。

### 4.2 样本二：`arm-d-postmortem-demo` — 工具检索词偏离导致目标服务零触达

- **根因分桶（Root Cause Bucket）**：`discovery_miss`
- **环境状态差异（State Diff）**：`missing_or_wrong_calendar_event: count=0; missing_or_corrupt_pdf_attachment: attachments=0`
- **关键父子 Span 决策树摘录**：
  ```text
  pi.durable.submit submission.type="input" conversation.id=1 submission.id=8 result="placed" (0.288ms)
    pi.durable.phase task.id=9 task.name="pi.generation" phase="request" outcome="waiting" (0.914ms)
      pi.ai.request model="faux-1" stop="toolUse" usage.input=0 usage.output=12 usage.cache_read=0 usage.cache_write=537 (0.184ms)
        · pi.ai.block type="tool_call" index=0 chars=36 tool="tool_search" (+0.15ms)
      pi.durable.phase task.id=12 task.name="pi.tool" phase="call" tool.name="tool_search" outcome="done" (3.078ms)
    pi.durable.phase task.id=14 task.name="pi.generation" phase="request" outcome="done" (0.989ms)
      pi.ai.request model="faux-1" stop="stop" usage.input=0 usage.output=4 usage.cache_read=537 usage.cache_write=2657 (0.199ms)
  ```
- **链路复盘与后续真机调优判据**：
  - Span 树显示该回合执行了 `tool_search`（`toolSearchCalls=1`），但后续没有任何指向期望服务（`expectedServers: ["mail", "calendar"]`）的 `jehee.mcp.call` 或 `jehee.mcp.resource_read` 子 Span，分类器自动将其判定为 `discovery_miss`（而非笼统归咎于 `model_reasoning`）。
  - **标准化排障动作表**（供后续跑完整 PALE 题库及 Slice 5 记忆评测复用）：
    - 落入 `discovery_miss` -> 仅补充 `JeheeMcpServerSpec.description` 领域同义词，不切回全量 `eager`；
    - 落入 `arg_or_version_error` -> 检查目标工具 Schema 归一化（`normalizeMcpInputSchema`）或服务端错误 JSON 是否被截断；
    - 落入 `payload_overflow` -> 下调 `blobOffloadThresholdBytes` 或将超大列表分页拉取；
    - 落入 `boundary_violation` -> 在 `beforeWriteToolCall` 增加确定性草稿确认拦截（Slice 5 重点）；
    - 落入 `model_reasoning` -> 保持承载层不动，记录为轻量模型 vs 旗舰模型的代际能力对照样本。
