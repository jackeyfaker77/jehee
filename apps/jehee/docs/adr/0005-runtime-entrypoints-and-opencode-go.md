# ADR-0005：双栖真机运行入口（本地 CLI / Telegram 轮询 + Cloudflare DO）与 OpenCode Go 模型装配

- **状态（Status）**：Accepted
- **日期（Date）**：2026-11-18
- **关联需求**：[PRD v1.0](../PRD.md)、[ADR-0003](./0003-cloud-topology-and-channel-gateway.md)

---

## 1. 背景与问题（Context & Problem）

在完成 Slice 1–3（`JeheeHost` 内核、平台无关渠道网关与 Telegram 适配、InstaBox 云工坊板块）并推送基线（`ed755720f`）后，系统需要提供**可直接连上真实大模型、真实 Telegram Bot 与真实 InstaBox 跑起来的启动与部署入口**，并原生支持 **`opencode-go`（OpenCode Go）** 作为主力可选模型提供商。

本阶段需要解决三个具体工程问题：

1. **如何在同时兼容本地 Node 24 与 Cloudflare Workers Free 的前提下装配 `opencode-go` 等模型？**
   - `@earendil-works/pi-ai` 内置了 `opencodeGoProvider()`（涵盖 `glm-5.3-flash`、`glm-5.3`、`kimi-k3.1-pro`、`kimi-k2.7-code`、`deepseek-v4.1-flash`、`gpt-6-luna`、`claude-haiku-5-5`、`minimax-m3` 等 28+ 款模型）；
   - 但若直接全量导入 `providers/all.ts`，会连带打包 `@aws-sdk/client-bedrock-runtime` 等重型 SDK，威胁 Cloudflare Workers 免费版 **3 MB 压缩体积红线**；
   - 此外，Cloudflare Workers 的密钥通过 `env` 对象注入而非全局 `process.env`，需要自定义 `AuthContext` 统一桥接。
2. **如何彻底消除 `JeheeHost` 对 Node 专属模块的静态耦合？**
   - 此前 `src/core/host.ts` 顶层静态导入了 `@earendil-works/pi-durable/storage/sqlite/node`（依赖 `node:sqlite`）与 `/env/node`（依赖 `node:child_process`），这会导致 Cloudflare Workers 打包失败（`workerd` 运行时无 `node:sqlite`，而是使用 Durable Object 原生 SQLite）。
3. **如何让用户在“本地零域名调试”与“Cloudflare 24h 免费常驻”之间一键切换？**
   - 本地调试时未必有公网 HTTPS 域名，需要提供 `bin.ts telegram`（基于 `getUpdates` 长轮询）和 `bin.ts chat`（终端直连 REPL）；
   - 云端常驻时则需要标准的 `worker.ts` + `wrangler.jsonc`（基于 SQLite Durable Object + `onWake` Alarm 心跳唤醒 + `/webhook/telegram`）。

---

## 2. 备选方案对比（Alternatives Considered）

| 方案 | 优势 | 淘汰原因 |
| :--- | :--- | :--- |
| **方案 A：导入 `@earendil-works/pi-ai` 全量注册表 `registerAllProviders`** | 一行代码挂上所有冷门云厂商 | 引入 AWS Bedrock 等重型依赖，显著膨胀 Worker 产物体积，违背边缘精简原则。 |
| **方案 B：分别为本地 Node 和 Cloudflare Workers 维护两套不同的 Host 类** | 无需重构 `host.ts` 顶层导入 | 造成核心会话/工坊装配逻辑重复，出现“本地修好了 Bug、云端忘同步”的分叉风险。 |
| **方案 C（最终采用）：纯化 `JeheeHost` 为 100% 跨平台内核 + 按需精选注册 `opencode-go` 等高频 Provider + 薄入口分离（`bin.ts` 与 `worker.ts`）** | 本地与云端 100% 复用同一套 `JeheeHost`、`ChannelGateway` 与 `InstaBox` 工坊代码；Worker 打包体积小且无任何 `node:sqlite` 泄漏 | 需将本地 SQLite 打开辅助函数抽至 `src/runtime/node.ts`，并补齐 Worker 打包体积门禁测试。 |

---

## 3. 决策与核心依据（Why — 为什么这么设计）

### 3.1 精选模型目录与 `opencode-go` 一等公民支持
- 在 `src/runtime/models.ts` 中显式按需注册：`opencode-go`（默认首选）、`opencode`、`deepseek`、`openai`、`anthropic`、`google`、`openrouter`；
- 通过自定义 `AuthContext` 同时读取传入的运行时字典（Cloudflare `env` 或本地 `.env`）与 `process.env`，并为 `opencode-go` 同时兼容 **`OPENCODE_API_KEY`**（官方标准名）与 **`OPENCODE_GO_API_KEY`**（直观别名），降低配置心智负担；
- 模型配置统一采用 `"<provider>/<modelId>"` 字符串（如 `JEHEE_MODEL=opencode-go/glm-5.3-flash` 或 `opencode-go/kimi-k3.1-pro`），启动时即时校验模型是否存在于目录中，拼写错误时直接给出候选列表而非等到用户发消息才报错。

### 3.2 `JeheeHost` 彻底去 Node 专属依赖 + `onWake` 透传
- 将 `openNodeSqliteStorage` 与 `NodeExecutionEnv` 从 `src/core/host.ts` 移至 `src/runtime/node.ts`；
- 在 `JeheeHost` 上暴露底层 `wake()` 与 `resume()` 以及 `onWake` 选项，使 Cloudflare Durable Object 可以严格按照 `@earendil-works/pi-durable` 官方规范在 `submit` 前预设恢复 Alarm、在空闲时释放定时器自动冬眠（0 闲置计费）。

### 3.3 打包体积与模块纯净度自动化门禁
- 新增 `scripts/check-worker-bundle.ts`，调用根仓已有的 `esbuild` 对 `worker.ts` 执行真实打包校验：断言产物中不包含 `node:sqlite` / `node:child_process`，且打包体积远低于 Cloudflare Free 限制。

---

## 4. 具体设计方案（How — 怎么设计）

### 4.1 新增文件结构

```text
apps/jehee/
├── .env.example                 # 本地与云端环境变量配置模板（含 opencode-go、Telegram、InstaBox）
├── .gitignore                   # 忽略本地 .env、.dev.vars、.jehee-data/*.sqlite、dist/
├── bin.ts                       # 本地 CLI 入口：`models`（查模型目录）、`chat`（终端对话）、`telegram`（长轮询常驻）
├── worker.ts                    # Cloudflare Workers + JeheeSessionDO（SQLite Durable Object + Webhook + Alarm）
├── wrangler.jsonc               # Cloudflare Workers Free 部署配置（new_sqlite_classes）
├── src/
│   ├── cloudflare.d.ts          # 轻量 cloudflare:workers 运行时类型声明（不污染全局 Node 类型）
│   └── runtime/
│       ├── config.ts            # 统一环境变量解析与校验（parseJeheeEnvConfig）
│       ├── models.ts            # OpenCode Go 及主流 Provider 注册、双别名密钥桥接与模型规格校验
│       └── node.ts              # Node 专属装配（.env 加载、本地 SQLite + NodeExecutionEnv 宿主构建）
├── features/
│   ├── runtime-and-models.feature
│   └── steps/
│       └── runtime.steps.ts
└── scripts/
    └── check-worker-bundle.ts   # 验证 worker.ts 可无错打包且满足 Cloudflare Free 体积约束
```

### 4.2 真机快速启动方式

1. **本地一键体验（无需公网域名）**：
   复制 `apps/jehee/.env.example` 为 `apps/jehee/.env`，填入 `OPENCODE_API_KEY`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_ALLOWED_USERS`（可选填 `INSTABOX_API_KEY` + `INSTABOX_MACHINE_ID`）：
   - 查看所有可用 `opencode-go` 模型：`npm --prefix apps/jehee run jehee -- models opencode-go`
   - 终端直接对话：`npm --prefix apps/jehee run start:cli`
   - 启动 Telegram 长轮询 Bot：`npm --prefix apps/jehee run start:telegram`
2. **Cloudflare Workers 免费 24h 部署**：
   在 `apps/jehee` 下通过 `wrangler secret put` 写入 `OPENCODE_API_KEY`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_WEBHOOK_SECRET`、`INSTABOX_API_KEY`，配置 `wrangler.jsonc` 中的非敏感变量后执行 `npx wrangler deploy`，再将 Telegram Webhook 指向 `https://<worker>.workers.dev/webhook/telegram`。

---

## 5. 验收门禁清单（Verification）

- [x] `npm run check`（Biome + `tsc --noEmit`）零警告、零错误通过。
- [x] `npm run check:worker-bundle`：`worker.ts` 零 `node:sqlite` / `child_process` 依赖打包成功，且体积远低于 Cloudflare Free 3 MB 上限。
- [x] `npm test`：新增 `features/runtime-and-models.feature`（验证 `opencode-go` 模型解析、双密钥环境变量桥接、完整运行时装配及 Worker 边缘打包校验），全量单测与 Cucumber BDD 场景绿色通过。
