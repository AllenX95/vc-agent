# Integration Build Executable Specification Index

Date: 2026-07-27  
Status: Complete — R1/I1-I6 and G3 accepted on the current build  
Parent plan: `docs/superpowers/plans/2026-07-22-integration-build-implementation-plan.md`  
Product authority: `docs/superpowers/specs/2026-07-06-vc-desktop-agent-design.md` and accepted ADRs

## Purpose

This index turns every remaining Integration Build Slice into an independently executable specification. The parent plan continues to own ordering and gates; these documents own within-Slice behavior, module seams, state, failure handling, migration, UI, and verification.

## Specification Set

| Slice | Executable specification | Entry condition | Exit decision |
| --- | --- | --- | --- |
| R1 | [Project Worker Runtime](2026-07-22-r1-project-worker-runtime-executable-spec.md) | R0 complete | Shared Project Worker runtime is safe for integrations |
| I1 | [Skills Directory](2026-07-22-i1-skills-directory-executable-spec.md) | R1 complete | Imported Skills can be inventoried and activated safely |
| I2 | [Claude Code Office Skills](2026-07-22-i2-office-skills-executable-spec.md) | I1 complete | User-supplied Claude Code Office Skills work end to end |
| I3 | [Skill Creator](2026-07-22-i3-skill-creator-executable-spec.md) | I1 and I2 compatibility lessons | A reused Skill Creator can stage reviewed packages |
| I4 | [Local Page Recovery](2026-07-22-i4-local-page-recovery-executable-spec.md) | R1 and Canonical Parse | Fixed local page recovery preserves best usable content |
| I5 | [MCP Adapter](2026-07-22-i5-mcp-adapter-executable-spec.md) | R1 and Capability Gateway | Pinned MCP adapter supports controlled lazy access |
| I6 | [Extension Admission](2026-07-22-i6-extension-admission-executable-spec.md) | R1 and I1 inventory mechanics | Reviewed Extensions can be approved and globally revised |
| G3 | [Integration Gate](2026-07-22-g3-integration-gate-executable-spec.md) | R1 and I1-I6 complete | Integration Build is accepted or rejected with evidence |

## Normative Language

- `MUST`, `MUST NOT`, and requirement rows are normative.
- `SHOULD` records a preferred implementation that may change only when the replacement preserves the same observable behavior and invariants.
- TypeScript and SQL fragments define the intended module interface or data shape. Identifier changes are allowed; widening authority, scope, side effects, or lifecycle is not.
- Open questions are not implementation freedom. A Slice stops at its Decision Gate when an unresolved question would change product behavior or trust.

## Required Shape Of Every Slice

Each specification contains:

1. Outcome and non-goals.
2. Governing decisions and entry conditions.
3. User-visible flows and states.
4. Deep modules, their interfaces, and process ownership.
5. Persisted records, versions, and migration/restart behavior.
6. Authorization, scope, and secret handling.
7. Failure, cancellation, crash, and Unknown Tool Outcome behavior.
8. Sanitized telemetry and Environment Doctor effects.
9. Requirement-to-test traceability.
10. Definition of Done and Decision Gate.

## Shared Invariants

All Slices inherit these requirements without restating their full rationale:

- Electron Main owns product policy, Operational State, workflow coordination, and final durable commits.
- Renderer is a command and view surface; it never becomes a filesystem, credential, Provider, Pi, MCP, OCR, Office, or Extension client.
- Agent Workers own Pi runtime and Physical Model Context only. Utility Workers and Isolated Jobs own local executable dependencies.
- `BoundedExecutionScheduler` is the only admission seam for model-backed work. Local executable jobs use a bounded Host-owned job admission path coordinated with installation resource limits.
- App launch, browsing, settings, inventory, deterministic inspection, migration, and diagnostics start no Pi session or Provider request.
- Project and Unscoped execution never share Physical Model Context. Unscoped execution receives no implicit Project authority.
- Provider Failure, dependency failure, schema mismatch, timeout, and crash never trigger automatic Provider, package, parser, server, or workflow fallback.
- Restart never automatically submits drafts, resumes model work, replays tools, reconnects MCP, activates Extensions, or starts local inference.
- Standard Access requires scoped confirmation for protected actions. Full Access suppresses eligible tool prompts but never bypasses Cognitive Review, Extension Admission, provenance, scope, or Unknown Tool Outcome handling.
- Protected Credentials remain reference-only outside the OS protection adapter. Persistent logs and UI diagnostics contain no secret or raw remote-content telemetry.
- State migration is deterministic, staged, validated, atomic, and rollback-backed; newer schemas enter Read-only Recovery.
- Every later-stage failure preserves validated earlier results and authoritative Source files.

## Traceability Convention

Requirement ids use `<SLICE>-REQ-###`; tests use `<SLICE>-T-###`. A test may cover multiple requirements, but every MUST requirement must appear in at least one test row before the Slice can close. G3 does not replace Slice tests; it exercises cross-Slice behavior.

## Change Control

- Clarifications that do not alter user-visible behavior may edit the relevant specification and record a dated note.
- Changes to trust, authorization, persistence authority, process ownership, automatic behavior, or product scope require a new or amended ADR before implementation.
- When code and a specification disagree, the accepted design and ADRs win until the specification is corrected explicitly.
