# H1 Personal Build Hardening Gate Executable Specification

Date: 2026-07-22  
Status: Proposed for implementation  
Blocked by: D1 pass

## Outcome

用统一验收矩阵证明 Foundation、Dogfood、Learning、Integration 和 Delegation 在真实桌面生命周期中共同工作，并关闭数据完整性、授权、隔离、恢复、秘密和退出行为风险。

## Required Gate Artifacts

- `personal-build-gate-report.json`
- `personal-build-gate-summary.md`
- acceptance criteria -> test/evidence traceability matrix
- build identity、state schema、migration versions、dependency inventory 和 sanitized Environment Doctor snapshot
- deterministic、real dependency、unavailable、migration/recovery、crash/cancellation 五类执行结果

所有 artifact 只使用脱敏相对路径和哈希，不包含项目内容、Memory 内容、prompt、secret、第三方 package bytes 或 OCR/MCP bodies。

## Requirements

- **H1-REQ-001 Acceptance coverage:** 原设计 `Testing And Acceptance` 中每一条 MVP criterion 必须映射自动测试或明确人工证据，不能使用“已有模块”代替行为证据。
- **H1-REQ-002 Clean start:** 空状态启动无默认 Thread/Profile，无 Pi/Provider/Worker/MCP/OCR/Skill activation；Host-only 功能仍可用。
- **H1-REQ-003 Full vertical workflow:** 至少一个 Project 从材料 inventory/parse/recall/web 到 source-referenced Output、Context、Project Memory、Reflection、Dream、Office edit 和显式 Sub-Agent workflow 完成。
- **H1-REQ-004 Unscoped isolation:** Unscoped ordinary、Reflection、Dream 和 Delegation 均无 Project state/path/credential authority。
- **H1-REQ-005 Concurrency:** 多 Thread、多 Project、Unscoped、workflow stage 和 Sub-Agent 共享 bounded capacity，保持 context isolation 和可见 queue。
- **H1-REQ-006 Interruption:** Stop、app close、Provider disconnect 和 worker crash 保留 durable progress，产生 Interrupted/Unknown states，不自动 resume/replay。
- **H1-REQ-007 Process termination:** App exit 后所有 Agent Worker、Utility Worker、Isolated Job、Python/OCR/rendering child tree 和 MCP connections 在 deadline 内终止。
- **H1-REQ-008 Write integrity:** Output、Parse、Memory patch、Skill revision、Extension revision 和 original replacement 使用 staged validation/atomic commit；失败无 mixed success。
- **H1-REQ-009 Unknown Tool Outcome:** dispatched external writes 无 confirmed result 时必须 inspect target 或由用户确认 duplicate risk 后才可 retry。
- **H1-REQ-010 Migration/recovery:** 每个持久 domain 都覆盖 supported old schema、injected migration failure、rollback 和 newer schema Read-only Recovery。
- **H1-REQ-011 External edits:** Context、Memory、Material、Skill/Extension bytes 和 Output target 的外部变化按各自 stale/refresh/invalidation policy 处理，不 hot-update Active Turn。
- **H1-REQ-012 Deletion cascade:** trajectory 删除清除 unapproved candidates、Dream excerpts 和 child details；approved records/Outputs 保留且 provenance 显示 source unavailable。
- **H1-REQ-013 Secret boundary:** Protected Credentials 只以 reference 存在；logs、IPC、trajectory、backup、gate report 和 model payload 无 secret。
- **H1-REQ-014 Scope/authority:** Renderer、Worker、Skill、MCP、Extension 和 Sub-Agent 不能扩大 Project/Unscoped、Provider、destination 或 cognitive authority。
- **H1-REQ-015 No hidden activation:** Doctor、Settings、browse、restart、migration、backup 和 deterministic inspections 保持 zero model/inference/connection activation。
- **H1-REQ-016 No fallback:** Profile、Provider、Office、OCR、MCP、Extension 和 child failures 不自动切换实现、server、Provider 或 model。
- **H1-REQ-017 Observability:** 本地 telemetry 覆盖 prompt/tool/context、queue、Worker/session/job、parser stages、MCP bounds、Extension revision、Sub-Agent usage 和 sanitized failures；remote content telemetry 默认关闭。
- **H1-REQ-018 Backup/restore:** Personal Cognition backup 机械恢复 Memory/prompt/skills overlay 等允许域，排除 Project metadata、operational jobs、credentials 和默认 trajectory。
- **H1-REQ-019 Single instance:** 第二实例只聚焦现有 app，不创建第二 writer。
- **H1-REQ-020 Usability:** sole User 可在无开发者介入情况下完成日常 VC、Learning、Office 和 Delegation 任务。

## Gate Suites

| Suite | Purpose |
| --- | --- |
| H1-S-001 Clean/idle | Zero activation and Host-only availability |
| H1-S-002 Daily VC | Full Dogfood vertical workflow |
| H1-S-003 Learning | Long-term Memory, Reflection, Dream, backup/migration |
| H1-S-004 Integration | Real Office/OCR/MCP and Extension lifecycle |
| H1-S-005 Delegation | Parallel read-only and write-capable Sub-Agent Runs |
| H1-S-006 Concurrency | Multi-Thread/Project/workflow queue, stop and collision |
| H1-S-007 Crash/restart | Every process and external outcome boundary |
| H1-S-008 Upgrade/recovery | Old/new schema and injected migration failures |
| H1-S-009 Deletion/privacy | Trajectory, child, candidate and source-unavailable cascade |
| H1-S-010 Static/security | Imports, spawns, secrets, paths, package bytes, eager activation |

## Severity Gate

以下任一开放缺陷直接 `fail`：

- 数据丢失、mixed commit、错误覆盖或无法回滚。
- Project/Unscoped、Thread、Provider 或 child context 交叉泄漏。
- 未授权外部写、原文件替换、Extension enablement 或认知状态变更。
- Secret 进入持久化、日志、UI、模型或报告。
- App exit 后工作继续、restart replay 或隐藏模型调用。
- 自动 Provider/model/parser/server fallback。

功能性缺陷若使已承诺的 Personal Build 路径无法完成，则为 `blocked` 或 `fail`，不能以 optional dependency 为由忽略；仅真实非必选环境缺失且 unavailable path 正确时可记录 warning。

## Pass Rules

- H1-REQ-001 through 020 全部通过。
- C0、C1、C2、D1 gates 均为 pass，且证据属于当前 build/schema。
- `pnpm verify`、Integration G3 和 Personal Build Gate 全部从干净状态通过。
- 无开放 severity-1/2 integrity、authorization、isolation、replay、secret 或 required-usability defect。
- Gate report 的 zero-secret/absolute-path/third-party-byte scan 通过。

## Definition Of Done

最终报告 decision 为 `pass`；原设计所有第一版 acceptance commitments 均有当前证据；用户可以将该构建作为完整 Personal Build 使用，而不是开发 fixture 或部分 Integration preview。

## Final Decision Gate

只有 `pass` 才表示原设计的 Personal Build 完成。`blocked`、fixture-only、已知 eager activation、缺失真实 dependency path、未实现 deletion/recovery edge 或未关闭 Sub-Agent trust boundary 均不得被标记为完成。

