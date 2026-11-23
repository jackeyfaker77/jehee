Feature: 上下文与记忆的可移植快照（Slice 5C-3）
  作为拥有完整数据主权的 Jehee 使用者
  我希望把长期原子记忆、墓碑记录与对话上下文导出为与 Harness 和模型解耦的标准 JSON/Markdown 快照
  并能无损导入全新宿主、切换不同模型无缝续聊、安全增量合并去重，同时通过 /memory export 受控查看

  Scenario: 跨宿主无损迁移快照并切换不同模型无缝续聊，旧遗忘墓碑仍可恢复
    Given 已在宿主 A 上存入核心偏好 "统一使用 pnpm"、一条已遗忘旧事实 "旧测试机为 staging-01" 并完成 1 轮项目对话
    When 从宿主 A 导出可移植 JSON 快照并以 replace 模式导入挂载新模型 "model-beta" 的全新宿主 B
    Then 宿主 B 的后续对话请求自动携带 L1 Core 偏好与迁移前的历史对话，且可通过 restoreMemory 恢复 "mem_0002"

  Scenario: merge 模式增量导入具备幂等去重与本地 ID 防碰撞保护
    Given 宿主 B 已有本地记忆 mem_0001 "本地独有备注"
    When 将包含 mem_0001 "外部项目规范" 与重复内容 "本地独有备注" 的快照以 merge 模式连续导入宿主 B 两次
    Then 本地 mem_0001 保持原内容不被覆盖，"外部项目规范" 自动分配新 ID，且二次导入全部按重复跳过

  Scenario: 导出可读 Markdown 快照且 Telegram /memory export 受主人白名单保护
    Given 已启动挂载原子记忆的宿主与 Telegram 渠道网关（快照授权主人 "owner-snap"）
    When 陌生人 "stranger-snap" 发送 "/memory export"
    Then 陌生人导出请求返回 unauthorized 且不泄露任何快照内容
    When 主人 "owner-snap" 发送 "/memory export"
    Then 渠道返回包含 L1 Core 与对话记录的可读 Markdown 快照
