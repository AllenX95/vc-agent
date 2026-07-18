# VC Desktop Agent Design

Date: 2026-07-06
Status: Approved design draft
Target project: `E:\claude-projects\vc-agent`

## Summary

This product is a desktop VC agent client built on the Pi SDK/runtime. Internally it keeps the shape of a general Pi Desktop Host, but the first user-facing release is a focused vertical VC workflow product. The application opens local project folders, manages Project Threads and Unscoped Threads, runs Pi agent sessions through isolated worker processes, and provides first-party VC capabilities for project context, outputs, project memory, Canonical Parse, web research, and Dream memory review while reusing Skills and Pi Extensions for Office, OCR, MCP, and other non-core integrations.

The product should feel closer to Codex or Claude Code than to a command-line wrapper: the desktop application owns projects, threads, streaming conversation, tool call visibility, project state panels, permissions, settings, and artifact navigation. It must not wrap the existing `pi` CLI or parse terminal output as the integration boundary.

## Product Positioning

The first release is a **VC Desktop Agent**. It should not expose domain switching, extension profile management, or a general-purpose platform narrative in the main experience. VC capabilities are enabled by default and are treated as first-party product behavior.

The primary product surface remains a Codex-like Thread and Prompt Composer. In the first release, VC verticalization comes from the base VC system prompt and first-party Host capabilities, not bundled First-party VC Skills, separate workflow applications, dashboard modules, or form-heavy feature pages. The User works through open-ended conversation and natural-language workflow intent; compatible Skills may still be loaded and invoked when available.

The product is a single-user personal VC agent. One installation serves one User and one evolving Long-term Memory. The first usable release is a Personal Build assembled and used only by that User; it is not a redistributable product package. Its VC workflows and learning mechanisms may later inform a distributable product, but third-party assets used in the Personal Build do not thereby become vc-agent-owned or redistributable. The product does not need multiple investor identities, profile switching, shared memory, team collaboration, or cross-investor validation. First-party prompts and workflows may encode reusable VC practice, but they must not hard-code one investor's conclusions or preferences.

The internal architecture may still use Pi Desktop Host concepts such as an approved Extension inventory, skills, effective capability sets, and workers. Those should remain implementation concepts unless needed in advanced settings.

### Goals

- Provide a desktop GUI for Project and Unscoped VC agent work.
- Use Pi SDK/runtime directly, not the Pi CLI.
- Keep a Minimal Default Harness so ordinary turns do not inherit unnecessary prompts, tools, Skills, Project State, or material bodies.
- Default to VC workflows and VC prompt/instruction behavior.
- Support project and thread management.
- Support Unscoped Threads for conversation without opening a Project, with no implicit Project State access.
- Support baseline document parsing for real project materials in the first release.
- Support Office document generation and editing through compatible document Skills while preserving edited-copy defaults, provenance, and Access Mode handling for original replacement.
- Detect page-recovery need and invoke one local Configured OCR Capability when available: preserve usable PyMuPDF native text, run ordinary PaddleOCR for missing or unreliable native text, then run OvisOCR2 for pages whose complex layout, tables, formulas, visual regions, or reading order remain unusable.
- Keep LLM conversation context isolated per thread.
- Share project state across threads through Context, Outputs, and Project Memory.
- Default read-only public web access to on.
- Keep generated outputs under a simple project-local `outputs/` structure.
- Provide Standard Access with scoped confirmation for sensitive tool actions and an explicitly selected Full Access mode with no subsequent tool-level confirmation.
- Support project-level Context and Project Memory as separate concepts and files.
- Support explicitly requested Sub-Agent Runs with user-configured common role models and Agent-created temporary Sub-Agent Tasks.
- Preserve `/dream` as an LLM-driven, human-approved memory promotion flow.
- Distinguish personalization from evidence-backed Investment Retrospective so repeated preferences are not mistaken for validated investment learning.
- Support a user-triggered Investment Reflection Thread in Project or Unscoped scope where the LLM actively discusses, challenges, and synthesizes investment judgments using accessible evidence and relevant memory.
- Support Skill Creator and compatible Pi / Claude Code / Codex style Skill packages through one dedicated VC Agent Skills Directory and explicit Skill Import.
- Avoid bundling heavyweight local providers into the default installer.

### Primary Product Loop

The first release has one Primary Product Loop:

```text
Project Thread or Unscoped Thread
→ ingest selected materials or begin from a research question
→ parse evidence and perform public-web or industry research
→ use conversation, the VC system prompt, Host capabilities, and optional loaded Skills to form investment analysis
→ produce a memo, meeting brief, diligence questions, or reviewed Office document
→ the User explicitly launches Investment Reflection
→ produce a Judgment Record and Long-term Learning Proposal
→ the User reviews and promotes durable Investment Learning
```

Scope and sequencing decisions should preserve this loop end to end before deepening parallel capabilities. Document Parsing, OCR, Progressive Material Disclosure, web research, Office editing, Outputs, Model Profiles, Memory Recall, Investment Reflection, Dream, and Skills are supporting parts of this loop rather than independent product lines. Existing MVP commitments remain, but their first-release depth should be the minimum required for a reliable path through this loop.

The Primary Product Loop has no single golden document type. Its output is a VC Deliverable selected by the User's purpose and may be an industry research report, project judgment, investment memo, meeting brief, diligence question set, or another reviewed document. Acceptance should verify that different VC Deliverables can use the same evidence, research, analysis, output, and reflection mechanisms rather than optimizing the product around one fixed memo template.

### Evidence Discipline For VC Deliverables

VC Deliverables follow Evidence Discipline rather than a rigid evidence gate:

- Verifiable external facts should be traceable to project materials or public-web sources when practical.
- User judgment, model inference, hypotheses, intuition, and aesthetic assessment are valid first-class content and do not require empirical proof before they may appear.
- A lack of supporting evidence must not block analysis or document generation. Material uncertainty or missing evidence should be stated when it affects how confidently a conclusion should be used.
- The system must not present a subjective judgment, model inference, Memory-derived view, or speculative hypothesis as a verified source fact.
- The document does not need mechanical source-type labels on every sentence. It should use citations, wording, notes, or provenance metadata where the distinction is material to interpretation or later audit.
- The active prompt or optional Skill may adapt the level and presentation of evidence to the deliverable's purpose, audience, and style.

The goal is rigorous judgment, not evidence maximalism. Evidence should improve the User's reasoning without preventing the User or LLM from forming an investment view under uncertainty.

The LLM may form independent investment judgments and draft a VC Deliverable in one coherent professional voice. The document does not need to attribute every subjective sentence to the User or LLM. If their views differ in a way that could materially change the investment conclusion, risk assessment, core rationale, or recommended action, the Material Judgment Disagreement must remain explicit until the User resolves it or deliberately keeps it open. The system must not silently blend material disagreement into false consensus.

Creating, revising, or accepting an Output does not automatically convert judgments in the document into Project Memory, Long-term Memory, or Investment Learning. Unresolved Material Judgment Disagreements may be carried into a later user-triggered Investment Reflection Thread.

### Access Modes And Agent Autonomy

The installation has one persistent Access Mode selected by the User: Standard Access or Full Access. Standard Access is the initial default. The current mode remains effective across Threads, Projects, and application restarts until the User changes it. Full Access must remain conspicuously visible in the Prompt Composer and settings, but its active state must not generate repeated warnings or confirmation dialogs.

Under Standard Access, the Agent may autonomously perform ordinary task actions within already authorized scope, including:

- Inspecting the Material Inventory and using On-demand Parsing or Progressive Material Disclosure for authorized files.
- Read-only public-web research.
- Read-only tools and evidence drilldown.
- Project Context Recall and Automatic Judgment Recall under their bounded policies.
- Thread Compaction.
- Sending task-relevant Project material under active Project Provider Authorization.
- Creating and revising Outputs in the determined Output Location when authorized by the User's task.

Standard Access requires scoped confirmation before a sensitive tool action:

- Reading or writing outside the active Project or authorized Unscoped locations.
- Deleting an existing file or editing or replacing an Original Source File.
- Running arbitrary shell commands, installers, dependency changes, or system configuration.
- Using logged-in browser state, credentials, write-capable MCP, external submission, publication, or other network side effects.
- Importing or enabling executable Extensions or otherwise expanding tool permissions.

An Action Proposal explains the action, target, reason, and expected effect. Under Standard Access, approval applies only to the displayed action and scope and is not reused as blanket authorization for later operations.

Full Access is standing authorization for tool execution. Once explicitly selected, the Host does not request confirmation for project-external filesystem access, deletion or replacement, shell execution, dependency installation, logged-in access, credential access, external writes, MCP side effects, or permission-expanding tool actions. The Agent may perform them when it judges them necessary to fulfill the current User task. Tool calls, affected paths, destinations, and results remain visible and auditable; Full Access removes prompts, not observability, provenance, error handling, or Unknown Tool Outcome safeguards.

Every Access Mode retains the Cognitive Review Gate. Starting or resuming Investment Reflection or Dream, applying Project Memory or Long-term Memory changes, and performing Thread Scope Elevation remain explicit User decisions. These are product decisions about the User's cognition or conversation scope, not tool-security confirmations. Full Access also does not turn an Agent suggestion into a new task objective or cause ordinary conversation to be saved as an Output without Output Intent.

Dream uses two Cognitive Review Gates. A model-free Dream Due Check may run automatically and surface an Action Proposal when the configured interval has elapsed. Approving that proposal authorizes one Dream consolidation run, but not its resulting Memory writes; applying the final Memory patch requires a separate confirmation in both Access Modes.

### Delivery Sequence

The complete Personal Build retains every first-release capability and acceptance commitment in this document, but implementation is delivered as runnable vertical stages rather than one simultaneous integration effort. A stage is complete only when its user-facing path works end to end with persisted state, visible failures, and the authorization boundaries required for that stage. Internal use begins at the Dogfood Build; this does not relabel incomplete capabilities as finished or remove them from the Personal Build.

1. Foundation: Electron and React shell, direct Pi SDK integration, Project and Unscoped Threads, retained trajectory, Model Profiles, Access Modes, basic Host tools, streaming events, visible Provider Failure, and a fixed loader that accepts only bundled reviewed pinned Extensions. This stage proves the real runtime path but is not accepted as the product merely because infrastructure runs.
2. Dogfood Build: Minimal VC System Prompt, public web, baseline document parsing, Progressive Material Disclosure, conversation and Output creation, Project Context, Project Memory, Project Identity, external-file propagation, and Parse Refresh Choice. The sole User begins normal VC work here and uses natural-language prompts to expose workflow and prompt gaps. Arbitrary Extension acquisition, audit, approval, and enablement remain unavailable.
3. Learning Build: Long-term Memory and bounded recall, Investment Reflection, Dream, Cognitive Evolution History, Personal Cognition Backup, and State Schema Migration. This stage closes the core loop from real work through reviewed durable personal learning before integration breadth is treated as progress.
4. Integration Build: the isolated VC Agent Skills Directory, compatible User-supplied Claude Office Skills, the local PaddleOCR-to-OvisOCR2 page-recovery chain, pinned `pi-mcp-adapter`, compatible Skill Import, reused Skill Creator, and the complete Extension Admission Review, approval, Global Extension Revision, and rollback flow. Each integration must have a real task path and visible unavailable state without blocking unrelated daily work.
5. Delegation And Hardening: explicit Sub-Agent Runs, bounded cross-Thread concurrency and Execution Queue, interruption and recovery edges, collision behavior, security and migration hardening, and the complete acceptance suite. Completion of this stage marks the first complete Personal Build.

Stages use ordinary code and UI availability rather than a general feature-flag platform. An unavailable later-stage capability is absent or clearly marked unavailable; the app must not expose a mock success path. Defects discovered through Dogfood Build usage may change prompts, priorities, or implementation details, but changing a confirmed product boundary still requires an explicit design decision.

### MVP Capability Level

The first release is a usable vertical alpha, not only an infrastructure proof. It should include minimum functional slices for:

- Real document parsing and progressive material disclosure.
- Task-specific source-referenced Outputs built on Canonical Parse and Progressive Material Disclosure.
- Office generation and editing through compatible document Skills under Host file-safety policy.
- OCR through one user-configured Skill, Pi Extension, command, service, or API.
- Skill Creator as an explicit meta-skill.
- Loading compatible Pi, Claude Code, and Codex-style Skill packages only after they are present in the dedicated VC Agent Skills Directory.

These capabilities do not need to be complete platform implementations in MVP. The requirement is that each has a real usable path, clear warnings when providers are missing, and no hidden bypass around project permissions.

### MVP Capability Matrix

| Capability | MVP usable path | Dependencies | Failure / degradation | Permission boundary |
| --- | --- | --- | --- | --- |
| Project/thread shell | Open local folder, create/switch Project Threads, or create an Unscoped Thread without a folder | Electron, React, worker, Pi SDK/runtime | Worker crash warning and restart/close path | Project Threads use one Project folder; Unscoped Threads have no implicit Project access |
| Document parsing | Lightweight Material Inventory plus On-demand Parsing; use PyMuPDF for native PDF text, geometry, images, tables, and page rendering before page-level OCR decisions | Built-in inventory, pinned PyMuPDF runtime, OpenXML and spreadsheet parsers | Preserve usable native or partial page content with parse warnings; mark unrecovered scan pages explicitly | Inventory reads metadata; parsing reads selected or needed materials |
| Task-specific structured Output | Create claim tables, fact packs, metric tables, memo input packs, meeting briefs, or diligence lists only when the current task needs them | Canonical Parse, progressive disclosure, model provider | Continue from excerpts or return a normal conversation answer | Output claims retain source references; no persistent per-file schema or lifecycle classification |
| Progressive material disclosure | Material card, outline, excerpts, full text only when needed, visual path only when authorized | Parsed artifacts, material tools | Fall back to smaller excerpts or warnings | Avoid full-context dumps by default |
| Office editing | Invoke the User-supplied Claude Code `docx`, `pptx`, `xlsx`, or `pdf` Skill to create or edit documents, save an edited copy and change summary, and optionally render/preview | Complete User-supplied Skill package and its declared runtime dependencies; optional Office COM | Skill unavailable/dependency warning; retain ordinary document generation paths | Host enforces output locations and Access Mode behavior for original replacement |
| OCR and complex page recovery | Use the fixed local chain PyMuPDF native extraction -> ordinary PaddleOCR -> OvisOCR2 complex page parsing, advancing only when the prior result is missing, unreliable, or structurally insufficient | PyMuPDF, PaddleOCR/PaddlePaddle, OvisOCR2 and its pinned local inference runtime installed under Access Mode policy | Retain the best usable earlier-stage result with stage-specific warnings; mark OCR unavailable only when no usable text was recovered; no automatic switch to an unconfigured or external OCR provider | Local-only by default; any future external OCR follows Access Mode and visible provenance |
| Multimodal visual analysis | Render selected pages/slides/images and send to configured multimodal provider when authorized | Document Skill render dependency or other configured render capability, multimodal model provider | Text/layout-only fallback if unavailable | Explicit material submission or project/provider authorization |
| Read-only web | Search/fetch public web, public PDFs, public GitHub/repo metadata | Host-registered web tools or Pi companion web package | Inline source/failure warning | Default allowed; no logged-in/write actions |
| Project Context | Fixed Project Context with bounded, visible Project Context Recall when conversation needs it | Context files, recall tool | Continue without recalled Context and show warning if unavailable | No default new-thread injection; unavailable in Unscoped Threads |
| Project Memory | Draft-confirm append notes, recall on judgment-heavy tasks | Project memory file, memory recall tool | Inline recall warning if unavailable | User-confirmed memory only |
| Dream | MVP scope-isolated consolidation over candidates and auditable trajectory, batch review, final patch preview | App-level memory review state, thread trajectory, model provider | Preserve successful scopes; failed scope remains Pending for manual retry or explicit skip | Read-only source inspection; user confirmation before run, coverage skip, and Project/Long-term Memory writes |
| Explicit Sub-Agent Run | User-requested delegation into isolated Agent-created tasks with configurable role models, visible task tree, and bounded result handoff | Multiple configured Model Profiles, execution queue, model provider | Retain successful siblings; failed task offers manual retry, Profile change, skip, or visibly incomplete continuation | Explicit intent applies to one current task; no hidden auxiliary model calls or direct Memory eligibility |
| Skills loading | Load compatible complete Skill packages only from the active VC Agent Skills Directory | Pi Agent Skills loader/package mechanics, dedicated app-level directory | Loading warnings for unsupported or missing directives/resources | No direct reads from Claude Code, Codex, Pi, project-local, or other Agent skill directories |
| Skill Creator | Reused explicit meta-skill creates or updates a complete personal Skill directory with review | Reused Creator package, model provider, VC Agent Skills Directory, controlled file/script tools | Compatibility diagnostic or draft only if required resources or write path are unavailable | Standard Access requires destination/package/diff review before write; Full Access keeps the information visible without pausing |
| MCP | Discover and activate MCP tools on demand through the bundled, pinned `pi-mcp-adapter` integration | Reviewed adapter version and User-configured servers | Adapter/server unavailable warning in Overview; no automatic client fallback | Proxy-first exposure, lazy connection, and Host authorization for write, external submission, sampling, elicitation, and permission expansion |

### Non-Goals For MVP

- User accounts, investor profile switching, multi-user or team permissions.
- Shared memory or cross-investor validation.
- Cloud sync.
- Built-in product-quality scoring, benchmark suites, Memory A/B tests, user-rating prompts, or an improvement dashboard; first-release usefulness is judged through the User's normal experience.
- Automatic or in-application vc-agent updates and a general version-management UI.
- Long-running background daemon.
- Running agent tasks after app exit.
- Domain switching UI.
- Automatic skill creation from successful threads.
- LibreOffice fallback.
- Bundled PaddleOCR, PaddlePaddle, OvisOCR2, acceleration libraries, model weights, or Python OCR/document-model runtime.
- Full-fidelity Office editor replacement.
- Skill marketplace or Skill installation and enablement unrelated to the current User task.
- Automatic long-term memory writes.
- Original-file overwrite unrelated to the current User task.
- Dedicated Materials tab.
- Dedicated Activity tab.
- Full file-manager replacement.
- Same-Thread context clear, reset, or fresh-start operation; the User creates a new Thread for a clean context.

## Main Interface

The main application shell uses a three-column layout.

First launch opens the empty application shell. vc-agent does not create a default Project, Unscoped Thread, Model Profile, Task Model Assignment, sample data, or Pi session, and it does not display a blocking setup wizard or an unsolicited missing-Profile reminder. The User may open Settings directly, open a Project, or create a Project or Unscoped Thread. Creating or inspecting a Thread persists only local Host metadata until model-backed work is submitted.

### Left Navigation

The left side supports both Unscoped Threads and a two-level Project structure:

```text
Unscoped Threads
Projects
  Threads within selected project
```

A Project is a local folder with a stable Project Identity stored in its visible system state. Project Threads may use shared Project State, while Unscoped Threads have no implicit access to any Project Context, Project Memory, project materials, Outputs, or project files. Unscoped Threads may still use active Long-term Memory because it is user-level state. Switching Threads never shares LLM conversation history. Files attached directly to an Unscoped Thread are available only to that Thread unless the User later saves or moves them elsewhere through an explicit action.

On first registration, the Host creates `outputs/system/project.json` with a random Project Identity and schema version; it contains no original path, Project name, or business content. App-owned Threads, Dream state, candidates, Project Provider Authorization, and provenance associate with this identity, while the local registry maps it to the latest user-opened path. Project-internal references use paths relative to the Project root wherever possible. If the folder is moved or renamed, vc-agent does not scan the disk for it; when the User opens its new location, the carried identity reconnects the existing Project and updates the path while preserving continuity. If the identity file cannot be created or read, the app may open the folder with a visible path-bound continuity warning rather than claim move recovery.

Copying a Project folder also copies its identity. When vc-agent observes the same Project Identity at two locations, it stops registration with a Project Identity Collision and requires the User to choose `Moved Project` or `Project Copy`. `Moved Project` updates the existing Project to the selected path and detaches the previous path. `Project Copy` assigns a new identity to the newly opened folder and starts independent app-level Threads and workflow state while retaining copied folder-local Context, Memory, parsed artifacts, and Outputs. The Host and LLM must not infer this choice from names, timestamps, hashes, or content similarity.

An Unscoped Thread may become a Project Thread only through user-initiated Thread Scope Elevation. The User selects an existing Project or creates a new one, reviews the Project State access being granted, and chooses whether directly attached files should be copied into the Project. After confirmation, the Thread becomes a normal Project Thread and inherits the target Project's standard access policy; the product does not create Thread-level Context, Memory, Outputs, or material permission switches. The Agent may not initiate this action, infer a Project from conversation content, select a target, grant itself access, or import files silently. Project Context, Project Memory, project materials, and other Project State become available only after the User confirms elevation.

### Center Interaction Area

The center is the primary working surface:

- Streaming conversation.
- Inline tool call display.
- Web fetch and source display.
- Office/PDF parse status.
- MCP call status.
- Access Mode control, Full Access indicator, and Standard Access permission prompts.
- Prompt composer.
- Active Model Profile selector in the Prompt Composer.
- Cross-Provider choice between continuing the current Thread with its retained context or starting a new Thread.
- Visible Sub-Agent task tree with role, objective, Profile, status, and token usage when a Sub-Agent Run is active.
- File attachment.
- Command palette.
- Optional loaded-Skill launcher and invocation state.
- Slash commands such as `/dream`.

Tool activity should appear inline in the conversation instead of a separate Activity tab. The user should be able to inspect what the agent searched, fetched, parsed, created, or failed to do.

### Right Project State Panel

The right panel has four fixed tabs:

```text
Overview / Outputs / Context / Project Memory
```

#### Overview

Overview is the default state tab. It shows:

- Project summary.
- Current session/thread state.
- LLM model and context usage.
- Whether context compression is approaching.
- Active skills.
- MCP status.
- Provider status and warnings.
- Read-only web access status.
- Configured OCR Capability availability.
- Active document Skill and declared dependency availability.

#### Outputs

Outputs indexes Agent-generated project artifacts and deliverables:

- `outputs/parsed/`
- `outputs/`
- Project-level parsed material artifacts.
- User-directed or LLM-selected task folders and generated deliverables.
- Generated Markdown, spreadsheets, documents, presentations, diffs, and edited copies.
- Source/thread/task provenance.
- Open, export, delete, and replace-original actions.

Outputs is not a generic file browser and does not classify files as work or final. It is an Agent artifact and deliverable index.

#### Context

Context displays and edits the project working-state file:

```text
outputs/system/project-context.md
outputs/system/project-context.json
```

The Markdown file is user-facing. The JSON file is a structured mirror used by the worker for reliable section-level Project Context Recall.

#### Project Memory

Project Memory displays and edits:

```text
outputs/system/project-memory.md
```

It records user-confirmed project judgments and project-specific decisions. It is not a place for ordinary agent output, parsed text, OCR text, or web content.

## Runtime Architecture

The runtime follows one governing ownership rule:

```text
The Host owns product facts and policy.
Workers own active execution resources.
Pi owns a Thread's Physical Model Context, not vc-agent product semantics.
```

The application uses:

```text
React Renderer
  <versioned command/event IPC>
Electron Main Host
  <capability requests and domain events>
Project or Unscoped Agent Worker
  Pi Adapter
  Pi SDK/runtime

Electron Main Host
  <bounded deterministic jobs>
Utility Worker Pool
```

The application must not wrap the existing Pi CLI. It should create and manage Pi runtime sessions directly through Pi SDK/runtime APIs inside the Project Agent Worker. The MVP should not require a user-managed local Pi runtime daemon.

The React Renderer is a presentation and command surface. It does not directly access project files, credentials, Providers, Pi sessions, MCP servers, or product stores. Electron Main is the Host product control plane and the only authority for Project registration, Thread metadata, Operational State, execution admission, authorization, workflow state, Memory eligibility, and final product-state commits. Agent Workers are execution boundaries for active Pi sessions, Provider calls, and reviewed executable Extensions. Utility Workers perform bounded deterministic parsing, OCR, rendering, and Office support jobs without creating Pi sessions.

Local file editing is provided by Host-registered tools inside the SDK session, not by shelling out to the Pi CLI. Model-invoked product capabilities cross the Host Capability Gateway before execution or final commit. Approved Pi Extensions are the explicit execution exception: after separate User approval and enablement, they run as Trusted Worker Code and may directly exercise Agent Worker process authority outside the Gateway. Any SDK-provided default write tools must be disabled, wrapped, or routed through Desktop Host Access Mode and output policy so Standard Access confirmations, Full Access behavior, Office edits, provider uploads, and generated Outputs remain observable and attributable.

### Codebase Structure And Dependency Direction

vc-agent uses one TypeScript workspace and one locked Python utility runtime rather than a local service architecture:

```text
apps/
  desktop/          Electron Main, preload, and React Renderer
  agent-worker/     Project and Unscoped Pi execution entry point
  utility-worker/   trusted bounded local-transform entry point

packages/
  core/             pure domain rules, application use cases, and ports
  contracts/        versioned IPC commands, Domain Events, Job Manifests, schemas
  host-services/    authorization, scheduling, Capability Gateway, Context Budget
  persistence/      SQLite, JSONL, transparent files, migrations
  pi-adapter/       the only package that directly imports the Pi SDK
  capabilities/     Material, Memory, Output, Web, and local capability adapters

runtimes/
  python/           pinned PyMuPDF, PaddleOCR, and OvisOCR2 environment and job handlers
```

The dependency direction is enforced as an architecture contract:

```text
Renderer -> contracts
Electron Main -> core + contracts + host-services + persistence + capabilities
Agent Worker -> contracts + pi-adapter
Utility Worker -> contracts + bounded capabilities
pi-adapter -> contracts + Pi SDK
persistence -> core ports + contracts
capabilities -> core ports + contracts
core -> no framework or runtime package
Python runtime <-> versioned Job Manifest and staged result only
```

Electron Main is the composition root that selects concrete stores, capability handlers, Worker clients, credential adapters, clocks, and filesystem implementations. Core use cases depend on ports and product types rather than Electron IPC, SQLite rows, JSONL records, Pi messages, Provider payloads, or Python structures. Persistence and capability packages map their external representations at the boundary and cannot call the Renderer or Agent Worker directly.

`contracts` contains transport DTOs and validation schemas, not product policy. Every process validates inbound messages and rejects unsupported schema versions. Pi-specific ids may cross only as optional correlation metadata; Pi event unions, tool definitions, ResourceLoader types, and model objects remain inside `pi-adapter`. Electron types remain inside `apps/desktop`, and the preload exposes one narrow typed bridge rather than a general IPC or filesystem escape hatch.

The Python runtime receives only a versioned Job Manifest and authorized staged inputs. It does not open `state.db`, mutate Thread Trajectory, resolve Project identity, inspect credential storage, or choose final destinations. Its result manifest is validated by the Utility Job Runner before the Host performs a product commit.

Dream, Investment Reflection, Memory, Office, OCR, parsing, and MCP remain modules or capabilities inside this workspace rather than separate daemons or repositories. New process boundaries require a distinct crash, trust, or lifecycle need; feature ownership alone is not sufficient.

### Pi SDK Capability Boundary

The Pi SDK provides the agent runtime and extension substrate. It should be treated as the native execution layer for conversation, models, tools, skills, events, and session mechanics. VC Desktop should register domain capabilities into that substrate instead of reimplementing the agent loop.

All direct SDK dependencies live behind a versioned Pi Adapter owned by the Agent Worker package. Product modules interact with a narrow runtime contract for context creation, Turn submission, cancellation, compaction, model changes, Sub-Agent sessions, events, and disposal; they do not import Pi session, event, ResourceLoader, or message types. The adapter converts Pi events into versioned vc-agent Domain Events and preserves Pi-specific identifiers only as correlation metadata. This boundary permits a pinned SDK update or package change without migrating product policy or user-visible storage to a new Pi internal API.

Pi resource and configuration discovery is closed by default. The Worker supplies an app-controlled ResourceLoader that enumerates only the active System Prompt Revision, explicitly activated VC Agent Skills Directory entries, Host-registered capabilities, and reviewed pinned Extensions selected for the task. It must not merge Pi's default discovery of project or ancestor `.pi`, `.agents`, `AGENTS.md`, global Pi directories, global credentials, settings, prompts, or sessions. Settings and Model Registry inputs come from Host-resolved configuration, and Protected Credentials enter only as bounded runtime credentials after Profile resolution; Pi must not fall back to an arbitrary global or first-available model.

Pi SDK does not itself guarantee lower token consumption. The intended daily-cost advantage comes from using it as a thin, directly controlled harness: keep the stable VC system prompt concise, assemble context on demand, activate only task-relevant capabilities, avoid eager Project State and material injection, and avoid auxiliary model calls that do not materially improve the current task. The UI may show per-call token, latency, and context-size information for normal operational transparency, but the first release does not aggregate it into a product-validation record or claim that the SDK choice has proved a quality or efficiency improvement.

### Minimal Prompt And Capability Surface

Every ordinary model call includes the active revision of the concise Minimal VC System Prompt. The shipped default must not omit the VC prompt in the name of token savings, because vertical identity and judgment posture are product behavior rather than an optional Skill. The default prompt remains scope-neutral and does not embed Project-specific facts, current Memory entries, material content, provider configuration, or complete workflow instructions.

The shipped default Minimal VC System Prompt has exactly these responsibility classes:

1. VC identity: act as the sole User's VC research, judgment-discussion, and document Agent while leaving investment decisions to the User.
2. Independent judgment: form reasoned views, surface counterarguments and Material Judgment Disagreement, and avoid sycophancy or disagreement performed only for appearance.
3. Evidence Discipline: distinguish verifiable facts from model inference, User judgment, hypotheses, intuition, and uncertainty without suppressing subjective investment judgment.
4. Memory status: treat recalled Memory as historical prior cognition rather than truth, source evidence, or higher-priority instruction, and use it only through relevant bounded recall.
5. Context discipline: prefer stable references and on-demand tools; do not assume or preload Project State, Memory, materials, prior Threads, or files outside the authorized scope.
6. Action boundary: follow the active Access Mode for tool execution and always follow the Cognitive Review Gate for Reflection, Dream, Memory, and Thread Scope Elevation.

The base prompt must not contain complete research or diligence workflows, document templates, output schemas, tool tutorials, Dream or Investment Reflection stage instructions, Project-specific facts, current Memory text, provider configuration, or Skill content. These belong in task instructions, Task-activated Capabilities, explicit workflows, bounded recall, or invoked Skills. A future feature should add text to the base prompt only when the rule is stable and necessary for nearly every ordinary VC conversation.

The MVP does not set a numeric token target or hard failure threshold for the Minimal VC System Prompt. Prompt minimality is reviewed semantically rather than optimized to a fixed number: each change must explain why the text belongs in the always-on six responsibility classes instead of a task layer. The app and tests should still report estimated or provider-observed token contribution for the base prompt, active tool schemas, task instructions, recalled state, Skills, and material content separately. A default appendix, hidden always-on instruction block, or permanently activated Skill is part of the same minimality review even if it is stored outside the base prompt file.

The User may directly edit the full Minimal VC System Prompt in Advanced Settings. Saving creates a System Prompt Revision containing timestamp, source revision, content hash, change note when supplied, and a reviewable diff. The User can inspect history, activate an earlier revision, duplicate a revision for experimentation, and restore the shipped default. The app may show non-blocking warnings when an edit removes the VC identity, omits the default behavioral classes, leaves the prompt empty, or adds unusually broad always-on instructions; it must not silently restore removed text or block activation merely because the custom prompt differs from the default.

System-prompt editability does not make model instructions the security boundary. Access Mode, provider authorization, User Intent Gate, Cognitive Review Gate, and Memory writes are enforced by Host policy and remain active even if the User removes their explanatory text from the prompt. The effective System Prompt Revision id and hash are recorded with each model turn so behavior can later be compared across prompt experiments.

System Prompt Revision activation follows the useful lifecycle behavior of Claude Code's root and user-level `CLAUDE.md`, adapted to an actual VC system-prompt layer:

- A physical Thread context loads the active revision at its Prompt Load Boundary and retains that revision in memory.
- Editing or activating a revision does not hot-reload an already active physical context, retroactively rewrite prior messages, or immediately invalidate its provider prompt cache.
- A new Thread loads the latest active revision.
- Reopening or resuming a Thread after an application restart creates a new Prompt Load Boundary and loads the latest active revision.
- Automatic or User-invoked Thread Compaction/rebuild creates a new Prompt Load Boundary and loads the latest active revision.
- If the loaded revision differs from the Thread's previous physical context, the conversation shows a lightweight `System prompt updated` event with old and new revision ids.
- MVP does not provide same-Thread context clear, reset, or fresh start. The User creates a new Thread for a clean context, or invokes Thread Compaction when continuing the same Thread is appropriate. No separate prompt hot-reload mechanism is required.

This borrows only Claude Code's reload timing. Claude Code injects `CLAUDE.md` as contextual instructions after its system prompt, while VC Desktop's Minimal VC System Prompt is the editable system-prompt layer itself. Host policy remains outside both mechanisms.

Investment Reflection and Dream use a stricter lifecycle because they are resumable multi-stage workflows. At run creation, the Host records a Workflow Prompt Snapshot that references the then-active System Prompt Revision. Every stage, selective stale-result rerun, and explicit post-restart resume of that run uses the snapshot rather than the newly active revision. Changing the active prompt does not by itself make workflow results stale. The latest active revision applies when the User launches a new Reflection or Dream run. The run UI and result provenance show the frozen revision id and hash. MVP does not add a dedicated restart-with-latest-prompt or stage-migration operation; the User ends or discards the current run and launches a new one when needed.

The active tool surface follows a small-core plus Task-activated Capability model:

- Keep only high-frequency, low-ambiguity core capabilities active by default.
- The Host deterministically preactivates specialized capabilities when explicit UI state, attachment type, invoked Skill, visible command or workflow, or unambiguous User intent already identifies the need.
- Keep one compact capability broker in the core surface. During its existing Turn, the primary Agent may issue a Capability Activation Request describing a missing need; the Host resolves it against the capability registry and, when allowed, exposes the selected tool schemas for the next model step without a separate model request.
- Activate Web, OCR, Office editing, MCP, Dream support, Investment Reflection support, Skill Creator, and other specialized capabilities only through deterministic preactivation or a Capability Activation Request.
- Load Skill instructions and referenced resources only after the Skill is invoked or explicitly activated.
- Do not make a separate model call to classify capability activation.
- Do not treat capability activation as an Access Mode change; every tool remains subject to the current Access Mode, provider policy, and Cognitive Review Gate.
- Do not preload the data behind an activated capability. Activation exposes the bounded action surface; Project Context, Memory, materials, and source excerpts still use their own on-demand recall or disclosure rules.
- Scope ordinary activation to the current Turn and explicit workflow activation to that workflow run. Activation never becomes a standing Thread mode or silently carries into an unrelated Queued Follow-up.
- A Capability Activation Request cannot supply the explicit User intent required for Dream, Investment Reflection, Thread Scope Elevation, or a Sub-Agent Run; it may expose support tools only after the corresponding workflow or delegation scope already exists.
- Return unavailable, incompatible, or unauthorized capabilities as a visible bounded result. Do not activate an alternative capability, Model Profile, Provider, or permission automatically.

The permanent Project Thread core tool surface is exactly:

| Core tool | Bounded responsibility |
| --- | --- |
| `capability_request` | Describe a missing task need and request matching registered model-callable capabilities; it neither executes the capability nor grants authorization. |
| `material_recall` | Inspect authorized Material inventory, cards, outlines, and targeted excerpts through Progressive Material Disclosure; invoke deterministic On-demand Parsing when required and surface Parse Refresh Choice for stale Material. |
| `project_state_recall` | Retrieve bounded, separately labelled sections from Project Context or Project Memory without reading Material bodies, Long-term Memory, or another Project. |
| `memory_recall` | Retrieve bounded active Long-term Memory under automatic, explicit-only, specificity, conflict, de-identification, and context-budget rules. |

An Unscoped Thread keeps `capability_request`, `material_recall`, and `memory_recall`, omits `project_state_recall`, and limits `material_recall` to direct Thread attachments. Core availability does not preload any data or authorize recall automatically: the primary Agent must call the relevant tool during its existing Turn, and the Host applies the source-specific recall policy.

All other capabilities fall into one of four activation classes:

| Activation class | Examples | Rule |
| --- | --- | --- |
| Ordinary task capability | Public Web, local OCR, Office, computation, read-only MCP, invoked Skills | The Host may preactivate it or approve a Capability Activation Request for the current Turn. |
| Preconditioned execution capability | Output writes, Shell, external files, write-capable MCP, logged-in actions | It may be exposed only when existing User intent, scope, Access Mode, Provider policy, and destination rules permit the action; activation itself is not approval to execute every call. |
| Protected workflow capability | Dream, Investment Reflection, Memory writes, Thread Scope Elevation, Sub-Agent delegation | The primary Agent cannot establish the required intent through `capability_request`; support tools appear only after the User has explicitly initiated the workflow or delegation scope. |
| Host-only management operation | Project registration, Model Profile editing, Access Mode changes, backup, restore, migration, credential management | It never enters the model tool surface and is performed through explicit UI or deterministic Host operations. |

The core prompt and stable core tool definitions should remain ordered and unchanged where practical so providers can reuse prompt prefixes. Task-specific instructions and activated capability schemas are appended as bounded layers and removed when no longer applicable to the task or explicit workflow.

SDK-native capabilities to use directly:

| SDK area | Native capability | Desktop use |
| --- | --- | --- |
| Session runtime | `createAgentSession`, `createAgentSessionRuntime`, `AgentSessionRuntime` replacement APIs, session tree, fork/import/switch, compaction | Thread lifecycle, branch/fork support, context compaction, worker-level session control |
| Streaming events | `message_*`, `turn_*`, `tool_execution_*`, `agent_*`, queue, compaction and retry events | Structured IPC to conversation UI and inline tool activity |
| Prompt queueing | `prompt`, `followUp`, image attachments | User prompts, Queued Follow-ups, and authorized multimodal submissions without implicit mid-run steering |
| Models/auth | `ModelRegistry`, `AuthStorage`, `SettingsManager`, provider registration, model input metadata including `text`/`image` | Provider settings, model selection, API key/OAuth handling, multimodal capability checks |
| Resource loading | `ResourceLoader`, system prompt override, skills, prompts, and context resources | App-controlled resource enumeration without Pi default project, ancestor, or global discovery |
| Skills | `Skill`, `loadSkills`, `loadSkillsFromDir`, `formatSkillsForPrompt`, skill diagnostics | Load compatible Pi / Claude Code / Codex-style `SKILL.md` sources and surface warnings |
| Extension hooks | `before_agent_start`, `context`, `tool_call`, `tool_result`, `before_provider_request`, `after_provider_response`, `input`, session events | On-demand context and memory recall, progressive disclosure, permission gates, provenance, truncation, provider logging |
| Tool registry | `defineTool`, `registerTool`, `customTools`, active tool allowlist/denylist, per-tool sequential/parallel execution | Register first-party VC tools and control which capabilities the LLM can call |
| Commands | `registerCommand`, prompt templates, custom messages/session entries | `/dream`, parse/projection commands, Skill Creator entry points, lightweight tool-call-like notices |

SDK capabilities that may be reused only through Desktop policy:

| Capability | Policy |
| --- | --- |
| Built-in `read`, `grep`, `find`, `ls` | Can be enabled for project-scoped read-only inspection if path policy and output truncation are enforced. Prefer Host material tools for parsed materials. |
| Built-in `bash`, `edit`, `write` | Route through Host path and Access Mode policy. Standard Access confirms sensitive use; Full Access does not. They must not replace the normal Office/document editing path. |
| Extension-discovered project resources | Use the app-controlled `ResourceLoader`; do not silently load arbitrary project-local or global extensions, skills, prompts, or context files. |
| Provider payload hooks | Use for audit/provenance and policy checks. Do not rely on them as the only control for material upload; permission must be decided before provider submission. |
| Session file storage | Stores the Pi Physical Model Context behind the Pi Adapter. It is not the authoritative Thread Trajectory, and Project Context, Project Memory, parsed artifacts, Outputs, permissions, Memory eligibility, and app-level Dream state remain Host-owned. |

Capabilities that must be registered by VC Desktop as Host-owned tools or commands:

| Host capability | Why SDK native is insufficient |
| --- | --- |
| `workspace_*` / output path tools | The app owns the determined Project Output Location, reserved `outputs/parsed` and `outputs/system` state, artifact registry, source hashes, and original-file replacement policy. |
| `material_parse` and parse-batch tools | Pi SDK has agent/tool mechanics, not canonical parsing rules for PDF, Office, spreadsheets, OCR warnings, and project artifact reuse. |
| Material disclosure tools | Progressive Material Disclosure needs material cards, outlines, targeted excerpts, full parsed text, and source references tied to parsed artifacts. |
| Task-specific structured-output tools | Claim tables, fact packs, metric tables, and similar Outputs need bounded Canonical Parse retrieval, source references, and standard Output policy. |
| Office Skill safety wrappers | Document Skills own generation/editing procedures and dependencies; VC Desktop owns destination policy, provenance, edited-copy defaults, and Access Mode handling for original replacement. |
| OCR capability adapter | OCR need detection, invocation of the single configured capability, source mapping, warnings, and external-upload authorization remain Host policy. |
| Multimodal material analysis tool | SDK can send `ImageContent`, but selecting/rendering pages and authorizing material submission are Host responsibilities. |
| Project Context tools | The fixed template, refresh-as-update semantics, structured mirror, and bounded Project Context Recall are app product behavior. |
| Project Memory, short-term memory, and Dream tools | Memory source rules, cross-project two-stage Dream, long-term memory evolution, Condensation Archive retention, permanent Cognitive Evolution History, and final approval are Host-owned. |
| Skill Import and Skill Creator boundary | Pi loads, validates, and progressively discloses Skills; Desktop owns the single VC Agent Skills Directory, complete-directory copy, Creator write destination, visible diff, and Access Mode handling. |
| Web and MCP policy wrappers | Core SDK does not include MCP. Use the bundled, pinned `pi-mcp-adapter` for connectivity, while Desktop routes activation, Access Mode behavior, and visible status through Host policy. |
| Dependency/capability doctor | Configured OCR, User-supplied Claude Office Skill dependencies, bundled MCP adapter/server, and optional local tools need app-level detection and user-facing warnings. |

Existing `pi-vc-core` extensions are useful as implementation references because they already register workspace, Office, and memory tools through Pi's `registerTool()` / `registerCommand()` API. Desktop MVP should not adopt their `.pi-vc/` storage or CLI-package assumptions directly. Reuse should happen by porting internal logic behind the new `outputs/` layout, GUI permission model, app-level memory review state, and Project Agent Worker lifecycle.

### Process Model

Each Project with submitted model-backed work gets one agent worker child process on demand:

```text
Desktop GUI
  <structured IPC>
Project Agent Worker
  Pi SDK/runtime
  First-party VC profile
  Project thread sessions
  Project tools and providers
```

The Host owns windows, routes, settings, permissions, Project registration, Thread metadata, Thread Trajectory, pre-execution validation, scheduling, and all durable product decisions. The Worker owns activated Pi sessions, Provider calls, reviewed Extension execution, and Physical Model Context. A Worker may inspect only the bounded state supplied or authorized for its current task; it does not become the authority for Project State or personal cognition merely because it executes a tool.

Each Host-registered tool exposed to Pi is a typed proxy. Its Worker-side implementation submits a Capability Execution Request containing Thread, Turn, capability, scope, arguments, correlation id, and expected state version. The Host validates intent, Access Mode, Project or Unscoped scope, Provider authorization, path policy, capability activation, and stale-write conditions before dispatch. Small metadata operations may complete in the Host; deterministic heavy work is delegated to a Utility Worker. Approved and enabled Pi Extensions may execute in the Agent Worker as Trusted Worker Code and are not assumed to route direct Node.js or OS behavior through this request path. The Host records bounded proxy results and validates every requested durable product-state commit before returning it to Pi or acknowledging the commit. A Capability Execution Request invokes an already active capability and is distinct from a Capability Activation Request that only changes the bounded tool surface.

Lazy Agent Activation keeps application launch, Project opening, Thread creation, Thread switching, trajectory browsing, settings, and local file views entirely in the Host. For an ordinary Thread, the Host resolves the effective Model Profile only when the User submits the first or next Turn. It then starts the Project or isolated Unscoped worker if absent, initializes Pi SDK/runtime and the Thread session, applies the current Prompt Load Boundary, and submits the Turn. Reopening an existing Thread after app restart does not recreate its Pi session merely for display; the session is reconstructed lazily when the User continues it.

If no effective Model Profile or Task Model Assignment exists, no worker, Pi runtime, Provider request, or automatic Profile creation occurs. The submitted text remains visible and retryable in that Thread beside a local `Model Profile not configured` error with actions to open Profile settings or select a Profile. vc-agent does not show this error before execution is attempted and does not automatically retry after configuration; the User retries or resubmits manually. The same pattern applies to an explicitly launched model-backed workflow whose required task assignment is missing.

Host-only Operations remain available without a Model Profile, Pi worker, or Thread session. They include Project registration and local browsing, empty Thread creation and trajectory inspection, Context and Memory viewing or direct editing, System Prompt and settings management, Material Inventory refresh, explicit baseline Parse Batches, deterministic Context mirror and Memory index rebuilds, Project Identity handling, Personal Cognition Backup and Restore, State Schema Migration, and environment diagnostics. A Host-only Operation may use bounded local utility or parser processes, including configured local PaddleOCR and OvisOCR2 for an explicit parse, but it must not initialize Pi, call a conversational or externally hosted model Provider, or silently become an Agent Turn. Local OvisOCR2 inference is a bounded document-recovery job rather than a Pi-backed Agent Turn. The operation continues to obey path, dependency, Access Mode, atomic-write, and provenance policies.

Pi-backed Work begins only from a submitted Thread Turn or an explicitly launched model-backed workflow, including Dream, Investment Reflection, Sub-Agent Run, visual model analysis, or a Skill whose execution requires model orchestration. Model-free UI actions that prepare inputs do not activate Pi merely because a later Agent may use their results. If a requested operation starts as Host-only but reaches a step that requires a model, it stops at that boundary and asks the User to submit or approve the Pi-backed work under normal Profile resolution rather than activating a session implicitly.

The app does not run a local daemon. Closing the application terminates all workers. After app exit, no agent should continue to access the network, MCP, files, OCR capabilities, or memory.

### Worker Granularity

Use at most one activated worker per Project. Inside that worker, each executed Project Thread has an independent session context created lazily. A Project with no submitted model-backed work has no worker. Each Unscoped Thread that executes model-backed work uses its own temporary Worker with no Project State access. This costs one bounded process per concurrently active Unscoped Thread but removes shared mutable attachment, capability, and path scope from the unscoped execution boundary.

Sub-Agent Tasks run as separate Pi sessions inside their parent Project or Unscoped Worker rather than creating a process for every child. Their context and Capability Sets remain isolated even though they share the Worker process. A Worker crash may interrupt every active session in that execution scope but cannot corrupt Host-owned Operational State or make the application UI unavailable.

### Local Executable Job Isolation

Electron Main never loads or evaluates third-party scripts, Office automation code, OCR runtimes, or arbitrary dependency modules. The Host owns one generic Utility Job Runner with two execution tiers:

| Tier | Work | Lifecycle |
| --- | --- | --- |
| Utility Worker Pool | Pinned vc-agent-owned PyMuPDF parsing and rendering, deterministic document parsing, ordinary PaddleOCR, local OvisOCR2 complex page parsing, derived-index rebuilds, and similar bounded local transforms | Lazy, bounded workers may remain warm while the application is open so heavy local models do not reload for every page. |
| Isolated Job Process | User-supplied Skill scripts, Skill Creator helper scripts, Office COM automation, Shell commands, dependency installation, and other arbitrary executable integrations | Supervised short-lived child process or process tree per invocation, with no in-process state shared with Electron Main or a Pi session. |

"Pinned vc-agent-owned" refers to code and dependency identities selected by vc-agent, not every Python or Node package already installed on the User's machine. A Personal Build still treats a User-supplied Skill package as arbitrary executable integration even when the sole User trusts its source. This boundary is for crash containment, cancellation, deterministic inputs, and product-state integrity; it does not claim a hardened hostile-code sandbox on the User's Windows account.

Every job receives a typed manifest containing job id, capability, authorized working scope, declared input references, staging destination, timeout and output bounds, and sanitized environment. Protected Credentials are supplied only when the authorized job requires them, through a bounded runtime channel rather than command-line arguments or persisted manifests. Standard Access obtains required confirmation before launch; Full Access suppresses that prompt but uses the same manifest and process boundary.

File-producing jobs write into an app-owned staging location where practical. The Host validates declared outputs, path scope, file existence, size, expected type, and provenance before atomically committing them to the authorized destination and acknowledging success to Pi. Jobs with external or non-stageable side effects still use the Host permission and audit path; interruption after dispatch follows Unknown Tool Outcome rather than assumed rollback.

Cancellation or application exit terminates the supervised process tree, marks uncommitted staging artifacts incomplete, and preserves bounded sanitized stdout, stderr, exit code, duration, dependency versions, and warnings. No completed side effect is replayed automatically. Job concurrency participates in the installation-wide execution and resource limits so multiple Threads cannot start unbounded OCR models, Office instances, or installers.

Approved and pinned Pi Extensions are the narrow exception: they execute inside the relevant Agent Worker because they require Pi lifecycle and tool hooks. Approval makes the artifact eligible but leaves it disabled; only a separate explicit Global Extension Enablement may load it. Enablement is installation-wide and applies consistently to Project and Unscoped Workers; the MVP has no per-Project or per-Thread Extension profile. Importing a Skill cannot approve, enable, install, or load an executable Pi Extension implicitly. Host-proxy calls and requested durable product-state commits still cross Host authorization and result recording, but direct filesystem, network, subprocess, session, or in-process access by Trusted Worker Code is not claimed to be intercepted by Access Mode. An Extension crash is contained to that Agent Worker rather than Electron Main.

Threads do not share:

- LLM context windows.
- Chat transcripts.
- Compaction summaries.
- Pending assistant state.

Threads may share:

- Project Context.
- Project Memory through recall.
- Outputs.
- Provider status.
- Tool registry.
- Skills loaded for the project.
- Artifact metadata.

The guiding rule is:

```text
Cross-thread sharing is project state, not model context.
```

### Concurrent Turn Execution

Each Thread may have only one Active Turn. Different Threads may have Active Turns concurrently, including Threads that belong to the same Project. Switching Threads or Projects, navigating elsewhere in the app, or minimizing the window does not pause or cancel an Active Turn.

The Host enforces a bounded installation-wide concurrency limit covering ordinary Turns and model-running workflow stages. The first release does not require a specific numeric limit in the product contract; it must be small enough to avoid uncontrolled Provider rate pressure and local OCR or Office contention. A prompt that cannot start immediately enters a visible Execution Queue. The User can inspect and cancel queued work, and queueing must not merge Thread contexts or task objectives.

The desktop application is single-instance by default. Launching it again focuses the existing instance instead of creating another writer over the same app-level state. This does not lock transparent Project or Memory files against external editors; vc-agent detects their changes and applies the external-file propagation rules below.

If the User sends a message while the same Thread has an Active Turn, the message becomes a Queued Follow-up for the next Turn. It remains editable and cancellable until execution begins and does not steer, mutate, or extend the Active Turn implicitly. `Stop` cancels the Active Turn and produces an Interrupted Turn under the existing recovery policy; it does not automatically submit a Queued Follow-up.

Concurrent tasks may share Project State but not model context. A write collision occurs when two tasks target the same existing path or incompatible shared state. The Host must not ask the LLM to merge concurrent writes implicitly. Under Standard Access it pauses the conflicting write for scoped confirmation; under Full Access it executes the requested operation without a prompt and visibly records the overwrite or failure. Writes to one target must be finalized atomically where the filesystem permits so concurrent execution does not produce an apparently complete mixed file.

Dream and Investment Reflection may occupy execution slots alongside ordinary Active Turns. Dependency-ordered stages within one run remain ordered; independent scope work may be scheduled within the same bounded limit without changing scope isolation or Cognitive Review Gates.

### Explicit Sub-Agent Runs

Ordinary Turns use one primary Agent and do not create auxiliary model tasks by default. A Sub-Agent Run begins only from explicit User intent for the current task, such as asking for multiple Agents, parallel research, an independent critic, or internal task delegation. Full Access does not supply this intent. Authorization ends with that task and does not become a standing Thread mode or permission for later prompts.

After a Sub-Agent Run is authorized, the primary Agent autonomously decides:

- How many Sub-Agent Tasks are useful.
- Each task's role, objective, context boundary, and expected result.
- Which tasks run sequentially or concurrently.
- Whether to use a configured common role or create a task-specific temporary role.
- How to compare, challenge, reconcile, or preserve disagreement among returned results.

Delegation is flat in the first release. Only the primary Agent may create Sub-Agent Tasks; a child task cannot create another Sub-Agent or internal model task. A child may still use its authorized tools and make the ordinary model calls required to complete its bounded objective.

Each Sub-Agent Task has an isolated model context and receives only the instructions, Project or Unscoped materials, evidence references, and bounded prior results needed for its objective. It does not inherit another Sub-Agent's raw context, the primary Thread's full trajectory, Project Memory, or Long-term Memory unless the explicit delegated objective and normal recall policy require them. The primary Agent receives bounded results rather than hidden reasoning or complete child transcripts.

The primary Agent assigns each child a minimal Sub-Agent Capability Set when creating it. The task tree shows the enabled tools, allowed side-effect class, and expected Output or external destination. Common research, analysis, and critic roles default to read-only material, web, parsing, evidence, and computation capabilities. They do not receive write or external-side-effect tools merely because those tools are active for the primary Agent.

When the current User task calls for document, spreadsheet, presentation, data, or other artifact creation, the primary Agent may create a write-capable Sub-Agent Task without asking the User to approve the child itself. That child may write an Output directly to the determined Output Location rather than returning content for redundant regeneration by the primary Agent. Every resulting artifact records its Sub-Agent Task id, role, resolved Model Profile, source materials, tool, timestamp, and warnings in normal provenance.

External writes, logged-in actions, deletion, and Original Source File replacement performed by a child follow the installation's Access Mode exactly as if the primary Agent performed them: Standard Access confirms sensitive actions and Full Access does not. Explicit authorization of a Sub-Agent Run does not expand the User's task objective, Project or Unscoped data scope, Provider authorization, or external destination scope.

No Sub-Agent Capability Set may contain tools that directly start or resume Dream or Investment Reflection, perform Thread Scope Elevation, or write Project Memory, Long-term Memory, Judgment Records, Cognitive Evolution History, or Dream review state. This prohibition applies in Full Access because those operations remain behind the Cognitive Review Gate.

Child tool calls appear nested below that Sub-Agent Task with their inputs, bounded outputs, affected paths or destinations, and failures. Concurrent child writes use the same target-collision and atomic-finalization policy as other tasks; the Host never asks children to merge the same target implicitly.

The active primary Model Profile may define Sub-Agent Model Assignments for common roles such as research, analysis, critic, document, or visual work, plus an optional Default Sub-Agent mapping. These labels are user-configurable defaults rather than fixed Agent types. Model resolution for a Sub-Agent Task is:

```text
Matching Sub-Agent Model Assignment
> Default Sub-Agent assignment
> primary Thread's Active Model Profile
```

The actual Provider, Model, role, objective, status, input/output token usage, and result of every Sub-Agent Task remain visible in a task tree attached to the primary Turn. A Provider Failure never triggers an automatic model or Provider fallback. Successful sibling results remain available; the failed task is shown separately so the User can retry it, adjust its Profile, skip it, or continue with visibly incomplete coverage.

Each primary Model Profile defines a default maximum number of Sub-Agent Tasks for one run, using a conservative shipped value until the User edits it. The explicit User prompt that starts a Sub-Agent Run may override that maximum for the current task. A Profile may also define an optional shared Token Budget for the primary Turn and every child model call in that run. When no shared Token Budget is configured, each resolved Model Profile's existing context and output budgets still apply, but there is no additional run-wide token cap.

The Host tracks observed or Provider-reported input and output tokens against the shared Token Budget. Because final usage is known only after a request completes, one in-flight request may finish above the remaining estimate; after the limit is reached, the Host does not start another child or model request. It preserves completed results and offers the User explicit choices to raise the task limit, narrow the remaining work, or continue synthesis with visibly incomplete coverage. The primary Agent cannot silently enlarge either limit.

Manual retries consume the same task's remaining Sub-Agent Budget and are never issued automatically after Provider Failure. Full Access does not bypass a Sub-Agent Budget because Access Mode governs computer permissions rather than model consumption. The first release records request count and input/output tokens by primary and child task but does not enforce a monetary budget; price estimation may be shown only when the relevant Provider and Model pricing configuration is reliable.

Sub-Agent Tasks and any explicit internal model stages share the installation-wide concurrency limit and Execution Queue. Stopping the primary Turn stops unfinished child tasks and creates an Interrupted Turn; completed child results remain visible, while no child task resumes or replays automatically after restart.

Sub-Agent output is not directly eligible for Project Memory, Long-term Memory, Inline Candidate Capture, or Dream recovery. It becomes eligible as user-attributable trajectory only after the primary Agent presents it in the user-visible conversation and the User meaningfully adopts, corrects, or confirms it. A Skill that makes an auxiliary model call must declare and display it as a Sub-Agent Task or other explicit internal model stage with separate model and token provenance; it cannot hide the call inside ordinary tool activity.

### Sub-Agent Task Records

The Host retains a structured Sub-Agent Task Record with the parent Thread trajectory. It includes the delegated objective and instructions, role, resolved Model Profile and Provider, input material and evidence references, model messages, nested tool events and bounded results, Sub-Agent Capability Set, usage, timestamps, errors, and final bounded handoff. The task tree is collapsed by default but lets the User expand and inspect this record without injecting it into the primary Agent's context.

The record must not persist hidden Chain of Thought, credentials, authorization headers, complete unredacted Provider request or response bodies, or other secret-bearing transport data. Provider-exposed reasoning summaries may be stored only when they are ordinary user-visible model output. The primary Agent receives the bounded handoff and stable references, not the complete child trajectory.

Retrying a failed or unsatisfactory child creates a new Sub-Agent Attempt under the same task. Each Attempt preserves its instruction revision, Model Profile, messages, tools, usage, error or result, and timestamp so a retry or model comparison never overwrites prior evidence. Automatic retry remains prohibited.

Sub-Agent Task Records follow Thread Trajectory Retention. Archiving the parent Thread retains them. Deleting the parent trajectory removes every detailed child record and child-only material excerpt. Outputs created by those children remain in their authorized locations, and artifact provenance retains only the minimal child id, role, deletion timestamp, and `source unavailable` state.

The User may delete one Sub-Agent Task Record without deleting the parent Thread. Standard Access uses the existing trajectory-deletion confirmation and Full Access does not pause. The task tree retains a minimal placeholder with task id, role, status, deletion timestamp, and `details deleted`; detailed messages, tool results, errors, and material excerpts are removed. This deletion does not retract text already presented in the parent conversation, delete generated Outputs, or delete approved Memory.

Dream, Inline Candidate Capture, and ordinary Memory Recall always ignore detailed Sub-Agent Task Records, even while those records remain locally available for User inspection. Eligibility continues to depend on user-visible adoption, correction, or confirmation in the parent conversation.

### Ordinary Turn Interruption And Recovery

The Host persists ordinary Thread messages and structured tool events as they complete rather than waiting for the whole turn to finish. Cancelling a run, closing the app, losing a Provider connection, or crashing a worker therefore creates an Interrupted Turn without erasing confirmed progress. Any unfinished Assistant message remains visible and is explicitly marked `Interrupted`; it is never presented as a complete response.

Reopening the Thread after application restart restores its retained trajectory and creates the normal Prompt Load Boundary, but it does not restore an execution stack or automatically issue a model request. The UI shows the interruption reason, last completed event, completed tools, and any in-flight tool. The User may invoke `Continue`, edit and resend an instruction, or leave the Thread as-is. `Continue` is a new model turn over the visible retained state, not an exact replay of the interrupted request.

Tool recovery follows side-effect certainty:

- Completed tool calls and their confirmed results remain in the trajectory and are never replayed automatically.
- Interrupted read-only calls are marked interrupted and may be retried only through a new User-authorized turn.
- Host-owned Output writes use a temporary file and atomic finalization where the filesystem permits. `outputCreated` is emitted only after finalization; an unfinished `.partial` artifact is shown as incomplete and is not a completed Output.
- A partial artifact in an app-owned temporary location may be removed through an explicit cleanup action. A partial or unknown file in a User-selected location is not deleted automatically.
- An external or write-capable MCP/tool call that was dispatched but did not return a confirmed result is marked Unknown Tool Outcome. Before retrying, the app requires inspection of the target state or explicit User acknowledgment that the operation may be duplicated.

Queued Follow-ups not yet sent to the model survive as editable drafts and are not submitted automatically after restart. A request already sent without a completed response remains part of the Interrupted Turn; the app does not manufacture a Provider response or silently resend it.

This ordinary-turn policy restores conversation and known results, not resumable execution. Dream and Investment Reflection retain their separate persisted stage results, Workflow Prompt Snapshot, and explicit Resume or Discard behavior.

### Context Payload Lifetime

Complete content returned by `material_recall`, `project_state_recall`, `memory_recall`, Web, MCP, parsing, Office inspection, direct attachment decoding, and other large read tools is a Turn-scoped Retrieval Payload by default. It remains available to every model step inside the originating Active Turn, including later tool calls and final synthesis. Once that Turn settles, subsequent Provider requests receive a compact Context Reference in place of the full payload unless the primary Agent retrieves it again.

A Context Reference contains the source class, stable source or artifact id, title or label, page/slide/sheet/section or other source range, content version or hash when available, originating tool and Turn, retrieval timestamp, and current known status such as active, stale, changed, deleted, or source unavailable. It contains enough information for the model to request the same bounded source again but not the source body, a generated semantic summary, hidden provenance, or cross-Project identity that the normal recall policy would exclude.

The Pi Adapter applies this model-facing projection before every Provider request after the originating Turn. The original Pi session entry may remain as a local runtime record behind the adapter, and the Thread Trajectory retains the completed visible tool event according to its source-specific retention policy; neither copy makes the full payload part of later Physical Model Context. Public Web remains subject to its transient policy: a reference may retain URL, title, access time, and citation metadata but must not turn fetched HTML or an extracted page body into a durable snapshot.

Ordinary User and Assistant messages remain in Physical Model Context until Thread Compaction. If the Assistant quotes or paraphrases retrieved content in its answer, vc-agent does not rewrite that answer merely because the source payload retires. Tool results below one deterministic, versioned size threshold may remain in full when they contain no large source body or secret-bearing data; the Host, not the model or Extension, applies the threshold consistently.

On a follow-up, the primary Agent may use the Context Reference with the applicable core or Task-activated capability. Re-retrieval applies current authorization, source version, Parse Refresh Choice, Memory version, explicit-only status, de-identification, and context budgets. It never silently reuses a stale body, replays a side effect, or assumes that a changed Web or MCP source still says the same thing.

### Context Budget Management

Electron Main owns one Provider-independent Context Budget Manager. Before every Provider request, including model steps after a tool result inside an Active Turn, it combines the active Model Profile's context limit and output limit with observed or estimated token use to reserve output space and a bounded Provider safety margin. Individual tools, Skills, Extensions, and the primary Agent cannot assign their own competing context limits or enlarge the request beyond this budget.

The Host assembles or reduces the request in this order:

1. Reserve configured output space and the Provider safety margin.
2. Keep the Minimal VC System Prompt, current User instruction, active tool protocol, and required workflow instructions.
3. Replace every eligible prior Turn-scoped Retrieval Payload with its Context Reference.
4. If retained prior conversation still prevents the projected request from fitting, invoke automatic Thread Compaction and recalculate from the resulting Physical Model Context.
5. Keep current explicit task inputs, User-selected excerpts or attachments, and Explicit Memory Recall before Agent-initiated or automatic recall.
6. Bound Material, Project State, and Memory candidate counts and expansion sizes using their progressive-disclosure interfaces.
7. Reduce Automatic Judgment Recall and other optional context before blocking required current-task content.

Compaction is therefore the normal response to old conversational pressure, not a last resort after discarding explicit current inputs. It may run before a new Turn begins or between model steps in one Active Turn when a new tool result makes the next call too large. The Host records the visible Compaction event and Prompt Load Boundary, then rebuilds the next request; it does not replay the tool or silently submit another independent Agent Turn.

If the current instruction, newly supplied attachments, or required explicit evidence still exceed the budget after eligible prior context has been compacted, further compaction cannot make that new content safe to process. The Host and retrieval tools instead use cards, outlines, targeted excerpts, page or section batches, and iterative synthesis. If no bounded plan can preserve the requested objective, execution stops with a visible context-budget error and asks for a narrower scope. vc-agent never silently truncates the current User instruction, claims to have read omitted content, or replaces unprocessed current source material with a lossy model summary.

The first release exposes per-call context contribution by stable prompt, tool schemas, retained conversation, explicit task input, recalled Memory, recalled Material, and output reserve, but does not expose user-adjustable allocation percentages. Model Profiles continue to own only the underlying context and output limits and related model settings.

### Thread Compaction

When a Thread approaches the active Model's context threshold, the Pi session runtime may run Thread Compaction automatically without user confirmation. The User may also invoke compaction explicitly when they want to reduce the active context while continuing the same Thread. Both paths use the same compaction semantics. The compacted context should preserve only what is needed to continue the current work:

- Current objective and requested deliverable.
- User decisions, corrections, and active constraints.
- Unresolved questions and pending actions.
- Material, evidence, tool-result, Output, and provenance references needed for later drilldown.
- Material Judgment Disagreements or important uncertainty still in play.

Full material bodies, superseded drafts, repetitive conversation, and large prior tool outputs should not be copied into the compaction result when stable references can be used instead. Project Context, Project Memory, and Long-term Memory remain available only through their normal recall mechanisms.

Ordinary Thread Compaction uses that Thread's effective Active Model Profile. Compaction inside Dream, Investment Reflection, or another explicit workflow stage uses the Profile already frozen or resolved for that stage. The first release does not define a separate Compaction Task Model Assignment, choose a cheaper Model, or send the Physical Model Context to another Provider automatically. After an authorized Cross-Provider Thread Continuation, the newly effective Profile may compact the continued Thread under the disclosed retained-context scope.

A failed automatic or manual Compaction is a Provider Failure attached to the attempted request. The Host keeps the pre-compaction Physical Model Context and pending User input, does not retry or fall back automatically, and offers the normal manual Profile adjustment or retry paths. Compaction token and latency usage remain separately visible from the ordinary response that required it.

Compaction appears as a lightweight visible event in the Thread with timestamp and context-usage change. It does not require approval, does not create an Output, and must not write its summary into Project Context, Project Memory, Long-term Memory, Short-term Memory Candidates, or Cognitive Evolution History. Each Thread owns its own compaction state; no compaction result is shared with another Thread.

### Thread Trajectory Retention

The application retains each Thread's original local trajectory and associated Sub-Agent Task Records without automatic expiry until the User explicitly deletes that Thread, its history, or an individual child record. Archiving a Thread only removes it from the normal active view; it does not delete, truncate, or summarize away the trajectory or child records. Thread Compaction changes the active model context but does not replace the retained original trajectory.

Settings must expose local trajectory storage usage and provide per-Thread and bulk history deletion actions. Standard Access requires confirmation; Full Access does not pause for a tool-level prompt. Deletion removes the selected trajectory from future Thread reopening, Dream recovery, source drilldown, and provenance verification. Removing a Project from the sidebar or losing access to its folder is not by itself trajectory deletion.

Already approved Project Memory, Long-term Memory, Judgment Records, and Cognitive Evolution History do not cascade-delete when their source trajectory is deleted. Their provenance metadata remains, but source resolution must return a visible `source unavailable` state rather than presenting the deleted exchange as auditable. The Agent must not infer the missing source text from the surviving Memory wording.

Trajectory deletion also applies a privacy-focused Trajectory Deletion Cascade:

- Remove detailed Sub-Agent Task Records and child-only material excerpts associated with the deleted Thread while retaining minimal `source unavailable` artifact provenance.
- Remove active Short-term Memory Candidates and Recovered Memory Candidates whose only qualifying source is the deleted trajectory.
- Remove verbatim or summarized source excerpts copied from that trajectory into pending or processed Dream Batches.
- Retain only minimal Dream review-history metadata needed to show that a candidate existed, its prior disposition, when its source was deleted, and that no source content remains.
- If a candidate has another retained qualifying source, keep the candidate but remove the deleted source reference and recompute whether the remaining provenance is sufficient.
- Never include approved Project Memory, Long-term Memory, Judgment Records, or Cognitive Evolution History in this cascade.

Deletion confirmation should summarize both the trajectory and unapproved derived content that will be removed. It must state separately that approved records will remain with unavailable provenance unless the User deletes those records through their own controls.

### Thread Persistence And Reconciliation

Thread Trajectory and Physical Model Context use separate persistence because they answer different questions. The Host appends versioned product events to the Thread's `trajectory.jsonl`; this is the authority for what the User saw, what permissions were decided, what tool outcomes are known, what provenance exists, and what content is eligible for Dream or deletion. The Worker persists the Pi session under the same app-owned Thread directory through the Pi Adapter; it is the authority only for the current model-facing message path, Pi tree state, and compaction entries.

Streaming uses a temporary In-flight Turn Checkpoint rather than making each Provider delta a permanent Domain Event. The Renderer receives valid ordered deltas immediately, while Electron Main coalesces the user-visible partial Assistant content and unfinished tool state in memory and atomically replaces `inflight/<turn-id>.json` at one deterministic versioned time-or-size cadence and at tool or message boundaries. A crash may lose only the bounded delta tail since the last checkpoint; the recovered message is labelled Interrupted rather than presented as a complete Provider response.

The checkpoint contains schema version, Thread and Turn ids, last accepted Worker and Host sequence, latest durable user-visible partial content, started tool ids and known status, provisional visible usage when available, and update time. It excludes hidden reasoning, credentials, raw authorization-bearing Provider payloads, unbounded source bodies not already eligible for Thread retention, and any claim that execution can resume. Completed tool results and permission decisions continue to become normal Thread Trajectory events as they complete; the checkpoint tracks only state still needed to explain an interruption.

On normal completion, the Host appends and flushes the terminal message and Turn events using their stable ids, commits terminal Operational State, and only then removes the checkpoint. On startup, a terminal event with the same `turnId` makes any leftover checkpoint stale and removable without creating another message. If no terminal event exists, the Host appends one `turnInterrupted` event carrying the latest durable partial Assistant content and known tool states, applies Unknown Tool Outcome where required, and then removes the checkpoint. Recovery never contacts the Provider, submits a Queued Follow-up, or opens Pi merely to inspect the snapshot.

Every submitted Turn receives a Host-generated `turnId` and idempotency key before Worker dispatch. Commands and Domain Events carry `threadId`, `turnId`, correlation id, monotonic per-Thread sequence, schema version, and any Pi entry id used for diagnosis. The Host durably records the User submission and queued or admitted Turn state before starting Provider work. Streaming deltas may be displayed before individual persistence, but completed messages, tool calls, permission decisions, errors, usage, and interruption boundaries become durable product events as they complete.

For a Host-owned capability, the Host records the call and authorization decision before dispatch, commits any product-state or atomic file result, persists the bounded result and provenance, and only then acknowledges success to the Worker. This ordering prevents a Worker crash from causing the model to observe a successful product write that the Host still considers unknown. Reviewed external tools that cannot offer this ordering use the Unknown Tool Outcome policy.

The Pi Adapter records a Thread Trajectory high-water mark in the Pi session after the Host acknowledges each completed model or tool boundary. On restart, the Host and adapter compare their last shared mark. A Pi-only tail is never promoted silently into user-visible history or treated as proof of a side effect; the Turn becomes Interrupted and the stale tail is excluded by branching or rebuilding the Physical Model Context from acknowledged state. If Thread Trajectory is ahead of the Pi session, the adapter rebuilds a new Physical Model Context from retained acknowledged events and any valid compaction state, records a visible recovery boundary, and does not replay completed tools. An unrecognized schema or irreconcilable mapping stops continuation with a recoverable error rather than guessing.

### IPC Events

IPC should be structured and event-based. Minimum event and command families:

```text
createProjectWorker
closeProjectWorker
openThread
createThread
sendPrompt
cancelRun
turnQueued
queueUpdated
subAgentTaskCreated
subAgentTaskUpdated
subAgentTaskFinished
subAgentBudgetExhausted
subAgentTaskRecordDeleted
messageStarted
messageDelta
messageFinished
toolCallStarted
toolCallUpdated
toolCallFinished
turnInterrupted
toolOutcomeUnknown
permissionRequested
permissionResolved
outputCreated
materialParsed
contextUpdated
projectMemoryUpdated
memoryCandidateCreated
dreamProposalCreated
workerWarning
workerCrashed
```

The GUI should not infer runtime state by scraping text output.

## Project Files And Outputs

The project folder itself is the workspace. The application should not present `.pi-vc` as a workspace concept. The default project-local generated content directory is:

```text
<project>/
  outputs/
    parsed/
    system/
      project.json
    <user-directed or task-appropriate files and folders>
```

Directories are lazy-created only when needed, except that first Project registration creates the minimal `outputs/system/project.json` identity marker required for move continuity.

### Output Intent

Ordinary analysis and discussion remain in the Thread and do not create Outputs merely because a response is long or substantive. Creating a VC Deliverable requires Output Intent through one of these user actions:

- An explicit natural-language request to create, save, export, edit, or generate a document or file.
- Invocation of a loaded Skill that declares a deliverable as part of the workflow.
- A `Save as Output` action applied to an existing conversation response.

The Agent may suggest creating a deliverable, but the suggestion alone does not authorize a file write. Output Intent authorizes the requested deliverable path under existing write and replacement policies; it does not authorize modification of an Original Source File.

Parsed Material Artifacts, artifact registry updates, provider status, and other necessary system state created while performing an already authorized task are not VC Deliverables and do not require separate Output Intent. Their creation remains bounded by the relevant parsing, permission, and system-file policies.

A Project Thread uses `<project>/outputs/` as its default determined Output Location. The User may specify a filename, subdirectory, or another already authorized destination in the prompt; otherwise the LLM selects a task-appropriate name and optional subdirectory under `outputs/`. There is no built-in draft/final classification, promotion action, or lifecycle metadata. The document's intended use is expressed in the User's instruction and its content, not inferred from its directory.

When an Unscoped Thread first receives Output Intent, the app asks the User to choose an Unscoped Output Location or use a one-time `Save As` destination. A chosen location is remembered only for that Thread until the User changes or clears it. It authorizes creation and management of that Thread's Outputs in the selected location, but it does not turn the directory into a Project, authorize scanning or reading unrelated existing files, or grant access to any Project State. The current destination remains visible wherever Output creation is confirmed.

The LLM may create supporting or intermediate files when reasonably necessary to fulfill an authorized request, but it must keep them in the determined Output Location and make their paths visible. Under Standard Access, deleting an existing Output requires a direct User instruction or scoped confirmation; Original Source File replacement retains its second-confirmation flow. Under Full Access, the Agent may delete or replace files without another prompt when it judges that necessary for the current User task. External transmission follows the same Access Mode distinction.

### User Outputs

Outputs may live directly under `outputs/` or in a task-appropriate folder selected from the User's instruction and current task:

```text
outputs/2026-07-06-bp-review/
  claim-check.md
  meeting-brief.md
  edited-deck.pptx
  diff.md
```

The LLM may choose the task folder and file names when the User does not specify them. User instructions take precedence over that choice. The Host ensures the resolved destination is within the determined or otherwise authorized Output Location and reports collisions before destructive replacement.

### `outputs/parsed/`

Project-level location for reusable parsed material artifacts. Parsed outputs should not be nested under thread or task folders by default, because the same source material is often reused across multiple threads and workflows.

Example:

```text
outputs/parsed/
  bp/
    source.json
    parsed.md
    parsed.json
    pages/
      page-001.png
  market-model/
    workbook.json
    sheets/
      assumptions.csv
      revenue.csv
```

The source material remains in its original project location. `outputs/parsed/` stores derived parse artifacts only. Task Outputs should reference parsed artifacts through provenance metadata rather than duplicating them.

Parsed artifact reuse is based on parse identity, not only file path. The identity should include:

- Source location.
- Source content hash.
- Parser type.
- Parser version.
- Relevant capability settings, such as the selected OCR capability or multimodal model path.

If a source file's content hash has not changed and the same parser identity is available, the worker should reuse the existing parsed artifact by default. If the source content or parser identity changes, the previous parse is marked stale or superseded in metadata. When the changed Material is next needed, the User makes a Parse Refresh Choice before parsing continues: `Create New Parse Version` preserves the prior artifact and creates a new Parse Identity, while `Replace Previous Parse` stages and validates the new parse before deleting the selected prior parsed content and making the new artifact active. The preserve option is recommended by default.

The Parse Refresh Choice is a task and retention decision, not an Access Mode permission prompt, so it remains explicit under both Standard Access and Full Access. The UI identifies the changed source, old and new source hashes, affected parser, and whether finalized Outputs or retained trajectory reference the prior artifact. Replacement never edits the Material or rewrites historical Outputs; removed parsed content leaves its prior Parse Identity and bounded provenance metadata visibly `source unavailable`. If refresh fails, the old artifact remains intact even when replacement was selected. Canceling the choice leaves the Material unparsed for the current task rather than silently using stale content.

### `outputs/system/`

Visible system state:

```text
outputs/system/project-context.md
outputs/system/project-context.json
outputs/system/project-memory.md
outputs/system/artifacts.jsonl
outputs/system/provider-state.json
outputs/system/project.json
```

This directory is intentionally visible. Users can inspect it. The agent should not casually edit system files; writes should go through structured Host/worker APIs.

`project.json` contains only the random Project Identity, its schema version, and identity-file metadata required for validation. It must not contain the Project's path, display name, Provider credentials, material summary, or investment content. Manual deletion makes future move recognition unavailable; manual duplication triggers the same Project Identity Collision rules as a copied folder.

### Materials

Materials are normal project files. They are not moved into an `outputs/inbox/` folder by default. The product may index or reference materials through metadata, source links, attachments, and outputs provenance.

If a user imports a file from outside the project, the app should ask where to copy it or put it under the active task output folder. It should not silently reorganize project materials.

When a Project opens, the app automatically builds or refreshes a lightweight Material Inventory containing file identity and basic metadata such as relative location, name, extension or detected type, size, modification time, and parse availability. Inventory creation must not extract document bodies, invoke OCR or visual capabilities, create task-specific Outputs, call an LLM, or inject the complete inventory into model context.

Document content uses On-demand Parsing. A Canonical Parse is created or refreshed only when:

- The User selects or attaches a Material for the current task.
- The current task needs a Material identified through the inventory and the Agent reads or parses it within the existing Project access boundary.
- The User explicitly starts a Parse Batch for selected Materials.
- An Unscoped Thread receives a direct file attachment that the current task needs to inspect.

Opening a Project must not trigger full-folder Canonical Parse, OCR, visual analysis, task-specific Outputs, or LLM analysis. Existing Parsed Material Artifacts are reused through Parse Identity. Model context remains governed separately by Progressive Material Disclosure, so a parsed artifact is not automatically loaded in full merely because it exists.

### External File Change Propagation

The Host watches registered Project and user-level authoritative files and waits for a bounded stable-write interval before reacting, so temporary Office save files and multi-step editor writes do not appear as complete revisions. A detected change refreshes lightweight metadata and content hashes without calling an LLM, starting OCR, or eagerly reparsing document bodies.

For a changed Material, Material Inventory updates immediately and affected Parsed Material Artifacts become stale. Reparse remains on demand. If a task later needs the stale Material, the Parse Refresh Choice pauses that read before new content is disclosed to the model. If an Active Turn already consumed the old Parse Identity when the source changes, the Host does not inject the change, steer the Turn, or rerun it automatically. The Turn may finish with a visible source-version warning, while prepared artifacts or state changes that depend on freshness are marked stale and must be explicitly regenerated or revalidated.

For `project-context.md`, the Markdown file is authoritative. A stable external edit triggers deterministic template parsing and rebuild of `project-context.json` without an LLM. Valid sections become available to subsequent Project Context Recall; malformed content is preserved, excluded where it cannot be parsed safely, and shown with a warning rather than silently repaired or masked by the old JSON mirror. Project Memory and Long-term Memory follow their existing Manual Memory Edit rules and rebuild only derived recall indexes.

Host-managed system and cognitive writes carry the version or content hash read during preparation. If the authoritative target changes before commit, the operation becomes a Stale Write and cannot overwrite the newer content or ask an LLM to merge it, including under Full Access. Dream, Investment Reflection, Memory patches, and Context updates must regenerate or revalidate from current inputs. Ordinary Output, Original Source File, Office, and external-tool collisions retain their existing Access Mode and Unknown Tool Outcome policies rather than becoming a general version-control system. Synchronization-client conflict copies are shown as ordinary files and are never selected as authoritative automatically.

### Baseline Document Parsing

The first release must include a real document parsing path. The MVP should not be limited to mock artifacts or manually supplied text.

Minimum baseline parsing should support:

- PDF extraction through pinned PyMuPDF, including page metadata, native text blocks and word coordinates, images, available table structure, and scanned/OCR-needed detection.
- Modern Office OpenXML materials such as `.docx` and `.pptx`.
- Basic spreadsheet and table extraction for `.xlsx` and `.csv`.
- Plain text and Markdown files.
- Parser metadata, warnings, and source provenance.
- Parsed artifacts written under `outputs/parsed/` and tracked through `outputs/system/artifacts.jsonl`.

Provider-dependent parsing should be available when configured:

- Legacy `.doc` and `.ppt` conversion through a User-supplied Claude Office Skill or its declared Office COM dependency.
- Scanned PDF or image OCR through the Configured OCR Capability.
- Image material analysis through a configured multimodal LLM provider.
- External OCR APIs only after explicit user enablement.

The baseline parser does not need to guarantee perfect layout fidelity. It must produce usable text, references to the source material, parse warnings, and enough provenance for the agent and Outputs tab to show what was read.

PDF parsing is one deterministic page-aware pipeline rather than interchangeable parser providers:

1. PyMuPDF opens the PDF and extracts native page content, geometry, images, and parse diagnostics.
2. The Host evaluates whether each page's native text is usable using bounded quality checks such as non-whitespace content, printable-character ratio, suspicious glyphs, and image-dominant coverage.
3. A usable native page enters the Canonical Parse without OCR.
4. A missing or unreliable native page is rendered by PyMuPDF and sent to ordinary PaddleOCR for text detection and recognition.
5. The Host evaluates the ordinary PaddleOCR result for usable text and for unresolved complex layout, tables, formulas, visual regions, or reading order. A usable ordinary result enters the Canonical Parse without OvisOCR2.
6. A page whose ordinary OCR result is missing, unreliable, or structurally insufficient is sent to local OvisOCR2 for page-level Markdown recovery. OvisOCR2 output is validated for truncation, repetition, malformed table or formula structure, and source-page identity before it can become the preferred page representation.
7. If OvisOCR2 is unavailable or fails validation, the Canonical Parse retains any usable native fragments and ordinary PaddleOCR text with a page-level `complex parse unavailable` warning. An image-only page is marked `OCR unavailable` only when no stage recovered usable text; PyMuPDF is not presented as having recovered text that was never encoded in the PDF.

PyMuPDF, PaddleOCR, and OvisOCR2 remain behind the same `material_parse` capability and do not add separate model-visible tools, provider selectors, or normal-turn prompt instructions. This fixed internal recovery order is not a user-selectable Provider Chain. Parse Identity records each invoked stage, its pinned parser/runtime/model version, duration, source-page mapping, validation outcome, warnings, and which stage supplied the preferred page representation.

Baseline parsing produces one Canonical Parse: a faithful reusable representation of the material. It should preserve source structure such as pages, slides, sheets, headings, paragraphs, tables, images, speaker notes, logical paths, source references, parser metadata, and warnings without forcing the material into a VC-specific schema.

The first release does not generate or maintain a persistent file-bound Structured Projection. Downstream analysis uses Progressive Material Disclosure to retrieve bounded Canonical Parse structure and excerpts. When the current task needs structured content, the Agent creates a Work Output such as a claim table, company fact pack, metric table, memo input pack, meeting brief, or diligence list.

Task-specific structured Outputs must:

- Use only relevant Canonical Parse excerpts and authorized visual or OCR results.
- Preserve source references for substantive extracted claims.
- Mark missing or uncertain information explicitly.
- Keep source facts distinguishable from model analysis and User judgment.
- Avoid turning generic VC knowledge into project facts.
- Remain outputs for the current task rather than becoming a mandatory permanent schema for each source file.

Repeated Work Output structures may later be codified through Skill Creator after Prompt-first Validation demonstrates a stable workflow. The Host does not maintain projection categories, attributes, repair states, or fallback schemas in MVP.

For `.docx` and `.pptx`, baseline parsing is language-first: extract text, document structure, slide text, speaker notes where available, tables, embedded metadata, and source locations. Visual understanding is a separate dependency-driven layer. When visual fidelity matters, a compatible document Skill may render materials to page or slide images using its declared libraries or optional Office COM path, then pass authorized renders to a configured multimodal LLM provider or use them for preview. A text-first LLM cannot be treated as having verified visual fidelity unless render output was inspected by a visual/multimodal path or shown to the User.

Sending rendered pages, slides, images, or other Project materials to an external multimodal LLM Provider is authorized by Project Provider Authorization when the active external Model Profile supports the required visual input. Unscoped material submission is authorized by selecting the external Profile and directly attaching the material for the current task. No additional per-page or per-excerpt confirmation is required, but the system still records Provider and source provenance in metadata or artifact events.

### Progressive Material Disclosure

Parsed materials should be disclosed to the LLM progressively instead of being eagerly inserted into the conversation context. Attaching or parsing a file creates a project-level parsed artifact and a lightweight material card; it does not automatically inject full parsed text.

Default disclosure levels:

1. Material Card: file name, type, size, page/slide/sheet counts, parse status, OCR or visual warnings, and short summary if available.
2. Outline / Structure: PDF sections, document headings, slide titles, speaker notes availability, workbook sheet names, table ranges, and major detected regions.
3. Targeted Excerpts: selected pages, slides, sections, sheet ranges, tables, claims, or keyword-matched snippets.
4. Full Parsed Text: used only when the user explicitly asks for full reading or the task genuinely requires full-document review.
5. Visual / Multimodal: selected rendered pages, slides, or images sent to a configured multimodal provider only when visual understanding is needed and authorized.

The system prompt should instruct the agent to start with material cards and structure, then call material-reading tools for targeted excerpts before requesting full text. This protects the context window while still allowing deep review when needed. Tool activity should show which disclosure level was used.

Material Cards are part of the material inventory and retrieval layer. They should not be copied into Project Context by default.

### Write Permission Model

Default write behavior:

```text
Write new products to outputs/
```

User-specified paths are allowed when the user clearly requests them.

Under Standard Access, Original Source File modification requires an explicit second confirmation. Before modifying or replacing an original file, the GUI must show:

- Absolute path.
- Operation type.
- Change summary or diff.
- Generated edited copy path, when applicable.
- Relevant warnings.
- The fact that the model cannot confirm on the user's behalf.

For Office/PPT/Word files, the preferred flow is:

```text
Generate edited copy in determined Output Location
Generate diff in determined Output Location
Optionally render/preview
Ask user to confirm replacement
Replace original only after confirmation
```

The last two steps apply to Standard Access. Under Full Access, the same operation, paths, summary, warnings, provenance, and result remain visible, but the Host does not pause for confirmation. The flow executes the replacement directly when the Agent judges it necessary for the current User task.

### Office Document Skills

The first release does not build a native Office editing engine. For the Personal Build, the User supplies the complete Claude Code `docx`, `pptx`, `xlsx`, and `pdf` Skill packages to the VC Agent Skills Directory, and vc-agent invokes them directly. These third-party packages remain User-supplied Skills: they are not copied into the vc-agent repository or installer, presented as vc-agent-owned assets, or assumed to be redistributable. Any future release for another user must separately resolve authorization or replace them with distributable Skills.

Compatibility changes should be kept outside the supplied package where practical. A vc-agent Compatibility Overlay may map expected tool names, output locations, rendering commands, and Host permission rules without rewriting the Skill. If the Personal Build requires a local package modification, its provenance and local diff remain visible, and no redistribution right is inferred from that modification. The Skill owns document-generation and editing instructions, scripts, templates, validation, and declared runtime dependencies.

The Host still enforces the product contract around every Office Skill:

- Create new or edited documents under the authorized Output location by default.
- Run Skill scripts, Office automation, and external render commands through Isolated Job Processes with staged outputs rather than loading them into Electron Main or the Agent Worker.
- Preserve source-to-output provenance and show Skill/dependency failures clearly.
- Create or request a human-readable change summary when editing an existing document.
- Allow render or preview only when the Skill's dependencies or an optional Office COM path support it.
- Apply the active Access Mode to Original Source File replacement: Standard Access requires the existing explicit second confirmation, while Full Access records and executes without a tool-level prompt.

No particular Skill guarantees pixel-perfect fidelity. Fidelity is an observable result of the selected Skill, template, libraries, and available render environment; unavailable high-fidelity paths degrade visibly rather than triggering a hidden built-in fallback.

Path and permission priority:

```text
Current explicit user instruction
> Project-level manual setting
> Session temporary authorization
> Tool/workflow default rule
> LLM suggestion
```

## Project Context

Project Context is the project working state. It is not project memory.

Files:

```text
outputs/system/project-context.md
outputs/system/project-context.json
```

The Markdown file is shown in the right panel. The JSON file mirrors the fixed template and stores section metadata for reliable bounded Project Context Recall.

### Context Template

The template is fixed so the LLM can patch sections instead of rewriting the whole file:

```md
# Project Context

## Project Snapshot
- Project:
- Company:
- Sector:
- Stage:
- Current Focus:

## Current Working State
- Active Thread:
- Recent Outputs:
- Current Questions:
- Next Actions:

## Materials Summary
- Key Materials:
- Parsed / Reviewed:
- Missing / Needs OCR:

## Operating Rules
- Output Location:
- Source File Modification:
- Web Access:
- MCP / External Tools:

## Context For New Threads
- Always Include:
- Be Careful About:
- Do Not Assume:

## Update Log
- YYYY-MM-DD:
```

### Context Rules

- User manual edits have highest priority.
- Context is generated or refreshed only by explicit user action.
- The LLM should patch known sections rather than freely rewriting structure.
- The fixed sections are a contract unless the user explicitly edits the template.
- Refresh Context is an update/patch operation for the current project state. It should not append duplicate historical content into normal sections.
- Only `Update Log` is append-style; all other sections should reflect the latest compact current state.
- Refresh Context generates a section-level patch preview and short change summary. Standard Access requires the User to apply it before the files are written; Full Access keeps the patch visible and writes it without a subsequent tool-level prompt when refresh was part of the current task.
- Materials Summary should stay compact and only include core project-relevant material status. It should not become a parsed material index, parse id list, or full source inventory.
- New Project Threads do not inject Project Context or a generated digest by default.

### Project Context Recall

Project Context is loaded only when the conversation needs project working state or the User explicitly asks to reference it. A new Project Thread starts without Project Context, Project Memory, material bodies, or prior Thread summaries in model context.

The LLM may use Project Context Recall when:

- The User asks about the Project's current focus, status, questions, next actions, operating rules, or recent progress.
- A task would materially depend on Project-level working state that is not present in the current Thread.
- The User explicitly asks to use, inspect, or compare against Project Context.

Recall should retrieve only relevant fixed-template sections from `project-context.json` or `project-context.md`, with an explicit size budget. It does not require an LLM-generated startup digest, freshness preflight, or blocking confirmation. Recall activity appears inline as a lightweight tool event showing the sections and update timestamp used.

Project Context Recall is not Memory Recall and does not read Project Memory, Long-term Memory, parsed materials, artifact registries, Web results, OCR text, or other Thread transcripts. Project Context is working state rather than source evidence and should be identified as such when it influences a response.

Unscoped Threads cannot use Project Context Recall. If relevant Context is unavailable or incomplete, the Agent continues with the current conversation and may state what project state is missing rather than silently importing other Project data.

## Project Memory

Project Memory is user-confirmed project judgment.

File:

```text
outputs/system/project-memory.md
```

It is an append-style Markdown notes file. The file does not use a fixed global template, but individual memory entries should use a light fixed structure so recall and Dream can work reliably. Example structure:

```md
# Project Memory

## 2026-07-06 - Production Scalability Is Main Risk
Tags: risk, diligence
Source: user-confirmed
Scope: project

用户确认：本项目最大风险不是市场需求，而是材料发现结果能否稳定规模化生产。

Related:
- Thread:
- Output:
```

Rules:

- Only user-confirmed project judgments, corrections, preferences, and decisions should be written.
- Ordinary agent output must not be written automatically.
- Parsed documents, OCR text, and web results must not be written directly.
- The agent may ask whether something should be remembered.
- Immediate Project Memory writes should use a draft-confirm flow. The LLM drafts a concise memory note with title, tags, body, and source context; the user confirms before the note is appended.
- The User may edit `project-memory.md` directly inside or outside the application. A detected Manual Memory Edit becomes the Project's authoritative active memory without an LLM call or confirmation dialog; the app records the manual source and rebuilds that Project's derived recall index. It preserves malformed User content and surfaces a parse warning rather than silently repairing the file.
- A manually added entry remains eligible for recall even when it has no Thread, Output, material, or Reflection source. The derived index labels it `User-authored / no evidence provenance`; this identifies a current User view, not an externally verified fact or retrospectively supported learning.
- A manual deletion takes effect immediately after refresh and does not create an automatic archive or cognitive-history record.
- A Manual Memory Edit changes the Project Memory version. Any prepared Dream or Reflection result that depends on the previous version becomes stale and must be regenerated or revalidated before write; it must not be automatically merged over the User's file change.
- New threads do not inject Project Memory in full by default.
- Project Memory is recalled on demand when relevant or when explicitly requested.
- Project Context Recall does not read Project Memory.

### Memory Recall Policy

The system prompt should support two bounded, visible recall modes across Project Memory and active Long-term Memory. Neither mode injects memory in full by default.

The first release uses a deterministic local retrieval layer and does not require an embedding model, vector database, or auxiliary ranking model call. Authoritative Markdown and Canonical Parse files are parsed into typed, rebuildable recall units. A shared retrieval kernel may serve Material, Project Context, Project Memory, and Long-term Memory, but source-specific scope, authorization, active-version, explicit-only, de-identification, staleness, and malformed-content filters run before ranking; sharing the kernel never merges the source domains or their policies.

Candidate retrieval combines structured metadata such as source type, tags, industry, financing stage, applicability, version, and conflict state with local language-appropriate full-text matching. The implementation must support Chinese and English text without depending on a Provider. Exact matches and explicit structured filters are preferred where available; recency, repetition, or confidence language must not silently override applicability or conflict rules. The index contains only derived copies and references and may be deleted and deterministically rebuilt without changing Memory or Project files.

Recall uses progressive disclosure inside the existing core tool call:

1. The primary Agent submits a task-grounded query and allowed source scope.
2. The Host applies policy filters and returns a bounded set of Memory Recall Cards with stable ids, scope, title, applicability, status, conflict indication, and a short match reason or preview.
3. The primary Agent selectively expands only the cards needed for the current judgment.
4. The Host returns the bounded active content and permitted provenance fields under per-call and cumulative context budgets.

Project Context and Material retrieval follow the same candidate-then-expand interaction through their own core tools and payload types. A future optional Embedding Adapter may contribute candidate scores behind the retrieval interface only after its model, privacy, migration, and dependency behavior is explicitly configured; it must not change authoritative files, bypass source-specific filters, or become required to open existing Memory. It is outside the first release.

1. Automatic Judgment Recall: the LLM has constrained autonomy to retrieve relevant memory when a judgment-heavy task would materially benefit from prior user-confirmed views.
2. Explicit Memory Recall: a natural-language request such as "参考项目记忆", "结合我以前的判断", or "借鉴长期记忆" immediately authorizes relevant recall even when Automatic Judgment Recall would not otherwise have triggered it. No fixed slash command is required.

The LLM may use Automatic Judgment Recall when:

- The task depends on user-confirmed project judgments, such as drafting an IC memo, meeting brief, investment view, diligence question list, risk assessment, or thesis update.
- The task compares current findings against prior conclusions or asks whether a view has changed.
- The task is likely to be harmed by ignoring known user corrections or project-level decisions.

The LLM should not use Automatic Judgment Recall for:

- Basic document parsing.
- Neutral source summarization.
- Mechanical table extraction.
- Read-only web search where no project judgment is requested.
- Project Context Recall itself.

Explicit Memory Recall takes precedence over these automatic exclusions. A general request to "use my memory" searches both relevant Project Memory and active Long-term Memory; a request naming one scope searches that scope first. Explicit recall bypasses task classification but does not bypass relevance filtering, per-call and cumulative context budgets, active-version rules, or provenance display. The User may explicitly ask to expand or inspect additional results.

Long-term Memory entries marked `Explicit Recall Only` are always excluded from Automatic Judgment Recall. They become eligible only when the User's request explicitly asks to use that entry or relevant explicit-only memories. This policy controls recall initiation; it does not grant access to a source Project, classify content sensitivity, or permit the Host to infer that project-specific facts belong in Long-term Memory.

In an Unscoped Thread, Automatic Judgment Recall and Explicit Memory Recall may search active Long-term Memory but must never search Project Memory or any Project State. A Long-term Memory entry may retain local provenance pointing to a source Project, but that reference does not authorize retrieval of the source Project's Context, materials, files, Outputs, or Project Memory.

The model-facing Long-term Memory recall payload contains only the current abstract learning, industry or financing-stage applicability, limitations, maturity, tags, and conflict state needed for the task. Project identity, company name, path, original excerpt, unpublished metric, deal term, and source-material content are excluded from ordinary recall. The local UI may display provenance to the User without adding it to the Provider request. Provenance drilldown is available only from the source Project during explicit Reflection or source verification and remains governed by that Project's Provider Authorization.

When memory is recalled, the assistant should treat it as user-confirmed judgment or Investment Learning, not as source evidence. It should distinguish Project Memory from Long-term Memory and both from parsed materials, web sources, and generated analysis. A manual entry without traceable evidence provenance remains recallable but must be identified as `User-authored / no evidence provenance`; it cannot be presented as an externally verified fact or retrospectively supported learning. If relevant Long-term Memory contains an Unresolved Memory Conflict, recall must present the competing views together rather than selecting one silently.

Memory recall activity should be shown inline in the conversation like a lightweight tool call. The default display may be collapsed, for example `Recalled 2 project memories and 1 long-term learning`, with an expandable view showing source scope, titles, dates, maturity, tags, and relevant excerpts. This keeps memory influence auditable without forcing memory content into the main answer.

## Long-Term Memory

Long-term memory is global application state, not project right-panel state. It belongs in app-level settings.

The settings page should show:

- Global memory location.
- Open file/folder action.
- Refresh/re-index action.
- Recent memory file list or summary.

Long-term memory is Markdown-first and user-editable. The agent must not automatically write long-term memory without explicit user confirmation.

Long-term Memory's maximum content specificity is an industry, financing stage, or comparable reusable investment situation. It may contain a personal heuristic, preference, diligence pattern, risk lens, memo standard, applicability boundary, limitation, or abstract retrospective learning. Named-company facts, unpublished company metrics, transaction terms, material quotations, project-specific conclusions, and other deal-level information belong in Project Memory or Project materials, not Long-term Memory.

Project-derived Long-term Memory retains Local Memory Provenance without putting Project identity into active Memory content or ordinary recall. Active entries and Cognitive Evolution History may carry opaque source-reference ids. An app-owned transparent local provenance registry maps those ids to the source Project Identity, Reflection or Dream run, Judgment Record, Thread, Turn, Output, and eligible evidence references. The Host may use that mapping to prioritize a same-Project candidate and the User may inspect it locally, but the mapping is not source evidence, does not authorize another scope, and is removed from ordinary model-facing recall. Manual entries without a qualifying mapping remain `User-authored / no evidence provenance`.

Long-term Memory has two user-approved entry paths:

1. Reflection path: an Investment Reflection Thread drafts a Long-term Learning Proposal and a Memory patch. After reviewing the proposal and patch, the User may write it directly to Long-term Memory without an additional Dream run.
2. Dream path: ordinary Short-term Memory Candidates are reviewed in batches, synthesized across projects, deduplicated against existing memory, and written only after the Dream confirmation flow.

The Reflection path is reserved for explicit, user-triggered judgment work. It must not become a shortcut for ordinary project conclusions or automatic memory capture.

### Long-Term Memory Evolution

A Long-term Learning Proposal must compare itself with relevant active Long-term Memory before proposing a write. The resulting Memory Evolution Action is explicit and user-approved:

| Action | Meaning | Memory effect |
| --- | --- | --- |
| Add | The learning is materially independent of existing memory. | Create a new active entry. |
| Reinforce | New evidence supports an existing learning without changing its meaning. | Add provenance or increase maturity without duplicating the entry. |
| Narrow | The existing learning remains useful but applies in a smaller domain. | Create a new version with a tighter applicability boundary and preserve the prior version. |
| Revise | The current learning should change because reasoning or evidence changed. | Create a new current version and preserve the prior version with revision linkage. |
| Contradict | New evidence conflicts with existing learning but is not sufficient to resolve it. | Preserve both views as an Unresolved Memory Conflict without silently choosing a winner. |

Long-term Memory entries therefore need stable identity, current-version status, provenance, maturity, and lineage to prior versions or unresolved conflicts. `Narrow` and `Revise` must never erase the earlier wording or contemporaneous rationale. `Contradict` must not be presented as a completed Judgment Revision until later reflection or evidence resolves the conflict.

Recency, repetition count, confidence language, and model preference are not conflict-resolution rules. A proposed `Revise` must point to an attributable User correction or a user-approved Reflection or Retrospective conclusion that explicitly changes the earlier judgment. If two substantive views conflict without that resolution signal, the correct proposal is `Contradict`, preserving both as an Unresolved Memory Conflict. Dream may suggest launching Investment Reflection, but it cannot launch it or decide the winner on the User's behalf.

Long-term memory should separate current learning, disposable condensation history, and durable cognitive evolution:

```text
<long-term-memory-dir>/
  long-term-memory.md
  long-term-memory-condensation-archive.md
  cognitive-evolution-history.md
```

The active file contains current durable Investment Learning. The Condensation Archive contains redundant entries removed by merge, deduplication, or wording condensation. Cognitive Evolution History contains prior versions and relationships produced by `Narrow`, `Revise`, and `Contradict`, including the earlier wording and contemporaneous rationale.

Long-term memory entries should use a light fixed structure similar to Project Memory, with global scope and applicability metadata:

```md
## 2026-07-07 - Conservative TAM Framing For Early VC Memos
Tags: memo, market, diligence
Source: dream-approved
Scope: global
Applies To: early-stage hard tech, IC memo, market sizing
Recall: automatic

我偏好在早期项目 memo 中保守处理 TAM，不把平台型远期市场全部计入可服务市场。
```

This structure gives Dream a stable target format while keeping the file human-editable. `Recall` is either `automatic` or `explicit-only`, defaulting to automatic when omitted. The User may edit `long-term-memory.md` directly inside or outside the application. A detected Manual Memory Edit becomes the authoritative active content without an LLM call or confirmation dialog; the app records that the source was a manual edit and rebuilds the derived recall index. A manually added entry remains recallable without a Thread, Project, material, or Reflection source, but the index labels it `User-authored / no evidence provenance`, and Dream must not upgrade it to evidence-backed or retrospectively supported learning merely because the User wrote it. If an edit appears to contain named-project or deal-level information, the app warns and suggests moving it to Project Memory or marking it `explicit-only`, but does not block or rewrite the User's content. Explicit-only is a recall control, not an exception to the intended Long-term Memory content boundary. Manual authorship does not make the entry immutable: Dream or Reflection may challenge it and propose `Narrow`, `Revise`, or `Contradict`, but only a User-confirmed patch changes the file. A direct manual deletion takes effect after refresh without writing the Condensation Archive or Cognitive Evolution History. The app must not infer a Memory Evolution Action, manufacture provenance, or write Cognitive Evolution History from the textual diff. If the edit breaks the expected structure, the app preserves the file, excludes malformed entries from recall, indexes only entries it can parse safely, and surfaces a warning rather than silently rewriting User content.

A Manual Memory Edit changes the active Memory version used for subsequent recall. Any prepared Dream or Reflection patch based on an earlier Long-term Memory version becomes stale under the existing target-change rules and must be regenerated or revalidated before write, never automatically merged over the manual change. This prevents a later Agent patch from silently overwriting the User's direct edit.

Long-term Memory should support user-approved merge and condensation. The system should not only append new entries indefinitely. Each Dream run should check for overlapping, redundant, or overly granular long-term entries and propose a condensation patch when useful. The patch can merge or rewrite entries into a smaller, clearer entry while preserving the durable Investment Learning. Entries removed only because of merge, deduplication, or wording condensation should move to `long-term-memory-condensation-archive.md` instead of being immediately deleted. Prior judgments changed through `Narrow`, `Revise`, or `Contradict` must instead write to `cognitive-evolution-history.md`. Condensation must be reviewed by the User before writing. A standalone condensation command is not required for MVP.

The Condensation Archive should have both dynamic and manual maintenance:

- Dynamic cleanup: the app checks archived entries against a configurable retention window and can delete expired archived entries after the policy allows it.
- Default retention window: 90 days.
- Supported retention settings: 30 days, 90 days, 180 days, 365 days, or permanent retention.
- Automatic deletion is disabled by default. Expired archive entries are marked eligible for cleanup and surfaced in settings.
- Manual cleanup: settings should provide a review and cleanup action for archive entries.
- If the user enables automatic cleanup, the app should remove eligible archived entries according to the retention policy and record a cleanup log.
- Keep action: the user can keep an archived entry before it expires.
- Re-archive/update action: if an archived entry is still useful as historical context, the user can refresh its archive timestamp or mark it to retain longer.

Condensation Archive entries should include metadata such as archived date, reason, source active entry, replacement entry, Dream batch id, and retention status. Cleanup policy applies only to the Condensation Archive, not active Long-term Memory or Cognitive Evolution History.

Cognitive Evolution History is retained permanently by default and is excluded from automatic cleanup and retention windows. The User may explicitly export or delete it, but ordinary settings cleanup must not include it. It is not injected into normal Threads or loaded in full; Investment Reflection, Investment Retrospective, or an explicit history view retrieves only relevant versions and relationships on demand.

When Long-term Memory is short, Dream may read it in full. As it grows, Dream should use an index, summaries, or relevant-entry recall to keep prompts bounded, then propose additions or condensation against the relevant entries.

### Memory Review State

Short-term memory candidates and Dream batch archives are app-level memory review state. They should not be stored inside the project folder by default.

Conceptual location:

```text
<app-data>/
  memory/
    candidates.jsonl
    dream-batches/
      2026-07-07-dream-001.json
      2026-07-07-dream-001.patch.md
```

This state references a Project by stable Project Identity and uses Project-relative source and Output paths where possible, but it is not itself project content. An absolute path may remain only as a replaceable location hint. It is a private work queue for reviewing user signals and personal investment learning.

Each short-term memory candidate should carry enough project metadata for cross-project Dream grouping:

- Project Identity.
- Project-relative source reference and optional current location hint.
- Thread id and message reference where available.
- Candidate timestamp.
- Captured user signal and source snippet.
- Candidate status.

Project-specific confirmed memories still write to:

```text
outputs/system/project-memory.md
```

Long-term confirmed memories write to the configured global long-term memory Markdown location.

The settings page should expose the memory review state location, open-folder action, and cleanup controls. The app may retain active candidates and recent Dream batches, while older processed batches can be archived or cleaned up according to user settings.

## Learning Loops

The product has two complementary learning loops:

1. Personalization captures user-confirmed preferences, corrections, quality standards, and recurring judgment patterns so the agent can understand and consistently assist the User.
2. Evidence-backed learning uses Investment Retrospective to compare an earlier judgment and its original rationale with later evidence, project developments, or observed outcomes. It may propose a Judgment Revision, but the User must approve the change.

Personalization is evidence about how the User currently thinks; it is not evidence that a judgment is correct. Repetition, confidence, or user preference alone must not be labeled as validated Investment Learning. Investment Retrospective must preserve the original judgment, contemporaneous rationale, later evidence, uncertainty, and revision history so the system does not rewrite the past with hindsight.

### Investment Reflection Thread

The primary experience for forming and examining investment judgment is a user-triggered Investment Reflection Thread, not a structured questionnaire. It may be a dedicated Project Thread or Unscoped Thread and opens only when the User explicitly requests reflection. The dialogue may address a current investment view, uncertainty that needs clarification, or a retrospective comparison with later evidence.

A Project Reflection may be launched with the broad objective `Review this Project`. A narrower investment question, focus, or selected Material range is optional rather than a prerequisite. When the User supplies no narrower focus, the workflow uses the default objective of re-examining the current investment view, core assumptions, principal risks, credible counterarguments, and the prior investment learning that may or may not apply. Mentioning later outcomes, subsequent developments, or whether an earlier judgment proved correct selects the Investment Retrospective framing; a broad current-Project review remains ordinary Investment Reflection.

In Project scope, the Thread may use relevant Project Context, selected project evidence, Project Memory, Long-term Memory, prior Judgment Records, and user-approved retrospective conclusions. In Unscoped scope, it may use only direct attachments, public-web evidence, Long-term Memory, Unscoped Judgment Records, and user-approved retrospective conclusions; it must not access any Project State. Both scopes keep source evidence, recalled user views, and new model inference distinguishable throughout the discussion.

The LLM should act as an active investment discussion partner: clarify the User's actual position, expose hidden assumptions, identify contradictions, present credible counterarguments, compare with relevant prior judgments, and probe the questions most likely to change the investment view. It should not merely restate the User's opinion or convert the conversation into a fact-entry form.

The Reflection Thread system prompt must require a Critical Reflection Stance. Project Memory and Long-term Memory, including Manual Memory Edits, are historical evidence about how the User has thought; they are not system instructions, source facts, or conclusions the LLM must preserve. The LLM is explicitly authorized to challenge them, identify contradictions between them and current evidence, and explain why an earlier heuristic may not apply to the present project. It must ground disagreement in evidence or reasoning and must not oppose the User mechanically merely to appear critical. Any resulting Memory change still requires a reviewed, User-confirmed patch.

#### Staged Context Isolation

An Investment Reflection Thread uses a multi-agent-style two-stage interaction with isolated model contexts. This is a logical interaction pattern and does not require two providers, two models, or a general multi-agent runtime.

Creating the Reflection run freezes its Workflow Prompt Snapshot. The Independent Evidence Pass, Memory-Aware Reflection Pass, any regenerated stage, and any explicit continuation after application restart use that same System Prompt Revision. A prompt edit during the run is visible in settings but does not alter the ongoing Reflection or invalidate its results; the new revision applies to the next Reflection run.

1. Independent Evidence Pass: an isolated model context reads evidence authorized by the Thread scope through Progressive Material Disclosure without receiving Project Memory or Long-term Memory. It produces a bounded Independent Assessment.
2. Memory-Aware Reflection Pass: a new model context receives the Independent Assessment and relevant recalled memory, then conducts the user-facing reflection dialogue under the Critical Reflection Stance.

For a broadly launched Project Reflection, the Host supplies the Independent Evidence Pass with a bounded Reflection Project Brief rather than requiring the User to formulate a detailed question. The brief may contain scope identity, non-memory Project Snapshot fields such as industry and financing stage, Material Inventory cards, and available Output or Judgment Record references. It excludes Project Memory, Long-term Memory, prior investment conclusions, a full Project Context dump, and Material bodies. The first-stage model chooses and expands evidence progressively; broad launch never authorizes eager loading of the whole Project.

After the Independent Assessment is complete, the Memory-Aware Reflection Pass may autonomously query relevant active Long-term Memory and Project Memory through the normal bounded card-then-expand mechanism. Candidate relevance may be direct, such as Local Memory Provenance linking a learning to the current Project, or inferred from industry, financing stage, applicability, risk, diligence question, counterargument, and uncertainty in the Reflection Project Brief and Independent Assessment. Direct provenance raises candidate priority but never makes a Memory correct or converts it into source evidence. The model sees cards before expansion, retrieval remains visible and budgeted, conflicts are returned together, and `explicit-only` Long-term Memory remains excluded unless the User explicitly requests it or names the entry.

The first stage's raw material context, transcript, and full model reasoning must not be copied into the second stage. The handoff is the Independent Assessment, which should contain only:

- Current conclusions and confidence or uncertainty.
- Concise supporting rationale.
- Stable evidence references back to materials, pages, sections, or parsed excerpts.
- Important disconfirming evidence and alternative explanations.
- Unresolved questions most likely to change the view.

The Independent Assessment is an intermediate handoff artifact, not Long-term Memory and not a final Judgment Record. It should have an explicit size budget so the second stage remains focused. The application may implement both stages with separate Pi session contexts using the same model, or use different configured models later without changing the product semantics.

The Memory-Aware Reflection Pass does not preload raw source materials, but it may perform an Evidence Drilldown when the User or LLM needs to verify or challenge a referenced claim. Each drilldown retrieves only a bounded excerpt authorized by the Thread scope around a stable material, page, section, table, slide, or parsed-excerpt reference and keeps the provenance visible in the discussion. Per-call and cumulative retrieval budgets prevent the second-stage context from silently expanding into a full material reload. If a reference cannot be resolved or the retrieved evidence does not support the Independent Assessment, the LLM must mark the claim as unsupported or revise it rather than relying on the handoff summary.

The Thread may end with a proposed Judgment Record and one or more Long-term Learning Proposals, but the conversation is the primary mechanism and these are its reviewable results. A Project Reflection stores a confirmed Judgment Record with the Project; an Unscoped Reflection stores it in the Unscoped Output Location. A Long-term Learning Proposal must state its applicability boundary, source Judgment Records or evidence, limitations or counterexamples, and maturity such as tentative heuristic, repeated pattern, or retrospectively supported learning. The User decides whether to confirm the Judgment Record, directly apply a reviewed Long-term Memory patch, keep the discussion unresolved, or discard the proposals. Creating the Thread, committing the Judgment Record, promoting memory, and applying any Judgment Revision all require explicit user action.

## Dream

`/dream` is the batch memory organization mechanism for ordinary candidates and ongoing Long-term Memory maintenance. It is not the only user-approved path into Long-term Memory:

```text
LLM-driven prepare
Human-approved commit
```

Dream is required in the first usable version. Its minimum viable mechanism adapts the useful core of MiMo Code's Dream design without copying its coding-specific memory semantics:

- Run consolidation in an independent Dream context so ordinary Thread attention and context are not consumed by memory maintenance.
- Isolate first-stage extraction by Project. Threads inside one Project may contribute to the same Project Dream Extraction Pass, but raw trajectory from different Projects must never be combined in one extraction context.
- Process each Unscoped Thread in its own Unscoped Dream Extraction Pass. Do not combine unrelated Unscoped Threads into a virtual Project or shared raw context.
- Treat structured memory and Short-term Memory Candidates as the working index, while retaining an auditable, read-only Thread trajectory as the source used to verify candidate meaning and provenance.
- Inspect recent and relevant records progressively rather than loading every historical Thread into one prompt.
- Merge duplicates, identify stale or conflicting entries, and produce a compact proposed current memory state.
- Keep Dream separate from workflow or Skill extraction; Dream consolidates memory, while future workflow codification remains an explicit Skill Creator activity.
- Restrict the Dream actor to memory-review state and approved memory destinations. It may read source trajectory but must not modify trajectory, Project materials, Outputs, or unrelated files.

Unlike MiMo Code's direct project-memory maintenance, VC Desktop Agent must apply the established investment-memory rules: Dream cannot silently delete a superseded judgment, resolve an Unresolved Memory Conflict, or commit a memory rewrite. `Narrow`, `Revise`, and `Contradict` actions preserve Cognitive Evolution History; merge-only condensation uses the Condensation Archive; all durable writes require the User to review the proposal and final patch.

When Dream compares new and existing candidate content, it classifies the relationship before drafting a patch:

- Duplicate meaning or wording-only variation may produce Merge / Condense.
- An attributable explicit User correction or approved reflective conclusion may produce a proposed `Revise` with preserved lineage.
- Substantive opposition without explicit resolution produces a proposed `Contradict` and Unresolved Memory Conflict.
- Newness, frequency, or rhetorical confidence alone must never cause replacement.

The MVP defaults to a seven-day Dream review interval. On application start or the start of a new top-level Thread, the Host may perform a Dream Due Check using only local scheduling metadata. This check does not call a model, read Thread content, construct a Dream Batch, or start a hidden workflow. When Dream is due, the UI surfaces a dismissible Action Proposal showing the candidate count, projects represented, last completed Dream date, and Dream Model Profile. The User may approve, dismiss for the current interaction, or defer the reminder. The interval is configurable and the User can still launch Dream manually at any time.

The seven-day interval applies only to proposing a new periodic Dream Batch. Existing Dream Carryover or a Resumable Dream Run produces a Pending Dream Reminder immediately on the next app start or relevant memory-state view. This reminder is model-free, non-blocking, and can be dismissed or deferred. It shows the pending type, affected scope count, oldest unresolved date, and last saved stage where applicable.

A Pending Dream Reminder never creates a new batch. If a Resumable Dream Run exists, Resume or Discard must resolve that run before another periodic Dream is created. If only Dream Carryover exists, approving the reminder may create a new batch that includes the carryover and a newly frozen cutoff. Dismissing or deferring the reminder leaves all pending state intact.

Approval of the due Action Proposal starts one Dream run and freezes its Workflow Prompt Snapshot. It does not authorize Project Memory or Long-term Memory changes. Dream may finish preparing and retain a pending proposal, but the User must separately review the final Markdown patch and confirm the writes.

Dream can be launched from:

- Slash command `/dream`.
- Command palette.
- Project Memory tab.
- Settings long-term memory section.

Regardless of launch location, each Dream session reviews app-level short-term memory candidates across all projects. Launching Dream from a Project may preselect or visually focus that Project in the review UI, but the Dream Batch is still cross-project.

Dream inputs may include:

- Short-term memory candidates from app-level Memory Review State.
- Recovered Memory Candidates discovered from Eligible Dream Trajectory within the current Dream Cutoff range or retained as Dream Carryover.
- User-confirmed project signals.
- Existing Project Memory.
- Existing Long-term Memory.
- User-selected thread or output summaries.
- User-approved Investment Retrospective conclusions.

Dream's main job is to find durable personal VC investment learning from project-level experience. It should look for cross-project preferences, heuristics, diligence patterns, risk lenses, memo standards, repeated user corrections, and user-approved retrospective conclusions that may deserve Long-term Memory. It may also organize Project Memory, but it must not promote ordinary project facts into Long-term Memory. A reusable principle derived from a Project must be de-identified and expressed no more specifically than industry, financing stage, or comparable investment situation before it can be proposed for Long-term Memory. Dream must distinguish a recurring personal preference from a principle supported or revised by Investment Retrospective.

Dream must not treat arbitrary agent output, web content, OCR text, or parsed document text as memory source of truth.

Dream also has a bounded recovery responsibility. Each Dream Batch has one shared Dream Cutoff, calculated and frozen when the batch is created as the completion time of the latest eligible user-facing Thread session then available. After Dream starts with User approval, it may inspect Eligible Dream Trajectory after the prior committed Dream Cutoff and through the frozen current Dream Cutoff, plus explicit Dream Carryover from earlier batches, to find strong signals missed by live candidate capture. Eligible Dream Trajectory includes Project Threads, Unscoped Threads, and user-facing dialogue in Investment Reflection Threads. This allows projectless discussions and reflective conversations to contribute personal Investment Learning.

The product does not maintain per-Project or per-Unscoped-Thread time watermarks. Sessions and candidates completed after the current Dream Batch is created are outside its frozen cutoff and remain for the next Dream. They do not invalidate current extraction or synthesis results. The committed cutoff advances only when the Dream reaches a completed batch disposition; discarding an unfinished Dream does not advance it.

Dream must exclude its own sessions, other system-maintenance sessions, Independent Evidence Pass contexts, background helper or subagent sessions, and pure tool trajectories. An Independent Assessment or internal agent conclusion becomes eligible only if it is later presented in a user-facing conversation and the User meaningfully adopts, corrects, or confirms it. Mere generation by a model is insufficient.

Only retained trajectory is eligible. If the User explicitly deletes a Thread or its history before Dream runs, Dream cannot recover signals from that deleted source. Archiving does not have this effect.

Recovery should prioritize User-authored turns, explicit corrections, confirmed Judgment Records, and Memory actions. A recovered item must preserve its Thread, turn, timestamp, scope, and exact or bounded source reference. It enters the current Dream Batch as a Recovered Memory Candidate and has no Memory authority before review.

Trajectory recovery must not convert ordinary assistant conclusions into user beliefs. Assistant text may help locate the surrounding exchange, but a proposal based on it requires a qualifying User signal or previously confirmed Judgment Record. Project materials, tool output, web content, OCR, and parsed text remain evidence, not personal Memory candidates. When a potentially important signal cannot be attributed reliably, Dream should mark it uncertain and Keep Pending or omit it rather than infer authorship.

Short-term memory candidates should capture strong user signals only. Valid candidate sources include:

- Explicit requests such as "remember this" or "use this going forward".
- User corrections to agent conclusions or framing.
- User-confirmed investment judgments.
- Repeated user choices of a specific analysis style, memo standard, risk lens, or diligence approach.
- User-approved Project Memory writes that may contain reusable investment learning.

Short-term memory candidates should not be created from ordinary agent output, neutral source summaries, parsed materials, OCR text, or web results.

Candidate capture should be non-blocking and must not add a separate per-turn model request. Explicit user intent such as "remember this" may be captured through deterministic intent handling. For less explicit strong signals, the model already producing the current response may emit a bounded structured candidate signal within that same turn. When the system captures one, it may show a lightweight inline hint such as `Memory candidate captured`, with an undo or dismiss action. It should not interrupt the conversation with a confirmation dialog. Actual promotion, merge, or discard happens through Dream. If the User explicitly asks to write Project Memory immediately, use the Project Memory confirmation flow instead.

The current-turn model is not required to identify every candidate, and the Host must not silently issue a follow-up classifier call when it emits none. Missed strong signals are handled by Dream's bounded recovery over Eligible Dream Trajectory. Inline Candidate Capture never writes Project Memory or Long-term Memory directly.

Dream flow:

```text
automatic model-free Dream Due Check or manual /dream
→ if automatically due, UI shows an inert Action Proposal
→ User approves one Dream run
→ Host partitions captured candidates and Eligible Dream Trajectory by Project, with each Unscoped Thread kept separate
→ one isolated Project Dream Extraction Pass per Project reads only that Project's candidates, relevant Project Memory, and bounded trajectory excerpts
→ one isolated Unscoped Dream Extraction Pass per Unscoped Thread reads only that Thread's candidates and bounded trajectory excerpts
→ each pass adds traceable Recovered Memory Candidates and emits a bounded summary
→ User approves, skips, or keeps pending each Project or Unscoped summary
→ Global Dream Synthesis reads only approved Project and Unscoped summaries, structured candidates, relevant Long-term Memory, and stable source references
→ UI shows global proposal and suggested memory actions
→ User reviews and may approve actions individually or in bulk, with low-friction destination changes
→ UI shows final Markdown patch preview before writes
→ User confirms final write
→ System writes Markdown and archives candidates
```

The LLM may organize, deduplicate, merge, classify, and draft memory patches. It must not commit those patches without user confirmation.

Dream proposals should distinguish target destinations:

- Project Memory: project-specific judgments and decisions worth keeping with this project.
- Long-term Memory: personal VC investment learning that should apply across projects.
- Keep Pending: candidates that may matter later but are not ready to promote.
- Discard: noise or source-derived content that should not become memory.
- Merge / Condense: update existing Long-term Memory entries instead of appending a redundant new entry.

Dream may propose organizing or condensing manually authored entries and may promote a manually authored Project Memory entry to Long-term Memory after User review. Such a proposal preserves `User-authored / no evidence provenance`; promotion alone does not make the entry evidence-backed. Only a User-confirmed Investment Reflection or Investment Retrospective conclusion with traceable supporting evidence may raise it to evidence-backed or retrospectively supported maturity.

A proposal may write to Project Memory only when it has one clear source project. It must write back to that original project. Proposals synthesized from multiple projects should not be written to Project Memory; they should become Long-term Memory, Keep Pending, or Discard.

An Unscoped Dream Extraction Pass has no Project Memory destination. Its candidates may become Long-term Memory, Keep Pending, or Discard. Dream must not infer a Project association from company names, attachments, discussion content, or similarity to an existing Project.

Each Dream session works on a Dream Batch assembled from Short-term Memory Candidates and Recovered Memory Candidates within the shared cutoff range, plus Dream Carryover. The LLM should review the batch as a whole so it can merge duplicates, detect repeated user signals, and separate project-specific memories from durable long-term investment learning. The review UI must identify whether each item was captured live, recovered during Dream, or carried over, and expose its source reference.

Dream uses project-isolated extraction followed by two-stage review and synthesis:

1. Project Dream Extraction Pass: one isolated model context processes the candidates and Eligible Dream Trajectory for one Project. It may retrieve multiple Threads from that Project progressively, but cannot receive another Project's raw trajectory. It emits structured captured and recovered candidates, uncertainty, source references, and a bounded Project Dream Summary. It does not pass raw conversation or full model reasoning onward.
2. Unscoped Dream Extraction Pass: one isolated model context processes one Unscoped Thread. It emits the same bounded candidate and provenance structure but has no Project association or Project Memory destination. Separate Unscoped Threads never share raw extraction context.
3. Extraction-summary review: the User reviews each Project or Unscoped result before global synthesis with low-friction actions such as Approve, Skip, or Keep Pending. The User is not expected to edit summaries manually.
4. Global Dream Synthesis: after extraction-summary review, a separate context receives only approved, de-identified Project and Unscoped summaries, structured candidates, relevant Long-term Memory, uncertainty, and opaque stable source references. It does not receive Project names, paths, company identifiers, deal-level facts unnecessary to the abstraction, or combined raw trajectories. It proposes Long-term Memory entries for reusable VC investment learning at industry, financing-stage, or comparable investment-situation specificity. The User should be able to approve proposals in bulk while retaining a lightweight way to change a proposal destination between Long-term Memory, Project Memory where eligible, Keep Pending, and Discard.

The extraction and first review stage are scope-local: Project-dimensional for Project Threads and single-Thread for Unscoped Threads. The final synthesis is global-dimensional. Execution may later be sequential or parallel without changing this isolation contract. The User may approve or reject proposed actions in bulk, but final writes to Project Memory or Long-term Memory require a user-reviewed Markdown patch preview.

Extraction failures are scope-local. A failed Project Dream Extraction Pass or Unscoped Dream Extraction Pass shows the sanitized Provider Failure and remains Pending; it does not discard successful summaries from other scopes. The app does not automatically retry, switch Model Profile, or exclude the failure. The User may retry the failed scope, change the workflow-specific Profile and retry, or explicitly skip that scope for the current Dream.

Global Dream Synthesis remains blocked while a failed scope is neither successful nor explicitly skipped. If the User skips one or more scopes, the run enters Partial Dream Coverage. The skipped scope, failure reason, affected candidate count, and missing date range must remain visible in the Global Dream Synthesis, final proposal, and patch preview. Skipped candidates and eligible trajectory stay unprocessed as Dream Carryover even if the batch's shared Dream Cutoff later advances; they must not be archived as reviewed.

Dream progress is persisted after every completed extraction, review decision, Global Dream Synthesis, and patch-preparation stage. If the app exits, crashes, or the workflow is cancelled without discard, the batch becomes a Resumable Dream Run. The next launch shows its completed scopes, pending scopes, coverage state, Model Profiles, Workflow Prompt Snapshot, and last saved stage with actions to Resume or Discard. It must not automatically issue a model request.

Resume revalidates the inputs for every persisted result. An unchanged scope result may be reused without another model call. A Project or Unscoped result becomes a Stale Dream Result when eligible trajectory or captured candidates at or before the frozen cutoff are modified or deleted after extraction, or when relevant Project Memory or applicable source-deletion state changes. New sessions and candidates after the cutoff belong to the next batch and do not cause staleness. Global Dream Synthesis becomes stale when any included extraction result or relevant Long-term Memory changed; a prepared patch becomes stale when its synthesis result or any target Memory changed.

Only stale scopes or stages are rerun. Unaffected results and User review decisions remain intact where their referenced content is unchanged. A stale Global Dream Synthesis or patch cannot proceed to durable write until regenerated and reviewed against current input versions. Resuming model work requires explicit User action, and confirming the final writes remains a separate approval.

Activating a different System Prompt Revision does not make a Dream stage stale. Every extraction, synthesis, selective rerun, and resume remains bound to the Dream run's Workflow Prompt Snapshot. The new revision is used only when a new Dream run is created.

After Dream completes, processed candidates should be removed from the active candidate queue and written to the app-level Dream batch archive with their final status. `Keep Pending` candidates stay active for a later Dream batch. This avoids unbounded growth in the active file while preserving review history outside the project folder.

The completed batch records its single committed Dream Cutoff. Items marked Keep Pending, skipped under Partial Dream Coverage, or otherwise unresolved at or before that cutoff are stored as Dream Carryover and injected into the next approved Dream independently of its newer time range. This prevents the global cutoff from hiding unresolved older inputs.

Dream Batch archival must respect Trajectory Deletion Cascade. An archive may retain candidate disposition and deletion audit metadata after a source Thread is deleted, but it must not retain a hidden copy of deleted transcript content.

No Dream process runs after app exit. A Dream Due Check, Pending Dream Reminder, or Resumable Dream Run may reappear when the app next starts, but model work resumes only after explicit User action.

## Network, MCP, And Provider Policy

### Model Profiles And Task Assignments

Provider and model choice is configured through named Model Profiles rather than hard-coded directly into each workflow. A Model Profile may contain:

- Provider and Model.
- Provider authentication reference.
- Reasoning or generation settings supported by that model.
- Context and output budgets.
- Required capabilities such as text, image input, or tool use.
- Optional Sub-Agent Model Assignments from user-configurable common roles to other Model Profiles, including an optional Default Sub-Agent mapping.
- Default maximum Sub-Agent Tasks per run and an optional shared Token Budget.

Profile configuration performs a lightweight availability and capability check using Pi or Provider metadata and a bounded connection check where supported. It records known support for text, image input, tool use, streaming, and context/output limits without maintaining a separate exhaustive model catalog or continuously probing Providers. Unknown or Provider-dependent capability claims remain visibly unknown rather than being promoted to guarantees.

Before model work begins, the Host performs a Profile Capability Check only for capabilities indispensable to the current task or workflow stage. A compatible Profile proceeds normally. If a defined degradation still satisfies the task, such as text and structure parsing without visual verification, the UI states the omitted capability and the resulting limitation before continuing. If no reliable degradation exists, the turn or stage stops with a specific incompatibility that identifies the selected Provider, Model, and missing capability.

A failed Profile Capability Check never selects another Profile or Provider automatically. The User may choose another Profile in the Prompt Composer or workflow launch surface and retry. Runtime Provider or Pi errors use the existing sanitized Provider Failure path and take precedence over stale capability metadata; configuration metadata is refreshed only through an explicit settings action or normal Profile edit, not by hidden fallback routing.

The User configures Task Model Assignments separately from Model Profiles. Product task types such as ordinary conversation, web research, document generation, Dream, Independent Evidence Pass, Memory-Aware Reflection Pass, Extension Audit, and visual material analysis each select a default Model Profile. Multiple task types may share one profile, and changing a profile updates every assignment that references it.

Thread Compaction is not a separate product task assignment in the first release. It inherits the effective Profile of the Thread or current explicit workflow stage so context is not silently disclosed to another Provider and summary behavior stays aligned with the model continuing the work.

The installation ships with no default Model Profile and no required initial Task Model Assignment. Missing configuration remains silent while the User browses or creates local state. It becomes a local inline execution error only when a submitted Turn or explicitly launched workflow cannot resolve an effective Profile; the app never invents a default Provider, starts Pi to discover one, or repeatedly prompts outside that attempted work.

Sub-Agent Model Assignments do not replace Task Model Assignments and do not create persistent Agents. They resolve only inside an explicitly requested Sub-Agent Run whose primary Agent is using that parent Model Profile. The app validates referenced Profiles and shows missing or cyclic mappings as configuration errors rather than silently selecting another Provider. Agent-created temporary roles follow the matching-role, Default Sub-Agent, then primary Active Model Profile resolution order.

The Prompt Composer displays the Active Model Profile and allows the User to create a Thread Model Override. The override persists for the current Thread until the User selects another profile or chooses `Restore Task Default`; it does not rewrite the Task Model Assignment and does not affect other Threads. The selected profile, resolved Provider and Model, and any profile change must remain visible and be recorded with response or artifact provenance. The application must not silently change Provider or Model during a running turn.

Changing Profiles within the same Provider continues the current Thread directly. Selecting a Profile backed by a different Provider requires one explicit choice in the selector: `Continue Current Thread` performs Cross-Provider Thread Continuation, while `Start New Thread` creates a separate Thread using the selected Profile and its normal Prompt Load Boundary. The choice surface identifies that continuation sends the new Provider the retained conversation context, including prior user and assistant messages, tool results retained in context, disclosed material excerpts, Project Memory, Long-term Memory, and attachments already represented there. The User's `Continue Current Thread` selection is the authorization; it does not produce a second confirmation dialog.

Cross-Provider Thread Continuation preserves the retained context as a coherent history and does not ask an LLM or heuristic filter to remove earlier Memory, material, or Provider-specific turns. Content absent from the retained context is not added merely because the Provider changed. Subsequent Project reads use the new Profile's Project Provider Authorization and Progressive Material Disclosure as usual. The change cannot take effect during an Active Turn; it is applied before the next Turn, or the User starts the new Thread immediately after the current Turn stops or completes.

Dream, Investment Reflection, Extension Audit, and Sub-Agent Tasks remain independently bounded model contexts. Their Profile selectors and assignments send only the inputs defined for their stage or task; an ordinary Thread's Cross-Provider Thread Continuation does not transfer its complete retained context into those workflows.

Independent workflows such as Dream, Investment Reflection, and Extension Audit do not inherit a normal Thread Model Override. Their launch surfaces show the Task Model Assignments for each stage and allow an explicit workflow-specific override before execution. For Investment Reflection, the Independent Evidence Pass and Memory-Aware Reflection Pass may use different Model Profiles. Extension Audit has one bounded workflow Profile and never falls back to the ordinary conversation assignment.

Opening a folder as a Project and selecting or activating an external Model Profile establishes Project Provider Authorization for that Project Identity and Profile. The Provider may receive Project material needed for the current task without per-file or per-excerpt confirmation. Reopening a moved folder and explicitly resolving it as `Moved Project` preserves this association at the newly selected root; a `Project Copy` receives a new identity and does not inherit the original app-level authorization. This is not permission to upload the Project eagerly: Material Inventory, On-demand Parsing, task relevance, and Progressive Material Disclosure still control what is read and sent. The authorization does not extend to another Project, another Provider, external OCR services, MCP servers, or unrelated files outside the Project folder. Provider and material provenance remain visible and auditable.

When the User explicitly starts a Sub-Agent Run, a child Model Profile selected through the active parent Profile's Sub-Agent Model Assignments is activated for that task and receives the same Project-scoped material authorization boundary, Progressive Material Disclosure, and provenance requirements. This does not authorize that child Profile for another Project or later ordinary task. In an Unscoped Thread, child tasks receive only directly attached or otherwise explicitly authorized files.

In an Unscoped Thread, selecting an external Model Profile and directly attaching a file authorizes that file for the current task. Choosing an Unscoped Output Location does not authorize reading or submitting unrelated files already present in that directory.

Provider Failure handling is deliberately simple in the first release. The application does not automatically retry, select a fallback Profile, or switch Provider. It parses the Provider or Pi SDK error response and shows a readable inline error in the conversation, including useful fields such as error code, message, Provider, Model, and request id when available. Secrets, credentials, authorization headers, and complete request bodies must be removed. The failed turn remains visible, and the User may retry manually with the same Profile or change the Active Model Profile before retrying. An independent workflow stops at the failed stage and offers the same manual actions.

In a multi-scope Dream, "stops at the failed stage" applies to the affected scope rather than erasing or rerunning successful scopes. Partial Dream Coverage follows the explicit skip rules in the Dream section.

### Read-Only Public Web

Read-only public web access is a first-party Host capability but is not part of the always-on core tool surface. It is Task-activated through deterministic preactivation when explicit research intent is clear, or through a Capability Activation Request when the primary Agent discovers that current public information is needed during the Turn. Activation exposes the bounded web tools but does not fetch a page, submit Project material, or grant logged-in access by itself.

Default allowed:

- Web search.
- Public URL fetch.
- Public webpage extraction.
- Public PDF extraction.
- Public GitHub/repo fetch.
- Public metadata extraction.

These do not require per-call confirmation. The UI must still show sources, fetched URLs, failures, and warnings inline in the conversation.

Public-web research is real-time and transient in the first release. The app does not create durable webpage snapshots, archive fetched HTML or extracted page bodies, maintain a web evidence cache, or version changing webpages. A saved Output may retain the source URL, title when available, access time, and ordinary citation text, but later source changes or disappearance are not reconstructed locally. A public webpage or PDF becomes a persistent Material only when the User explicitly downloads, imports, or saves it into an authorized Project or Unscoped location; it then follows normal Material, Canonical Parse, and provenance rules rather than a separate web-snapshot lifecycle.

### Higher-Risk Network And Tool Actions

Under Standard Access, these require scoped confirmation or an existing applicable project/provider authorization. Under Full Access, they execute without a tool-level confirmation while remaining visible:

- Logged-in browser access.
- Browser automation.
- Form submission.
- POST/write APIs.
- Uploading local materials without Project Provider Authorization or explicit Unscoped attachment authorization.
- Write-capable MCP servers.
- Downloading and executing files.
- Original source file modification.
- Sending Project materials or rendered document images to an external Model Provider that is not covered by the active Project Provider Authorization.

### MCP Through Pi Extension

The first release does not build a native MCP Server Manager. It bundles a reviewed and pinned `pi-mcp-adapter` version because its proxy-first tool discovery, lazy server lifecycle, metadata cache, and output guard match the Minimal Default Harness. VC Desktop exposes a thin Host integration showing whether the adapter is enabled, its connection or startup status, discovered tool labels, read/write risk, and sanitized failures.

The Host owns adapter configuration and capability exposure. Proxy mode is the default; individual direct tools are opt-in. Only User-configured vc-agent global or Project MCP definitions are loaded. Cross-Agent configuration discovery/import, automatic OAuth, MCP sampling, elicitation, MCP Apps/UI execution, and server-triggered turns are disabled by default and can be enabled only through explicit User configuration where the Host has a corresponding authorization boundary. The package version does not follow npm `latest`; updates are manually reviewed and applied under the ecosystem-package update policy.

MCP tools remain Task-activated Capabilities and subject to Host Access Mode policy. Standard Access confirms write-capable tools, logged-in services, external submissions, and permission expansion; Full Access does not prompt for them. If no compatible Extension is installed or it fails, the app reports MCP as unavailable and does not implement or select another client automatically.

### Lightweight Built-In Providers

The MVP can include or directly load lightweight capabilities:

- Pi SDK/runtime.
- Read-only web tools.
- OpenXML `.docx` and `.pptx` parsing.
- Text PDF parsing.
- Outputs/context/memory registry.

### Optional Microsoft Office Dependency

Microsoft Office desktop/COM is not a required built-in provider. A document Skill may declare it as an optional Windows dependency for legacy `.doc`/`.ppt` conversion, rendering, preview, or stronger local compatibility. If unavailable, that Skill reports the missing path; vc-agent does not silently substitute LibreOffice.

### Configured OCR Capability

The first release fixes the active Configured OCR Capability to a local staged recovery implementation. PyMuPDF native extraction remains authoritative when usable. Ordinary PaddleOCR is the first OCR stage for missing or unreliable native text. Local OvisOCR2 is the final complex-page stage only when the ordinary result is missing, unreliable, or structurally insufficient for layout, tables, formulas, visual regions, or reading order. PP-StructureV3 is no longer part of the active first-release chain. These are internal stages of one configured capability, not separate model-visible providers or a user-selectable Provider Chain.

PaddleOCR, PaddlePaddle, OvisOCR2, their pinned inference dependencies, optional acceleration libraries, and model files are not embedded in the main installer. Standard Access requires review and confirmation of their pinned installation before first use; Full Access may install them for the current task without another prompt while showing the same package, model, size, hardware-path, and version details. OvisOCR2 may run on CPU where the pinned runtime supports it, but CPU availability is not represented as acceptable throughput; Environment Doctor reports whether the validated CPU or GPU execution path is available.

On invocation, the Host records every attempted stage, version, mode, duration, hardware path, source page or image mapping, validation result, warnings or failure, and confirms that processing remained local. OCR-derived text and OvisOCR2 Markdown enter the Canonical Parse as parser-derived blocks with stable source references. Generated OvisOCR2 output never silently overwrites usable native or ordinary OCR evidence: the retained artifact identifies the preferred representation and preserves stage provenance needed for inspection. Any future external OCR requires an explicit design and User enablement because local materials or rendered images may be uploaded.

PaddleOCR and OvisOCR2 run only in the Utility Worker Pool. They may remain warm for bounded reuse, but they do not load into Electron Main or a Project Agent Worker and receive no Provider credentials or unrelated Project content. OvisOCR2 is invoked with deterministic decoding and bounded input resolution, output length, execution time, and repetition cleanup; its generative output must pass structural validation before preference over an earlier-stage result.

When a runtime or model is unavailable, or a stage fails, the affected page retains the best usable earlier-stage result and a specific warning. `OCR unavailable` is reserved for a page with no usable recovered text; `complex parse unavailable` indicates that ordinary text survived but requested structure did not. The User may repair the local installation or manually retry. PyMuPDF is a native parser and renderer, not a second OCR provider. The app does not silently switch to PP-StructureV3, MinerU, Unlimited-OCR, an external API, or another OCR engine.

### Removed From MVP

LibreOffice is not part of MVP:

- Do not bundle it.
- Do not recommend it as default fallback.
- Do not include it in first-run setup.

LibreOffice may remain a future provider extension candidate.

## Skills

Skills use a compatible runtime package format, but vc-agent owns an isolated loading boundary.

The product uses a Conversation-first Workflow model and begins with Prompt-first Validation:

- Host-registered Capabilities provide stable actions such as material parsing, evidence retrieval, web research, output creation, Memory Recall, and Investment Reflection support; imported Skills and Pi Extensions provide optional Office, OCR, MCP, and similar integrations.
- The first release does not require bundled First-party VC Skills. The User exercises real VC workflows through natural-language prompts, the base VC system prompt, and visible Host tool activity.
- Threads remain the interaction surface. Compatible loaded Skills may still be invoked through the command palette or an optional Skill launcher and then continue through ordinary conversation.
- Skill Creator remains an explicit tool for later codifying a workflow after repeated use reveals stable instructions, inputs, outputs, evidence rules, and failure modes.
- Product learning from Prompt-first Validation should precede any decision to bundle a First-party VC Skill.

The runtime discovers Skills from exactly one active VC Agent Skills Directory:

```text
<app-data>/skills/
  skill-creator/
  <future-personal-skill>/
  <future-first-party-vc-skill>/
```

The default location may be changed in Settings, but there is only one active root. The app must not aggregate or directly read Claude Code, Codex, Pi package, Mimo Code, project-local, or other coding-agent Skill directories. The MVP does not require any bundled First-party VC Skill beyond the reused Skill Creator package.

Pi, Claude Code, Codex, or other compatible Skill packages may be reused through Skill Import. Import is a thin isolation operation: it copies the complete package into the VC Agent Skills Directory after showing source, destination, compatibility warnings, missing-resource diagnostics, and overwrite information. Standard Access requires final confirmation; Full Access executes without that tool-level prompt. Imported Skills run from the copied vc-agent-owned location; later edits in the source Agent directory do not affect them unless the User imports again.

Skills may be imported from a local directory or an immutable Git/package source when the selected package format supports it. Before import, the app shows the package source, pinned version or commit, declared license, requested permissions, runtime dependencies, and destination. It must not silently track a mutable branch or unpinned latest version. Under Standard Access, Skill import and updates require a User request and confirmation. Under Full Access, the Agent may perform them as part of the current task without a subsequent tool-level prompt, while still pinning and reporting the selected version or commit.

The Extension admission features below belong to the Integration Build. Foundation, Dogfood Build, and Learning Build expose no action or Agent capability for acquiring, staging, auditing, approving, enabling, or updating arbitrary Pi Extensions. Their app-controlled ResourceLoader accepts only the exact bundled reviewed pinned inventory, including the selected MCP adapter when that integration becomes available. Earlier stages may reserve the loader interface and persistence schema needed by later admission records, but they must not expose a partial or bypassable trust flow.

Pi Extensions use a separate Extension Admission Review instead of direct installation. A proposed Extension is acquired into a non-executing staging area; it cannot be discovered by Pi or loaded into an Agent Worker during review. The review operates on an immutable artifact and records at minimum its source revision, content hash, dependency lock and integrity data, executable entry points, declared filesystem/network/subprocess behavior, requested capability expansion, compatibility result, and review evidence. Host checks and any LLM-assisted review produce an advisory report; neither the Agent nor the audit process may promote the artifact. Only an explicit User approval creates the approval record and moves that exact artifact into the Approved Pi Extension inventory, where it is enabled, disabled, configured, and version-pinned like a bundled reviewed Extension.

Extension Admission Review has two complementary layers:

- Deterministic full-closure inspection inventories every resolved dependency and verifies immutable source identity, package bytes and integrity metadata, exact dependency resolution, lifecycle/install scripts, native binaries, executable entry points, declared permissions, licenses, and available vulnerability advisories.
- Risk-directed LLM review reads the Extension-owned source, lifecycle scripts, and direct dependencies selected for privileged or suspicious behavior. Transitive dependencies remain completely inventoried, pinned, integrity-checked, and vulnerability-scanned, but the report must not imply that every transitive source line received model review.

The deterministic layer is a Host-only Operation. It can be run and persisted without starting Pi or resolving a Model Profile. The model layer is a separate Extension Audit Workflow launched only by an explicit User action after the deterministic report is available. The launch surface shows the selected `Extension Audit` Model Profile, Provider, artifact identity, approximate source size, and that the staged source will be submitted to that Provider. Launching authorizes only this bounded audit submission.

An Extension Audit Workflow creates an independent Physical Model Context using minimal versioned audit instructions that treat all source, manifests, comments, documentation, and dependency text as untrusted data rather than executable instructions. It does not load the Minimal VC System Prompt, any Project or Unscoped Thread history, Project files, Project Context, Project Memory, Long-term Memory, VC Agent Skills, ordinary capability set, or another workflow's results. Its readable inputs are limited to the exact staged artifact, deterministic inspection report, selected vulnerability or package metadata needed to interpret that artifact, and User answers supplied inside the audit workflow.

Extension Audit trajectory and reports are operational security records, not investment cognition. They are excluded from Inline Candidate Capture, Dream eligibility, Memory Recall, Project Memory, Long-term Memory, and ordinary Thread retrieval. The workflow cannot invoke Extension approval, Global Extension Enablement, Project Scope Elevation, Memory writes, Skills, Sub-Agents, or the staged Extension itself. A missing `Extension Audit` Task Model Assignment or launch-time Profile leaves the deterministic report intact and produces the normal local missing-Profile error without starting Pi. Provider Failure preserves completed audit state and requires manual retry or Profile adjustment; no ordinary conversation Profile or Provider fallback is borrowed automatically.

The report separates Extension Admission Blockers from Extension Risk Findings. Missing immutable source identity, unavailable package contents, unresolved dependency versions, absent integrity data needed to identify the reviewed bytes, or an incomplete dependency closure blocks approval and cannot be overridden by the User. Security, privacy, licensing, compatibility, or operational concerns in an otherwise fully identified artifact remain visible risk findings; the User may reject the artifact or explicitly accept those findings when approving it. The proposed Extension remains non-executable throughout both review layers.

Approval never follows only a package name, publisher, mutable branch, semver range, or npm `latest`. Any change to package bytes, source revision, dependency resolution, executable entry points, or requested permissions creates a distinct artifact and requires a new review and explicit User approval before execution. Approval and enablement are separate: a newly Approved Pi Extension remains disabled until the User explicitly enables that exact artifact installation-wide. Neither Standard Access nor Full Access can load an unapproved or disabled artifact, and Full Access cannot turn an Agent or audit recommendation into approval or enablement.

An enabled Approved Pi Extension is Trusted Worker Code. The approval UI must state that it can access data and credentials visible to the Agent Worker and may directly invoke filesystem, network, or subprocess APIs without Host Capability Gateway mediation; Standard Access applies only when the Extension uses Host proxies. Review is a supply-chain and compatibility control, not a hostile-code sandbox or a guarantee of safe runtime behavior. If this authority is unacceptable, the Extension is rejected or reimplemented as a Host-registered Capability or an isolated Skill job. An acquisition, audit, dependency resolution, startup, or provider failure is shown as a sanitized error; vc-agent does not silently approve, enable, switch packages, downgrade versions, or select a fallback capability.

Global Extension Enablement makes the Extension available in every subsequently created or rebuilt Project and Unscoped Agent Worker. It does not imply that every Extension tool schema or instruction enters every Provider request: those surfaces remain Task-activated under the Minimal Default Harness. The MVP does not expose per-Project exceptions, so the enablement UI must disclose installation-wide data reach before the User enables the artifact.

The Host persists one active Global Extension Revision and at most one pending successor. Enabling, disabling, replacing, or rolling back an Extension creates a complete proposed revision containing the exact Approved Pi Extension artifact selected for every enabled package; it never mutates an individual Worker's Extension set in place. New work continues on the active revision while a successor is pending, including work submitted to a newly created Worker, so the application does not drift into mixed Project configurations.

By default, the Host waits until no Agent Worker has an Active Turn. At that Extension Changeover Boundary it atomically marks the pending revision active, terminates every old-revision Worker, and leaves those Workers stopped. Lazy Agent Activation recreates a Worker with the new revision only when later model-backed work is submitted. Extension lifecycle hooks are never hot-loaded or unloaded during a Turn, and a pending revision remains visible and cancellable while waiting.

`Apply now` is an explicit destructive alternative. The UI states which Active Turns will be interrupted; after User confirmation, the Host stops those Turns, records normal Interrupted Turn state, terminates all Workers, and atomically activates the pending revision. It does not automatically resume model work or replay tools. Replaced artifacts and their approval records remain available for explicit rollback while their stored bytes, dependency lock, permission declaration, and approval identity still match. Rollback creates another pending Global Extension Revision and follows the same default or immediate changeover path.

After import, vc-agent delegates Agent Skills discovery, frontmatter validation, description listing, on-demand instruction loading, relative script/resource resolution, and package-resource mechanics to Pi wherever its SDK supports them. vc-agent must not duplicate Pi's Skill parser or package manager. Its custom responsibility is limited to the isolated root, reviewed copy/import, compatibility adaptation for unsupported host-specific directives, permission enforcement, and visible diagnostics.

MVP compatibility target:

- Discover `SKILL.md` files only below the active VC Agent Skills Directory.
- Use Pi to parse and validate frontmatter and load main instructions on demand.
- Preserve referenced scripts, resources, assets, metadata, and licenses during Skill Import.
- Display original import provenance and loading warnings.
- Enable/disable individual skills.
- Reload skills without restarting the whole app when feasible.
- Apply skills as instruction/resource packages through the worker's effective capability set.

Skill compatibility is best-effort across ecosystems. The MVP does not need to support every host-specific directive or tool integration from Claude Code or Codex, but it should load ordinary `SKILL.md` skills and surface clear warnings for unsupported capabilities.

### Skill Settings

Settings should include:

- Loaded skills.
- Active VC Agent Skills Directory, defaulting to `<app-data>/skills/`.
- Open/change directory action; changing it replaces the active root rather than adding another source.
- Import compatible complete Skill package.
- Remove a Skill from the VC Agent Skills Directory.
- Reload skills.
- Enable/disable individual skills.
- View `SKILL.md`.
- View referenced resources/assets where available.
- Warnings for untrusted or invalid skills.
- Approved Pi Extensions with source, exact version, content hash, review status, permissions, dependencies, and enable/disable state.
- An explicit action to stage a proposed Pi Extension for Extension Admission Review; no direct install or load action for unapproved artifacts.
- Separate review-report and explicit User approve/reject actions; neither an Agent recommendation nor Full Access may invoke approval.
- Separate non-overridable Extension Admission Blockers from User-acceptable Extension Risk Findings, with the scope of LLM-reviewed code stated precisely.
- Review history, User decision, approval time, audit report revision, and invalidation reason for replaced or changed Extension artifacts.
- Separate explicit installation-wide enable/disable controls; approval never enables an Extension automatically, including under Full Access, and the MVP exposes no per-Project Extension overrides.
- A Worker-level trust disclosure stating that enabled Extensions may bypass Host-mediated tool confirmation through direct process APIs.
- An installation-wide reach disclosure covering all Project and Unscoped Workers while clarifying that Extension capabilities remain Task-activated in model context.
- Active and pending Global Extension Revisions, affected artifact diffs, waiting reason, cancel-pending action, and estimated Active Turns affected by immediate application.
- Default `Apply when idle` and separately confirmed `Apply now` actions; the latter discloses that all Active Turns will become Interrupted Turns.
- Explicit rollback to a retained still-approved artifact through the same global revision flow; no automatic update or rollback.
- Extension Audit Profile selection, deterministic-report status, isolated workflow status, source-submission disclosure, advisory report, and manual retry without exposing Project or Memory selectors.

The Overview tab should show active skills and loading warnings for the current project/session.

### Skill Creator Meta-Skill

The first usable release includes Skill Creator, but vc-agent does not design a separate creator workflow or rewrite the source Skill. It reuses a compatible Claude Code or Codex Skill Creator as a complete package directory, including every script, reference, asset, metadata file, and license required by that package. Copying only `SKILL.md` is insufficient when its instructions reference bundled resources.

Skill Creator is an explicit user-invoked workflow that can create or update a complete personal global Skill directory. The Host integration supplies only the execution and safety boundary: configured source package, controlled destination, available file/script tools, compatibility diagnostics, and diff preview. Standard Access requires final write approval; Full Access writes without a subsequent tool-level prompt while keeping the diff visible.

Rules:

- It runs only when the user explicitly invokes it.
- It may use current Context, Project Memory, and Outputs as source material.
- It generates or updates a global personal Skill directory, including only the scripts, references, assets, and metadata that the reused Creator determines are needed.
- It writes a Pi / Claude Code / Codex compatible `SKILL.md` format where possible and surfaces warnings for host-specific metadata or directives.
- It writes directly to the active VC Agent Skills Directory, not Project Outputs, an Unscoped Output Location, or another Agent's Skill directory.
- Before writing, it shows skill name, destination path, summary, and overwrite/diff information.
- Referenced Creator scripts may run only through an explicitly allowed Skill Creator Isolated Job Process. A Skill cannot enable general shell access or bypass Host permissions merely because its source package expects a script.
- If a reused Creator package is missing a referenced script, reference, asset, or license, loading fails with a compatibility diagnostic rather than silently running a partial workflow.
- New or updated skills do not automatically affect the current running thread unless the user reloads skills.

External Skills cannot alter the active Access Mode or bypass the Cognitive Review Gate. Their tool calls follow the same Output, network, OCR, MCP, provenance, and Access Mode policies as first-party capabilities.

## Settings

MVP settings should include:

- Model/provider configuration.
- Sub-Agent Model Assignments within Model Profile configuration, including common role labels and Default Sub-Agent.
- Sub-Agent Budget defaults, including maximum flat tasks and optional shared Token Budget.
- Persistent Access Mode selector, with a conspicuous Full Access state.
- Direct Minimal VC System Prompt editor, System Prompt Revision history, diff, activation, and restore-default controls.
- Read-only web access status.
- Bundled `pi-mcp-adapter` status, pinned version, and Host-owned server configuration entry point.
- PaddleOCR runtime/model availability and ordinary OCR execution path.
- OvisOCR2 runtime/model availability, validated CPU or GPU execution path, model footprint, and complex-page mode status.
- PDF Parse Pipeline diagnostics, including pinned PyMuPDF, PaddleOCR, and OvisOCR2 runtime/model availability and stage-validation status.
- Document Skill and declared dependency diagnostics, including optional Office COM when required by a Skill.
- Long-term memory file/folder location.
- Long-term memory refresh/re-index.
- Memory review state location and cleanup controls.
- VC Agent Skills Directory, Skill Import, and reload.
- Environment doctor.
- App data location.
- Local storage and content-telemetry status, Protected Credential management, and a clear Logical Deletion notice.
- Personal Cognition Backup export and restore, with optional trajectory inclusion and an explicit destination-security warning.

Under Standard Access, dependency installation commands require User confirmation. Under Full Access, the Agent may run them without a subsequent tool-level prompt when needed for the current task. In both modes the selected package, source, version, command, and result remain visible.

## Data And Metadata

The project state model should prefer transparent Markdown and JSON files under `outputs/system/`.

### Storage Ownership

Storage is partitioned by semantic ownership rather than putting every local datum into one database:

```text
<Project>/
  outputs/
    system/                 authoritative Project State and provenance
    parsed/                 Canonical Parse artifacts
    ...                     User-requested Outputs

<vc-agent app data>/
  state.db                  Operational State and indexes
  threads/<thread-id>/
    trajectory.jsonl        authoritative Thread Trajectory
    inflight/               temporary In-flight Turn Checkpoints
    pi/session.jsonl        Physical Model Context behind Pi Adapter
    attachments/            Unscoped or copied Thread-local attachments
  cognition/                transparent user-level Memory and evolution files
  skills/                   VC Agent Skills Directory
  cache/                    rebuildable derived data
  logs/                     bounded sanitized diagnostics
```

`state.db` is a local SQLite control store with Electron Main as its only writer. It contains Project Identity-to-location registration, Thread and Turn metadata, Model Profile metadata and credential references, Task Model Assignments, execution queue and leases, workflow checkpoints, schema versions, settings, and rebuildable lookup indexes. It must not become the sole copy of user-authored Project Context, Project Memory, Long-term Memory, Thread message bodies, Outputs, Skills, or Canonical Parse content. Those remain transparent files, while the database may retain ids, hashes, locations, status, and derived indexes needed to coordinate them.

Project files are authoritative for Project content and move with the Project folder. User-level cognition files are authoritative for cross-project learning and remain outside every Project. Thread directories are app-owned and keyed by stable Thread ids so a moved Project reconnects its existing trajectory through Project Identity without copying conversation state into the Project. Pi session files are runtime records rather than Project or cognitive backup assets.

In-flight Turn Checkpoints are temporary Operational State and are excluded from Personal Cognition Backup and normal history export. A raw diagnostic export may include a sanitized orphaned checkpoint only when the User explicitly selects it. A completed or recovered terminal Turn must not retain an active checkpoint.

All app-owned structured files and database rows carry or inherit a schema version. Transparent authoritative files are updated through staged validation and atomic replacement where the filesystem supports it; append-only JSONL records use validated complete lines and monotonic sequence ids. Cache and index corruption is repaired by deterministic rebuild from the applicable authoritative files rather than by model inference.

### Local Data Security

The Personal Build uses Transparent Local Storage. Materials, Outputs, Canonical Parse, Project Context, Project Memory, Long-term Memory, Thread trajectory, Sub-Agent Task Records, Dream review state, artifact metadata, and other user content are not placed behind a separate vc-agent application-encryption vault. Project and Memory files remain directly inspectable and editable; app-owned state remains under the current operating-system user's app-data boundary.

This policy relies on the security of the User's Windows account, filesystem permissions, device access, and optional whole-disk protection such as BitLocker. The app may show the local-storage model and environment status, but it does not claim that plaintext project content is protected from another process or account that can already read those files. Backups, copied Projects, exported Outputs, and user-selected Memory locations inherit the security of their destination.

Provider API keys, OAuth access and refresh tokens, cookies imported for configured authenticated capabilities, and comparable secrets are Protected Credentials. On Windows they use an OS-protected credential facility such as Credential Manager or DPAPI-backed storage. Model Profiles, MCP configuration, and other settings store only credential references and non-secret metadata; they must not write plaintext secrets into Project folders, app configuration, logs, Thread trajectory, Sub-Agent Task Records, artifact metadata, or error payloads.

Content telemetry is off by default. vc-agent does not upload Prompts, material bodies, parsed text, Thread or Sub-Agent messages, Memory, Outputs, tool payloads, or file paths for product analytics or diagnostics. Local token, latency, context-size, queue, capability, and failure metrics may be retained for the User's inspection. Any future remote telemetry is a separate explicit opt-in design and must distinguish operational counters from content.

Application, worker, Provider, MCP, OCR, Office, and Extension logs and errors are sanitized before persistence or display. Sanitization removes authorization headers, API keys, OAuth tokens, cookies, complete request bodies, raw secret-bearing Provider payloads, and unnecessary material or Output content. Useful non-secret fields such as Provider, Model, error code, request id, tool, duration, and bounded failure text may remain.

Deletion is Logical Deletion. The applicable trajectory, Memory, candidate, archive, Output, or state rules determine what vc-agent removes from files, indexes, recall, and UI, but the product does not promise secure physical erasure from SSD wear-leveling, filesystem journals, system restore, backups, synchronized folders, Provider retention, or copies outside its control. The UI and documentation must not describe ordinary deletion as unrecoverable destruction.

### Personal Cognition Backup

The first release provides a lightweight, explicit Personal Cognition Backup rather than automatic cloud synchronization, Project backup, or full application-state migration. Its purpose is to preserve the User's durable cognitive assets and reconstructible personal configuration without carrying working-directory topology or resumable Project execution state.

The backup contains Long-term Memory, Cognitive Evolution History, Condensation Archive, System Prompt Revisions, Model Profiles, Task and Sub-Agent Model Assignments, non-secret application settings, and the VC Agent Skills Directory. Thread and Sub-Agent trajectories are optional and excluded by default because they may be large and sensitive. The export uses a transparent, versioned manifest with schema version and checksums; it is not encrypted by vc-agent, so the export flow warns that the destination determines its security.

The backup excludes the Project registry, Project names, paths, ids, references, Local Memory Provenance mappings, Materials, Outputs, Canonical Parse, Project Context, Project Memory, artifact registry, Physical Model Context, Project-scoped Dream Cutoffs, Dream Carryover, pending review queues, resumable Dream or Investment Reflection state, local caches, and operational logs. Confirmed Dream results that already became Long-term Memory or Cognitive Evolution History remain included through those durable records and opaque source-reference ids, but those references become visibly unavailable after restore when their excluded local mapping is absent. Protected Credentials are never exported, and restored Provider or authenticated-capability configuration requires fresh credential setup.

Restore is mechanical rather than model-mediated. The first release restores only into an empty personal state or, after explicit confirmation, replaces the existing backed-up domains as a whole. It does not semantically merge Memory, infer duplicate judgments, reconcile two cognitive histories, recreate Projects, or relink source folders. Internal lineage among included Memory and Cognitive Evolution records is preserved; source links that depended on excluded Project state remain visibly unavailable rather than being reconstructed or silently removed.

### State Schema Migration

The first release is installed or updated manually and does not contain an automatic application updater. Every vc-agent-owned structured state domain, including Long-term Memory metadata, Cognitive Evolution History, System Prompt Revisions, Model Profiles, workflow state, indexes, and project system metadata, carries an explicit schema version or belongs to a versioned enclosing manifest.

When a supported older schema is opened after an application update, vc-agent runs a deterministic State Schema Migration before normal writes are enabled. Migration may parse and transform Host-owned structure but may not call an LLM, reinterpret investment meaning, summarize content, infer missing provenance, or rewrite user-authored Memory or Skill instructions. Derived indexes may be rebuilt from authoritative files; User-authored content remains authoritative.

Before changing an affected domain, the Host creates a local rollback copy of the files that migration will replace. This short-lived migration safeguard is separate from Personal Cognition Backup and may include only the affected local state needed for exact rollback. Migration writes to staged destinations, validates the complete result, and activates it atomically. On any failure, the prior state remains active, staged changes are retained only as bounded diagnostics or removed, and the User receives a specific sanitized error. A partial migrated state must never become writable.

If stored state has a schema newer than the running application supports, vc-agent enters Read-only Recovery Mode for the affected installation rather than guessing compatibility or migrating backward. The User may inspect state, view the incompatibility, and create supported raw or Personal Cognition exports, but ordinary Turns, Memory edits, workflow commits, settings writes, and other state mutations remain disabled until a compatible application version is installed or the User explicitly restores compatible state. The first release does not promise writable downgrade compatibility or expose a general migration-history interface.

Minimum project state files:

```text
outputs/system/project-context.md
outputs/system/project-context.json
outputs/system/project-memory.md
outputs/system/artifacts.jsonl
outputs/system/provider-state.json
outputs/system/project.json
```

`artifacts.jsonl` should track source-output relationships:

- Source file path or URL.
- Parsed material path.
- Generated output path.
- Diff path.
- Thread/session id.
- Sub-Agent Task id and role when an artifact was created by a child task.
- Tool name.
- Provider used.
- Timestamp.
- Warnings.

The registry is system-maintained. The user may inspect it, but manual edits are not the normal flow.

## Testing And Acceptance

MVP acceptance criteria:

- Open a local project folder.
- Launch into an empty shell with no default Thread or Model Profile, and keep Project opening, Thread creation, and history inspection free of Pi runtime activation.
- Keep Host-only local browsing, deterministic parsing, index rebuilds, settings, backup, and migration usable without a Profile or Pi session; activate Pi only for submitted model-backed work.
- Preserve Project continuity across a user-opened folder move through Project Identity, and require an explicit moved-versus-copy choice for identity collisions.
- Detect stable external file changes without hot-updating Active Turns; rebuild lightweight Context and Memory indexes deterministically and defer changed-Material parsing until an explicit Parse Refresh Choice.
- Create and switch project threads.
- Create and switch Unscoped Threads without opening a Project.
- Start at most one worker per Project only when its first model-backed Turn or workflow is submitted.
- Run Unscoped Threads behind an isolated worker boundary with no Project State access.
- Terminate workers when the app closes.
- Continue Active Turns while the User switches Threads or Projects or minimizes the app, subject to a bounded global concurrency limit.
- Allow only one Active Turn per Thread while permitting concurrent Active Turns across different Threads, including within one Project.
- Put excess prompts and messages sent during an Active Turn into a visible, editable, cancellable Execution Queue without implicit mid-turn steering.
- Make Stop produce an Interrupted Turn and never automatically submit a Queued Follow-up.
- Resolve same-path concurrent writes through Access Mode policy and atomic finalization rather than implicit LLM merging.
- Start a Sub-Agent Run only from explicit User intent for the current task, then allow the primary Agent to create and organize isolated Sub-Agent Tasks autonomously.
- Resolve child models through matching Sub-Agent Model Assignment, Default Sub-Agent, then primary Active Model Profile without automatic Provider fallback.
- Check only task-required Model Profile capabilities before execution; make defined degradation visible, block unsupported tasks specifically, and never switch Profiles automatically.
- Require an explicit continue-versus-new-Thread choice when a Thread switches Provider, clearly disclose the retained context shared by continuation, and never auto-redact or transfer full Thread context into independent workflows.
- Show Sub-Agent role, objective, Profile, status, token usage, failure, and bounded returned result; exclude raw child trajectory from Memory and Dream eligibility.
- Keep Sub-Agent delegation flat, enforce the task-count limit and optional shared Token Budget, count manual retries, and never let Full Access or the primary Agent enlarge limits silently.
- Give each Sub-Agent Task a visible minimal Capability Set; allow explicitly write-capable children to create provenance-tracked Outputs while permanently excluding cognitive-state write tools.
- Retain expandable structured Sub-Agent Task Records and separate retry Attempts with the parent trajectory, exclude hidden reasoning and raw secret-bearing payloads, and support parent-cascade or individual detail deletion.
- Keep content in Transparent Local Storage without an app-encryption vault, store secrets only as OS-protected credential references, disable remote content telemetry by default, sanitize logs, and describe deletion as Logical Deletion.
- Export and mechanically restore a versioned Personal Cognition Backup without Project metadata, operational workflow state, Protected Credentials, or automatic Memory merging; exclude trajectories by default.
- Migrate older vc-agent-owned schemas deterministically and atomically with a rollback copy; use Read-only Recovery Mode for unsupported newer schemas and never use an LLM for migration.
- Retain completed messages, tool events, Outputs, and unsent drafts across an Interrupted Turn without automatically resuming model work or replaying tools.
- Mark dispatched external write operations with unconfirmed completion as Unknown Tool Outcome and require target inspection or explicit duplicate-risk acknowledgment before retry.
- Keep thread LLM contexts independent.
- Retain original local Thread trajectory until explicit deletion; treat archive and compaction as non-destructive, and show `source unavailable` for surviving approved records whose source was deleted.
- Cascade trajectory deletion to unapproved candidate text and Dream source excerpts without deleting approved Memory or Judgment Records.
- Do not inject Project Context into new Threads by default; recall relevant sections on demand.
- Do not inject Project Memory in full by default.
- Parse supported project materials into usable text artifacts with source provenance.
- Create a source-referenced task-specific structured Output from bounded Canonical Parse excerpts when the User's task requires one, without creating a persistent per-file projection.
- Make read-only public web available by default as a first-party capability, but add its tool schemas to a Turn only through deterministic preactivation or a Capability Activation Request.
- Display web sources and tool calls inline.
- Create the Project `outputs/` directory and reserved `outputs/parsed` and `outputs/system` directories lazily.
- Write Project Outputs to a User-directed or LLM-selected path under the determined Project Output Location; write Unscoped Outputs only to the user-selected Unscoped Output Location.
- Show right tabs: Overview, Outputs, Context, Project Memory.
- Generate, edit, and refresh Project Context while preserving the template.
- Append Project Memory only after user confirmation.
- Run one isolated Project Dream Extraction Pass per Project, pass only bounded project-level results into Global Dream Synthesis, and commit only after user approval.
- Run one isolated Unscoped Dream Extraction Pass per eligible Unscoped Thread, never create an inferred Project association, and prohibit Project Memory destinations for its proposals.
- Preserve successful Dream scope results across a scope-local Provider Failure; require manual retry or explicit skip and visibly mark Partial Dream Coverage through final patch review.
- Persist Dream stage results as a Resumable Dream Run, reuse only unchanged results, and selectively refresh Stale Dream Results before synthesis or writes.
- Use one shared Dream Cutoff based on the latest included completed session, with explicit Dream Carryover for every unresolved input at or before that cutoff.
- Freeze the Dream Cutoff when the batch is created so later sessions and candidates roll into the next batch without invalidating current results.
- Recover missed qualifying user signals from bounded Eligible Dream Trajectory as traceable Recovered Memory Candidates, including Project, Unscoped, and user-facing Reflection dialogue while excluding internal model work.
- Run a model-free Dream Due Check on the configured schedule, surface an inert Action Proposal when due, and make run approval distinct from final Memory patch approval.
- Surface Dream Carryover and Resumable Dream Runs immediately through a non-blocking Pending Dream Reminder without creating or resuming model work automatically.
- Capture explicit or strong Short-term Memory Candidate signals without a separate per-turn model request and rely on Dream recovery for misses.
- Include the concise Minimal VC System Prompt on every ordinary model call and keep specialized tools and Skill instructions out of context until task-activated.
- Directly edit, version, diff, activate, and restore the Minimal VC System Prompt without weakening Host-enforced authorization boundaries.
- Apply System Prompt Revisions only at visible Prompt Load Boundaries, preserving the current physical context and cache until compaction/rebuild, application restart resume, or a new Thread.
- Do not provide same-Thread context clear/reset; use a new Thread for a clean context and retain automatic and User-invoked compaction for continuing an existing Thread.
- Freeze one Workflow Prompt Snapshot for each Investment Reflection and Dream run; keep all stages and post-restart resumes on that revision, and apply later prompt changes only to newly launched runs.
- Accept Manual Memory Edits as authoritative Project Memory or Long-term Memory, rebuild the relevant derived recall index without a model call, warn without rewriting malformed content, and invalidate pending results or patches based on the prior Memory version.
- Keep Long-term Memory at industry, financing-stage, or comparable reusable-situation specificity; exclude Project provenance and deal-level facts from ordinary recall payloads, and honor Explicit Recall Only entries.
- Recall manually added Memory without requiring evidence provenance while labeling it as User-authored and never presenting it as an external fact or retrospectively supported learning.
- Apply the complete Manual Memory Edit policy: direct deletion without automatic history, no automatic merge over manual changes, reviewed Dream organization or promotion with provenance preserved, maturity upgrades only through confirmed Reflection or Retrospective, and exclusion of malformed entries from recall.
- Generate an edited `.docx` or `.pptx` copy under the determined Output Location and produce a change summary/diff before original replacement.
- Require second confirmation before Original Source File modification under Standard Access and no tool-level confirmation under Full Access.
- Apply the fixed local page-recovery chain: preserve usable PyMuPDF native content, invoke ordinary PaddleOCR for missing or unreliable text, and invoke OvisOCR2 only when ordinary OCR is missing, unreliable, or structurally insufficient, with no automatic switch to another OCR provider.
- Require explicit enablement for external OCR APIs.
- Invoke the complete User-supplied Claude Code Office Skills from the VC Agent Skills Directory, apply the Compatibility Overlay, enforce edited-copy and Original Source replacement policy, and report missing declared dependencies.
- Connect MCP only through the bundled, pinned `pi-mcp-adapter` while preserving Host permission gates and visible status.
- Prevent Pi from discovering or executing a proposed Extension while it is staged for Extension Admission Review.
- Before the Integration Build, reject arbitrary Extension acquisition and load only the exact bundled reviewed pinned inventory; do not expose a partial audit or direct-install bypass.
- Load only Approved Pi Extensions whose current bytes, dependency lock, source revision, and permission declaration match the recorded approval; invalidate approval on any relevant change in both Access Modes.
- Require an explicit User admission decision after the audit report before creating an Approved Pi Extension record; never permit the Agent, audit model, Full Access, or an update operation to self-approve an Extension.
- Block approval when immutable artifact identity, integrity evidence, or complete deterministic dependency resolution is unavailable; allow explicit User acceptance only for disclosed Extension Risk Findings on a fully reviewable artifact.
- Inventory and integrity-check the full dependency closure while applying LLM source review to Extension-owned code, lifecycle scripts, and risk-selected direct dependencies without claiming line-by-line review of every transitive dependency.
- Run deterministic Extension inspection without Pi, then launch model review only through an explicit isolated Extension Audit Workflow whose context excludes Projects, ordinary Threads, Skills, VC prompts, and all Memory domains.
- Resolve only the `Extension Audit` Task Model Assignment or explicit launch override, preserve deterministic results on missing Profile or Provider Failure, and never borrow another task Profile or fallback Provider.
- Exclude Extension Audit inputs, trajectory, and reports from Dream, candidate capture, Memory Recall, Project Memory, Long-term Memory, and ordinary Thread retrieval.
- Keep a newly approved Extension disabled until a separate explicit Global Extension Enablement, apply enabled inventory consistently to Project and Unscoped Workers, and never let Full Access or the Agent enable it implicitly.
- Disclose and test the Trusted Worker Code boundary: Host-proxy and durable-state requests remain validated, while direct Extension process behavior is not represented as Access Mode-enforced.
- Provide no per-Project Extension override in MVP; verify that global runtime enablement does not make Extension tools or instructions permanently present in every model request.
- Apply enable, disable, update, and rollback through one Global Extension Revision; keep all work on the old revision until the global idle boundary, then atomically activate and terminate old Workers without eager restart.
- Never hot-reload an Extension during an Active Turn; make immediate application interrupt and persist all affected Turns before activation, with no automatic resume or tool replay.
- Permit rollback only to a retained artifact whose bytes and approval identity still match, and route rollback through the same pending-revision boundary.
- Show settings for the bundled MCP adapter, Configured OCR Capability, long-term memory, the VC Agent Skills Directory, and environment doctor.
- Load Skills only from the VC Agent Skills Directory; explicitly import compatible complete packages from Claude Code, Codex, Pi, or other sources before use.
- Run Skill Creator only when explicitly invoked.
- Use Skill Creator to create or update a reviewed personal Skill directory inside the VC Agent Skills Directory.

Test strategy:

- Unit tests for empty first launch, Lazy Agent Activation, Host-only versus Pi-backed boundary enforcement, local parser and OCR execution without Pi, local OvisOCR2 execution without a Model Profile or Agent Turn, model-boundary escalation, missing-Profile inline error and retained prompt, manual retry after Profile configuration, Project Identity creation, moved-path continuity, Project Identity Collision resolution, Project Copy identity replacement, relative-reference rebasing, stable external-write detection, Material staleness, Parse Refresh Choice preservation/replacement/cancellation/failure behavior, Context mirror rebuild, Stale Write rejection, output path policy, persistent Access Mode policy, Standard Access sensitive-action confirmation, Full Access prompt suppression, Cognitive Review Gate invariance, Sub-Agent explicit-intent gating, flat-delegation enforcement, Profile resolution, Profile Capability Check compatibility/degradation/blocking behavior, same-Provider Profile changes, Cross-Provider Thread Continuation authorization and retained-context scope, new-Thread alternative, independent-workflow isolation, inherited Compaction Profile and no fallback, minimum Capability Set selection, cognitive-tool exclusion, task-count and shared-Token-Budget behavior, Task Record redaction and Memory exclusion, Attempt retention, child-record deletion cascade, Long-term Memory specificity validation and warning, recall-payload provenance exclusion, Explicit Recall Only gating, pre-ranking scope and policy filtering, Chinese and English local full-text retrieval, Memory Recall Card progressive expansion, deterministic recall-index rebuild without model calls, Turn-scoped Retrieval Payload retirement, deterministic small-result retention, Context Reference completeness and de-identification, stale-reference re-retrieval, In-flight Turn Checkpoint cadence and sanitization, terminal-event/checkpoint deduplication, orphan checkpoint recovery without Pi, Dream de-identification, Protected Credential reference-only serialization, log and error sanitization, content-telemetry default-off behavior, Personal Cognition Backup allowlist and Project-metadata exclusion, manifest and checksum validation, empty-or-replace restore behavior, deterministic State Schema Migration, atomic activation and rollback, newer-schema Read-only Recovery Mode, Context template parser/patcher, Project Memory append rules, Inline Candidate Capture without auxiliary requests, Thread Trajectory Retention and source-unavailable behavior, Dream Due Check scheduling, Pending Dream Reminder precedence, two-gate Dream authorization, PDF native-text quality routing, fixed PaddleOCR-to-OvisOCR2 stage selection, retention of usable earlier-stage results, OvisOCR2 structural validation, and distinct `OCR unavailable` versus `complex parse unavailable` warnings.
- Worker integration tests for project worker creation, per-Unscoped-Thread worker isolation, thread creation, cross-Thread concurrent execution, one-Active-Turn enforcement, queue admission and cancellation, Sub-Agent session isolation, Utility Worker warm reuse and crash containment, bounded PaddleOCR and OvisOCR2 job cancellation, OvisOCR2 timeout or crash retention of the best earlier-stage result, Isolated Job process-tree cancellation, staged output validation and commit, bounded and sanitized job logs, arbitrary Skill dependency exclusion from Host and Agent Worker processes, reviewed Extension containment, nested tool calls, direct child Output provenance, bounded handoff, parent-stop propagation, mock prompt execution, event emission, Worker termination, Interrupted Turn persistence, atomic Output finalization, write-collision handling, and Unknown Tool Outcome recovery.
- Runtime contract tests for workspace dependency-direction enforcement, Pi and Electron type-boundary exclusion, typed preload surface, cross-process schema-version rejection, Python Job Manifest isolation, Renderer-to-Host isolation, versioned command and Domain Event shape, exact Project and Unscoped core tool surfaces, Unscoped Project-state exclusion, Capability Activation Request resolution and scoping, protected-workflow and Host-only denial, Capability Execution Request authorization, custom ResourceLoader exclusion of default project and global resources, explicit Profile and runtime-credential injection, Pi Adapter event normalization, before-Provider Context Reference projection, originating-Turn payload availability, per-request context projection, pre-Turn and mid-Turn automatic Compaction, post-compaction budget recalculation, explicit-input priority, oversized-current-input progressive handling, Thread Trajectory and Pi-session high-water reconciliation, Pi-only-tail rejection, Physical Model Context rebuild, tool event shape, permission request event shape, output-created events, context updates, memory updates, Dream actor read/write boundaries, recovered-candidate provenance, resumable stage persistence, and stale-result invalidation.
- UI tests for three-column layout, right tabs, Context editor, output index, Active Turn and Execution Queue visibility, queued-message editing and cancellation, Access Mode control and indicator, Standard Access permission confirmation, settings, and Dream review.
- E2E smoke test: open project; parse native-text, scanned, and complex-page fixture materials; verify PyMuPDF, PaddleOCR, and OvisOCR2 stage routing and warnings; generate a source-referenced task-specific Output; invoke a fixture document Skill to create an edited copy; refresh Context; capture a Project Memory candidate; run `/dream`; approve the proposal; and commit memory.
- Capability tests should use fixture Skills, Extensions, OCR/document-model adapters, and mock providers where possible. CI should not require real PaddleOCR or OvisOCR2 weights, external OCR APIs, or Microsoft Office installation. Local diagnostics must clearly report unavailable fixed-chain dependencies; external OCR remains unavailable unless separately designed and explicitly enabled.

## Open Design Constraints

The design intentionally keeps these as constraints rather than unresolved questions:

- No background daemon in MVP.
- No domain switching in MVP.
- No LibreOffice fallback in MVP.
- No automatic memory commit.
- No automatic original file modification.
- No automatic skill generation from normal conversation.

These constraints should be revisited only after the first vertical VC workflow product is usable.
