# ADR-0004：InstaBox 免费版云工坊板块（按需唤醒、`/data` 多 Worktree 隔离与后台协同治理）

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-18
- **关联需求**：[PRD v1.0 — Slice 3](../PRD.md)

---

## 1. 背景与问题（Context & Problem）

在 Slice 1（`JeheeHost` 常驻宿主 + 可插拔记忆底座）和 Slice 2（双栖渠道网关 + Telegram 首发适配）落地后，当前主入口仍缺少把耗时长、输出量大的工程/调研任务剥离出去的 **「工坊板块（Workshop）」**。

结合用户的实际资源与产品原则，设计工坊板块必须同时解决四个硬约束：

1. **InstaBox 免费计划配额约束**：
   - 单工作区最多同时存在 **1 台沙箱机器**（任何状态均计入配额，因此不能通过 `POST /v1/machines/{id}/fork` 开多台机器并行）；
   - 机器规格为 4 vCPU / 8 GiB RAM，带 **20 GiB `/data` 持久化磁盘**（而 `/tmp` 为受限内存盘）；
   - 闲置 **30 分钟**固定自动暂停（`state: "suspended"`），单次连续运行有 `maxRunMinutes` 上限。
2. **双栖控制面兼容约束**：
   控制面需同时支持在本地 Node 24 与 Cloudflare Workers Free（无本地 `ssh` 二进制与子进程）中运行，因此连接 InstaBox 必须完全基于标准 HTTPS `fetch` 调用 InstaBox OpenAPI v1。
3. **上下文与工具严格隔离（主 Agent 稀疏原则）**：
   - 主入口不应直接暴露底层沙箱文件读写与 Shell 工具，只持有极简的 `workshop` 编排工具；
   - 工坊子会话**绝不能继承主窗口的日常闲聊历史**，只能继承受控的基础记忆切片（L1 Core / 工坊专属规范），且禁止子工坊无限递归派生孙子工坊。
4. **异步不阻塞与崩溃安全汇报**：
   主入口派发工坊任务后必须立即回复用户（主窗口继续秒回闲聊）；工坊在后台跑完后自动将精简结论回传主入口，并主动投递到用户最新活跃的聊天渠道（Telegram 或 QQ），且进程中途重启不丢回执、不重复汇报。

---

## 2. 备选方案对比（Alternatives Considered）

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：每个工坊任务调用 InstaBox `fork` 克隆新机器** | 整机级隔离（含独立端口与内核环境） | 违反 InstaBox 免费计划“最多 1 台机器”硬限制，第二个任务会直接触发 `429 quota_exceeded`。保留接口供未来付费计划扩展，但不作为默认实现。 |
| **方案 B：在主会话内同步调用工具直接操作 InstaBox** | 实现最简单，无需子会话管理 | 几万行测试与构建输出会瞬间撑爆主对话窗口、污染 KV-Cache，且执行期间主聊天窗口完全卡死，违背“主 Agent 保持稀疏”原则。 |
| **方案 C：用 `@earendil-works/pi-env` 本地 `ssh` 进程连接 InstaBox** | 现成 Rust 守护进程文件操作快 | 依赖宿主机 `child_process.spawn("ssh")`，无法在 Cloudflare Workers 边缘控制面运行。 |
| **方案 D（最终采用）：纯 `fetch` InstaBox OpenAPI 客户端 + 单机按需唤醒 `/data` 多 Git Worktree 供应器 + `pi-durable` 后台 Anchor/Reporter 子会话** | 完美适配免费版单机与 CF Workers 双栖运行；30 分钟自动休眠后任意工具调用可透明重唤醒；主从上下文彻底隔离且崩溃可恢复 | 需针对 InstaBox OpenAPI v1 封装轻量客户端与沙箱专属工具集（`box_exec` / `box_read` / `box_write`）。 |

---

## 3. 决策与核心依据（Why — 为什么这么设计）

### 3.1 针对 InstaBox OpenAPI v1 的精确协议对齐

经核对 `https://api.instabox.sh/v1/openapi.json` 权威规范，锁定以下关键协议细节（避免凭猜测踩坑）：
- **状态字段名为 `state`（非 `status`）**：机器状态枚举包含 `running`、`suspended`、`stopped`、`starting`、`resuming` 等；异步操作 `Operation` 状态枚举为 `queued`、`running`、`succeeded`、`failed`。
- **透明唤醒（Lazy Auto-Wake）**：不仅在创建工坊任务时检查机器状态，而且在工坊子 Agent 每次调用 `box_exec` / `box_read` / `box_write` 前均经过轻量 `ensureRunning()`——若任务等待人工拍板超过 30 分钟导致机器自动 `suspended`，下一次工具调用会自动附带 `Idempotency-Key` 触发 `/resume`（若为 `stopped` 则触发 `/start`）并轮询 `Operation` 完成后无缝继续执行。
- **文件与命令端点分工**：
  - 命令执行走 `POST /v1/machines/{id}/exec`（传入 `cwd` 锁定到当前子任务的 Worktree 目录）；
  - 文件读取走 `GET /v1/machines/{id}/files/content?path=<absPath>`（避免用 `exec cat` 触发 1 MiB 截断或 UTF-8 替换）；
  - 文件写入走 `PUT /v1/machines/{id}/files?path=<absPath>&parents=true`（服务端先写临时文件再原子 rename，中断不留半截脏文件）。
- **持久化路径一律落在 `/data/jehee/`**：规避受限的 `/tmp` 内存盘，所有仓库缓存与子任务 Worktree 均置于 `/data/jehee/worktrees/<task-slug>`。

### 3.2 为什么用「Background Anchor + Durable Reporter」管理工坊子会话？

参考同仓 `@earendil-works/pi-durable` 官方范式（`22-subagent-background.ts`）：
1. **所有权隔离（Anchor Task，`background: true`）**：工坊子会话挂在一个后台 Anchor 任务名下，使得主对话 `waitForIdle()` 无需等待工坊跑完即可立即收束本轮回复，且用户在主对话发 `/stop` 取消普通闲聊时不会误杀正在后台编译的工坊任务。
2. **上下文纯净隔离**：通过 `tx.createConversation` 新建空白对话（而非 `fork` 主对话），并通过 `configure`：
   - 移除主入口的 `workshop` 编排扩展（防止递归套娃），挂载仅对工坊开放的 `WorkshopSandboxTools`（`box_exec`、`box_read`、`box_write`）；
   - 将工坊专属指令设为 `MemoryProvider.renderWorkshopPrompt`（默认仅提取 L1 Core 基础记忆）+ 任务契约（Task Brief）+ 分配好的独立 `cwd` 路径。
3. **断点安全的完工汇报（Reporter Task）**：后台 Reporter 等待子会话 `submission.wait()` 结算后，在单个原子事务中记录已汇报 `EntryId`（防崩溃重复汇报），再以幂等 `requestId` 向主对话投递 `[workshop:<name> completed]` 消息；主对话生成精简人话总结后，触发 `JeheeHost` 的后台通知回调，由 `ChannelGateway` 自动推送到用户最近活跃的 Telegram / QQ 会话。

---

## 4. 具体设计方案（How — 怎么设计）

### 4.1 模块目录结构（`apps/jehee/src/workshop/`）

```text
apps/jehee/src/workshop/
├── instabox-client.ts   # 零依赖 fetch 实现 InstaBox OpenAPI v1（getMachine, start, resume, waitOperation, exec, readFile, writeFile, ensureRunning）
├── provisioner.ts       # WorkshopProvisioner 策略接口 + SingleBoxWorktreeProvisioner（免费单机唤醒 + /data/jehee/worktrees/<name> git worktree 管理）
├── sandbox-tools.ts     # 仅对工坊子会话可见的远程工具：box_exec、box_read、box_write（路径锚定至该子会话分配的 Worktree cwd）
└── extension.ts         # 主入口 `workshop` 编排工具（spawn / send / status / stop / cleanup）+ 持久化 Anchor / Reporter 任务与注册文档
```

### 4.2 记忆契约与网关联动增量

1. **`MemoryProvider` 扩展可选切片方法（`src/memory/contract.ts`）**：
   ```typescript
   renderWorkshopPrompt?(taskName: string): string | undefined | Promise<string | undefined>;
   ```
   若记忆插件未单独实现该方法，默认回退调用 `renderCorePrompt("workshop:" + taskName)`，确保工坊子 Agent 天然拿到用户长期编码规范（L1 Core），而拿不到主窗口的日常对话历史。
2. **`JeheeHost` + `ChannelGateway` 后台完成主动回推**：
   - `JeheeHost` 监听根对话上由工坊 Reporter 触发的后台跟进回合（`[workshop:...]` 输入），当主 Agent 产出对用户的汇报回复时，触发注册监听器 `onProactiveReply(replyText)`；
   - `ChannelGateway` 绑定该回调，自动将主 Agent 整理好的人话汇报发往 `gateway.lastActiveRoute`（同样受 Staging 发送保护锁约束）。

---

## 5. 风险、权衡与验收标准（Consequences & Verification）

### 5.1 安全与路径约束
- `box_read` / `box_write` / `box_exec` 对相对路径统一基于该工坊子会话登记的 `worktreeCwd` 解析，并拒绝 `..` 越界逃逸出其专属 `/data/jehee/worktrees/<name>` 目录（除非显式只读访问共享仓库目录），避免不同工坊子任务互相改乱代码。

### 5.2 Slice 3 验收门禁清单
- [x] `npm run check`（Biome + `tsc --noEmit`）零警告、零错误通过。
- [x] 零新增外部 npm 依赖，根仓 `check-pinned-deps.mjs` 与相对导入检查通过。
- [x] 新增 `features/cloud-workshop.feature`，通过 Cucumber BDD 验证：
  1. 派发工坊任务自动唤醒 `suspended` 状态的 InstaBox 单机并在 `/data/jehee/worktrees/` 建立独立 Git Worktree，主入口秒回不阻塞；
  2. 工坊子会话仅继承 Core 基础记忆（零主对话闲聊泄漏），可在专属 Worktree 内调 `box_exec`/`box_write` 干活；
  3. 工坊后台完工后自动汇报主入口，并主动推送到用户最新活跃的聊天渠道（Telegram）；
  4. 支持查询工坊状态（`status`）、中途插话（`send`）、停止（`stop`）与清理 Worktree（`cleanup`）。
