Feature: 单窗口无感换窗、换窗前记忆落盘与底层原话回查（Slice 5D / ADR-0013）
  作为 Jehee 的长期使用者
  我希望主对话窗口超过注意力甜点上限时能够先自动落盘记忆再无感压缩换窗
  同时支持通过 /handoff 主动开启干净新窗口，且换窗后仍能按 sourceEntryId 或关键词回查底层逐字原话

  Scenario: 活跃窗口越过甜点阈值后自动先整理记忆再无感压缩，后续窗口 Token 压降且用户无感
    Given 已启动开启甜点自动压缩（sweetSpotTokens=160, keepRecentTokens=50）与原子记忆的 Jehee 宿主
    When 用户连续发送 2 轮较长业务对话（含隐性项目代号 "星辰计划" 与预算 "80 万"）并等待自动压缩结算
    Then 宿主累计自动压缩次数至少为 1，且原子记忆库已自动沉淀 "星辰计划" 事实
    And 可移植快照 active 视图包含压缩摘要，full 视图仍完整保留首轮逐字原话

  Scenario: 主人通过 /handoff 主动整窗交接并更新 /status，未授权陌生人被白名单拒绝
    Given 已启动挂载原子记忆的 Jehee 宿主与 Telegram 渠道网关（授权主人 "owner-handoff"）
    When 宿主先完成一轮长背景对话，随后陌生人 "stranger-5d" 发送 "/handoff"
    Then 陌生人换窗请求返回 unauthorized 且换窗计数仍为 0
    When 主人 "owner-handoff" 发送 "/handoff 聚焦发布收口" 并查询 "/status"
    Then 渠道回报换窗完成且活跃 Token 显著下降，/status 展示最新上下文水位与 handoffs=1

  Scenario: 换窗后通过 history_search 按 sourceEntryId 与关键词仍可回查被压缩前的逐字原话，且工坊子会话不暴露该工具
    Given 已启动挂载原子记忆与内置工坊的 Jehee 宿主
    When 首轮对话记录关键原话 "暗号：北极星-7788" 后执行整窗换窗
    And 新窗口内主会话调用 history_search 检索 "北极星-7788" 并按首轮 entryId 回查
    Then 两种方式均精准返回换窗前的逐字原话 "暗号：北极星-7788"
    When 主会话派发内置工坊任务 "handoff-ws-check"
    Then 工坊子 Agent 可用工具集中不包含 history_search
