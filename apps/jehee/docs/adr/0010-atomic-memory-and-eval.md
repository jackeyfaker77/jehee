# ADR-0010：可插拔持久化原子记忆插件（L1 Core 一页纸 + 按需检索 + `/memory`）与 `Eval-0002`（Slice 5C-1）

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-24
- **关联需求**：[PRD v1.3 — 板块三 & Slice 5C](../PRD.md)、[ADR-0002](./0002-host-skeleton-and-bdd-cucumber.md)、[ADR-0007](./0007-mcp-connector-skeleton-and-eval.md)、[ADR-0008](./0008-write-approval-and-quiet-governance.md)

---

## 1. 背景与问题（Context & Problem）

截至 Slice 5B，Jehee 已打通单入口常驻会话、双栖 MCP 连接器、确定性写操作审批、主动打扰治理与外部 Coding Agent 工坊网关，但记忆层仍停留在 Slice 1 的基线插件 [StaticCoreMemoryProvider](../../../src/memory/static-core.ts)（仅挂载静态只读字符串，回合归档仅存内存）。这导致长期共事场景下存在四个核心缺口：

1. **偏好与事实无法跨重启演进**：用户在日常对话中交代的长期约束（如“以后统一用 pnpm”“回复简明扼要”）或跨时间事实（如项目里程碑、行程、联系人偏好），无法在会话中持久化沉淀并在重启或 Cloudflare DO 休眠恢复后继续生效。
2. **缺乏按需检索与证据溯源**：如果把所有历史记忆无差别塞进系统提示词，会迅速撑爆上下文并拖垮成本；而若没有轻量索引与 `sourceEntryId` 溯源指针，模型在跨话题追问时既查不到旧事实，也无法回查原始依据。
3. **缺乏用户可见、可改、可彻底遗忘的控制面**：参考主流个人助理记忆体系（Town、Instinct、Muse、Grok Bot）的实践共识——可读文本优于黑盒向量库，常驻注入必须极薄，且用户必须能随时查看与纠偏记忆；若记忆写脏后只能靠跟模型反复口头纠正，体验极差。
4. **双栖可移植性约束**：`JeheeHost` 必须 100% Web/Edge 可移植（同一套代码运行在本地 Node 24 SQLite 与 Cloudflare Workers Durable Objects），不能引入外部 Postgres、独立向量库或本机 `git` CLI 依赖；同时外部第三方应用数据已由 Slice 4 MCP 按需实时查询，记忆层不应整库复制邮件/日历。

---

## 2. 备选方案对比（Alternatives Considered）

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：外部向量库 / Embedding RAG** | 语义近邻召回覆盖面广 | 引入额外基础设施或付费 Embedding API，破坏单 SQLite / CF DO 零外部依赖拓扑；黑盒切片难以精确遗忘和人工审阅。 |
| **方案 B：5C 一次性交付“多页 Wiki + 后台定时 LLM 整理（Dream）+ 前缀冻结双状态机 + 无感换窗”** | 纸面形态一步到位 | 变量过多导致 `Eval-0002` 无法归因（分不清是检索漏召回、后台整理写脏还是换窗摘要丢信息）；前缀冻结双状态机在 CF DO 休眠场景下徒增同步复杂度，违背“薄补偿层”原则。 |
| **方案 C（最终采用，Slice 5C-1）：`pi-durable` `MemoryDoc` 持久化存储 + L1 Core 一页纸（立即刷新）+ 原子记忆列表（关键词/别名/时间过滤 + 证据溯源）+ 显式读写工具 + `/memory` 确定性指令** | 100% Web/Edge 可移植；读写检索与遗忘语义完全确定、可白盒观测；L1 Core 与普通原子记忆严格分离，天然保住日常 KV-Cache 命中率；与 5C-2（后台整理）及后续无感换窗清晰解耦 | 5C-1 阶段仅靠会话显式写入与 `/memory` 指令，未明说“记住”的隐性偏好留待 5C-2 后台整理自动沉淀。 |

---

## 3. 决策与核心依据（Why — 为什么这么设计）

### 3.1 拆分为 5C-1（确定性读写检索基线）与 5C-2（后台整理）
- **Eval 变量隔离**：5C-1 先锁死存储结构、工具契约、关键词/别名/时间检索与显式遗忘，并以 `StaticCore` 为基线运行 `Eval-0002`。待确定性基线数据立住后，5C-2 再引入空闲/定时异步整理（去重、冲突消解、隐性事实提炼），即可精准量化后台整理的净增益。

### 3.2 L1 Core 立即刷新（单一真相），而非窗口内冻结 + 尾部补丁
- **高频与低频严格隔离**：L1 Core（`kind: "core"`）仅存放极少变化的长期画像与硬约束；所有日程、事件、项目事实与跟进事项均写入原子记忆表（`fact` / `episode` / `active`），走 `memory_search` 按需检索，**完全不碰系统提示词前缀**。
- **缓存损耗极低且遗忘更彻底**：95%+ 的常规对话与普通记忆写入零前缀变动；仅在极低频的 Core 变更时触发 1 次前缀重算。作为回报，当用户通过 `memory_forget` 或 `/memory forget` 删除一条错误 Core 规则时，它在下一次请求中立即从提示词物理消失（无“冻结前缀残存旧规则 + 尾部补丁覆盖”的冲突风险），同时省去 CF DO 休眠下的双快照同步逻辑。
- **留有演进余地**：若后续 `Eval-0002` 或线上 Trace 表明 Core 变更导致 `post_warmup_cache_hit_rate` 明显下降，可在 `AtomicMemoryProvider` 内部无感增加冻结层，不改动外部接口。

### 3.3 纯 TypeScript 可移植索引（关键词 + 别名 + 时间区间）与 `sourceEntryId` 溯源
- 不依赖宿主专属 SQLite FTS5 扩展（确保 `MemoryStorage`、Node SQLite 与 Cloudflare DO 行为 100% 一致）。
- 针对个人助理常见的中英文混合、缩写与口语别称（例如“老王”/“王总”/“Wang”，“机票”/“东京航班”），在每条原子记忆上显式保存 `keywords` 与 `aliases`，检索时结合 Latin 词项归一化、CJK 二元组/子串匹配、别名加权与时间范围（`validFrom` / `validUntil`）过滤排序。
- 每条记忆保留 `sourceEntryId`（写入时的对话条目 ID）与可选 `sourceRef`（如 MCP 资源 URI），形成可审计的证据链。

### 3.4 软删除（Tombstone）与 `/memory` 确定性指令闭环
- 遗忘默认采用软删除（`status: "forgotten"` + `forgottenAtMs` + `forgetReason`）：被遗忘条目在 `renderCorePrompt` 与 `memory_search` 中立即完全不可见，但保留墓碑记录，支持 `/memory restore <id>` 防误删与审计，不依赖 `git` CLI。
- 在 `ChannelGateway` 新增 `/memory` 确定性指令族（走现有主人白名单鉴权，零模型调用、不污染主对话历史），让用户在 Telegram / CLI 中直接审阅、搜索、遗忘与恢复记忆。

### 3.5 L4 无感换窗（Seamless Handoff）拆出为独立切片
- 上下文窗口预算与压缩交接属于对话生命周期治理，与跨时间长期记忆正交。5C-1 不混入换窗逻辑，仅保持 `MemoryProvider` 接口简洁，供后续换窗切片按需挂接。

---

## 4. 具体设计方案（How — 怎么设计）

### 4.1 持久化数据模型（`MemoryDoc`）

使用 `pi-durable` 的 `defineDoc` 将记忆状态直接保存在会话所属 SQLite / DO 中（与 `ApprovalDoc`、`WorkshopRegistryDoc` 同构）：

```ts
export type MemoryKind = "core" | "fact" | "episode" | "active";
export type MemoryStatus = "active" | "forgotten";

export type MemoryItem = {
	id: string;                 // 例如 "mem_0001"
	kind: MemoryKind;
	content: string;            // 人类可读的简洁陈述
	keywords: string[];         // 检索关键词
	aliases: string[];          // 同义词、人名别称、项目代号
	validFrom?: string;         // 可选 ISO 日期（YYYY-MM-DD），支持时间轴过滤
	validUntil?: string;        // 可选 ISO 日期（YYYY-MM-DD）
	sourceEntryId?: string;     // 溯源：来源对话 EntryId
	sourceRef?: string;         // 可选溯源：外部 MCP URI 或工坊任务名
	status: MemoryStatus;
	createdAtMs: number;
	updatedAtMs: number;
	forgottenAtMs?: number;
	forgetReason?: string;
};

export type MemoryStoreState = {
	seq: number;
	items: Record<string, MemoryItem>;
};
```

- `MemoryDoc` 定义：`kind: "jehee.memory.store"`, `version: 1`, `scope: "session"`（单主人单会话共享，同时天然支撑 `builtin` 工坊子会话只读共享 L1 Core 及未来 Slice 5D 换窗无缝延续）。
- L1 Core 硬边界：渲染 `jehee_core_memory` 段落时仅包含 `kind === "core" && status === "active"` 的条目，并按 `maxCoreChars`（默认 `4000` 字符）做确定性上限保护；超出上限时拒绝继续向 `core` 追加并提示模型改存为 `fact` 或先精简/遗忘旧 Core 条目。

### 4.2 契约演进与防腐桥接（`contract.ts` & `bridge.ts`）

保持 `src/memory/contract.ts` 不依赖 `pi-durable` 且完全向后兼容 `StaticCoreMemoryProvider`：

- **只读与变更端口**：在 `src/memory/durable-store.ts` 隔离 `MemoryDoc` 的读写实现；在 `src/memory/atomic-memory.ts` 实现纯 TypeScript 的领域逻辑（渲染 L1 Core、中英文混合检索评分、新增/更新、软删除/恢复、`/memory` 文本格式化）。
- **工具挂载（仅当挂载支持工具的 `MemoryProvider` 时生效）**：`createMemoryExtension` 在同一 `"jehee.memory"` 扩展槽内注册三把主会话工具（热切回 `StaticCoreMemoryProvider` 时自动卸载）：
  1. `memory_save`
     - 入参：`{ kind: "core" | "fact" | "episode" | "active", content: string, keywords?: string[], aliases?: string[], validFrom?: string, validUntil?: string, sourceRef?: string, id?: string }`
     - 行为：新建（分配 `mem_000N`）或按 `id` 原地更新已有条目；自动附带当前回合来源 `sourceEntryId`；若 `kind === "core"` 校验 `maxCoreChars` 上限。
     - 说明文案明确约束：仅在用户明确要求记住、明确修正偏好，或出现跨会话高价值事实时调用；**低频长期准则才用 `core`，其余一律用 `fact`/`episode`/`active`**。
  2. `memory_search`
     - 入参：`{ query: string, kind?: MemoryKind, fromDate?: string, toDate?: string, limit?: number }`
     - 行为：仅检索 `status === "active"` 条目；按关键词、别名、内容匹配度与时间区间过滤排序，返回精简列表（含 `id`、`kind`、`content`、`validFrom`/`validUntil`、`sourceEntryId`、`sourceRef`）。
  3. `memory_forget`
     - 入参：`{ id: string, reason?: string }`
     - 行为：将目标条目标记为 `status: "forgotten"`；返回确认信息。
- **工坊子 Agent 继承**：`JeheeHost` 通过 `getCorePrompt` 为工坊子 Agent 注入的仍是只读 L1 Core 一页纸，工坊子会话不挂载写记忆工具，避免子任务污染主记忆库。
- **可观测性埋点**：在 `memory_save` / `memory_search` / `memory_forget` 内发出 `jehee.memory.save` / `jehee.memory.search` / `jehee.memory.forget` 子 Span（记录 `memory.kind`、`memory.id`、`memory.hit_count`、`memory.outcome`），挂在 `pi.durable.phase(task.name="pi.tool")` 之下。

### 4.3 `/memory` 确定性指令（`ChannelGateway` + `JeheeHost`）

在 `JeheeHost` 上暴露确定性记忆管理方法（`inspectMemory`、`searchMemory`、`forgetMemory`、`restoreMemory`），并在 `ChannelGateway` 接入斜杠指令（复用主人白名单鉴权）：

- `/memory`（或 `/memory list`）：输出当前活跃的 L1 Core 条目列表 + 最近活跃的原子记忆条目摘要（带 `id` 与类型标签）。
- `/memory search <query>`：直接调用确定性检索引擎返回匹配条目。
- `/memory forget <id>`：直接软删除指定条目并返回确认。
- `/memory restore <id>`：将误删的墓碑条目恢复为 `active`。

### 4.4 模块目录结构与配置项

```text
apps/jehee/
├── src/
│   ├── memory/
│   │   ├── contract.ts       # 纯 TS MemoryProvider 契约与原子记忆领域类型
│   │   ├── atomic-memory.ts  # 纯 TS 原子记忆引擎：L1 Core 渲染、中英混合/别名/时间检索、增改忘恢复与格式化
│   │   ├── durable-store.ts  # pi-durable MemoryDoc 定义与事务读写封装（100% Web/Edge 可移植）
│   │   ├── bridge.ts         # createMemoryExtension：挂载 jehee_core_memory 段落 + memory_* 工具 + Telemetry Span
│   │   └── static-core.ts    # 保留零复杂度基线插件（Eval 对照组）
│   ├── core/
│   │   └── host.ts           # 暴露 inspectMemory / searchMemory / forgetMemory / restoreMemory，支持工坊读取持久化 Core
│   ├── channels/
│   │   └── gateway.ts        # 接入 /memory（list / search / forget / restore）确定性指令
│   └── runtime/
│       ├── config.ts         # 解析 JEHEE_MEMORY_PROVIDER ("atomic" | "static") 与 JEHEE_MEMORY_CORE_MAX_CHARS
│       └── node.ts           # 按配置装配 AtomicMemoryProvider 或 StaticCoreMemoryProvider
├── features/
│   ├── pluggable-memory.feature
│   └── atomic-memory.feature
├── evals/
│   └── memory-eval.ts        # Eval-0002：StaticCore vs AtomicMemory 对比评测脚本
└── test/
    └── memory.test.ts
```

新增环境变量（`.env` / `wrangler.jsonc`）：
- `JEHEE_MEMORY_PROVIDER`：`"atomic"`（启用持久化原子记忆插件）或 `"static"`（基线 `StaticCoreMemoryProvider`，默认保持向后兼容，`.env.example` 提供 `"atomic"` 配置示例）；
- `JEHEE_MEMORY_CORE_MAX_CHARS`：L1 Core 一页纸最大字符数（默认 `4000`）。

### 4.5 `Eval-0002` 对比评测设计

复用统一 Trace 指标字典（`prefill_tokens`、`post_warmup_cache_hit_rate`、`llm_turns`、`tool_calls`、`cost_usd`、`pass_rate`），在同一组多阶段任务上横向对比 `StaticCore` 与 `AtomicMemory`：
1. **长期偏好遵循**：首轮交代硬约束后，跨多轮无关对话与宿主重启后仍准确遵守。
2. **别名与时间范围检索**：存入带别称与日期区间的人物/项目/行程记忆，后续用口语别称或时间条件追问，验证召回准确率与 `sourceEntryId` 溯源完整性。
3. **显式纠偏与彻底遗忘**：先存入旧规则/旧地址，随后显式更正或执行遗忘，验证后续回答不再泄露或误用旧值。
4. **KV-Cache 稳定度观测**：连续多轮普通问答与原子记忆读写下，核验 `post_warmup_cache_hit_rate` 不因普通记忆操作发生异常掉点。

---

## 5. 风险、权衡与验收标准（Verification & Risks）

### 5.1 风险与缓冲
- **模型滥用 `kind: "core"` 导致前缀膨胀与缓存抖动**：通过工具描述明确区分 `core` 与 `fact`/`episode`/`active`，叠加 `maxCoreChars` 硬上限与 `Eval-0002` 的 `post_warmup_cache_hit_rate` 门禁监控。
- **中文无空格分词导致召回漏检**：检索打分采用 Latin 词项 + CJK 二元组与子串混合匹配，并引导写入时补充 `keywords` 与 `aliases`；后续若条目规模增长到数千条，可平滑替换内部索引实现而不改外部契约。
- **Cloudflare Worker 边缘打包纯净度**：`memory/` 下全部模块严格禁止导入 `node:*` 原生模块，由 `check-worker-bundle.ts` 门禁守卫。

### 5.2 Slice 5C-1 验收门禁清单
- [x] `npm run check`（Biome + `tsc --noEmit` + `check-worker-bundle`）零错误通过，Worker 包（`1879.7 KiB`）无 Node 专属依赖渗漏。
- [x] 单元测试（`test/memory.test.ts`）覆盖：L1 Core 渲染与 `maxCoreChars` 护栏、中英文关键词/别名/时间范围检索排序、新建/原地更新/软删除/恢复、以及 SQLite 重启持久化。
- [x] Cucumber BDD（`features/pluggable-memory.feature` 与 `features/atomic-memory.feature`）全量通过（`37/37` 场景、`263/263` 步骤）：
  1. 原有热插拔与 `StaticCore` 场景 100% 保持绿灯；
  2. 会话中调用 `memory_save` 写入 `core` 与 `fact`，重启宿主后 L1 Core 自动注入且 `memory_search` 按别名/时间精准命中并携带 `sourceEntryId`；
  3. 调用 `memory_forget` 或发送 `/memory forget <id>` 后，条目立即从 L1 Core 与检索结果中消失，`/memory restore <id>` 可恢复；
  4. Telegram / 渠道 `/memory`、`/memory search`、`/memory forget` 受主人白名单保护，未授权用户拒绝且零状态变更；
  5. 普通原子记忆写入不改变系统提示词前缀，工坊子 Agent 仅继承 L1 Core 且不挂载写记忆工具。
- [x] 完成 `Eval-0002`（离线确定性）对比评测（`StaticCore` `25%` vs `AtomicMemory` `100%`），并归档至 [0003-memory-provider-eval-and-postmortem.md](../evals/0003-memory-provider-eval-and-postmortem.md)。
