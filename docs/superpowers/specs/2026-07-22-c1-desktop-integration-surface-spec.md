# C1 Desktop Integration Surface Executable Specification

Date: 2026-07-22  
Status: Implemented for the desktop fixture slice; real dependency acceptance remains C2  
Blocked by: C0 pass

## Outcome

用户可以完全通过桌面 UI 操作 I1-I6 的 fixture 和 unavailable 路径。Renderer 仍是无特权视图，所有授权、状态转换和副作用由 Host 执行。

## Information Architecture

Settings 增加一个 `Integrations` 区域，包含：

- Skills：目录位置、inventory、import、compatibility、diff、activate/disable、revision。
- Office Skills：每个格式的 package/dependency 状态、创建/编辑任务和结果。
- Page Recovery：native/Paddle/Ovis availability、policy、显式 Parse activity。
- Connected Tools：pinned adapter、server config、credential reference、lazy connection 和 capabilities。
- Extensions：staged、inspection、audit、approval、enabled revision、pending revision、rollback。
- Runtime：Worker/session/job/queue/crash/shutdown telemetry。

主 Thread 只显示与当前 Turn 相关的 Integration activity，不把全部设置或 schema 注入模型上下文。

## Requirements

- **C1-REQ-001 Typed bridge:** 每个 UI 动作 MUST 使用 versioned typed IPC command/event；Renderer 不得直接导入 Host Service 或 Node API。
- **C1-REQ-002 Read projections:** bootstrap 和后续 events MUST 提供可恢复的状态 projection；UI 不得从自由文本推断 lifecycle。
- **C1-REQ-003 Skills flow:** 用户可显式创建/选择 Skills Directory、导入完整包、查看 diagnostics/diff、激活、禁用和检查 revision。
- **C1-REQ-004 Office flow:** 用户可从 task intent 启动 create/edit，查看 dependency check、staged copy、diff、provenance、replace decision 和 failure recovery。
- **C1-REQ-005 Skill Creator flow:** 只有显式 intent 可创建/update draft；review 后移交 I1，默认 disabled。
- **C1-REQ-006 OCR flow:** 用户可查看三阶段 availability 并显式对 Material 运行 Parse；UI 展示 per-page retained-result 和 warning，不展示伪造文本。
- **C1-REQ-007 MCP flow:** 用户可保存 server config/credential reference 而不连接；连接只发生在 task activation；read/write permission 和 provenance 可见。
- **C1-REQ-008 Extension flow:** staged、inspect、audit、approve、enable、pending revision、activate、invalidate 和 rollback 是独立可见动作。
- **C1-REQ-009 Lifecycle states:** 每条异步工作流必须至少表示 `pending | queued | running | completed | failed | interrupted | unknown_outcome` 中适用的状态。
- **C1-REQ-010 Restart:** 重启后恢复 inventory、draft、job/result、revision 和 failure 状态，但不得自动继续、连接、推理、审核或写入。
- **C1-REQ-011 Authorization:** Standard/Full Access 只影响合格的 tool confirmation；不得绕过 Extension approval、Output Intent、Cognitive Review 或 Unknown Tool Outcome。
- **C1-REQ-012 Task activation:** 普通 Turn 未使用 Integration 时，Runtime Resource Snapshot 不得包含无关 Skill instructions、MCP schemas 或 Extension tools。
- **C1-REQ-013 Unavailable honesty:** 缺少 package/runtime/server/profile 时必须显示 actionable unavailable reason，并保留其他日常功能。
- **C1-REQ-014 Accessibility:** 所有关键 action、status、error 和 review surface 必须有稳定 accessible name，供键盘和 Playwright 使用。

## Command/Event Families

建议族名；最终名称可调整但语义不能合并：

```text
skills.view | skills.import | skills.review | skills.activate | skills.disable
office.task.prepare | office.task.run | office.result.review | office.source.replace
skill_creator.prepare | skill_creator.run | skill_creator.review | skill_creator.handoff
page_recovery.inspect | page_recovery.run | page_recovery.cancel
mcp.server.save | mcp.activate | mcp.permission.resolve | mcp.disconnect
extension.stage | extension.inspect | extension.audit | extension.approve
extension.revision.prepare | extension.revision.activate | extension.rollback
integration.state.updated | integration.job.updated | integration.diagnostic
```

每个 command 必须携带 command id、correlation id、expected state version 和 scope；每个 durable state transition 必须由 Host event 确认。

## Test Traceability

| Test id | Requirements | Observable assertion |
| --- | --- | --- |
| C1-T-001 Renderer boundary | 001, 002 | Static architecture test finds no privileged imports or direct clients. |
| C1-T-002 Skills UI | 003, 010, 014 | Import-review-activate-disable survives restart with no eager activation. |
| C1-T-003 Office UI fixture | 004, 009, 011 | Create/edit/diff/deny/approve/failure states are visible. |
| C1-T-004 Creator UI fixture | 005 | Explicit draft/review/handoff remains disabled. |
| C1-T-005 OCR UI fixture | 006, 013 | Native/Paddle/Ovis selection and unavailable warnings are visible. |
| C1-T-006 MCP UI fixture | 007, 011 | Save causes zero connection; task activation and write gate are visible. |
| C1-T-007 Extension UI fixture | 008, 011 | Review, approval and enablement remain separate across restart. |
| C1-T-008 Resource snapshot | 012 | Unrelated Turns contain zero Integration resources; relevant Turn contains minimum projection. |
| C1-T-009 Recovery matrix | 009, 010, 013 | Every interrupted/failed workflow restores without automatic continuation. |

## Definition Of Done

- C1-REQ-001 through 014 pass。
- I1-I6 每个 fixture flow 都可通过桌面 UI 完成。
- 不需要 terminal、数据库编辑、内部目录手工复制或开发者注入。
- Settings/Doctor 浏览保持零 Pi、Provider、MCP connection 和 OCR inference。

## Decision Gate

任一 Integration 仍只有服务层 API、状态只能通过文本猜测、或 UI 动作可以越过 Host authorization 时，不得进入 C2。
