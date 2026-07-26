# I2 Claude Code Office Skills Executable Specification

Date: 2026-07-22  
Status: Approved for implementation  
Parent: `2026-07-22-integration-slice-spec-index.md`  
Blocked by: I1 complete

## Outcome

The sole User can import and directly invoke complete User-supplied Claude Code `docx`, `pptx`, `xlsx`, and `pdf` Skills. Creation writes a new registered Output; editing writes a reviewed copy and change summary first; replacing an Original Source remains a separate explicit action.

## Non-goals

- No vc-agent-owned parallel Office engine, LibreOffice provider/fallback, third-party Skill redistribution, installer bundling, or automatic dependency installation.
- No silent source replacement, format conversion promise, live Microsoft Office control surface, or Office-specific Memory path.
- No guarantee that every package version is compatible; unavailable state is a valid result.

## Governing Decisions

ADR 0025, 0028, 0034, 0036, 0041, 0042, 0048, 0057, 0060, and I1.

## Supported User Flows

### Create

```text
User requests document -> Host detects Output Intent -> relevant Office Skill activated
-> Skill plan declares inputs/outputs/dependencies -> Isolated Job runs in staging
-> Host validates media type, path, size, hash, and optional render
-> atomic commit to Output Location -> register provenance -> show Output
```

### Edit

```text
User selects Source -> Host snapshots source identity -> Skill writes staged edited copy
-> validate copy -> produce change summary/diff and optional preview
-> User accepts copy as new Output
-> optional separate Replace Original action -> authorization/collision check -> atomic replace
```

## Deep Modules And Interfaces

### `OfficeSkillOrchestrator`

```ts
interface OfficeSkillOrchestrator {
  prepare(request: OfficeTaskRequest): Promise<OfficeExecutionPlan>;
  execute(planId: string): Promise<OfficeStagedResult>;
  commit(resultId: string): Promise<ProjectOutputArtifact>;
  replaceOriginal(request: OriginalReplacementRequest): Promise<ReplacementResult>;
}
```

The module owns Skill selection, minimum capability projection, job manifest creation, staged validation, provenance, edited-copy policy, change-summary association, collision inspection, and Unknown Tool Outcome reconciliation. It does not implement document generation algorithms.

### Isolated Office job adapter

The adapter executes only the imported Skill-declared entry point with explicit input paths, staging output paths, environment allowlist, timeout, output byte limit, and process-tree cancellation. It receives no Project-root wildcard authority and no raw credential store.

## Required Behavior

| Requirement | Behavior |
| --- | --- |
| I2-REQ-001 | Office tasks MUST execute the imported complete Claude Code Skill revision selected through I1; repository and installer contain no copied package. |
| I2-REQ-002 | Only the relevant format Skill and minimum controlled capabilities enter the Turn resource snapshot. |
| I2-REQ-003 | Each job manifest MUST declare Skill/revision, inputs, exact staged outputs, executable dependency, timeout, limits, cancellation token, and sanitized log destination. |
| I2-REQ-004 | Creation MUST commit only validated `.docx`, `.pptx`, `.xlsx`, or `.pdf` under the determined Output Location. |
| I2-REQ-005 | Registered provenance MUST include producing Skill/revision, Thread, Turn, Profile, source references, job id, warnings, media type, hash, and creation time. |
| I2-REQ-006 | Editing MUST never write the Source path during generation; it first produces a separate edited copy and change summary/diff. |
| I2-REQ-007 | Original replacement is a second action. Standard Access requires a scoped confirmation; Full Access may execute without a prompt but MUST keep visible action/provenance. |
| I2-REQ-008 | Replacement MUST revalidate Source identity and target collision immediately before atomic commit. Changed targets require the existing collision policy. |
| I2-REQ-009 | Dispatched replacement without confirmed completion becomes Unknown Tool Outcome; retry requires inspection or duplicate-risk acknowledgement. |
| I2-REQ-010 | Missing Microsoft Office desktop/COM, Skill failure, render failure, timeout, cancellation, or malformed result MUST preserve Source and every validated staged/committed copy. |
| I2-REQ-011 | The Host MUST NOT attempt LibreOffice, another Skill, another package revision, another Provider, or format fallback automatically. |
| I2-REQ-012 | Environment Doctor MUST report integrity and dependencies per imported format Skill without running document generation or starting Pi. |
| I2-REQ-013 | Temporary job inputs/results/logs MUST retire after durable commit or bounded failure retention; secrets and full Project paths are sanitized from persistent diagnostics. |
| I2-REQ-014 | Office Outputs MUST remain ordinary Project Outputs and MUST NOT directly update Context, Project Memory, Long-term Memory, Reflection, or Dream. |

## State Model

```text
planned -> awaiting_authorization? -> admitted -> running
-> staged -> validating -> validated -> committed
running/validating -> failed | cancelled | timed_out
replacement_requested -> awaiting_confirmation? -> revalidating -> replacing
-> replaced | collision | unknown_outcome | failed
```

Restart performs inspection only. `running` becomes interrupted; `replacing` without terminal confirmation becomes `unknown_outcome`; no job or replacement restarts automatically.

## Output And Change Records

Persist generic Office task/job records plus relationships in Project Output Registry:

- `office_task_id`, kind, format, Skill revision, Thread/Turn/Profile.
- Source reference and pre-edit hash for edit tasks.
- Edited copy Output id, change-summary artifact id, optional preview artifact ids.
- Replacement proposal, confirmation, precommit target hash, outcome, and recovery inspection.

Change summaries are review aids, not proof of semantic equivalence. Render previews are derivative artifacts and failure to render does not invalidate a structurally validated Office file unless the selected Skill declares rendering mandatory.

## UI

- Conversation shows Skill activation, dependency status, job stages, warnings, Output link, and producing revision.
- Edited copies are clearly labeled against their Source with Review changes and Replace original actions.
- Replacement confirmation names exact Source and edited copy. Full Access still displays completed replacement.
- Environment Doctor has one row per imported Office Skill and dependency, including optional Microsoft Office/COM.

## Failure Codes

`OFFICE_SKILL_UNAVAILABLE`, `OFFICE_DEPENDENCY_MISSING`, `OFFICE_JOB_REJECTED`, `OFFICE_JOB_TIMEOUT`, `OFFICE_JOB_CANCELLED`, `OFFICE_RESULT_MISSING`, `OFFICE_RESULT_INVALID`, `OFFICE_RENDER_FAILED`, `OFFICE_SOURCE_CHANGED`, `OFFICE_TARGET_COLLISION`, `OFFICE_REPLACEMENT_FAILED`, and `UNKNOWN_TOOL_OUTCOME`.

## Test Traceability

| Test | Requirements | Assertion |
| --- | --- | --- |
| I2-T-001 Package provenance | 001, 002, 005 | Fixture complete package executes; only relevant Skill appears; repo has no package copy. |
| I2-T-002 Create document | 003-005 | Generated fixture validates, commits under Output Location, and records provenance. |
| I2-T-003 Edited copy | 006, 010 | Source bytes unchanged; copy, diff, and optional preview are reviewable. |
| I2-T-004 Standard replacement | 007, 008 | Denial preserves Source; approval revalidates and atomically replaces. |
| I2-T-005 Full replacement | 007, 008 | No tool prompt, but action and provenance remain visible. |
| I2-T-006 Unknown outcome | 009 | Injected lost acknowledgement blocks blind retry and supports inspection. |
| I2-T-007 Unavailable/failure | 010-012 | Missing dependency/render/job failure has no fallback and preserves results. |
| I2-T-008 Cancellation/restart | 003, 010, 013 | Process tree exits; no auto replay; temporary payload policy holds. |
| I2-T-009 Cognitive exclusion | 014 | No cognitive record changes after creation/edit/replacement. |
| I2-T-010 Four formats | 001-005 | Contract fixture covers docx, pptx, xlsx, and pdf; at least one real supplied Skill completes before G3. |

## Implementation Order

1. Build format-neutral Office task/result contracts and fixture Skills.
2. Implement Isolated Job manifest adapter and staged output validator.
3. Implement create flow and generic Output provenance.
4. Implement edited-copy, change-summary, preview, replacement, and Unknown Outcome flow.
5. Add Environment Doctor, retention, migration, and four-format contract tests.
6. Validate at least one actual User-supplied Claude Code Office Skill without committing its package.

## Definition Of Done And Decision Gate

All requirements pass, including source-preservation and no-fallback tests. Do not claim I2 complete using only a vc-agent-authored fake engine: fixtures verify the interface, but at least one complete User-supplied Claude Code Office Skill must execute an end-to-end document task in the Personal Build.
