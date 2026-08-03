# Capability Reuse And Host Simplification Executable Specification

Date: 2026-08-03
Status: Proposed for review
Scope: Runtime capability assembly, Pi built-in tools, approved Extensions, MCP tools, Skills, Web access, and duplicate Host implementations
Supersedes: None; refines ADR 0034, I5, I6, and the Optimization and Simplification Specification without weakening their trust boundaries

## Outcome

VC Desktop uses Host code for product policy, authoritative state, scope, confirmation, provenance, and durable commit while reusing Pi, approved Extensions, MCP adapters, Skills, and Utility Workers for execution behavior that the Host does not need to own.

The completed system has one runtime capability assembly seam. For each Turn it combines:

- Host domain capabilities;
- reviewed bundled or approved Extension tools;
- explicitly activated MCP tools;
- scoped Pi built-in tools; and
- task-selected Skills.

The Host no longer maintains a second production Web search/fetch implementation, approved Extensions can actually enter a Worker from the effective Global Extension Revision, MCP tools can be called by the Agent after activation, and Skill instructions are progressively disclosed instead of being injected twice.

The target is capability reuse, not indiscriminate enablement. Raw shell and direct file mutation remain unavailable in ordinary Turns unless a later accepted specification defines an equally strong scope, confirmation, and provenance model.

## Current Baseline And Confirmed Gaps

The implementation starts from these verified facts:

| Area | Current behavior | Gap |
| --- | --- | --- |
| Pi session | `noTools: "builtin"`; active tools reset and selected by Host capability ids | Pi tools are mostly unavailable; tool assembly is name-coupled to Host inventory |
| Project reads | Pi `read`, `ls`, `find`, and `grep` definitions are wrapped with Project realpath checks | Good reuse pattern; retain and generalize |
| Web | `pi-web-access@0.17.0` supplies `web_search`, `web_fetch`, and `web_fetch_content` | Host still constructs a separate PublicWeb/Bing implementation |
| Source verification | `pi-web-access` registers `source_check` | No Host capability metadata can activate it |
| Web interaction | Curator, summary workflows, commands, shortcuts, and Google-account support exist in the Extension | App-owned config forces raw workflow and Desktop exposes no command/curator integration |
| User Extensions | Host supports stage, inspect, audit, approve, enable, revision, and rollback | Worker loader rejects every non-empty effective Extension snapshot and only hard-codes `pi-web-access` |
| MCP | Pinned `pi-mcp-adapter` is used behind `McpIntegrationManager` | Activated schemas never become ordinary Pi session tools |
| Skills | Host inventory, trust, task selection, Office execution, and Pi Skill registration exist | Selected Skill bodies are also appended to the system prompt, defeating progressive disclosure |
| Pi write/shell | `bash`, `edit`, and `write` are disabled | Correct ordinary-Turn default; isolated jobs need an explicit reusable execution design |
| Academic research | Host owns OpenAlex, arXiv, GitHub, Hugging Face, normalization, and content access | Generic GitHub/Web fetch overlaps with reusable Web/MCP implementations |

Before deletion, characterization tests MUST prove each baseline behavior and identify the current production caller. Dead-code conclusions MUST be supported by the deletion test: if removal makes no complexity reappear in authorized callers, the module was not earning its interface.

## Product Thesis And Ownership Rule

The governing ownership rule is:

> Host owns whether an action is allowed, its scope, authoritative state transition, confirmation, provenance, and final commit. Reusable runtimes own how an admitted action is performed.

| Concern | Authoritative owner |
| --- | --- |
| User intent, Access Mode, action classification, confirmation | Host |
| Project/Unscoped scope and path authority | Host |
| Project, Thread, Material, Reflection, Dream, Memory state | Host |
| Output registry, original replacement, durable commit | Host |
| Credential references and disclosure policy | Host |
| Extension staging, identity, audit, approval, revision | Host |
| Per-Turn visible capability surface | Host policy assembled through one runtime module |
| Web search, page extraction, source-check implementation | `pi-web-access` |
| MCP protocol and transport | pinned `pi-mcp-adapter` |
| Local read/list/find/grep implementation | Pi built-in definitions behind Host scope checks |
| Office and specialist task procedure | approved Skill plus isolated runner |
| OCR model execution | Utility Worker and pinned local runtimes |
| Provider transport, model stream, physical context, compaction | Pi |

An implementation MAY use a Host adapter at a seam without moving the underlying implementation into the Host. A protected proxy is not considered duplicate implementation when it adds authorization, scope, or commit semantics absent from the reused runtime.

## Non-goals

- No direct activation of all Pi built-in tools in ordinary Turns.
- No raw `bash`, `write`, or `edit` that bypasses Output Intent, Standard Access, Project scope, provenance, or stale-state checks.
- No Pi default discovery of arbitrary Extensions, Skills, prompts, themes, or AGENTS files outside app-generated reviewed snapshots.
- No execution from Extension staging, mutable import sources, disabled revisions, or identity-mismatched approved artifacts.
- No automatic Extension approval, enablement, update, rollback, Provider switch, MCP server switch, or package fallback.
- No removal of Host Project, Memory, Reflection, Dream, trajectory, confirmation, or durable commit semantics.
- No claim that Standard Access can mediate direct process actions performed internally by trusted Extension code.
- No browser-cookie extraction, curator browser launch, or remote curator exposure without a separate explicit User-facing authorization design.
- No replacement of local complex-page OCR with generic Web PDF extraction.
- No success criterion based only on reduced lines of code or fewer modules.

## Governing Decisions

This specification preserves ADR 0034, 0037, 0042, 0048, 0050, 0054, 0055, 0056, and 0057; I1, I2, I3, I4, I5, I6, R1, G3; and `2026-08-01-vc-agent-optimization-and-simplification-spec.md`.

An ADR amendment is required before:

- weakening exact Extension identity, separate approval and enablement, or atomic Global Revision changeover;
- allowing trusted Extension code to commit Host state without validation;
- exposing raw shell or file mutation to ordinary Turns;
- weakening MCP scope, secret handling, write confirmation, or Unknown Tool Outcome behavior;
- allowing Skill discovery outside the isolated Skills Directory; or
- allowing browser cookies or external curator access without explicit disclosure and consent.

## Target Runtime Shape

```text
Host policy and authoritative state
  -> RuntimeCapabilityAssembler
       -> Host domain tool adapters
       -> ApprovedExtensionLoader -> Extension tools
       -> ActivatedMcpToolAdapter -> MCP custom tools
       -> ScopedPiToolAdapter -> read/ls/find/grep
       -> SkillResourceAdapter -> task-selected Skill metadata/resources
  -> Pi AgentSession
       -> active tools for this Turn only
       -> tool events observed by Host
  -> Host validation and durable commit where required
```

Global availability, Turn visibility, and execution authority are separate facts:

1. A package or server is installed/configured.
2. Its exact revision is approved and globally enabled.
3. A tool is eligible for the current scope and task.
4. A tool is visible in the current Turn.
5. A call is authorized to execute.
6. A result is validated and, if applicable, committed.

No earlier fact implies a later one.

## Deep Modules And Interfaces

### `RuntimeCapabilityAssembler`

```ts
interface RuntimeCapabilityAssembler {
  assemble(input: RuntimeCapabilityAssemblyInput): Promise<RuntimeCapabilityAssembly>;
}

interface RuntimeCapabilityAssemblyInput {
  hostSurface: TurnCapabilitySurfaceSnapshot;
  extensionRevision: ExtensionInventorySnapshot;
  mcpActivation?: FrozenMcpActivation;
  projectReadRoot?: string;
  skills: RuntimeSkillSnapshot;
}

interface RuntimeCapabilityAssembly {
  revision: string;
  tools: readonly RuntimeToolDescriptor[];
  initialActiveToolNames: readonly string[];
  skills: readonly RuntimeSkillDescriptor[];
  diagnostics: readonly RuntimeCapabilityDiagnostic[];
}
```

This module owns source-aware name resolution, collision rejection, mapping Host capability ids to provider tool names, Turn activation, and a deterministic assembly revision. It does not execute Host policy, approve Extensions, connect MCP servers, or commit outputs.

### `ApprovedExtensionLoader`

```ts
interface ApprovedExtensionLoader {
  load(snapshot: ExtensionInventorySnapshot): Promise<LoadedExtensionSet>;
  inspect(snapshot: ExtensionInventorySnapshot): Promise<ExtensionLoadPreflight>;
}
```

It loads only app-generated exact entry paths from the effective Global Extension Revision. Bundled and user-approved Extensions use the same loading path after trust and identity validation. The loader preserves Pi's Extension runtime behavior rather than reimplementing registration.

### `ActivatedMcpToolAdapter`

```ts
interface ActivatedMcpToolAdapter {
  definitions(activation: FrozenMcpActivation): readonly ToolDefinition[];
}
```

Definitions expose the frozen selected schemas to Pi. Execution calls the existing Host MCP gateway, which remains authoritative for credential resolution, scope, action class, confirmation, output bounds, provenance, retirement, and Unknown Tool Outcome.

### `SkillResourceAdapter`

```ts
interface SkillResourceAdapter {
  project(decisions: readonly SkillActivationDecision[]): RuntimeSkillSnapshot;
  loadBody(packageId: string, revisionId: string): RuntimeSkillBody;
}
```

Initial context contains bounded metadata and activation guidance. Full instructions and referenced resources are loaded only when the selected Skill is invoked or when a protected workflow explicitly freezes the Skill body as part of its prompt snapshot.

### `ToolObservationSink`

```ts
interface ToolObservationSink {
  started(event: RuntimeToolStarted): void;
  completed(event: RuntimeToolCompleted): void;
  failed(event: RuntimeToolFailed): void;
}
```

Observation records source, tool identity, duration, bounded result metadata, citations, and sanitized failure without becoming an authorization bypass or retaining raw secret/content telemetry. Extension Web results enter CitationRegistry through this seam.

## Runtime Tool Identity And Collision Policy

Every runtime tool descriptor MUST include:

```ts
interface RuntimeToolDescriptor {
  name: string;
  source: "host" | "pi_builtin" | "bundled_extension" | "approved_extension" | "mcp";
  sourceId: string;
  sourceRevision: string;
  capabilityId?: string;
  allowedScopes: readonly ("project" | "unscoped")[];
  activationClass: "bootstrap" | "common_read" | "on_demand" | "preconditioned" | "protected";
  sideEffectClass: CapabilityMetadata["sideEffectClass"];
  hostMediated: boolean;
}
```

Collision rules:

- Two tools with the same provider-facing name MUST NOT be resolved by load order.
- An app-declared replacement MUST identify the replaced source and exact revision range.
- Unplanned collisions block Extension revision preflight or MCP activation before a Turn starts.
- `pi-web-access` is the declared production implementation for `web_search` and `web_fetch`; the Host definitions remain catalog/policy metadata, not competing executable tools.
- Diagnostics show sanitized source ids and revisions without source bodies or credentials.

## Required Behavior

### Capability assembly and Pi tools

| Requirement | Behavior |
| --- | --- |
| REUSE-REQ-001 | Every production Pi session MUST receive tools through one `RuntimeCapabilityAssembler`; callers MUST NOT independently mutate active tools outside the session adapter. |
| REUSE-REQ-002 | Turn visibility MUST remain derived from Host scope, availability, activation class, User intent, and catalog revision. Package installation or global enablement alone MUST NOT expose a schema. |
| REUSE-REQ-003 | Tool identity MUST include source and revision, and collisions MUST fail deterministically before Provider execution. |
| REUSE-REQ-004 | Project `read`, `ls`, `find`, and `grep` MUST continue to reuse Pi definitions and MUST reject paths that resolve outside the authorized Project after symlink/junction resolution. |
| REUSE-REQ-005 | Ordinary Turns MUST NOT activate raw Pi `bash`, `write`, or `edit`. Any isolated use requires an explicit bounded job interface, working directory, command/tool allowlist, output manifest, timeout, cancellation, and Host commit. |
| REUSE-REQ-006 | Unscoped Turns MUST receive no Project read tool and no implicit Project path. |

### Approved Extensions

| Requirement | Behavior |
| --- | --- |
| REUSE-REQ-007 | The Worker MUST load every entry in the effective `ExtensionInventorySnapshot` whose exact approved identity passes I6 validation; a non-empty snapshot MUST NOT be rejected merely because it is non-empty or `approved-trusted`. |
| REUSE-REQ-008 | Bundled and approved Extensions MUST use one loader interface. Bundled status MAY change admission evidence but MUST NOT require a separate hard-coded runtime implementation branch. |
| REUSE-REQ-009 | Loading MUST use exact app-generated entry paths and hashes; Pi/global/project default discovery remains disabled. |
| REUSE-REQ-010 | Extension revision preflight MUST execute no Extension code. Code loads only in a newly created or rebuilt Worker after atomic Global Revision activation. |
| REUSE-REQ-011 | Extension tools MUST remain task-activated. Enabling an Extension installation-wide MUST NOT inject every tool schema into every Turn. |
| REUSE-REQ-012 | Disabling, updating, or rolling back an Extension MUST rebuild affected Physical Contexts through the existing atomic Worker changeover and MUST NOT hot-mutate an active Turn. |
| REUSE-REQ-013 | Direct Extension process authority MUST remain visibly disclosed; observation and Host-proxied calls MUST NOT be represented as a complete sandbox. |

### Web reuse

| Requirement | Behavior |
| --- | --- |
| REUSE-REQ-014 | Production `web_search`, `web_fetch`, and bounded stored-content retrieval MUST be implemented by the pinned `pi-web-access` Extension. The Host MUST NOT issue a competing Bing or other search request. |
| REUSE-REQ-015 | `source_check` MUST be represented as an on-demand Host catalog entry mapped to the Extension tool and activated through the normal capability broker. |
| REUSE-REQ-016 | Web Provider selection, routing, extraction fallbacks, PDF/YouTube handling, and source-check behavior SHOULD remain inside `pi-web-access`; Host configuration MUST pass validated settings rather than reimplement provider logic. |
| REUSE-REQ-017 | Tool names required by the capability catalog MAY be app-pinned, but unrelated valid User settings MUST be preserved. Invalid configuration MUST produce a sanitized diagnostic and safe explicit defaults rather than silently replacing all configuration. |
| REUSE-REQ-018 | Extension Web results MUST populate CitationRegistry or an equivalent source-reference projection through `ToolObservationSink`; citation integration MUST NOT require a second fetch/search implementation. |
| REUSE-REQ-019 | Extension Provider failure MUST surface as the tool failure. The Host MUST NOT silently fall back to its removed PublicWeb implementation, another Provider, or browser-cookie access. |
| REUSE-REQ-020 | Curator, auto-summary, browser launch, and browser-cookie access remain disabled until their UI, consent, timeout, and restart behavior are separately accepted. Raw workflow remains the initial supported Desktop mode. |

### MCP reuse

| Requirement | Behavior |
| --- | --- |
| REUSE-REQ-021 | A frozen admitted MCP activation MUST register its bounded selected tool schemas as Pi custom tools for the owning Turn or Physical Context. |
| REUSE-REQ-022 | Each MCP custom tool execution MUST call `McpIntegrationManager.execute`; Pi, Renderer, Extension code, and the model MUST NOT bypass Host scope, credential, confirmation, result-bound, retirement, or provenance policy. |
| REUSE-REQ-023 | Unrelated Turns MUST contain no MCP schema or server metadata. Activation expiry, disconnect, schema change, or Turn completion removes the tools at the next safe session boundary. |
| REUSE-REQ-024 | MCP tool names MUST participate in the common collision policy. Schema mismatch or collision blocks only the affected activation and causes no automatic alternate server/tool/client selection. |
| REUSE-REQ-025 | Read and protected MCP actions MUST retain I5 behavior, including Standard Access confirmation, Full Access scope limits, sanitized telemetry, and Unknown Tool Outcome. |

### Skills and isolated execution

| Requirement | Behavior |
| --- | --- |
| REUSE-REQ-026 | Host Skill inventory, compatibility, trust, enabled revision, task selection, and isolated-directory policy remain authoritative. |
| REUSE-REQ-027 | A selected ordinary Skill MUST NOT have its complete body both appended to the system prompt and registered for Pi invocation. Initial context uses bounded metadata; full body loads once on invocation. |
| REUSE-REQ-028 | Skill references and assets MUST resolve only below the exact active Skill revision, with traversal and symlink escape rejected. |
| REUSE-REQ-029 | Protected workflows that require a frozen Skill procedure MAY snapshot the complete body, but MUST record the package revision and MUST NOT also expose a mutable copy. |
| REUSE-REQ-030 | Office and Skill Creator execution SHOULD reuse Skill-owned scripts in an isolated job. The Host retains explicit intent, input snapshot, runner/tool allowlist, output validation, preview, source replacement confirmation, provenance, and commit. |
| REUSE-REQ-031 | Missing Skill dependency, runner failure, invalid output, timeout, or cancellation MUST NOT choose another Skill, package revision, Provider, or implementation automatically. |

### Host simplification

| Requirement | Behavior |
| --- | --- |
| REUSE-REQ-032 | The production Host PublicWeb/Bing implementation and its production wiring MUST be removed after Extension-backed fixture and citation tests provide equivalent observable behavior. |
| REUSE-REQ-033 | `project.command` text-search behavior MUST migrate to scoped Pi read tools. Remaining Git/PDF metadata behavior MUST be exposed through smaller allowlisted tools or removed when no authorized caller requires it. |
| REUSE-REQ-034 | Academic Research MUST retain domain normalization, evidence typing, graph semantics, and source-specific identifiers while delegating generic Web/GitHub content retrieval where the reusable implementation satisfies its evidence contract. |
| REUSE-REQ-035 | Host adapters that add authorization, bounded disclosure, staging, stale-state validation, provenance, or commit MUST NOT be removed merely because an underlying runtime has a similarly named tool. |
| REUSE-REQ-036 | Every removed module MUST pass the deletion test and have characterization coverage for all retained callers; replacement tests cross the new public seam rather than testing deleted internals. |

## Capability Mapping At Completion

| Capability | Runtime implementation | Host responsibility |
| --- | --- | --- |
| `capability_request` | Host proxy | catalog revision and activation policy |
| `material_recall` | Host domain module | parse identity, disclosure bounds, references |
| `project_state_recall` | Host domain module | Project scope and bounded sections |
| `memory_recall` | Host domain module | recall policy, source separation, lineage |
| Reflection/Dream tools | Host domain modules | workflow state and cognitive gates |
| `read`, `ls`, `find`, `grep` | Pi definitions with scope wrapper | Project path authority |
| `web_search`, `web_fetch`, `web_fetch_content` | `pi-web-access` | visibility, observation, source projection |
| `source_check` | `pi-web-access` | on-demand activation and observation |
| `academic_research` | Host evidence aggregator using reusable retrieval adapters | evidence typing and domain normalization |
| text/batch output tools | Host commit modules | intent, confirmation, atomic write, provenance |
| file download/ArXiv archive | reusable fetch/parser plus Host commit | destination, confirmation, artifact record |
| MCP tool | `pi-mcp-adapter` through dynamic Pi tool | activation, credential, scope, permission, bounds |
| Office/Skill Creator procedure | active Skill in isolated job | trust, input snapshot, validation, commit |
| OCR | Utility Worker local runtimes | admission, stage selection, parse commit |
| Sub-Agent attempt | Pi Worker | Host budget, scheduling, context boundary, handoff |

## Session, Revision, And Restart Behavior

- Runtime capability assembly revision includes Host catalog revision, effective Extension revision, frozen MCP activation revision, scoped Pi tool revision, and Skill snapshot revision.
- A changed Extension set, MCP schema set, or tool collision resolution is a Physical Context rebuild boundary.
- A Skill metadata change MAY update a new Turn snapshot without rebuilding when it introduces no tool or provider change; a protected frozen workflow continues with its recorded revision.
- App restart loads configuration and inventories locally but starts no Pi session, Extension code, MCP connection, Skill job, or Provider request.
- Existing Thread trajectory remains readable when an old tool source is no longer installed. Historical tool records preserve source id and revision without attempting to reload it.
- Interrupted tool calls retain existing checkpoint and Unknown Tool Outcome semantics according to side-effect class.

## Configuration And User Experience

Settings SHOULD present capability sources rather than duplicate product features:

- Web: pinned Extension version, active provider/routing summary, raw-workflow status, sanitized failures, and source-check availability.
- Extensions: staged/approved/enabled/effective revision, tool inventory, collisions, trust disclosure, and rebuild status.
- MCP: configured servers, selected tool schemas, scope/action classes, disconnected-by-default state, and last sanitized status.
- Skills: active revision, compatibility, activation description, dependencies, and isolated execution readiness.
- Pi tools: Project read tools available; ordinary shell/write tools intentionally unavailable.

The conversation tool activity projection shows tool name, source class, source id/version, activation reason, action class, confirmation state when Host-mediated, duration, truncation, and sanitized result status. It does not show credentials, raw hidden configuration, browser cookies, or retained source bodies.

## Environment Doctor And Telemetry

Doctor remains local and non-executing. It MUST verify:

- pinned Pi, `pi-web-access`, and `pi-mcp-adapter` versions;
- effective Extension snapshot identity and load preflight without executing Extension code;
- duplicate tool names and missing catalog mappings;
- active Skill revision paths and declared dependency readiness;
- MCP configuration/cache shape without connecting;
- absence of production Host Web fallback wiring; and
- runtime capability assembly revision consistency.

Content-free telemetry MAY record source class/id/version, active tool counts, assembly duration, activation counts, collision/failure codes, bounded byte counts, and duration. It MUST NOT record prompts, source bodies, file names, URLs containing credentials, cookies, API keys, MCP payloads, Skill bodies, or Extension source.

## Failure Codes

Add or reuse typed failures:

`RUNTIME_CAPABILITY_COLLISION`, `RUNTIME_CAPABILITY_SOURCE_UNAVAILABLE`, `RUNTIME_CAPABILITY_REVISION_MISMATCH`, `EXTENSION_LOAD_PREFLIGHT_FAILED`, `EXTENSION_ENTRY_NOT_APPROVED`, `EXTENSION_TOOL_UNMAPPED`, `WEB_EXTENSION_UNAVAILABLE`, `WEB_PROVIDER_FAILED`, `MCP_TOOL_INACTIVE`, `MCP_SCHEMA_MISMATCH`, `SKILL_RESOURCE_ESCAPE`, `SKILL_EXECUTION_UNAVAILABLE`, `PI_TOOL_SCOPE_REJECTED`, and existing authorization, Provider, timeout, cancellation, stale-state, and `UNKNOWN_TOOL_OUTCOME` codes.

No failure automatically enables a broader tool, uses an older Extension, changes MCP server, changes Skill revision, opens browser-cookie access, switches Provider, or restores the deleted Host Web implementation.

## Migration Strategy

The initial migration is primarily runtime and configuration projection, not an authoritative cognition rewrite.

- Existing effective Global Extension Revision records remain authoritative.
- Loader support is added before any new user Extension revision can become effective in a release build.
- Existing `pi-web-access` configuration is read and normalized without discarding unrelated valid fields; a backup is created before any schema rewrite.
- Existing Skill inventory and active revisions are unchanged. Compatibility readers support the old eager instruction snapshot for one migration window, but new Turns use progressive disclosure.
- Existing MCP server records and cached schemas remain; only admitted active schemas gain Pi tool definitions.
- Historical trajectory tool ids are not rewritten. New events add source identity fields.
- Host PublicWeb code is deleted only after no persisted configuration or retry path references it.
- Migration failure leaves prior configuration active or enters Read-only Recovery; it does not start Pi or execute external code.

## Delivery Slices

### CR0 - Characterization And Unified Contracts

- Add production-caller and deletion-test inventory.
- Define runtime tool identity, source, revision, activation, collision, and observation contracts.
- Characterize current Web, Pi project-read, Skill, MCP, Extension snapshot, session rebuild, and citation behavior.
- Add content-free baseline metrics.

Decision gate: no implementation deletion until every retained behavior has a seam-level test.

### CR1 - Approved Extension Runtime

- Implement `ApprovedExtensionLoader` and non-executing preflight.
- Load bundled and approved Extensions through one path.
- Remove unconditional non-empty snapshot rejection and align `approved-trusted` handling with I6.
- Add collision detection, assembly revision, atomic changeover, restart, and malicious identity fixtures.

Decision gate: an exact approved fixture Extension loads after effective revision activation; changed bytes, collision, staging path, and disabled revision never execute.

### CR2 - Web Consolidation

- Map `web_search`, `web_fetch`, `web_fetch_content`, and `source_check` from `pi-web-access` into the capability assembly.
- Add Extension result observation and CitationRegistry projection.
- Preserve validated provider configuration while pinning required public tool names.
- Replace Web tests with Extension-backed fixtures.
- Delete production PublicWeb/Bing execution and fallback wiring.

Decision gate: Web and citation golden cases pass with no Host outbound search request and no silent fallback.

### CR3 - MCP Tool Exposure

- Freeze admitted MCP activation schemas per Turn.
- Register dynamic Pi custom tools backed by `McpIntegrationManager.execute`.
- Add expiry, disconnect, collision, scope, write confirmation, bounded result, retirement, restart, and Unknown Outcome tests.
- Update conversation activity and Doctor projections.

Decision gate: the Agent can call one explicitly activated fixture MCP read/write tool, while unrelated Turns contain no MCP schema and all I5 gates remain green.

### CR4 - Skill Progressive Disclosure And Isolated Execution

- Separate Skill metadata projection from body/resource loading.
- Remove duplicate full-body system-prompt injection.
- Add exact revision resource loading and escape checks.
- Route Office and Skill Creator procedures through the common isolated Skill job interface where compatible.
- Preserve protected workflow snapshots and output commit behavior.

Decision gate: Office, Skill Creator, and academic Skill compatibility evidence passes with one body load, exact revision provenance, and no widened filesystem/shell authority.

### CR5 - Pi Tool And Host Cleanup

- Retain scoped Pi project-read adapters as the standard read implementation.
- Remove overlapping `project.command` text search and shrink remaining Git/PDF metadata tools.
- Delegate qualifying Academic generic retrieval behind the reusable adapter seam.
- Remove obsolete flags, proxies, test-only production branches, duplicate schemas, and dead Host modules.
- Run deletion tests and codebase-wide architecture checks.

Decision gate: ordinary, Project, Reflection, Dream, output, OCR, Sub-Agent, academic, and recovery suites retain behavior with fewer competing implementations.

## Test Traceability

| Test | Requirements | Observable assertion |
| --- | --- | --- |
| REUSE-T-001 Assembly determinism | 001-003 | Same snapshots produce same revision/tools; source or schema change changes revision; collision blocks before Provider. |
| REUSE-T-002 Scoped Pi reads | 004-006 | Project read/list/find/grep work; absolute, traversal, symlink, junction, and Unscoped escape fail. |
| REUSE-T-003 Approved Extension load | 007-013 | Exact effective approved Extension loads once; staging/disabled/changed/colliding artifact never executes. |
| REUSE-T-004 Atomic extension changeover | 010-013 | Active Turn is not hot-mutated; idle/immediate revision behavior preserves I6 semantics. |
| REUSE-T-005 Web implementation ownership | 014, 016, 019 | Search/fetch use pinned Extension; no Host Bing/PublicWeb request or silent fallback occurs. |
| REUSE-T-006 Source check activation | 002, 015 | Absent initially when on-demand; broker activation exposes exact Extension tool. |
| REUSE-T-007 Web configuration | 017, 020 | Required names are stable; valid unrelated fields persist; curator/cookies remain off. |
| REUSE-T-008 Citation observation | 018 | Extension results produce stable citation/source records without a second fetch. |
| REUSE-T-009 MCP visibility | 021-024 | Only frozen selected schemas appear; unrelated Turn and post-expiry session contain none. |
| REUSE-T-010 MCP policy | 022-025 | Read provenance, write confirmation, bounds, secrets, disconnect, schema mismatch, and Unknown Outcome preserve I5. |
| REUSE-T-011 Skill disclosure | 026-029 | Metadata is initial; body loads once from exact revision; resource escape fails; frozen workflow remains stable. |
| REUSE-T-012 Isolated Skill execution | 030-031 | Office/Creator job has bounded tools, staging, timeout, cancellation, validated manifest, and explicit commit; no fallback. |
| REUSE-T-013 Host deletion test | 032-036 | PublicWeb and duplicate search code have zero production caller; retained domain/policy behavior crosses replacement seam. |
| REUSE-T-014 Academic delegation | 034-035 | Evidence types/ids/partial failures remain stable while generic retrieval uses reusable adapter. |
| REUSE-T-015 Restart and history | Session section | Launch starts no Pi/Extension/MCP/job; historical source identities remain readable without reloading code. |
| REUSE-T-016 Doctor and telemetry | Doctor section | Preflight is non-executing; telemetry passes content/secret scan and reports source revisions/collisions. |
| REUSE-T-017 Migration | Migration section | Old Web/Skill/MCP/Extension records remain usable; failure is atomic and starts no external work. |

## Verification Gates

Every slice MUST pass:

```text
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm integration-gate
pnpm personal-build-gate
```

Applicable slices additionally run:

```text
pnpm office:compat
pnpm mcp:compat
pnpm academic-research:compat
pnpm sub-agent:compat
pnpm package:verify-inputs
```

CR1-CR4 MUST include Worker crash, application restart, Provider failure, timeout, cancellation, changed artifact/schema, collision, and stale revision fixtures proportional to the changed scope. Release evidence MUST prove that configuration/Doctor screens execute no Extension, connect no MCP server, start no Skill job, and call no Provider.

## Definition Of Done

- `REUSE-REQ-001` through `REUSE-REQ-036` are implemented or explicitly deferred through an accepted child specification.
- One runtime capability assembly seam owns source-aware tool inventory and activation.
- Exact effective approved Extensions load successfully; staging, disabled, changed, or colliding code does not.
- `pi-web-access` is the only production public Web search/fetch implementation and `source_check` is broker-activatable.
- Citation projection works from Extension results without Host refetch.
- Activated MCP tools are callable by the Agent through Host policy; unrelated Turns contain no MCP schemas.
- Pi project read tools remain reused and scoped; raw ordinary shell/write/edit remain unavailable.
- Skill bodies are progressively disclosed exactly once and isolated Skill jobs preserve Host validation and commit.
- Host PublicWeb/Bing production code and proven duplicate paths are removed.
- Project, Memory, Reflection, Dream, Output, OCR, Sub-Agent, Extension trust, MCP permission, restart, migration, and Unknown Outcome invariants remain green.
- Doctor and packaged runtime report exact capability source revisions without executing dormant integrations.

## Final Decision Gate

Stop and revise this specification if implementation requires any of the following:

- allowing an unapproved or identity-mismatched Extension to execute;
- resolving tool collisions by load order;
- making global enablement equivalent to Turn visibility or execution authorization;
- enabling raw shell/write/edit in ordinary Turns;
- bypassing Host scope, confirmation, credential, provenance, stale-state, or commit checks;
- retaining a hidden Host Web fallback after declaring the Extension authoritative;
- injecting every MCP schema or full Skill body into every Turn;
- representing trusted Extension observation as a hostile-code sandbox;
- automatic Provider, server, package, revision, parser, or implementation fallback; or
- deleting a Host module whose policy or domain complexity reappears across callers without a deeper replacement interface.

The refactor succeeds when the Host becomes smaller because execution behavior is reused behind strong seams, while product authority remains local, explicit, and testable.
