Feature: InstaBox 云工坊板块与多任务隔离治理（InstaBox Cloud Workshop & Isolated Subagents）
  作为把复杂开发与调研委托给 Jehee 的个人用户
  我希望主入口将重任务派发到 InstaBox 云电脑的独立 Worktree 后台执行，仅继承基础记忆且完工后主动汇报
  以便主对话始终秒回不卡顿，同时充分利用免费单机 4C8G 云沙箱完成并行工程任务

  Scenario: 派发工坊任务自动唤醒休眠中的 InstaBox 单机、创建 /data 独立 Worktree，且完工后主动推送到 Telegram
    Given InstaBox 免费单机 "box-free-1" 当前处于 "suspended" 休眠状态
    And Jehee 挂载核心记忆 "编码铁律：一律使用严格模式且禁止 any" 并连接 Telegram 主人 "tg-owner-1"
    And 主对话在派发前已有日常闲聊 "中午想吃牛肉面" -> "牛肉面不错！"
    When 主人 "tg-owner-1" 在 Telegram 会话 "tg-chat-1" 发送 "帮我开个工坊任务 auth-fix 修复登录超时，仓库在 /data/jehee/repos/app"
    Then InstaBox 单机 "box-free-1" 被自动 resume 唤醒为 "running" 状态
    And InstaBox 在持久化盘创建了独立 Git Worktree "/data/jehee/worktrees/auth-fix"
    And 主入口先立即向 Telegram 会话 "tg-chat-1" 回复了派发确认消息
    And 工坊子会话 "auth-fix" 的上下文包含核心记忆 "编码铁律：一律使用严格模式且禁止 any"，但绝不包含主窗口闲聊 "中午想吃牛肉面"
    And 工坊子会话在独立目录 "/data/jehee/worktrees/auth-fix" 内执行了修复脚本并完成任务
    And 等待后台工坊结算后，Telegram 会话 "tg-chat-1" 自动收到了工坊完工汇报 "工坊任务 auth-fix 已完成：修复了登录超时并通过单测"

  Scenario: 工坊子任务运行期间支持查询状态、中途发送 steer 纠偏、停止与清理 Worktree
    Given InstaBox 免费单机 "box-free-1" 当前处于 "running" 运行状态且配置了可控慢工坊模型
    And Jehee 已启动云工坊板块
    When 主入口派发后台工坊任务 "refactor-db"（仓库 "/data/jehee/repos/app"）且子任务正在执行中
    Then 查询工坊状态返回 "refactor-db: working (/data/jehee/worktrees/refactor-db)"
    When 主入口调用工坊 stop 停止任务 "refactor-db" 并调用 cleanup 清理其工作区
    Then InstaBox 执行了针对 "/data/jehee/worktrees/refactor-db" 的 git worktree 清理命令
    And 查询工坊状态返回 "No active workshop tasks."
