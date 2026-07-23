# I3 Skill Creator Executable Specification

Date: 2026-07-22  
Status: Approved for implementation  
Parent: `2026-07-22-integration-slice-spec-index.md`  
Blocked by: I1 complete and I2 compatibility lessons recorded

## Outcome

An explicitly invoked, complete compatible Claude Code or Codex Skill Creator package can create or update a staged Skill inside the VC Agent Skills Directory. The User reviews destination, dependencies, content, and diff before the package enters normal I1 inspection; it never activates automatically.

## Non-goals

- No vc-agent-specific Skill authoring engine, autonomous Skill creation, marketplace publishing, direct external destination, or automatic dependency installation.
- No Extension generation/admission and no authority to approve or enable itself.

## Governing Decisions

ADR 0025, 0027, 0028, 0042, 0057, and I1/I2.

## Deep Module And Interface

`SkillCreationWorkflow` hides reused-package invocation, staging, diff, review, and handoff to I1.

```ts
interface SkillCreationWorkflow {
  createDraft(request: CreateSkillDraftRequest): Promise<SkillDraft>;
  updateDraft(request: UpdateSkillDraftRequest): Promise<SkillDraft>;
  review(draftId: string): Promise<SkillDraftReview>;
  accept(draftId: string): Promise<SkillImportResult>;
  discard(draftId: string): Promise<void>;
}
```

`accept` does not activate. It transfers the staged package to I1 as a new import/revision and returns I1 compatibility state.

## Required Behavior

| Requirement | Behavior |
| --- | --- |
| I3-REQ-001 | Workflow starts only from explicit User intent naming create/update Skill or an explicit Skill Creator action. |
| I3-REQ-002 | The reused complete package, referenced scripts/resources/metadata/license, and approved overlay MUST be inventoried and activated through I1. |
| I3-REQ-003 | Creator execution MUST run as a bounded Isolated Job with declared input, app-owned staging destination, timeout, cancellation, and sanitized logs. |
| I3-REQ-004 | Output MUST remain under `<app-data>/skills/jobs/<job-id>` until review and MUST NOT write directly into active packages or external roots. |
| I3-REQ-005 | Review MUST show package destination, full file inventory, metadata, dependencies, executable entry points, content preview, and exact create/update diff. |
| I3-REQ-006 | Standard Access requires explicit final write approval; Full Access may suppress the tool prompt but MUST retain a visible review record and explicit workflow intent. |
| I3-REQ-007 | Accepted drafts MUST pass ordinary I1 path, compatibility, dependency, hash, overlay, and activation checks. |
| I3-REQ-008 | A failed update MUST leave the prior active revision unchanged and preserve a bounded reviewable draft when safe. |
| I3-REQ-009 | Skill Creator receives no cognitive-state write, Extension approval/enablement, Protected Credential, arbitrary Project-root, or automatic activation capability. |
| I3-REQ-010 | Restart MUST not continue a Creator job or accept a draft automatically; completed drafts remain reviewable until retention expiry. |

## State Machine

```text
requested -> planned -> running -> draft_ready -> reviewed
-> accepted_into_i1 | discarded
running -> failed | cancelled | timed_out
draft_ready/reviewed -> stale (target revision changed)
```

Updating an active Skill uses optimistic target revision/hash validation. A stale draft must be regenerated or explicitly rebased by a later designed action; it cannot overwrite a changed active revision.

## UI And Diagnostics

- Entry points: explicit conversation intent and Skills → Create/Update Skill.
- The review surface separates Creator output from I1 compatibility findings and activation state.
- Failure codes: `SKILL_CREATOR_UNAVAILABLE`, `SKILL_CREATOR_JOB_FAILED`, `SKILL_CREATOR_RESULT_INVALID`, `SKILL_DRAFT_PATH_ESCAPE`, `SKILL_DRAFT_STALE`, and `SKILL_CREATOR_CAPABILITY_REJECTED`.
- Environment Doctor reports Creator package/dependencies without executing it.

## Test Traceability

| Test | Requirements | Assertion |
| --- | --- | --- |
| I3-T-001 Explicit launch | 001 | Ordinary conversation success never invokes Creator; explicit intent does. |
| I3-T-002 Complete package | 002, 003 | Reused fixture scripts/resources run in isolated job. |
| I3-T-003 Create review | 004-007 | Draft stays staged, review is complete, acceptance enters I1 disabled. |
| I3-T-004 Update diff | 005, 008 | Exact diff shown; failed/stale update preserves active revision. |
| I3-T-005 Authority exclusion | 009 | Forbidden paths/capabilities/credentials are absent or rejected. |
| I3-T-006 Restart/cancel | 003, 010 | Process tree ends; draft persists only when complete; no auto continuation. |

## Implementation Order

1. Import and validate the chosen complete Creator package through I1.
2. Define draft/job/result contracts and fixture package.
3. Implement isolated create/update execution and staging containment.
4. Implement diff/review/accept/discard and I1 handoff.
5. Add authority, failure, restart, retention, and E2E tests.

## Definition Of Done And Decision Gate

The real reused Creator package produces at least one staged Skill that passes I1 review but remains disabled. Stop if compatibility would require embedding Creator logic into vc-agent or granting it direct active-directory, Extension, credential, or cognitive authority.
