# Personal Build Completion Executable Specification Index

Date: 2026-07-27  
Status: C0/C1/C2/D1/H1 pass; final release evidence validated
Parent plan: `docs/superpowers/plans/2026-07-22-personal-build-completion-implementation-plan.md`

## Purpose

本索引将剩余 Personal Build 工作拆为五个顺序关闭的可执行阶段。现有 R1/I1-I6/G3 SPEC 继续拥有各 Integration 模块的细节；本组 SPEC 负责当前实现收敛、跨模块产品接线、真实依赖、Delegation 和最终验收。

## Final reconciliation (2026-07-27)

当前发布状态以本节和 `docs/superpowers/plans/2026-07-26-post-g3-development-plan-and-spec.md` 为准；下方历史规则仍然是规范约束，但不再代表当前 Gate 状态。

- `pnpm verify`：56 个测试文件、241 个单元/集成测试、32 个 fixture/unavailable E2E 全部通过。
- `pnpm integration-gate:release`：G3-T-001 至 G3-T-011 全部 `pass`。
- `pnpm sub-agent:compat`：真实 MIMO Profile、Provider-backed child、Output adoption、stop/budget/failure 脱敏证据通过。
- `pnpm h1:packaged`：进程树、Word 外部编辑、备份恢复、单实例生命周期证据通过。
- `pnpm personal-build-gate:release`：H1-S-001 至 H1-S-010 全部 `pass`。
- Office 使用 Microsoft Word；MCP 使用 vc-agent 自有 `server-filesystem` runtime；所有真实依赖包和证据均在仓库外。

## Specification Set

| Stage | Executable SPEC | Entry condition | Exit decision |
| --- | --- | --- | --- |
| C0 | [Integration Baseline Stabilization](2026-07-22-c0-integration-baseline-stabilization-spec.md) | Learning G2 and current worktree | `pass` |
| C1 | [Desktop Integration Surface](2026-07-22-c1-desktop-integration-surface-spec.md) | C0 pass | `pass` |
| C2 | [Real Integration And G3 Closure](2026-07-22-c2-real-integration-gate-spec.md) | C1 pass | `pass`（G3-T-001..011） |
| D1 | [Explicit Sub-Agent Runtime](2026-07-22-d1-explicit-sub-agent-runtime-spec.md) | C2 pass | `pass`（真实 Provider evidence） |
| H1 | [Personal Build Hardening Gate](2026-07-22-h1-personal-build-hardening-gate-spec.md) | D1 pass | `pass`（H1-S-001..010） |

## Normative Rules

- `MUST`、`MUST NOT` 和带 requirement id 的条目为规范要求。
- 每个 requirement 必须映射至少一个自动测试或明确记录的人工/真实依赖证据。
- Fixture 证明接口和失败注入；不能替代 C2 要求的真实 dependency path。
- 后续阶段不能通过放宽前一阶段边界来关闭；行为冲突时，以产品设计和已接受 ADR 为准。
- 任一阶段出现 `blocked` 时，后续阶段不得被标记完成。

Current evidence: C0/C1/C2/D1/H1 are all marked `pass`; the remaining maintenance activity is periodic re-run and release-document synchronization.

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
