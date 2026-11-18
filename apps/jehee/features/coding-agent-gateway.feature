Feature: 工坊双执行面外部 Coding Agent 网关（External Coding Agent Workshop Gateway）
  作为通过 Jehee 远程或跨窗口调度专业编程工具的开发者
  我希望工坊支持在本机或云端隔离 Git Worktree 中调度 pi、opencode、antigravity 等外部 CLI 并自动核验 Git 变更
  以便主对话只做派单与验收，重型编码交给最擅长的外部 Coding Agent 在独立分支并行完成

  Scenario: 本机 Git Worktree 调度外部 CLI 完成首轮改码、仅继承 L1 核心编码偏好并回推确定性 Git Diff 回执
    Given 已初始化真实本地 Git 仓库并挂载 LocalWorktreeBackend 与 L1 核心记忆 "严格禁用 var，统一使用 const"
    And 主人先在 Telegram 会话 "chat-600" 聊过日常闲聊 "晚饭准备去吃牛肉火锅"
    When 主人发送工坊需求 "开一个工坊 fix-header 把 src/app.ts 里的标题改成 v2"
    And 等待后台外部 Coding Agent CLI 任务执行与主会话汇总完毕
    Then 外部 CLI 在独立分支 "jehee/fix-header" 收到了 L1 偏好 "严格禁用 var"，且未收到主窗口闲聊 "牛肉火锅"
    And 原始主仓库的 "src/app.ts" 保持未改动，而工坊分支的 "src/app.ts" 已更新为含 "v2" 内容
    And Telegram 会话 "chat-600" 收到主动完工汇报，且主会话收到的工坊回执包含确定性 "branch=jehee/fix-header" 与 "src/app.ts" 变更统计

  Scenario: 对同一工坊任务调用 send 自动触发 --continue 会话续接并在同分支增量改码
    Given 已初始化真实本地 Git 仓库并挂载 LocalWorktreeBackend 与外部 CLI 驱动
    When 主人先启动工坊任务 "iter-feature" 完成第一轮修改，再追加指令 "继续在 src/app.ts 末尾加上版本号注释"
    And 等待后台外部 Coding Agent CLI 续聊轮执行与主会话汇总完毕
    Then 第二轮外部 CLI 调用自动携带了 "--continue" 续聊标志且未重复拼接首轮核心提示头
    And 工坊状态查询显示任务 "iter-feature" 已累计完成 "turns=2"

  Scenario: 同屏并行调度 antigravity 与 opencode 异构驱动，且对慢速外部 CLI 执行 stop 可按 PID 立即终止
    Given 已挂载支持记录命令行的模拟执行后端（默认驱动 "opencode"）
    When 主会话同时派生指定驱动 "antigravity" 的工坊 "ui-agy" 与指定驱动 "opencode" 的慢速工坊 "api-oc"
    Then 后端分别收到了 "agy --print --dangerously-skip-permissions" 与 "opencode run --auto" 的隔离启动命令
    When 在慢速工坊 "api-oc" 仍在运行期间主会话调用 "stop" 终止 "api-oc"
    Then 后端收到了针对 "api-oc" 进程 PID 的终止指令，且工坊状态查询显示 "api-oc: idle"
