# Personal Build Completion Implementation Plan

Date: 2026-07-22  
Status: Proposed for implementation  
Product authority: `docs/superpowers/specs/2026-07-06-vc-desktop-agent-design.md` and accepted ADRs  
Starting point: committed Learning Build at `1dae091` plus the current uncommitted Integration worktree

## Objective

从当前已通过 `pnpm verify` 的工作区出发，按可回退、可验收的顺序完成 Integration Build、显式 Sub-Agent Delegation 和最终 Hardening，使完整 Personal Build 达到原始设计中的第一版验收标准。

本计划只负责跨阶段排序、依赖和发布门。每个阶段的具体行为、状态、失败处理和测试由可执行 SPEC 定义，索引见：

`docs/superpowers/specs/2026-07-22-personal-build-completion-spec-index.md`

## Current Baseline

- Foundation、Dogfood 和 Learning Build 已提交并通过桌面 E2E。
- R0 Execution Scheduler 已实现并通过队列、Stop、重启恢复测试。
- R1、I1-I6 已有 Host Service、fixture 和 Electron Main 接线；Gate/生命周期兼容性基线已收敛并提交于 `4f3d842`，本轮 Office Runner slice 在此基线上继续推进。
- Integration 已有统一 Renderer/IPC 管理入口和 Host 状态投影，但真实依赖验收仍未闭合。
- Office 和 MCP 尚未通过要求的真实依赖路径；OCR 已完成本地 CPU/CUDA 部署与真实 Electron 进程链路验收。
- Integration Gate 当前因真实 Office Skill 路径缺失而为 `blocked`。
- Sub-Agent Runtime 的 deterministic core、IPC/UI、持久化、fixture 和 Electron 路径已实现；真实 Provider-backed child session 仍保持不可用。
- 当前 `pnpm verify`：44 个测试文件、206 个测试；31 个 Electron E2E 中 30 个通过、1 个按未配置真实 OCR 环境跳过。

## Progress Snapshot (2026-07-23)

- **C0:** closed for the current slice. Skills Directory is lazy at app launch; Project/Unscoped runtime, scheduler, migration and existing shutdown fixtures remain green.
- **C1 / Skills:** closed for the first vertical slice. Typed `skills.*` IPC, Settings inventory, explicit import, compatibility inspection, activation, disable, restart restoration and no-eager-creation E2E are implemented.
- **C1:** typed Integration state/job/diagnostic IPC and a Settings Integration surface are wired for Office create/edit/review/replace, Skill Creator, Page Recovery/OCR Parse, MCP configuration/activation/permission actions and Extension Admission/revision/rollback. The full desktop fixture matrix is covered by `completes the desktop C1 fixture paths without eager external activation`; fixture actions remain explicit and lazy.
- **C2 / deterministic gate:** `pnpm integration-gate` runs G3-T-001 through G3-T-010 (fixture, unavailable/failure injection, restart dormancy, recovery and evidence hygiene), writes sanitized JSON/Markdown evidence, and reports `blocked` when the declared Personal Build dependencies are absent.
- **C2 / remaining:** PaddleOCR + OvisOCR2 now have pinned external runtimes, redacted CPU/CUDA evidence, and a real Electron-to-Utility-Worker E2E. `pi-mcp-adapter@1.5.1` is now installed and locked; its real stdio path is exercised by the Host manager with lazy Test Connection, schema caching, bounded read/write authorization, and restart dormancy. User-supplied Office package evidence and external real-MCP evidence are still required before a `pass` decision. Environment flags alone do not close G3-T-011.
- **C2 / Office runner slice (2026-07-26):** The active user-supplied Skill revision is now carried into an explicit Office job manifest and executed only through the Utility Worker when `VC_AGENT_OFFICE_RUNNER` is configured. Source edits are read from a staged snapshot, outputs are structurally checked as OOXML/PDF artifacts, runner logs are sanitized and bounded, cancellation waits for Office shutdown before Utility Worker shutdown, and the production adapter has no fixture fallback. `pnpm office:compat` can now run the pinned external package through the create/edit/replace contract and emit sanitized evidence outside the repository; a user-supplied real runner is still required to remove the Office block.
- **C2 / Gate hardening:** G3-T-011 validates typed sanitized evidence outside the repository, including OCR CPU/CUDA repeated results, and records sanitized relative evidence paths. The report remains blocked on Office and externally supplied MCP evidence, while the local pinned-adapter compatibility slice is closed.
- **C2 / MCP evidence runner (2026-07-26):** `pnpm mcp:compat` now provides an external-only stdio smoke path for a user-supplied MCP server. It requires explicit read/write tool names and JSON arguments, uses the pinned adapter through the Host manager, proves lazy read, confirmed write, and restart dormancy, and emits only sanitized evidence outside the repository. It does not use the repository fixture server and does not close G3-T-011 until the user runs it against the real service.
- **D1:** implementation slice is present: explicit intent, flat Run/Task/Attempt records, bounded Host runtime, IPC/UI, fixture adapter, persistence/restart interruption, deletion placeholders, collision policy and delegation E2E are covered. The D1 final gate remains blocked until C2 is `pass` and a real provider-backed child-session/Output evidence path is supplied.
- **H1:** Personal Build Gate runner and sanitized JSON/Markdown artifacts are present. Single-instance locking, awaited shutdown, and bounded Utility/Agent child-tree termination are now implemented and tested; the report remains `blocked` for real Office/MCP, provider-backed D1, packaged lifecycle evidence, and remaining external-edit/backup evidence.
- **H1 / Office lifecycle (2026-07-26):** Office cancellation now maps the UI plan identity to the bounded local job identity, terminates the Utility Worker tree, and persists an `interrupted` projection. Host cancellation coverage and a packaged desktop E2E cover the running-runner path; the packaged evidence bundle is collected separately by `pnpm h1:packaged`.
- **H1 / packaged evidence (2026-07-26):** `pnpm h1:packaged` runs the bounded Electron suites for process cancellation, material external-edit refresh, cognition backup/restore, and single-instance locking, then emits only sanitized metadata outside the repository. `VC_AGENT_H1_PACKAGED_EVIDENCE` lets the Personal Build Gate consume that artifact; without it those four criteria remain blocked.

## Immediate Next Work

1. Complete the user-supplied Office package path and real create/edit/replace evidence.
2. Supply sanitized external MCP evidence and wire the validated Office/MCP smoke paths into G3-T-011, then close C2.
3. Add the real Provider-backed child-session and Output-adoption path; the deterministic D1 core is already complete.
4. Collect packaged process-tree, external-edit, backup/restore, and usability evidence before the final H1 pass.

## Program Invariants

- Renderer 只负责命令和视图，不直接访问文件系统、Pi、Provider、凭据、MCP、OCR、Office 或 Extension runtime。
- Electron Main 继续拥有授权、Operational State、调度、持久化和最终 durable commit。
- Agent Worker 只拥有 Pi runtime 和 Physical Model Context；本地可执行依赖必须进入 Utility Worker 或 Isolated Job。
- 浏览、设置、诊断、导入检查和重启不得隐式启动 Pi、Provider、MCP 连接或本地推理。
- 不得通过 fixture 将真实依赖要求标记为通过；缺少真实依赖时状态只能是 `blocked` 或明确的 `unavailable`。
- Provider、依赖或进程失败不得自动 fallback、重试、恢复执行、扩大权限或制造成功。
- Sub-Agent 不得直接写个人认知状态，也不得绕过 Output Intent、Provider Authorization、Access Mode 或 Cognitive Review Gate。
- 每个阶段必须从干净支持状态通过 `pnpm verify`，并产生可审查的测试证据后才能关闭。

## Completion Stages

### C0. Stabilize The Integration Baseline

**Goal:** 把当前未提交的 R0/R1/I1-I6 服务层实现收敛成可审查基线，修复已知设计偏离，并证明运行时所有权和本地作业边界成立。

**Primary work:**

- 审查并分离当前未提交改动，禁止把生成物或真实第三方包提交进仓库。
- 完成 R1 的 Electron adapter 接线、进程树取消、关闭顺序、崩溃和同目标写冲突。
- 将 Skills Directory 改为真正的 lazy initialization；仅打开 Skills 设置或执行显式配置时创建。
- 固化 Integration 状态迁移、Read-only Recovery 和 Environment Doctor 的无激活行为。
- 为现有 fixture 模块建立 requirement-to-test traceability。

**Exit gate:** C0 SPEC 全部通过；R1 可安全承载后续 Integration；形成一个可回退的提交基线。

### C1. Complete The Desktop Integration Surface

**Blocked by:** C0.

**Goal:** 将现有 I1-I6 Host Service 暴露为可见、可操作、可恢复的桌面产品路径，而不是仅能通过测试或终端调用。

**Primary work:**

- 增加统一的 Integration Settings 信息架构和 typed IPC command/event families。
- 完成 Skills 导入、审查、激活、禁用、版本查看和诊断。
- 完成 Office 任务、Skill Creator、OCR 状态/显式 Parse、MCP 配置/激活和 Extension Admission/Revision UI。
- 在普通 Turn 中只投影任务相关 Skills、MCP schemas 和 approved Extension inventory。
- 所有工作流提供 pending/running/failed/unknown/completed/restart 状态和恢复动作。

**Exit gate:** 用户可从桌面完成每个 Integration fixture 路径；不存在要求终端、数据库操作或手工复制内部目录的产品流程。

### C2. Close Real Integrations And G3

**Blocked by:** C1.

**Goal:** 接入并验证真实用户提供的 Office Skills、真实本地 OCR runtime 和真正 pinned 的 MCP adapter，然后关闭 G3 Practical Integration Gate。

**Primary work:**

- 使用仓库外、用户提供的完整 Claude Office Skill 包完成一次真实 create/edit/diff/replace 流程。
- 使用已配置的 PaddleOCR 和 OvisOCR2 runtime 完成本地混合 PDF recovery；不提交模型权重。
- 安装、锁定并校验真实 `pi-mcp-adapter`，用 fixture server 完成 lazy read/write/failure/restart。
- 完成 Extension deterministic inspection、isolated audit、approval、enablement、revision 和 rollback 的桌面 E2E。
- 执行 G3 的 deterministic、unavailable、migration/recovery 和 Personal Build dependency 四种模式。

**Exit gate:** G3 报告为 `pass`，不是 `blocked`；Integration Build 清单关闭。

### D1. Implement Explicit Sub-Agent Delegation

**Blocked by:** C2.

**Goal:** 实现原设计中的显式、扁平、可预算、可审计 Sub-Agent Run，同时保持普通 Turn 的单 Agent 默认路径。

**Primary work:**

- 增加显式 intent gate、Sub-Agent Run/Task/Attempt 状态和 task tree。
- 实现 role assignment、Profile resolution、isolated context、minimal Capability Set 和 bounded handoff。
- 将 child work 接入全局 scheduler、Stop、token budget、retry 和 Provider Failure 行为。
- 保存可展开记录和删除级联，同时永久排除 hidden reasoning、凭据和直接 Memory/Dream eligibility。
- 支持 provenance-tracked child Output 和并发目标冲突处理。

**Exit gate:** D1 SPEC 和 delegation E2E 全部通过；未授权的普通 Turn 无 child model call。

**Current implementation note (2026-07-22):** The deterministic runtime and desktop delegation surface are implemented and green in unit/Electron fixture tests. The exit gate is not closed because the runtime intentionally returns `SUB_AGENT_PROVIDER_UNAVAILABLE` unless a real provider adapter is injected; the fixture adapter is never counted as the real D1 gate.

### H1. Harden And Accept The Personal Build

**Blocked by:** D1.

**Goal:** 关闭跨阶段安全、恢复、迁移、并发、删除和可观测性缺口，并按原设计完整验收 Personal Build。

**Primary work:**

- 建立原设计 acceptance criteria 到自动测试或人工证据的一对一矩阵。
- 完成 Unknown Tool Outcome、进程树关闭、并发写碰撞、断电/崩溃恢复和 schema upgrade/recovery 压力测试。
- 完成 trajectory/Sub-Agent/Dream candidate 删除级联和 `source unavailable` 验证。
- 执行秘密、路径、权限、scope、eager activation、自动 fallback 和远程内容 telemetry 静态/动态检查。
- 从空状态和受支持旧状态运行完整日常 VC、Learning、Integration、Delegation 场景。

**Exit gate:** Personal Build Gate 为 `pass`；无开放的 severity-1/2 数据完整性、授权、隔离、重放或秘密泄露缺陷。

**Current implementation note (2026-07-22):** `pnpm personal-build-gate` now executes H1-S-001 through H1-S-010 across deterministic, real-dependency, unavailable, migration/recovery and crash/cancellation modes and writes `personal-build-gate-report.json` plus Markdown summary. It currently reports `blocked` rather than `pass` for the missing real/evidence paths.

## Dependency Graph

```text
Learning G2 + current Integration worktree
                 |
                 v
        C0 Integration Baseline
                 |
                 v
        C1 Desktop Integration UX
                 |
                 v
        C2 Real Integrations + G3
                 |
                 v
        D1 Explicit Sub-Agent Runs
                 |
                 v
        H1 Personal Build Hardening
```

## Commit And Review Strategy

- 每个阶段至少形成一个独立、可回退的提交；禁止将 C0-C2 与 D1 混成一个提交。
- 数据库 schema、IPC contract 和 runtime ownership 变更优先独立提交并先通过兼容性测试。
- 真实用户 Skill、OCR 权重、Protected Credentials、项目材料和 MCP secret 不进入 Git、测试证据或 gate report。
- 每阶段关闭时更新父计划 checklist、对应 SPEC test traceability 和本索引状态。
- 发现会改变授权、自动行为、数据所有权、进程所有权或产品范围的问题时，先新增或修订 ADR，再继续实施。

## Program Definition Of Done

- C0、C1、C2、D1、H1 的 Definition of Done 全部满足。
- 原 Integration R1/I1-I6/G3 checklist 全部关闭并有证据链接。
- `pnpm verify` 和最终 Personal Build Gate 从干净支持状态通过。
- 可选依赖缺失时功能明确降级，但真实 Personal Build dependency run 已在本机成功完成。
- 应用启动和状态浏览保持零 Pi、零 Provider、零 MCP connection、零 OCR inference。
- 普通 Turn 不会创建隐藏 Sub-Agent；显式 Delegation 的成本、状态、工具和结果均可见。
- 应用退出后没有 Agent、MCP、OCR、Office 或本地作业继续运行。
