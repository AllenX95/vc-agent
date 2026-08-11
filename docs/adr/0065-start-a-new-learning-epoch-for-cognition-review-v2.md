# Start A New Learning Epoch For Cognition Review V2

Status: Accepted

Date: 2026-08-11

## Context

The current Dream, Reflection, Project Memory, Long-term Memory, Judgment,
provenance, and cognitive-history state was produced by superseded authority
paths. The sole User has accepted discarding that personal-cognition state;
there is no user value in interpreting it into the replacement workflow.
Ordinary conversations, Project materials, Project Context, and non-cognitive
Outputs remain valuable and must not be deleted as part of the cutover.

The [Cognition Review Redesign Specification](../superpowers/specs/2026-08-11-cognition-review-redesign-spec.md)
requires an explicit epoch boundary so legacy files and rows cannot be loaded
by the new implementation.

## Decision

Production cutover starts one new Learning Epoch. The Host records a
`learningEpochStartedAt` only after the legacy cognition reset has activated
successfully. Completed eligible exchanges before that timestamp remain in
ordinary Thread history but are excluded from automatic eligibility. An
explicit import action may create new post-epoch references in a later release;
this cutover does not import or reinterpret old cognition.

The replacement uses a separate app-data root:

```text
<app-data>/cognition-v2/
├── epoch.json
├── automatic-review-policy.json
├── source-index.jsonl
├── reviews/
├── reflections/
├── batches/
├── patches/
└── work/
```

`source-index.jsonl` is content-free. Raw exchange bodies remain in Thread
Trajectory and are resolved only when a review chunk starts. State schema 18
removes `reflection_runs` and legacy cognition task assignments, accepts only
`reflection` and `memory_review` assignments, and records a cutover marker with
`pending_reset`, `active`, and `failed_reset` states. Old Reflection rows are
not copied into v2 records.

The reset removes from active product state:

- Project Memory files and indexes;
- Long-term Memory, Condensation Archive, Cognitive Evolution History,
  provenance, indexes, maintenance state, and prepared patches;
- Short-term Memory Candidates;
- Dream schedule, batches, extraction/synthesis work, carryover, and patches;
- Reflection runs, workflow sessions, outcomes, and drafts;
- Judgment Records produced by the old mechanism; and
- old `dream`, `independent_evidence`, and `memory_aware_reflection` task
  assignments.

The reset preserves ordinary Thread Trajectory and Physical Model Context
policy; Projects and Project Identity; Materials, Canonical Parse, and Project
Context; non-cognitive Outputs; model profiles and credentials; System Prompt
revisions; and execution history unrelated to Dream or Reflection.

Reset activation is deterministic and Host-only:

1. Stage and validate the SQLite v18 migration with the existing rollback
   bundle.
2. Load the Project and Thread inventory needed to resolve cognition targets.
3. Resolve every legacy cognition path to an absolute path and verify that it
   is contained by the explicit app-data root, known Project roots, or known
   Unscoped Output locations.
4. Prepare one manifest listing exact targets and intended empty or
   replacement content.
5. Activate the SQLite migration and file reset through a recoverable
   transaction protocol.
6. Write `epoch.json` with `learningEpochStartedAt` only after every legacy
   cognition target is inactive.
7. Mark the cutover active.
8. On failure, restore the prior SQLite bundle when activation began and enter
   Read-only Recovery; never start a Worker, Pi runtime, or Provider call.

The reset claims logical deletion, not secure physical erasure.

## Consequences

- v2 cannot accidentally read or merge superseded personal-cognition state.
- Users retain ordinary conversation history and Project work while beginning
  durable learning from a clear boundary.
- Backups and migration code must understand the v2 root and epoch marker;
  old cognition is not a restore source for v2.
- The cutover needs path-containment checks, a rollback manifest, and explicit
  Read-only Recovery handling, increasing implementation work but preventing
  partial schema/file activation.
- Sources before the epoch are not silently treated as current learning, and
  physical erasure is not promised.

## Supersedes

This ADR supersedes the legacy-cognition continuity and migration requirements
in `OPT-REQ-021` through `OPT-REQ-024` of the 2026-08-01 optimization
specification, as well as any requirement to migrate or reinterpret old Dream,
Reflection, Judgment, Memory, provenance, or cognitive-history state. ADR-0064
governs the replacement authority and review Interface.

ADR-0030, *Retain Thread Trajectory Until Explicit Deletion*, remains governing
for ordinary trajectory retention and deletion cascades. ADR-0049, *Back Up
Personal Cognition Without Project State*, remains governing for portable
backup boundaries but applies to v2 state after cutover. ADR-0050, *Use
Deterministic Atomic State Schema Migrations*, remains governing for rollback,
forward-version checks, and Read-only Recovery; this ADR adds the one-time
intentional cognition reset at the v2 boundary.
