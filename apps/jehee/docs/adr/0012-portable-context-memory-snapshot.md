# ADR-0012：上下文与记忆的可移植快照（Portable Export / Import）（Slice 5C-3）

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-24
- **关联需求**：[PRD v1.4 — 板块三 & Slice 5C-3](../PRD.md)、[ADR-0010](./0010-atomic-memory-and-eval.md)、[ADR-0011](./0011-background-memory-consolidation.md)

---

## 1. 背景与问题（Context & Problem）

在完成 Slice 5C-1（原子记忆 `MemoryDoc`）与 Slice 5C-2（后台空闲整理 `MemoryConsolidationDoc`）后，Jehee 的全部长期记忆与对话事实已经完全保存在用户自持的本地 SQLite 或 Cloudflare Durable Object SQLite 中，不依赖任何模型厂商云端存储。

但当前存储层仍存在两类现实缺口：

1. **物理结构耦合在 `pi-durable` Schema 内**：对话 Transcript Entries、压缩摘要与 `MemoryDoc` 均落在 `pi-durable` 内部表与文档增量格式中。虽然日常执行需要借助 `pi-durable` 获得原子事务与崩溃恢复，但用户缺少一份**独立于 Harness 与模型厂商的中立快照**用于跨机器迁移、本地备份或脱离 `pi-durable` 时无损带走数据。
2. **缺少面向人类审阅与外部 Agent 复用的标准输出**：工坊外部 Coding Agent（`claude`、`codex`、`opencode`、`pi`）与用户日常审计需要一份人类可读的 Markdown 视图，而跨实例无损恢复则需要带版本校验的确定性 JSON 快照。

---

## 2. 备选方案对比（Alternatives Considered）

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：直接复制底层 `.sqlite` 文件** | 零代码成本 | 强绑定 `pi-durable` 内部表结构与版本，无法跨 Node SQLite 与 Cloudflare DO SQLite 互通，不可读、不可合并，也无法脱离 `pi-durable` 复用。 |
| **方案 B：在 `pi-durable` 之上再抽象一层通用 Harness Storage 接口** | 理论上可随时替换主 Harness | 显著增加“补偿层”复杂度，破坏 `pi-durable` 的原子事务与增量提交语义，对低频的 Harness 替换属于过度抽象。 |
| **方案 C（最终采用）：纯 TypeScript 版本化可移植快照（JSON 无损往返 + Markdown 人类/外部 Agent 可读视图）+ `JeheeHost` 事务级 `exportPortableSnapshot` / `importPortableSnapshot` + CLI `export`/`import` 与 `/memory export` 指令** | 不破坏 `pi-durable` 原生事务性能；100% 脱离 Harness 与模型格式；支持 `merge`（幂等去重、ID 防碰撞）与 `replace`（重置上下文 + 精确恢复 ID 与墓碑）双模式；Node 与 Cloudflare Workers 双栖可用 | 需在导入边界实现严格的不可信 JSON 校验、忙态保护与 L1 Core 字数上限护栏。 |

---

## 3. 决策与核心依据（Why — 为什么这么设计）

### 3.1 版本化、零依赖的纯数据契约（`jehee.portable.snapshot` v1）
- 在 `src/memory/portable-snapshot.ts` 中定义 `PortableContextSnapshot`（`schema: "jehee.portable.snapshot"`, `version: 1`），**不引用 `@earendil-works/pi-durable` 和任何 `node:*` 模块**，确保可直接在浏览器、Cloudflare Workers 和任意外部脚本中解析。
- 快照仅包含纯粹的业务事实：
  - `memory`：`seedCorePrompt`、`corePrompt` 渲染快照，以及完整原子记忆条目（`id`/`kind`/`content`/`keywords`/`aliases`/`validFrom`/`validUntil`/`sourceEntryId`/`sourceRef`/`status`/`createdAtMs`/`updatedAtMs`/`forgottenAtMs`/`forgetReason`）；
  - `context`：`scope`（`"active"` 当前有效窗口，或 `"full"` 全量历史）与按时间顺序排列的标准化对话回合（`role: "user" | "assistant" | "summary"`、`text`、`timestampMs`、可选 `model` 溯源元数据）。

### 3.2 导入双模式与确定性安全护栏
导入属于典型的不可信外部输入边界，固定执行以下确定性规则：
1. **严格解析校验（`parsePortableSnapshotJson`）**：校验 JSON 语法、`schema`、`version`、每条记忆的 `kind`/`status`/非空 `content`/合法时间戳，以及每个上下文回合的 `role`/非空 `text`；任何非法字段直接拒绝，绝不静默写入脏数据。
2. **忙态并发保护**：若导入包含上下文回放（`includeContext !== false` 且 `turns.length > 0` 或 `mode === "replace"`），事务内检查 `LiveDoc` 是否处于前台忙态；忙态时返回 `host_busy` 拒绝写入，防止把历史条目插进正在进行的推理轮次。
3. **`merge` 模式（默认，安全增量合并）**：
   - 按归一化 `(kind, content)` 对活跃记忆确定性去重，重复导入同一份快照完全幂等（`skippedDuplicates` 计数）；
   - 若外部条目的 `id` 本地尚不存在，保留原 `id` 并推进 `seq`；若与本地已有不同内容的 `id` 碰撞，自动分配新的单调 `mem_NNNN` 编号，绝不静默覆盖本地记忆；
   - 默认遵守 `maxCoreChars` 上限（超限条目计入 `skippedReasons` 并跳过，不破坏现有 L1 Core）。
4. **`replace` 模式（无损迁移/回滚恢复）**：
   - 清空 `MemoryDoc` 后按原始 `id` 完整还原活跃条目与软删除墓碑（`/memory restore <id>` 在目标宿主依然可用），同步推进 `seq`；
   - 在对话日志中追加 `ResetEntry(head: "self")` 开启干净的新上下文基线（历史旧记录仍不可变保留在底层日志中），再按时间顺序写入 `summary` / `user` / `assistant` 条目，使目标宿主（即便切换为不同厂商模型）下一轮即可携带完整记忆与上下文无缝续聊；
   - 若同时恢复了记忆与上下文，同步推进 `MemoryConsolidationDoc` 水位线，避免对已整理过的历史重复调用整理模型。

### 3.3 双格式输出：JSON 负责机器无损，Markdown 负责人类与外部 Agent
- **JSON**：供 `jehee import`、跨实例迁移、云端/本地互导与自动化备份。
- **Markdown（`renderPortableSnapshotMarkdown`）**：按 `L1 Core Memory` -> `Atomic Memories` -> `Forgotten Memories` -> `Conversation Context` 分节输出，可直接放进 Git 审阅，或直接作为上下文文件交给工坊里的 `claude` / `codex` / `opencode` / `pi` 阅读。

### 3.4 多入口与观测闭环
- **`JeheeHost` 便携 API**：`exportPortableSnapshot()` 与 `importPortableSnapshot()`，同时服务本地 Node 与 Cloudflare Workers DO。
- **本地 CLI（`bin.ts`）**：新增 `jehee export [outPath] [--format json|md] [--scope active|full] [--no-forgotten]` 与 `jehee import <filePath> [--mode merge|replace] [--memory-only] [--context-only]`。
- **渠道白名单指令（`ChannelGateway`）**：新增 `/memory export [md|json]`（受主人白名单保护，零模型调用，支持长内容安全截断提示）。
- **Telemetry 埋点**：在 `JEHEE_MEMORY_TELEMETRY_SCHEMA` 中新增 `jehee.memory.export` 与 `jehee.memory.import` Span，记录导出/导入条目数、跳过数与结果状态。

---

## 4. 具体设计方案（How — 怎么设计）

```text
apps/jehee/
├── src/
│   ├── memory/
│   │   └── portable-snapshot.ts      # 纯 TS：快照 Schema、严格解析校验、Markdown 渲染、merge/replace 纯内存应用器与报告格式化
│   ├── core/
│   │   └── host.ts                   # 新增 exportPortableSnapshot() 与 importPortableSnapshot()（单事务原子提交 + 忙态保护 + Telemetry）
│   ├── channels/
│   │   └── gateway.ts                # /memory export [md|json] 确定性白名单指令
│   ├── telemetry/
│   │   └── recorder.ts               # JEHEE_MEMORY_TELEMETRY_SCHEMA 新增 jehee.memory.export / jehee.memory.import
│   └── index.ts                      # 公共类型与函数导出
├── bin.ts                            # 新增 CLI 子命令 `export` 与 `import`
├── features/
│   ├── portable-snapshot.feature     # Cucumber BDD 行为规格
│   └── steps/
│       └── portable-snapshot.steps.ts
└── test/
    └── portable-snapshot.test.ts     # 单元、边界、跨宿主换模型续聊与 CLI 文件读写测试
```

---

## 5. 风险、权衡与验收标准（Verification & Risks）

### 5.1 风险与缓冲
- **外部编辑或损坏的 JSON 导入**：`parsePortableSnapshotJson` 在进入事务前执行完整结构与类型校验，校验失败不触发任何存储写操作。
- **静态记忆插件下导入原子记忆**：若目标宿主仅挂载 `StaticCoreMemoryProvider`（无 `atomic` 控制器），导入不崩溃，显式返回 `memoryUnsupported: true` 与 `memorySkipped`，同时仍可按需导入对话上下文。
- **Telegram 消息长度限制**：`/memory export` 在聊天渠道输出时对超长文本按安全上限截断并提示使用 CLI `jehee export <file>` 导出完整文件。

### 5.2 Slice 5C-3 验收门禁清单
- [x] `apps/jehee` `npm run check`（Biome + `tsc --noEmit` + `check:worker-bundle`）与根仓 `npm run check` 零错误通过，Worker 包保持零 `node:*` 残留。
- [x] 单元测试（`test/portable-snapshot.test.ts`）覆盖：JSON 严格校验、非法输入拒收、Markdown 渲染、`merge`/`replace` 去重与 ID 防碰撞、`maxCoreChars` 护栏、墓碑保留、`active`/`full` 范围、忙态拒收、静态记忆降级、跨宿主换模型续聊及 CLI `export`/`import` 实文件往返。
- [x] Cucumber BDD（`features/portable-snapshot.feature`）覆盖：
  1. 跨宿主无损迁移 + 换模型续聊 + 遗忘墓碑跨宿主 `/memory restore` 恢复；
  2. `merge` 增量合并幂等去重与本地 ID 碰撞保护；
  3. Markdown 可读视图导出与 Telegram `/memory export` 白名单权限保护。
