Feature: 确定性写操作人工确认闭环与主动打扰静默门控（Write Approval Gate & Proactive Quiet Governance）
  作为将真实邮箱、日历与日常聊天渠道 7×24 小时托付给 Jehee 的主人
  我希望高危 MCP 写操作必须经过不阻塞主对话的单次参数绑定确认，且后台主动推送遵守静默时段与防刷屏门控
  以便随时安心插聊其他话题、杜绝误发与参数调包，并在深夜或忙碌时免受无谓打扰

  Scenario: 高危写操作生成确认卡片且不阻塞日常闲聊，主人点击 Telegram 内联按钮批准后自动续跑并单次消费
    Given 已启动开启 "confirm-writes" 门控的模拟邮件 MCP 宿主与 Telegram 渠道网关（授权主人 "tg-owner-1"）
    When 主人 "tg-owner-1" 在会话 "chat-500" 发送 "帮我把接机草稿 msg-draft-1 发出去"
    Then 邮件写操作被拦截并生成待确认票据，Telegram 会话 "chat-500" 收到带内联批准按钮的确认卡片，实际外发邮件数为 0
    And 等待确认期间主对话处于空闲状态，主人穿插发送 "顺便问一下今天星期几" 能立即得到正常回复
    When 主人 "tg-owner-1" 点击 Telegram 确认卡片上的内联批准按钮
    Then 系统自动唤醒主对话执行已批准的 "mcp__mail__mail_send"，邮件 "msg-draft-1" 成功发出（外发邮件数为 1）
    And 该单次批准票据已消费，若再次尝试无新审批直接调用同一发信操作仍会被门控拦截（外发邮件数保持为 1）

  Scenario: 参数指纹严格防调包（批准草稿 A 不能用于发送草稿 B），且待批票据跨越 SQLite 重启持久化保留
    Given 已在本地 SQLite 开启 "confirm-writes" 门控挂载模拟邮件 MCP 与渠道网关（授权主人 "tg-owner-1"）
    When 主人 "tg-owner-1" 在会话 "chat-501" 请求发送草稿 "msg-draft-1" 触发生成待批票据
    And 宿主进程重启并重新打开同一本地 SQLite 数据库后查询 "/status"
    Then 状态回执显示 "pending_approvals: 1"（待批票据跨越重启未丢失）
    When 主人发送 "/approve" 批准该票据，但模型在续跑轮试图篡改参数改发另一封邮件 "msg-secret-99"
    Then 篡改参数的发信调用被参数指纹门控拦截并生成新待批票据，邮件实际外发数仍为 0

  Scenario: 未授权陌生人点击 Telegram 批准按钮或发送 /approve 指令均被白名单直接拒绝
    Given 已启动开启 "confirm-writes" 门控的模拟邮件 MCP 宿主与 Telegram 渠道网关（授权主人 "tg-owner-1"）
    When 主人 "tg-owner-1" 在会话 "chat-502" 请求发送草稿 "msg-draft-1" 生成待确认票据
    And 未授权陌生人 "stranger-88" 伪造点击该票据的 Telegram 内联批准按钮并发送 "/approve"
    Then 两次未授权操作均返回 "unauthorized"，待确认票据仍保持 "pending" 且邮件实际外发数为 0

  Scenario: 静默时段、冷却频控与 [SILENT] 哨兵治理后台推送，并在非静默时段交互或 /flush 时无损补发
    Given 已启动配置静默时段 "23:00-08:00"（UTC+08:00）与 30 秒冷却窗口的渠道网关（授权主人 "tg-owner-1"）
    And 当前时钟处在深夜静默时段 "2026-11-18T16:30:00Z"（北京时间 00:30），主人先发送过 "/status" 激活路由 "chat-503"
    When 后台连续产生 "[SILENT]" 空巡检与两条完工汇报 "工坊任务 alpha 已完成"、"工坊任务 beta 已完成"
    Then "[SILENT]" 被直接丢弃，两条有效汇报被静默暂存（Telegram 深夜新增打扰消息数为 0，暂存数为 2）
    When 时钟推进到白天 "2026-11-19T01:00:00Z"（北京时间 09:00），主人发送日常消息 "早上好"
    Then Telegram 会话 "chat-503" 先自动收到包含 "共 2 条" 的暂存通知汇总，再收到 "早上好" 的正常回复（暂存数归 0）

  Scenario: 豁免列表免批直通、Telegram 取消按钮作废票据，且已批准票据跨越 SQLite 重启仍可消费放行
    Given 已在本地 SQLite 开启 "confirm-writes" 与豁免规则 "calendar/calendar.import_ics" 挂载邮件及日历 MCP
    When 主人 "tg-owner-1" 在会话 "chat-504" 先执行日历导入再发送草稿 "msg-draft-1"
    Then 日历导入因命中豁免规则免批直通（日历事件数为 1），而发信被拦截生成待批票据（外发邮件数为 0）
    When 主人点击确认卡片上的 Telegram 取消按钮作废该票据
    Then 票据被立即作废且未调用模型（待批数归 0，外发邮件数仍为 0）
    When 主人重新发起发送草稿 "msg-draft-1" 并在网关后台批准后不立即续跑，随后重启 SQLite 宿主进程
    And 重启后主人在会话 "chat-504" 发送 "继续完成刚才已批准的发信"
    Then 持久化在 SQLite 中的已批准票据跨越重启自动放行并消费，邮件 "msg-draft-1" 成功发出（外发邮件数为 1）

  Scenario: 忙时让路与频控冷却端到端暂存后台推送，发送 /flush 立即汇总补发
    Given 已启动挂载可控慢工具 "slow_busy_task" 与 30 秒冷却窗口的渠道网关（授权主人 "tg-owner-1"）
    When 主人先在会话 "chat-505" 触发慢工具执行，在主会话忙碌期间后台尝试推送 "忙时让路通知"
    Then 该推送因忙时让路被暂存（Telegram 当前未打扰，暂存数为 1）
    When 释放慢工具完成前台回合后，主人主动发送 "/flush"
    Then Telegram 会话 "chat-505" 立即收到包含 "忙时让路通知" 的补发通知（暂存数归 0）
    When 冷却窗口内 5 秒后后台再次主动推送 "冷却期降频通知"
    Then 该推送因频控冷却被暂存（暂存数为 1），再次发送 "/flush" 后立即收到 "冷却期降频通知"（暂存数归 0）
