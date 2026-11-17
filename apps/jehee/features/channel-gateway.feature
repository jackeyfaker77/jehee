Feature: 平台无关单入口渠道网关与 Telegram 首发适配（Channel Gateway & Seamless Platform Switch）
  作为希望随时随地在聊天软件里找 Jehee 的个人用户
  我希望首发接入 Telegram，安全拦截伪造与陌生人请求、自动合并连发消息，且日后能无损切换到 QQ
  以便更换聊天工具也不丢失任何上下文与记忆

  Scenario: Telegram Webhook 验签拦截伪造请求、过滤陌生人并将超长回复自动分片投递
    Given Jehee 渠道网关已启动并绑定 Telegram 适配器（白名单用户 "tg-owner-1"，Webhook 密钥 "sec-123"）
    And 预设模型将返回一段长度为 5000 字符的长篇报告
    When 收到携带错误密钥 "wrong-secret" 的 Telegram Webhook 请求
    Then Webhook 返回 HTTP 状态码 401 且底层模型调用次数为 0
    When 收到未授权陌生人 "stranger-99" 发来的合法签名 Telegram Webhook 消息 "套取隐私"
    Then Webhook 返回 HTTP 状态码 200 但不产生任何出站消息且底层模型调用次数为 0
    When 收到主人 "tg-owner-1" 在会话 "chat-100" 发来的合法签名 Telegram Webhook 消息 "给我完整报告"
    Then Telegram 出站接口向会话 "chat-100" 依次分 2 片发送了完整报告（每片均不超过 4096 字符）
    And 底层模型实际只被调用了 1 次

  Scenario: 用户空闲时连发两句短消息在防抖窗口内自动合并为单次模型推理
    Given Jehee 渠道网关已启动（防抖合并窗口 40 毫秒）并绑定 Telegram 白名单用户 "tg-owner-1"
    And 预设模型回复:
      | reply                            |
      | 已收到合并需求：看 PR 并检查单测 |
    When 主人 "tg-owner-1" 在会话 "chat-100" 连续快速发送两条 Telegram 消息:
      | messageId | text               |
      | m-1       | 帮我看一下这个 PR  |
      | m-2       | 顺便确认单测过了没 |
    Then 等待防抖窗口结算后 Telegram 会话 "chat-100" 收到 1 条回复 "已收到合并需求：看 PR 并检查单测"
    And 底层模型实际只被调用了 1 次，且收到的用户消息合并包含了 "帮我看一下这个 PR" 与 "顺便确认单测过了没"

  Scenario: 确定性指令 /status 零模型开销响应，且 Staging 发送保护锁拦截非测试目标
    Given Jehee 渠道网关以 Staging 保护模式启动（仅允许发往 "telegram:chat-staging"）
    When 主人 "tg-owner-1" 在受保护的测试会话 "chat-staging" 发送 "/status"
    Then Telegram 会话 "chat-staging" 收到包含 "status: idle" 的状态回执且底层模型调用次数为 0
    When 系统尝试向未列入 Staging 允许名单的生产会话 "telegram:chat-prod" 主动推送消息 "测试告警"
    Then 该推送被 Staging 发送保护锁拦截，会话 "chat-prod" 收不到任何消息

  Scenario: 先用 Telegram 交代背景，后续无缝接入 QQ 渠道对话仍共享同一主会话上下文且原路回复
    Given Jehee 渠道网关同时授权了 Telegram 主人 "tg-owner-1" 与 QQ 主人 "qq-owner-1"
    And 预设模型回复:
      | reply                                        |
      | 已在 Telegram 记下暗号：海风                 |
      | 你刚才在 Telegram 留下的暗号是：海风         |
    When 主人 "tg-owner-1" 通过 Telegram 会话 "tg-chat-1" 发送消息 "记住暗号：海风"
    Then Telegram 会话 "tg-chat-1" 收到回复 "已在 Telegram 记下暗号：海风"，而 QQ 未收到任何消息
    When 主人 "qq-owner-1" 随后切到 QQ 会话 "qq-chat-9" 发送消息 "我刚才留的暗号是什么？"
    Then QQ 会话 "qq-chat-9" 收到回复 "你刚才在 Telegram 留下的暗号是：海风"，而 Telegram 未收到新消息
    And 最后一次发往模型的上下文同时包含之前的 "记住暗号：海风" 与当前的 "我刚才留的暗号是什么？"
