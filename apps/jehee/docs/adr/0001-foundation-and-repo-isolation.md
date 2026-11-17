# ADR-0001：基座选型（`@earendil-works/pi-durable`）与上游源码隔离策略

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-18
- **关联基线（Upstream Baseline）**：`earendil-works/pi` `main` @ `cead615b48b80d1c61eecab2f0b576d16eeaf4c5`（`@earendil-works/pi-durable@1.5.2`）

---

## 1. 背景与问题（Context & Problem）

在对前代个人 Agent 项目 `Kaze`（`hasaki-agent`）进行架构复盘后，明确了从“重桌面端 Personal Agent”转型为“7×24 常驻个人伙伴 Bot（Jehee）”的核心工程准则——**削薄补偿层，加厚承载层**：

1. **需要砍掉的补偿层包袱**：重型 Electron 桌面端壳子、硬编码在核心装配中的本机截屏/桌宠耦合、为弥补早期模型能力不足而编写的数十 KB 多阶段主动/漂流状态机，以及维护成本极高但未投产的自研复杂图记忆引擎。
2. **必须加厚的承载层能力**：
   - **常驻崩溃恢复**：进程意外终止或机器重启后，对话记录、收件箱队列、在途任务与子会话状态不丢失，且不盲目重复触发非幂等外部副作用。
   - **单入口与工坊（Workshop）同构**：前台保持单一聊天入口的无感连续体验（支持忙时随时插话纠偏）；后台重任务派发至拥有独立上下文窗口与独立 Git Worktree 的子 Agent，仅共享受控的基础记忆切片。
   - **可热插拔记忆与甜点窗口治理**：由于记忆层方案需要在实际产品体验与后期对比中验证迭代，记忆模块必须与 Bot 主体彻底解耦、支持零侵入替换，同时兼顾注意力甜点区间与 KV-Cache 命中率。
   - **清晰的观测与可验证底座**：支持确定性的本地 BDD 行为验收测试（无需消耗真实 API Token），同时保留精确的 Token / 缓存 / 成本统计供后期调优与专项 Eval 使用。

我们需要决定：
1. 选择哪个开源 Agent Harness 作为 `jehee` 的底层基座？
2. 如何组织 Git 仓库与目录结构，既能深度定制和调试基座源码，又能在基座快速迭代期无痛同步上游更新？

---

## 2. 备选方案对比（Alternatives Considered）

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：在旧仓 `hasaki-agent`（Python）上直接重构** | 已有 `ExecutionJournal`、`ChatLane`、`PushGate` 及 Telegram/QQ 渠道代码 | 仓库背负四代历史演进包袱与桌面桥接耦合；渠道入站目前为单队列串行阻塞；清理旧双轨插件与重写并发模型的综合负担高于在新基座上按干净契约重建。 |
| **方案 B：基于 `OpenClaw` 二次开发** | 聊天软件常驻控制面成熟，社区生态大 | 属于高封装度的重型成品网关，会话拼装、工具路由与权限策略耦合紧密，Token 开销偏高，不利于精细定制单入口/工坊边界与可替换记忆。 |
| **方案 C：基于 `Hermes Agent`（Nous Research）二次开发** | Python 实现成熟，自带 `MemoryProvider` 接口与 50%/85% 双阈值上下文压缩 | 框架内置了较多默认管家策略（自动技能提取、网关卫生清理等），与“保持主框架极薄、按需组装能力”的目标存在摩擦。 |
| **方案 D：仅使用 `@earendil-works/pi-agent-core`（不含 `pi-durable`）** | 极简内存循环，API 最少 | 缺少常驻 Bot 必需的崩溃恢复、原子事务落盘、Effect Sandwich 幂等保护、持久化 Inbox（Steer/Follow-up）与子任务所有权图，需要重复手写整套持久化状态机。 |
| **方案 E（最终采用）：以 `@earendil-works/pi-durable` + `@earendil-works/pi-ai` 为基座，Fork 上游单仓并在 `apps/jehee` 隔离开发** | 同时具备极简内核、SQLite 原子持久化恢复、忙时插话/追问队列、Worktree 子会话隔离与无损上下文钩子 | 需应对 `pi-durable` 当前标注 `Experimental` 带来的上游 API 变动风险（通过目录隔离 + 薄适配层解决）。 |

---

## 3. 决策与核心依据（Why — 为什么这么设计）

### 3.1 为什么选 `@earendil-works/pi-durable`？

经源码与类型定义（`v1.5.2`）核验，`pi-durable` 在底层原语上精准匹配 `jehee` 的产品形态：

1. **开箱即用的常驻同事交互模型**：
   - 原生支持 SQLite WAL 持久化（`openNodeSqliteStorage`）与崩溃重启自动续跑（`harness.resume()`）；
   - `conversation.submit` 原生支持 `requestId` 幂等去重、忙时 `whenBusy: "steer"`（当前工具轮后实时插话纠偏）与 `"followUp"`（本轮答完后接续）。
2. **原生支撑工坊独立 Worktree 子会话**：
   - `HarnessOptions.env` 按会话动态解析 `cwd`，配合任务拥有的后台子会话（`ownership: { kind: "task", taskId }` + `background: true`），天然实现工坊板块的独立上下文 + 独立 Git Worktree 隔离。
3. **事实存储与请求视图彻底解耦（支撑可换记忆与同窗无感换窗）**：
   - 底层 Transcript Entries 原子提交后不可变；`GenerationTask.beforeRequest` 可在不篡改底层记录的前提下动态整形当次请求的 `messages[]`；
   - `PromptSection` 仅在内容变化时写入最小增量补丁，保护 Provider Prompt Cache；
   - `conversation.reset(handoff)` 与工具 `control.handoff` 支持在保持同一个 `conversationId` 和缓存亲和 `sessionId` 的前提下开启新上下文起点，旧记录留在库中按需备查；
   - `GenerationTask.afterRun` 在回复送达后拉起持久化后台任务，适合承接异步抽屉归档。
4. **对自动化 BDD 验收测试与后期调优友好**：
   - 配合 `@earendil-works/pi-ai/providers/faux`、`MemoryStorage` 与可注入时钟 `now/setTimer`，可在本地零网络开销地运行 Cucumber BDD 业务验收场景，同时保留 `harness.usage()` 供后期成本分析与专项 Eval 使用。

### 3.2 为什么采用「Monorepo Fork + `apps/jehee` 物理隔离」？

1. **为什么不直接建空仓 `npm install @earendil-works/pi-durable`？**
   `pi-durable` 当前处于活跃演进期（`Experimental`），Fork 完整源码仓库（`earendil-works/pi`）使我们可以直接阅读官方实现与全部示例（`packages/durable/test/examples/`），并在遇到极端边界问题时具备受控热修能力。
2. **为什么严禁在 `packages/durable` 等上游目录直接写业务代码，而放到 `apps/jehee`？**
   - 根仓 `package.json` 原生配置了 `"workspaces": ["packages/*", "apps/*"]`，官方自身的常驻项目 `apps/p3` 也采用这一模式；
   - 将 Jehee 全部产品代码、BDD 规格、配置与文档收敛在 `apps/jehee/` 下，确保上游 `packages/*` 100% 干净，未来执行 `git fetch upstream && git merge upstream/main` 升级底层时**零文件冲突**。

---

## 4. 具体设计方案（How — 怎么设计）

### 4.1 Git 远端拓扑与分支约束

本地仓库路径固定为 `E:\CODE\jehee`，配置双远端：

```text
origin    https://github.com/jackeyfaker77/jehee.git  (fetch / push：Jehee 主开发远端)
upstream  https://github.com/earendil-works/pi.git    (fetch only；pushurl 设为 no_push 防止误推上游)
```

### 4.2 `apps/jehee` 目标目录边界

```text
apps/jehee/
├── docs/
│   ├── README.md          # 标准研发流程与文档索引
│   ├── PRD.md             # 产品需求文档
│   └── adr/               # 架构决策记录（0001, 0002, ...）
├── features/              # BDD Gherkin 业务规格（*.feature）与 Cucumber Step Definitions
├── src/
│   ├── core/              # 常驻宿主内核（JeheeHost：会话生命周期、插话/追问、崩溃恢复、门控）
│   ├── memory/            # 可插拔记忆防腐层（contract.ts 纯接口 + bridge.ts 适配 + 各套记忆实现）
│   ├── channels/          # 单入口渠道适配（CLI / Telegram / QQ 等薄客户端收发与防抖合并）
│   └── workshop/          # 工坊板块（独立子会话 + Git Worktree 编排与回执）
├── test/                  # 内部单元与边界测试
└── evals/                 # （后期阶段）产品成型后的可插拔模块对比评测脚本
```

### 4.3 应对 `pi-durable` Experimental 变动的防腐层设计

- 各套记忆实现只针对 `src/memory/contract.ts` 定义的纯 TypeScript 数据结构编程；
- 只有 `src/memory/bridge.ts` 引用 `@earendil-works/pi-durable` 的 `defineExtension` 与 Hook API；
- 若上游升级改变 Hook 签名，只需修改 `bridge.ts` 一处。

---

## 5. 影响、风险与验收记录（Consequences & Verification）

- **运行环境**：当前开发机已核验为 **Node `v24.20.0` / npm `11.19.0`**，满足根仓与原生 TypeScript 执行要求。
- **依赖锁定规则**：严格遵循 `scripts/check-pinned-deps.mjs`，所有依赖使用精确版本号。
- **本步完成状态**：
  - [x] 上游仓库 Fork 就绪（`jackeyfaker77/jehee`），完整拉取至 `E:\CODE\jehee`（HEAD `cead615b`）。
  - [x] `origin` 与 `upstream`（`pushurl = no_push`）双远端配置并核验完成。
  - [x] 落地工程研发规范、PRD 与架构决策文档体系。
