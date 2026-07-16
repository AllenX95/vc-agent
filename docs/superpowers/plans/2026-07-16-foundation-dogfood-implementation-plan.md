# Foundation And Dogfood Implementation Plan

Date: 2026-07-16

Source: `docs/superpowers/specs/2026-07-06-vc-desktop-agent-design.md`

## Objective

Deliver the smallest runnable path from an empty desktop shell to daily VC work over a local Project: configure a Provider, converse through Pi, inspect and parse materials on demand, research the public web, recall bounded Project state, produce a source-referenced Output, and preserve user-approved Project Memory.

This plan covers only Foundation and Dogfood Build. Learning Build, Integration Build, Delegation And Hardening, arbitrary Extension admission, Office Skills, OCR, MCP, Dream, Long-term Memory, Investment Reflection, and Sub-Agents remain out of scope.

## Planning Rules

- Build vertical slices that are demoable through the desktop application and include persistence, failure behavior, and tests.
- Preserve the Host control-plane and Pi execution-plane boundary from the first model call.
- Do not create substitute abstractions for Pi before the first real SDK tracer succeeds.
- Keep later-stage controls absent rather than exposing mock or partial success paths.
- Use the bundled reviewed pinned Extension inventory only. Arbitrary Extension acquisition is rejected.
- Treat the accepted design specification and ADRs as the behavioral authority. This plan orders implementation; it does not supersede product decisions.

## Forward Compatibility Contract

Excluding a later-stage feature from Foundation or Dogfood means deferring its adapter and UI, not closing the seam it will use. Current slices must establish the following interfaces through real current behavior. They must not build empty plugin frameworks, placeholder feature packages, speculative settings, or fake later-stage adapters.

| Later capability | Seam exercised in this plan | Current compatibility requirement |
| --- | --- | --- |
| Office Skills and Skill Creator | Capability Registry, Utility Job Runner, Output Store, Artifact Registry | The first text/Markdown adapters use format-neutral job, staged-result, Output, and provenance contracts. Core and UI must not assume every Output is Markdown or editable as text. |
| PaddleOCR, OvisOCR2, and future parsers | Material Pipeline, Parser Adapter registry, Canonical Parse | Native parsers emit parser-neutral blocks and warnings. Later adapters implement the fixed page-recovery order PyMuPDF native extraction -> ordinary PaddleOCR -> OvisOCR2 without requiring a second material model or a new model-visible tool. Each stage retains parser-neutral provenance, validation results, and the best usable earlier-stage result. |
| MCP | Capability Registry, Task Activation, Host Capability Gateway, runtime resource snapshot | Web and local tools use the same capability metadata, authorization, event, and bounded-result contracts that an MCP proxy will use. No MCP-specific behavior enters core policy. |
| Skill Import and Skill loading | App-controlled ResourceLoader and immutable runtime resource snapshot | The bundled-only build obtains resources from a Host-supplied snapshot rather than scanning directories or hard-coding package paths inside the Pi Adapter. Integration later changes the snapshot producer, not Pi session orchestration. |
| Extension Admission and updates | Immutable Extension Inventory Snapshot consumed by the ResourceLoader | Foundation accepts only bundled pinned entries. Integration later supplies an approved global revision through the same snapshot shape; unreviewed acquisition never enters the Worker loading path. |
| Long-term Memory, Dream, and Investment Reflection | Versioned Thread Trajectory, scoped Memory Recall sources, explicit write commands | Project Memory remains a project-scoped source. Later user-level memory and review workflows add separate sources and commands without changing historical trajectory meaning or treating current Project Memory as a generic unscoped store. |
| Sub-Agents and broader concurrency | Worker Supervisor, versioned execution/event envelopes, provenance actor metadata | Current primary-Agent execution uses the same actor-aware envelopes and supervision interface. Later child actors add scheduling and records without changing Turn, tool, Output, or provenance identities already persisted. |

The compatibility rule is **add an Adapter, do not replace the path**. A later feature may add registered capability metadata, a new parser or output adapter, a new scoped recall source, or a new Worker actor. It must not require the Renderer to call Pi directly, move product policy into a Worker, bypass the Host Capability Gateway for Host-mediated actions, reinterpret existing trajectory events, or migrate all existing Outputs to a feature-specific schema.

Interfaces should remain deep and few:

- `pi-adapter` hides Pi session creation, resource loading, model submission, streaming, and physical-context persistence from the Host.
- The Capability Registry and executor hide activation, authorization, dispatch, bounded results, and event/provenance recording from Pi and the Renderer.
- The Material Pipeline hides parser selection, versioning, stale handling, page recovery, and Canonical Parse persistence.
- The Utility Job Runner hides process launch, cancellation, bounded logs, staging, validation, and final commit.
- The Output Store and Artifact Registry hide destination policy, atomic commit, media type, producer identity, and source relationships.
- The Worker Supervisor hides process lifecycle and routes versioned actor-aware commands and events.

Every interface above must be introduced only in the first slice that exercises it with a real adapter and an in-memory or fixture adapter used by tests. No general marketplace, plugin SDK, workflow engine, service mesh, or feature-flag platform is part of this compatibility work.

## Proposed Toolchain

- One TypeScript workspace using `pnpm` workspaces.
- Electron, React, Vite, and TypeScript for the desktop application.
- SQLite for Host Operational State; transparent JSONL and Markdown files for authoritative user-visible content.
- Vitest for unit and contract tests; Playwright for desktop end-to-end tests.
- A pinned Pi SDK dependency isolated behind `packages/pi-adapter`.

The exact package versions should be pinned when Slice F1 starts. A different package manager or test runner is acceptable only if the workspace and dependency-direction contracts remain unchanged.

## Foundation Slices

### F1. Boot The Empty Desktop Shell

**Blocked by:** None.

**What to build:** Create the directed workspace, Electron Main and React Renderer, typed preload IPC, Host-owned SQLite bootstrap, and architecture contract tests. Launch into the empty three-column shell without creating a Project, Thread, Model Profile, credential, Worker, Pi session, or Provider request.

**User stories covered:** First launch is useful without setup; local navigation and Settings remain Host-only.

**Acceptance criteria:**

- [x] The application launches and displays the empty shell and Settings.
- [x] Renderer code cannot import filesystem, Electron Main, persistence, Provider, or Pi modules.
- [x] Only `pi-adapter` can import the Pi SDK; `core` contains no Electron, Pi, SQLite, or Python types.
- [x] Architecture contract tests enforce the workspace dependency direction and prevent later feature packages or runtime adapters from being imported into `core` or the Renderer.
- [x] Versioned command and event envelopes support actor/provenance identity without encoding the primary Agent as an unchangeable singleton.
- [x] Launch, Settings navigation, and application exit create no Agent Worker and make no network request.
- [x] Unsupported IPC schema versions are rejected with a visible local diagnostic.
- [x] A Playwright smoke test launches and closes the packaged development application.

### F2. Complete One Unscoped Pi Turn

**Blocked by:** F1.

**What to build:** Let the User create a named Model Profile with an OS-protected credential reference, create an Unscoped Thread, select an Active Model Profile, submit text, lazily start an isolated Agent Worker, execute one real Pi SDK turn, stream the response, and display a sanitized Provider Failure without fallback.

**User stories covered:** Provider-neutral conversation; no default Profile; Codex-like Thread interaction; lazy Pi activation.

**Acceptance criteria:**

- [x] Creating and browsing an empty Thread does not start Pi.
- [x] Submitting without an effective Profile retains the prompt and shows `Model Profile not configured` without starting a Worker.
- [x] Retrying after manual Profile configuration starts one isolated Unscoped Worker and streams ordered text deltas.
- [x] The custom ResourceLoader excludes project/global `.pi`, `.agents`, `AGENTS.md`, external Skills, settings, auth, and arbitrary Extensions.
- [x] Only the bundled reviewed pinned Extension inventory is loadable.
- [x] The Pi Adapter consumes one immutable Host-supplied Runtime Resource Snapshot and Extension Inventory Snapshot; it does not scan resource directories or hard-code bundled package paths in session orchestration.
- [x] Provider errors show parsed human-readable text, retain the User turn, and offer manual retry or Profile adjustment without automatic fallback.
- [x] The UI records the effective Profile, Provider, Model, token usage when available, and completion status.

### F3. Preserve And Recover Thread Trajectory

**Blocked by:** F2.

**What to build:** Persist Host-owned Thread Trajectory separately from the Pi Physical Model Context, add In-flight Turn Checkpoints, Stop, app restart recovery, high-water reconciliation, and same-Thread continuation. Add explicit cross-Provider continuation versus new-Thread choice.

**User stories covered:** Durable conversation history; stop without hidden resume; safe Provider switching.

**Acceptance criteria:**

- [x] Completed messages and terminal tool events append and flush to `trajectory.jsonl`.
- [x] Streaming partial content is atomically checkpointed without storing hidden reasoning, credentials, or raw authorization payloads.
- [x] Stop or crash produces one visible Interrupted Turn and never automatically resumes, replays tools, or submits queued text.
- [x] Restarting for inspection does not start Pi; continuing rebuilds the Physical Model Context lazily.
- [x] Stable event ids and high-water marks prevent duplicate terminal content after checkpoint recovery.
- [x] Persisted execution, tool, and artifact events carry a versioned actor/provenance reference that represents the primary Agent now and can represent a later Sub-Agent without reinterpreting old events.
- [x] A cross-Provider selection requires `Continue Current Thread` or `Start New Thread` and records the choice and retained-context disclosure.

### F4. Execute One Authorized Host Capability

**Blocked by:** F2.

**What to build:** Implement a typed Capability Registry and Host Capability Gateway, Standard Access and Full Access, visible capability execution events, Output Intent, and one narrow Unscoped text-output adapter that writes through the shared staging, Output Store, and Artifact Registry path to a User-selected Output Location.

**User stories covered:** Observable Agent actions; two access modes; explicit document creation rather than automatic conversation export.

**Acceptance criteria:**

- [x] A model tool invocation crosses versioned IPC with Thread, Turn, capability, scope, arguments, correlation id, and expected state version.
- [x] Capability metadata declares activation class, input/output schema, side-effect class, scope requirements, and executor identity; adding a later capability does not require a new Pi-to-Host IPC method or Renderer branch.
- [x] The Host rejects inactive, unauthorized, stale, or out-of-scope requests before side effects.
- [x] Ordinary conversation creates no file without Output Intent.
- [x] An explicit save request prompts for an Unscoped Output Location when absent and atomically creates a visible file there.
- [x] Standard Access confirms sensitive out-of-scope or replacement actions; Full Access suppresses tool-level prompts but keeps events and provenance visible.
- [x] Unknown completion after a dispatched non-stageable write becomes Unknown Tool Outcome and is not automatically retried.
- [x] The first text Output records a format-neutral media type, producer, destination, and source/provenance relation rather than defining Markdown as the Output domain model.

### F5. Open A Stable Project And Run A Project Thread

**Blocked by:** F3 and F4.

**What to build:** Register a local folder as a Project, create the minimal Project Identity marker, create Project Threads, preserve conversation isolation, establish Project Provider Authorization through explicit Profile use, and handle moved folders and copied-identity collisions.

**User stories covered:** Project-scoped work; folder move continuity; no accidental cross-Project context.

**Acceptance criteria:**

- [x] Opening a folder creates only `outputs/system/project.json` with a random identity and no path or business content.
- [x] Project registration and Thread browsing remain Host-only until work is submitted.
- [x] A Project Thread can run through the same Pi path while an Unscoped Thread cannot access Project State.
- [x] Selecting an external Profile for the Project records Project Provider Authorization without eagerly reading or uploading files.
- [x] Reopening a moved folder reconnects its Threads and metadata through Project Identity.
- [x] Detecting the same identity at two paths blocks registration until the User chooses `Moved Project` or `Project Copy`.
- [x] Two Threads in one Project retain independent conversation and Physical Model Context.

## Dogfood Slices

### D1. Load And Revise The Minimal VC System Prompt

**Blocked by:** F2.

**What to build:** Ship the six-responsibility Minimal VC System Prompt, include its active revision in every ordinary Provider call, add direct editing, diff/history, activation, restore-default, Prompt Load Boundary behavior, and prompt contribution telemetry.

**User stories covered:** VC-specific judgment behavior without a large harness; prompt-first product learning.

**Acceptance criteria:**

- [x] Every ordinary Turn includes the active Minimal VC System Prompt revision and no Project-specific content by default.
- [x] The default prompt contains only the six accepted responsibility classes.
- [x] Saving creates a revision with hash, timestamp, optional note, and reviewable diff.
- [x] Active physical contexts do not hot-reload an edited prompt mid-context.
- [x] Application restart, new Thread, and compaction/rebuild apply the latest active revision at the defined boundary.
- [x] Turn provenance records prompt revision and estimated or observed prompt/tool/context contributions.

### D2. Inventory Materials And Detect External Changes

**Blocked by:** F5.

**What to build:** Add a deterministic Material Inventory for supported files, stable source hashes, external-change detection, stale parse status, and the explicit Parse Refresh Choice UI. Do not parse file bodies during Project opening.

**User stories covered:** Work over changing deal folders without eager context loading or stale silent reuse.

**Acceptance criteria:**

- [x] Opening a Project inventories metadata without parsing or sending file bodies.
- [x] Stable external changes update inventory metadata but do not alter an Active Turn.
- [x] A changed previously parsed Material becomes visibly stale when next needed.
- [x] The User chooses `Create New Parse Version`, `Replace Previous Parse`, or cancel under both Access Modes.
- [x] Failed replacement preserves the prior parse and historical references.
- [x] Generated Outputs and reserved system/cache paths are excluded from ordinary Material discovery as specified.

### D3. Produce Reusable Canonical Parses

**Blocked by:** D2.

**What to build:** Implement the bounded Utility Job Runner, Material Pipeline, and Parser Adapter registry with baseline adapters for text, Markdown, PDF native text, DOCX, PPTX, XLSX/CSV, and common structured text formats. Persist source-referenced Canonical Parse artifacts and visible warnings. The pipeline can represent a page-recovery request for later OCR; when no recovery adapter is registered, it reports recovery unavailable rather than providing a placeholder OCR implementation or simulating success.

**User stories covered:** Analyze common VC materials without loading Office Skills or OCR.

**Acceptance criteria:**

- [ ] Parsing starts only from explicit Host action or task need and runs without Pi when invoked locally.
- [ ] Each parse records source hash, parser identity/version, blocks, stable source references, warnings, and provenance.
- [ ] Canonical Parse blocks, tables, page references, warnings, and parser provenance are independent of a concrete parser package and do not contain PyMuPDF-, Office-, or OCR-specific runtime objects.
- [ ] Identical source and parser identities reuse the current parse.
- [ ] Native PDF extraction reports image-only or unreliable pages as requiring unavailable OCR rather than inventing text.
- [ ] A native parser can request bounded page recovery through the Material Pipeline without knowing which future OCR adapter will satisfy it.
- [ ] Parser crashes and malformed files are contained to the Utility Worker and do not corrupt Host or Agent Worker state.
- [ ] Parsed artifacts are written under the reserved Project output structure and remain distinguishable from User Outputs.

### D4. Recall Materials Within A Bounded Model Context

**Blocked by:** D1 and D3.

**What to build:** Add `capability_request` and `material_recall`, deterministic preactivation, Progressive Material Disclosure, Context References, Turn-scoped Retrieval Payload retirement, Context Budget Management, and visible automatic/manual Thread Compaction.

**User stories covered:** Token-efficient analysis of large folders; explicit current-file reading without silent truncation.

**Acceptance criteria:**

- [ ] Project and Unscoped core tool surfaces match the accepted scope; Unscoped recall sees only direct attachments.
- [ ] The primary Agent can activate an allowed material capability during the same Turn without a classifier model call.
- [ ] Material retrieval uses a typed scoped recall-source interface and the common bounded-result envelope; later Memory or MCP recall sources do not require changes to Pi session orchestration.
- [ ] Retrieval starts with cards/outlines and expands only selected blocks with stable source references.
- [ ] Large retrieval bodies remain full only in the originating Turn and become Context References later.
- [ ] Budget pressure retires old payloads, compacts prior conversation, and preserves explicit current input before reducing optional recall.
- [ ] Oversized current materials are processed progressively; the Agent never claims to have read omitted content.
- [ ] Compaction is visible, uses the effective current Profile, and never writes into Context or Memory.

### D5. Perform Read-only Public Web Research

**Blocked by:** F4 and D1.

**What to build:** Add Task-activated search, public URL fetch, public page/PDF extraction, bounded results, inline source display, and transient real-time behavior without webpage snapshots.

**User stories covered:** Current industry research with visible sources and low default tool-schema cost.

**Acceptance criteria:**

- [ ] Clear research intent preactivates web tools; otherwise the Agent requests them through `capability_request`.
- [ ] Web tools register through the same Capability Registry and bounded-result envelope as local capabilities; no web-specific dispatch path is added to the Agent Worker.
- [ ] Public read-only actions run without per-call confirmation and remain visible inline.
- [ ] Logged-in access, form submission, write APIs, browser automation, and local-file upload are unavailable in this slice.
- [ ] Results include URL, title when available, access time, bounded content, and failure warnings.
- [ ] No durable HTML/body snapshot or web evidence cache is created.
- [ ] Large web results follow Turn-scoped Retrieval Payload retirement and Context Reference rules.

### D6. Recall And Maintain Project Context

**Blocked by:** F5, D1, and D4.

**What to build:** Create the fixed Project Context Markdown template and structured mirror, right-panel editor, deterministic mirror rebuild, explicit context update flow, and bounded `project_state_recall` without default new-Thread injection.

**User stories covered:** Shared project facts across Threads without copying the whole project state into each conversation.

**Acceptance criteria:**

- [ ] Context files are created lazily and remain user-editable and transparent.
- [ ] New Threads receive no Project Context body by default.
- [ ] `project_state_recall` returns only relevant sections with visible provenance.
- [ ] External manual edits rebuild the structured mirror deterministically without a model call.
- [ ] Malformed sections produce visible warnings without overwriting user text.
- [ ] Unscoped Threads cannot invoke Project Context recall.

### D7. Capture And Recall Project Memory

**Blocked by:** D1, D4, and D6.

**What to build:** Add the Project Memory editor, inline candidate capture from explicit/strong User signals without an auxiliary classifier call, draft-confirm append, source metadata, and bounded `memory_recall` for judgment-heavy or explicit recall. Register Project Memory as one explicitly project-scoped recall source rather than making it the storage model for future Long-term Memory.

**User stories covered:** Preserve project-level judgments while keeping model output and source facts separate from confirmed User memory.

**Acceptance criteria:**

- [ ] No Project Memory is injected in full by default.
- [ ] Explicit or strong User signals may create a visible candidate without a separate model request.
- [ ] Only User confirmation appends candidate content to Project Memory.
- [ ] Manual edits are authoritative and rebuild derived recall indexes without a model call.
- [ ] Recall labels Memory as user-confirmed judgment rather than source evidence and shows the activity inline.
- [ ] Recall results carry source scope and maturity metadata so a later Long-term Memory source can join ranking without changing existing Project Memory records or their authority.
- [ ] Unapproved model statements, Outputs, and source summaries do not become Project Memory automatically.
- [ ] Unscoped Threads cannot read or write Project Memory.

### D8. Produce A Source-referenced Project Output

**Blocked by:** D3, D4, D5, and D6.

**What to build:** Extend Output Intent and the format-neutral Output Store to Project Threads, use a Markdown output adapter to generate the first VC Deliverable from parsed material and optional web research, record artifact provenance, and expose it in the Outputs panel. Markdown is the first concrete adapter, not the Output domain model. No draft/final classification is introduced.

**User stories covered:** Produce an industry note, project judgment, or investment memo from the same conversation-first workflow.

**Acceptance criteria:**

- [ ] An explicit User request creates a task-appropriate file under the determined Project Output Location.
- [ ] The document distinguishes sourced facts, inference, uncertainty, and material User/model disagreement where relevant without imposing evidence maximalism.
- [ ] Material claims use stable parse references and web claims use visible URLs where available.
- [ ] The artifact registry records source-output relationships, Thread/Turn, Profile, Provider, tool, timestamp, and warnings.
- [ ] Output metadata supports media type, producing capability/Skill, optional render or diff artifacts, and arbitrary file extensions without schema changes; the UI opens Markdown now and shows a generic file action for unknown future formats.
- [ ] Supporting files remain under the Output Location and are visible to the User.
- [ ] Ordinary analytical conversation still creates no Output without Output Intent.

## Dogfood Exit Slice

### G1. Pass The Daily VC Workflow Gate

**Blocked by:** F1-F5 and D1-D8.

**What to build:** Stabilize one end-to-end Project workflow and its failure paths: open a real fixture Project, inspect inventory, parse selected materials, conduct public research, discuss an investment judgment using bounded Context and Memory, generate a source-referenced Output, restart the application, and continue the Thread without hidden work.

**User stories covered:** The complete Dogfood Build loop available to the sole User.

**Acceptance criteria:**

- [ ] One Playwright E2E scenario completes the entire workflow through visible UI actions.
- [ ] A second scenario covers missing Profile, Provider Failure, parse warning, stopped Turn, and restart recovery without data corruption or automatic fallback.
- [ ] The application starts and browses local state without Pi activation.
- [ ] Telemetry exposes prompt, tool-schema, recall, retained-context, output reserve, latency, and token contributions without remote content telemetry.
- [ ] The environment doctor reports Pi, Provider, parser, credential-reference, storage, and bundled-Extension status with sanitized diagnostics.
- [ ] Architecture tests exercise fixture adapters through the ResourceLoader, Capability Registry, Parser Adapter, Output Store, and Worker Supervisor interfaces without importing later-stage feature code.
- [ ] No Learning, Integration, Extension Audit, Office, OCR, MCP, Dream, Reflection, Long-term Memory, or Sub-Agent control appears as a working feature.
- [ ] The sole User can use the build for ordinary VC work without developer intervention.

## Dependency Graph

```text
F1 -> F2 -> F3 -----> F5 -> D2 -> D3 -> D4 ----+
       |     |         |             |          |
       |     +-> F4 ---+             +-> D6 -> D7
       |          |                  |          |
       +-> D1 ----+------------------+----------+-> D8 -> G1
                  +-> D5 -----------------------+
```

## Stage Gates

**Foundation complete:** F1-F5 pass on a clean machine configuration. A User can open the empty app, configure a Profile, run and recover Unscoped and Project Threads, and create one authorized file through the Host boundary.

**Dogfood complete:** D1-D8 and G1 pass. A User can complete the daily VC workflow over local materials and public web sources with bounded context, visible provenance, Project Context, Project Memory, and a durable Output.

## Issue Publication

This repository does not currently define an issue tracker. After the slice granularity and dependencies are approved, either:

1. configure a local Markdown issue tracker under `.scratch/`, or
2. initialize a real Git repository and publish the slices to its GitHub/GitLab tracker.

Until then, this document is the dependency-ordered implementation backlog.
