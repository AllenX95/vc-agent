# C2 Real Integration And G3 Closure Executable Specification

Date: 2026-07-22  
Status: Complete — fixture and real dependency gate passed on 2026-07-26
Blocked by: None

## Outcome

用真实但不入库的用户依赖验证 Integration Build，并使 `G3 Practical Integration Workflow Gate` 从 `blocked` 变为 `pass`。

Closure evidence: the pinned Anthropic Office source was provisioned only under vc-agent-owned application data, and an external Microsoft Word runner passed create/edit/reopen/replace without LibreOffice. Configured OCR evidence remained valid, and an external official filesystem MCP service passed lazy-read/confirmed-write/restart through `pi-mcp-adapter@1.5.1`. `pnpm integration-gate:release` reports `pass` for G3-T-001 through G3-T-011. Evidence files, dependency packages, generated documents, and MCP sandbox contents remain outside the repository.

## Real Dependency Matrix

| Integration | Required real evidence | Repository rule |
| --- | --- | --- |
| Office | One complete user-supplied Claude Office Skill create/edit/diff/replace path | Package bytes stay outside Git |
| OCR | Configured PaddleOCR and OvisOCR2 local runtime on native/scanned/complex pages | No weights or environment paths in Git/report |
| MCP | Actually installed and locked pinned `pi-mcp-adapter` plus fixture server | No second client and no credentials in config export |
| Skill Creator | Complete reused package stages a valid disabled Skill | Generated personal package stays in app data |
| Extension | Fixture artifact through inspect/audit/approve/revise/rollback | Audit inputs and staged bytes excluded from cognition/backup |

## Requirements

- **C2-REQ-001 Office provenance:** 真实 Office create/edit 必须产生 Output Registry provenance、edited copy、change summary 和 source references。
- **C2-REQ-002 Office replacement:** Standard deny/approve 和 Full visible action 均需验证；unknown completion 必须进入 Unknown Tool Outcome。
- **C2-REQ-003 Office degradation:** 缺少依赖、render failure、job timeout 和 source change 必须保留 source 与 validated staged copy；不得 LibreOffice fallback。
- **C2-REQ-004 OCR chain:** native -> Paddle -> Ovis 路由必须由 deterministic quality rules 触发，并保存 parser-independent provenance。
- **C2-REQ-005 OCR preservation:** Ovis timeout/crash/invalid result 必须保留可用 native/Paddle candidate；app restart 不得启动 inference。
- **C2-REQ-006 MCP artifact:** 生产依赖树必须包含 exact pinned adapter；运行时必须拒绝不同版本或 changed bytes。
- **C2-REQ-007 MCP lazy authority:** Settings 不连接；task activation 后才连接；write、submission、sampling、elicitation、upload 和 permission expansion 经过 Host gate。
- **C2-REQ-008 MCP failure:** disconnect、schema mismatch、timeout 和 restart 不得 fallback、reconnect 或重放。
- **C2-REQ-009 Skill Creator:** 真实/完整 Creator 包必须生成可审查 staged package，通过 I1 compatibility，且保持 disabled。
- **C2-REQ-010 Extension lifecycle:** fixture Extension 必须完成 deterministic closure、isolated audit、User approval、separate enablement、idle activation、invalidation 和 rollback。
- **C2-REQ-011 Personal usability:** 用户必须只通过桌面 UI 完成真实 Office workflow；允许首次选择外部 package/runtime location，但不允许 terminal provisioning 成为最终产品步骤。
- **C2-REQ-012 Gate modes:** deterministic fixture、unavailable dependency、migration/recovery、real dependency 四种模式必须全部运行。
- **C2-REQ-013 Evidence hygiene:** gate report 和 trace 不得包含 secret、absolute external paths、project content、OCR text、MCP bodies 或 third-party package bytes。
- **C2-REQ-014 G3 pass:** 所有 R1/I1-I6 Definition of Done 和 G3-REQ-001 through 010 必须关闭；最终 decision 必须是 `pass`。

## Gate Execution Order

1. 从空 app-data 运行 deterministic fixture suite。
2. 运行所有依赖缺失和失败注入场景。
3. 从支持的旧 schema、迁移失败和 newer schema 运行 recovery suite。
4. 在用户选择的外部依赖上运行真实 Office/OCR/MCP compatibility path。
5. 运行 secret、absolute path、package byte、eager activation 和 runtime ownership scans。
6. 生成并人工审查 `integration-gate-report.json` 和 Markdown summary。

## Test Traceability

| Test id | Requirements | Observable assertion |
| --- | --- | --- |
| C2-T-001 Real Office | 001, 002, 003, 011 | Real create/edit/diff/replace and degraded paths complete through UI. |
| C2-T-002 Real OCR | 004, 005 | Mixed pages route correctly and retain earlier results on Ovis failure. |
| C2-T-003 Pinned MCP | 006, 007, 008 | Exact adapter runs lazy fixture server path; mismatch/restart stay dormant. |
| C2-T-004 Creator handoff | 009 | Complete package creates reviewed disabled Skill. |
| C2-T-005 Extension lifecycle | 010 | Artifact reaches approved revision and retained rollback without self-approval. |
| C2-T-006 Four-mode gate | 012, 014 | All modes execute and final G3 decision is pass. |
| C2-T-007 Evidence scan | 013 | Reports/traces contain no prohibited values or bytes. |

## Definition Of Done

- C2-REQ-001 through 014 pass。
- `pnpm integration-gate` 运行完整 G3，而不只是 report fixture test。
- G3 report decision 为 `pass`，无 blocked real dependency。
- 原 Integration implementation plan 的 R1/I1-I6/G3 checklist 全部勾选并链接证据。

## Decision Gate

真实 Office/OCR/MCP 任一路径只能由 fixture 证明、仍需 terminal 操作、或 gate 为 `blocked` 时，不得进入 D1。

## Local Evidence Inputs

`pnpm integration-gate` 不会把环境变量本身当作真实通过证据。G3-T-011 只有在下列值都存在、且路径位于仓库外时才会解除阻断：

- `VC_AGENT_REAL_OFFICE_SOURCE` + `VC_AGENT_REAL_OFFICE_EVIDENCE`
- `VC_AGENT_REAL_OCR=1` + `VC_AGENT_REAL_OCR_EVIDENCE`
- `VC_AGENT_REAL_MCP_ADAPTER=1` + `VC_AGENT_REAL_MCP_EVIDENCE`

Evidence 文件只能是脱敏兼容性摘要；不得包含 Skill 源码、模型权重、凭据、项目内容、OCR 文本或 MCP response body。
