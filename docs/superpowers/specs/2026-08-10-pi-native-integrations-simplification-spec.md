# Pi-Native Integrations Simplification Specification

Date: 2026-08-10
Status: Approved for implementation
Scope: Pi runtime resource loading, Extensions, MCP, Skills, integration settings, migration, and removal of superseded governance machinery

## Problem Statement

VC Desktop currently makes Extensions, MCP servers, and Skills pass through separate Host-owned admission, registration, revision, activation, permission, and projection workflows before Pi can use them. Those workflows duplicate capabilities already provided by Pi and `pi-mcp-adapter`, spread integration knowledge across the Host, Renderer, Agent Worker, persistence, IPC contracts, and Pi Adapter, and make a Personal Build integration feel substantially more complicated than an ordinary Pi Agent.

The complexity does not produce a uniform security guarantee. An enabled Extension is already Trusted Worker Code with the Agent Worker's effective process authority, so Host approval records cannot sandbox its direct filesystem, network, subprocess, session, or in-process behavior. MCP action-class inference and per-Turn schema activation add a large control plane that differs from ordinary Pi behavior. Skills are mixed into the same governance shape even though the product has one distinct requirement for them: VC Desktop must never discover Skills from Claude Code, Codex, Pi, project `.agents` roots, or other coding-agent installations.

The user wants Extension and MCP integration to regain ordinary Pi flexibility and operating semantics. Installing an Extension or listing an MCP server in configuration must itself be the trust decision. Skills must use Pi's native progressive disclosure and package format while being discoverable only from one dedicated VC Agent Skills Directory. Host-owned Project, Thread, Memory, Output, Reflection, Dream, authorization, trajectory, and durable commit semantics must remain separate from this integration simplification.

## Solution

VC Desktop will introduce one deep Pi resource runtime Module behind the existing Pi session creation Seam. The Module will use Pi's `DefaultResourceLoader` and `SettingsManager` instead of constructing separate snapshots and dynamic projections for Extensions, MCP tools, and Skills.

VC Desktop will have an app-controlled Pi agent directory. Extensions placed in its Extension directory or declared in its Pi settings will load with ordinary Pi Extension semantics. A separately disclosed coarse project-resource trust setting may allow project-local Pi Extensions; there will be no per-Extension staging, source audit, approval, enablement record, immutable revision, atomic Global Extension Revision, or application-level rollback workflow. Presence in a trusted source is the user's trust and enablement decision.

The pinned `pi-mcp-adapter` will load as an ordinary Pi Extension. MCP servers will be configured through an app-owned `mcp.json`, with optional project configuration when project Pi resources are trusted. The adapter will own proxy-first discovery, connection, status, schema discovery, calls, and reconnection. VC Desktop will not register every remote schema as a separate Host capability and will not classify or confirm individual MCP calls. Listing a server in effective MCP configuration is the user's trust decision.

Skills will be the only resource type with a custom source Adapter. Pi default Skill discovery will be disabled. The resource runtime will supply only the dedicated VC Agent Skills Directory and will enforce canonical containment for every Skill directory, `SKILL.md`, referenced resource, and symbolic-link target. Skills in any other global, project, coding-agent, Extension-contributed, or ambient Pi location will not load. A complete Skill may be copied into the dedicated directory through a convenience import action, but no separate package revision or activation database is required. A Skill directory's presence means available; removing it means unavailable.

The application will remain dormant until the user submits model-backed work. Settings, diagnostics, Project and Thread navigation, and file management will not create a Pi session, execute Extension code, connect an MCP server, start a Skill job, or call a Provider. Ordinary Pi built-in `bash`, `write`, and `edit` tools will remain disabled. Host capabilities will continue to mediate authoritative product state and durable commits.

## User Stories

1. As a VC Desktop user, I want to install a Pi Extension by placing it in a documented Extension directory, so that I can use Pi ecosystem functionality without an application-specific approval workflow.
2. As a VC Desktop user, I want an Extension declared in effective Pi settings to load using Pi semantics, so that Pi documentation and ecosystem conventions remain useful.
3. As a VC Desktop user, I want a single Reload action, so that changed integration files become effective without stage, inspect, approve, prepare, and commit steps.
4. As a VC Desktop user, I want Extension load errors shown as diagnostics, so that I can repair files or configuration without navigating a governance workflow.
5. As a VC Desktop user, I want tool-name collisions reported deterministically, so that load order does not silently select an unintended tool.
6. As a VC Desktop user, I want to understand that an installed Extension is Trusted Worker Code, so that I can make an informed trust decision before placing it in a trusted source.
7. As a VC Desktop user, I want Extension installation to be the trust decision, so that the UI does not imply a sandbox that the runtime cannot provide.
8. As a VC Desktop user, I want optional project-local Extensions to require one clear project-resource trust decision, so that Projects do not execute local code merely because they were viewed.
9. As a VC Desktop user, I want active Turns to remain stable while integration files change, so that Reload does not hot-mutate code during model execution.
10. As a VC Desktop user, I want new resource configuration to apply at the next safe session boundary, so that integration behavior is predictable.
11. As a VC Desktop user, I want to configure MCP servers in `mcp.json`, so that MCP setup resembles ordinary Pi Agent setup.
12. As a VC Desktop user, I want `pi-mcp-adapter` to expose its token-efficient proxy tool, so that all remote schemas are not injected into every Physical Model Context.
13. As a VC Desktop user, I want MCP search, describe, call, and status behavior to come from the pinned adapter, so that VC Desktop does not duplicate MCP protocol behavior.
14. As a VC Desktop user, I want adding a server to effective MCP configuration to be the explicit trust action, so that there is no separate registration and per-Thread activation lifecycle.
15. As a VC Desktop user, I want MCP connection failures surfaced directly, so that VC Desktop does not silently switch servers, adapters, or implementations.
16. As a VC Desktop user, I want secrets referenced through environment or OS-protected materialization rather than copied into migration logs, so that simplifying configuration does not expose credentials.
17. As a VC Desktop user, I want MCP servers to remain disconnected while the application is idle, so that opening the app or settings has no external side effects.
18. As a VC Desktop user, I want MCP configuration changes to take effect after Reload or a new session, so that connection lifecycle remains understandable.
19. As a VC Desktop user, I want a dedicated VC Agent Skills Directory, so that investment Skills never mix with coding-agent Skills.
20. As a VC Desktop user, I want Skills from Claude Code, Codex, Pi global roots, project `.agents` roots, and other ambient locations ignored, so that unrelated instructions do not enter investment work.
21. As a VC Desktop user, I want Skill symbolic links and referenced resources constrained to the dedicated directory, so that the source restriction cannot be bypassed indirectly.
22. As a VC Desktop user, I want Pi's native progressive disclosure for Skills, so that startup context contains bounded metadata rather than every full instruction body.
23. As a VC Desktop user, I want to import a compatible Skill by copying its complete directory, so that reuse remains convenient without live cross-agent coupling.
24. As a VC Desktop user, I want a Skill to become available when its directory is present and valid, so that I do not need a separate activation database.
25. As a VC Desktop user, I want invalid Skill metadata and collisions shown as diagnostics, so that one bad package does not become an opaque runtime failure.
26. As a VC Desktop user, I want ordinary Pi `bash`, `write`, and `edit` to remain unavailable, so that integration simplification does not silently broaden first-party file mutation behavior.
27. As a Project user, I want Project reads and Host-owned writes to retain their existing scope rules, so that a Pi resource refactor does not change Project authority.
28. As a Project user, I want Outputs, Memory, Reflection, Dream, and other authoritative state changes to continue through Host-owned Modules, so that Pi runtime resources cannot redefine product truth.
29. As a user reopening an existing Thread, I want its Thread Trajectory to remain readable even when an old Extension, server, or Skill is no longer installed, so that history does not depend on re-executing integrations.
30. As a user with existing approved Extensions, I want the effective selected artifacts migrated to the new Extension directory, so that I do not have to reinstall everything manually.
31. As a user with existing MCP records, I want them exported to the new configuration format without exposing credentials, so that migration is safe and comprehensible.
32. As a user with existing active Skills, I want the effective package contents copied into the dedicated Skills Directory, so that existing workflows continue after migration.
33. As a user, I want migration to be idempotent and backed up, so that interruption or retry does not duplicate or corrupt integration state.
34. As a user, I want the obsolete integration UI removed after migration, so that the product presents one obvious way to manage each resource.
35. As a maintainer, I want one Pi resource loading Seam, so that Pi version compatibility and resource lifecycle changes remain local to one Module.
36. As a maintainer, I want Extension, MCP, and Skill loading to reuse upstream Pi behavior, so that the application does not maintain parallel implementations.
37. As a maintainer, I want diagnostics to observe resource loading without executing dormant resources, so that Doctor and settings remain safe local operations.
38. As a maintainer, I want old persistence tables, IPC commands, runtime projections, and tests deleted after successful migration, so that compatibility machinery does not become permanent.
39. As a maintainer, I want the pinned Pi fork and `pi-mcp-adapter` compatibility proven before migration, so that the design is validated against the actual bundled versions.
40. As a maintainer, I want replacement tests to cross the Pi session creation Seam, so that tests protect user-observable behavior rather than deleted management internals.

## Implementation Decisions

- A new ADR MUST precede production implementation and explicitly supersede the conflicting Extension admission, Global Extension Revision, task-activated Extension, controlled MCP activation, per-tool MCP confirmation, and app-generated exact-resource snapshot decisions. The ADR retaining one isolated VC Agent Skills Directory remains governing.
- This specification supersedes the Extension, MCP, and generic Skill-management portions of the earlier capability-reuse specification and the I5/I6 executable specifications. It does not supersede their requirements for Host-owned product state, lazy Pi activation, sanitized credential handling, failure visibility, or no automatic fallback.
- The primary architectural Seam is Pi session creation. Callers provide product context and Host tools; they do not assemble resource loaders, Extension inventories, MCP schema definitions, or Skill bodies.
- One internal `PiResourceRuntime` Module will hide Pi settings construction, resource loading, Reload behavior, Extension flag values, diagnostics, tool inventory, collision detection, and safe session replacement.
- `PiResourceRuntime` will use Pi's `DefaultResourceLoader` and `SettingsManager` rather than a custom snapshot ResourceLoader.
- VC Desktop will provide an app-controlled Pi agent directory. It will not point Pi at the user's ordinary Pi or coding-agent home directory.
- App-global Extensions will be discovered from the VC Desktop Pi agent directory and explicit Pi settings using native Pi loading behavior.
- Project-local Extensions MAY be supported only behind one coarse project-resource trust decision. Merely opening, inventorying, or viewing a Project MUST NOT execute project-local Extension code.
- Extension presence in an effective trusted source is both trust and enablement. There will be no application-level staging, audit, approval, immutable artifact identity, enablement record, pending revision, atomic Global Extension Revision, or rollback state.
- Extension code executes only inside an Agent Worker created for submitted model-backed work. Settings and Doctor do not load Extension entry points.
- Integration file changes MUST NOT hot-mutate an Active Turn. Reload is applied at an idle session replacement boundary or deferred until the next session.
- Tool collisions MUST be reported deterministically. An unresolved duplicate provider-facing name prevents the affected resource set from entering a new session; load order MUST NOT silently resolve it.
- The pinned `pi-mcp-adapter` will be loaded as a normal Pi Extension through the common ResourceLoader.
- Its effective configuration path will be supplied through the adapter's supported Extension flag, with an app-owned `mcp.json` as the installation configuration.
- Project-local MCP configuration MAY participate when project Pi resources are trusted and when that merge behavior is proven by compatibility tests.
- The adapter's single proxy tool will own MCP search, description, invocation, status, connection, and reconnection behavior.
- VC Desktop will not create one Pi custom tool per remote MCP schema, persist schema action classes, freeze schemas per Turn, or route ordinary MCP calls through a Host execution manager.
- Listing an MCP server in effective configuration is the user's trust decision. Standard Access and Full Access do not add per-tool MCP confirmation under this specification.
- MCP credentials MUST be represented by environment references or a minimal credential-materialization Adapter. Renderer payloads, migration output, diagnostics, telemetry, and Thread Trajectory MUST NOT contain secret values.
- No MCP server is connected during app startup, Project browsing, Thread viewing, settings, migration, or Doctor. Connection begins only after a submitted Turn creates the relevant Pi session.
- Pi default Skill discovery will be disabled for every VC Desktop Pi session.
- The only supplied Skill source will be the dedicated VC Agent Skills Directory. No user Pi home, `.agents`, `.codex`, project `.pi/skills`, project `.agents/skills`, imported live root, or Extension-contributed Skill path is admitted.
- A small Skill path Adapter will enforce canonical containment after symbolic-link and junction resolution for Skill directories, `SKILL.md`, and referenced resources. Escape is a hard load failure for that Skill.
- Skill parsing, metadata validation, collision diagnostics, invocation, and progressive disclosure will reuse Pi.
- A convenience import operation MAY copy a complete compatible Skill directory into the dedicated directory. It MUST validate the final canonical destination and MUST NOT retain a live link to the source.
- Skill availability is derived from valid directory contents. Separate package revision, activation, overlay, and runtime body-snapshot stores are removed for ordinary Skills.
- Protected Office and Skill Creator workflows MAY retain isolated runners, frozen input snapshots, output validation, preview, source replacement confirmation, provenance, and Host commit. Those controls protect durable product actions and are not a generic Skill registration system.
- Ordinary Pi built-in `bash`, `write`, and `edit` remain disabled. Existing scoped Project read tools and Host Capability Gateway tools remain available according to product policy.
- Extension tools and the MCP proxy form the Pi-native base tool set for a created session. Host tool visibility may still vary by Turn; Host activation code MUST NOT accidentally deactivate the Pi-native base set.
- Host remains authoritative for Project, Thread, Material, Context, Memory, Output, Reflection, Dream, authorization, Operational State, Thread Trajectory, and final durable commits.
- Historical trajectory records retain tool name, source class, sanitized source identity when available, completion status, and bounded result metadata. Reading history never reloads old code or reconnects old servers.
- Settings will provide Open Folder or Open Configuration, Reload, trust disclosure, and read-only diagnostics for Extensions, MCP, and Skills. It will not reproduce the removed control plane under different labels.
- Doctor will inspect configuration files, directory accessibility, versions, and static diagnostics without executing Extension code, connecting MCP servers, invoking Skills, or calling a Provider.
- Migration will select the currently effective approved Extension artifact, currently effective Skill package, and existing MCP server records. It will copy or export them into the new sources, create a backup, and record an idempotent migration marker.
- Migration failure leaves prior state available for retry and starts no external work. Obsolete state is deleted only after replacement configuration is validated and a release migration window completes.
- The first implementation slice is a compatibility spike proving the bundled Pi fork can directly load `pi-mcp-adapter`, honor its configuration flag, expose its proxy, remain dormant before session creation, and cleanly close connections.
- The second slice introduces `PiResourceRuntime` behind existing session creation without changing user behavior.
- The third slice moves Skills to the dedicated native Pi source and removes ordinary Skill activation and body projection.
- The fourth slice moves Extension loading to trusted directories/settings and removes admission and Global Revision behavior.
- The fifth slice exports MCP configuration, enables the native adapter path, and removes schema projection and Host MCP execution management.
- The final slice removes obsolete IPC, persistence, Renderer state, managers, projections, compatibility readers, and tests, then updates governing documentation.

## Testing Decisions

- Tests MUST assert externally observable behavior rather than private loader calls, persistence shapes, or deleted workflow stages.
- The highest primary test Seam is creation and use of a Pi session from submitted model-backed work. Focused tests MAY exercise `PiResourceRuntime` for deterministic resource diagnostics without exposing it to unrelated callers.
- Existing lazy-activation tests are prior art: app startup, Project opening, Thread viewing, settings, migration, and Doctor MUST produce no Agent Worker, Provider call, Extension side effect, MCP connection, or Skill invocation.
- Existing runtime resource assembly tests are prior art for asserting the resulting tool inventory, collisions, and active tool names; assertions will be rewritten against the new session Seam.
- Existing Skills Directory escape and compatibility tests are prior art for canonical containment, complete-directory import, malformed metadata, collision, and progressive disclosure.
- Existing MCP compatibility tests are prior art for real adapter startup, proxy search/describe/call/status, configuration errors, connection closure, and sanitized failures.
- A fixture Extension placed in the app Extension directory MUST load in the next session without any approval record.
- The same fixture outside all effective sources MUST not load.
- A project-local fixture Extension MUST not execute before the coarse project-resource trust decision and MUST load after trust at the next safe session boundary.
- Modifying Extension files during an Active Turn MUST not change the running session. Reload MUST either wait for idle or apply to a replacement session.
- Duplicate Extension, MCP proxy, and Host tool names MUST produce a deterministic diagnostic and prevent an ambiguous new session.
- Editing the app `mcp.json` and reloading MUST change the adapter's effective server inventory without creating Host schema records.
- An MCP fixture MUST remain disconnected until a submitted Turn creates a session.
- The MCP proxy MUST support bounded search, describe, call, and status behavior using the pinned adapter.
- MCP failure MUST remain visible and MUST not cause automatic server, adapter, Provider, or implementation fallback.
- Migration tests MUST prove credential values never appear in exported JSON, logs, diagnostics, telemetry, Renderer payloads, or trajectory fixtures.
- A valid Skill in the dedicated directory MUST appear through Pi metadata and load its full instructions only when invoked.
- Skills in user Pi roots, `.agents`, `.codex`, project `.pi/skills`, project `.agents/skills`, and Extension-contributed paths MUST not appear.
- Direct and multi-hop symbolic-link or junction escape from the dedicated Skills Directory MUST fail.
- A malformed or colliding Skill MUST produce a bounded diagnostic without loading an ambient replacement.
- Complete-directory Skill import MUST copy regular files safely, reject traversal and escaping links, and remain usable after the source is removed.
- Ordinary sessions MUST not expose Pi built-in `bash`, `write`, or `edit`.
- Project and Unscoped tests MUST prove existing Project read scope and absence of implicit Project authority remain unchanged.
- Host capability tests MUST prove Memory, Output, Reflection, Dream, and other durable commits still cross their existing Host seams.
- Historical Thread Trajectory MUST remain readable after deleting the current Extension, MCP configuration, or Skill directory and MUST not attempt resource reload.
- Migration MUST be idempotent, preserve backups, select one effective prior artifact, and leave retryable prior state after injected interruption.
- Deletion tests MUST prove obsolete admission, activation, schema, projection, revision, and management Modules have zero production callers and that their policy does not reappear across multiple callers.
- Compatibility and release verification MUST include type checking, unit tests, desktop end-to-end tests, integration gates, personal-build gates, packaged runtime inputs, and the real MCP compatibility lane applicable to the changed slice.
- Test fixtures that execute Extension code or connect MCP MUST run only in explicitly marked runtime tests, never in static Doctor or settings tests.

## Out of Scope

- Sandboxing, capability-restricting, or proving the safety of arbitrary Pi Extension code.
- Preserving per-Extension source audit, dependency review, exact hash approval, immutable revision, enablement, atomic Global Revision, or application rollback workflows.
- Preserving per-MCP-tool action classification, Host confirmation, frozen per-Turn schema activation, or application-managed MCP tool registration.
- Enabling raw Pi `bash`, `write`, or `edit` in ordinary Turns.
- Allowing Skills from any source other than the dedicated VC Agent Skills Directory.
- Replacing Host ownership of Project, Thread, Memory, Output, Reflection, Dream, trajectory, authorization, or durable commits.
- Redesigning Office output validation, original-file replacement, Skill Creator isolation, OCR, Web citation behavior, Provider selection, or Model Profile assignment except where compilation requires adapting to the new resource runtime.
- Building a package marketplace, automatic Extension or Skill updates, automatic dependency installation, or automatic fallback.
- Hot-reloading resources inside an Active Turn.
- Multi-user, team-wide, or centrally administered integration policy.

## Further Notes

- This is an intentional trust-model change, not a behavior-preserving refactor. Ordinary Pi similarity and the former per-resource Host governance cannot both be retained without recreating the same complexity.
- The product must disclose that Extensions are arbitrary Agent Worker code and that configured MCP servers and their exposed tools are trusted as a set. Standard Access cannot be represented as mediating their internal process or protocol behavior.
- Skills receive a narrower trust statement: VC Desktop guarantees source isolation and path containment, not correctness or benign instructions.
- Application-level rollback is replaced by filesystem backup, source control, or restoring a prior configuration. Migration creates one explicit backup before removing old state.
- The app-controlled Pi directory preserves Pi configuration semantics without sharing the user's real Pi, Codex, Claude Code, or other coding-agent home directories.
- If direct top-level `pi-mcp-adapter` loading is incompatible with the bundled Pi fork, implementation MUST stop at the compatibility spike. The fallback is to upgrade or patch the pinned adapter at its native Extension Seam, not to retain both the old Host MCP manager and the new native path indefinitely.
- Completion means users manage Extensions by directory/settings, MCP by `mcp.json`, and Skills by one dedicated directory; settings offer Reload and diagnostics; and the prior governance systems have been deleted rather than hidden behind a new Interface.
