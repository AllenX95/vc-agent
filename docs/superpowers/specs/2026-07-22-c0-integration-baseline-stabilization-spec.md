# C0 Integration Baseline Stabilization Executable Specification

Date: 2026-07-22  
Status: Proposed for implementation  
Blocked by: Learning Build G2 complete

## Outcome

将当前未提交 Integration 工作区变成一个可审查、可回退、行为与设计一致的稳定基线。C0 不宣称任何 Integration 已对用户可用；它只关闭运行时所有权、lazy activation、持久化和测试追踪风险。

## Non-goals

- 不增加完整 Integration Settings UI。
- 不用 fixture 宣称真实 Office、OCR 或 MCP 已完成。
- 不实现 Sub-Agent。
- 不提交用户提供的 Skill、模型权重、凭据或测试生成物。

## Requirements

- **C0-REQ-001 Worktree partition:** 当前改动 MUST 按 runtime/contracts、Integration services、desktop wiring、tests/docs 分组审查；无关改动和生成物不得进入基线提交。
- **C0-REQ-002 Clean verification:** 基线 MUST 从干净依赖状态通过 `pnpm typecheck`、`pnpm test` 和 `pnpm test:e2e`。
- **C0-REQ-003 Project worker ownership:** 第一次 admitted Project work 才创建按 Project Identity 定位的 Worker；同 Project Thread 使用独立 session；Unscoped work 使用独立 Worker。
- **C0-REQ-004 Runtime shutdown:** App close MUST 先拒绝 admission、保存 checkpoint、取消 session/job、终止剩余进程树，再关闭 stores；不得 replay。
- **C0-REQ-005 Crash containment:** Agent、Utility、Isolated Job 或其子进程崩溃不得破坏 Host、先前 Parse、Output 或 best earlier result。
- **C0-REQ-006 Same-target safety:** 并发写必须 staged validation + atomic finalization；不得让模型隐式合并同目标写。
- **C0-REQ-007 Lazy Skills Directory:** App launch、普通 Settings 和 Environment Doctor MUST NOT 创建 Skills Directory；只有显式打开/配置 Skills surface 或 import 才可创建。
- **C0-REQ-008 Dormant integrations:** 启动、浏览、Doctor 和重启不得连接 MCP、运行 OCR、执行 Skill、发现 staged Extension 或启动 Pi。
- **C0-REQ-009 Migration:** 新增 scheduler、skills、MCP、extension、runtime state 必须通过 deterministic staged migration；newer schema 进入 Read-only Recovery。
- **C0-REQ-010 Traceability:** R1/I1-I6 每个已实现 requirement 必须有测试映射；未满足项保持 unchecked，不得按源码存在推断完成。
- **C0-REQ-011 Repository hygiene:** Git tracked/untracked scan MUST 拒绝第三方 Skill package bytes、OCR weights、secret、absolute user paths 和 `test-results` artifacts。
- **C0-REQ-012 Checkpoint:** C0 关闭时 MUST 形成一个可单独构建、测试和回退的提交基线。

## Required Code Seams

- `AgentWorkerSupervisor` 或统一 supervisor adapter 是 Electron Main 唯一 Agent Worker spawn seam。
- `LocalJobSupervisor`/Utility Worker 是本地 executable job 的唯一生产 spawn seam。
- `BoundedExecutionScheduler` 是所有 model-backed work 的唯一 admission seam。
- `SkillPackageManager.open()` 必须移动到显式 Skills command flow，不能留在 `app.whenReady()`。
- Environment Doctor 只能调用无副作用的 `inspectAvailability`/inventory projection。

## Test Traceability

| Test id | Requirements | Observable assertion |
| --- | --- | --- |
| C0-T-001 Clean full verification | 001, 002, 011 | Clean tree build/test passes; forbidden artifact scan passes. |
| C0-T-002 Lazy launch | 007, 008 | Launch/settings/Doctor create no skills directory and zero activation counters. |
| C0-T-003 Project runtime matrix | 003 | Two Project Threads share owner, separate sessions; Unscoped has separate process/scope. |
| C0-T-004 Stop/crash/shutdown | 004, 005 | Targeted stop and process-tree fixtures terminate; restart has no replay. |
| C0-T-005 Concurrent target | 006 | Collision is visible and prior valid target remains intact on failure. |
| C0-T-006 State compatibility | 009 | Old schema migrates atomically; injected failure rolls back; newer schema is read-only. |
| C0-T-007 Spec audit | 010, 012 | Checklist evidence exists and baseline commit can be checked out and verified. |

## Definition Of Done

- C0-REQ-001 through 012 pass。
- R1 executable SPEC 的 runtime ownership 和 cancellation decision gate 关闭。
- Skills Directory eager creation 已修复。
- `pnpm verify` 全绿，且 Integration 仍诚实显示 unavailable/attention 状态。
- 当前未提交工作被收敛成可回退基线，没有真实第三方资产进入仓库。

## Decision Gate

若进程树不能可靠终止、Project/Unscoped scope 仍可能串线、Skills Directory 仍在启动创建，或迁移无法安全回滚，则不得进入 C1。

