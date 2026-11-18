Feature: 双栖运行时装配与 OpenCode Go 模型支持（Runtime Entrypoints & OpenCode Go Provider）
  作为准备将 Jehee 投入日常真机使用的个人开发者
  我希望开箱支持 OpenCode Go 模型目录，并能用同一套配置在本地 Node 或 Cloudflare Workers 免费 DO 上运行
  以便随时在本地调试或零月租部署到云端 24 小时待命

  Scenario: OpenCode Go 模型目录加载、双别名 API Key 解析与拼写错误快速拦截
    Given 运行时环境变量配置了 OpenCode Go 密钥别名 "OPENCODE_GO_API_KEY" 为 "ocg_test_key_123"
    When 解析模型配置 "opencode-go/glm-5.3-flash"
    Then 成功定位到提供商 "opencode-go" 下的模型 "glm-5.3-flash"
    And 通过模型集合查询 "opencode-go" 的认证状态为已配置可用
    When 尝试解析不存在的错误模型配置 "opencode-go/not-a-real-model"
    Then 立即抛出包含候选模型提示的清晰配置错误

  Scenario: 从统一环境变量字典一键装配完整运行时（含 OpenCode Go、Telegram 白名单与可选 InstaBox 工坊）
    Given 提供如下环境变量配置字典:
      | key                      | value                        |
      | JEHEE_MODEL              | opencode-go/kimi-k3.1-pro    |
      | OPENCODE_API_KEY         | oc_live_demo                 |
      | TELEGRAM_BOT_TOKEN       | 123456:ABC-DEF               |
      | TELEGRAM_ALLOWED_USERS   | 10001, 10002                 |
      | INSTABOX_API_KEY         | ibk_demo_free                |
      | INSTABOX_MACHINE_ID      | box-free-main                |
    When 解析 Jehee 运行时配置
    Then 解析出的默认模型为 provider "opencode-go" 与 modelId "kimi-k3.1-pro"
    And Telegram 白名单包含用户 "10001" 与 "10002"
    And InstaBox 云工坊配置已自动启用并绑定机器 "box-free-main"

  Scenario: Cloudflare Workers 部署入口打包无 Node 专属 SQLite 模块泄漏且体积低于免费层上限
    When 对 Cloudflare 部署入口 "worker.ts" 执行边缘环境打包检查
    Then 打包成功且产物不包含任何 "node:sqlite" 或 "src/runtime/node" 外部残留
    And 打包后的脚本总字节数小于 2500000 字节
