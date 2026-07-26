# Personal Build Completion Executable Specification Index

Date: 2026-07-22  
Status: C0/C1 pass; D1/H1 deterministic implementation slices present; C2 real dependency gate blocked
Parent plan: `docs/superpowers/plans/2026-07-22-personal-build-completion-implementation-plan.md`

## Purpose

本索引将剩余 Personal Build 工作拆为五个顺序关闭的可执行阶段。现有 R1/I1-I6/G3 SPEC 继续拥有各 Integration 模块的细节；本组 SPEC 负责当前实现收敛、跨模块产品接线、真实依赖、Delegation 和最终验收。

## Specification Set

| Stage | Executable SPEC | Entry condition | Exit decision |
| --- | --- | --- | --- |
| C0 | [Integration Baseline Stabilization](2026-07-22-c0-integration-baseline-stabilization-spec.md) | Learning G2 and current worktree | Runtime/integration baseline is safe to extend |
| C1 | [Desktop Integration Surface](2026-07-22-c1-desktop-integration-surface-spec.md) | C0 pass | I1-I6 are operable through desktop paths |
| C2 | [Real Integration And G3 Closure](2026-07-22-c2-real-integration-gate-spec.md) | C1 pass | Integration Build G3 is `pass` |
| D1 | [Explicit Sub-Agent Runtime](2026-07-22-d1-explicit-sub-agent-runtime-spec.md) | C2 pass | Delegation is bounded, visible, and recoverable |
| H1 | [Personal Build Hardening Gate](2026-07-22-h1-personal-build-hardening-gate-spec.md) | D1 pass | Complete Personal Build is accepted |

## Normative Rules

- `MUST`、`MUST NOT` 和带 requirement id 的条目为规范要求。
- 每个 requirement 必须映射至少一个自动测试或明确记录的人工/真实依赖证据。
- Fixture 证明接口和失败注入；不能替代 C2 要求的真实 dependency path。
- 后续阶段不能通过放宽前一阶段边界来关闭；行为冲突时，以产品设计和已接受 ADR 为准。
- 任一阶段出现 `blocked` 时，后续阶段不得被标记完成。

Current evidence: D1 deterministic runtime/desktop fixture and H1 five-mode gate are executable, but neither D1 nor H1 is marked `pass` while C2 remains `blocked`.

## Existing Integration Specifications Reused

- `2026-07-22-r1-project-worker-runtime-executable-spec.md`
- `2026-07-22-i1-skills-directory-executable-spec.md`
- `2026-07-22-i2-office-skills-executable-spec.md`
- `2026-07-22-i3-skill-creator-executable-spec.md`
- `2026-07-22-i4-local-page-recovery-executable-spec.md`
- `2026-07-22-i5-mcp-adapter-executable-spec.md`
- `2026-07-22-i6-extension-admission-executable-spec.md`
- `2026-07-22-g3-integration-gate-executable-spec.md`

## Shared Evidence Convention

Gate evidence只保留 build id、schema version、test id、duration、状态、相对 evidence path、哈希和脱敏 diagnostics。不得保存凭据、原始 prompt、项目内容、OCR 页面文本、MCP payload body、第三方 Skill 源路径或 Extension audit 原始材料。
