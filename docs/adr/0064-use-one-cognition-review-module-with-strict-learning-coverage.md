# Use One Cognition Review Module With Strict Learning Coverage

Status: Accepted

Date: 2026-08-11

## Context

Dream and Investment Reflection currently expose separate cognition-changing
authority paths. Dream can freeze a batch of eligible sources but its scope
context applies a fixed twelve-exchange limit, so a committed cutoff can move
past a source that was never inspected. Reflection has separate outcome and
learning transitions, and callers understand extraction, synthesis, proposal,
and patch stages that should remain implementation details.

The [Cognition Review Redesign Specification](../superpowers/specs/2026-08-11-cognition-review-redesign-spec.md)
defines the replacement boundary and the strict coverage invariant.

## Decision

VC Desktop exposes two product intents, Investment Reflection and Memory
Review, over one Host-owned `CognitionReviewModule`:

```ts
interface CognitionReviewModule {
  prepare(input: ReflectionReviewInput | MemoryReviewInput): ReviewBundle;
  decide(reviewId: string, decisions: readonly ProposalDecisionInput[]): ReviewBundle;
  commit(reviewId: string): CognitionCommitResult;
  discard(reviewId: string): void;
}
```

The Module is the only external authority transition for proposals, Judgment
Records, Project Memory, Long-term Memory, provenance, carryover, and cutoff.
Extraction, synthesis, stores, patch construction, and recovery helpers remain
internal unless a second real caller proves that another seam is necessary.

Each Memory Review freezes one cutoff and a content-free Coverage Ledger. For a
batch `B`, every frozen eligible source is in exactly one of `no_signal`,
`represented`, or `carried_over`; a `represented` disposition references an
existing proposal. Every source belongs to exactly one isolated Extraction
Chunk, and each completed chunk must return one terminal disposition per
member. Chunks are formed by the shared token/character budget service, never
by a fixed item count. Missing, duplicate, or out-of-chunk references block
the bundle, and only a successful Module commit may advance the cutoff.

Project and Unscoped extraction remains isolated and cross-project synthesis
receives only bounded de-identified results. Reflection keeps its independent
evidence and memory-aware contexts, but one explicit launch authorizes their
automatic transition. Finishing Reflection prepares exactly one Judgment Record
draft (learning proposals may be empty); one `Confirm Reflection` commit saves
the Judgment Record and all adopted learning atomically. Discard creates no
authoritative cognitive artifact.

Memory Review may be manually launched or prepared automatically after the
User grants standing opt-in. A model-free Due Check may run at startup and
state changes, but model work is admitted only after submitted work completes
and the execution scheduler is idle. Automatic preparation can produce a
Review Bundle but cannot commit Memory or confirm a Judgment Record.

The shipped product does not expose a user-selectable old/new toggle, dual
write, direct Dream commit, direct Reflection outcome commit, or stage-level
scope review as an alternate authority path.

## Consequences

- The twelve-exchange omission becomes an invariant violation rather than a
  hidden context-budget trade-off.
- Reflection and Memory Review share staleness, proposal decisions, patch
  preview, provenance, and atomic commit behavior while retaining different
  analytical prompts and scope rules.
- Automatic preparation can reduce scheduling friction without weakening the
  Cognitive Review Gate for durable cognition changes.
- Existing Dream/Reflection stores, projections, and tests must be retired
  after replacement evidence exists; they cannot remain alternate commit
  seams.
- The implementation carries a Coverage Ledger, chunk records, and durable
  commit manifests, increasing local state in exchange for exact disposition
  and restart safety.

## Supersedes

This ADR supersedes the conflicting authority or stage requirements in:

- ADR-0003, *Cross-project Two-stage Dream*: scope isolation and de-identified
  synthesis remain, but per-scope User review is no longer an authority step.
- ADR-0011, *Staged Context Isolation For Reflection*: isolated evidence and
  memory-aware contexts remain, but one Reflection launch authorizes their
  transition.
- ADR-0012, *Allow Reflection To Propose Direct Long-term Memory*: Reflection
  learning uses the shared Cognition Review commit path.
- ADR-0025, *Gate Durable Actions On User Intent*: standing opt-in permits
  non-authoritative automatic preparation; final cognition commit remains
  explicit.
- ADR-0029, *Recover Missed Memory Signals During Dream*: eligible-source
  recovery now requires deterministic disposition rather than scope sampling.
- ADR-0031, *Use One Dream Cutoff With Explicit Carryover*: one cutoff and
  carryover remain, but the Coverage Ledger is authoritative and the cutoff
  advances only through the shared commit.
- ADR-0032, *Avoid A Per-turn Memory Classifier Call*: deterministic capture
  remains, with strict batch coverage replacing best-effort recovery.
- ADR-0042, *Use Two Access Modes And Preserve Cognitive Review*: the
  preserved gate is the Reflection launch and final shared cognition commit;
  automatic preparation is not a cognitive commit.
- ADR-0054, *Launch Empty And Activate Pi Only On Submitted Work*: startup may
  perform only a model-free Due Check; automatic model work waits for an idle
  scheduler boundary.

ADR-0053, *Limit Long-Term Memory To De-identified Cross-project Learning*,
remains governing without change. ADR-0065 governs the separate Learning Epoch
reset and legacy-cognition disposal required before production cutover.
