# Jehee 产品需求文档（PRD v1.0）

- **产品名称**：Jehee
- **产品形态**：7×24 小时常驻个人伙伴型 Bot（Always-on Personal Colleague）
- **文档状态**：Active（随各垂直切片演进同步更新，v1.4）
- **更新日期**：2026-11-24

---

## 1. 产品背景与愿景

传统的对话式 AI 与终端 Coding Agent 大多停留在**“发一条、等一条”的指令工具模式**：用户必须守在屏幕前管理多个会话窗口、手动切换模式按钮，一旦关机或上下文撑满就需要重头交代背景。而前代个人 Agent 尝试通过自建重型 Electron 桌面端和复杂状态机来补齐体验，结果陷入了高昂的 UI 与“补偿层”维护负担。

**Jehee 的产品愿景**：
做一个真正住在日常聊天软件（如 Telegram / QQ / 极简 CLI）里的**长期共事伙伴**。你像给靠谱同事发消息一样随时交代事情、随时补充插话；简单问题它秒回，复杂工程或长线任务它自己在后台“工坊”开独立工作区干完，有重要结论或需要拍板时才回来汇报（*“It knows when to be quiet”*）。

### 核心设计原则
1. **薄补偿层，厚承载层**：不造复杂的专属 GUI 模式菜单，不写死限制强模型发挥的繁琐流程树；把工程资源全部投入在**崩溃恢复、并发插话、上下文隔离、可替换记忆与确定性安全边界**上。
2. **单入口无感体验**：用户永远只面对同一个主对话窗口，不用关心底层何时压缩换窗、后台开了几个子任务。
3. **主 Agent 保持稀疏（Sparse）**：主入口只负责沟通、记事、派活与验收；耗时长、占大量上下文的重活全部下沉到隔离的“工坊”执行。
4. **记忆可换，验证务实**：记忆模块做成标准插件，先把核心 Bot 产品闭环跑顺，后续再通过实际体感与专项 Eval 迭代更优的记忆实现。

---

## 2. 核心功能板块（Functional Pillars）

### 板块一：单入口常驻主对话（Single-Entry Conversational Hub）
- **统一消息入口**：无论来自命令行、Telegram 还是 QQ，外部输入统一归一化为标准消息进入主对话。
- **忙时随时插话与追问**：
  - 当 Jehee 正在调用工具干活时，用户补发纠正指令（如“先别用 npm，改用 pnpm”），系统支持作为 **`steer`（实时插话）** 在当前工具轮结束后立即并入上下文，无需强行掐断重来；
  - 若用户发送的是下一件事，支持作为 **`followUp`（排队追问）** 在本轮答复后自动接续处理；
  - 支持连发消息的短时间窗口防抖合并（避免用户分两句话说完同一件事却触发两次独立推理）；
  - **本地轮询与云端 Webhook 行为对齐**：Telegram 本地长轮询（`start:telegram`）采用非阻塞两阶段入站（快速准入推进 `offset` + 后台异步结算投递），确保连发防抖合并、忙时 `steer` 实时插话以及 `/stop` 紧急刹车在无公网域名的本地守护模式下与 Cloudflare Webhook 100% 一致。
- **请求幂等与断点恢复**：
  - 同一外部消息重投（携带相同 `requestId`）绝不触发重复执行或重复扣费；
  - 宿主进程重启或意外崩溃后，重新打开本地 SQLite 存储即可保留完整历史并恢复未竟任务。
- **同窗口无感换窗（Seamless Handoff）**：
  - 当单窗口累积上下文到达注意力甜点上限时，自动携带交接摘要开启新上下文起点，用户在前端聊天框中完全无感，且历史原话仍留在底层供随时回查。

### 板块二：外部能力连接与工坊协同板块（MCP Connectors & Workshop Gateway）
- **个人助理主定位（总管 + 连接器 + 外部 Coding Agent 网关）**：
  - Jehee 聚焦于代表用户跨时间、跨日常应用（邮件、日历、账单、出行、健康等，对齐 PALE 场景）协调事务，**不重复造轮子替代专业 Coding Agent**；
  - **MCP 连接器骨架**：原生支持双栖连接外部 MCP 服务（云端控制面走 HTTP MCP，本地与 PALE 评测走 `stdio` MCP），默认采用“服务摘要常驻 + `tool_search` 按需加载工具 Schema”，并支持跨应用附件资源读取与大二进制句柄无损传递（防上下文爆窗）；
  - **工坊网关（双执行面 Git Worktree 隔离 + 外部 Coding Agent 调度）**：同时支持云执行面（InstaBox 4C8G，`/data/jehee/worktrees/<task-id>`）与本机执行面（`LocalWorktreeBackend` 本地 `git worktree` 隔离）；通过回合制 `--print`/`--continue` 驱动与后台 PID 轮询直接调度外部成熟 Coding Agent CLI（内置 `pi`、`opencode`、`antigravity` (`agy`)、`claude`、`codex`、`custom` 及 `builtin` 兜底），在独立分支异步执行并附带确定性 `git diff --stat` 验收回推精简结论。
- **受控上下文共享（防噪音污染）**：
  - 工坊子 Agent **只读取基础记忆切片（如用户长期编码偏好、项目规范）与当前任务契约（Task Brief）**；
  - **绝不继承**主聊天窗口里的日常闲聊记录，工坊内部产生的几万行命令输出也**绝不倒灌**回主聊天窗口。
- **异步生命周期管理**：支持查看运行中的工坊任务列表、向指定工坊任务中途追加指示、取消失控任务，并在任务完成或遇到阻塞需人工拍板时向主入口最新活跃渠道投递精简汇报。

### 板块三：可插拔记忆与甜点上下文治理（Pluggable Memory & Context Governance）
- **热插拔记忆契约**：宿主通过统一的 `MemoryProvider` 接口挂载记忆能力，支持在不改动主流程与渠道代码的前提下切换不同记忆方案：
  - **阶段一（随骨架交付）**：提供零复杂度的 `StaticCoreMemory` 基线插件（稳定挂载 `CORE.md` 核心画像 + 回合归档钩子），确保 Bot 产品立即可用且极易排查问题。
  - **阶段二（演进方案）**：实现**四层抽屉式记忆**——
    1. **L1 Core 层**：核心长期偏好与身份准则（窗口周期内前缀冻结，吃满 KV-Cache）；
    2. **L2 中期时序层**：数周至一年内的日程、阶段性目标，按时间轴管理与检索；
    3. **L3 短期任务状态缓存**：活跃跟进事项的即时状态，尾部按需注入、即用即扔；
    4. **L4 历史压缩抽屉**：每轮或跨甜点阈值后异步压缩装入抽屉，保持活跃上下文始终落在低幻觉、高性价比的甜点区间。
- **可移植快照与数据主权（Portable Snapshot）**：支持将长期原子记忆与对话上下文一键导出/导入为与底层 Harness 和模型厂商解耦的标准 JSON（无损迁移/合并/回滚）与 Markdown（人类审阅与外部工坊 Agent 直接可读）快照。

### 板块四：确定性治理、安全与质量度量（Deterministic Governance & Quality）
- **外层确定性打扰控制**：主动提醒或后台汇报是否真正发往聊天软件，必须经过确定性程序门控（用户正在输入/活跃对话时让路、同窗口频率上限、静默时段控制）。
- **工具与安全边界**：按主入口/工坊角色限定可见工具集，高风险外部副作用具备拦截钩子。
- **可观测账单与后期专项 Eval**：实时记录每次模型调用的输入输出、缓存命中（Cache Read / Write）与成本；在产品跑通后，支持对不同 `MemoryProvider` 运行主导者定义的对比评测。

---

## 3. 明确不做的事（Non-Goals）

1. **不做自研桌面 GUI 客户端与复杂终端 TUI**：不开发 Electron 界面、设置表单、模型选择器弹窗、动画桌宠或本机屏幕监控；本地终端 `start:cli` 仅定位为轻量同步冒烟与排错入口，不做异步终端光标重绘或重型 TUI 补偿层。
2. **不做预设模式按钮**：不强迫用户在对话前手动选择 Ask / Plan / Agent 模式，由模型自主判断是直接回答还是派发工坊。
3. **不在骨架阶段超前堆砌复杂检索**：任何新增的记忆分层或压缩规则，都作为独立可拆卸插件实现，随时可关闭或替换。

---

## 4. 分阶段交付路线图（Vertical Slices）

| 切片 | 目标交付物 | 验收标志（BDD Scenarios） |
| :--- | :--- | :--- |
| **Slice 1（已完成）** | **最小常驻宿主骨架（`JeheeHost`）+ 可插拔记忆底座 + Cucumber BDD 体系** | 通过 Gherkin 场景验证：单入口问答与 `requestId` 幂等、SQLite 重启持久化恢复、忙时 `steer` 插话纠偏、记忆插件热插拔生效且不污染底层事实。 |
| **Slice 2（已完成）** | **单入口交互网关（`ChannelGateway` + Telegram 适配器）+ 连发合并与中断控制** | 支持白名单鉴权、空闲防抖合并、忙时自动 `steer`、`/status` 与 `/stop` 确定性指令、跨渠道单根会话无缝切换。 |
| **Slice 3（已完成）** | **云工坊板块（InstaBox 云电脑按需唤醒 + 多 Git Worktree 沙箱隔离 + 完工回执）** | 主入口可将开发/长任务派发至 `/data/jehee/worktrees/<task>`，主窗口保持无重型工具污染，子任务完工后主动向最新活跃渠道推送精简汇报。 |
| **Slice 3.5（已完成）** | **双栖运行入口（本地 CLI / Telegram 守护进程 + Cloudflare Workers DO）+ `opencode-go` 模型目录** | 默认接入 `opencode-go`（含 34 款模型）及多厂商注册表；一套代码同时支持本地 `.env` 直跑与 Cloudflare Free Worker 零月租部署（通过 Edge 打包门禁）。 |
| **Slice 3.6（已完成）** | **Telegram 本地长轮询非阻塞两阶段入站（打通本地防抖、`steer` 与 `/stop`）** | 轮询器仅等待毫秒级准入（`admit`）即推进 `offset` 拉取下一批消息，实测跨批连发防抖、慢工具期间实时 `steer` 插话与 `/stop` 紧急叫停全部通过 BDD 验收；本地 CLI 保持精简同步交互。 |
| **Slice 4（已完成）** | **双栖 MCP 连接器骨架（`tool_search` 按需暴露 + 资源三件套 + 附件句柄 + 写门控钩子）与对比 Eval** | 支持多实例 HTTP / 本地 `stdio` MCP（对接 PALE 环境）、`list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`、乐观锁报错透传、PDF/ICS 大附件句柄无损流转，并完成 `eager` vs `deferred` 对比评测与失败复盘归档（`Eval-0001`）。 |
| **Slice 5A（已完成）** | **确定性安全门控与主动打扰治理（SQLite 单次审批票据 + Telegram 内联按钮确认 + 三重静默暂存门控）** | 高危 MCP 写操作生成持久化 `apv_...` 确认卡片且等待期不阻塞主对话，支持 Telegram 点按钮与 `/approve` 单次防调包放行；后台推送支持静默时段、忙时让路、冷却频控与暂存汇总交付。 |
| **Slice 5B（已完成）** | **工坊演进为双执行面外部 Coding Agent 网关（`pi` / `opencode` / `antigravity` / `claude` / `codex`）** | 支持云端 InstaBox 与本机双 Git Worktree 隔离，通过回合制 `--print`/`--continue` 与后台 PID 轮询调度异构外部 Coding Agent CLI，并附带确定性 `git diff --stat` 验收回执。 |
| **Slice 5C-1（已完成）** | **热插拔持久化原子记忆插件（L1 Core 一页纸 + 别名/时间检索 + 软删除 + `/memory` 指令）与 `Eval-0002`** | 基于 `pi-durable` `MemoryDoc` 实现双栖持久化记忆、`memory_save`/`memory_search`/`memory_forget` 工具、`/memory` 确定性白名单指令、工坊只读隔离与 `StaticCore` vs `AtomicMemory` 对比评测（`Eval-0002`）。 |
| **Slice 5C-2（已完成）** | **后台空闲/定时异步记忆整理（去重、冲突消解与隐性事实提炼）** | 基于 `MemoryConsolidationDoc` 增量水位线、`pi-durable` 单活空闲休眠任务、严格 JSON Patch 确定性应用器（墓碑可逆恢复）与 `/memory consolidate` 白名单指令，三臂 `Eval-0002` 对比达 `100%`（vs 5C-1 `57.1%` / 基线 `14.3%`）。 |
| **Slice 5C-3（已完成）** | **上下文与记忆的可移植快照（Portable Export / Import）** | 定义 Harness 与模型无关的 `jehee.portable.snapshot` v1 格式（无损 JSON + Markdown 视图），支持 `JeheeHost` 跨宿主/换模型无损迁移与 `merge`/`replace` 原子导入、CLI `export`/`import` 及 `/memory export` 白名单指令。 |
