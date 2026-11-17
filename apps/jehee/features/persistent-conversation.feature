Feature: 单入口常驻主对话（Single-Entry Persistent Conversation）
  作为一个希望拥有长期共事伙伴的用户
  我希望在同一个对话入口里发送消息、防重投、重启不断线并能在忙碌时随时插话
  以便像给靠谱同事发消息一样自然协作

  Scenario: 单入口正常问答且重复 requestId 保持幂等不重复调用模型
    Given Jehee 以内存模式启动并预设模型回复:
      | reply                        |
      | 收到，周四下午三点提醒你开会 |
    When 用户携带请求号 "msg-001" 发送消息 "周四下午三点有个评审会"
    And 网络重投再次携带请求号 "msg-001" 发送消息 "周四下午三点有个评审会"
    Then 两次提交返回相同的回复 "收到，周四下午三点提醒你开会"
    And 底层模型实际只被调用了 1 次

  Scenario: 基于 SQLite 的常驻宿主重启后完整保留对话上下文并继续共事
    Given Jehee 以本地 SQLite 模式启动并预设模型回复:
      | reply                      |
      | 记下了，后续统一用 pnpm。  |
      | 你刚才交代过统一使用 pnpm。 |
    When 用户携带请求号 "sqlite-001" 发送消息 "以后我的项目统一用 pnpm"
    Then 主入口收到回复 "记下了，后续统一用 pnpm。"
    When Jehee 宿主进程正常关闭并以同一个 SQLite 文件重新启动
    And 用户携带请求号 "sqlite-002" 发送消息 "我刚才交代过用什么包管理器？"
    Then 主入口收到回复 "你刚才交代过统一使用 pnpm。"
    And 当前主对话可见历史依次包含 4 条消息

  Scenario: 主对话执行慢工具忙碌期间，用户发送 steer 插话在当前回合实时生效
    Given Jehee 以内存模式启动且挂载了一个可控慢工具 "slow_check"
    And 模型第一轮会调用慢工具 "slow_check"，第二轮在看到插话后回复 "已按你的插话改查 staging 环境"
    When 用户异步发起首条消息 "帮我检查默认环境的部署状态"
    And 在慢工具尚未结束时用户发送 steer 插话 "先别看默认环境，改查 staging 环境"
    And 慢工具执行完毕放行
    Then 首条回合与 steer 插话均完成，最终模型请求上下文中包含了插话 "先别看默认环境，改查 staging 环境"
    And 首条消息最终收到的回合回复为 "已按你的插话改查 staging 环境"
