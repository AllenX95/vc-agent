# Cognition Review Redesign Specification

Date: 2026-08-11  
Status: Approved for implementation  
Scope: Investment Reflection, Memory Review, learning eligibility, coverage, proposal review, cognitive commit, model assignments, and one-time personal-cognition reset

## 1. Outcome

VC Desktop Agent will replace the current Dream and Reflection learning machinery with two simple user-facing entry points over one deep cognition-review Module:

```text
Investment Reflection ─┐
                       ├─> Cognition Review -> Review Bundle -> Commit
Memory Review ─────────┘
```

The redesign has four outcomes:

1. Every eligible source before a committed cutoff is accounted for; the current per-scope twelve-exchange truncation can no longer silently lose learning input.
2. Investment Reflection remains an evidence-oriented, interactive decision review, while Memory Review becomes the batch path for consolidating prior work.
3. Both paths use one proposal, review, staleness, patch, provenance, and atomic-commit implementation behind a small Interface.
4. Automatic work may prepare a Review Bundle but can never change active Memory or confirm a Judgment Record without one explicit User commit.

The normal product experience is:

```text
Reflection: Start -> Discuss -> Review -> Confirm
Memory Review: Prepare -> Review -> Commit
```

`Dream` remains an internal mechanism name or advanced command. The primary UI calls the user-facing batch workflow **Memory Review**.

## 2. Problem Statement

### 2.1 Silent coverage loss

The current Dream batch freezes every eligible exchange at or before one cutoff, but `buildDreamScopeExtractionContext` sends at most twelve trajectory items from a scope to extraction. The committed cutoff can later advance past exchanges that were frozen into the batch but never inspected, represented by a proposal, or retained as carryover.

This is a correctness defect, not merely a context-budget trade-off. Raising twelve to another constant would move the defect rather than remove it.

### 2.2 Workflow complexity leaks through the Interface

Current callers and UI understand scope extraction, scope review, synthesis, proposal review, patch preparation, separate Judgment confirmation, separate Learning Proposal preparation, Dream-specific commit, and several recovery states. The implementation preserves useful safety facts, but the external Interface exposes nearly the same complexity as the implementation.

### 2.3 Reflection and Dream duplicate cognitive authority transitions

Investment Reflection and Dream currently maintain separate proposal stores, status transitions, commit paths, staleness handling, UI controls, and IPC commands. They should keep different analytical behavior but should not maintain two Memory-changing systems.

### 2.4 Scheduling is time-oriented rather than signal-oriented

The current Dream Due Check primarily reflects a review interval. A useful personal learning loop should combine explicit User initiation with deterministic signal density and a maximum-age fallback, while preserving model/profile disclosure and preventing automatic cognitive writes.

### 2.5 The current state is not worth migrating

The sole User has explicitly accepted deleting the current Project Memory, Long-term Memory, Dream, Reflection, Judgment, provenance, and cognitive-history data. Preserving old workflow state would add compatibility code without meaningful user value. Ordinary Thread Trajectory and Project materials remain valuable and must not be deleted.

## 3. Supersession And Governing Decisions

This specification supersedes the following parts of `2026-08-01-vc-agent-optimization-and-simplification-spec.md`:

- the Reflection legacy-state migration requirements `OPT-REQ-021` through `OPT-REQ-024`;
- the Dream workflow and explicit-launch requirements `OPT-REQ-025` through `OPT-REQ-032`;
- the shallow `MemoryReviewService` Interface in `OPT-REQ-033` through `OPT-REQ-038`, while retaining the distinction between Project Memory, Long-term Memory, active Memory, and history.

Before production implementation, new ADRs MUST explicitly amend or supersede the conflicting parts of:

| Decision | Required change |
| --- | --- |
| ADR-0003 Cross-project Two-stage Dream | Keep scope isolation and de-identified global synthesis, but remove mandatory per-scope User review and treat extraction chunks as internal facts. |
| ADR-0011 Staged Context Isolation For Reflection | Keep isolated evidence and memory-aware contexts; one Reflection launch authorizes automatic transition between them. |
| ADR-0012 Reflection Direct Long-term Memory | Replace its separate Reflection Memory path with the shared Cognition Review commit path. |
| ADR-0025 User Intent Gate | Permit standing opt-in to run non-authoritative automatic Memory Review preparation; final cognitive commit remains explicit. |
| ADR-0029 Recover Missed Memory Signals | Preserve eligible-source recovery, but require deterministic source disposition rather than best-effort scope sampling. |
| ADR-0031 One Dream Cutoff With Carryover | Retain one cutoff, make the Coverage Ledger authoritative, and advance cutoff only through committed review. |
| ADR-0032 No Per-turn Classifier | Preserve the decision not to add a per-turn model call; deterministic capture remains sufficient. |
| ADR-0042 Preserve Cognitive Review | Narrow the mandatory explicit actions to Reflection launch and final cognitive commit; automatic non-authoritative preparation is allowed after standing opt-in. |
| ADR-0053 De-identified Cross-project Learning | Preserve without change. |
| ADR-0054 Lazy Agent Activation | Startup may perform a model-free due check only; automatic model work begins after submitted work completes and the execution scheduler is idle. |

Until those ADRs are accepted, this specification is the approved implementation target but production cutover MUST NOT occur.

## 4. Non-goals

- No automatic write to active Project Memory or Long-term Memory.
- No automatic confirmation of a Judgment Record.
- No model-backed checkpoint writer after every Turn.
- No migration or reinterpretation of old cognition data.
- No deletion of ordinary Thread Trajectory, Project materials, Project Context, ordinary Outputs, or model credentials.
- No merging of Project Memory and Long-term Memory into one authoritative store.
- No use of arbitrary assistant output, source materials, web content, tool output, Independent Evidence transcripts, or Sub-Agent output as personal learning unless the User later adopts, corrects, or confirms it in an eligible exchange.
- No workflow/Skill/Playbook generation in this redesign. Repeated procedures may be proposed to a later, separate Distill/Playbook workflow.
- No bundle-to-bundle automatic merge.
- No stage-specific model settings in the first release.

## 5. Domain Language

The following terms are authoritative and MUST be added to `CONTEXT.md` during implementation.

### Learning Epoch

The time from which completed eligible exchanges may enter the new learning system. Sources before `learningEpochStartedAt` remain ordinary Thread history but are excluded unless the User explicitly imports them later.

### Eligible Learning Source

A stable reference to a completed, user-attributable exchange or confirmed cognitive artifact that may be examined for personal learning. Eligibility permits analysis; it does not assert that the source contains useful learning.

### Coverage Ledger

The authoritative set of eligible source references frozen into one Memory Review Batch, together with exactly one current disposition for each reference.

### Extraction Chunk

A bounded subset of one isolated Project or Unscoped scope, formed by token/character budget rather than a fixed total-item cutoff. Every source in the Coverage Ledger belongs to exactly one extraction chunk in the batch.

### Source Disposition

The recorded outcome for one eligible source:

```ts
type SourceDispositionStatus =
  | "pending"
  | "processing"
  | "no_signal"
  | "represented"
  | "carried_over";
```

- `no_signal`: inspected and produced no durable learning candidate.
- `represented`: inspected and linked to at least one proposal in the batch.
- `carried_over`: explicitly unresolved and retained for a future batch.

### Memory Review

The manual or standing-opt-in batch workflow that examines eligible sources, consolidates learning proposals, and prepares one Review Bundle without changing active Memory.

### Review Bundle

The sole user-reviewable cognition-change package. It contains proposals, User decisions, source coverage, dependency snapshots, and a patch preview. A Reflection Review Bundle additionally contains one Judgment Record draft.

### Cognition Review

The shared authority transition that converts either a Reflection result or a Memory Review synthesis into a Review Bundle and, after explicit User confirmation, atomically commits its adopted changes.

## 6. Product Responsibilities

### 6.1 Investment Reflection

Investment Reflection answers:

> Is my current investment judgment well-supported, and what would change it?

It is explicitly launched by the User. One launch authorizes:

1. an isolated Independent Evidence Pass without personal Memory;
2. automatic transition to a new isolated Memory-aware Critical Dialogue context;
3. interactive discussion with bounded Memory recall and evidence drilldown;
4. preparation of one Reflection Review Bundle when the User chooses to finish.

Every completed Reflection produces exactly one Judgment Record draft. Its result may express:

- a changed judgment;
- an unchanged judgment with stronger or narrower rationale;
- insufficient evidence to form a judgment.

Learning Proposals are optional and may be empty. Reflection is valuable even when it writes no Memory.

The User has two terminal actions:

- **Confirm Reflection**: atomically save the Judgment Record and all adopted learning changes.
- **Discard Reflection**: create no authoritative cognitive artifact.

### 6.2 Memory Review

Memory Review answers:

> What reusable learning, conflicts, or obsolete beliefs are present in completed work since the last committed review?

It may be initiated manually or prepared automatically after standing opt-in. Its implementation:

1. freezes one cutoff and eligible-source ledger;
2. partitions each Project and Unscoped scope into bounded extraction chunks;
3. runs isolated extraction over every chunk;
4. rejects extraction output that omits or duplicates a source disposition;
5. carries failed or intentionally deferred sources explicitly;
6. performs one synthesis over bounded, de-identified scope results and active Memory cards;
7. creates one Review Bundle.

Scope extraction, chunk progress, and synthesis are inspectable diagnostics, not primary User decisions.

### 6.3 Runtime recall

Runtime Memory recall remains a separate responsibility:

- select relevant Memory cards;
- validate source availability and content-version keys when applicable;
- enforce Project/Long-term scope policy;
- inject within an explicit budget;
- never modify Memory.

This redesign does not introduce a second recall engine.

## 7. Eligible Learning Sources

The eligible set includes:

1. every completed ordinary user-facing exchange after the Learning Epoch;
2. explicit remember requests and deterministic strong User judgment signals;
3. confirmed Judgment Records created by the new mechanism;
4. Reflection exchanges containing persisted User adoption, correction, or confirmation;
5. explicit Memory actions.

The eligible set excludes:

1. failed, interrupted, or incomplete Turns;
2. Independent Evidence Pass contexts;
3. Memory Review extraction and synthesis sessions;
4. Sub-Agent messages and tool events;
5. source materials, OCR, webpages, and tool output;
6. unadopted assistant claims;
7. sources before `learningEpochStartedAt` unless explicitly imported.

Thread deletion removes its uncommitted eligible source references and source bodies from future Memory Review. It does not delete already committed Memory; committed Memory instead records source availability according to existing provenance policy.

## 8. Strict Coverage Invariant

For a batch `B` with frozen source set `E(B)`:

```text
E(B) = N(B) union R(B) union C(B)
N(B), R(B), and C(B) are pairwise disjoint
```

where:

- `N(B)` contains `no_signal` sources;
- `R(B)` contains `represented` sources with at least one valid proposal reference;
- `C(B)` contains explicit `carried_over` sources.

Additional invariants:

1. Every source in `E(B)` belongs to exactly one extraction chunk.
2. A completed chunk contains exactly one terminal extraction result for each member source.
3. `represented` requires at least one proposal ID that exists in the batch.
4. A source may be represented by multiple proposals, but duplicate proposal IDs are rejected.
5. Synthesis cannot start while any source is `pending` or `processing`.
6. A Review Bundle cannot be prepared while coverage is incomplete.
7. Discarding a batch never advances the committed cutoff.
8. Preparing or reviewing a bundle never advances the committed cutoff.
9. Only a successful Cognition Review commit may advance the cutoff.
10. Sources completed after the frozen cutoff belong to a later batch and do not stale the current batch.

The implementation MUST include a property test with at least thirteen exchanges in one scope and tests with multiple chunks, partial failure, retry, carryover, deletion, and restart.

## 9. Chunking And Context Budget

Chunk construction is deterministic and versioned. It MUST use the shared `ContextBudgetService` rather than an item-count constant.

Each chunk budget includes:

- stage instructions and output schema;
- bounded source exchange bodies;
- Project Memory cards for Project scopes only;
- reserved output tokens;
- a safety margin.

Chunk ordering is stable by `completedAt` then `sourceReference`. If one source body exceeds the available budget, the source is represented by a bounded excerpt plus its stable reference; the source is not silently dropped. The extraction result must still disposition that reference.

The first release does not add a model-backed checkpoint writer. Thread Trajectory is the source of truth, Thread Compaction serves only current-Thread continuity, and a content-free eligibility index supports cheap scheduling.

## 10. Review Bundle And User Decisions

```ts
type ProposalDecision = "adopt" | "defer" | "reject";

interface ReviewBundle {
  readonly id: string;
  readonly kind: "reflection" | "memory_review";
  readonly status:
    | "analysis_completed"
    | "waiting_for_review"
    | "reviewing"
    | "prepared"
    | "stale"
    | "committed"
    | "discarded";
  readonly judgment?: JudgmentRecordDraft;
  readonly proposals: readonly LearningProposal[];
  readonly decisions: readonly ProposalDecisionRecord[];
  readonly coverage?: CoverageSummary;
  readonly dependencies: readonly CognitionDependency[];
  readonly patch?: CognitionPatchPreview;
}
```

User decisions have the following meaning:

- **Adopt**: accept the proposed destination and Memory Evolution action. Advanced details may allow changing supported destination/action fields before patch preparation.
- **Defer**: do not write the proposal; retain its supporting sources as explicit carryover.
- **Reject**: do not write the proposal and treat its supporting sources as finally reviewed for this epoch/batch. Rejecting a proposal never deletes Thread Trajectory.

Memory Evolution actions such as Add, Reinforce, Narrow, Revise, Contradict, and Merge/Condense remain inspectable implementation facts. The ordinary User interface does not require the User to select among them.

All proposal decisions must be terminal before patch preparation. One patch contains every adopted Project Memory and Long-term Memory change plus, for Reflection, the Judgment Record file addition.

## 11. Deep Cognition Review Module

The external seam is one deep Module:

```ts
interface CognitionReviewModule {
  prepare(input: ReflectionReviewInput | MemoryReviewInput): ReviewBundle;
  decide(reviewId: string, decisions: readonly ProposalDecisionInput[]): ReviewBundle;
  commit(reviewId: string): CognitionCommitResult;
  discard(reviewId: string): void;
}
```

Its implementation owns:

- Review Bundle persistence and status projection;
- proposal normalization and decision interpretation;
- Project Memory versus Long-term Memory routing;
- Memory Evolution action validation;
- source disposition and carryover;
- dependency/content-version capture and revalidation;
- patch preparation and base-hash verification;
- Judgment Record rendering;
- provenance and cognitive history;
- journaled, logically atomic multi-file commit across cognition roots;
- committed cutoff advancement;
- staleness invalidation.

The Module accepts dependencies rather than creating stores. Project Memory, Long-term Memory, Thread Trajectory, and local file transaction implementations are internal adapters. Production uses filesystem/SQLite adapters; tests use temporary filesystem and in-memory adapters.

The external Interface does not expose extraction scopes, chunk methods, synthesis transitions, Memory Evolution store methods, or separate Judgment/Memory commit operations.

Deleting this Module would force proposal review, dependency validation, patch creation, atomic commit, source disposition, and cutoff behavior back into Reflection, Memory Review, IPC handlers, and UI callers. It therefore passes the deletion test.

The existing shallow `MemoryReviewService` is removed after replacement tests cover the new Interface.

## 12. Atomic Commit And Staleness

One commit is authoritative. For a Reflection bundle it atomically:

1. writes the Judgment Record;
2. writes all adopted Project Memory and Long-term Memory changes;
3. records provenance/evolution history;
4. records deferred and rejected proposal outcomes;
5. marks the Reflection completed;
6. commits the Review Bundle.

For a Memory Review bundle it atomically:

1. writes all adopted Memory changes;
2. records provenance/evolution history;
3. persists carryover and source disposition;
4. advances the committed cutoff;
5. commits the Review Bundle.

Immediately before commit, the Host revalidates:

- exact Material versions referenced by a Reflection;
- recalled/targeted Memory entry versions;
- Project Memory and Long-term Memory file hashes;
- Review Bundle identity and decisions;
- Judgment output destination;
- source availability needed by the patch.

Any relevant change marks the bundle stale and commits nothing. No operation may leave a confirmed Judgment Record paired with an uncommitted adopted Memory proposal.

Because Project Memory and user-level cognition may reside on different filesystem volumes, this guarantee does not assume one cross-volume filesystem rename. The Host uses a durable transaction manifest with before-images, staged after-images, base hashes, and an explicit commit point. Readers expose either the complete before-state or the complete after-state. Startup recovery deterministically rolls back a transaction without a durable commit point and completes publication for one with a durable commit point before cognition becomes writable.

## 13. Review Concurrency

Analysis may run concurrently within the existing execution scheduler, but the installation has one global cognition-review lease:

- at most one bundle may be `reviewing` or `prepared`;
- additional completed analyses remain `analysis_completed`;
- after the active bundle is committed or discarded, the next analysis is revalidated and promoted to `waiting_for_review`;
- automatic Memory Review never preempts an active Reflection;
- bundles are never merged automatically.

This lease is operational state, not a tool permission or Access Mode.

## 14. Manual And Automatic Memory Review

Manual Memory Review is always available when the Memory Review Profile is configured and no conflicting batch is active.

Automatic preparation requires a standing User opt-in:

```ts
interface AutoMemoryReviewPolicy {
  readonly enabled: boolean;
  readonly profileId: string;
  readonly minEligibleExchangeCount: number;
  readonly maxIntervalDays: number;
  readonly maxInputTokensPerRun: number;
}
```

The shipped defaults SHOULD be conservative:

- `enabled = false`;
- `minEligibleExchangeCount = 20`;
- `maxIntervalDays = 7`;
- no more than one automatically started batch per local day;
- input budget derived from the configured Profile and `ContextBudgetService`.

The model-free due check may run at startup, after trajectory changes, and after settings changes. It may not start a Provider call during application startup.

Automatic model work may begin only when:

```text
policy enabled
AND Memory Review Profile available
AND no Memory Review batch is active
AND no cognition-review bundle is under review
AND execution capacity is available
AND at least one User-submitted model-backed Turn has completed in this app run
AND (
  an explicit candidate exists
  OR eligible source count reaches the threshold
  OR the maximum interval elapsed
)
```

Automatic execution is visible, cancellable, and non-authoritative. Failure leaves sources pending, advances no cutoff, and requires manual retry or a later separately admitted run; it does not loop automatically.

## 15. Model Profiles And LLM Settings

LLM Settings exposes two task assignments:

```text
Reflection Profile
Memory Review Profile
```

Contract task types become:

```ts
type CognitionTaskModelType = "reflection" | "memory_review";
```

The old `dream`, `independent_evidence`, and `memory_aware_reflection` assignments are removed during the reset.

The Reflection Profile is used for both isolated Reflection stages. The Memory Review Profile is used for chunk extraction and synthesis. Each run freezes the effective Profile and Workflow Prompt Snapshot. There is no fallback to the current Thread Profile, no automatic Provider switch, and no stage-level setting in the first release.

If an assignment is missing, the workflow remains local and idle and shows one configuration action. It does not infer a Profile.

## 16. Learning Epoch And Destructive Reset

The cutover creates a new `learningEpochStartedAt` and intentionally discards all prior personal-cognition data.

The reset removes from active product state:

- Project Memory files and indexes;
- Long-term Memory, condensation archive, cognitive evolution history, provenance, indexes, maintenance state, and prepared patches;
- Short-term Memory candidates;
- Dream schedule, batches, extraction/synthesis work state, carryover, and patches;
- Reflection runs, workflow sessions, outcomes, and drafts;
- confirmed Judgment Record files produced by the old mechanism;
- old cognition task assignments.

The reset preserves:

- ordinary Thread Trajectory and Physical Model Context policy;
- Projects, Project Identity, materials, Canonical Parse, Project Context, and non-cognitive Outputs;
- model profiles and credentials;
- System Prompt revisions;
- execution history unrelated to Dream/Reflection.

The reset is a deterministic Host-only operation. It calls no model and imports no old cognition. Sources completed before the epoch are excluded from automatic eligibility. A future explicit-import action may create new eligible references to selected old exchanges, but that action is outside this release.

Reset activation MUST resolve and validate every target path before deletion, use the existing state-migration rollback discipline for SQLite, and fail into Read-only Recovery without partially activating the new schema. Logical deletion is claimed; secure physical erasure is not.

## 17. Persistence And Restart

The new implementation persists:

- one Learning Epoch record;
- content-free eligible-source index;
- Memory Review Batch metadata;
- Coverage Ledger and extraction chunk states;
- bounded extraction results and proposals;
- Review Bundles and decisions;
- auto-review policy and scheduling metadata;
- cognition-review lease state;
- committed cutoff and carryover.

Raw eligible exchange bodies remain authoritative in Thread Trajectory and are resolved when a chunk starts. They are not duplicated permanently into the eligibility index.

On restart:

- no Provider call starts automatically;
- running extraction/synthesis becomes interrupted or failed with visible recovery;
- `reviewing`/`prepared` bundles remain reviewable only after deterministic revalidation;
- stale patches cannot commit;
- the cognition-review lease is reconstructed from persisted nonterminal bundles rather than treated as a live process lease.

## 18. User Interface

### Reflection

The Reflection workspace shows:

- objective and optional focus;
- progress: evidence analysis, critical dialogue, or review;
- Independent Assessment as inspectable evidence context;
- the interactive dialogue;
- one final Review Bundle with Judgment Record and optional learning proposals;
- one `Confirm Reflection` and one `Discard Reflection` terminal action.

It does not show a second `Start critical dialogue` gate or separate Judgment/Memory commit controls.

### Memory Review

The Memory settings area shows:

- pending eligible source count and oldest pending date;
- manual `Prepare Memory Review` action;
- automatic preparation policy;
- current preparation progress;
- one Review Bundle with Adopt/Defer/Reject decisions and final patch preview;
- one `Commit Memory Changes` action.

Scope chunks, attempts, cutoff, and carryover are available in diagnostics/details, not as the primary workflow.

### LLM Settings

Task Model Assignments show `Reflection Profile` and `Memory Review Profile`. Old stage-level assignments and per-launch profile selectors are removed.

## 19. IPC And Execution Surface

The Renderer-facing command surface SHOULD converge on intent-level commands:

```text
reflection.start
reflection.finish
reflection.discard
memory_review.prepare
memory_review.cancel
cognition_review.load
cognition_review.decide
cognition_review.commit
cognition_review.discard
memory_review.policy.set
```

Commands for individual extraction scopes, synthesis start, separate Judgment confirmation, Learning patch preparation, and Dream patch preparation/commit are removed after the new vertical slices are complete.

The Host owns automatic stage transitions. Model execution continues through the existing scheduler, Worker supervision, Prompt Snapshot, and failure-sanitization machinery.

## 20. Security And Privacy

- Automatic review opt-in discloses that eligible historical exchanges are sent to the selected Memory Review Provider.
- The effective Profile, Provider, input count, and approximate token budget are visible for each run.
- Credential values, protected secrets, raw Provider payloads, and unrelated Thread content never enter review metadata.
- Extraction receives only sources in its frozen chunk and scope-compatible Project Memory cards.
- Global synthesis receives bounded, de-identified extraction results and bounded active Long-term Memory cards, not combined raw Project trajectories.
- Project-specific facts cannot enter Long-term Memory without de-identification and reusable applicability.
- Unscoped sources cannot target Project Memory.
- Standard Access and Full Access never bypass final cognition commit.

## 21. Required Tests

### Contract and property tests

| ID | Scenario | Required result |
| --- | --- | --- |
| CR-T-001 | Thirteen eligible exchanges in one scope | Every source is assigned to a chunk and receives one disposition. |
| CR-T-002 | Multiple chunks and stable ordering | Repeated construction produces identical membership/order. |
| CR-T-003 | Missing extraction disposition | Chunk result is rejected. |
| CR-T-004 | Duplicate source disposition | Chunk result is rejected. |
| CR-T-005 | Represented source references missing proposal | Bundle preparation is rejected. |
| CR-T-006 | Failed chunk | Sources remain pending or become explicit carryover; cutoff does not advance. |
| CR-T-007 | Discarded batch | Cutoff does not advance. |
| CR-T-008 | All proposals rejected then committed | Coverage commits and cutoff advances without Memory write. |
| CR-T-009 | Source after cutoff | Source belongs only to the next batch. |
| CR-T-010 | Source before Learning Epoch | Source is ineligible. |

### Cognition Review tests

| ID | Scenario | Required result |
| --- | --- | --- |
| CR-T-011 | Reflection with no learning | Judgment Record commits successfully. |
| CR-T-012 | Reflection with adopted learning | Judgment and Memory change commit atomically. |
| CR-T-013 | Stale Memory target | Nothing commits; bundle becomes stale. |
| CR-T-014 | Judgment destination failure | Nothing commits. |
| CR-T-015 | Adopt/Defer/Reject mix | Patch, carryover, and final dispositions match decisions. |
| CR-T-016 | Two completed analyses | Only one bundle acquires the review lease. |
| CR-T-017 | Restart with prepared bundle | Revalidation is required; no model starts. |

### Automatic preparation tests

| ID | Scenario | Required result |
| --- | --- | --- |
| CR-T-018 | Policy disabled | No automatic model execution. |
| CR-T-019 | Profile missing | Configuration prompt only; no execution. |
| CR-T-020 | Threshold reached while busy | Work waits; it does not preempt active Reflection. |
| CR-T-021 | Maximum interval reached at startup | Due state is visible; no Provider call starts at startup. |
| CR-T-022 | Automatic extraction fails | No retry loop and no cutoff advancement. |

### Reset tests

| ID | Scenario | Required result |
| --- | --- | --- |
| CR-T-023 | Existing cognition files and state | All scoped cognition targets are logically deleted. |
| CR-T-024 | Existing Thread history and materials | Preserved byte-for-byte. |
| CR-T-025 | Reset failure before activation | Previous schema remains active or app enters Read-only Recovery; no partial new epoch. |
| CR-T-026 | New epoch after reset | Only post-epoch exchanges become eligible. |

## 22. Observability

Content-free local telemetry includes:

- eligible, processed, no-signal, represented, and carried-over counts;
- chunk count, failures, retries, input-token estimate, and latency;
- manual versus automatic preparation;
- proposal Adopt/Defer/Reject counts;
- stale bundle and failed atomic-commit counts;
- Memory recall count, source-invalid count, and User-reported unhelpful recall count;
- time from analysis completion to review and commit;
- review abandonment.

Telemetry contains no prompts, exchange bodies, Memory text, source filenames, Project names, Judgment text, or credentials.

## 23. Definition Of Done

The redesign is complete only when:

1. The old twelve-item truncation path is deleted and `CR-T-001` proves strict coverage.
2. Every eligible source before a committed cutoff is `no_signal`, `represented`, or explicit carryover.
3. Reflection automatically transitions between isolated stages after one User launch.
4. Every completed Reflection produces one Judgment Record draft and commits through the shared Module.
5. Memory Review supports manual preparation and standing-opt-in automatic preparation without automatic commit.
6. One Cognition Review Module owns proposal decisions, staleness, patch preparation, atomic commit, provenance, and cutoff advancement.
7. Only one bundle may be under active review.
8. LLM Settings exposes only Reflection Profile and Memory Review Profile for these workflows.
9. The new Learning Epoch reset deletes old cognition data while preserving ordinary Thread Trajectory and Project materials.
10. Project Memory and Long-term Memory retain separate scope and de-identification semantics.
11. Startup performs no automatic Provider call.
12. Old Dream/Reflection IPC, UI branches, stores, and tests are deleted after replacement tests pass.
13. Typecheck, deterministic tests, architecture tests, E2E tests, integration gate, and Personal Build gate pass.

## 24. Research Basis

The design is informed by the official-source comparison in:

- `docs/research/coding-agent-reflection-mechanisms.md`

The adopted synthesis is:

- MiMo Code's checkpoint/consolidation/retrieval responsibility split and bounded Memory injection;
- Gemini CLI Auto Memory's non-authoritative proposal-before-apply model;
- GitHub Copilot Memory's recall-time source validation;
- VC Desktop's existing evidence isolation, de-identification, explicit final commit, and cognitive-history discipline.

No external product's mechanism overrides the product-specific investment-cognition requirements in this specification.
