# Learning Build Implementation Plan

Date: 2026-07-18

Source: `docs/superpowers/specs/2026-07-06-vc-desktop-agent-design.md`

Blocked by: completed Foundation and Dogfood Build through commit `49f743d`.

## Objective

Close the first durable personal-learning loop for the sole User: preserve de-identified cross-Project investment learning, recall it selectively, examine a Project or Unscoped judgment through an explicit two-stage Investment Reflection, consolidate ordinary candidates through Dream, retain cognitive evolution, and export or migrate that cognition without silently changing its meaning.

This plan covers only the Learning Build. Office Skills, OCR recovery, MCP, Skill Import, Skill Creator, arbitrary Extension admission, Extension Audit, Sub-Agent Runs, broad execution concurrency, distribution, and multi-user behavior remain out of scope.

## Confirmed Product Direction

- Investment Reflection is the first user-visible learning workflow; Dream follows and reuses the same Memory Evolution and patch-commit path.
- A Project Reflection may start from the broad objective `Review this Project`. A narrower question and selected Material range are optional.
- Broad launch supplies a bounded Reflection Project Brief and uses Progressive Material Disclosure. It never loads the whole Project eagerly.
- The Independent Evidence Pass receives no Project Memory or Long-term Memory.
- The Memory-Aware Reflection Pass autonomously queries relevant Memory after the Independent Assessment exists.
- Memory relevance may be direct through Local Memory Provenance or inferred from Project context, industry, financing stage, risk, diligence question, counterargument, and uncertainty.
- `explicit-only` Long-term Memory is never included merely because Reflection was launched.
- Investment Reflection is the default framing. Investment Retrospective applies only when the User refers to later evidence, subsequent developments, observed outcomes, or whether an earlier judgment held.
- Ordinary Long-term Memory recall is de-identified. Project identity and source drilldown remain local and User-inspectable.

## Planning Rules

- Build vertical slices with a visible desktop path, durable state, failure behavior, migration coverage, and tests.
- Introduce migration safety before adding durable cognitive domains.
- Keep Markdown authoritative for user-editable Memory and cognitive history; SQLite and JSON indexes remain rebuildable or operational.
- Use one Memory Evolution and atomic patch application path for Reflection and Dream.
- Do not create a general workflow engine, multi-agent runtime, event-sourcing framework, embedding service, or vector database.
- Implement Reflection-specific stage orchestration first. Extract a shared resumable-workflow module only when Dream exercises the same lifecycle behavior.
- Keep the Cognitive Review Gate under both Access Modes. Workflow launch/resume and Memory writes always require explicit User action.
- Do not add a per-turn classifier model call. Recall and candidate discovery use current-stage reasoning plus deterministic local retrieval.
- Provider Failure never causes automatic retry, Profile fallback, Provider switching, stage skipping, or Memory writes.
- Treat the accepted design specification, glossary, and ADRs as behavioral authority. This plan only orders implementation.

## Current Foundation To Reuse

| Existing path | Learning Build use |
| --- | --- |
| Host-owned Thread Trajectory and recovery | Reflection dialogue, Dream eligibility, source references, interruption audit |
| Project Identity | Local Memory Provenance and Project-isolated Dream extraction |
| Project Memory Markdown and parser | Project-targeted Dream patches; parser conventions, not a global-memory substitute |
| `memory_recall` source contract | Add the real `long_term_memory` adapter without changing Pi session orchestration |
| Memory Candidate Store | Captured Dream inputs; extend disposition and source metadata without rewriting historical capture events |
| Progressive Material Disclosure | Independent Evidence Pass and bounded Evidence Drilldown |
| System Prompt Revisions | Frozen Workflow Prompt Snapshot for Reflection and Dream |
| Capability Registry and Host Gateway | Protected workflow support and explicit Memory patch commit |
| Model Profiles | Task Model Assignments and launch-time workflow Profile override |
| Runtime resource snapshots | Stage-specific instructions without enlarging the Minimal VC System Prompt |
| Environment Doctor and local telemetry | Workflow configuration, storage, token, latency, coverage, and failure inspection |

## Durable Domain Boundaries

Default user-level cognition location:

```text
<app-data>/memory/long-term/
  long-term-memory.md
  long-term-memory-condensation-archive.md
  cognitive-evolution-history.md
```

App-owned operational and provenance state:

```text
<app-data>/memory/
  long-term-index/
  local-memory-provenance.jsonl
  candidates.jsonl
  dream/
  reflection/
```

Rules:

- Active Memory Markdown stores stable opaque entry and source-reference ids but no source Project name or path.
- `local-memory-provenance.jsonl` maps opaque source references to Project Identity, workflow run, Judgment Record, Thread, Turn, Output, and eligible evidence references. It is transparent local operational state, excluded from ordinary Provider payloads and Personal Cognition Backup.
- Cognitive Evolution History preserves semantic lineage, earlier wording, contemporaneous rationale, Memory Evolution Action, and opaque source references. It does not require source Project availability.
- The Condensation Archive stores merge and wording-condensation history only. `Narrow`, `Revise`, and `Contradict` belong in Cognitive Evolution History.
- Derived indexes can be deleted and rebuilt from authoritative files plus retained local provenance mappings.
- Manual edits remain authoritative. The Host never infers a Memory Evolution Action or manufactures provenance from a textual diff.

## Learning Slices

### L0. Establish The Safe Migration Boundary

**Blocked by:** Dogfood Build complete.

**What to build:** Replace direct best-effort startup migration with a deterministic migration coordinator for vc-agent-owned state. Add version inspection, bounded rollback copies, staged transformation, complete validation, atomic activation, sanitized failure diagnostics, and Read-only Recovery Mode for state newer than the application.

**Why first:** Long-term Memory, provenance, Reflection, and Dream create durable cognition whose meaning cannot be repaired by a later guessed migration.

**Acceptance criteria:**

- [x] Opening current schema state remains behaviorally unchanged and does not start Pi.
- [x] A supported older fixture migrates through a staged destination and activates only after complete validation.
- [x] Injected failure before activation leaves the previous database and files byte-for-byte active and writable after rollback.
- [x] Migration never calls a model, rewrites user-authored Memory text, infers provenance, or changes investment meaning.
- [x] Derived indexes may be rebuilt without becoming authoritative migration input.
- [x] Newer stored state enters visible Read-only Recovery Mode before any ordinary Turn or state mutation can begin.
- [x] Read-only Recovery Mode permits inspection and supported export but blocks Threads, Memory edits, workflow commits, settings writes, and Project system writes.
- [x] Environment Doctor reports active schema, pending migration, rollback availability, and sanitized failure state.

### L1. Make Long-term Memory Authoritative And Recallable

**Blocked by:** L0.

**What to build:** Create the three Markdown-first Long-term Memory files lazily, define stable entry parsing, support direct internal and external edits, rebuild a deterministic bilingual index, and replace the unavailable `long_term_memory` recall branch with bounded card-then-expand retrieval.

**User stories covered:** Inspect and edit global personal cognition; use relevant learning in Project and Unscoped Threads without loading Project data.

**Acceptance criteria:**

- [x] First launch creates no Long-term Memory file; opening the Settings memory view creates the minimal active file lazily.
- [x] Settings shows the global location, open-folder, refresh/re-index, file summary, warnings, and recent update state.
- [x] Active entries carry stable id, version, current status, title, tags, applicability, maturity, Recall policy, conflict state, content, and opaque source references.
- [x] The parser preserves malformed content, indexes only safe entries, and surfaces warnings without an LLM repair.
- [x] External edits change the authoritative version and rebuild the derived index without starting Pi.
- [x] Automatic Judgment Recall searches only `automatic` entries relevant to judgment-heavy work.
- [x] Explicit Memory Recall bypasses task classification but not relevance, scope, de-identification, conflict, active-version, or budget rules.
- [x] `explicit-only` entries appear only after an explicit request that covers them.
- [x] Unscoped recall returns de-identified Long-term Memory and cannot access a source Project, Project Memory, Project Context, Materials, or Outputs.
- [x] Conflicting active views are returned together and identified as Memory rather than source evidence.
- [x] Ordinary recall payloads contain no Project identity, company name, path, unpublished metric, transaction term, original excerpt, or local provenance mapping.

### L2. Apply Memory Evolution Without Rewriting History

**Blocked by:** L1.

**What to build:** Add a typed Memory Patch and one Host-owned compare, preview, stale-check, and atomic commit path for `Add`, `Reinforce`, `Narrow`, `Revise`, `Contradict`, and `Merge / Condense`. Persist Local Memory Provenance, Cognitive Evolution History, and Condensation Archive changes as one validated transaction.

**User stories covered:** Safely improve personal cognition while preserving prior reasoning and unresolved disagreement.

**Acceptance criteria:**

- [x] Every patch records base hashes for all target files and becomes stale after a manual or workflow write changes any target.
- [x] `Add` creates a new stable entry; `Reinforce` adds provenance or maturity without duplicating meaning.
- [x] `Narrow` and `Revise` create a new current version and preserve prior wording and rationale in Cognitive Evolution History.
- [x] `Contradict` preserves both substantive views as an Unresolved Memory Conflict.
- [x] `Merge / Condense` moves removed redundant content to the Condensation Archive and does not create false cognitive evolution.
- [x] Recency, repetition, confidence language, or model preference cannot select `Revise` over `Contradict`.
- [x] A final Markdown and lineage diff is visible before commit; confirmation remains mandatory in Full Access.
- [x] Commit either activates every active-memory, history, archive, provenance, and index change or activates none.
- [x] Manual edits and deletions do not infer evolution actions, archive entries, provenance, or history.
- [x] Archive retention settings support 30, 90, 180, 365 days, or permanent; automatic deletion is off by default and never includes Cognitive Evolution History.
- [x] Source drilldown is available only inside the source Project under its Provider Authorization; missing or restored-away sources remain visibly unavailable.

### L3. Run A Broad Project Independent Evidence Pass

**Blocked by:** L0 and Dogfood material/context/output paths.

**What to build:** Add explicit `Start Reflection` for a Project, an optional focus input, deterministic Reflection Project Brief creation, Workflow Prompt Snapshot, Reflection-specific task instructions, Task Model Assignments, launch-time Profile override, and an isolated Independent Evidence Pass that uses Progressive Material Disclosure without Memory.

**User stories covered:** Start a useful Project Reflection by saying only `Review this Project` while retaining an unbiased first assessment.

**Acceptance criteria:**

- [x] Reflection starts only from explicit User action and creates a dedicated Investment Reflection Thread and run record.
- [x] The default objective examines the current view, assumptions, risks, counterarguments, and potentially applicable prior learning; focus and Material selection remain optional.
- [x] A request mentioning later outcomes or whether an earlier judgment held is visibly framed as Investment Retrospective.
- [x] Launch freezes scope, Project Identity, objective, Reflection Project Brief version, Workflow Prompt Snapshot, and effective Independent Evidence Profile.
- [x] The Reflection Project Brief contains only bounded basic context fields, Material cards, and record or Output references; it excludes Memory, prior conclusions, paths, and Material bodies.
- [x] Independent Evidence Pass receives no Project Memory, Long-term Memory, Memory index result, or Local Memory Provenance.
- [x] The model chooses evidence progressively and emits a bounded Independent Assessment with conclusions, uncertainty, rationale, counterarguments, stable evidence references, and decision-changing questions.
- [x] Missing assignment or Profile leaves the run locally visible and retryable without starting Pi or selecting a fallback.
- [x] Provider Failure preserves the brief and run state, exposes sanitized details, and requires manual retry or Profile adjustment.
- [x] App restart displays the run and completed assessment without starting Pi; unfinished model work resumes only after explicit action.

### L4. Complete Memory-Aware Reflection And Confirm Outcomes

**Blocked by:** L1, L2, and L3.

**What to build:** Start a separate Memory-Aware Reflection context from the Independent Assessment, autonomously retrieve relevant Memory, support bounded Evidence Drilldown, conduct critical user-facing dialogue, and prepare optional Judgment Records and Long-term Learning Proposals through the shared Memory Patch path. Extend the same workflow to Unscoped scope.

**User stories covered:** Discuss and improve an investment judgment; directly preserve reviewed cross-Project learning without a Dream run.

**Acceptance criteria:**

- [x] The second stage receives the bounded Independent Assessment, objective, and permitted stage instructions but not first-stage raw materials, transcript, full context, or hidden reasoning.
- [x] It autonomously queries Memory using the Assessment and Project brief, starting from cards and expanding selectively.
- [x] Direct same-Project provenance may rank a candidate higher but is not exposed in the Provider payload and never makes the Memory authoritative.
- [x] Inferred relevance uses applicability, industry, financing stage, risk, diligence questions, counterarguments, and uncertainty.
- [x] Every recall is visible and budgeted; `explicit-only` remains excluded without explicit User intent.
- [x] The Critical Reflection Stance distinguishes evidence, historical User judgment, and new inference; it challenges Memory when reasoning or evidence warrants.
- [x] Evidence Drilldown retrieves only bounded excerpts behind stable references and marks unsupported handoff claims rather than trusting the Assessment.
- [x] The conversation may remain unresolved or be discarded without creating a Judgment Record or Memory patch.
- [x] A confirmed Judgment Record preserves view, reasoning, uncertainty, counterarguments, evidence references, decision state, and source availability.
- [x] A Long-term Learning Proposal states de-identified applicability, limitations or counterexamples, maturity, and source references, then compares against relevant active Memory.
- [x] Applying the proposal uses the L2 preview and confirmation path; Reflection cannot bypass Dream by bypassing Memory Evolution rules.
- [x] Project Reflection stores its Judgment Record with the Project; Unscoped Reflection uses the selected Unscoped Output Location and never accesses Project State.
- [ ] Reflection dialogue is Dream-eligible only where the User meaningfully adopts, corrects, or confirms a view; the Independent Evidence Pass remains ineligible.
- [ ] Restart recovery reuses unchanged completed stages under the frozen prompt and marks target-dependent proposals stale after relevant Memory or evidence changes.

### L5. Create Dream Batches Without Hidden Model Work

**Blocked by:** L0, L1, retained trajectory, and Memory Candidates.

**What to build:** Add model-free Dream Due Check, Pending Dream Reminder, explicit manual launch, one frozen Dream Cutoff, Dream Carryover, eligible-trajectory selection, source-deletion cascade, Workflow Prompt Snapshot, Dream Task Model Assignment, and persisted resumable run state.

**User stories covered:** Review accumulated learning periodically without background execution or losing unresolved candidates.

**Acceptance criteria:**

- [ ] The default seven-day Due Check reads scheduling metadata only and never creates a batch, reads trajectory content, starts a Worker, or calls a Provider.
- [ ] Manual launch and approval of a due proposal create exactly one batch and freeze one shared cutoff at the latest eligible completed user-facing session.
- [ ] New sessions after the cutoff belong to the next batch and do not make current results stale.
- [ ] Eligible trajectory includes ordinary Project and Unscoped user-facing dialogue plus Memory-Aware Reflection dialogue; it excludes Dream, Independent Evidence Pass, internal work, pure tools, and unadopted assistant output.
- [ ] Captured and recovered candidates retain attributable Thread, Turn, timestamp, scope, source kind, and bounded source reference.
- [ ] Deleted trajectory cannot be scanned and cascades content out of pending/archive candidates as specified; archived trajectory remains eligible.
- [ ] Keep Pending, skipped, failed, and otherwise unresolved inputs become explicit Carryover even after a cutoff advances.
- [ ] A resumable run or Carryover produces an immediate non-blocking reminder without starting model work or creating a new batch.
- [ ] Resume and Discard resolve an existing run before a new periodic batch can start.
- [ ] Workflow launch and resume remain explicit under Full Access and freeze the Dream prompt and effective Profile assignments.

### L6. Extract And Review Dream Scopes In Isolation

**Blocked by:** L5 and Project Memory.

**What to build:** Run one isolated Project Dream Extraction Pass per represented Project and one isolated Unscoped extraction per represented Thread, recover missed signals progressively, produce bounded de-identified summaries, persist each stage, and add per-scope review, retry, skip, and Keep Pending decisions.

**User stories covered:** Recover missed personal signals without mixing raw context across Projects or silently omitting failed scopes.

**Acceptance criteria:**

- [ ] A Project extraction sees only that Project's candidates, relevant Project Memory, and bounded eligible trajectory excerpts.
- [ ] An Unscoped extraction sees only one Unscoped Thread and has no Project Memory destination or inferred Project association.
- [ ] Recovered candidates require attributable User signal or a confirmed Judgment Record; materials, web, OCR, tools, and ordinary assistant text cannot become personal Memory.
- [ ] Each result includes source references, uncertainty, candidate origin, proposed destination, and a bounded Project or Unscoped summary without raw trajectory or full reasoning.
- [ ] Project summaries are de-identified before leaving the scope-local review stage and carry opaque source references rather than Project identity.
- [ ] The User can approve, retry, skip, or Keep Pending without manually editing summaries.
- [ ] A failed scope remains Pending with its sanitized Provider Failure and never triggers automatic retry, fallback, or silent exclusion.
- [ ] Global synthesis remains blocked until every scope succeeds or is explicitly skipped.
- [ ] Explicit skip creates visible Partial Dream Coverage and Carryover for the missing scope.
- [ ] Restart retains completed scopes and decisions; only stale scopes rerun after explicit resume.

### L7. Synthesize Dream And Commit Reviewed Memory Patches

**Blocked by:** L2 and L6.

**What to build:** Add isolated Global Dream Synthesis over approved de-identified summaries, relevant Long-term Memory cards, and opaque references; classify destination and Memory Evolution relationship; preview Project and Long-term Markdown patches; and commit through the shared atomic Memory path.

**User stories covered:** Consolidate ordinary work into Project Memory and durable cross-Project learning with low-friction review.

**Acceptance criteria:**

- [ ] Global synthesis receives no Project names, paths, unnecessary deal facts, combined raw trajectory, or cross-Project source excerpts.
- [ ] Proposed Long-term Memory remains no more specific than industry, financing stage, or comparable reusable investment situation.
- [ ] Proposals distinguish Project Memory, Long-term Memory, Keep Pending, Discard, and Merge / Condense.
- [ ] Project Memory is eligible only for a proposal with one unambiguous source Project and writes back to that Project.
- [ ] Each Long-term proposal compares against active Memory and uses the L2 evolution semantics.
- [ ] Frequency and confidence cannot silently replace a prior judgment or resolve a conflict.
- [ ] The UI supports bulk proposal review while retaining per-item destination change and uncertainty inspection.
- [ ] Run approval does not authorize writes; final Markdown patch preview and confirmation remain separate.
- [ ] Partial Dream Coverage remains visible in synthesis, proposal, patch, and completed batch records.
- [ ] Target Memory changes make synthesis or prepared patches stale and block commit until explicit regeneration and review.
- [ ] Successful commit archives resolved candidates, records the committed cutoff, retains Carryover, and updates Memory, history, archive, provenance, and indexes atomically.

### L8. Back Up And Restore Personal Cognition

**Blocked by:** L2 and stable Learning schemas. May proceed after L4 while L5-L7 are implemented, but the Learning Gate waits for all slices.

**What to build:** Add explicit transparent Personal Cognition Backup and mechanical Restore with a versioned manifest, checksums, empty-state restore, confirmed whole-domain replacement, and no semantic merge.

**User stories covered:** Preserve durable cognition and reconstructible personal configuration without exporting Projects or secrets.

**Acceptance criteria:**

- [ ] Backup includes Long-term Memory, Cognitive Evolution History, Condensation Archive, System Prompt Revisions, Model Profiles and task assignments, non-secret settings, and the VC Agent Skills Directory when present.
- [ ] Thread and Sub-Agent trajectories are optional and excluded by default.
- [ ] Backup excludes Project registry, names, ids, paths, references, Materials, Outputs, parses, Project Context, Project Memory, artifact state, local provenance mappings, pending candidates, Dream/Reflection run state, caches, logs, and Physical Model Context.
- [ ] Protected Credentials are never exported; restored Profile references require fresh credential setup.
- [ ] The transparent manifest records format/schema version, domain inventory, checksums, creation time, and security warning without absolute Project paths.
- [ ] Restore validates the complete bundle before replacing any domain and performs no LLM call, Memory merge, duplicate inference, or provenance manufacture.
- [ ] Restore into non-empty personal state requires explicit whole-domain replacement confirmation under both Access Modes.
- [ ] Failed restore leaves all prior domains active and unchanged.
- [ ] Semantic lineage and opaque source references survive; excluded Project provenance is shown as unavailable.
- [ ] Backup and Restore remain Host-only and do not start Pi.

## Learning Exit Slice

### G2. Pass The Durable Learning Workflow Gate

**Blocked by:** L0-L8.

**What to build:** Stabilize one complete Project Reflection-to-Memory path, one Unscoped recall path, one multi-scope Dream path, and migration/backup failure recovery through visible UI actions.

**Acceptance criteria:**

- [ ] One Playwright scenario broadly launches Project Reflection, completes isolated evidence assessment, recalls relevant Project and Long-term Memory, conducts dialogue, confirms a Judgment Record, previews a Memory Evolution Action, commits it, restarts, and recalls the resulting learning from an Unscoped Thread.
- [ ] The scenario proves ordinary recall contains no Project identity while local source inspection resolves the originating Project under authorization.
- [ ] A Retrospective fixture revises or contradicts an earlier judgment without erasing its original rationale.
- [ ] A Dream E2E spans at least two Projects and one Unscoped Thread, proves raw-scope isolation, reviews summaries, handles one failed/skipped scope, displays Partial Dream Coverage, confirms final patches, and retains Carryover.
- [ ] Restart recovery preserves completed Reflection and Dream stages but starts no Pi until explicit resume or submitted work.
- [ ] Missing Profile, Provider Failure, stale evidence, external Memory edit, stopped workflow stage, failed patch commit, and manual retry never cause fallback, duplicate writes, or silent stage reuse.
- [ ] Migration failure restores prior state; newer state opens read-only; Personal Cognition Backup/Restore preserves supported cognition without Project metadata or credentials.
- [ ] Telemetry exposes stage prompt/tool/context/recall/output reserve, latency, token contribution, coverage, and failure counters without remote content telemetry.
- [ ] Architecture tests exercise migration, Long-term Memory source, Memory Patch Store, Reflection runner, Dream runner, provenance registry, and backup adapters without importing Integration or Delegation feature code.
- [ ] Office, OCR, MCP, Skills, Extension Audit, arbitrary Extensions, and Sub-Agent controls remain absent as working features.
- [ ] The sole User can move from ordinary VC work to reviewed durable personal learning without developer intervention.

## Dependency Graph

```text
Dogfood -> L0 -> L1 -> L2 --------------------+-------> L7 ----+
              |                               |                 |
              +-------> L3 -> L4 -------------+                 +-> G2
              |                   |                              |
              +-------------------+-> L5 -> L6 -----------------+
                                  |                              |
                                  +-------> L8 ------------------+
```

L8 may be implemented after L4 once the backed-up schemas are stable, but no Dream run state, pending review queue, or Local Memory Provenance mapping becomes part of the backup when L5-L7 arrive.

## Stage Gate

**Learning Build complete:** L0-L8 and G2 pass. The User can explicitly examine a current or retrospective investment judgment, preserve its reviewed result, recall de-identified personal learning across scopes, consolidate ordinary candidates through Dream, inspect cognitive evolution and local provenance, and back up or migrate durable cognition without hidden model work or automatic Memory change.

Integration Build must consume these stable Memory, workflow, migration, Capability, and backup boundaries. It must not reinterpret existing cognition, expose pending workflow state as a Skill, allow an Extension to bypass the Cognitive Review Gate, or require Office, OCR, MCP, or Skills to open and use Learning state.
