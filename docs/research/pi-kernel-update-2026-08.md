# Pi 0.80.8 → 0.84.1 官方发布说明影响评估（2026-08-12）

## 结论先行

截至 2026-08-12，`earendil-works/pi` 最新正式版是 **v0.84.1（2026-08-07）**；本项目在 `apps/desktop`、`apps/agent-worker`、`packages/pi-adapter` 中固定使用 **0.80.8**。这次不是一次可以单包尝试的普通升级：仓库直接或间接耦合 `pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-tui`，而 `pi-web-access` 又以 `pi-ai`、`pi-coding-agent`、`pi-tui` 为 peer，四个官方包必须锁成同一版本并重新解算 peer 依赖。

对现有源码的判断是：**未发现必须立刻改写的 Pi API 调用**。项目的主路径仍是 `createAgentSession()`、`SessionManager.create/open/inMemory()` 和 `AgentSession`，没有使用 0.81–0.84 被替换的 agent-core `SessionStorage` / repository API、`AgentHarness`、自定义 `Provider.refreshModels()`，也没有读取 JSON/RPC 中被删除的累计 `message_update.message` / `.partial`。但升级本身必须同步调整全部 Pi 版本声明和 lockfile，并通过一组真实回归，尤其是旧 session 恢复、扩展加载、流式 delta、compaction、abort/dispose 和自定义 URL provider。

推荐目标为 **0.84.1，不要停在 0.84.0**。0.84.1 修复了 0.84.0 中 active run 期间 `Agent.reset()` 的 transcript/runtime 清理以及 extension TUI wrapper 递归问题。[v0.84.1 release](https://github.com/earendil-works/pi/releases/tag/v0.84.1)

## 仓库触点与依赖耦合

| 触点 | 当前用法 | 升级含义 |
|---|---|---|
| `packages/pi-adapter/src/pi-session.ts` | `createAgentSession`、`SessionManager`、`AgentSession`；消费 `assistantMessageEvent.delta` | coding-agent SDK、事件流、session 回放、compaction 的首要回归面 |
| `packages/pi-adapter/src/testing.ts` | `createAgentSessionServices`、`createAgentSessionFromServices`、`SessionManager.inMemory`、faux provider | 测试辅助 API 和 agent-core/ai 类型必须共同编译 |
| `packages/pi-adapter/src/pi-resource-runtime.ts` | coding-agent resource/extension loader | 0.83–0.84 的 reload、listener disposal、Windows/path 修复会直接改变运行行为 |
| `packages/pi-adapter/src/project-read-tools.ts` | coding-agent 工具定义 | 0.83 的 TypeBox 升级和 0.84 的 tool argument union coercion 修复需要 schema 回归 |
| `apps/desktop`、`apps/agent-worker` | 直接声明四个 `@earendil-works/pi-*` 0.80.8 | **必须**与 adapter 同步升版，不能形成多份 Pi runtime/type identity |
| `pi-web-access@0.17.0` | peer 到 `pi-ai`、`pi-coding-agent`、`pi-tui` | 必须重新安装后检查 peer warning，并跑 web extension 实测；其 `*` peer 不等于已经验证 0.84 |
| `pi-mcp-adapter@1.5.1` | worker 中的 native extension/MCP 桥 | 没有锁定 Pi peer 的直接证据，但 extension 生命周期变化要求 MCP reload/dispose 实测 |

本仓库自己的 `typebox@1.1.38` 与 Pi 0.83 起导出的 TypeBox 1.3.7 是另一项类型/运行时耦合风险。即使 pnpm 允许并存，Pi 工具 schema 若跨包传递，来自两份 TypeBox 的类型或已移除 API都可能暴露问题；不要在同一提交顺手升级项目 TypeBox，先让 typecheck 和 provider-tool-schema 测试证明是否需要对齐。

## 逐版相关变更

以下只列从固定版本之后到目标版本、与 vc-agent 的嵌入式 SDK、模型调用、会话、工具、扩展或 Windows 打包有关的事项。完整条目以各版本官方 release 和四个 package changelog 为准。

### 0.80.9 / 0.80.10（2026-07-16）

- **Added：** Kimi K3、多 provider 支持和 deferred tool loading；若 vc-agent 启用这些模型，工具激活与 thinking replay 会变化。
- **Fixed：** Kimi adaptive thinking、空 thinking signature、模型输出限制/价格/catalog 修复。
- **Removed：** 一批旧 xAI 模型从内建 catalog 移除；保存了这些模型 ID 的用户配置可能需要 fallback。

来源：[v0.80.9](https://github.com/earendil-works/pi/releases/tag/v0.80.9)、[v0.80.10](https://github.com/earendil-works/pi/releases/tag/v0.80.10)。

### 0.81.0 / 0.81.1（2026-07-21）

- **Breaking（agent-core）：** `SessionStorage` 契约改为 cursor reads、self-contained compaction checkpoint，并要求 name/statistics；`uuidv7` 移至 `pi-ai`；0.81.0 一度要求显式 `streamFunction`，0.81.1 又恢复旧 `Agent.streamFn` fallback。项目未实现这些低层接口，判定无直接源码迁移。
- **Added：** tool、compaction、branch summary usage 写入 session；coding-agent 导出 message/tool lifecycle event 类型；加入完整 provider extension 注册。
- **Fixed：** compaction 中排队消息保留 steering/follow-up 语义；大 session 打开不再重复解析；OpenAI Responses 提前结束自动重试；0.81.1 增加 bounded assistant retry 并修复后台 catalog refresh 阻塞启动。

这些修复和 vc-agent 的长会话、队列、流式运行相关，应视为升级收益，同时也意味着 persisted usage/session 内容需要兼容验证。来源：[v0.81.0](https://github.com/earendil-works/pi/releases/tag/v0.81.0)、[v0.81.1](https://github.com/earendil-works/pi/releases/tag/v0.81.1)、[`agent` changelog](https://github.com/earendil-works/pi/blob/v0.84.1/packages/agent/CHANGELOG.md#0810---2026-07-21)。

### 0.82.0 / 0.82.1（2026-07-24 至 07-25）

- **Breaking（pi-ai）：** `getBuiltinModelDataUrl()` 被 `getBuiltinModelDataGeneratedAt()` 取代。项目没有调用该低层 catalog API。
- **Breaking（agent-core）：** `AgentHarness` 的 `ExecutionEnv`/tool 输入改为应用自定义 `toolContext` 和 context-aware tools。项目没有使用 `AgentHarness`。
- **Added：** constrained tool sampling、strict/grammar tool capability；Kimi Code 与 OpenRouter OAuth；0.82.1 加入 Claude Opus 5 和 catalog ETag。
- **Fixed：** DNS 错误自动重试、provider retry wait 可 abort、Codex WebSocket continuation 恢复；compaction/branch summary 使用新的 routing session ID 并禁用 prompt cache；TUI 日志遵循配置目录。

对项目最重要的是工具 schema 和 abort 行为回归，不是迁移 harness。来源：[v0.82.0](https://github.com/earendil-works/pi/releases/tag/v0.82.0)、[v0.82.1](https://github.com/earendil-works/pi/releases/tag/v0.82.1)、[`pi-ai` changelog](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/CHANGELOG.md#0820---2026-07-24)。

### 0.83.0（2026-07-29）

- **Breaking（pi-ai）：** 导出的 TypeBox 升到 1.3.7，移除 `Type.Base/Awaited/Promise/AsyncIterator/Iterator/Options` 与 `Value.Mutate`。仓库没有检出这些调用，但自身仍锁 `typebox@1.1.38`，需要编译和 schema runtime 验证。
- **Added：** `pending` stop reason、`AssistantMessage.rawStopReason`、per-request `fetch` injection、OAuth 最小剩余有效期；OAuth 会在不足五分钟时提前刷新。
- **Fixed：** active response 中 session replacement/tree navigation 会 abort 并持久化 outgoing turn；extensions reload 后 skills/prompts/themes 保留 package source；重复消息、并发 bash abort、OpenAI-compatible tool-call argument 丢失等问题。

`pending` 是 partial streaming 状态，最终消息状态映射不能将它误判为成功结束；当前适配器主要依赖事件 delta，仍需截断/中断 smoke test。来源：[v0.83.0](https://github.com/earendil-works/pi/releases/tag/v0.83.0)、[`pi-ai` changelog](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/CHANGELOG.md#0830---2026-07-29)。

### 0.84.0（2026-08-06）：所谓“内核更新”

- **Breaking（agent-core）：** 旧 harness session model 被 v4 lane-based `Session` / `SessionStorage` / `SessionRepo` 替换；旧 JSONL/in-memory repository API 删除；custom filesystem 新增原子 `renameFile()`；experimental subpath 删除，v2 `AgentHarness` 从 package root 导出。项目没有使用这些接口，因此目前无直接迁移，但不能把 coding-agent 的 `SessionManager` 与新 agent-core `Session` 混为一谈。[agent changelog](https://github.com/earendil-works/pi/blob/v0.84.0/packages/agent/CHANGELOG.md#0840---2026-08-06)
- **Breaking（coding-agent JSON/RPC）：** `message_update` 只发 `assistantMessageEvent` delta，不再发累计 `message` 或 `.partial`，避免二次方输出。项目当前读取 `.delta`，预计兼容；必须验证文本、thinking、tool-call delta 聚合以及 `message_end` 最终态。[v0.84.0 release](https://github.com/earendil-works/pi/releases/tag/v0.84.0#breaking-changes)
- **Breaking（pi-ai provider extension）：** `ModelsStreamTransforms` 改名，refresh/login/API-key/OAuth 实现必须接受 concrete abort signal，手写 `Provider.refreshModels()` 改为 `stored` + generation-checked `publish()`。项目的 custom URL provider 没有证据表明实现这些低层接口，但 extension 与第三方依赖必须编译验证。[pi-ai changelog](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/CHANGELOG.md#0840---2026-08-06)
- **Added：** durable deferred provider request、telemetry context、sampling params；harness 新底座支持 durable operation、global facts、lane tree view 和 open-operation recovery。
- **Fixed：** OAuth/auth/catalog refresh 的取消和竞态；Anthropic 初始 block 丢文本/思考；Google/Gemini signed replay；Codex WebSocket 跨账号隔离；截断响应恢复；tool union coercion；compaction 竞态；session symlink discovery；Windows/MSYS/WSL path；extension listener disposal。

新 `AgentHarness` 虽移入默认导出，官方 changelog 仍说明部分 operation path 会抛 `HarnessNotImplemented`，不建议本项目在此次依赖升级中迁入。[`AgentHarness` source/release context](https://github.com/earendil-works/pi/releases/tag/v0.84.0)

### 0.84.1（2026-08-07）

- **Fixed（关键）：** 修复 active run 期间 `Agent.reset()` 清理 transcript/runtime state；修复 extension TUI wrapper 递归。因此 0.84.0 不适合作为落点。
- **Added：** Qwen Token Plan Individual；TUI 增强与本项目 Electron UI 无直接关系。

来源：[v0.84.1 release](https://github.com/earendil-works/pi/releases/tag/v0.84.1)、[`pi-ai` changelog](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/CHANGELOG.md#0841---2026-08-07)、[`tui` changelog](https://github.com/earendil-works/pi/blob/v0.84.1/packages/tui/CHANGELOG.md#0841---2026-08-07)。

## 影响矩阵

“必须改”表示完成升级不可省略的仓库变更，不代表已经确认业务源码破坏。

| 事项 | 级别 | 依据与动作 |
|---|---|---|
| 四个 `@earendil-works/pi-*` 版本统一为 0.84.1 | **必须改** | desktop、agent-worker、pi-adapter 均有直接声明；混版可能造成重复 runtime、结构类型漂移和 peer 解算不一致 |
| 重建并审查 pnpm lockfile | **必须改** | 确认只存在目标 Pi 版本，检查 `pi-web-access` peer、MCP adapter、TypeBox、MCP SDK/Zod 的解算结果 |
| `createAgentSession` / `SessionManager` 源码迁移 | **无直接影响** | 0.84 的 v4 `SessionRepo` 属于 agent-core harness，不是 coding-agent `SessionManager`；当前无低层 API 调用 |
| JSON/RPC `message_update` 累计字段删除 | **建议验证** | 当前使用 `assistantMessageEvent.delta`，静态上兼容；验证 delta 聚合和 message_end |
| 0.83 TypeBox 1.3.7 | **建议验证** | 未使用被删除 API，但仓库有独立 1.1.38；跑 typecheck、tool schema、nullable union 实测 |
| 旧 0.80.8 session 文件 | **建议验证** | usage/accounting、compaction checkpoint、abort persistence 多次改变；用真实旧 fixture 恢复并继续对话 |
| extension/MCP lifecycle | **建议验证** | 0.83 reload metadata、0.84 listener disposal 与 provider abort contract 改变；跑 reload/dispose 和 MCP 工具调用 |
| custom URL/provider 路径 | **建议验证** | 0.84 provider auth/refresh signal contract 有 breaking；确认项目只注册静态 model，且 auth/header/abort 正常 |
| Windows 路径、打包和 native TUI | **建议验证** | 官方修复 MSYS/WSL/path 与 native addon 打包；worker 将 Pi 打进 bundle，需 packaged smoke |
| `AgentHarness` v2 迁移 | **无直接影响 / 暂缓** | 项目未用，且 0.84.0 尚存在 `HarnessNotImplemented` 路径 |
| 新 provider、llama.cpp、alternate-screen TUI | **无直接影响** | 当前产品没有暴露这些官方 CLI/TUI 能力；不应扩大升级范围 |

## 建议升级步骤与回归清单

1. 建独立升级分支，一次性修改 `apps/desktop/package.json`、`apps/agent-worker/package.json`、`packages/pi-adapter/package.json` 中全部 Pi 版本为 0.84.1，再由 pnpm 重建 lockfile。
2. 检查 lockfile：四个官方 Pi 包只出现 0.84.1；`pi-web-access@0.17.0` peer 全部绑定 0.84.1；没有意外引入第二份 agent-core/coding-agent；记录 TypeBox 1.1.38 与 Pi 内部版本是否并存。
3. 先跑 `pnpm typecheck`、`pnpm test`、`pnpm integration-gate`；若 TypeBox 报错，再单独决定是否迁移项目 TypeBox，避免把两项升级揉成一次。
4. 运行以下真实回归：

   - 新建 session，文本、thinking、tool call、tool result 按增量顺序送达，最终 message 不重复也不缺失；
   - 打开 0.80.8 生成的 session，恢复上下文并继续一轮；覆盖空/短 session、长 session、含 tool call、含 compaction 的 session；
   - manual compaction、阈值 auto-compaction，以及 compaction 期间 steering/follow-up；确认无并发 summary、消息丢失或重复；
   - provider 返回 length/incomplete、网络早断、DNS/临时错误时，能够 retry 或 compact-and-retry，abort 后不再发事件；
   - active run 中 abort、dispose、切换/恢复 session；确认 outgoing turn 有明确终态且 worker 无悬挂 listener；
   - 加载、reload、禁用 extension；启动/调用/停止 MCP server；重复 reload 后监听器和工具数量不增长；
   - custom URL provider 的 model/header/API key、请求取消、nullable/union tool 参数，以及 OpenAI-compatible tool-call delta；
   - Windows 含空格/非 ASCII 路径、开发态与打包态 worker 启动、session 路径和 `pi-agent` resource 路径；
   - `pi-web-access` 的至少一次成功网页工具调用和错误/取消路径；
   - 凭据接近过期时刷新、并发请求共用凭据、账号切换后 Codex WebSocket 不复用旧账号 session。

## 决策

建议升级到 **0.84.1**，理由主要是 session/compaction、stream recovery、provider cancellation、extension disposal、Windows path 和长期凭据可靠性修复，而不是为了采用新 harness。验收门槛是上述真实回归通过；在此之前保持 0.80.8。此次升级不应同时迁移 `AgentHarness`，也不应在没有失败证据时主动改造 `SessionManager` seam。

一句话：**源码静态触点大体兼容，但依赖必须整体对齐，运行风险集中在旧 session、流式事件、TypeBox 工具 schema、扩展/MCP 生命周期和 provider 取消/刷新。**
