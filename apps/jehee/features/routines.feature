Feature: 主动定时提醒、周期例行任务、用户侧时钟锚点与持久化路由（Proactive Routines & Clock Anchor）
  作为 7x24 常驻的个人伙伴型 Bot
  我希望在不破坏系统前缀 KV-Cache 的前提下感知当前本地时间，并能稳定执行零 Token 提醒与可静默抑制的周期巡检任务
  以便跨越重启与 Cloudflare DO 休眠后仍能按时触达主人的最后活跃会话

  Scenario: 本地时钟锚点注入用户侧消息且保持系统前缀完全不变
    Given 已启动开启 Routines 与时区 "+08:00" 的 Jehee 宿主（时钟可推进）
    When 用户在不同时间点连续发送两轮普通对话
    Then 两轮请求发往模型的系统提示词前缀完全一致且不包含 "[Local Time:"
    And 发往模型的用户侧消息包含两个时刻对应的本地时钟锚点，而持久化可见历史保持纯净

  Scenario: 定时 direct_notify 提醒在 SQLite 重启后自动唤醒并零 Token 推送至持久化路由
    Given 已以本地 SQLite 模式启动 Jehee 宿主与 Telegram 渠道网关（授权主人 "tg-owner-6a"）
    When 主人 "tg-owner-6a" 在会话 "chat-persisted-6a" 发过一条消息并重启宿主与网关
    And 宿主创建一条 60 毫秒后触发的 direct_notify 提醒 "会议即将开始" 并等待调度器结算
    Then 底层模型重启后调用次数为 0，且 Telegram 会话 "chat-persisted-6a" 自动收到提醒 "会议即将开始"

  Scenario: agent_prompt 周期例行任务支持 [SILENT] 静默抑制与非静默主动汇报
    Given 已启动开启 Routines 与 Trace 录制器的 Jehee 宿主及冷启动 Telegram 网关（授权主人 "cold-tg-1"）
    When 创建一条回复 "[SILENT]" 的 agent_prompt 巡检与一条返回 "今日待办已就绪" 的 agent_prompt 简报并等待触发
    Then "[SILENT]" 巡检不会向 Telegram 推送任何消息，而 "今日待办已就绪" 自动回退投递至 "cold-tg-1"
    And Trace 录制器记录了 2 条 "jehee.routine.fire" Span

  Scenario: 白名单 /routines 指令支持查询、立即执行与取消，且拒绝未授权陌生人
    Given 已启动开启 Routines 的 Jehee 宿主与 Telegram 渠道网关（授权主人 "tg-owner-cmd"）并预置一条每日提醒
    When 陌生人 "stranger-6a" 发送定时指令 "/routines list"
    Then 陌生人定时指令返回 unauthorized 且无出站消息
    When 主人 "tg-owner-cmd" 依次发送 "/routines list"、"/routines run" 与 "/routines cancel"
    Then 渠道依次回执定时任务列表、触发成功提示与取消确认，且任务列表归零
