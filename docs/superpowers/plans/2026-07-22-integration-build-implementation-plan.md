# Integration Build Implementation Plan

Date: 2026-07-22

Source: `docs/superpowers/specs/2026-07-06-vc-desktop-agent-design.md`

Blocked by: completed Learning Build through commit `1dae091`.

## Objective

Turn the completed daily-work and personal-learning loops into a practical Personal Build by adding the shared execution foundation, isolated Skills, direct use of User-supplied Claude Code Office Skills, local page recovery, controlled MCP access, and reviewed Pi Extension admission without weakening the existing Host, Project, Provider Authorization, Output Intent, or Cognitive Review boundaries.

Executable specifications for every remaining Slice are indexed at `docs/superpowers/specs/2026-07-22-integration-slice-spec-index.md`.

This plan covers the Integration Build plus the minimum Runtime Foundation required by its local executable and concurrent workloads. Explicit Sub-Agent Runs remain out of scope and receive a separate Delegation and Hardening plan after this gate.

## Confirmed Product Direction

- The Personal Build directly uses complete User-supplied Claude Code `docx`, `pptx`, `xlsx`, and `pdf` Skill packages. vc-agent does not build a parallel Office engine or fork those packages into product-owned implementations.
- Office Skill packages are explicitly imported as complete copies into the isolated VC Agent Skills Directory. vc-agent never reads Claude Code's live Skill root at runtime.
- The imported packages are not committed to this repository, bundled by an installer, redistributed, or represented as vc-agent-owned code.
- Host-owned compatibility overlays are preferred over editing imported packages. Any unavoidable local package change remains visible as a recorded diff.
- Office creation and editing always produce an edited copy and change summary first. Original Source replacement remains a separate action governed by Access Mode.
- The Runtime Foundation is implemented before integrations because Office, OCR, MCP workflow stages, Extension Audit, and later Sub-Agent Runs must share one bounded installation-wide scheduler.
- Project model work uses at most one Agent Worker per Project, with independent lazy Pi sessions per Project Thread. Each model-backed Unscoped Thread retains its own isolated Worker.
- The fixed local recovery chain is PyMuPDF native extraction, then ordinary PaddleOCR, then OvisOCR2 only for pages that remain missing, unreliable, or structurally insufficient.
- MCP is exposed only through the bundled pinned `pi-mcp-adapter`; there is no second built-in MCP client or direct Provider bypass.
- Arbitrary Pi Extensions remain unavailable until deterministic inspection, isolated model review, explicit User approval, separate enablement, and a global idle activation boundary all succeed.

Governing decisions: ADR 0027, 0028, 0034, 0036-0039, 0043, 0057-0059.

## Planning Rules

- Build vertical slices with a visible desktop path, durable operational state, explicit unavailable behavior, restart behavior, and tests.
- Preserve the existing dependency direction. Local executable dependencies run through the Utility Worker or an Isolated Job boundary, never inside the Renderer, Electron Main, or Agent Worker.
- Keep one generic Host capability gateway. Office, OCR, Skills, and MCP do not receive ad hoc Renderer-to-runtime channels.
- Do not load Skill instructions, MCP schemas, OCR payloads, or Extension tools into every Turn. Activate only what the current task requires.
- Do not start Pi for directory inspection, dependency checks, Skill import, OCR, Extension deterministic inspection, queue browsing, or settings navigation.
- Provider Failure never causes automatic retry, Profile fallback, Provider switching, stage skipping, Extension approval, or durable writes.
- Standard Access confirms sensitive out-of-scope access and original replacement. Full Access suppresses eligible tool-level prompts but preserves Output Intent, Cognitive Review Gates, Extension admission, and visible provenance.
- Preserve best usable earlier-stage results when a later parser, OCR, Office, MCP, or Extension action fails.
- Treat the accepted design specification and ADRs as behavioral authority. This plan orders implementation and does not broaden product scope.

## Current Foundation To Reuse

| Existing path | Integration Build use |
| --- | --- |
| Capability Registry and Host Gateway | Task-activated Skills, MCP proxy operations, staged Office writes, and protected integration actions |
| Runtime Resource Snapshot | Bounded Skill instructions and approved Extension inventory at Prompt Load Boundaries |
| Utility Worker and Canonical Parse | Python Job Manifest execution, PDF native extraction, page recovery, staged parser results |
| Project Output Registry | Office copies, render previews, diffs, source relationships, and producing Skill provenance |
| Material Inventory and Parse Refresh | OCR escalation and external edit invalidation without eager parsing |
| Model Profiles and Task Assignments | Document generation, visual material analysis, Extension Audit, and explicit launch overrides |
| Thread Trajectory and checkpoints | Queue admission, interruption, visible integration activity, and Unknown Tool Outcome handling |
| Project Identity and Provider Authorization | Project Worker ownership, source access, MCP/Office scope, and moved-folder continuity |
| Environment Doctor | Skills, Python packages, OCR models, Office dependencies, MCP adapter, and Extension status |
| State Migration boundary | Durable queue, Skill inventory, MCP configuration, and Extension revision schemas |

## Runtime And Storage Boundaries

Default app-level integration locations:

```text
<app-data>/skills/
  active/
  imports/
  overlays/
  inventory.json

<app-data>/integrations/
  mcp/
  extensions/
    staged/
    approved/
    revisions/

<app-data>/jobs/
  staged/
  results/
  logs/
```

Rules:

- Imported Skills and approved Extensions are transparent local directories. SQLite stores only ids, paths, hashes, status, permissions, revisions, and operational coordination state.
- Protected Credentials remain OS-protected references. They never enter Skill directories, Extension packages, Job Manifests, logs, backups, or Provider-visible tool results.
- Job inputs and results are bounded, versioned, scoped to one request, and removed according to the existing retrieval and temporary-payload policy after durable outputs or parse artifacts are committed.
- Skills cannot write Project Memory, Long-term Memory, Reflection state, or Dream state. Cognitive changes continue through their existing Host-owned review paths.
- An approved Extension is trusted Worker code only for its declared direct process behavior. Host-proxied durable state and permission-changing operations remain validated by the Host.

## Runtime Foundation Slices

### R0. Add The Bounded Execution Scheduler And Visible Queue

**Blocked by:** Learning Build complete.

**What to build:** Add one Host-owned installation-wide scheduler for ordinary Turns and model-running workflow stages. Persist queue entries and leases, admit work by bounded capacity, and add visible editable Queued Follow-ups for a Thread that already has an Active Turn.

**Why first:** Office, OCR, Extension Audit, MCP-backed work, and later Sub-Agent Tasks need one capacity and interruption model rather than independent background runners.

**Acceptance criteria:**

- [x] One Thread has at most one Active Turn; different Threads may run concurrently only under the installation-wide limit.
- [x] Ordinary Turns, Reflection stages, Dream stages, Extension Audit, and later registered internal model stages consume the same bounded capacity.
- [x] A message submitted to an Active Thread becomes a visible Queued Follow-up and never steers the running Turn.
- [x] The User can edit, reorder within the same Thread, or cancel queued drafts before admission.
- [x] A globally capacity-blocked task shows its queue reason, scope, requested Profile, and submission time.
- [x] Stop interrupts only the selected Active Turn and never automatically submits its Queued Follow-up.
- [x] App restart preserves queued content as unsent drafts, clears stale leases deterministically, and starts no Worker or Provider request.
- [x] Missing Profile, incompatible Profile, or Provider Failure does not consume capacity indefinitely or trigger fallback.
- [x] Queue state and leases migrate atomically and enter Read-only Recovery behavior with unsupported newer schemas.
- [x] Telemetry exposes queue delay, running duration, capacity use, and sanitized failure counts without remote content telemetry.

### R1. Correct Project Worker Ownership And Shared Runtime Contention

**Blocked by:** R0.

**What to build:** Change Agent Worker supervision from one Worker per Thread to one Worker per Project plus one isolated Worker per model-backed Unscoped Thread. Host multiple independent lazy Thread sessions inside a Project Worker and add bounded local-job admission shared with the scheduler.

**Acceptance criteria:**

- [ ] A Project with no submitted model-backed work starts no Agent Worker.
- [ ] The first admitted Project task starts exactly one Worker keyed by Project Identity rather than path or Thread id.
- [ ] Multiple Project Threads use independent Pi sessions and may execute concurrently within the global limit without sharing model context.
- [ ] Each model-backed Unscoped Thread uses a separate Worker with no Project State path, capability, attachment, or credential authorization.
- [ ] Moving a Project folder preserves Worker ownership through Project Identity after restart; an identity collision remains blocked pending explicit classification.
- [ ] Closing the app interrupts active work, flushes checkpoints, terminates Agent Workers and Isolated Jobs, and performs no automatic replay.
- [ ] Utility and Isolated Job crashes preserve the Host, Agent Worker, prior parse, prior Output, and best earlier-stage result.
- [ ] Process-tree cancellation is bounded and verified for Python, OCR, rendering, and Skill-declared executable jobs.
- [ ] Same-target concurrent writes use staged validation and the existing Access Mode collision policy rather than implicit model merging.
- [ ] Worker integration tests cover two concurrent Threads in one Project, concurrent Projects, Unscoped isolation, capacity admission, stop, crash, and restart.

## Integration Slices

### I1. Establish The Isolated VC Agent Skills Directory

**Blocked by:** R1.

**What to build:** Create the app-level Skills Directory, deterministic package inventory, explicit complete-directory import, compatibility diagnostics, Host-owned overlays, activation metadata, and task-activated Skill resource projection.

**Acceptance criteria:**

- [ ] Opening Settings creates no Skills Directory until the User opens or configures the Skills view.
- [ ] The default directory is app-owned and isolated from Claude Code, Codex, Pi, project-local, and global Agent Skill roots.
- [ ] Import copies one complete selected package, including `SKILL.md`, referenced scripts, resources, metadata, and license files, into a staged location before validation.
- [ ] vc-agent never follows live external Skill-root references after import and never silently updates an imported package.
- [ ] Inventory records package id, source kind, import time, content hash, compatibility status, declared dependencies, overlay revision, and enabled state.
- [ ] Missing referenced files, unsupported directives, escaping paths, undeclared executable dependencies, and malformed metadata block activation with visible diagnostics.
- [ ] Compatibility changes live in a Host-owned overlay where practical; direct package edits require a visible package diff and explicit approval.
- [ ] Skill instructions and tool schemas enter only task-relevant Runtime Resource Snapshots and do not enlarge unrelated ordinary Turns.
- [ ] Skills cannot access cognitive-state write tools or bypass Output Intent, Project scope, Provider Authorization, Access Mode, or capability validation.
- [ ] Backup includes the active Skills Directory and overlay metadata but excludes external source paths, secrets, caches, and job payloads.

### I2. Invoke User-Supplied Claude Code Office Skills Directly

**Blocked by:** I1.

**What to build:** Import and invoke the User-supplied Claude Code `docx`, `pptx`, `xlsx`, and `pdf` Skill packages through the Skills boundary. Add controlled file/script capabilities, dependency diagnostics, staged output validation, edited-copy workflow, render/preview artifacts where the supplied Skill supports them, and change summaries.

**Acceptance criteria:**

- [ ] vc-agent uses the imported complete Claude Code Office Skills directly and does not implement a parallel Office document engine.
- [ ] The repository and installer contain no copied third-party Office Skill package, model weight, or undeclared binary dependency.
- [ ] Environment Doctor reports each imported Office Skill, package integrity, required runtime or binary dependencies, optional Microsoft Office dependency, and actionable unavailable reasons.
- [ ] A document-generation task activates only the relevant Office Skill and minimum controlled capabilities.
- [ ] Creation writes a new `.docx`, `.pptx`, `.xlsx`, or `.pdf` under the determined Output Location with producing Skill, Thread, Turn, Profile, source references, and warnings.
- [ ] Editing an existing Project Material first writes an edited copy plus a reviewable change summary/diff; it never silently replaces the source.
- [ ] Original Source replacement requires a second confirmation under Standard Access and remains a visible explicit action under Full Access.
- [ ] Missing dependencies, Skill failure, render failure, or Office COM absence preserves the source and any validated staged copy; no LibreOffice fallback is attempted.
- [ ] Skill scripts run as bounded Isolated Jobs with declared inputs, outputs, timeout, cancellation, sanitized logs, and no inherited Project-wide filesystem access.
- [ ] Unknown completion after a dispatched replacement becomes Unknown Tool Outcome and requires target inspection or explicit duplicate-risk acknowledgment.
- [ ] E2E fixtures exercise at least one generated document, one edited copy, diff review, denied replacement, approved replacement, unavailable dependency, and restart inspection.

### I3. Reuse Skill Creator As An Explicit Meta-Skill

**Blocked by:** I1 and I2 compatibility lessons.

**What to build:** Import one complete compatible Claude Code or Codex Skill Creator package, adapt it through the same overlay mechanism, and expose explicit create/update workflows with destination, dependency, content, and diff review.

**Acceptance criteria:**

- [ ] Skill Creator starts only from explicit User intent and never from ordinary successful conversation.
- [ ] It creates or updates only a staged package inside the VC Agent Skills Directory.
- [ ] The reused package retains its referenced scripts, resources, metadata, and license; missing components block activation.
- [ ] Standard Access requires destination, generated package, dependency declaration, and diff review before write; Full Access preserves the visible review record.
- [ ] Generated or updated Skills pass the same compatibility, path, executable dependency, and activation checks as imported Skills.
- [ ] Skill Creator has no cognitive-state write capability, Extension approval capability, Protected Credential access, or automatic enablement right.
- [ ] Failure leaves the prior active Skill version unchanged and preserves a reviewable draft when safe.

### I4. Add Local PaddleOCR And OvisOCR2 Page Recovery

**Blocked by:** R1 and the existing Canonical Parse boundary. May proceed in parallel with I1-I3 after R1.

**What to build:** Extend the Utility/Isolated Job parser registry with fixed page-level recovery: retain usable PyMuPDF output, invoke ordinary PaddleOCR for missing or unreliable text, and invoke OvisOCR2 only when ordinary OCR remains missing, unreliable, or structurally insufficient.

**Acceptance criteria:**

- [ ] Native PyMuPDF extraction remains first and usable native blocks are never discarded because a later recovery stage runs.
- [ ] PaddleOCR receives only bounded rendered pages selected by deterministic quality rules and runs locally without Pi or a Model Profile.
- [ ] OvisOCR2 receives only pages whose PaddleOCR result is unavailable, unreliable, or structurally insufficient; there is no automatic alternative OCR provider.
- [ ] Every stage records adapter id/version, page references, quality result, duration, warnings, and retained-result decision in parser-independent provenance.
- [ ] The Canonical Parse keeps parser-independent blocks, tables, geometry, images, warnings, and stable source references.
- [ ] A later-stage timeout, cancellation, malformed result, or process crash preserves the best validated earlier-stage content.
- [ ] Diagnostics distinguish native parse warning, OCR unavailable, OCR failed, and complex parse unavailable.
- [ ] External OCR APIs remain disabled unless separately designed and explicitly enabled.
- [ ] Local dependency checks do not import model weights or start inference during app launch, browsing, inventory, or Environment Doctor.
- [ ] Tests cover native text, scanned text, mixed pages, unreliable OCR, table/layout escalation, missing PaddleOCR, missing OvisOCR2, timeout, cancellation, and crash containment.

### I5. Connect MCP Through The Pinned Pi Adapter

**Blocked by:** R1 and the Capability Gateway. May proceed after R1 independently of Office/OCR.

**What to build:** Bundle and pin `pi-mcp-adapter`, add app-level server configuration and status, lazily connect only when a task activates MCP, project server tools through bounded Host capability metadata, and enforce read/write/external-submission boundaries.

**Acceptance criteria:**

- [ ] MCP is available only through the bundled pinned adapter; no direct Renderer, Host, or second built-in MCP client path exists.
- [ ] Settings shows adapter version, configured servers, credential-reference state, connection status, capabilities, and sanitized failures without connecting on view.
- [ ] Ordinary Turns contain no MCP schemas until deterministic preactivation or an accepted Capability Activation Request.
- [ ] Read-only retrieval uses bounded result envelopes, visible server/tool provenance, and Turn-scoped large-payload retirement.
- [ ] Writes, external submissions, sampling, elicitation, local-file upload, and permission expansion cross the Host permission boundary.
- [ ] Standard Access requests required confirmation; Full Access suppresses only eligible tool-level prompts and never broadens server or Project authorization.
- [ ] Server failure, schema change, timeout, or Provider Failure causes no automatic server/client fallback and preserves unrelated work.
- [ ] Unscoped Threads receive no Project file or state access merely because an MCP server is configured.
- [ ] Protected Credentials remain reference-only and are never persisted in configuration exports, logs, trajectories, or tool results.
- [ ] Fixture-server tests cover lazy connection, activation, bounded read, denied write, approved write, disconnect, schema mismatch, and restart without eager connection.

### I6. Implement Extension Admission And Global Revision Control

**Blocked by:** R1, I1 inventory mechanics, and the pinned bundled Extension boundary.

**What to build:** Add staged acquisition from a User-selected local artifact, deterministic full dependency-closure inspection, isolated Extension Audit Workflow, explicit approval records, separate global enablement, immutable approved artifacts, Global Extension Revisions, idle-boundary activation, update, disable, and rollback.

**Acceptance criteria:**

- [ ] A proposed Extension remains outside Pi discovery and execution while staged or under review.
- [ ] Deterministic inspection runs without Pi and records artifact identity, hashes, source revision where available, lockfile/dependency closure, lifecycle scripts, permissions, and integrity gaps.
- [ ] Approval is blocked when immutable artifact identity, integrity evidence, or deterministic dependency resolution is incomplete.
- [ ] Extension Audit runs only after explicit User launch in an isolated context with no Projects, ordinary Threads, Skills, VC prompt, Project Memory, Long-term Memory, Reflection, or Dream state.
- [ ] Audit resolves only the Extension Audit Task Assignment or explicit override; missing Profile and Provider Failure retain deterministic results and require manual action.
- [ ] The report distinguishes deterministic findings, model review, unreviewed transitive surface, requested permissions, and residual risks without claiming complete safety.
- [ ] Only the User can approve; the Agent, audit model, Full Access, update flow, and Extension code cannot self-approve.
- [ ] Approval and Global Extension Enablement are separate explicit actions; newly approved Extensions remain disabled.
- [ ] Runtime loading requires exact matches for approved bytes, dependency lock, source revision, permission declaration, and retained artifact identity.
- [ ] Enable, disable, update, and rollback create one pending Global Extension Revision and activate atomically only at a global idle boundary.
- [ ] Immediate activation explicitly interrupts and checkpoints affected work, then terminates old Workers; it never resumes or replays automatically.
- [ ] Rollback is allowed only to a retained artifact whose current bytes still match its approval identity.
- [ ] Extension changes apply consistently to Project and Unscoped Workers, with no per-Project override in this build.
- [ ] Direct Extension process behavior is disclosed as Trusted Worker Code; Host-proxied durable state and permission-changing actions remain validated.
- [ ] Extension Audit artifacts, inputs, and trajectory remain excluded from Memory capture, Dream, ordinary recall, Personal Cognition Backup, and Project Outputs unless the User explicitly exports a report.

## Integration Exit Slice

### G3. Pass The Practical Integration Workflow Gate

**Blocked by:** R0-R1 and I1-I6.

**What to build:** Stabilize the shared scheduler and one real visible path for imported Office Skills, OCR recovery, Skill Creator, MCP, and approved Extension lifecycle without requiring every optional dependency to be installed.

**Acceptance criteria:**

- [ ] One Playwright scenario queues work across multiple Threads, keeps model contexts independent, stops one Turn, edits/cancels a Queued Follow-up, and resumes inspection after restart without automatic submission.
- [ ] A Project-worker scenario proves two Project Threads share one Project Worker but retain independent Pi sessions; Unscoped work remains process- and scope-isolated.
- [ ] One fixture Claude Code Office Skill is imported as a complete package, activated for a document task, creates an edited copy and diff, and passes explicit original-replacement policy.
- [ ] One OCR E2E routes native, scanned, and complex pages through PyMuPDF, PaddleOCR, and OvisOCR2 fixtures while retaining best earlier results on later-stage failure.
- [ ] One fixture MCP server proves lazy activation, bounded read, protected write, visible provenance, and restart without eager connection.
- [ ] One fixture Extension completes deterministic inspection, isolated audit, approval, separate enablement, idle activation, update invalidation, and retained-artifact rollback.
- [ ] One Skill Creator fixture creates a staged Skill that passes compatibility review without automatic activation.
- [ ] Missing Office dependencies, missing OCR runtimes, MCP failure, Extension audit Provider Failure, job timeout, worker crash, stale output target, and app restart produce visible recoverable states without fallback or corrupting prior results.
- [ ] Environment Doctor reports Pi, Profiles, credentials, storage, migrations, Skills, Office dependencies, OCR chain, MCP adapter/servers, and Extension revisions with sanitized diagnostics.
- [ ] Architecture tests enforce Renderer isolation, Pi-only adapter ownership, Job Manifest boundaries, task-activated resources, cognitive-state exclusion, and the absence of Sub-Agent runtime code.
- [ ] The sole User can import supplied Claude Code Office Skills and complete normal document work without developer intervention when their declared dependencies are available.

## Dependency Graph

```text
Learning G2 -> R0 -> R1 -----+-> I1 -> I2 -> I3 --+
                             |                     |
                             +-> I4 ---------------+-> G3
                             |                     |
                             +-> I5 ---------------+
                             |                     |
                             +-> I1 -> I6 ---------+
```

I4 and I5 may proceed in parallel with the Skills path after R1. I6 reuses I1 inventory and integrity mechanics but does not treat a Skill compatibility result as Extension approval.

## Stage Gate

**Integration Build complete:** R0-R1, I1-I6, and G3 pass. The User can run bounded concurrent work, directly use supplied Claude Code Office Skills from the isolated VC Agent Skills Directory, recover scanned and complex pages locally, activate MCP tools on demand, explicitly create personal Skills, and admit or roll back reviewed Extensions through visible Host-controlled paths.

The following remain unavailable until the Delegation and Hardening Build: explicit Sub-Agent Runs, child task trees, child Profile resolution, shared child Token Budgets, child Capability Sets, bounded child handoff, parent-stop propagation, and Sub-Agent trajectory retention. Their later implementation must reuse the scheduler, Project Worker ownership, capability gateway, Runtime Resource Snapshot, and interruption semantics established here.
