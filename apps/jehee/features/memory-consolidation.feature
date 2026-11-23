Feature: 后台空闲与手动异步记忆整理（Slice 5C-2）
  作为 Jehee 的长期使用者
  我希望日常对话中未显式调用 memory_save 的隐性事实与偏好能经整理自动沉淀
  同时重复记忆能自动合并、新旧冲突能自动消解并保留可逆墓碑，且支持空闲定时唤醒与 /memory consolidate 指令

  Scenario: 日常对话中的隐性事实经 /memory consolidate 自动沉淀并推进水位线，二次触发返回 noop 零模型调用
    Given 已启动挂载原子记忆插件的 Jehee 宿主与 Telegram 渠道网关（授权主人 "owner-consol"）
    When 主人与宿主完成一轮日常对话 "以后周报统一用 bullet list 发我"（未显式调用 memory_save）
    And 主人 "owner-consol" 在 Telegram 发送 "/memory consolidate" 触发整理提取隐性偏好
    Then 渠道回报整理新增 1 条记忆，且 "/memory" 巡检展示 "bullet list" 偏好与累计整理次数 1
    When 主人 "owner-consol" 紧接着再次发送 "/memory consolidate"
    Then 渠道回复无需整理，且后台未发起额外模型调用

  Scenario: 重复记忆自动合并与新旧冲突自动消解，旧条目墓碑化且可通过 /memory restore 无损恢复
    Given 已启动挂载原子记忆插件的 Jehee 宿主与 Telegram 渠道网关（授权主人 "owner-consol"）
    And 宿主内已存入两条重复记忆 "王明负责支付服务"、"王明是支付服务负责人" 以及一条旧地址 "住在上海浦东"
    When 主人与宿主对话告知 "我这周搬到深圳南山了"，随后主人发送 "/memory consolidate"
    Then 渠道回报 merge=1 与 supersede=1，检索 "南山" 命中新地址，检索 "浦东" 为空，且重复项已合并为 1 条
    When 主人 "owner-consol" 在 Telegram 发送 "/memory restore mem_0003" 撤销旧地址替换
    Then 检索 "浦东" 重新命中旧地址 "住在上海浦东"

  Scenario: 空闲防抖后台整理在 idleDelayMs 到期后自动执行，且未授权陌生人发 /memory consolidate 被拒绝
    Given 已启动开启空闲自动整理（idleDelayMs=60, minNewTurns=2）的原子记忆宿主与 Telegram 网关（授权主人 "owner-consol"）
    When 陌生人 "stranger-88" 在 Telegram 发送 "/memory consolidate"
    Then 陌生人请求返回 unauthorized 且未触发任何整理
    When 主人与宿主完成 2 轮日常对话并等待空闲整理任务完成
    Then 后台空闲整理自动沉淀隐性事实 "偏好深色主题"，且累计整理次数为 1
