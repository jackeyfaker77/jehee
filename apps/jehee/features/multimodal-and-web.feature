Feature: Telegram 多模态入站通道与防 SSRF 可移植 web_fetch 工具（Multimodal Channels & Web Fetch）
  作为 7x24 常驻个人伙伴型 Bot
  我希望用户发送的无配文图片与文本文档能自动下载并转换为模型可读的 ImageContent 与文档摘录，同时主会话能安全抓取公网网页并拦截内网 SSRF
  以便多模态协作与网页查证开箱即用，且工坊子会话仍保持最小权限隔离

  Scenario: 无配文 Telegram 图片与文本文档经 ChannelGateway 防抖合并并交付 ImageContent 与文档摘录
    Given 已启动带 Telegram 多模态传输器与防抖窗口的 Jehee 宿主及渠道网关（授权主人 "tg-owner-6b"）
    When 主人 "tg-owner-6b" 连续发送一条无配文 Telegram 图片与一条 Markdown 文档 "notes.md"
    Then 发往模型的用户消息包含 "image/png" 的 ImageContent 块与文档正文 "Sprint-6B-Checkpoint"，且渠道收到模型回复

  Scenario: 单个附件下载失败时网关降级为提示说明而不丢弃整条消息
    Given 已启动带 Telegram 多模态传输器与防抖窗口的 Jehee 宿主及渠道网关（授权主人 "tg-owner-6b-err"）
    When 主人 "tg-owner-6b-err" 发送包含有效图片与下载失败文档 "broken.txt" 的消息
    Then 模型仍收到有效图片的 ImageContent 与 "Attachment download failed" 降级提示，整条消息未被丢弃

  Scenario: 主会话通过 web_fetch 读取公网 HTML、拦截 SSRF 169.254.169.254，且工坊子会话隔离不暴露 web_fetch
    Given 已启动开启 web_fetch 与内置工坊的 Jehee 宿主（公网页面标题 "Jehee Public Guide"）
    When 主会话依次调用 web_fetch 抓取公网 HTML 与元数据地址 "http://169.254.169.254/latest/meta-data/"
    Then 公网抓取成功提取标题 "Jehee Public Guide" 与正文并剥离脚本，元数据地址被 "ssrf_blocked" 拦截
    When 主会话派发校验 web_fetch 隔离的内置工坊任务 "web-iso-task"
    Then 工坊子 Agent 可用工具集中不包含 web_fetch
