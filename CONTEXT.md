# VC Desktop Agent

This context defines the product language for a desktop agent client focused on VC project work. The terms here describe the user-facing domain, not implementation internals.

## Language

**VC Desktop Agent**:
A single-user desktop agent client for Project and Unscoped VC work, with VC behavior enabled by default.
_Avoid_: General Pi Desktop Host as product label, CLI wrapper

**Personal Build**:
The first usable VC Desktop Agent release assembled and used only by the User, without distribution to another person or organization.
_Avoid_: Public release, redistributable package, multi-user product

**Dogfood Build**:
An incomplete but end-to-end runnable internal build used by the sole User for real VC work before every Personal Build commitment is finished.
_Avoid_: Infrastructure demo, complete Personal Build, public alpha, mock workflow

**Primary Product Loop**:
The first-release path from project materials or a research question, through evidence-backed investment analysis and document output, into user-triggered reflection and durable personal Investment Learning.
_Avoid_: Feature checklist, runtime proof, memory-only workflow

**User**:
The sole investor served by one VC Desktop Agent installation and its accumulated project state, memory, and investment learning.
_Avoid_: Tenant, team member, investor profile, shared account

**Project**:
A local folder opened in the app as the workspace for a VC opportunity, diligence effort, or related body of work.
_Avoid_: Workspace, repo, .pi-vc workspace

**Project Identity**:
A stable identity carried by a Project folder that preserves its Threads, workflow state, authorization associations, and provenance when the folder path changes.
_Avoid_: Absolute path, folder name, content fingerprint, Project backup identity

**Project Identity Collision**:
The state in which two opened folder locations carry the same Project Identity and require the User to classify the new location as a moved Project or an independent Project copy.
_Avoid_: Automatic move inference, silent identity duplication, content-based merge

**Thread**:
An independent user-visible conversation unit, either a Project Thread or an Unscoped Thread, with its own model context.
_Avoid_: Chat, session when discussing user-visible conversation units

**Thread Compaction**:
An automatic or User-invoked runtime reduction of a long Thread's model context that preserves the current objective, decisions, constraints, unresolved work, and important references without becoming Project Context or Memory.
_Avoid_: Memory condensation, Thread summary as durable knowledge, cross-Thread context sharing

**Physical Model Context**:
The current model-facing representation of one Thread, including retained messages, tool results, and any Thread Compaction needed to continue model work; it may differ from the complete Thread Trajectory.
_Avoid_: Thread Trajectory, Project State, Memory, complete audit history

**Turn-scoped Retrieval Payload**:
The full model-facing content returned by a retrieval or other large read tool for the Turn that requested it, replaced in later Turns by a Context Reference unless retrieved again.
_Avoid_: Permanent model context, Thread Trajectory deletion, Memory write, compaction summary

**Context Reference**:
A compact model-facing pointer that preserves the identity, source range, version, and status needed to retrieve a retired Turn-scoped Retrieval Payload again without carrying its full body into every later Turn.
_Avoid_: Source evidence body, Memory entry, Thread Compaction, broken plain-text placeholder

**Project Thread**:
A Thread that belongs to one Project and may use that Project's shared Project State without sharing model context with other Threads.
_Avoid_: Unscoped Thread, shared conversation context

**Unscoped Thread**:
A Thread that does not belong to a Project and has no implicit access to any Project State, project materials, or project files. It may use files attached directly to that Thread and relevant user-level Long-term Memory through Memory Recall.
_Avoid_: Empty Project, Global Chat, cross-project Thread

**Thread Scope Elevation**:
An explicit user-initiated conversion of an Unscoped Thread into a Project Thread, after which it inherits the target Project's standard access policy. The User selects the Project and separately decides whether to import direct attachments.
_Avoid_: Automatic project association, agent-initiated elevation, Thread-level access policy, silent file import

**Project State**:
Shared project-level facts and files that can be used across Threads, including Context, Project Memory, Outputs, provider status, and artifact metadata.
_Avoid_: Shared model context, chat history

**SDK-native Capability**:
A capability provided by the Pi SDK/runtime itself, such as session lifecycle, streaming events, tool registration, model/auth handling, resource loading, skills formatting, or extension hooks.
_Avoid_: VC product behavior, Host policy

**Host-registered Capability**:
A VC Desktop-owned tool, command, provider wrapper, or policy surface registered into the Pi SDK runtime.
_Avoid_: Pi built-in tool, arbitrary extension behavior

**Minimal Default Harness**:
The ordinary-turn agent configuration that keeps the stable VC instructions, active capabilities, recalled state, loaded Skills, and disclosed materials limited to what the current task needs.
_Avoid_: Pi as automatic token discount, full capability preload, eager Project context, coding-agent prompt inheritance

**Lazy Agent Activation**:
The rule that application launch, Project opening, Thread creation, and Thread inspection remain local Host actions, while a Pi worker and model session start only when the User submits model-backed work.
_Avoid_: Startup worker, default Thread, default Model Profile, eager session restore

**Host-only Operation**:
An explicit or deterministic local application action that can inspect or transform authorized local state without starting Pi, calling a model, or contacting a Provider.
_Avoid_: Agent Turn, hidden model call, Pi-backed Skill, unrestricted background work

**Pi-backed Work**:
User-submitted work that requires a Pi worker, model session, Provider call, or model-orchestrated Skill or workflow.
_Avoid_: Project browsing, local index rebuild, deterministic parsing, application startup

**Minimal VC System Prompt**:
The concise, user-editable VC identity and behavioral contract whose active revision is included in every ordinary model context regardless of Thread scope or activated workflow.
_Avoid_: Hidden prompt, full workflow manual, Project-specific context, mutable Memory content

**System Prompt Revision**:
A saved version of the Minimal VC System Prompt with provenance, diff, activation state, and a path to restore the shipped default.
_Avoid_: Memory version, silent prompt mutation, untracked overwrite

**Prompt Load Boundary**:
The creation or rebuild of a Thread's physical model context when its first Pi-backed Turn is submitted, it is continued after application restart, or Thread Compaction occurs; the context loads the active System Prompt Revision and retains it until the next boundary.
_Avoid_: Mid-context hot reload, same-Thread clear or reset, retroactive message change, prompt edit as immediate cache invalidation

**Workflow Prompt Snapshot**:
The System Prompt Revision fixed when an Investment Reflection or Dream run begins and used by every stage and resume of that run so its judgments remain internally consistent.
_Avoid_: Prompt copy, latest revision on resume, mixed-revision workflow, ordinary Thread prompt state

**Task-activated Capability**:
A Host-registered Capability added to the active model tool surface only when the current user intent, attachment, or explicit workflow requires it within existing authorization.
_Avoid_: All-tools-by-default, separate classifier call, permission expansion, permanently active workflow tool

**Capability Activation Request**:
A bounded request from the primary Agent during its existing Turn to expose an additional Task-activated Capability needed for the current task, subject to Host availability, scope, and authorization checks.
_Avoid_: Auxiliary classifier call, capability execution, Access Mode change, standing Thread permission, Sub-Agent authorization

**Model Profile**:
A named, reusable model configuration that selects a Provider, Model, relevant generation, context-budget, and capability settings, and may map common Sub-Agent roles to other Model Profiles.
_Avoid_: Task type, Provider account, hard-coded model name

**Profile Capability Check**:
A pre-execution comparison between the current task's indispensable model capabilities and the selected Model Profile, resulting in compatible execution, a visible defined degradation, or a blocking incompatibility.
_Avoid_: Automatic Profile switch, hidden fallback, continuous Provider probing, capability guarantee

**Sub-Agent Model Assignment**:
An optional role-to-Model-Profile mapping attached to a Model Profile for common delegated roles, including a Default Sub-Agent mapping for roles without a specific match.
_Avoid_: Fixed Agent instance, automatic Provider fallback, Task Model Assignment

**Task Model Assignment**:
The user-configured mapping from a product task type to its default Model Profile.
_Avoid_: Automatic provider routing, manual per-prompt selection, model fallback

**Active Model Profile**:
The Model Profile currently effective for a Thread, initialized from the applicable Task Model Assignment and replaced by a Thread Model Override when the User selects another profile.
_Avoid_: Permanent task assignment, hidden model selection, direct Provider switch

**Thread Model Override**:
A user-selected Model Profile that remains active for the current Thread until the User selects another profile or restores the applicable Task Model Assignment.
_Avoid_: One-turn override, task assignment edit, inheritance by independent workflows

**Cross-Provider Thread Continuation**:
An explicit User choice to continue an existing Thread with a different Provider by sending that Provider the Thread's retained context, including content already disclosed or recalled into it.
_Avoid_: Model-only switch, automatic context redaction, Provider fallback, new Thread

**Provider Failure**:
A failed model interaction shown inline as a sanitized, readable error parsed from the Provider or SDK response, after which the User decides whether to retry or change the Active Model Profile.
_Avoid_: Silent retry, automatic fallback, raw secret-bearing payload

**Transparent Local Storage**:
The local-first policy that keeps project content, Memory, Outputs, and inspectable Agent state as ordinary user-accessible files or app data without a separate vc-agent content-encryption vault.
_Avoid_: Cloud sync, application-encrypted workspace, credential storage, public data

**Operational State**:
App-owned coordination metadata needed to locate Projects and Threads, schedule execution, apply configuration, and resume explicit workflows without becoming authoritative Project content, personal cognition, or model context.
_Avoid_: Project State, Memory, Thread Trajectory, Physical Model Context, derived cache

**Protected Credential**:
A Provider key, OAuth token, refresh token, or comparable secret stored through the operating system's protected credential facility while vc-agent configuration retains only a non-secret reference.
_Avoid_: Plaintext API key, environment dump, encrypted project content

**Logical Deletion**:
Removal from vc-agent's active storage, indexes, recall, and normal UI without claiming physical secure erasure from the filesystem, SSD, backups, or external copies.
_Avoid_: Cryptographic erasure, guaranteed recovery prevention, archive

**Interrupted Turn**:
An ordinary Thread turn that ended before completion because it was cancelled, the application exited, or its worker or connection failed, while retaining every completed message and tool event without automatically resuming or replaying execution.
_Avoid_: Provider Failure only, automatic continuation, complete response, discarded trajectory

**In-flight Turn Checkpoint**:
A temporary recoverable snapshot of the latest durable user-visible partial response and unfinished tool state for one Active Turn, removed after its terminal Thread Trajectory events are committed.
_Avoid_: Thread Trajectory, per-token log, resumable model execution, hidden reasoning archive

**Active Turn**:
The single model-and-tool Turn currently executing in one Thread. A Thread cannot have a second Active Turn, but Active Turns in different Threads may run concurrently.
_Avoid_: Active Thread, queued prompt, background daemon

**Queued Follow-up**:
A User message accepted while its Thread already has an Active Turn or the installation-wide concurrency limit is reached, kept as an editable and cancellable next Turn without changing the objective of the Active Turn.
_Avoid_: Mid-turn steering, automatic submission after restart, hidden prompt queue

**Execution Queue**:
The visible installation-wide ordering of Queued Follow-ups waiting for an available execution slot under the bounded global concurrency limit.
_Avoid_: Background job scheduler, post-exit execution, model-managed queue

**Sub-Agent Run**:
A delegation scope explicitly requested by the User for one current task, within which the primary Agent may autonomously create, organize, and stop Sub-Agent Tasks without gaining standing authorization for later tasks.
_Avoid_: Default ordinary Turn, permanent Thread mode, hidden auxiliary model call

**Sub-Agent Task**:
A bounded internal model task created inside an authorized Sub-Agent Run with its own objective, context, Model Profile, Sub-Agent Capability Set, status, and result handed back to the primary Agent.
_Avoid_: User-visible Thread, shared raw context, direct Memory source

**Sub-Agent Capability Set**:
The minimal task-specific tools and allowed side-effect class assigned to one Sub-Agent Task by the primary Agent, never an automatic copy of the primary Agent's full capability surface.
_Avoid_: Access Mode, permanent role permissions, inherited full tool set, Memory write capability

**Sub-Agent Budget**:
The task-scoped limits applied to one Sub-Agent Run, consisting of a maximum number of flat Sub-Agent Tasks and an optional shared Token Budget, initialized from the primary Model Profile and explicitly overridable by the User for that task.
_Avoid_: Global concurrency limit, monetary budget, recursive Agent depth, Full Access permission

**Sub-Agent Task Record**:
The locally retained, user-inspectable structured trajectory of one Sub-Agent Task, including its delegated objective, instructions, references, Model Profile, messages, tool events, Attempts, usage, errors, and bounded result without hidden reasoning or secret-bearing raw Provider payloads.
_Avoid_: Primary Agent context, Memory source, Chain of Thought archive, opaque background log

**Sub-Agent Attempt**:
One execution of a Sub-Agent Task under a specific instruction and Model Profile, retained separately when the User retries or changes the model instead of overwriting an earlier result.
_Avoid_: Automatic retry, replacement of failure history, new User Thread

**Unknown Tool Outcome**:
The visible state of an interrupted external or write-capable tool call after dispatch when the app cannot prove whether its side effect completed.
_Avoid_: Failed tool, successful tool, automatic retry, assumed rollback

**Action Proposal**:
An Agent-drafted, user-reviewable request that remains inert until approved, used for a sensitive tool action under Standard Access or for a product decision governed by the Cognitive Review Gate.
_Avoid_: Tool execution, notification, approval already granted by Full Access

**Access Mode**:
The User-selected, installation-wide tool authorization level, either Standard Access or Full Access, kept until the User changes it and always shown while Full Access is active.
_Avoid_: Model Profile, Project authorization, cognitive review setting

**Standard Access**:
The default Access Mode that permits ordinary work inside the active Project or authorized Unscoped locations while requiring scoped confirmation for sensitive filesystem, command, installation, logged-in, external-write, credential, and permission-expanding actions.
_Avoid_: Read-only mode, confirmation for every tool call, Full Access

**Full Access**:
An explicitly selected Access Mode that lets tools perform filesystem, command, installation, authenticated-network, external-write, and other sensitive actions without subsequent tool-level confirmation, while leaving the Cognitive Review Gate intact.
_Avoid_: Automatic Memory, automatic Dream, hidden elevated mode, bypass of cognitive review

**Cognitive Review Gate**:
The requirement that Investment Reflection, Dream execution or resume, Memory changes, and Thread Scope Elevation remain explicit User decisions in every Access Mode because they define the User's investment cognition or conversation scope rather than tool security.
_Avoid_: Tool permission prompt, disabled by Full Access, automatic knowledge-base maintenance

**User Intent Gate**:
The requirement that an Output or other user-facing product action arise from a direct User instruction or approval of a scoped Action Proposal. Standard Access adds tool-level confirmation for sensitive execution; Full Access supplies standing tool authorization but never satisfies the Cognitive Review Gate.
_Avoid_: Agent-created goal, implicit Memory write, Full Access as cognitive consent

**Project Context**:
The current working state of a Project, maintained as a fixed template and available to Project Threads through on-demand Project Context Recall.
_Avoid_: Memory, transcript, knowledge base, material index

**Project Context Recall**:
A bounded, visible retrieval of relevant Project Context sections when the current conversation needs project working state or the User explicitly requests it.
_Avoid_: Startup injection, full Context dump, Memory Recall, Unscoped access

**Project Memory**:
User-confirmed project judgments, corrections, preferences, and decisions that can be recalled across Threads.
_Avoid_: Context, summary, parsed material

**Memory Recall**:
A bounded, auditable retrieval of relevant Project Memory or Long-term Memory for the current task, triggered automatically for judgment-heavy work or explicitly by the User.
_Avoid_: Startup context injection, full memory dump, hidden prompt injection

**Memory Recall Card**:
A compact candidate view returned before full Memory content, identifying Memory scope, title, applicability, status, and why it may be relevant so the primary Agent can selectively expand it.
_Avoid_: Material Card, complete Memory entry, injected Memory, search index row

**Automatic Judgment Recall**:
A Memory Recall initiated by the agent when the current task materially depends on the User's prior judgments, decisions, corrections, or investment learning.
_Avoid_: Default memory injection, recall for mechanical tasks

**Explicit Memory Recall**:
A Memory Recall initiated by a natural-language user request to reference, compare with, or learn from relevant prior memory, regardless of automatic task classification.
_Avoid_: Fixed recall command, unbounded memory load, Automatic Judgment Recall

**Long-term Memory**:
Global user memory for reusable investment cognition whose maximum specificity is an industry, financing stage, or comparable cross-project investment situation.
_Avoid_: Project Memory, project notes, named company fact, deal term, material excerpt

**Explicit Recall Only**:
A Long-term Memory recall policy that excludes an entry from Automatic Judgment Recall while allowing it to be retrieved when the User explicitly asks to use that memory.
_Avoid_: Project access grant, sensitive-data classification, inactive Memory, automatic recall

**Manual Memory Edit**:
A direct User addition, change, or deletion in a Project Memory or Long-term Memory file that becomes authoritative active memory after refresh without the Agent interpreting the change, automatically merging conflicts, or rewriting archives or cognitive history; safely parsed entries remain recallable and challengeable, while entries without traceable sources remain identified as User-authored rather than evidence-backed.
_Avoid_: Agent-proposed memory patch, automatic interpretation, silent repair, inferred Judgment Revision, automatic archive, recall of malformed content

**Memory Condensation**:
A user-approved rewrite or merge of existing Long-term Memory entries to reduce duplication while preserving durable investment learning.
_Avoid_: Automatic deletion, summarizing source materials

**Condensation Archive**:
An app-level archive for Long-term Memory entries removed because they were merged, deduplicated, or condensed without a meaningful change in investment judgment.
_Avoid_: Active Long-term Memory, Cognitive Evolution History, hard delete

**Cognitive Evolution History**:
The durable history of earlier investment judgments, rationale, revisions, narrowed applicability, and unresolved conflicts preserved when confirmed Investment Learning in Long-term Memory changes.
_Avoid_: Condensation Archive, active Long-term Memory, ordinary edit history

**Archive Retention**:
A configurable cleanup policy that removes expired Condensation Archive entries after a retention window unless the user keeps or re-archives them. It never applies to Cognitive Evolution History.
_Avoid_: Cognitive history cleanup, hidden deletion

**Dream**:
A user-approved memory review flow where the model prepares memory proposals and the user decides what is promoted, merged, kept, or discarded.
_Avoid_: Background memory writer, automatic memory commit

**Dream Due Check**:
An automatic, model-free check that determines whether the configured Dream review interval has elapsed and, when due, surfaces an Action Proposal without starting Dream.
_Avoid_: Scheduled Dream execution, background memory review, automatic model call

**Pending Dream Reminder**:
A non-blocking reminder that immediately exposes existing Dream Carryover or a Resumable Dream Run without waiting for the periodic Dream interval or starting model work.
_Avoid_: New Dream Batch, automatic resume, repeated blocking prompt, seven-day delay

**Dream Batch**:
The set of captured and recovered memory candidates assembled for one Dream session and reviewed together before any promotion or discard.
_Avoid_: Single candidate review, continuous background review

**Dream Cutoff**:
The completion time of the latest eligible user-facing Thread session available when a Dream Batch is created, frozen as that batch's shared upper time boundary.
_Avoid_: Per-Project watermark, Dream wall-clock finish time, moving cutoff during a run

**Dream Carryover**:
Unresolved candidates or eligible trajectory at or before a prior Dream Cutoff that must remain explicitly pending for a later Dream despite the shared cutoff advancing.
_Avoid_: Silent omission, per-scope watermark, archived-as-reviewed input

**Recovered Memory Candidate**:
A potential memory signal that Dream recovers from auditable Thread trajectory because it was not captured during the original conversation, remaining only a candidate until user review.
_Avoid_: Existing Memory, arbitrary model output, automatic promotion, untraceable inference

**Eligible Dream Trajectory**:
User-participating conversation history that Dream may inspect for missed memory signals, including Project Threads, Unscoped Threads, and the user-facing dialogue of Investment Reflection Threads while excluding internal or autonomous model work.
_Avoid_: Independent Evidence Pass, Dream's own sessions, background helper sessions, pure tool trajectory, all runtime history

**Thread Trajectory**:
The complete user-inspectable sequence of messages, tool activity, permissions, interruptions, Sub-Agent records, and other product events retained for one Thread independently of its current Physical Model Context.
_Avoid_: Pi session, model context window, compaction summary, application log

**Thread Trajectory Retention**:
The policy that keeps a Thread's original local conversation trajectory and associated Sub-Agent Task Records available until the User explicitly deletes them; archiving the Thread does not delete or shorten that history.
_Avoid_: Automatic expiry, archive-as-delete, permanent undeletable history

**Trajectory Deletion Cascade**:
The privacy rule that deleting Thread trajectory also removes its Sub-Agent Task Records, unapproved candidate text, and source excerpts derived only from that trajectory while preserving Outputs, approved Memory, and minimal review-history metadata with unavailable provenance.
_Avoid_: Deleting approved Memory, retaining hidden transcript copies, deleting all provenance metadata

**Project Dream Summary**:
A first-stage Dream summary that groups candidates by Project so the user can review project-local signals before global synthesis.
_Avoid_: Project Memory, final long-term memory

**Project Dream Extraction Pass**:
An isolated Dream stage for one Project that recovers and organizes that Project's candidate signals into a bounded Project Dream Summary without exposing its raw trajectory to other Projects or global synthesis.
_Avoid_: Per-Thread synthesis, cross-project raw context, Global Dream Synthesis

**Unscoped Dream Extraction Pass**:
An isolated Dream stage for one Unscoped Thread that produces a bounded user-level candidate summary for Global Dream Synthesis without creating a Project association or Project Memory destination.
_Avoid_: Virtual Project, shared Unscoped bucket, Project Memory proposal, cross-Thread raw context

**Global Dream Synthesis**:
A second-stage Dream synthesis that turns reviewed project-level signals into cross-project personal VC investment learning.
_Avoid_: Project summary, source summary

**Partial Dream Coverage**:
A Dream state in which one or more eligible Project or Unscoped extraction scopes were explicitly skipped after failure, allowing global synthesis to continue with a visible coverage limitation.
_Avoid_: Silent omission, automatic retry, failed scope treated as reviewed, complete Dream coverage

**Resumable Dream Run**:
An interrupted Dream whose completed stage results and review state are retained for explicit continuation without automatically restarting model work.
_Avoid_: Automatic restart, discarded progress, new unrelated Dream Batch

**Stale Dream Result**:
A persisted Dream stage result whose relevant trajectory, candidates, or Memory inputs changed after it was produced and therefore must be refreshed before downstream use.
_Avoid_: Failed result, reusable unchanged result, silent reuse

**Investment Learning**:
A cross-project personal insight about VC investing, such as a preference, heuristic, diligence pattern, risk lens, or memo standard worth preserving in Long-term Memory.
_Avoid_: Project fact, source excerpt, ordinary output

**Investment Retrospective**:
A user-reviewed comparison of an earlier investment judgment and its original rationale against later evidence, project developments, or observed outcomes, identifying what held, failed, or remains uncertain and why.
_Avoid_: Memory summary, outcome-only scoring, hindsight rewrite

**Investment Reflection Thread**:
A user-triggered dedicated Project Thread or Unscoped Thread in which the User and agent examine current or prior investment judgments through guided dialogue using evidence and memory available to that Thread scope. The agent actively questions, challenges, and synthesizes rather than merely collecting facts.
_Avoid_: Ordinary Thread, automatic review, form-filling workflow, Session

**Critical Reflection Stance**:
The agent's intellectually independent stance inside an Investment Reflection Thread: it treats memory as historical evidence about the User, tests claims against available evidence, and surfaces reasoned disagreement or contradiction when warranted.
_Avoid_: Sycophancy, memory obedience, reflexive opposition, debate for its own sake

**Independent Evidence Pass**:
The first stage of an Investment Reflection Thread, in which the agent forms an initial view from evidence available to the Thread scope without access to Project Memory or Long-term Memory.
_Avoid_: Memory-aware analysis, final investment decision, ordinary material summary

**Independent Assessment**:
A bounded, auditable result of the Independent Evidence Pass containing conclusions, concise rationale, evidence references, uncertainty, counterarguments, and open questions for later discussion.
_Avoid_: Raw material dump, full model reasoning, final Judgment Record

**Memory-Aware Reflection Pass**:
The second stage of an Investment Reflection Thread, in which the agent discusses the Independent Assessment with the User in light of relevant memory without inheriting the first stage's full context.
_Avoid_: Re-running the evidence pass, full-context continuation, memory obedience

**Evidence Drilldown**:
An on-demand retrieval of a bounded original-source excerpt during the Memory-Aware Reflection Pass, using an Independent Assessment evidence reference to verify or challenge a claim.
_Avoid_: Full material reload, Memory Recall, unsupported quotation

**Judgment Record**:
A user-confirmed result of an Investment Reflection Thread that preserves the current investment view, reasoning, uncertainty, counterarguments, evidence references, and decision state.
_Avoid_: Fact list, transcript summary, Long-term Memory entry

**Long-term Learning Proposal**:
A higher-level Investment Learning drafted by an Investment Reflection Thread for possible direct promotion to Long-term Memory, including its applicability boundary, sources, limitations or counterexamples, and maturity.
_Avoid_: Project conclusion, generic principle, automatic memory write, ordinary Memory Candidate

**Memory Evolution Action**:
The user-approved relationship between a proposed Investment Learning and existing Long-term Memory: Add, Reinforce, Narrow, Revise, or Contradict.
_Avoid_: Append-only memory, silent overwrite, automatic conflict resolution

**Unresolved Memory Conflict**:
A preserved tension between existing and proposed Investment Learning when available evidence is insufficient to decide which view should prevail.
_Avoid_: Judgment Revision, duplicate memory, model disagreement without evidence, latest-view-wins, repetition as truth

**Judgment Revision**:
A user-approved change to confirmed Investment Learning in Long-term Memory produced by an Investment Reflection Thread or Investment Retrospective while preserving the earlier judgment and its original rationale.
_Avoid_: Silent memory overwrite, preference capture, deleting a disproven judgment

**Short-term Memory Candidate**:
A captured strong user signal that may later be reviewed by Dream for Project Memory or Long-term Memory.
_Avoid_: Agent output, source summary, parsed text

**Inline Candidate Capture**:
The capture of an explicit or strong user memory signal through deterministic intent handling or the current response turn without a separate memory-classification model call.
_Avoid_: Per-turn classifier call, automatic Memory promotion, guaranteed exhaustive capture

**Memory Review State**:
App-level state for short-term memory candidates, Dream batches, and Dream archives before or after memory promotion.
_Avoid_: Project Memory, Long-term Memory

**Material**:
An original project file or public source used as input for agent work.
_Avoid_: Output, inbox item

**Material Inventory**:
An automatically maintained lightweight catalog of available Project files and basic metadata that does not read document content, invoke OCR, or call an LLM.
_Avoid_: Canonical Parse, material index injected into context, full-folder analysis

**On-demand Parsing**:
Document Parsing performed only when a Material is selected, attached, needed by the current task, or included in an explicit Parse Batch.
_Avoid_: Eager full-project parsing, LLM context injection, metadata inventory

**Document Parsing**:
The baseline ability to turn supported Materials into readable text, metadata, and structured parse artifacts that the agent can cite and use.
_Avoid_: OCR, document editing, full visual rendering

**Canonical Parse**:
A faithful reusable parse of a Material into blocks, structure, metadata, warnings, and source references without forcing it into a task-specific VC schema.
_Avoid_: Task-specific Output, summary, inferred project facts

**PDF Parse Pipeline**:
A page-aware parsing path that preserves usable native PDF content first, invokes ordinary OCR only when native text is absent or unreliable, and invokes Complex Page Recovery only when usable page structure still cannot be recovered, retaining the best earlier result with explicit warnings when a later stage fails.
_Avoid_: Whole-document OCR by default, interchangeable OCR Provider Chain, unconditional generative replacement, silent parse substitution

**Complex Page Recovery**:
A bounded page-level attempt to recover layout, tables, formulas, visual regions, or reading order that remain unusable after native parsing and ordinary OCR, without discarding better earlier evidence when recovery fails validation.
_Avoid_: Ordinary text OCR, user-selectable Provider fallback, whole-document generative parsing, silent evidence overwrite

**Parse Batch**:
A group of one or more Materials parsed together in a single user action or agent workflow.
_Avoid_: Single file assumption, project import

**Parsed Material Artifact**:
A reusable project-level parse result derived from a Material, such as extracted text, structured metadata, table extraction, or rendered pages.
_Avoid_: Task output, thread attachment

**Progressive Material Disclosure**:
The default material-reading strategy where the agent starts with metadata and structure, then reads targeted excerpts, full text, or visual renders only when needed.
_Avoid_: Full-context dump, eager material injection

**Parse Identity**:
The stable identity of a Parsed Material Artifact, based on source location, source content hash, parser type, parser version, and relevant provider settings.
_Avoid_: File path only, latest parse

**Parse Refresh Choice**:
The explicit User decision, made when a changed Material is next needed, to preserve its prior Parsed Material Artifact beside a new parse or replace the prior parsed content after successful refresh.
_Avoid_: File-change notification, automatic reparse, source-file replacement, LLM merge

**Stale Write**:
A prepared state or cognitive-file update that cannot be committed because its authoritative input or target changed after preparation.
_Avoid_: Provider Failure, ordinary Output collision, automatic merge, failed parse

**Visual Document Understanding**:
Provider-dependent analysis of rendered document pages, slides, images, or layout snapshots through a visual or multimodal path.
_Avoid_: Document Parsing, OCR

**Explicit Material Submission**:
A user action or setting that clearly authorizes sending selected project material to an external model or provider for the current request or configured scope.
_Avoid_: Implicit upload, background sync

**Project Provider Authorization**:
The default authorization created by opening a folder as a Project and selecting an external Model Profile, allowing that Profile's Provider to receive task-relevant Project material through Progressive Material Disclosure.
_Avoid_: Bulk project upload, authorization for another Project, authorization for an unrelated Provider, per-excerpt confirmation

**Output**:
A generated or edited artifact produced by the Agent under a Project's determined Output Location or an Unscoped Thread's authorized Output Location. Output has no built-in draft, work, or final lifecycle status; its purpose and organization follow the User's instruction and the current task.
_Avoid_: Material, source file, Work Output, Final Output, implicit document status

**Output Intent**:
An explicit user request, a user-invoked Skill with a declared deliverable, or a `Save as Output` action that authorizes creation of an Output in the determined Output Location.
_Avoid_: Long response, inferred desire to save, Parsed Material Artifact, automatic conversation export

**Unscoped Output Location**:
A user-selected local directory remembered by one Unscoped Thread as the destination for its Outputs until the User changes or clears it.
_Avoid_: Project folder, implicit default directory, Project State access, directory scan permission

**VC Deliverable**:
A user-requested document produced for a specific VC work purpose, such as industry research, project judgment, an investment memo, meeting preparation, or diligence questions.
_Avoid_: Canonical golden output, generic chat response, document type fixed by the product

**Evidence Discipline**:
A best-effort quality rule that makes verifiable facts traceable and keeps them distinguishable from user judgment, model inference, hypotheses, and intuition without requiring subjective investment views to be empirically proven.
_Avoid_: Evidence gate, citation for every sentence, suppressing judgment, unsupported fact presented as certain

**Material Judgment Disagreement**:
An unresolved difference between the User's view and the LLM's independent judgment that could materially change an investment conclusion, risk assessment, core rationale, or recommended action.
_Avoid_: Wording preference, minor emphasis difference, disagreement invented for balance

**Original Source File**:
A Material or user-owned file outside the normal generated-output flow. Modifying or replacing it requires explicit second confirmation under Standard Access and no tool-level confirmation under Full Access.
_Avoid_: Output, edited copy

**Read-only Public Web**:
Default network access for public search, URL fetch, public document extraction, and public repository fetch.
_Avoid_: Browser automation, logged-in web, write API access

**Skill**:
A reusable runtime instruction package discovered only from the active VC Agent Skills Directory.
_Avoid_: Tool, dedicated feature page, plugin

**VC Agent Skills Directory**:
The single dedicated app-level directory from which vc-agent discovers and loads Skill packages, including Skill Creator and future personal or first-party Skills.
_Avoid_: Claude Code skills directory, Codex skills directory, coding-agent skill aggregation, project-local skill source

**Skill Import**:
A task-authorized copy of a compatible complete Skill package into the VC Agent Skills Directory with visible compatibility and overwrite information, requiring final confirmation only under Standard Access.
_Avoid_: Loading in place, automatic discovery from another Agent, copying SKILL.md without resources

**Extension Admission Review**:
A non-executing assessment of a proposed Pi Extension's immutable package contents, dependency closure, executable entry points, requested permissions, and compatibility that produces evidence for the User's admission decision but cannot approve the Extension by itself.
_Avoid_: User approval, install confirmation, runtime sandbox, trust by package name, approval of mutable latest versions

**Extension Audit Workflow**:
A User-launched model-backed review context isolated from all Projects, ordinary Threads, Skills, and Memory, receiving only one staged Extension artifact and its deterministic inspection evidence to produce an advisory admission report.
_Avoid_: Project Thread, ordinary VC workflow, hidden audit call, Memory source, approval decision

**Extension Admission Blocker**:
An objective incompleteness in Extension identity or reviewability, such as mutable or missing source identity, unavailable package contents, or unresolved dependency closure, that prevents User approval until corrected.
_Avoid_: Accepted residual risk, vulnerability severity, User-overridable warning

**Extension Risk Finding**:
A disclosed security, privacy, compatibility, licensing, or operational concern found in a fully identified Extension artifact that the User may explicitly accept when deciding admission.
_Avoid_: Extension Admission Blocker, hidden warning, automatic rejection, proof of safety

**Approved Pi Extension**:
An Extension artifact admitted for Agent Worker loading only by an explicit User decision after Extension Admission Review, with approval bound to its exact content hash, pinned source revision, dependency lock, permission declaration, and review record.
_Avoid_: Audit recommendation, arbitrary installed Extension, globally trusted package name, automatically approved update, Full Access self-approval

**Trusted Worker Code**:
An explicitly approved executable component that runs with an Agent Worker's effective process authority and therefore may perform behavior outside Host-mediated capability controls; admission means the User accepts that trust boundary, not that the component is sandboxed.
_Avoid_: Host-registered Capability, Isolated Job Process, permission-enforced plugin, proof of safety

**Global Extension Enablement**:
An explicit installation-wide User setting that causes one Approved Pi Extension artifact to be loaded by every subsequently created or rebuilt Project and Unscoped Agent Worker until disabled.
_Avoid_: Approval, per-Project Extension profile, automatic tool-schema injection, implicit enablement

**Global Extension Revision**:
An immutable installation-wide selection of the exact Approved Pi Extension artifacts that all Agent Workers must use, with at most one pending successor awaiting a safe global changeover.
_Avoid_: Per-Project Extension set, mutable package resolution, mixed steady-state versions

**Extension Changeover Boundary**:
The global idle point at which no Active Turn is using the current Global Extension Revision, allowing the Host to activate a pending revision and retire all old-revision Workers without mid-Turn hot reload.
_Avoid_: Prompt Load Boundary, per-Worker opportunistic update, automatic Active Turn interruption

**User-supplied Skill**:
A third-party Skill package placed into the VC Agent Skills Directory by the User for the Personal Build, without becoming a vc-agent-owned or redistributable asset.
_Avoid_: Bundled first-party Skill, vc-agent ownership, redistribution right

**Configured OCR Capability**:
The single fixed local page-recovery capability used on demand when a Material requires OCR or Complex Page Recovery, with visible stage availability, provenance, validation, hardware path, and warnings while remaining one model-visible capability.
_Avoid_: User-selected OCR Provider, separate model-visible OCR tools, user-selectable Provider Chain, unconditional generative overwrite, silent external upload

**Skill Creator**:
A User-invoked meta-skill reused as a complete compatible Claude Code or Codex skill package to create or update personal Skill directories under the active Access Mode.
_Avoid_: Automatic workflow mining, vc-agent-specific creator engine, SKILL.md copied without required resources

**First-party VC Skill**:
A bundled Skill created after Prompt-first Validation that organizes Host-registered Capabilities, prompts, evidence rules, and output standards into a proven reusable VC workflow while remaining inside a Thread.
_Avoid_: Hard-coded workflow page, form wizard, generic third-party Skill

**Prompt-first Validation**:
A product-learning period in which VC workflows are performed through natural-language prompts, the base VC system prompt, and Host-registered Capabilities before repeated patterns are codified as First-party VC Skills.
_Avoid_: Required bundled workflow, premature Skill design, tool-free chat

**Conversation-first Workflow**:
A VC workflow initiated and conducted through a Thread by natural-language intent or optional Skill invocation, rather than through a dedicated application page.
_Avoid_: Form-first workflow, separate mini-application, unstructured chat only

**Personal Cognition Backup**:
An explicit portable backup of durable user-level cognition and reconstructible personal configuration, independent of Projects and operational workflow state.
_Avoid_: Project backup, workspace migration, credential export, Dream resume snapshot, automatic Memory merge

**State Schema Migration**:
A deterministic, version-aware transformation of vc-agent-owned state that either commits completely or leaves the prior state active.
_Avoid_: LLM rewrite, partial migration, application update, manual Memory interpretation

**Read-only Recovery Mode**:
A protective application state that permits inspection and export but prohibits Agent and user-state writes when stored data is newer than the running application can safely understand.
_Avoid_: Normal read-only Project, degraded write mode, automatic downgrade
