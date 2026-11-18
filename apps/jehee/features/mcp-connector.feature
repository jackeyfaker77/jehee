Feature: 双栖 MCP 连接器骨架、父子 Span 决策树与 PALE 场景适配（MCP Connector Skeleton & Observability）
  作为连接个人生活服务并参与 PALE 基准评测的常驻个人助理
  我希望通过统一 MCP 连接器按需发现工具、读取资源附件、自愈乐观锁版本冲突并拦截未确认的高危写操作
  以便主对话始终保持稀疏与高缓存命中率，同时完整留存父子 Span 决策树供 Eval 与失败复盘使用

  Scenario: 多实例挂载下默认启用 deferred 按需检索，且完整采集父子 Span 决策树
    Given 已启动模拟 PALE 多应用 MCP 环境（含 mail、calendar 与 4 个干扰域服务，共 55 个工具）
    And Jehee 以 "deferred" 模式挂载全部 MCP 服务并开启 Trace 录制器
    When 用户发送任务 "帮我查一下收件箱里有没有航班相关的邮件"
    Then 首轮发往模型的系统提示词包含 "mcp_servers" 摘要目录，且首轮可见工具仅包含 "tool_search"
    And 模型先调用 "tool_search" 按需加载邮件工具，再调用 "mcp__mail__mail_search" 查得航班邮件并完成回复
    And Trace 录制器记录了完整的父子决策树（包含 "pi.durable.submit"、"pi.ai.request"、"tool_search" 与 "jehee.mcp.call"）

  Scenario: PALE 写操作遇到 stale_version 乐观锁冲突时原样透传 current_version 并由模型在下一轮自愈提交
    Given 已启动模拟 PALE 多应用 MCP 环境且日历初始版本号 revision 为 2
    And Jehee 挂载日历 MCP 服务并开启 Trace 录制器
    When 用户发送任务 "把最新改签航班导入我的日历"，且模型首次误传旧版本号 revision 0
    Then 模型收到了包含 "stale_version" 与最新 revision 2 的结构化错误详情
    And 模型在下一轮读取最新版本号重新提交 "mcp__calendar__calendar_import_ics" 并成功落库（日历事件数为 1）

  Scenario: 跨应用搬运大体积 PDF 收据与 ICS 日历邀请时通过 $jehee_blob 句柄实现零爆窗且 SHA-256 严格一致
    Given 已启动模拟 PALE 多应用 MCP 环境（邮件内含 16 KiB PDF 收据与 ICS 日历附件）
    And Jehee 挂载邮件与日历 MCP 服务（Blob 卸载阈值 4096 字节）并开启 Trace 录制器
    When 用户发送任务 "把航班邮件里的日历邀请导入日历，并把原始 PDF 收据挂载到该日历日程上"
    Then 模型读取邮件附件时收到解码后的 ICS 文本与 "$jehee_blob:" 句柄（全程上下文未出现原始长 Base64 字符串）
    And 日历服务最终保存了 1 条日程与 1 份附件，且接收端校验的 PDF SHA-256 与原始邮件附件 100% 一致

  Scenario: beforeWriteToolCall 确定性门控放行只读查询，但拦截未经确认的外发写操作并归入安全边界指标
    Given 已启动模拟 PALE 多应用 MCP 环境并配置写操作需用户确认门控
    And Jehee 挂载邮件 MCP 服务并开启 Trace 录制器
    When 用户发送任务 "先搜一下草稿箱，然后直接把那封接机草稿发出去"（尚未授予发送确认）
    Then 只读工具 "mcp__mail__mail_search" 正常放行返回草稿列表
    And 写工具 "mcp__mail__mail_send" 被确定性门控拦截并返回 "confirmation_required"，邮件实际外发数为 0
    And 当前 Trace 指标记录的 "boundaryViolations" 次数为 1

  Scenario: 本地运行入口自动读取标准 mcp.json 挂载真实 stdio 子进程并在 /status 中回显
    Given 已在临时目录写入包含真实本地 stdio 服务 "stdio_fixture" 与禁用项 "disabled_http" 的 mcp.json
    When 通过 assembleNodeRuntime 启动本地宿主与渠道网关并发送 "/status"
    Then 渠道状态回执包含 "mcp: stdio_fixture" 且未挂载已禁用的 "disabled_http"
