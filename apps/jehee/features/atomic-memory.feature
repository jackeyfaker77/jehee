Feature: 可插拔持久化原子记忆插件与 /memory 确定性指令（Slice 5C-1）
  作为 Jehee 的长期使用者
  我希望 Jehee 能够将低频长期偏好沉淀到 L1 Core 一页纸、将高频事实与日程存入可按别名和时间检索的原子记忆
  并且我可以随时通过对话或 /memory 确定性指令查看、检索、彻底遗忘或恢复记忆

  Scenario: 会话中写入 Core 与 Fact 记忆后，SQLite 重启仍保留 L1 Core 并支持按别名与时间检索溯源
    Given 已以 SQLite 模式启动挂载原子记忆插件的 Jehee 宿主
    When 主会话在首轮调用 memory_save 写入一条 Core 偏好 "代码一律使用 pnpm" 和一条带别称 "老张" 与日期 "2026-05-10" 的 Fact "张伟负责支付网关迁移"
    Then 宿主关闭并重新打开同一 SQLite 文件后，模型收到的系统提示词自动包含 L1 Core "代码一律使用 pnpm"
    And 通过 memory_search 用别称 "老张" 与时间区间 "2026-05-01" 至 "2026-05-31" 可精准命中 "张伟负责支付网关迁移" 且附带 sourceEntryId 溯源

  Scenario: 遗忘 Core 或 Fact 记忆后立即从提示词与检索中消失，且支持确定性恢复
    Given 已以内存模式启动挂载原子记忆插件的 Jehee 宿主与 Telegram 渠道网关（授权主人 "owner-mem"）
    And 宿主内已存入一条 Core 记忆 "默认使用 npm" 和一条 Fact 记忆 "旧住所地址在浦东"
    When 主人 "owner-mem" 在 Telegram 发送 "/memory forget mem_0001"
    Then 渠道立即回复已遗忘 "mem_0001" 且下一轮模型系统提示词中不再包含 "默认使用 npm"
    When 主人 "owner-mem" 在 Telegram 发送 "/memory forget mem_0002" 后再发送 "/memory search 浦东"
    Then 渠道回复未找到匹配记忆
    When 主人 "owner-mem" 在 Telegram 发送 "/memory restore mem_0002" 后再发送 "/memory search 浦东"
    Then 渠道回复重新命中 "旧住所地址在浦东"

  Scenario: 未授权陌生人发送 /memory 指令被白名单直接拒绝且零状态变更
    Given 已以内存模式启动挂载原子记忆插件的 Jehee 宿主与 Telegram 渠道网关（授权主人 "owner-mem"）
    And 宿主内已存入一条 Core 记忆 "内部偏好不可泄露"
    When 陌生人 "stranger-99" 在 Telegram 发送 "/memory" 和 "/memory forget mem_0001"
    Then 两次请求均返回 unauthorized 且渠道未发送任何回复，记忆 "mem_0001" 仍保持活跃

  Scenario: 普通原子记忆写入不改变 L1 Core 前缀，热切回静态记忆后记忆工具自动卸载
    Given 已以内存模式启动挂载原子记忆插件的 Jehee 宿主（初始 Core 种子 "基础准则：回答简洁"）
    When 主会话写入一条 Fact 记忆 "下周五提交季度总结"
    Then 写入 Fact 前后两轮请求的 L1 Core 系统提示词前缀完全一致
    When 运行时热切换回静态核心记忆 "纯静态兜底画像" 并发送一轮新消息
    Then 模型请求中不再挂载 memory_save、memory_search、memory_forget 工具，且系统提示词切换为 "纯静态兜底画像"

  Scenario: 工坊子 Agent 仅继承只读 L1 Core，不暴露写记忆工具
    Given 已以内存模式启动同时挂载原子记忆插件与内置工坊的 Jehee 宿主
    And 宿主内已存入一条 Core 记忆 "工坊代码必须使用 TypeScript 严格模式"
    When 主会话通过 workshop(spawn) 派发一个内置工坊任务 "mem-ws-check"
    Then 工坊子 Agent 收到的系统提示词包含 "工坊代码必须使用 TypeScript 严格模式"，且可用工具集中不包含 memory_save 或 memory_forget
