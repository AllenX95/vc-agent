# D1 Explicit Sub-Agent Runtime Executable Specification

Date: 2026-07-22  
Status: Proposed for implementation  
Blocked by: C2 and G3 pass

## Outcome

仅在用户对当前任务表达显式 Delegation intent 时，primary Agent 才可创建扁平、隔离、可预算、可停止、可审计的 Sub-Agent Tasks。普通 Turn 保持单 primary Agent、最小 prompt 和零隐藏辅助模型调用。

## Non-goals

- 不支持递归 Delegation、长期 Agent team、后台 daemon 或 app 退出后执行。
- 不自动从普通对话推断 standing delegation permission。
- 不提供 monetary budget enforcement。
- 不保存 hidden Chain of Thought 或完整原始 Provider transport payload。

## Domain Records

```text
SubAgentRun
  id, parentThreadId, parentTurnId, explicitIntentEvidence
  taskLimit, sharedTokenBudget?, usage, status, createdAt, completedAt?

SubAgentTask
  id, runId, role, objective, contextBoundary
  capabilitySet, resolvedProfile, status, handoff?, usage

SubAgentAttempt
  id, taskId, instructionRevision, profile
  messages, toolEvents, usage, failure?, result?, timestamps
```

详细字段可演进，但 stable id、Attempt 不覆盖、scope、usage、failure、bounded handoff 和 deletion state 必须持久化。

## Requirements

- **D1-REQ-001 Explicit intent:** 只有当前 User task 明确要求多个 Agent、parallel work、independent critic 或 delegation 时才能创建 Run；Full Access 不构成 intent。
- **D1-REQ-002 Authorization lifetime:** intent 只覆盖当前 task；新 Turn 不继承 standing permission。
- **D1-REQ-003 Flat topology:** 只有 primary Agent 可创建 child task；child 不能创建 Sub-Agent 或隐藏 internal model stage。
- **D1-REQ-004 Role resolution:** Profile 解析顺序为 matching role assignment、Default Sub-Agent、primary Active Profile；缺失/循环/失败不得自动 Provider fallback。
- **D1-REQ-005 Isolated context:** child 只接收 objective 所需 instructions、bounded references 和 prior results；不得继承完整 parent trajectory 或 sibling raw context。
- **D1-REQ-006 Minimal capability:** 每个 task 有可见最小 Capability Set；read-only role 默认无 write/external side effects。
- **D1-REQ-007 Cognitive exclusion:** child 永远不能启动/恢复 Dream、Reflection、Scope Elevation，或直接写 Project/Long-term Memory、Judgment、History、Dream state。
- **D1-REQ-008 Authorized outputs:** 当前任务要求 artifact 时，write-capable child 可直接写确定的 Output Location，并记录 task、role、Profile、sources、tool 和 warnings provenance。
- **D1-REQ-009 Scheduler:** primary、children 和其他 model stages 共享全局 concurrency/queue；一个 Thread 仍只有一个 parent Active Turn。
- **D1-REQ-010 Limits:** Profile 定义默认 child task maximum，可由用户仅为当前 Run 覆盖；Agent 和 Full Access 不得扩大。
- **D1-REQ-011 Token budget:** 可选 shared Token Budget 累计 primary/child usage；达到上限后不启动新 model request，并提供 raise/narrow/incomplete synthesis 选择。
- **D1-REQ-012 Failure/retry:** Provider Failure 不自动 retry/fallback；成功 siblings 保留；manual retry 创建新 Attempt 并消耗同一 Run budget。
- **D1-REQ-013 Stop/restart:** Stop parent 会停止未完成 child；completed results 保留；restart 将活动 work 标记 Interrupted，不自动 resume/replay。
- **D1-REQ-014 Visible tree:** task tree 显示 role、objective、Profile、Provider、status、capabilities、usage、failure 和 bounded result；nested tool calls 可展开。
- **D1-REQ-015 Record hygiene:** retained record 排除 hidden reasoning、credentials、authorization headers 和 unredacted transport bodies。
- **D1-REQ-016 Memory eligibility:** raw child record/result 永久排除 Memory、Inline Capture 和 Dream；只有 parent 对话中展示并被用户采纳/修正/确认的内容才可进入现有路径。
- **D1-REQ-017 Deletion:** parent trajectory deletion 删除 child details/excerpts；individual task deletion留下 minimal `details deleted` placeholder；Outputs 保留并标记 source unavailable。
- **D1-REQ-018 Collision:** 并发 child 同目标写使用 Host collision/atomic policy；不得让 children 或 primary 隐式合并。

## IPC And Runtime Ownership

Minimum command/event families:

```text
sub_agent.run.authorize
sub_agent.task.created | queued | started | updated | completed | failed
sub_agent.attempt.created
sub_agent.budget.exhausted
sub_agent.task.retry | skip | record.delete
sub_agent.run.stopped | completed | interrupted
```

Host 创建 record、解析 Profile、验证 Capability Set、调度和持久化；Project/Unscoped Worker 内创建独立 Pi child sessions；Renderer 只发送 explicit commands 和显示 projections。

## Test Traceability

| Test id | Requirements | Observable assertion |
| --- | --- | --- |
| D1-T-001 Intent boundary | 001, 002 | Ordinary prompts create zero child calls; one explicit task authorizes one Run only. |
| D1-T-002 Flat profile resolution | 003, 004 | Role/default/primary order works; cycle/failure has no fallback. |
| D1-T-003 Context isolation | 005, 007, 015 | Child snapshots contain only allowed references and no cognitive write tools/secrets. |
| D1-T-004 Read/write capabilities | 006, 008, 018 | Critic is read-only; document child writes provenance-tracked Output; collision is gated. |
| D1-T-005 Concurrency and Stop | 009, 013 | Siblings share capacity; stopping parent ends unfinished work only. |
| D1-T-006 Limits and retry | 010, 011, 012 | Limit blocks new tasks; retry is new Attempt and consumes budget. |
| D1-T-007 Task tree | 014 | Status, tools, usage, failure and handoff survive restart and remain expandable. |
| D1-T-008 Memory exclusion | 016 | Raw child data is absent from recall/candidate/Dream scans until parent adoption. |
| D1-T-009 Deletion cascade | 017 | Details/excerpts disappear; placeholders and Output provenance remain. |

## Definition Of Done

- D1-REQ-001 through 018 pass。
- 至少一个 parallel research + critic + synthesis E2E 和一个 write-capable Output E2E 通过。
- Provider Failure、budget exhaustion、Stop、restart、record deletion 和 target collision 均有 E2E。
- 普通无 delegation intent 的 daily VC 和 Learning suites 保持零 child model calls。

## Decision Gate

存在隐藏 child call、递归 delegation、scope 泄漏、直接认知写入、自动 fallback/retry、不可见 token usage 或 restart replay 时，D1 不得关闭。

