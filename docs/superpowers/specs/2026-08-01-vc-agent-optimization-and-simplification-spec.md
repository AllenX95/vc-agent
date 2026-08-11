# VC Desktop Agent Optimization And Simplification Specification

Date: 2026-08-01  
Status: Proposed for review  
Scope: Personal Build optimization after the Foundation, Learning, Integration, and Personal Build slices  
Supersedes: None; this specification refines presentation and implementation while preserving governing ADRs unless an explicit amendment is approved

> **Historical supersession notice (2026-08-11):** The Reflection state and
> migration requirements `OPT-REQ-021` through `OPT-REQ-024`, the Dream
> workflow requirements `OPT-REQ-025` through `OPT-REQ-032`, and the shallow
> `MemoryReviewService` requirements `OPT-REQ-033` through `OPT-REQ-038` are
> superseded by the [Cognition Review Redesign Specification](./2026-08-11-cognition-review-redesign-spec.md)
> and ADR-0064/ADR-0065. This document remains a historical optimization
> baseline; the sections below are retained verbatim and are not the current
> implementation target.

## Outcome

VC Desktop Agent becomes materially simpler in ordinary use without weakening the product boundaries that make its investment work trustworthy. Routine work uses fewer blocking decisions, Dream and Sub-Agent workflows expose fewer user-facing layers, Memory is organized through one review-oriented information architecture, and repeated execution and integration plumbing is centralized behind deep Host modules.

The target is not feature removal for its own sake or a numeric reduction in IPC commands and source lines. The target is:

- 50-70% fewer blocking confirmations in ordinary low-risk work;
- no more than three primary User decisions in a normal Dream run: launch, review, and commit;
- two default visible Sub-Agent levels: Run and Task;
- three Memory views: Pending Review, Adopted Memory, and History;
- one context-budget decision service and one Host execution-lifecycle coordinator;
- fewer duplicated state expressions and UI branches while retaining durable facts needed for authorization, provenance, restart recovery, stale-write protection, and audit.

## Product Thesis

Optimization MUST distinguish three kinds of complexity:

| Complexity | Product treatment |
| --- | --- |
| User interaction complexity | Remove, combine, default, or progressively disclose it. |
| Domain fact complexity | Preserve authoritative distinctions but project them into simpler User concepts. |
| Runtime safety complexity | Preserve recovery and consistency semantics; centralize ownership and coordination instead of deleting mechanisms. |

The ordinary experience SHOULD feel like a lightweight conversation and output tool. Complexity SHOULD become prominent only when the User changes investment cognition, expands disclosure or authority, trusts executable code, replaces source content, or resolves an uncertain external side effect.

## Non-goals

- No removal or bypass of the Cognitive Review Gate or User Intent Gate.
- No silent Memory write, Dream or Reflection launch/resume, Thread Scope Elevation, Extension approval, or Cross-Provider Thread Continuation.
- No automatic Provider switch, model fallback, retry, replay, or ordinary-Turn resume.
- No deletion of In-flight Turn Checkpoints, Thread Trajectory acknowledgement, Unknown Tool Outcome, visible Execution Queue, or bounded global execution admission merely to reduce code or state count.
- No merge of Project Memory and Long-term Memory, current Memory and history, Short-term Memory Candidates and reviewed proposals, or Condensation Archive and Cognitive Evolution History into one authoritative store.
- No default removal of failed Sub-Agent Attempts before real dogfood retention data exists.
- No second local-only Dream proposal engine and no default disabling of the existing synthesis stage.
- No hot reload of System Prompt revisions into an existing Physical Model Context.
- No universal integration state machine that erases domain-specific admission, preview, activation, or commit semantics.
- No success criterion based solely on IPC command count, enum count, or lines of code.

## Governing Decisions

This specification preserves ADR 0013, 0014, 0018, 0022, 0024, 0025, 0029, 0030, 0031, 0032, 0033, 0034, 0040, 0042, 0043, 0047, 0048, 0050, 0052, 0053, 0054, 0055, 0056, 0057, and 0058.

Any implementation that changes the following behavior MUST first amend its governing ADR:

- making Parse Refresh non-explicit when stale material is next needed;
- changing retained Sub-Agent Task Record content or default lifecycle;
- changing Dream from cross-project two-stage learning to separate local/global engines;
- removing a Prompt Load Boundary or Workflow Prompt Snapshot;
- changing Extension approval, enablement, or atomic changeover boundaries;
- changing Interrupted Turn recovery or queued-follow-up restart behavior.

## Success Measures And Baseline

Before structural deletion begins, the Personal Build MUST record local, content-free dogfood metrics for at least one meaningful usage period. The metrics MUST NOT contain prompts, source bodies, Memory content, file names, output text, credentials, Provider response bodies, or Extension source.

Required baseline metrics:

- decision requests by decision class, accepted/cancelled counts, and repeated-choice counts;
- time from Turn submission to first useful visible result and final result;
- Dream launch, scope review, synthesis, proposal review, preview, commit, defer, discard, and abandonment counts;
- Sub-Agent Run/Task/Attempt counts, retry rate, detail-expansion rate, record-deletion rate, and adoption/rejection rate;
- Extension stage, inspect, optional audit, approve, enable, disable, invalidation, and rollback counts;
- Provider Failure, Unknown Tool Outcome, interrupted-turn recovery, stale-write rejection, and migration failure counts;
- state-machine-related defect count and number of modules changed for representative workflow changes.

Target measures after implementation:

| Measure | Target |
| --- | --- |
| Median blocking decisions for an ordinary task without sensitive side effects | At most 1 |
| Default Output location reuse | At least 90% when the configured path remains valid |
| Normal Dream primary User decisions | Launch, review, commit |
| Sub-Agent default visible hierarchy | Run and Task only |
| Cross-Provider continuation | Always explicit |
| Silent stale parse use | Zero |
| Silent stale Memory/Dream commit | Zero |
| Automatic replay after interruption | Zero |
| Extension approval or enablement inferred from Full Access/model output | Zero |

Code reduction is a secondary result. A 10-20% reduction in the directly affected orchestration and presentation code is plausible; a 50% product-wide reduction is not a commitment.

## Decision Classification

The Host MUST classify User decisions by cognitive impact, disclosure, external side effect, and recoverability. Recoverability alone is insufficient.

### Decision classes

| Class | Meaning | Required interaction | Examples |
| --- | --- | --- | --- |
| G1 Cognitive or trust gate | Defines cognition, scope, or executable trust | Explicit User action; never bypassed by Access Mode or remembered preference | Memory commit, Dream/Reflection launch or resume, Thread Scope Elevation, Extension approval |
| G2 Disclosure or high-risk side effect | Changes disclosure recipient, original source, runtime trust set, or uncertain external outcome | Targeted disclosure/preview and explicit confirmation | Cross-Provider continuation, Original Source replacement, immediate Extension activation, Unknown Tool Outcome retry |
| G3 Ordinary recoverable write | Creates or changes Host-owned output with known target and recovery path | Inline preview or established scoped preference; Standard Access policy still applies | New Output, edited copy, project-default Output directory |
| G4 Local non-side-effect operation | Reads or deterministically refreshes local state | Execute and visibly report when useful | Inventory refresh, local index rebuild, load/list/open folder |

### Required behavior

| Requirement | Behavior |
| --- | --- |
| OPT-REQ-001 | Every confirmation surface MUST declare one decision class and its reason. |
| OPT-REQ-002 | G1 decisions MUST remain explicit in Standard and Full Access and MUST NOT support a standing bypass preference. |
| OPT-REQ-003 | G2 decisions MUST identify the disclosure recipient, affected original target, interrupted work, or duplicate-risk outcome as applicable. |
| OPT-REQ-004 | G3 preferences MUST be scoped to a Project or explicit authorized location and MUST fail closed when the target becomes unavailable, changes identity, or leaves its boundary. |
| OPT-REQ-005 | G4 operations MUST NOT start Pi, activate a Worker, or call a Provider unless separately submitted as Pi-backed work. |
| OPT-REQ-006 | Blocking modal presentation SHOULD be reserved for G1/G2 decisions; G3 SHOULD prefer inline preview and G4 SHOULD prefer status or notification. |

### Concrete simplifications

- A Project MAY retain one default Output directory. A Thread MAY override it. Missing, moved, or unauthorized paths require a new User choice.
- Output creation uses the default directory without a location dialog when the request and boundary are unambiguous.
- Replacing an Original Source File remains a G2 action. Creating an edited copy remains the recommended path.
- Material inventory changes are aggregated into one notification. The application waits until stale content is needed before Parse Refresh blocks dependent work.
- The Parse Refresh surface MAY batch multiple stale materials, but each selected material receives an explicit resolution. `Create New Parse Version` remains the recommended default and retains the old artifact.
- Cross-Provider continuation remains G2 because it changes the recipient of retained Thread context.
- Profile Capability Check is silent when compatible, inline when degradation is defined, and blocking only when an indispensable capability is absent.

## Capability Activation Simplification

The ordinary capability model remains Minimal Default Harness plus a revision-checked `capability_request` broker.

Intent detectors MUST be classified as one of:

1. preload optimization;
2. User Intent authorization evidence;
3. recall policy signal;
4. protected-workflow framing.

Pure preload detectors MAY be removed when the capability is already common-visible or broker-requestable and Golden Cases prove no loss of task completion. Authorization, recall, and protected-workflow signals MUST NOT be removed merely because the model can request a capability.

| Requirement | Behavior |
| --- | --- |
| OPT-REQ-007 | Common-read capabilities MUST NOT depend on regex classification for correctness. |
| OPT-REQ-008 | `capability_request` MAY expand the current Turn surface only within existing scope, availability, catalog revision, activation class, and User authorization. |
| OPT-REQ-009 | A model capability request MUST NOT manufacture User intent for Output creation, Memory access beyond policy, durable write, delegation, Dream, Reflection, or scope elevation. |
| OPT-REQ-010 | Detector removal MUST include bilingual positive, negative, ambiguous, and broker-fallback Golden Cases. |
| OPT-REQ-011 | Initial schema tokens, activation round trips, rejected activations, and task completion MUST remain observable without content telemetry. |

## Context Budget Service

Introduce one Host-owned `ContextBudgetService` used by ordinary Turns and explicit model-backed workflows.

```ts
interface ContextBudgetInput {
  systemPromptBytes: number;
  toolSchemaBytes: number;
  taskBytes: number;
  retainedHistoryBytes: number;
  retrievalBytes: number;
  contextWindowTokens: number;
  reservedOutputTokens: number;
}

interface ContextBudgetDecision {
  contributions: {
    systemPromptTokens: number;
    toolSchemaTokens: number;
    taskTokens: number;
    retainedHistoryTokens: number;
    retrievalTokens: number;
  };
  usableContextTokens: number;
  estimatedInputTokens: number;
  action: "admit" | "compact_then_admit" | "reject_current_input" | "reject_additional_retrieval";
}
```

One estimation implementation is authoritative. Distinct contribution fields remain because current input, retained history, and retrieval consumption answer different operational questions.

| Requirement | Behavior |
| --- | --- |
| OPT-REQ-012 | All context-budget decisions MUST use the same versioned estimator and safety margin. |
| OPT-REQ-013 | Telemetry MUST preserve contribution categories and estimator revision. |
| OPT-REQ-014 | Current input larger than usable context MUST fail visibly without Provider fallback. |
| OPT-REQ-015 | History-driven overflow MAY trigger visible compaction under existing ADR policy; retrieval overflow MUST reject or bound additional retrieval rather than silently discard authoritative source identity. |

## Execution Lifecycle Coordination

Introduce a Host-internal `ExecutionLifecycleCoordinator`. It centralizes orchestration but does not replace the stores or semantics owned by the Execution Queue, scheduler leases, In-flight Turn Checkpoints, Thread Trajectory, or Physical Model Context acknowledgement.

```ts
interface ExecutionLifecycleCoordinator {
  admit(request: ExecutionAdmissionRequest): ExecutionAdmission;
  beginTurn(request: BeginTurnRequest): void;
  updateCheckpoint(update: CheckpointUpdate): void;
  recordTerminal(event: TerminalExecutionEvent): void;
  interrupt(request: InterruptExecutionRequest): void;
  reconcileWorkerExit(workerId: string): ReconciliationReport;
  drainQueue(): void;
  shutdown(deadlineMs: number): Promise<ExecutionShutdownReport>;
}
```

Ownership remains:

| Mechanism | Authoritative responsibility |
| --- | --- |
| Execution Queue | Visible order and editable/cancellable queued follow-ups |
| Scheduler lease | Installation-wide capacity across ordinary and explicit workflow model executions |
| In-flight checkpoint | Latest durable visible partial response and unfinished tool boundary |
| Thread Trajectory | Completed User-visible and audit events |
| Physical Context acknowledgement | Host/Pi session high-water synchronization |
| Unknown Tool Outcome | Uncertain dispatched side effect requiring inspection or explicit duplicate-risk decision |

| Requirement | Behavior |
| --- | --- |
| OPT-REQ-016 | Every admitted execution MUST acquire and release exactly one scheduler lease through the coordinator. |
| OPT-REQ-017 | Completed, failed, interrupted, worker-exit, and shutdown paths MUST use one terminal reconciliation contract. |
| OPT-REQ-018 | A terminal trajectory event MUST become durable before its In-flight Turn Checkpoint is removed. |
| OPT-REQ-019 | Startup MUST treat persisted processes and leases as non-running, reconcile orphaned checkpoints, and start no model work. |
| OPT-REQ-020 | Queue, lease, checkpoint, and acknowledgement mechanisms MUST NOT be removed until fault-injection evidence proves an equivalent implementation for every governing invariant. |

## Reflection State Model

> **Superseded section:** `OPT-REQ-021`–`OPT-REQ-024` are historical
> requirements. See the [Cognition Review Redesign Specification](./2026-08-11-cognition-review-redesign-spec.md)
> and [ADR-0065](../../adr/0065-start-a-new-learning-epoch-for-cognition-review-v2.md)
> for the Learning Epoch reset and replacement Reflection authority.

Replace the flat eleven-state UI and persistence model with orthogonal workflow stage and execution state after an atomic migration.

```ts
type ReflectionStage =
  | "configuration"
  | "independent_evidence"
  | "critical_dialogue"
  | "completed"
  | "discarded";

type ReflectionExecutionState = "idle" | "running" | "paused" | "failed";

type ReflectionPauseReason = "user_stop" | "application_restart" | "configuration";
```

Provider Failure remains `failed`; User stop and restart become `paused` with distinct reasons. Presentation selectors derive labels and available actions from stage, execution state, evidence availability, and failure/pause reason.

Required legacy mapping:

| Legacy status | New stage | New execution state |
| --- | --- | --- |
| `awaiting_profile` | `configuration` | `paused` |
| `ready` | `independent_evidence` | `idle` |
| `independent_running` | `independent_evidence` | `running` |
| `independent_completed` | `critical_dialogue` | `idle` |
| `independent_failed` | `independent_evidence` | `failed` |
| `independent_interrupted` | `independent_evidence` | `paused` |
| `memory_aware_running` | `critical_dialogue` | `running` |
| `dialogue_active` | `critical_dialogue` | `idle` |
| `memory_aware_failed` | `critical_dialogue` | `failed` |
| `memory_aware_interrupted` | `critical_dialogue` | `paused` |
| `discarded` | `discarded` | `idle` |

| Requirement | Behavior |
| --- | --- |
| OPT-REQ-021 | Migration MUST preserve frozen brief, prompt snapshot, profiles, assessment, failure, session reference, source scope, and timestamps. |
| OPT-REQ-022 | UI controls MUST be derived from the new model through one selector rather than direct checks against legacy status strings. |
| OPT-REQ-023 | Failed and interrupted executions MUST retain distinct User-visible reason and recovery action. |
| OPT-REQ-024 | No migration may turn an unfinished Reflection into active dialogue, discard it, or call a model. |

## Dream Workflow Simplification

> **Superseded section:** `OPT-REQ-025`–`OPT-REQ-032` are historical
> requirements. See the [Cognition Review Redesign Specification](./2026-08-11-cognition-review-redesign-spec.md)
> and [ADR-0064](../../adr/0064-use-one-cognition-review-module-with-strict-learning-coverage.md)
> for Memory Review, strict Coverage Ledger disposition, and the shared
> Cognition Review commit path.

The User-facing Dream has three primary phases:

```text
Collect -> Review -> Commit
```

The implementation retains scope extraction, reviewed-scope synthesis, proposal review, prepared patch, cutoff, carryover, stale handling, and partial coverage as internal facts.

Normal orchestration:

1. The User explicitly launches or resumes Dream.
2. The Host runs eligible scope extractions under existing isolation and capacity rules.
3. The User reviews scope results as one review phase.
4. When every scope has a final review disposition, the Host automatically starts the existing synthesis stage if capacity and Profile requirements are satisfied.
5. The User reviews proposed changes.
6. When proposal review is complete, the Host automatically prepares the patch preview.
7. The User explicitly commits or discards the prepared change.

The synthesis implementation adapts to input cardinality:

- one Project scope produces project-specific proposals without manufacturing cross-project claims;
- multiple Project scopes may produce de-identified cross-project learning;
- Unscoped scope cannot target Project Memory;
- Long-term Memory remains limited to de-identified reusable learning;
- no useful learning may result in Keep Pending or Discard rather than forced Memory creation.

| Requirement | Behavior |
| --- | --- |
| OPT-REQ-025 | Dream launch and resume remain G1 decisions. Automatic transitions occur only inside the explicitly authorized run. |
| OPT-REQ-026 | Synthesis MUST remain the single proposal-generation path unless a later ADR explicitly defines another engine. |
| OPT-REQ-027 | Automatic synthesis start MUST use the frozen Workflow Prompt Snapshot and Dream Profile and MUST pause visibly when configuration or capacity is unavailable. |
| OPT-REQ-028 | Proposal review MUST NOT authorize a write. A prepared patch preview and explicit commit remain required. |
| OPT-REQ-029 | Prepared patch MUST compare authoritative base hashes at commit and reject stale project or Memory targets. |
| OPT-REQ-030 | Cutoff and carryover remain authoritative scheduling facts; primary UI presents them as unresolved prior-period items rather than requiring the User to understand scheduling terminology. |
| OPT-REQ-031 | Partial coverage remains visible as a warning and provenance attribute, not a competing primary workflow stage. |
| OPT-REQ-032 | Batch status fields may be removed only when a deterministic derivation from retained facts is documented, migrated, and property-tested. |

## Memory Information Architecture And Application Service

> **Superseded section:** `OPT-REQ-033`–`OPT-REQ-038` are historical
> requirements. See the [Cognition Review Redesign Specification](./2026-08-11-cognition-review-redesign-spec.md)
> and [ADR-0064](../../adr/0064-use-one-cognition-review-module-with-strict-learning-coverage.md)
> for the replacement Module Interface and Review Bundle authority.

The User sees three top-level views:

### Pending Review

- captured Short-term Memory Candidates;
- recovered Dream candidates;
- Dream proposals and Keep Pending items;
- Reflection learning proposals;
- unresolved Memory conflicts requiring User attention.

### Adopted Memory

- current Project Memory;
- current Long-term Memory;
- maturity, applicability, recall policy, status, and source availability.

### History

- Cognitive Evolution History;
- Condensation Archive;
- superseded Memory versions;
- approval, provenance, source-unavailable, and manual-edit records.

Introduce a `MemoryReviewService` as an application seam used by Dream, Reflection, and direct User Memory actions.

```ts
interface MemoryReviewService {
  listPending(query?: PendingMemoryQuery): PendingMemoryProjection[];
  prepareChange(request: MemoryChangeRequest): PreparedMemoryChange;
  commit(changeId: string): MemoryCommitResult;
  discard(changeId: string): void;
  history(query?: MemoryHistoryQuery): MemoryHistoryProjection[];
}
```

The service coordinates existing candidate, Project Memory, Long-term Memory, evolution, archive, provenance, and review stores. It does not collapse their authoritative storage.

| Requirement | Behavior |
| --- | --- |
| OPT-REQ-033 | Candidates and reviewed proposals MUST retain distinct types and provenance. |
| OPT-REQ-034 | Project Memory and Long-term Memory MUST retain different scope, recall, and de-identification policies. |
| OPT-REQ-035 | Cognitive Evolution History and Condensation Archive MAY share one UI view but MUST retain their different retention semantics. |
| OPT-REQ-036 | Historical or superseded Memory MUST NOT enter ordinary recall as current authoritative Memory. |
| OPT-REQ-037 | Every Memory-changing path MUST prepare a reviewable change and require explicit User commit. |
| OPT-REQ-038 | User-facing action labels SHOULD use plain language; exact Add/Reinforce/Narrow/Revise/Contradict/Merge semantics remain inspectable in advanced details and history. |

## Sub-Agent Presentation And Retention

The default visible hierarchy is:

```text
Sub-Agent Run
  -> Task summary, status, usage, bounded result, and adoption state
```

Attempt messages, tool events, exact Profile snapshot, context references, and detailed failures load only when the User expands a Task.

The underlying Run, Task, Attempt, and Handoff distinctions remain authoritative:

- Run owns task-scoped User authorization and shared budget;
- Task owns objective, context boundary, capability set, and resolved Profile;
- Attempt owns one actual execution and retry history;
- Handoff owns the bounded result and User adoption/rejection state.

| Requirement | Behavior |
| --- | --- |
| OPT-REQ-039 | Run list and ordinary Thread projection MUST NOT eagerly transfer every Attempt body and tool event. |
| OPT-REQ-040 | Expanding one Task MUST load only that Task's retained details. |
| OPT-REQ-041 | Retry MUST create a new Attempt and MUST NOT overwrite a prior result or failure. |
| OPT-REQ-042 | Handoff adoption/rejection remains explicit and determines whether the result is meaningfully adopted into the parent workflow. |
| OPT-REQ-043 | `record.delete` and parent Thread deletion MUST retain existing logical deletion and provenance-placeholder behavior. |
| OPT-REQ-044 | Sub-Agent scheduling MUST NOT reuse ordinary queued-follow-up semantics because task budget, capability set, and context boundary remain distinct. |
| OPT-REQ-045 | A retention-policy change requires dogfood evidence, an ADR amendment, migration behavior, and a visible User setting; the initial optimization changes presentation and loading only. |

## Extension Admission Presentation

The primary Extension UI presents three User steps:

1. Select and inspect;
2. review findings and approve or reject;
3. enable, disable, update, or rollback.

Optional model Audit remains an explicit deeper-review action. Deterministic inspection, exact approval identity, separate enablement, invalidation, pending Global Extension Revision, atomic changeover, and retained rollback bytes remain authoritative.

| Requirement | Behavior |
| --- | --- |
| OPT-REQ-046 | Primary UI MAY collapse technical admission states into three steps but MUST show blockers, accepted residual risks, exact identity, permissions, and Trusted Worker Code disclosure before approval. |
| OPT-REQ-047 | Model Audit remains optional and advisory; it cannot approve, enable, or remove deterministic blockers. |
| OPT-REQ-048 | Approval and enablement remain separate explicit User actions. |
| OPT-REQ-049 | Enable, disable, update, and rollback retain pending-revision and global-idle changeover semantics. |
| OPT-REQ-050 | Immediate activation remains G2, checkpoints/interruption remain visible, and no Turn is automatically resumed or replayed. |
| OPT-REQ-051 | Audit execution MAY reuse generic isolated model-job supervision, but its resource, context, Memory, capability, and eligibility isolation MUST remain unchanged. |

## Integration Workflow Primitives

Do not introduce one domain-neutral authoritative state machine. Introduce reusable infrastructure and two optional workflow patterns.

```ts
interface IntegrationJobController<TRequest, TResult> {
  start(request: TRequest): Promise<IntegrationJobHandle>;
  cancel(jobId: string): Promise<IntegrationCancellationResult>;
  inspect(jobId: string): IntegrationJobProjection<TResult>;
  reconcileRestart(): IntegrationReconciliationReport;
}
```

Reusable behavior:

- bounded admission;
- cancellation and process-tree termination;
- status/progress projection;
- sanitized failure;
- result reference;
- restart reconciliation;
- content-free telemetry;
- shared desktop job card.

Suggested presentation patterns:

```text
Admission: stage -> inspect -> User decision -> activate
Task: prepare -> execute -> preview -> commit
```

Extension, Skill, MCP, Office, Skill Creator, and Page Recovery retain domain-specific invariants and states behind these shared primitives.

| Requirement | Behavior |
| --- | --- |
| OPT-REQ-052 | Shared infrastructure MUST NOT infer approval, activation, target replacement, or commit from job completion. |
| OPT-REQ-053 | Every integration keeps typed domain results and sanitized failure codes; a generic string status is not authoritative. |
| OPT-REQ-054 | New integration UI SHOULD reuse one progress/job card unless the domain requires a cognitive, trust, disclosure, or source-replacement decision. |

## Credential Configuration

Model and Academic credentials already use the same protected credential store and OS protection service. Optimization applies to configuration and lifecycle presentation, not to a replacement security system.

| Requirement | Behavior |
| --- | --- |
| OPT-REQ-055 | Model, Academic, MCP, and future comparable secret configuration SHOULD reuse one Credential field/status component. |
| OPT-REQ-056 | Stored configuration contains only non-secret references and metadata; credentials remain OS protected. |
| OPT-REQ-057 | Environment credential fallback, while present, MUST display its source without revealing its value and SHOULD emit a local deprecation notice. |
| OPT-REQ-058 | Removing Academic environment fallback requires a release note and setup migration path but no secret migration or logging. |
| OPT-REQ-059 | Model Profile and Academic source configuration remain distinct domain objects even when their credential lifecycle UI is shared. |

## System Prompt And Physical Context

No optimization in this specification removes:

- immutable System Prompt Revisions;
- the revision loaded by one Thread's Physical Model Context;
- Prompt Load Boundary behavior;
- Workflow Prompt Snapshots for Reflection and Dream.

Implementation MAY centralize revision resolution and remove duplicated lookup code. It MUST NOT make an existing context silently adopt a newer active revision after edit, restart, resume, or stage transition outside its defined boundary.

## IPC And Presentation Boundaries

Reducing IPC command count is optional. Commands MAY be combined only when their authorization, stale-state, retry, audit, and lifecycle semantics are identical.

The renderer SHOULD consume projections rather than raw persistence states:

- `DecisionProjection` for confirmation surfaces;
- `ReflectionProjection` for stage, status, label, and actions;
- `DreamProjection` for collect/review/commit progress;
- `MemoryWorkspaceProjection` for Pending/Adopted/History;
- `SubAgentRunProjection` with lazy Task details;
- `ExtensionSetupProjection` for inspect/approve/enable steps.

No projection is authoritative for commit. Host services revalidate current state and authorization on every command.

## Migration Strategy

Every structural phase uses deterministic, versioned, atomic State Schema Migration under ADR 0050.

Migration rules:

- presentation-only changes require no authoritative rewrite;
- Reflection migration maps every legacy status exactly as specified above and retains original failure/interruption facts;
- Dream state fields are deleted only after a compatibility reader and deterministic derivation tests exist;
- Memory stores remain separate, so the three-view information architecture initially requires no destructive migration;
- Sub-Agent optimization initially changes query/projection behavior only;
- Extension optimization initially changes presentation only;
- temporary compatibility readers have an explicit removal version and tests for both old and new state;
- migration failure leaves the prior state active or enters Read-only Recovery Mode; it never partially rewrites authoritative cognition.

## Delivery Slices

### O0 - Baseline And Decision Taxonomy

- Add content-free local dogfood metrics.
- Inventory every confirmation and assign G1-G4.
- Add decision projection and shared UI components.
- Record current workflow step counts and failure/recovery baselines.

Decision gate: do not delete a workflow stage or retained record based only on code inspection or assumed low frequency.

### O1 - User-Facing Quick Wins

- Project default Output directory with Thread override.
- Inline compatible/degraded Profile Capability Check.
- Aggregated material-change notification and batch Parse Refresh decision.
- Two-level Sub-Agent default UI with lazy details.
- Three-step Extension setup UI.
- Pending/Adopted/History Memory navigation.
- Dream Collect/Review/Commit projection while retaining existing orchestration.

Decision gate: G1/G2 E2E tests remain green and no stale material is silently consumed.

### O2 - Context And Execution Deep Modules

- Introduce `ContextBudgetService`.
- Introduce `ExecutionLifecycleCoordinator`.
- Centralize terminal reconciliation and queue drain.
- Add crash, restart, Unknown Outcome, and stale-event fault injection.
- Remove duplicate estimator and lifecycle branches only after parity tests.

Decision gate: no regression in interrupted-turn recovery, queue drafts, scheduler capacity, or physical-context acknowledgement.

### O3 - Reflection State Refactor

- Add new contracts and migration.
- Introduce one Reflection projector/action selector.
- Migrate Host transition methods and renderer.
- Remove legacy status checks after migration and E2E parity.

Decision gate: every legacy state fixture maps deterministically and no unfinished run changes meaning.

### O4 - Dream And Memory Orchestration

- Auto-chain reviewed scopes to synthesis.
- Adapt synthesis presentation to single/multiple scopes without a second engine.
- Auto-prepare patch after complete proposal review.
- Introduce `MemoryReviewService` and unified pending projection.
- Audit and remove only proven-derived Dream state.

Decision gate: cross-project isolation, de-identification, stale patch, cutoff/carryover, partial coverage, and explicit commit tests pass.

### O5 - Integration And Configuration Consolidation

- Introduce shared Integration Job infrastructure and UI card.
- Reuse isolated job supervision for Extension Audit without changing isolation.
- Reuse Credential configuration components.
- Deprecate and later remove Academic environment fallback.
- Remove superseded compatibility and duplicate presentation code.

Decision gate: real Office, MCP, Extension, Skill Creator, Page Recovery, Academic Research, and packaged compatibility evidence remain green.

### O6 - Evidence-Based Retention Review

- Review Sub-Agent Attempt detail-expansion and retry data.
- Review Extension history/rollback use.
- Review Condensation Archive cleanup behavior.
- Propose separate ADR changes only where measured value does not justify retention cost.

Decision gate: no default record deletion is introduced without explicit retention, provenance, backup, and migration behavior.

## Test Traceability

| Test | Requirements | Observable assertion |
| --- | --- | --- |
| OPT-T-001 Decision classification | 001-006 | Every decision surface has one class; G1/G2 cannot be bypassed through remembered preferences. |
| OPT-T-002 Output default | 004, 006 | Valid Project default avoids location dialog; missing/out-of-bound target requires User choice. |
| OPT-T-003 Material refresh | 003, 006 | Changes aggregate; use blocks for explicit create-version/replace/cancel; old parse is never silently current. |
| OPT-T-004 Capability broker | 007-011 | Missed preload activates through broker; protected actions remain blocked without User intent. |
| OPT-T-005 Context budget | 012-015 | All execution types use one estimator; contribution telemetry and boundary actions are deterministic. |
| OPT-T-006 Terminal lifecycle | 016-020 | Complete/fail/interrupt/worker-exit release once, checkpoint ordering holds, and restart starts no work. |
| OPT-T-007 Reflection migration | 021-024 | All eleven legacy states map without lost assessment, profile, prompt, failure, or resume semantics. |
| OPT-T-008 Dream normal path | 025-032 | Explicit launch auto-chains stages, displays three phases, previews patch, and requires explicit commit. |
| OPT-T-009 Dream single/multi scope | 026-031 | Single scope makes no false cross-project claim; multi-scope remains de-identified; Unscoped cannot target Project Memory. |
| OPT-T-010 Dream stale/restart | 027-032 | Stale patch blocks; restart preserves resumable state and starts no Provider call. |
| OPT-T-011 Memory projections | 033-038 | Three views cover all records; historical/superseded content is excluded from current recall. |
| OPT-T-012 Sub-Agent lazy detail | 039-045 | List omits full Attempt bodies; expansion loads one Task; retry and adoption semantics remain intact. |
| OPT-T-013 Sub-Agent deletion | 043-045 | Parent and child deletion preserve placeholders, outputs, and approved Memory behavior. |
| OPT-T-014 Extension simplified UI | 046-051 | Three steps preserve blocker, exact approval, separate enablement, trust disclosure, and atomic changeover. |
| OPT-T-015 Integration primitives | 052-054 | Shared job completion never implies domain commit or approval; cancel/restart remain typed. |
| OPT-T-016 Credentials | 055-059 | Shared component exposes readiness/source without secret; persisted configuration contains references only. |
| OPT-T-017 Prompt boundaries | Prompt section | Existing Thread/workflow keeps frozen revision until its defined boundary. |
| OPT-T-018 Migration failure | Migration section | Atomic failure leaves prior state or Read-only Recovery Mode; no partial cognition rewrite. |
| OPT-T-019 Metrics privacy | Baseline section | Telemetry contains counts/timing/revisions only and passes secret/content scan. |

## Verification Gates

Every delivery slice MUST pass:

```text
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm integration-gate
pnpm personal-build-gate
```

Release-candidate slices additionally run the applicable release gates and real compatibility evidence. O2-O5 MUST include application force-exit, Worker crash, Provider Failure, external file modification, stale commit, state migration, and migration-failure fixtures proportional to the changed scope.

## Definition Of Done

- OPT-REQ-001 through OPT-REQ-059 are implemented or explicitly deferred by an approved child specification.
- O0 establishes a content-free baseline and post-change comparison.
- Ordinary low-risk tasks meet the blocking-decision target without bypassing G1/G2 boundaries.
- Dream exposes Collect/Review/Commit while retaining isolated extraction, single synthesis path, prepared patch, explicit commit, cutoff, carryover, and stale protection.
- Reflection no longer exposes or branches directly on eleven flat persistence states.
- Memory is navigable through Pending Review, Adopted Memory, and History without collapsing authoritative stores.
- Sub-Agent default UI exposes Run and Task while retained Attempt and Handoff semantics remain inspectable.
- Extension setup exposes three User steps while exact approval and atomic global revision behavior remain unchanged.
- Context budgeting and execution lifecycle have one authoritative Host seam each.
- Existing release, migration, recovery, evidence, credential, Provider, and integration invariants remain green.

## Final Decision Gate

Stop and revise this specification if simplification requires any of the following without a separately approved ADR amendment:

- silent cognitive write or scope change;
- silent Cross-Provider disclosure;
- stale parse or stale Memory commit;
- inferred Extension approval or mixed live Extension revisions;
- automatic retry, replay, fallback, or ordinary-Turn resume;
- deletion of the only retained evidence for a Sub-Agent retry or external side effect;
- a second Dream proposal engine that duplicates existing synthesis semantics;
- rewriting authoritative Memory through a non-atomic or model-driven migration.

The optimization succeeds when ordinary use is simpler because internal complexity is progressively disclosed and deeply owned, not because trustworthy state was discarded.
