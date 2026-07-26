# G3 之后的 Personal Build 开发方案与可执行 SPEC

> 日期：2026-07-26
> 状态：Implementation complete；P3/D1、P4-A/B/C、P5 与 Release Gate 已完成
> 范围：P3 Provider-backed Sub-Agent、P4 Personal Build Hardening、P5 发布一致性
> 前置基线：P0/P1/P2 与 G3 已完成；Microsoft Office 是唯一 DOCX 桌面兼容性目标，不使用 LibreOffice

## 1. 文档定位

本文档是 G3 通过后的剩余开发执行基线，合并“后续开发方案”和“可执行 SPEC”。它不重写原始产品设计，而是把以下现有规范收敛成可直接开发和验收的 P3-P5 工作：

- `2026-07-22-d1-explicit-sub-agent-runtime-spec.md`
- `2026-07-22-h1-personal-build-hardening-gate-spec.md`
- `2026-07-26-personal-build-finalization-development-plan.md`
- ADR-0060 及 G3 兼容性证据约束

如旧文档中的阶段状态与本文冲突，以本文记录的最新状态为准；D1/H1 的原始需求编号与安全约束仍然有效。

## 0.1 当前实现检查点（2026-07-26）

本轮已按 P3-A 至 P3-E 完成第一条真实 Provider 垂直切片，并完成 P4-A 的打包生命周期证据：

- 生产进程在有 Profile/Credential 时使用 Agent Worker Provider Adapter；仅 `VC_AGENT_TEST_SUB_AGENT_FIXTURE=1` 使用 fixture。
- MIMO Profile 保留用户保存的原始 Provider/Model；运行时对 `https://api.xiaomimimo.com/anthropic` 使用 Pi 的 Anthropic-compatible Xiaomi runtime 适配，不改写持久化 Profile。
- Context Compiler、Project/Unscoped scope 校验、角色 assignment → Default Sub-Agent → Primary Active Profile 解析、解析来源和 Context hash 已接入 Attempt record。
- `read_context`、`read_materials`、`web_research`、`write_output` 通过 Host Capability Broker；写入型 Provider 子任务没有 Registry artifact 时会失败，不再静默直写。
- Handoff 默认 `pending_parent_review`，父会话通过 adopt/reject 显式审阅；Output artifact 登记归属父 Thread，同时保留 Sub-Agent producer/request provenance。
- 共享 token budget 在 Provider 请求前执行保守预检；stop、shutdown、Provider failure 和手工 retry 保持显式状态机，不自动 fallback。
- 最新 `pnpm verify`：56 个测试文件、241 个单元/集成测试、32 个 E2E 场景通过（typecheck、build、fixture E2E 全部通过）。
- `pnpm sub-agent:compat` 已用用户保存的 MIMO Profile 生成仓库外脱敏证据：并行只读、write-capable Output、父采用、stop/cancel、budget exhaustion、显式 Provider Failure 七类场景均通过，secret scan 通过。
- `pnpm h1:packaged` 已生成有效打包生命周期证据：进程树退出、Word 外部编辑、备份恢复、单实例四类工作流均通过。
- Microsoft Word COM 兼容性证据和本地 OCR 证据均有效；DOCX 验收只走 Microsoft Office，不使用 LibreOffice。
- vc-agent 自有 `server-filesystem` MCP 服务已完成真实 lazy-read、confirmed-write、restart 三条工作流；使用固定 `pi-mcp-adapter@1.5.1`，证据写在仓库外。
- `pnpm integration-gate:release` 的 G3-T-001 至 G3-T-011 全部通过；`pnpm personal-build-gate:release` 的 H1-S-001 至 H1-S-010 全部通过。

剩余工作仅为 P5 文档/运维同步和定期复跑；当前没有阻塞 Release Gate 的开发缺口。

## 2. 当前基线与剩余阻塞

### 2.1 已完成基线

- `pnpm verify` 最新通过：56 个测试文件、241 个单元/集成测试、32 个 E2E 场景。
- `pnpm integration-gate:release` 最新通过：G3-T-001 至 G3-T-011 全部 pass。
- Microsoft Word、OCR 和 MCP 真实兼容性证据均已纳入 Integration Gate；MCP 使用 vc-agent 自有 `server-filesystem` 运行时。
- Extension Audit 已使用隔离 Worker；测试可使用确定性 fixture，生产路径不应使用 fixture。
- Skills 的目标位置是 vc-agent 自身管理的目录，不依赖 `~/claude/skills` 或其他 Agent 的技能目录。

### 2.2 当前 Personal Build Gate 状态

`pnpm personal-build-gate` 可以在没有 LLM Provider 的情况下运行。目前所有确定性场景均可执行通过；用户保存的 MIMO Profile 已用于生成并校验 D1 Provider 脱敏证据，H1 打包证据、Office、OCR 和 MCP 证据也已就绪。最新 `pnpm personal-build-gate:release` 决策为 `pass`：

1. H1-S-001 至 H1-S-010 全部通过。
2. Office、OCR、MCP、Sub-Agent Provider 和 Packaged Lifecycle 证据均通过脱敏校验。

目前受上述证据阻塞的验收项包括：

- 无 blocked 验收项；H1-REQ-001 至 H1-REQ-020 均为 `pass`。

### 2.3 代码层面的主要缺口

| 缺口 | 当前实现 | 目标状态 |
|---|---|---|
| 生产 Sub-Agent Adapter | 已接入 Agent Worker/Pi Provider；fixture 仅由显式测试环境变量启用 | 继续补齐真实 stop/budget/failure 证据 |
| Model Profile 解析 | 已按角色 assignment → Default Sub-Agent → Primary Active Profile；无 first-profile fallback | 继续保持 assignment 与 Profile 设置可审计 |
| Context Boundary | 已由 Compiler 解析、限长、哈希并注入隔离 Prompt | 增加更多 source-reference 与采用结果审计覆盖 |
| Project scope UI | 已从父 Thread 继承并在 IPC/Runtime 双重校验 | 在完整真实项目闭环中复核 |
| Handoff adoption | 已提供 adopt/reject IPC、UI 和可审计状态 | 在完整真实项目闭环中复核已提交 Project Output |
| Write-capable child | 已通过 Host Capability Broker 登记 artifact，缺 Registry 结果即失败 | 在完整真实项目闭环中补 staged → validated → committed 冲突 evidence |
| Token/stop/failure | 已接入真实 usage、取消、预算预检和脱敏错误分类 | `sub-agent:compat` 七类真实场景已覆盖 |
| D1 真实证据 | `sub-agent:compat` 七类场景均已生成并由 Gate 校验脱敏证据 | 已完成 |
| H1 打包证据 | `h1:packaged` 四类生命周期工作流均已通过 | 已完成；仍受整体 C2/G3 release gate 约束 |
| Office/OCR 真实证据 | Microsoft Word COM 与本地 OCR 证据均有效 | 已完成；不使用 LibreOffice |
| MCP 真实证据 | vc-agent 自有 `server-filesystem` 已通过 `lazy-read`、`confirmed-write`、`restart`，证据在仓库外 | 已完成 |
| 文档状态 | 本文、Completion Spec Index、Finalization Plan、C2/G3/H1 specs、Gate runbook 和 MCP runbook 已同步 | 已完成 |

## 3. 是否需要提供 LLM Provider

### 3.1 结论

当前已经完成的 G3 检查不需要提供 LLM Provider；继续运行 `verify`、Office、OCR、MCP、Integration Gate 和确定性 Personal Build 诊断，也不需要 LLM Provider。

用户已保存并提供 MIMO LLM Profile，本轮已用它完成 P3/D1 的真实 Provider 证据，因此不需要再次配置新的 Provider。P4 的完整真实垂直工作流复用了该 Profile，最终 `personal-build-gate:release` 已通过。

Gate 脚本本身只验证证据，不应在 Gate 内临时调用 Provider。真实 Provider 调用由独立兼容性/产品 E2E 生成脱敏证据，Gate 再消费该证据。

### 3.2 检查与 Provider 需求矩阵

| 检查或工作 | 是否需要外部 LLM Provider | 说明 |
|---|---:|---|
| Typecheck、Unit、Integration、fixture E2E | 否 | 保持确定性和离线可复现 |
| `pnpm verify` | 否 | 不应读取真实 Provider 凭据 |
| Microsoft Word 兼容性 | 否 | 直接使用 Microsoft Office；不引入 LibreOffice |
| OCR 兼容性 | 否 | 本地 OCR/模型不是外部 LLM Provider API |
| MCP 兼容性 | 否 | 验证协议和真实 MCP 环境 |
| `pnpm integration-gate:release` | 否 | 消费已有 G3 证据 |
| P3 主体编码和确定性测试 | 否 | Adapter 可通过 fake/fixture 开发 |
| D1 真实 Provider 子会话验收 | **是（已完成）** | 已使用保存的 MIMO Profile 证明生产 Adapter、凭据解析、usage、停止和错误行为 |
| D1 write-capable Output adoption E2E | **是（已完成）** | 已由真实子会话产生并采用 Output |
| `pnpm h1:packaged` 生命周期场景 | 否 | 进程、外部编辑、备份恢复、单实例不依赖 LLM |
| 完整真实垂直工作流 | **是（已完成）** | 已复用保存的 MIMO Profile；普通会话、Reflection/Dream、Extension Audit、Sub-Agent 真实闭环证据已被 Gate 接受 |
| `pnpm personal-build-gate` 诊断 | 否 | 可运行，但缺证据时仍为 `blocked` |
| `pnpm personal-build-gate:release` 最终通过 | **间接需要** | Gate 不调用模型，但必须读取真实 Provider 证据 |

### 3.3 最低 Provider 条件

验收只要求一个可用 Provider/Model Profile，不要求同时支持多个 Provider，也不要求父 Agent 与 Sub-Agent 使用不同模型。该 Profile 应满足：

- 支持普通对话和产品当前使用的工具调用协议。
- 支持流式响应或可被 Worker 统一适配的增量输出。
- 能返回或可靠估算 token usage。
- 支持取消；取消后不能留下失控的子进程或继续写入。
- 上下文窗口满足产品配置的最小上下文预算。
- 凭据通过 vc-agent 的 Protected Credential 流程保存，不写入仓库、日志或证据文件。

建议在 P3 主体实现前完成一个 Profile 的本地配置，以便尽早暴露 Provider Adapter 差异；但 Provider 不是开始编码的前置条件。

## 4. 总体开发顺序

```text
P3-A Provider Adapter
  → P3-B Profile 与 Context Boundary
  → P3-C Capability、Output 与 Adoption
  → P3-D Runtime/Record 收口
  → P3-E UI、真实 E2E 与 D1 证据
  → P4-A Packaged Lifecycle
  → P4-B 完整真实垂直工作流
  → P4-C Personal Build Release Gate
  → P5 文档、运维与发布一致性
```

原则上先让一个只读 Sub-Agent 的真实会话跑通，再增加可写 Output；不要在同一垂直切片中同时引入 Provider、Context、写入和 UI 的全部变化。

## 5. P3：Provider-backed Explicit Sub-Agent

### 5.1 P3-A Provider Adapter

#### P3-REQ-001 生产 Adapter

实现生产级 `SubAgentProviderAdapter`，通过现有 Agent Worker/Pi Provider 基础设施执行子会话。每个 Attempt 必须获得独立的 child session/turn 标识，不能复用父会话的可变历史。

Adapter 输入至少包含：

- run/task/attempt ID
- 已解析 Model Profile ID
- 冻结的 Context Bundle
- 能力白名单
- token/time/tool-call 预算
- 输出策略
- AbortSignal 或等价取消句柄

Adapter 输出至少包含：

- 终态和脱敏失败分类
- 文本 Handoff 摘要或 Output 引用
- usage
- 开始/结束时间
- Provider/Model 的非敏感标识

#### P3-REQ-002 生产选择规则

- `VC_AGENT_TEST_SUB_AGENT_FIXTURE=1` 只允许测试进程使用。
- 正常生产进程在 Profile 和 Credential 可用时必须选择 Provider Adapter。
- 配置缺失时允许返回明确的 `ProviderUnavailable`，但禁止自动改用 fixture、其他 Provider 或第一个可用 Profile。

#### P3-REQ-003 取消和退出

`stop attempt`、父 Run 停止、应用退出和超时必须向 Worker 传播取消。最终状态必须区分 `stopped`、`interrupted`、`budget_exhausted`、`provider_failure`，并确保子进程树终止。

### 5.2 P3-B Profile Resolution 与 Context Boundary

#### P3-REQ-004 Profile 解析

固定解析顺序：

1. 与任务角色匹配的 Sub-Agent Model Assignment。
2. Default Sub-Agent Model Assignment。
3. Primary Active Profile。
4. 无可用 Profile 时失败。

禁止退回 profiles 列表第一项。解析结果及来源必须写入 Attempt record。

#### P3-REQ-005 Context Compiler

新增一个深模块，例如 `SubAgentContextCompiler`，负责：

- 校验 source references 属于允许的 Project/Unscoped 边界。
- 按 `maxChars`、数量和总预算读取最小材料。
- 生成不可变 Context Bundle、revision/hash 和来源清单。
- 排除父会话完整 transcript、兄弟 Agent 原始 history、Cognitive Memory、未授权路径和凭据。
- 只有在用户显式选择时，才允许加入先前已采用的 bounded handoff。

#### P3-REQ-006 Scope 继承

- Project Thread 创建的 Run 默认使用该 Project ID。
- Unscoped Thread 创建的 Run 不得包含 Project ID 或 Project 路径。
- UI、IPC 和 Runtime 三层都必须校验 scope，不能只相信前端字段。
- 修复当前 UI 把有 Project 的请求也写为 `unscoped` 的问题。

### 5.3 P3-C Capability、Output 与 Adoption

#### P3-REQ-007 最小能力集

根据任务意图显式派生能力，不继承父 Agent 的全部工具。第一版只允许：

- `read_context`
- `read_materials`
- `web_research`
- `write_output`

Reflection、Dream、长期记忆写入、技能安装、Extension 管理、凭据管理和任意本地文件访问必须排除。

#### P3-REQ-008 可写 Output

具有 `write_output` 能力的子任务必须通过 Host Output Registry：

```text
staged → validated → committed
```

记录至少包含 run/task/attempt、Profile、Context Bundle hash、目标 Project、source references 和 collision policy。不得绕过 Registry 直接写最终文件。

#### P3-REQ-009 Handoff Review

增加父会话可调用的显式命令：

- `sub_agent.handoff.adopt`
- `sub_agent.handoff.reject`

以及对应的 record/event。Handoff 初始状态为 `pending_parent_review`；只有 adopt 后，父会话才能把其摘要作为后续上下文使用。Reject 不删除审计记录。

对于已提交的 Project Output，adopt 表示父会话认可并引用结果，不等价于再次写文件。

#### P3-REQ-010 冲突处理

同一目标 Output 的并发提交必须使用现有 collision/versioning 规则。系统不得“最后写入者覆盖”，冲突应形成可见终态和可重试的新 Attempt。

### 5.4 P3-D Runtime、预算和记录

#### P3-REQ-011 预算

- 在发起 Provider 请求前执行预算预检。
- 每次响应后写入真实或明确标注的估算 usage。
- 达到 token、时间或 tool-call 上限时停止，状态为 `budget_exhausted`。
- 不允许因预算不足自动换便宜模型或继续无计费执行。

#### P3-REQ-012 Retry 语义

Provider Failure 不自动重试、不静默 fallback。用户或父 Runtime 显式 retry 时创建新 Attempt，旧 Attempt 保持不可变。

#### P3-REQ-013 记录卫生

持久化 run/task/attempt、状态、非敏感 Profile 元数据、usage、Context hash、Handoff/Output 引用和错误分类。禁止持久化：

- API key、token、credential handle 原值
- 完整 Provider 请求或响应正文
- 未经采用的 Handoff 正文进入父 transcript
- Cognitive Memory 或其他隔离域的内容

#### P3-REQ-014 删除

删除 Run 时级联删除其可删除的 Task/Attempt/Handoff 数据，但不得无提示删除已经提交到 Project Output Registry 的用户成果。删除结果必须明确列出保留的 Output 引用。

### 5.5 P3-E UI 与证据

#### P3-REQ-015 UI

Delegation UI 必须能：

- 显示 Project/Unscoped scope。
- 选择意图、Profile assignment、Context references、预算和能力。
- 显示平铺的 Run → Task → Attempt 树，不支持递归委派。
- 显示 queued/running/terminal 状态、usage、Provider Failure、stop/retry/delete。
- 对 pending Handoff 提供 adopt/reject。
- 对 Output 显示 staged/validated/committed/collision 状态。

#### P3-REQ-016 真实兼容性证据

新增独立命令，建议命名为：

```bash
pnpm sub-agent:compat
```

它使用应用中已配置的 Protected Credential，执行并验证：

1. 两个并行只读子任务。
2. 一个 critic/synthesis 子任务。
3. 一个 write-capable 子任务及父会话 adopt。
4. stop/cancel。
5. token usage 和预算终止。
6. 一个显式 Provider Failure，确认无 fallback。

证据写入仓库外路径，并仅包含 schema version、sanitized 标志、场景终态、耗时、usage、Context hash、Output/Handoff 引用和非敏感 Provider/Model 标识；不得包含凭据、Prompt、响应正文或用户材料。

### 5.6 P3 验收测试

| 测试 ID | 验收内容 | 类型 |
|---|---|---|
| P3-T-001 | 真实 Provider child session 使用独立 session/history | Real E2E |
| P3-T-002 | Profile 解析严格遵循四步顺序，无 first-profile fallback | Unit/Integration |
| P3-T-003 | Context Compiler 只复制授权、受限且可哈希的上下文 | Unit/Integration |
| P3-T-004 | Project 与 Unscoped 边界在 UI/IPC/Runtime 一致 | E2E |
| P3-T-005 | write-capable child 走 Registry，collision 可见 | Integration/Real E2E |
| P3-T-006 | Handoff 只能显式 adopt/reject | Integration/E2E |
| P3-T-007 | Provider Failure、预算和 retry 产生正确终态 | Integration/Real E2E |
| P3-T-008 | stop、应用退出终止 Worker 和子进程树 | Packaged/Real E2E |
| P3-T-009 | 删除保留已提交 Output，隔离 Cognitive Memory | Integration |
| P3-T-010 | 真实证据通过脱敏和 schema 校验 | Release Gate |

### 5.7 P3 Definition of Done

状态：已完成（代码、确定性测试和 `sub-agent:compat` 真实证据均已通过）。

- D1-REQ-001 至 D1-REQ-018 均有可追踪测试。
- 生产配置可用时不再落入 `UnavailableSubAgentAdapter`。
- Project scope UI 缺陷、Profile fallback 和 Handoff adoption 缺口已关闭。
- `pnpm verify` 通过。
- `pnpm sub-agent:compat` 生成有效的真实 Provider 脱敏证据。
- Personal Build Gate 不再因 D1 Provider-backed evidence 阻塞。

## 6. P4：Personal Build Hardening

### 6.1 P4-A Packaged Lifecycle

状态：已完成。`pnpm h1:packaged` 在打包应用上已生成仓库外脱敏证据，覆盖进程树退出、Microsoft Word 外部编辑、备份恢复和单实例四条工作流；Office 验收使用 Word COM，不使用 LibreOffice。

#### P4-REQ-001 打包应用

所有生命周期验收必须在实际打包应用中运行，而不是只在 Vitest/Electron dev 模式中模拟。

#### P4-REQ-002 进程树

验证正常退出、强制退出、Sub-Agent 运行中退出、Office/MCP/OCR Worker 运行中退出。重启后不得存在孤儿子进程、错误的 running 状态或未完成写入。

#### P4-REQ-003 外部编辑

在 Microsoft Word 中直接修改受管 DOCX 后，应用必须检测 revision 变化并执行既定的 reconcile/conflict 流程。LibreOffice 不属于支持或验收范围。

#### P4-REQ-004 备份恢复和单实例

验证备份创建、损坏/中断恢复、恢复后迁移，以及第二实例启动时的确定性行为。

建议继续使用：

```bash
pnpm h1:packaged
```

并通过 `VC_AGENT_H1_PACKAGED_EVIDENCE` 把脱敏证据写到仓库外。

### 6.2 P4-B 完整真实垂直工作流

状态：已完成。Office/OCR、真实 Sub-Agent Provider 和 vc-agent 自有 `server-filesystem` MCP 均已通过真实兼容性证据；MCP 仍不得以 fixture 证据替代。

#### P4-REQ-005 单项目闭环

至少完成一次真实项目闭环：

```text
材料导入/解析/检索
→ 普通模型会话与 web research
→ Host Output
→ Context/Memory
→ Reflection
→ Dream
→ Microsoft Word 编辑与外部变更检测
→ 显式 Sub-Agent 并行任务
→ write-capable Output
→ 父会话 adopt
```

模型相关阶段使用真实 Provider；文件、Office、MCP 和生命周期阶段不得用 Provider fixture 伪装为真实证据。

#### P4-REQ-006 Failure 与隐私

验证凭据缺失、Provider Failure、超时、budget exhausted、MCP 失败和 Office 失败。任何失败不得静默 fallback；日志和证据不得包含 secret、完整 Prompt、响应正文或私有材料。

### 6.3 P4-C Release Gate

状态：已完成。当前 Gate 已消费 D1、H1、Office、OCR、MCP 证据并返回 `pass`；缺证据时仍会返回 `blocked`。

#### P4-REQ-007 最终 Gate 输入

`personal-build-gate:release` 至少消费：

- G3 Integration Gate 真实证据
- D1 Sub-Agent Provider 真实证据
- H1 Packaged Lifecycle 真实证据
- 完整垂直工作流的脱敏摘要

#### P4-REQ-008 最终判定

所有 H1-REQ-001 至 H1-REQ-020 必须为 `pass`；缺证据必须是 `blocked`，不得被记为 `pass` 或自动 `deferred`。

### 6.4 P4 验收测试

| 测试 ID | 验收内容 | 是否需要 LLM Provider |
|---|---|---:|
| P4-T-001 | 打包进程树与退出恢复 | 否 |
| P4-T-002 | Word 外部编辑与 conflict/reconcile | 否 |
| P4-T-003 | 备份、恢复、迁移和单实例 | 否 |
| P4-T-004 | 完整真实垂直工作流 | 是 |
| P4-T-005 | Provider Failure 无 fallback 且证据脱敏 | 是 |
| P4-T-006 | Release Gate 消费全部证据并返回 pass | 间接需要 |

### 6.5 P4 Definition of Done

- `pnpm h1:packaged` 通过并生成有效证据。
- 完整真实垂直工作流通过。
- H1-REQ-003、007、011、016、018、019、020 全部关闭。
- `pnpm personal-build-gate:release` 返回 `pass`。

## 7. P5：发布一致性

### 7.1 P5-REQ-001 状态同步

状态：已完成。本文件已同步 P3/D1、H1、Office/OCR、MCP 和 Gate 的最新状态，相关权威索引和 Finalization Plan 也已同步。

更新 D1、H1、Completion Spec Index 和 Finalization Plan，清除 C2/G3 的过期 blocked 状态，并记录最终测试数量、证据 schema 和 Gate 命令。

### 7.2 P5-REQ-002 运维文档

状态：已完成本地配置。Provider Profile、Microsoft Office/Word、OCR、MCP 和 vc-agent 自有 Skills 目录的运行约束均已记录；MCP 实际命令/工具配置见 `docs/local-mcp-compatibility.md`。

补充：

- Provider Model Profile 和 Protected Credential 配置。
- Microsoft Office/Word 前置条件；明确不支持 LibreOffice。
- MCP、OCR、Skills 目录和诊断方法。
- D1/H1 证据生成、保存和脱敏要求。
- 常见 Provider Failure、Office conflict 和备份恢复操作。

Skills 文档和默认配置只能指向 vc-agent 自身管理的技能目录，不得把其他 Agent 的技能目录作为运行依赖。

### 7.3 P5-REQ-003 干净环境复现

在干净 checkout 上完成依赖安装、build、verify、兼容性 Gate 和 Personal Build Release Gate。真实凭据和证据通过外部安全路径注入，不进入 Git。

### 7.4 P5 Definition of Done

- 所有权威文档状态一致。
- 用户操作指南与实际 UI/命令一致。
- 干净环境复现通过。
- 工作树不包含凭据、真实材料、Prompt/响应正文或未脱敏证据。

## 8. 建议实施切片与工期

| 切片 | 内容 | 预计 |
|---|---|---:|
| P3-A | Provider Adapter、取消、错误映射 | 1.5-2 天 |
| P3-B | Profile 解析、Context Compiler、Scope 修复 | 1.5-2 天 |
| P3-C | Capability Broker、Output Registry、Adoption | 2-2.5 天 |
| P3-D/E | 预算/记录、UI、真实证据与 D1 收口 | 1.5-2.5 天 |
| P4-A | Packaged Lifecycle | 1.5-2 天 |
| P4-B/C | 真实垂直流程、Failure/Privacy、Release Gate | 1.5-3 天 |
| P5 | 文档、运维、干净环境复现 | 1-2 天 |

合计约 10-16 个有效开发日。Provider 只在 P3 真实证据与 P4 真实模型闭环阶段构成硬依赖；其余切片可先用确定性 Adapter 完成。

## 9. 每阶段必跑命令

### 无 Provider 也必须保持绿色

```bash
pnpm verify
pnpm office:compat
pnpm mcp:compat
pnpm integration-gate:release
pnpm personal-build-gate
```

`personal-build-gate` 在最终证据齐全前允许返回 `blocked`，但不得出现新的 suite failure。

### P3 真实验收

```bash
pnpm sub-agent:compat
```

此命令为 P3 新增交付物；应从应用安全存储读取 Profile/Credential，并向仓库外写脱敏证据。

### P4/P5 最终验收

```bash
pnpm h1:packaged
pnpm personal-build-gate:release
```

## 10. 最终完成标准

Personal Build 只有在以下条件同时满足时才算完成：

1. `pnpm verify` 绿色。
2. G3 真实 Integration Gate 保持绿色。
3. D1 的真实 Provider 子会话、Output 和 Adoption 证据有效。
4. H1 的打包生命周期证据有效。
5. 完整真实垂直工作流通过。
6. `pnpm personal-build-gate:release` 返回 `pass`。
7. Microsoft Word 是 DOCX 的唯一桌面兼容性目标。
8. Skills 只依赖 vc-agent 自身管理的目录。
9. 凭据、私有上下文和 Provider 正文没有进入日志、证据或 Git。
10. D1/H1/索引/运维文档与实际发布状态一致。
