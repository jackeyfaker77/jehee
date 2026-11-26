Feature: 静默时段持久化自动补发、MCP 自愈重连、运行时模型热切与出站富媒体交付（Slice 6C）
  作为 7x24 常驻个人助理（PA）
  我希望静默时段暂存通知跨重启不丢失并在窗口结束自动送达、故障 MCP 服务可诊断并免重启自愈、运行时模型可持久化热切、且能把 MCP 截图与文档直接发送给主人
  以便长期运维稳定、零停机自愈且多模态交付零 Token 浪费

  Scenario: 静默时段暂存通知跨越 SQLite 重启保留，/status 显示持久化数量，且静默窗口结束时自动补发汇总
    Given 已以本地 SQLite 模式启动配置静默时段 "23:00-08:00"（UTC+08:00）的 Jehee 宿主与 Telegram 网关（授权主人 "tg-owner-6c"）
    When 当前时钟处在深夜 "2026-11-18T15:30:00Z"（23:30+08:00），后台推送通知 "夜间构建已完成" 并重启 SQLite 宿主与网关
    And 主人 "tg-owner-6c" 在会话 "chat-6c-quiet" 执行运维指令 "/status"
    Then 运维状态回执显示持久化暂存数 "held_proactive: 1"，且深夜未产生打扰推送
    When 时钟推进到次日清晨 "2026-11-19T00:00:00Z"（08:00+08:00）并唤醒调度器结算
    Then Telegram 会话 "chat-6c-quiet" 自动收到包含 "夜间构建已完成" 的补发通知，且再次执行 "/flush" 提示 "当前没有暂存通知"

  Scenario: /mcp 展示脱敏后的失败服务诊断，远端恢复在线后 /mcp reconnect 完成自愈且新工具立即可用
    Given 已启动挂载离线 MCP 服务 "phone"（含敏感凭据）与在线服务 "mail" 的 Jehee 宿主及 Telegram 网关（授权主人 "tg-owner-6c"）
    When 主人 "tg-owner-6c" 在会话 "chat-6c-mcp" 执行运维指令 "/mcp"
    Then 渠道回执包含 "[OK] mail" 与 "[FAIL] phone"，且不包含原始凭据 "secret-phone-token-6c"
    When 离线 MCP 服务 "phone" 恢复上线后，主人执行 "/mcp reconnect"
    Then 渠道回执显示重连完成且同时包含 "[OK] mail" 与 "[OK] phone"，且模型随后可正常调用 "mcp__phone__phone_ping"

  Scenario: /model 支持列表查看、合法模型热切并跨越 SQLite 重启持久化、拒绝未知模型且 /model reset 恢复默认
    Given 已以本地 SQLite 模式启动多模型注册表的 Jehee 宿主与 Telegram 网关（授权主人 "tg-owner-6c"，默认模型 "faux-multi/fast-1"）
    When 主人 "tg-owner-6c" 在会话 "chat-6c-model" 依次执行 "/model list"、"/model faux-multi/does-not-exist" 与 "/model faux-multi/pro-2"
    Then 渠道回执依次包含可用模型列表、未知模型拦截提示以及切换至 "faux-multi/pro-2" 的确认，且下一轮模型请求使用 "pro-2"
    When 重启 SQLite 宿主与网关后主人先查询 "/model" 再执行 "/model reset" 并进行一轮对话
    Then 重启后 "/model" 仍显示运行时覆盖 "faux-multi/pro-2"，执行 "/model reset" 后恢复为默认模型 "fast-1"

  Scenario: send_media 通过 $jehee_blob 句柄把 MCP 截图送达 sendPhoto，并将 UTF-8 文档送达 sendDocument
    Given 已启动开启出站富媒体与模拟手机截图 MCP 服务的 Jehee 宿主及多模态 Telegram 网关（授权主人 "tg-owner-6c"）
    When 主人 "tg-owner-6c" 在会话 "chat-6c-media" 请求截屏并导出巡检报告，模型依次调用截图 MCP 工具与两次 send_media
    Then Telegram 传输器收到 1 张通过 "$jehee_blob:" 句柄无损转发的 "image/png" 图片与 1 份 "report.md" UTF-8 文档
