# Jehee 工程文档与标准开发流程

Jehee 是基于 `@earendil-works/pi-durable` 构建的 **7×24 常驻个人伙伴型 Bot（Always-on Personal Colleague）**，遵循 **「产品体验驱动、薄补偿层、厚承载层、记忆可插拔」** 的工程原则。

> **核心定位声明**：我们是为了做一个真正能长期托付日常与工程事务的 **Bot 产品** 而构建 Jehee；专项评测（Eval）只是产品主体成型后，用来横向优选可替换部件（如不同记忆策略）的辅助工具之一，绝不本末倒置。

---

## 1. 标准软件工程流程（PRD → ADR → BDD → 实现 → 门禁）

本项目采用规范化的正向研发闭环，确保每一步“做什么、为什么这么设计、怎么设计、怎么验收”都有据可查：

1. **产品需求对齐（[PRD](./PRD.md)）**
   明确用户真实痛点、核心交互体感、功能板块边界、明确不做的“补偿层”事项，以及垂直交付切片（Slices）顺序。
2. **架构决策立项（[ADR](./adr/)）**
   每个切片或关键设计动工前，先编写 `adr/NNNN-<topic>.md`，固定记录四部分：
   - **Context（背景与约束）**：当前切片要解决什么业务与工程问题？
   - **Why（为什么这么设计 & 淘汰了什么）**：对比备选方案，写明取舍理由。
   - **How（具体怎么设计）**：模块边界、TypeScript 接口签名、状态流向与目录结构。
   - **Verification & Risks（风险与验收标准）**：风险缓冲机制、回退路径与对应的 BDD 验收场景。
3. **行为驱动规格（BDD + Cucumber）**
   在 `apps/jehee/features/*.feature` 中使用 Gherkin 编写业务可读的可执行验收规格（`Feature / Scenario / Given / When / Then`），覆盖正常流、忙时插话、崩溃恢复与插件替换边界。
4. **垂直切片实现（Vertical Slice Implementation）**
   - 严守上游隔离原则：业务代码仅落在 `apps/jehee/` 内，不直接污染上游 `packages/*`。
   - 严守根仓编码规范（见根目录 [`AGENTS.md`](../../../AGENTS.md)）：仅使用可擦除 TypeScript 语法（Node 24 strip-types 兼容）、顶层静态导入、禁用无依据的 `any`、所有依赖精确锁定版本号。
5. **静态门禁与自动化验收（Check & BDD Gate）**
   运行 Biome 格式/静态检查、TypeScript 类型检查、依赖精确锁定检查，以及 Cucumber BDD 全量验收测试。
6. **后期专项调优（Targeted Eval，产品主体就绪后介入）**
   当产品核心闭环稳定后，针对记忆策略等存在多种启发式方案的可插拔模块，由项目主导者定义评测维度进行对比选型。

---

## 2. 文档总索引

### 产品文档
- **[PRD.md — Jehee 产品需求文档](./PRD.md)**：产品愿景、四大核心板块、非目标边界与分阶段交付路线图。

### 架构决策记录（ADR）

| 编号 | 标题 | 状态 | 日期 | 摘要 |
| :--- | :--- | :--- | :--- | :--- |
| [ADR-0001](./adr/0001-foundation-and-repo-isolation.md) | 基座选型（`@earendil-works/pi-durable`）与上游源码隔离策略 | Accepted | 2026-11-18 | 确立从 `earendil-works/pi` Fork 构建 `jehee`，采用 `apps/jehee` Workspace 物理隔离上游源码、防误推双远端配置及薄胶水层隔离 Experimental API。 |
| [ADR-0002](./adr/0002-host-skeleton-and-bdd-cucumber.md) | 最小常驻宿主骨架（`JeheeHost`）与 BDD + Cucumber 验收体系设计 | Accepted | 2026-11-18 | 设计 Slice 1 宿主内核、可热插拔 `MemoryProvider` 防腐接口，以及基于 `@cucumber/cucumber` + Node 24 原生 TS + `fauxProvider` 的确定性 BDD 验收架构。 |
| [ADR-0003](./adr/0003-cloud-topology-and-channel-gateway.md) | 双栖云拓扑（Cloudflare DO + InstaBox Free）与平台无关渠道网关（Telegram 首发） | Accepted | 2026-11-18 | 确立本地/CF DO 双栖控制面 + InstaBox 免费单机多 Worktree 云工坊拓扑；实现平台无关 `ChannelGateway`（白名单、防抖合并、Staging 锁、跨平台共用会话）与零依赖纯 `fetch` Telegram 适配器。 |
| [ADR-0004](./adr/0004-instabox-cloud-workshop.md) | InstaBox 免费版云工坊板块（按需唤醒、`/data` 多 Worktree 隔离与后台协同治理） | Accepted | 2026-11-18 | 基于纯 `fetch` 对接 InstaBox OpenAPI v1，实现免费单机透明唤醒、`/data/jehee/worktrees` Git Worktree 隔离、仅继承 Core 记忆的后台子会话及跨渠道完工主动回推。 |
| [ADR-0005](./adr/0005-runtime-entrypoints-and-opencode-go.md) | 双栖真机运行入口（本地 CLI / Telegram 轮询 + Cloudflare DO）与 OpenCode Go 模型装配 | Accepted | 2026-11-18 | 纯化 `JeheeHost` 跨平台内核，原生接入 `opencode-go` 模型目录，交付本地 `bin.ts`（`models`/`chat`/`telegram`）与 Cloudflare `worker.ts` + `wrangler.jsonc` 部署入口及边缘打包门禁。 |
| [ADR-0006](./adr/0006-nonblocking-telegram-polling-and-cli-boundary.md) | Telegram 本地长轮询非阻塞两阶段入站与本地 CLI 同步边界 | Accepted | 2026-11-18 | 将 `ChannelGateway` 拆分为有序毫秒级准入 `admit` 与后台结算 `settled`，打通本地 Telegram 轮询下的连发防抖、忙时实时 `steer` 插话与 `/stop` 紧急中止，同时明确本地 CLI 保持精简同步交互。 |

---

## 3. 后续计划立项队列

- **ADR-0007（Slice 4）**：四层抽屉记忆（Core / 中期时序 / 短期任务缓存 / 历史压缩抽屉）与甜点区间窗口治理。
- **ADR-0008（Slice 5）**：确定性主动提醒门控与可插拔记忆层的横向对比 Eval 套件（由项目主导者定调评测维度）。
