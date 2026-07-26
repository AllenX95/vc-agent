# G3 Practical Integration Workflow Gate Executable Specification

Date: 2026-07-27  
Status: Complete — G3-T-001 through G3-T-011 passed on the current build  
Parent: `2026-07-22-integration-slice-spec-index.md`  
Blocked by: None

## Outcome

The Integration Build is accepted only when the shared runtime and every integration has a real visible desktop path, deterministic persisted state, explicit unavailable behavior, restart safety, authorization evidence, and cross-Slice compatibility. Optional external dependencies need not all be installed, but their unavailable paths must be functional and honest.

Closure evidence: `pnpm integration-gate:release` passed with Microsoft Word, local OCR, and vc-agent-owned filesystem MCP evidence. The real MCP path used `read_text_file` and `write_file` through `pi-mcp-adapter@1.5.1`; no fixture evidence was promoted to the release artifact.

## Non-goals

- No new product feature, broad performance program, Sub-Agent Run, distributable installer claim, marketplace, automatic updater, or requirement to bundle User-supplied Office Skills/OCR weights.
- G3 does not replace Slice-level tests or waive incomplete requirements.

## Governing Decisions

All accepted design decisions and R0/R1/I1-I6 executable specifications. Where a fixture differs from a real dependency, both the interface contract and at least one real Personal Build path required by the owning Slice must pass.

## Gate Artifacts

The implementation produces a local `integration-gate-report.json` and readable Markdown summary containing build identity, state schema, sanitized Environment Doctor inventory, executed test ids, durations, evidence paths, migration versions, zero-secret scan, warnings, unavailable dependencies, deferred scope, and a final `pass | fail | blocked` decision.

The report contains no credentials, raw prompts, Project content, imported package source paths, MCP payload bodies, OCR page content, or audit artifact source.

## Required Gate Scenarios

### G3-REQ-001 Runtime multitasking and restart

One E2E scenario MUST start model work in two Threads under bounded capacity; prove one Project Worker with isolated Project Thread sessions and a separate Unscoped Worker; queue/edit/reorder/cancel a Follow-up; stop one Turn without affecting unrelated work or submitting the Follow-up; then restart with drafts/checkpoints but no Worker, Pi, Provider, job, MCP connection, inference, audit, or replay.

### G3-REQ-002 Office Skill path

Using a complete fixture package and at least one real User-supplied Claude Code Office Skill, the gate MUST prove explicit import, compatibility review, disabled-by-default activation, document creation with provenance, Source edit to copy plus change summary, denied and approved replacement, and dependency/render/job failure preserving validated results. No third-party package bytes may enter the repository or report.

### G3-REQ-003 Page recovery path

A mixed fixture PDF MUST prove native preservation, Paddle page selection, Ovis structural escalation, candidate validation, best-earlier-result retention after injected Ovis failure, provenance, cancellation, and restart without inference.

### G3-REQ-004 MCP path

A fixture MCP server MUST prove configuration without connection, task activation, bounded/provenanced read, protected denied/approved write, schema mismatch, disconnect, large-payload retirement, secret hygiene, and restart without reconnection.

### G3-REQ-005 Skill Creator path

The reused Creator fixture/real package MUST create or update a staged Skill, show complete diff/dependency review, pass I1 compatibility handoff, remain disabled, and preserve the prior active revision on injected failure.

### G3-REQ-006 Extension path

A fixture Extension MUST prove non-executing staging, deterministic closure inspection, isolated Audit, Provider Failure preservation, exact User approval, separate disabled state, pending enablement, global idle activation, Worker revision changeover, changed-byte invalidation, immediate activation interruption, and rollback.

### G3-REQ-007 Failure and recovery matrix

The suite MUST visibly cover missing/incompatible Profile, Provider Failure, all runtime process crashes, Office/OCR missing dependency and timeout, MCP disconnect/schema mismatch, Audit Provider Failure and artifact mismatch, stale parse/output/Skill/Extension revisions, same-target collision, Unknown Tool Outcome, supported migration failure, and newer-state Read-only Recovery. No case may silently fallback, corrupt earlier state, start unrelated work, or manufacture approval/provenance.

### G3-REQ-008 Environment Doctor and observability

Environment Doctor MUST report sanitized Pi Adapter, Profile, credential, storage, migration, scheduler, Agent/Utility/Isolated runtime, Skills, Office, OCR, MCP, Extension revision, and backup status without activating those resources. Local telemetry MUST cover capacity, queue/job/running duration, failures, parser stages, MCP bytes/truncation, and revision state without remote content telemetry.

### G3-REQ-009 Security and exclusion

Automated inspection MUST demonstrate Renderer privilege exclusion, Pi SDK import only in Pi Adapter, executable spawns limited to runtime adapters, reference-only credentials, cognitive exclusion for Skills/Audit, no staged Extension discovery, and no external Skill roots or User-supplied Office bytes in repository artifacts.

### G3-REQ-010 Personal usability

With declared dependencies available, the sole User MUST import their Claude Code Office Skills and complete ordinary document work through the desktop UI without developer edits, database manipulation, terminal commands, or manual copying into internal directories.

## Gate Execution Modes

| Mode | Purpose | Required |
| --- | --- | --- |
| Deterministic fixtures | Contract, state, security, failure injection, migration, restart | Every change and final gate |
| Personal Build dependency run | Real supplied Office Skill and installed OCR/runtime compatibility | Before final pass |
| Unavailable-dependency run | Honest degraded UI and no fallback | Before final pass |
| Upgrade/recovery run | Old schema, injected migration failure, newer schema | Before final pass |

## Pass/Fail Rules

- `pass`: every R1/I1-I6 Definition of Done and G3-REQ-001 through 010 pass; required real path succeeds; no open severity-1/2 integrity, authorization, loss, isolation, or replay defect.
- `fail`: an implemented path violates a requirement, trust statement, or preserves incorrect state.
- `blocked`: a required real dependency or explicit User action is unavailable. Blocked is not pass and cannot become pass through fixtures alone.

Optional dependency absence is acceptable only in unavailable-dependency mode; it never excuses missing diagnostics or recovery.

## Test Matrix

| Test id | Scenario | Primary evidence |
| --- | --- | --- |
| G3-T-001 | Project/Unscoped queue-stop-restart | R0, R1 |
| G3-T-002 | Fixture and real Office create/edit/replace | I1, I2 |
| G3-T-003 | Skill Creator staged handoff | I1, I3 |
| G3-T-004 | Mixed PDF recovery and best-result retention | I4 |
| G3-T-005 | Lazy MCP read/write/failure/restart | I5 |
| G3-T-006 | Extension inspect/audit/approve/revise/rollback | I6, R0, R1 |
| G3-T-007 | Cross-runtime crash/cancel/shutdown | R1, I2, I4 |
| G3-T-008 | Migration and Read-only Recovery | all persisted Slices |
| G3-T-009 | Secret/content/exclusion/static scan | all Slices |
| G3-T-010 | Environment Doctor causes zero activation | all Slices |
| G3-T-011 | Personal usability without developer intervention | I1, I2, G3 |

## Evidence Requirements

E2E stores only sanitized screenshots/traces and machine-readable assertions. Filesystem outcomes use hashes and relative paths rather than content. Process evidence records owner/session/job ids and PIDs where needed. Network fixtures count connections/requests and redact bodies. Cleanup must not delete User data or real imported packages.

## Execution Order

1. Confirm every Slice test matrix and Definition of Done independently.
2. Run deterministic full suite from empty state.
3. Run migration/recovery and unavailable-dependency suites.
4. Run Personal Build real Office/OCR compatibility path.
5. Run authority, package-content, secret, and telemetry scans.
6. Generate the gate report and review every warning/blocked item.

## Definition Of Done

- G3-REQ-001 through G3-REQ-010 pass with linked evidence.
- Parent plan R1/I1-I6/G3 checklists are fully checked.
- `pnpm verify` and the Integration Gate command pass from a clean supported state.
- A supported prior state migrates atomically; restart remains dormant.
- The User performs the declared Personal Build Office workflow without developer intervention.
- Deferred Delegation and Hardening scope remains unavailable rather than partially exposed.

## Final Decision Gate

Only `pass` closes the Integration Build. A blocked real dependency, fixture-only Office claim, eager activation, authorization bypass, data-loss edge, cross-scope context leak, or automatic replay keeps the build open regardless of apparent feature completeness.
