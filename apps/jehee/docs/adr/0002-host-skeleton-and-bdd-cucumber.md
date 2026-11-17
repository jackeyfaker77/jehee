# ADR-0002：最小常驻宿主骨架（`JeheeHost`）与 BDD + Cucumber 验收体系设计

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-18
- **关联需求**：[PRD v1.0 — Slice 1](../PRD.md)

---

## 1. 背景与问题（Context & Problem）

根据 [PRD](../PRD.md) 确立的路线，我们优先推进 **Slice 1：搭建最小可运行的产品宿主骨架（`JeheeHost`），打通可热插拔记忆底座接口，并建立标准的 BDD + Cucumber 自动化行为验收体系**。

在本切片中需要解决三个具体工程问题：

1. **如何划定 BDD（Cucumber）、单元测试与后期 Eval 的职责边界？**
   不能让验收测试依赖真实外部大模型 API（否则测试慢、结果不确定、每次运行烧钱），也不能过度 Mock 把 `@earendil-works/pi-durable` 的核心事务与持久化链路架空。
2. **在当前 Monorepo（Node 24 + ESM + 可擦除 TypeScript 语法）中如何干净集成 Cucumber？**
   传统 Cucumber + TypeScript 方案常引入 `ts-node`、`tsconfig-paths` 等重型转译链，容易与 Node 原生 ESM 及根仓严格的依赖检查冲突。
3. **`JeheeHost` 与可插拔 `MemoryProvider` 的第一版最小边界怎么定？**
   既要覆盖产品核心原语（持久对话、幂等 `requestId`、忙时 `steer`/`followUp` 插话、SQLite 崩溃重启恢复、记忆插件热插拔），又要保持极薄，不为尚未进入当前切片的渠道和四层抽屉预写死多余代码。

---

## 2. 备选方案对比（Alternatives Considered）

### 2.1 BDD 运行方式选型

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：`@cucumber/cucumber` CLI + `ts-node/esm` 加载器** | 传统教程常见 | `ts-node` 在 Node 24 原生 ESM 下兼容性脆弱，且引入额外转译依赖，违背根仓轻依赖原则。 |
| **方案 B：不用真 Cucumber，在 Vitest / `node:test` 里手写 `given/when/then` 辅助函数** | 零新增依赖 | 失去了标准 `.feature` 纯文本业务规格文件，无法实现产品需求文档与可执行 Gherkin 规格的一一映射。 |
| **方案 C（最终采用）：`@cucumber/cucumber`（精确锁定 `13.3.0`）+ Node 24 原生 `--experimental-strip-types` + 编程式 API 运行器** | 保留标准 `.feature` Gherkin 文件，零转译器依赖，直接以源码条件（`--conditions=source`）驱动真实 `JeheeHost` 与 SQLite | 需要提供一个极简的 `scripts/run-bdd.ts` 入口调用 `@cucumber/cucumber/api`（仅约 30 行代码）。 |

### 2.2 Gherkin 语言风格选型

- **方案 1：全中文关键字（`# language: zh-CN`，`功能/场景/假如/当/那么`）** vs **方案 2：标准英文 Gherkin 关键字（`Feature/Scenario/Given/When/Then`）+ 中文业务描述**。
- **决策**：采用 **方案 2（英文 Gherkin 关键字 + 中文自然语言步骤描述）**。原因：所有主流 IDE 插件与 CI 报告器无需额外语言头即可 100% 识别语法结构，同时步骤正文保持纯粹的中文产品语义（例如 `When 用户在主入口发送消息 "帮我记住我习惯用 pnpm"`），可读性最佳。

---

## 3. 决策与核心依据（Why — 为什么这么设计）

### 3.1 明确三层质量保障分工（各司其职）

1. **BDD 行为验收层（`features/*.feature` + `@cucumber/cucumber`）—— 验证“产品行为契约对不对”**
   - 驱动**真实的 `JeheeHost`、真实的 `pi-durable` 状态机与真实的 SQLite / Memory 存储**；
   - 仅在最底层的 LLM 网络边界注入 `@earendil-works/pi-ai/providers/faux`（确定性桩模型，可精确预设文本回复、多步工具调用以及检查实际发给模型的 Prompt 与 Messages）；
   - 毫秒级跑完、零外部网络依赖、100% 确定性可重现。
2. **单元与边界测试层（`test/*.test.ts` + `node:test`）—— 验证“内部数据结构与异常分支稳不稳”**
   - 针对纯算法、参数校验与内部边界做细粒度断言。
3. **专项对比评测层（`evals/`，产品核心成型后启动）—— 验证“接真实大模型后哪套策略效果更好、更省钱”**
   - 专门用于横向评估四层抽屉记忆 vs 极简记忆等开放性问题。

### 3.2 为什么 `JeheeHost` 第一版直接内聚支持内存与本地 SQLite 两种后端？

- 产品真实常驻运行必须走本地 `openNodeSqliteStorage(dbPath)`，而崩溃重启恢复（关闭第一个 `JeheeHost` 实例后在同一个 `.sqlite` 文件上重新打开第二个 `JeheeHost` 实例）必须在真实 SQLite 文件上验收才算数；
- 快速逻辑测试与后续无状态验证则可传入 `{ kind: "memory" }` 零磁盘开销运行；两者共用完全一致的 `JeheeHost` 业务代码。

---

## 4. 具体设计方案（How — 怎么设计）

### 4.1 目录与包结构（`apps/jehee/`）

```text
apps/jehee/
├── biome.json                              # 对齐根仓/p3 的 Biome 代码规范检查配置
├── package.json                            # 精确锁定依赖版本（pi-durable 1.5.2, @cucumber/cucumber 13.3.0）
├── tsconfig.json                           # 继承根仓 tsconfig，启用 NodeNext + source 条件
├── docs/
│   ├── README.md
│   ├── PRD.md
│   └── adr/
│       ├── 0001-foundation-and-repo-isolation.md
│       └── 0002-host-skeleton-and-bdd-cucumber.md
├── src/
│   ├── index.ts                            # 对外公共导出入口
│   ├── core/
│   │   └── host.ts                         # JeheeHost：宿主生命周期、单入口提交/插话、回复提取、用量查询
│   └── memory/
│       ├── contract.ts                     # 纯 TS 可插拔记忆契约（MemoryProvider）
│       ├── bridge.ts                       # 将 MemoryProvider 适配为 pi-durable Extension 的防腐层
│       └── static-core.ts                  # 开箱即用的默认基线记忆插件（StaticCoreMemoryProvider）
├── features/
│   ├── persistent-conversation.feature     # 核心产品规格 1：单入口问答、幂等去重、SQLite 重启续接、忙时 Steer 插话
│   ├── pluggable-memory.feature            # 核心产品规格 2：Core 记忆注入、回合后归档回调、运行时热切换记忆插件
│   ├── support/
│   │   └── world.ts                        # Cucumber World 上下文（管理临时目录、faux 模型、宿主生命周期清理）
│   └── steps/
│       └── host.steps.ts                   # Given / When / Then 步骤实现
├── scripts/
│   └── run-bdd.ts                          # 基于 @cucumber/cucumber/api 的原生 TS BDD 执行器
└── test/
    └── host.test.ts                        # 补充底层单元边界测试
```

### 4.2 核心接口设计

#### 1) 可插拔记忆契约（`src/memory/contract.ts`）
完全不引用 `@earendil-works/pi-durable`，确保未来任意记忆算法（如四层抽屉）都是纯数据结构变换：

```typescript
import type { Message } from "@earendil-works/pi-ai";

export type TurnCompletedEvent = {
	readonly conversationId: string;
	readonly userMessages: readonly string[];
	readonly assistantReply: string;
};

export type RequestContextInput = {
	readonly conversationId: string;
	readonly messages: readonly Message[];
};

export interface MemoryProvider {
	readonly id: string;
	renderCorePrompt?(conversationId: string): string | undefined | Promise<string | undefined>;
	shapeRequestMessages?(input: RequestContextInput): readonly Message[] | undefined | Promise<readonly Message[] | undefined>;
	onTurnCompleted?(event: TurnCompletedEvent): void | Promise<void>;
}
```

#### 2) 常驻宿主门面（`src/core/host.ts`）
- `JeheeHost.open(options, context)`：根据 `storage` 配置打开 `MemoryStorage` 或 `openNodeSqliteStorage(filePath)`，注册基础扩展与当前 `MemoryProvider` 桥接扩展，获取或恢复根主对话（`root`），并调用 `harness.resume()` 恢复未竟任务。
- `host.sendMessage(input, context)`：支持传入 `{ text, requestId?, whenBusy?: "steer" | "followUp" | "reject" }`，返回受控结果（包含 `submissionId`、最终状态 `done | unanswered` 及提取出的助手文本回复）。
- `host.submitAsync(input, context)`：异步提交消息并返回句柄（用于在工具慢执行期间模拟用户实时并发发送 `steer` 插话）。
- `host.setMemoryProvider(provider)`：利用 `pi-durable` Registry 同名扩展原地热替换机制（`registry.install`），在不重启宿主、不丢失会话历史的前提下即时切换记忆实现。
- `host.getVisibleHistory(context)` / `host.usage(context)` / `host.close(context)`：提供干净的对话历史读取、累计用量查询与优雅停机。

---

## 5. 风险、权衡与验收标准（Consequences & Verification）

### 5.1 注意事项
- **构建产物依赖**：如根仓 `AGENTS.md` 所述，`@earendil-works/pi-ai` 仅导出 `./dist/*`（无 `source` 条件导出），因此在首次安装依赖后需先构建底层依赖包（`telemetry`、`schema`、`chord`、`codemode`、`ai`、`durable`），之后 `apps/jehee` 即可零编译直接运行 `check` 与 `bdd`。
- **锁文件管控**：新增 `apps/jehee` 工作区依赖后，使用 `npm install --ignore-scripts` 更新工作区依赖链接，并通过 `node scripts/check-pinned-deps.mjs` 验证所有依赖严格锁定精确版本。

### 5.2 Slice 1 验收门禁清单
- [x] `node ../../scripts/biome-check.mjs` 零警告、零错误通过。
- [x] `tsc --noEmit` 类型检查零错误通过。
- [x] `node ../../scripts/check-pinned-deps.mjs` 精确版本检查通过。
- [x] `npm run test:bdd`：2 个 `.feature` 文件（共 5 个核心产品验收 Scenario / 39 Steps）全部绿色通过。
- [x] `npm run test:unit`：底层边界单元测试全部通过。
