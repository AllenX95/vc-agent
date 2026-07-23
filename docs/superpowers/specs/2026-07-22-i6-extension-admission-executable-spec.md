# I6 Extension Admission And Global Revision Executable Specification

Date: 2026-07-22  
Status: Approved for implementation  
Parent: `2026-07-22-integration-slice-spec-index.md`  
Blocked by: R1, I1 inventory mechanics, and pinned bundled Extension loader

## Outcome

A User-selected local Pi Extension can be copied into non-executing staging, deterministically inspected, optionally model-reviewed in an isolated explicit Audit, explicitly approved, separately enabled, and activated only through an atomic installation-wide Global Extension Revision. Changed bytes invalidate approval; disable, update, and rollback use the same revision mechanism.

## Non-goals

- No hostile-code sandbox guarantee, automatic acquisition/update/install/audit/approval/enablement, per-Project Extension profile, Agent self-approval, or Full Access bypass.
- No execution from staging, review directories, mutable source paths, or unmatched dependency closure.
- No claim that model review covers every transitive dependency line by line.

## Governing Decisions

ADR 0034, 0042, 0048, 0054, 0055, 0057, R0, R1, and I1 integrity mechanics.

## Deep Modules And Interfaces

### `ExtensionAdmissionManager`

```ts
interface ExtensionAdmissionManager {
  stage(request: LocalExtensionStageRequest): Promise<StagedExtension>;
  inspect(stagedRevisionId: string): Promise<DeterministicInspectionReport>;
  startAudit(request: ExtensionAuditRequest): Promise<ExtensionAuditRun>;
  approve(request: ExtensionApprovalRequest): Promise<ApprovedExtensionRevision>;
  reject(stagedRevisionId: string, reason?: string): Promise<void>;
}
```

### `GlobalExtensionRevisionManager`

```ts
interface GlobalExtensionRevisionManager {
  propose(change: ExtensionEnablementChange): Promise<PendingGlobalExtensionRevision>;
  activateWhenIdle(revisionId: string): Promise<void>;
  activateImmediately(revisionId: string): Promise<ImmediateActivationResult>;
  rollback(approvedRevisionId: string): Promise<PendingGlobalExtensionRevision>;
  snapshot(): GlobalExtensionRevisionState;
}
```

The first module owns artifact identity and User approval. The second owns one effective set, pending change, global idle boundary, Worker termination, and rollback. Approval never calls enablement implicitly.

## Storage Layout

```text
<app-data>/integrations/extensions/
  staged/<staged-revision-id>/
  approved/<extension-id>/<approved-revision-id>/
  reports/<report-id>/
  audit-work/<audit-run-id>/
```

Approved artifacts are immutable content-addressed copies. SQLite records identity, hashes, source revision if available, dependency lock/closure hash, entry points, lifecycle scripts, native binaries, permissions, licenses, compatibility, findings, evidence, User decision, and Global Revision membership.

## Required Behavior

| Requirement | Behavior |
| --- | --- |
| I6-REQ-001 | Staging MUST copy a complete local artifact into a non-discovered directory and MUST never execute package code or lifecycle scripts. |
| I6-REQ-002 | Deterministic inspection MUST run without Pi and inventory exact bytes, source revision, lockfile/closure, integrity, entry points, scripts, native binaries, permissions, licenses, vulnerabilities, and gaps. |
| I6-REQ-003 | Missing immutable identity, incomplete artifact, integrity failure, or non-deterministic dependency resolution MUST be a non-overridable admission blocker. |
| I6-REQ-004 | Risk findings on a fully identified artifact remain visible and may be explicitly accepted by the User; inspection never approves. |
| I6-REQ-005 | Audit starts only from explicit User action and must acquire R0 `extension_audit` capacity using Extension Audit assignment or explicit Profile override. |
| I6-REQ-006 | Audit receives only staged artifact and deterministic evidence with minimal versioned audit instructions; no Projects, ordinary Threads, Skills, VC prompt, Context, Memory, Reflection, Dream, or ordinary resource snapshot. |
| I6-REQ-007 | Missing Profile or Provider Failure preserves deterministic evidence and audit state, with no fallback, retry, Provider switch, or effect on ordinary Threads. |
| I6-REQ-008 | Report MUST distinguish deterministic facts, model review, unreviewed transitive surface, requested permissions, blockers, accepted findings, and residual risk. |
| I6-REQ-009 | Only an explicit User command can approve exact reviewed identity. Agent, audit model, Full Access, update flow, and Extension code cannot approve. |
| I6-REQ-010 | Newly approved Extension remains disabled. Enablement is a separate explicit installation-wide action. |
| I6-REQ-011 | Runtime load MUST match approved artifact bytes, closure lock/hash, source revision, entry points, permissions, and retained identity exactly. |
| I6-REQ-012 | Enable, disable, update, and rollback MUST create one pending Global Extension Revision and MUST NOT hot-modify individual Workers. |
| I6-REQ-013 | Default activation occurs atomically only when scheduler and runtime supervisor report global idle; all old-revision Workers terminate before later lazy recreation. |
| I6-REQ-014 | Immediate activation requires explicit warning/command, interrupts/checkpoints active work, terminates Workers, atomically activates, and never resumes/replays automatically. |
| I6-REQ-015 | Rollback is allowed only to retained bytes whose current identity still matches approval and uses the same pending revision path. |
| I6-REQ-016 | One effective Global Revision applies to every Project and Unscoped Worker; no per-scope override exists. |
| I6-REQ-017 | UI MUST disclose enabled Extensions as Trusted Worker Code whose direct process behavior cannot be fully mediated by Standard Access. |
| I6-REQ-018 | Host-proxied durable state, Memory, authorization, and permission changes remain Host-validated even for approved code. |
| I6-REQ-019 | Audit input, trajectory, report, and findings are excluded from Memory capture, Dream, ordinary recall, Personal Cognition Backup, and Project Outputs unless explicitly exported. |
| I6-REQ-020 | Restart performs no audit continuation or pending revision activation unless the User explicitly resumes/activates after state inspection. |

## State Machines

Admission:

```text
staging -> staged -> inspecting -> blocked | reviewable
reviewable -> audit_running -> audit_paused | audit_complete
reviewable/audit_complete -> awaiting_user_decision
-> approved_disabled | rejected
approved_disabled -- identity change --> invalidated
```

Global revision:

```text
effective Rn -> pending Rn+1
pending -> waiting_for_global_idle -> activating -> effective Rn+1
pending -> immediate_activation -> interrupt/checkpoint/terminate -> effective Rn+1
pending -> cancelled
```

There is at most one pending Global Extension Revision. Competing changes must compose into a reviewed replacement proposal or wait.

## Audit Isolation And Runtime Load

- Audit uses an isolated owner/work directory and one Physical Model Context unrelated to ordinary Thread ids.
- Audit capability set is read-only staged artifact inspection plus bounded report production; shell/network/credentials are absent unless a future ADR explicitly adds them.
- Approved artifact loading occurs only in Agent Worker startup from an app-generated exact manifest. Pi/global/project discovery remains disabled.
- Extension-provided tools/instructions are still task-activated; global enablement does not mean every Turn receives their schemas.

## UI And Environment Doctor

- Extension details separate Staged, Deterministic Inspection, Audit, Approval, Enablement, and Effective Revision.
- Approval review shows exact identity, closure, entry points, scripts, permissions, findings, audit limitations, and Worker-level trust disclosure.
- Global revision screen shows effective/pending set, blocking active work, default idle activation, immediate activation warning, and rollback targets.
- Doctor verifies loader, approved artifact hashes, pending/effective consistency, and audit assignment locally without executing Extension code.

## Failure Codes

`EXTENSION_STAGE_FAILED`, `EXTENSION_IDENTITY_INCOMPLETE`, `EXTENSION_INTEGRITY_FAILED`, `EXTENSION_DEPENDENCY_UNRESOLVED`, `EXTENSION_ADMISSION_BLOCKED`, `EXTENSION_AUDIT_PROFILE_MISSING`, `EXTENSION_AUDIT_FAILED`, `EXTENSION_APPROVAL_MISMATCH`, `EXTENSION_NOT_APPROVED`, `EXTENSION_REVISION_CONFLICT`, `EXTENSION_ACTIVATION_BLOCKED`, `EXTENSION_ARTIFACT_CHANGED`, and `EXTENSION_ROLLBACK_UNAVAILABLE`.

## Test Traceability

| Test | Requirements | Assertion |
| --- | --- | --- |
| I6-T-001 Non-executing stage | 001, 002 | Lifecycle fixture never runs; full deterministic inventory produced without Pi. |
| I6-T-002 Hard blockers | 003, 004 | Missing lock/integrity cannot be overridden; risk finding can be accepted only with exact identity. |
| I6-T-003 Audit isolation | 005-008, 019 | Shared capacity used; audit prompt/resources contain no VC or cognitive/project data. |
| I6-T-004 Audit failure | 007 | Missing Profile/Provider failure preserves deterministic report and no fallback. |
| I6-T-005 Approval separation | 009, 010 | Model/Agent/Full Access cannot approve; approved remains disabled. |
| I6-T-006 Runtime identity | 011, 018 | Exact approved bytes load; changed bytes block; Host commits remain validated. |
| I6-T-007 Idle activation | 012, 013, 016 | Current revision remains until global idle, then old Workers terminate atomically. |
| I6-T-008 Immediate activation | 014 | Active work interrupts/checkpoints and never replays. |
| I6-T-009 Update/rollback | 012, 015 | Update invalidates old approval; retained exact revision rolls back through pending state. |
| I6-T-010 Trust disclosure | 017 | Approval/enablement surfaces show Worker-level authority warning. |
| I6-T-011 Restart/Doctor | 019, 020 | No eager audit/activation/code load; hashes and pending state inspect locally. |
| I6-T-012 Migration | 009-016 | Records migrate atomically and cannot manufacture approval evidence. |

## Implementation Order

1. Define artifact identity, inspection, approval, and global revision contracts plus malicious fixtures.
2. Implement non-executing stage copy and deterministic closure inspection.
3. Implement isolated Audit using R0/R1 and exclusion tests.
4. Implement exact User approval and immutable approved storage.
5. Implement separate enablement, pending revisions, idle/immediate activation, and Worker changeover.
6. Add update, invalidation, rollback, UI/Doctor, migration, restart, and full E2E.

## Definition Of Done And Decision Gate

All requirements pass, including malicious lifecycle, identity-change, audit-isolation, and global revision tests. Stop if any staged/reviewing code enters Pi discovery, if approval can be inferred, or if enabled sets can differ across live Workers outside the explicit atomic changeover window.
