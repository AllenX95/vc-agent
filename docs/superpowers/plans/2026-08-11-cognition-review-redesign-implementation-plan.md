# Cognition Review Redesign Implementation Plan

Date: 2026-08-11  
Status: Approved plan  
Specification: `docs/superpowers/specs/2026-08-11-cognition-review-redesign-spec.md`  
Research: `docs/research/coding-agent-reflection-mechanisms.md`

## 1. Delivery Goal

Replace the current Dream and Reflection learning implementations with:

```text
Investment Reflection ─┐
                       ├─> CognitionReviewModule
Memory Review ─────────┘
```

The delivered system must:

- process every eligible source at or before a frozen cutoff without a fixed-item truncation hole;
- expose Reflection and Memory Review as two product intents, not two Memory commit systems;
- prepare automatic Memory Reviews only after standing opt-in;
- require one explicit, atomic final cognition commit;
- expose only Reflection Profile and Memory Review Profile in LLM Settings;
- start a new Learning Epoch and discard all legacy personal-cognition data while preserving ordinary conversations and Project materials;
- delete superseded Dream/Reflection contracts, Host orchestration, UI branches, persistence, and tests after replacement evidence exists.

## 2. Implementation Strategy

This is a replacement, not a compatibility refactor.

The implementation will build the new vertical path alongside the old path behind an internal development flag, prove the replacement at the new Module Interface, then perform one cutover that:

1. activates the new Learning Epoch;
2. resets legacy cognition data;
3. switches IPC and UI to the new path;
4. removes old code and tests in the same development series.

The shipped build will not contain a user-selectable old/new toggle or long-lived dual-write behavior.

## 3. Architecture And Ownership

### 3.1 External seam

One deep Module owns cognitive authority transitions:

```ts
interface CognitionReviewModule {
  prepare(input: ReflectionReviewInput | MemoryReviewInput): ReviewBundle;
  decide(reviewId: string, decisions: readonly ProposalDecisionInput[]): ReviewBundle;
  commit(reviewId: string): CognitionCommitResult;
  discard(reviewId: string): void;
}
```

Tests and callers cross this Interface. Internal extraction, synthesis, store, patch, and reset helpers are not exported from `@vc-agent/host-services` unless a second real caller requires them.

### 3.2 New code layout

```text
packages/contracts/src/cognition-review.ts

packages/host-services/src/cognition-review/
├── cognition-review.ts          # external Module implementation
├── store.ts                     # Reflection, batch, ledger, bundle persistence
├── eligibility.ts               # content-free source selection
├── coverage-ledger.ts           # strict invariant and projections
├── chunking.ts                   # deterministic ContextBudgetService chunking
├── memory-review-extraction.ts  # isolated chunk prompt and parser
├── memory-review-synthesis.ts   # bounded synthesis prompt and parser
├── commit.ts                    # patch construction and atomic commit
├── automatic-review.ts          # model-free due check and admission
├── reset.ts                     # one-time Learning Epoch reset
└── prompts/
    ├── memory-review-extraction.txt
    └── memory-review-synthesis.txt

tests/host-services/cognition-review/
├── coverage-ledger.test.ts
├── chunking.test.ts
├── eligibility.test.ts
├── extraction.test.ts
├── synthesis.test.ts
├── cognition-review.test.ts
├── commit.test.ts
├── automatic-review.test.ts
└── reset.test.ts
```

### 3.3 Reused internal implementations

The redesign SHOULD reuse proven implementation behind internal seams where it remains correct:

- `ContextBudgetService` for chunk budgets;
- `ThreadTrajectoryStore` for authoritative exchange bodies;
- `ReflectionEvidenceDrilldownSource` for exact Reflection evidence revalidation;
- `ProjectMemoryStore` and `LongTermMemoryStore` as storage adapters;
- `MemoryEvolutionStore` multi-file transaction support after it is hidden behind Cognition Review;
- execution scheduler, Worker supervision, Prompt Snapshot, Provider failure parsing, and context retirement;
- Project/Long-term Memory recall adapters and scope policy.

Reuse does not preserve old public methods or workflow states.

### 3.4 Removed ownership

The following modules must not remain alternate cognition-changing seams:

- `DreamReviewStore`;
- `DreamCommitStore`;
- `ReflectionOutcomeStore`;
- current `MemoryReviewService`;
- Renderer or Electron Main code that prepares Memory patches directly;
- separate Judgment Record and Learning Proposal commit handlers.

## 4. Canonical Persistence Shape

### 4.1 App cognition root

Use a new root to prevent accidental loading of old state:

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

`source-index.jsonl` is content-free. Raw user/assistant exchange bodies remain in Thread Trajectory and are resolved only when a chunk starts.

Review, Reflection, and batch records live under the same cognition root. A Host-owned durable transaction manifest coordinates them with Project Memory, Long-term Memory, Judgment Records, carryover, and cutoff. The implementation must provide logical atomicity across roots and volumes; it must not assume a single filesystem rename can cover every target.

### 4.2 SQLite state schema

Increment `STATE_SCHEMA_VERSION` from 17 to 18.

Schema 18 will:

- remove `reflection_runs` and its legacy methods;
- delete task assignments for `dream`, `independent_evidence`, and `memory_aware_reflection`;
- accept new task assignment types `reflection` and `memory_review`;
- persist a content-free cognition cutover marker sufficient to distinguish `pending_reset`, `active`, and `failed_reset`;
- retain Projects, Threads, model profiles, credentials, prompt revisions, materials, queue state, and unrelated operational state.

Do not copy old Reflection rows into new records.

### 4.3 Reset activation order

The reset implementation must avoid a state where schema 18 is active but old cognition is partly visible.

Required order:

1. Stage and validate the SQLite v18 migration using the existing rollback bundle.
2. Load the staged Project/Thread inventory needed to resolve cognition targets.
3. Resolve every legacy cognition path to an absolute target and verify containment within the explicit app-data root, known Project roots, or known Unscoped output locations.
4. Prepare one reset manifest listing the exact targets and intended empty/replacement content.
5. Activate the SQLite migration and cognition file reset through a recoverable transaction protocol.
6. Write `epoch.json` with `learningEpochStartedAt` only after every cognition target is inactive.
7. Mark the cutover active.
8. On any failure, restore the prior SQLite bundle when activation started and enter Read-only Recovery; never start a Worker, Pi runtime, or Provider call.

The implementation claims logical deletion, not secure erasure.

## 5. Development Slices

### P0 — Governance, terms, and failing characterization

**Goal:** make the changed authority model explicit before production code.

**Files:**

```text
docs/adr/0064-use-one-cognition-review-module-with-strict-learning-coverage.md
docs/adr/0065-start-a-new-learning-epoch-for-cognition-review-v2.md
CONTEXT.md
docs/superpowers/specs/2026-08-01-vc-agent-optimization-and-simplification-spec.md
tests/host-services/dream-extraction.test.ts
tests/host-services/dream-review.test.ts
```

**Tasks:**

1. Add ADR-0064 to supersede the conflicting Dream/Reflection authority and stage decisions listed in the specification.
2. Add ADR-0065 for the intentional cognition reset and Learning Epoch.
3. Add the new domain terms from the specification to `CONTEXT.md`.
4. Mark superseded sections of the 2026-08-01 optimization spec with a direct link to the new spec; do not silently edit its historical requirements into a different decision.
5. Add a failing characterization test proving that thirteen ordinary exchanges currently result in only twelve extraction inputs and can advance beyond the omitted source.

**Exit criteria:**

- governance conflict is explicit;
- the twelve-item defect is reproduced by a deterministic test;
- no implementation behavior has changed yet.

**Estimate:** 0.5-1 day.

### P1 — Contracts, Learning Epoch, and strict Coverage Ledger

**Goal:** establish the new source-of-truth contracts and invariant without calling a model.

**Files:**

```text
packages/contracts/src/cognition-review.ts
packages/contracts/src/index.ts
packages/contracts/src/ipc.ts
packages/contracts/src/trajectory.ts
packages/host-services/src/cognition-review/eligibility.ts
packages/host-services/src/cognition-review/coverage-ledger.ts
packages/host-services/src/cognition-review/store.ts
packages/host-services/src/index.ts
tests/contracts/cognition-review.test.ts
tests/host-services/cognition-review/eligibility.test.ts
tests/host-services/cognition-review/coverage-ledger.test.ts
```

**Tasks:**

1. Define Learning Epoch, eligible source, ledger, chunk, proposal, decision, Review Bundle, policy, and commit result schemas.
2. Implement deterministic eligibility from completed ordinary Turn events, confirmed new Judgment Records, Reflection adoption/correction/confirmation, and explicit Memory actions.
3. Exclude pre-epoch, failed, interrupted, Sub-Agent, evidence-pass, tool-only, and Memory Review sessions.
4. Implement ledger transitions with exact membership and proposal-reference validation.
5. Persist content-free source index and bounded workflow records under `cognition-v2`.
6. Add deletion/redaction handling for uncommitted source references.

**Tests:** `CR-T-003`, `CR-T-004`, `CR-T-005`, `CR-T-009`, `CR-T-010`.

**Exit criteria:**

- every ledger projection is schema-validated;
- no source body is copied into the eligibility index;
- no model or Memory write is involved.

**Estimate:** 1-1.5 days.

### P2 — Budgeted chunk processor and strict extraction coverage

**Goal:** eliminate the twelve-item truncation and prove complete source disposition.

**Files:**

```text
packages/host-services/src/cognition-review/chunking.ts
packages/host-services/src/cognition-review/memory-review-extraction.ts
packages/host-services/src/cognition-review/prompts/memory-review-extraction.txt
packages/contracts/src/worker.ts
apps/desktop/src/main/turn-execution.ts
apps/agent-worker/src/**                 # only where a new execution kind is required
tests/host-services/cognition-review/chunking.test.ts
tests/host-services/cognition-review/extraction.test.ts
tests/host-services/context-budget.test.ts
```

**Tasks:**

1. Partition each Project/Unscoped scope by `ContextBudgetService` decision, not item count.
2. Store deterministic chunk membership, input hash, prompt/profile snapshot, attempts, and status.
3. Require extraction output to disposition every source in the chunk exactly once.
4. Reject out-of-chunk references, missing references, duplicates, and `represented` without a candidate.
5. Resolve Thread bodies only at chunk execution time and retire them afterward.
6. Mark failed/interrupted chunks without advancing cutoff; permit bounded explicit retry or carryover.
7. Support multiple chunks per scope and bounded concurrency through the existing scheduler.

**Tests:** `CR-T-001`, `CR-T-002`, `CR-T-003`, `CR-T-004`, `CR-T-006`.

**Exit criteria:**

- the original thirteen-exchange failing test passes through the new path;
- no fixed per-scope maximum can silently omit a source;
- extraction isolation and de-identification rules remain intact.

**Estimate:** 1.5-2 days.

### P3 — Synthesis and the deep Cognition Review Module

**Goal:** create the shared proposal/review/patch seam before integrating either UI workflow.

**Files:**

```text
packages/host-services/src/cognition-review/cognition-review.ts
packages/host-services/src/cognition-review/memory-review-synthesis.ts
packages/host-services/src/cognition-review/commit.ts
packages/host-services/src/cognition-review/prompts/memory-review-synthesis.txt
packages/host-services/src/memory-evolution.ts
packages/host-services/src/project-memory.ts
packages/host-services/src/long-term-memory.ts
tests/host-services/cognition-review/synthesis.test.ts
tests/host-services/cognition-review/cognition-review.test.ts
tests/host-services/cognition-review/commit.test.ts
```

**Tasks:**

1. Implement `prepare`, `decide`, `commit`, and `discard` through the single Interface.
2. Adapt approved, bounded scope results into one synthesis input.
3. Preserve single-Project, multi-Project, Unscoped, and Long-term de-identification rules.
4. Normalize Learning Proposals and internal Memory Evolution actions.
5. Map `Adopt`, `Defer`, and `Reject` to patch, carryover, and final source disposition.
6. Capture dependencies and base hashes in the Host, not from model-declared metadata.
7. Prepare one multi-file patch and commit it through a durable manifest with before-images, staged after-images, base hashes, an explicit commit point, and deterministic restart recovery.
8. Implement the global cognition-review lease and waiting projection.
9. Hide direct `MemoryEvolutionStore` and store-specific commit methods from external callers.

**Tests:** `CR-T-007`, `CR-T-008`, `CR-T-011` through `CR-T-017` except Reflection-specific orchestration.

**Exit criteria:**

- tests exercise only the Module Interface for cognitive commits;
- deletion of the Module would redistribute commit complexity to multiple callers;
- stale or partial commit is impossible under fault injection.

**Estimate:** 2-2.5 days.

### P4 — Memory Review manual and automatic orchestration

**Goal:** deliver the complete batch workflow without exposing chunk/synthesis stages as primary actions.

**Files:**

```text
packages/host-services/src/cognition-review/automatic-review.ts
packages/contracts/src/ipc.ts
apps/desktop/src/main/main.ts
apps/desktop/src/main/turn-execution.ts
apps/desktop/src/renderer/App.tsx
apps/desktop/src/renderer/i18n.ts
tests/host-services/cognition-review/automatic-review.test.ts
tests/contracts/ipc.test.ts
tests/e2e/lifecycle.spec.ts
tests/e2e/ui-details.spec.ts
```

**Tasks:**

1. Add manual Memory Review preparation.
2. Add standing-opt-in policy with configured Memory Review Profile, thresholds, maximum interval, and token budget.
3. Run model-free due checks at startup and state changes.
4. Admit automatic model work only after submitted work completes and the scheduler is idle.
5. Freeze one Memory Review Profile and Prompt Snapshot for extraction and synthesis.
6. Show pending count, oldest pending source date, preparation progress, failure, Review Bundle, and patch preview.
7. Show Adopt/Defer/Reject as ordinary choices; keep evolution action and source details behind disclosure.
8. Prevent automatic commit, startup Provider calls, preemption, retry loops, and current-Thread Profile fallback.

**Tests:** `CR-T-018` through `CR-T-022`.

**Exit criteria:**

- manual and automatic preparation converge on the same batch implementation;
- automatic preparation is visible and cancellable;
- final commit is always explicit.

**Estimate:** 1.5-2 days.

### P5 — Reflection orchestration and atomic finalization

**Goal:** preserve evidence isolation while reducing Reflection to one launch and one final confirmation.

**Files:**

```text
packages/host-services/src/investment-reflection.ts
packages/host-services/src/reflection-evidence.ts
packages/host-services/src/cognition-review/store.ts
packages/contracts/src/cognition-review.ts
packages/contracts/src/ipc.ts
packages/persistence/src/index.ts             # remove old Reflection runtime ownership
apps/desktop/src/main/main.ts
apps/desktop/src/main/turn-execution.ts
apps/desktop/src/renderer/App.tsx
apps/desktop/src/renderer/i18n.ts
tests/host-services/investment-reflection.test.ts
tests/host-services/reflection-evidence.test.ts
tests/host-services/cognition-review/cognition-review.test.ts
tests/e2e/project-thread-lifecycle.spec.ts
```

**Tasks:**

1. Use one Reflection Profile for both isolated stages.
2. After Independent Assessment completes, automatically start the Memory-aware context under the same explicit Reflection launch.
3. Preserve frozen brief, Prompt Snapshot, exact evidence references, bounded drilldown, and Memory challengeability.
4. Make finalization require exactly one Judgment Record draft; allow zero Learning Proposals.
5. Send Judgment and Learning Proposals to `CognitionReviewModule.prepare`.
6. Replace separate Judgment confirmation and Learning patch commands with one `Confirm Reflection` commit.
7. Persist `completed` as a true terminal Reflection state.
8. Preserve discard without authoritative outcome.

**Tests:** `CR-T-011` through `CR-T-014`, including no-learning, insufficient-evidence, stale, and injected write failure.

**Exit criteria:**

- no second `Start critical dialogue` decision exists;
- no separate Judgment/Memory authority transition remains;
- Reflection and Memory Review share the same commit implementation.

**Estimate:** 1.5-2 days.

### P6 — LLM Settings, intent-level IPC, and simplified projections

**Goal:** remove stage-level configuration and expose only product intent.

**Files:**

```text
packages/contracts/src/ipc.ts
packages/persistence/src/index.ts
apps/desktop/src/main/main.ts
apps/desktop/src/renderer/App.tsx
apps/desktop/src/renderer/i18n.ts
tests/contracts/ipc.test.ts
tests/persistence/host-state-store.test.ts
tests/e2e/ui-localization.spec.ts
tests/e2e/ui-details.spec.ts
```

**Tasks:**

1. Replace task types `dream`, `independent_evidence`, and `memory_aware_reflection` with `reflection` and `memory_review`.
2. Add Reflection Profile and Memory Review Profile to LLM Settings.
3. Remove per-launch/stage Profile selectors and current-Thread fallbacks.
4. Add intent-level commands from the specification.
5. Project chunk, scope, attempt, carryover, and cutoff details behind one diagnostics disclosure.
6. Enforce one active review bundle through Host projection, not duplicated Renderer checks.

**Exit criteria:**

- users configure only two cognition task assignments;
- Renderer does not branch on extraction/synthesis persistence statuses;
- IPC cannot bypass the Cognition Review Module.

**Estimate:** 1-1.5 days.

### P7 — Learning Epoch reset and production cutover

**Goal:** activate cognition v2 without importing old cognition or deleting ordinary work.

**Files:**

```text
packages/persistence/src/state-migration.ts
packages/persistence/src/index.ts
packages/host-services/src/cognition-review/reset.ts
packages/host-services/src/personal-cognition-backup.ts
apps/desktop/src/main/main.ts
tests/persistence/host-state-store.test.ts
tests/host-services/cognition-review/reset.test.ts
tests/host-services/personal-cognition-backup.test.ts
tests/e2e/lifecycle.spec.ts
```

**Tasks:**

1. Implement schema 18 staging, cutover marker, and old Reflection-table removal.
2. Resolve and validate exact cognition reset targets.
3. Reset Project Memory, Long-term Memory, history, provenance, candidates, Dream, Reflection, Judgment Records, and old task assignments.
4. Preserve Thread Trajectory, Project materials, Context, model profiles, credentials, prompt revisions, and non-cognitive Outputs.
5. Write the new epoch only after reset activation succeeds.
6. Exclude all pre-epoch sources.
7. Update Personal Cognition Backup to support only v2 after cutover; do not import old cognition into v2.
8. Surface reset failure as Read-only Recovery and start no Worker, Pi runtime, or Provider work.

**Tests:** `CR-T-023` through `CR-T-026`, plus path containment, symlink/junction, injected failure, and restart.

**Exit criteria:**

- a populated legacy fixture becomes an empty cognition-v2 installation;
- ordinary conversation/material fixtures remain byte-identical;
- no old cognition can reappear through eligibility scanning.

**Estimate:** 1.5-2 days.

### P8 — Delete superseded implementation and run release evidence

**Goal:** finish replacement and avoid permanent dual architecture.

**Delete after replacement tests pass:**

```text
packages/contracts/src/dream.ts
packages/contracts/src/dream-workflow.ts
packages/contracts/src/reflection-workflow.ts
packages/host-services/src/dream-commit.ts
packages/host-services/src/dream-eligibility.ts
packages/host-services/src/dream-extraction.ts
packages/host-services/src/dream-review.ts
packages/host-services/src/dream-synthesis.ts
packages/host-services/src/reflection-outcomes.ts
packages/host-services/src/reflection-staleness.ts
packages/host-services/src/memory-review.ts
tests/contracts/dream-workflow.test.ts
tests/contracts/reflection-workflow.test.ts
tests/host-services/dream-*.test.ts
tests/host-services/reflection-outcomes.test.ts
tests/host-services/reflection-staleness.test.ts
tests/host-services/memory-review.test.ts
```

PowerShell/glob limitations require resolving and reviewing the exact file list before deletion; do not pass unresolved globs to destructive commands.

**Tasks:**

1. Remove old exports, imports, IPC commands/events, execution kinds, UI settings, CSS selectors, translations, and telemetry labels.
2. Replace architecture tests so callers cannot access internal cognition stores or direct commit methods.
3. Run contract, persistence, Host, capability, architecture, and E2E suites.
4. Run packaged Personal Build evidence with automatic policy disabled and enabled fixtures.
5. Review the final diff for duplicate state machines and old terminology.

**Exit criteria:**

- no production import references a deleted Dream/Reflection store;
- no old task model type or command remains in contracts;
- no compatibility reader or dual write remains;
- all release gates pass.

**Estimate:** 1-1.5 days.

## 6. Test Strategy

### 6.1 Replace, do not layer

Once the Cognition Review Interface tests cover an observable behavior, delete old tests of the superseded shallow module. Keep tests of reusable internal adapters only when they express independent behavior, such as Memory file parsing or evidence drilldown.

### 6.2 Property tests

Coverage correctness needs generated cases, not only fixtures:

- 0, 1, 12, 13, 24, and 100 eligible exchanges;
- varying body sizes around chunk budget boundaries;
- multiple Project and Unscoped scopes;
- duplicate and reordered source references;
- failure at every chunk position;
- sources added after cutoff;
- sources deleted before execution;
- all no-signal, all represented, all carryover, and mixed results.

For every generated committed batch:

```text
eligible source set
=== no_signal union represented union carried_over
```

and the three terminal sets are pairwise disjoint.

### 6.3 Fault injection

Inject failure:

- before and after patch preparation;
- while writing each Memory/history/Judgment/state file;
- before cutoff advancement;
- during reset staging and activation;
- on Worker exit and application restart;
- after source/base hash changes.

No fault may produce a partial cognitive commit or active new epoch over incomplete reset.

### 6.4 Architecture tests

Add rules proving:

- Electron Main and Renderer cannot import Memory Evolution or cognition stores directly;
- only `CognitionReviewModule` performs authoritative cognition commit;
- extraction/synthesis sessions are excluded from learning eligibility;
- ordinary startup cannot invoke automatic review execution;
- Thread Trajectory remains the raw eligible-source body store;
- Project and Long-term Memory adapters remain scope-distinct.

## 7. Verification Commands

Run after each slice as applicable:

```powershell
pnpm typecheck
pnpm vitest run tests/contracts/cognition-review.test.ts
pnpm vitest run tests/host-services/cognition-review
pnpm vitest run tests/persistence
pnpm vitest run tests/architecture
```

Run before old-code deletion and again after deletion:

```powershell
pnpm test
pnpm test:e2e
pnpm integration-gate
pnpm personal-build-gate
```

Run final release evidence:

```powershell
pnpm verify
pnpm integration-gate:release
pnpm personal-build-gate:release
```

Real Provider evidence must cover:

- one manual Memory Review with more than twelve eligible exchanges;
- one standing-opt-in automatic preparation;
- one Reflection with no Learning Proposal;
- one Reflection with adopted learning;
- one stale commit rejection;
- restart with a prepared Review Bundle;
- no Provider call at startup.

Content-bearing evidence stays outside the repository; repository evidence contains only sanitized status, IDs, counts, Profile/Provider labels, usage, latency, and terminal results.

## 8. Delivery Estimate

| Slice | Estimate |
| --- | ---: |
| P0 Governance and characterization | 0.5-1 day |
| P1 Contracts and ledger | 1-1.5 days |
| P2 Chunk extraction | 1.5-2 days |
| P3 Cognition Review Module | 2-2.5 days |
| P4 Memory Review orchestration | 1.5-2 days |
| P5 Reflection integration | 1.5-2 days |
| P6 Settings and IPC | 1-1.5 days |
| P7 Reset and cutover | 1.5-2 days |
| P8 Deletion and release evidence | 1-1.5 days |
| **Total** | **12-16 days** |

The estimate excludes user review time, real Provider outages, packaging runtime download time, and unrelated repository failures.

## 9. Stop Conditions

Stop and revise the specification before continuing if implementation would require any of the following:

- advancing cutoff while an eligible source lacks terminal disposition or carryover;
- automatic active Memory or Judgment write;
- preserving a separate Reflection or Dream commit path;
- adding a per-turn model classifier or model checkpoint writer for correctness;
- deleting ordinary Thread Trajectory or Project materials during reset;
- loading pre-epoch sources without explicit import;
- exposing stage-specific model profiles as required settings;
- starting automatic Provider work during application startup;
- weakening Project/Long-term Memory scope or de-identification rules;
- leaving a long-lived old/new compatibility mode after cutover.

## 10. Final Definition Of Done

Implementation is finished only when the specification's Definition of Done is satisfied, legacy cognition data has been reset into a new Learning Epoch, the old code paths are deleted, and release evidence proves strict coverage plus atomic cognitive commit under failure and restart.
