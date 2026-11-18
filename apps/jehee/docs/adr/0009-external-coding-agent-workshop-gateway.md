# ADR-0009：工坊升级为双执行面外部 Coding Agent 网关（Slice 5B）

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-18
- **关联需求**：[PRD v1.3 — 板块二 & Slice 5B](../PRD.md)、[ADR-0004](./0004-instabox-cloud-workshop.md)、[ADR-0005](./0005-runtime-entrypoints-and-opencode-go.md)、[ADR-0008](./0008-write-approval-and-quiet-governance.md)

---

## 1. 背景与问题（Context & Problem）

在 Slice 3（`ADR-0004`）中，工坊首发形态是在 `JeheeHost` 内部新建一个 `pi-durable` 子会话，仅挂载 `box_exec`、`box_read`、`box_write` 三把基础远程工具改代码。随着产品定位明确为**「个人助理总管 + 外部专业 Coding Agent 的上层编排网关」**（类似对话式的多 Agent 终端调度器，但打通 Telegram/CLI 与异构引擎），旧执行方式暴露出三个明显瓶颈：

1. **重复造低配版 Coding Agent**：内置 3 把工具缺乏精准行级 `edit`、符号检索、项目级 `AGENTS.md` / Skills 自动发现与长上下文压缩，工程表现远不及成熟的外部 CLI（如 `pi`、`opencode`、`antigravity` (`agy`)、`claude`、`codex`）。
2. **仅支持远程 InstaBox，无法直接调度本机开发环境**：用户在本地电脑常驻运行 `start:telegram` 时，往往希望在外面用手机发一条消息，直接调度家里电脑已装好全套环境与密钥的 `agy` 或 `opencode` 在本机仓库拉隔离分支干活，而不仅限于远程 Linux 沙箱。
3. **长耗时 CLI 任务的无阻塞存活与客观验收**：复杂重构或全量测试常耗时数分钟以上。若同步阻塞单次 HTTP `exec` 会触发超时；且外部 CLI 退出后不能只听其口头总结，必须附带确定性的 Git 变更快照供主会话核验。

---

## 2. 备选方案对比（Alternatives Considered）

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：接入第三方终端复用器（如 Herdr）统一托管** | 自带多面板状态跟踪与远程连接 | 需额外维护常驻守护进程与专有 Socket 协议，对特定 CLI（如 `opencode` 新标志或 `agy`）适配受制于外部进度，且无法在 Cloudflare Workers DO 无状态边缘环境中直接驱动。 |
| **方案 B：对接单一 CLI 的私有流式协议（如 `pi --mode rpc`）** | 支持工具轮内的细粒度事件流 | 强耦合单一 CLI，无法统一调度 `antigravity` (`agy`)、`opencode`、`claude`、`codex`。 |
| **方案 C（最终采用）：双执行后端（`InstaBox` 云沙箱 + `LocalWorktree` 本机目录）+ 回合制 `--print`/`--continue` 驱动器矩阵 + `pi-durable` 后台 PID 状态轮询 + Git Diff 确定性验收** | 一套协议通吃 `pi`、`opencode`、`antigravity`、`claude`、`codex` 与自定义模板；同时支持云端与本机 Worktree 隔离；轮询期间 Cloudflare DO 可休眠零超时；保留 `builtin` 模式平滑兜底 | 需将原 `InstaBox` 硬编码解耦为跨平台 `WorkshopExecutionBackend`，并把本机 `child_process` 隔离在 Node 专属模块外以确保 Worker 包纯净。 |

---

## 3. 决策与核心依据（Why — 为什么这么设计）

### 3.1 双执行后端（1A：`InstaBox` 云端 + `LocalWorktree` 本机）且保持 Worker 打包纯净
- 抽象跨平台接口 `WorkshopExecutionBackend`（`prepareWorkspace`、`cleanupWorkspace`、`startJob`、`pollJob`、`stopJob`、`inspectGitSummary`）：
  - **云端后端（`InstaBoxWorkshopBackend`）**：纯 `fetch` 实现，零 `node:child_process` 依赖，可在 Cloudflare Workers DO 与本地 Node 双端运行；
  - **本机后端（`LocalWorktreeBackend`）**：独立放在 Node 专属模块 `src/workshop/node-local-backend.ts`（在 `check-worker-bundle.ts` 中显式禁止打入 Worker 包），直接对本机仓库执行 `git worktree add -B jehee/<slug>` 并在本地拉起 CLI 子进程，兼容 Windows（自动解析 `PATHEXT` 下的 `.exe` / `.cmd` 并用 `taskkill /T /F` 杀进程树）与 Linux/macOS（进程组 `-pid` 信号回收）。

### 3.2 回合制 `--print` + `--continue` + 后台落盘轮询（2A）
- **首轮与续聊解耦**：
  - 首轮 `spawn`：将「L1 Core 编码偏好（若有）+ 当前 Task Brief」拼装为初始提示词（绝不混入主会话日常闲聊），以非交互打印模式拉起外部 CLI；
  - 后续 `send`：在同一隔离 Worktree 目录下使用各 CLI 原生的会话续接标志（`-c` / `--continue` / `resume --last`）追加指令；若当前已有任务在跑，`followUp: true` 自动排入该任务队列待当前轮结束后接续执行，`followUp: false` 则先终止当前进程再以新指令重启续聊。
- **后台非阻塞轮询**：`startJob` 立即落盘启动后台作业并返回 `{ jobId, pid }`；`WorkshopCliRunner` 通过 `pi-durable` 的 `sleeping` 状态（带单次唯一信号键 `WorkshopCancelSignal`）周期性调用 `pollJob` 检查 `exit.code` 完成标记。在 Cloudflare Workers 上轮询间隔内 DO 自动休眠释放内存，彻底规避单次执行超时；`workshop(stop)` 直接按 `pid` 终止整棵进程树并立即唤醒取消任务。

### 3.3 内置五大主流 CLI 预设（含 `antigravity` 与 `opencode`）+ 确定性 Git 验收回执
基于实机核验的权威 CLI 参数，内置以下驱动预设（支持全局默认配置 `JEHEE_WORKSHOP_DRIVER`，也支持主会话在 `workshop(spawn)` 时按任务动态指定 `driver`，实现同屏多工坊异构并行）：
1. **`pi`**（同仓 `@earendil-works/pi-coding-agent`）：
   - 首轮：`pi --print [--model <m>] -- <prompt>`
   - 续聊：`pi --continue --print [--model <m>] -- <prompt>`
2. **`opencode`**（OpenCode CLI）：
   - 首轮：`opencode run --auto [-m <m>] -- <prompt>`
   - 续聊：`opencode run --auto -c [-m <m>] -- <prompt>`
3. **`antigravity`**（Google Antigravity CLI `agy`）：
   - 首轮：`agy --print --dangerously-skip-permissions --add-dir <cwd> [--model <m>] -- <prompt>`
   - 续聊：`agy --print --dangerously-skip-permissions --add-dir <cwd> --continue [--model <m>] -- <prompt>`
4. **`claude`**（Claude Code CLI）：
   - 首轮：`claude --print --dangerously-skip-permissions [--model <m>] -- <prompt>`
   - 续聊：`claude --continue --print --dangerously-skip-permissions [--model <m>] -- <prompt>`
5. **`codex`**（OpenAI Codex CLI）：
   - 首轮：`codex exec --dangerously-bypass-approvals-and-sandbox [-m <m>] -- <prompt>`
   - 续聊：`codex exec resume --last --dangerously-bypass-approvals-and-sandbox [-m <m>] -- <prompt>`
6. **`custom`**（自定义命令模板）与 **`builtin`**（保留内置 3 工具子会话兜底）。

**确定性 Git 验收门禁**：每次外部 CLI 进程结束后，后端自动在同一 Worktree 执行 `git status --short` 与 `git diff --stat`（自动排除 `.jehee-workshop/` 元数据目录），对 CLI 原始输出执行字节上限截断（默认保留尾部 12 KiB 关键结论，严禁几万行编译日志倒灌主窗口），与真实 Git 改动统计合并为结构化回执呈交主会话。

---

## 4. 具体设计方案（How — 怎么设计）

### 4.1 模块结构演进

```text
apps/jehee/
├── src/
│   ├── workshop/
│   │   ├── coding-agent-driver.ts  # 五大 CLI 预设（pi/opencode/antigravity/claude/codex/custom）、提示词封装与输出截断
│   │   ├── backend.ts              # WorkshopExecutionBackend 跨平台接口与 InstaBoxWorkshopBackend 远程实现
│   │   ├── node-local-backend.ts   # Node 专属本机 Git Worktree 与跨平台子进程（Windows taskkill / POSIX -pid）后端
│   │   ├── provisioner.ts          # 保留 SingleBoxWorktreeProvisioner 与任务名安全校验
│   │   ├── sandbox-tools.ts        # 保留 builtin 模式沙箱工具
│   │   └── extension.ts            # 升级 workshop 工具：支持按任务选 driver、durable 轮询任务 WorkshopCliRunner 与 Git 验收回执
│   └── runtime/
│       ├── config.ts               # 解析 JEHEE_WORKSHOP_DRIVER、JEHEE_WORKSHOP_AGENT_MODEL、JEHEE_WORKSHOP_LOCAL_ROOT 等
│       └── node.ts                 # 自动装配云端 InstaBox 或本机 LocalWorktreeBackend
├── features/
│   ├── coding-agent-gateway.feature
│   └── steps/
│       └── coding-agent-gateway.steps.ts
└── test/
    └── coding-agent-gateway.test.ts
```

### 4.2 新增环境变量（`.env`）
- `JEHEE_WORKSHOP_DRIVER`：默认驱动器（`"pi"` | `"opencode"` | `"antigravity"` | `"claude"` | `"codex"` | `"custom"` | `"builtin"`；当挂载外部后端时推荐 `"opencode"` / `"antigravity"` / `"pi"`，未指定时默认 `"builtin"` 以保持向后兼容，`.env.example` 提供显式配置示例）；
- `JEHEE_WORKSHOP_AGENT_MODEL`：可选传给外部 Coding Agent CLI 的模型名；
- `JEHEE_WORKSHOP_LOCAL_ROOT`：本地 Node 模式下存放隔离 Git Worktree 的根目录（如 `E:/CODE/.jehee-worktrees`；当未配 `INSTABOX_*` 且配了该项时自动启用本机工坊后端）；
- `JEHEE_WORKSHOP_DEFAULT_REPO`：可选默认仓库路径，省去每次对话手动报仓库绝对路径。

---

## 5. 风险、权衡与验收标准（Verification & Risks）

### 5.1 风险与缓冲
- **`.jehee-workshop` 状态目录污染 Git 工作区**：后台作业需在 Worktree 内写 `.pid` / `.stdout` / `.exit` 状态文件；若直接散落在根目录会被 `git status` 误报为未跟踪源码。解决方案：统一写入 `<cwd>/.jehee-workshop/`，在创建 Git Worktree 时自动向该工作树专属 exclude（或 `git status` 过滤逻辑）排除 `.jehee-workshop/`，保证仓库 `git status` 100% 干净。
- **Windows `.cmd` 包装脚本残留子进程**：Windows 上 npm 全局安装的 `opencode.cmd` / `pi.cmd` 会多套一层 `cmd.exe`；`LocalWorktreeBackend.stopJob` 统一调用 `taskkill /pid <pid> /T /F` 按进程树清理，杜绝孤儿进程。

### 5.2 Slice 5B 验收门禁清单
- [x] `npm run check`（Biome + `tsc --noEmit` + `check-worker-bundle`）零错误通过，且 `src/workshop/node-local-backend.ts` 绝不进入 Cloudflare Worker 产物。
- [x] 单元测试（`test/coding-agent-gateway.test.ts`）覆盖：`pi` / `opencode` / `antigravity` / `claude` / `codex` / `custom` 首轮与 `--continue` 参数构造、输出截断、InstaBox 后台脚本组装，以及真实本地 Git 仓库 Worktree 创建/清理与 `.jehee-workshop` 隔离。
- [x] Cucumber BDD（`features/coding-agent-gateway.feature`）端到端验证：
  1. 在真实本地 Git 仓库上通过 `workshop(spawn)` 驱动外部 CLI 创建分支修改文件：首轮注入 L1 Core 编码偏好、不泄漏主对话闲聊、轮询完成后向主会话回推包含真实 `git diff --stat` 的精简回执；
  2. 对同一工坊任务调用 `workshop(send)` 触发 `--continue` 会话续接，在同一 Worktree 分支上增量修改文件并二次汇报；
  3. 支持同场并行指定不同驱动（如任务 A 指定 `antigravity`、任务 B 指定 `opencode`），且对慢速运行中的外部 CLI 调用 `workshop(stop)` 可按 PID 立即终止进程树。
