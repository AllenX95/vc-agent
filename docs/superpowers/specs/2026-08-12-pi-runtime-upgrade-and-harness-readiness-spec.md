# Pi Runtime Upgrade and AgentHarness Readiness Specification

Date: 2026-08-12

## Problem Statement

VC Desktop currently pins the earendil-works Pi runtime family at 0.80.8. Pi 0.84.1 contains relevant reliability fixes for streaming, Provider cancellation, Thread Compaction, Extension lifecycle, Windows paths, session handling, and dependency security. The repository also declares Pi packages across multiple workspaces even though production source code reaches Pi through the Pi Adapter and directly imports only pi-ai and pi-coding-agent. This makes the effective runtime version harder to reason about and increases the risk of multiple Pi runtime copies entering the Agent Worker bundle.

Pi 0.84 also publishes the v4 Session/SessionRepo model and AgentHarness v2 interface. AgentHarness v2 is not yet capable of replacing the current execution path: prompt, restore, compaction, abort, resume, event watching, hooks, and lane execution remain unimplemented in 0.84.1. Migrating production Threads now would remove required behavior rather than simplify it.

The project needs a controlled Pi runtime upgrade that preserves the existing `createAgentSession` and `SessionManager` behavior, concentrates Pi dependency ownership behind one seam, proves compatibility with existing Physical Model Context files and Pi-native integrations, and records objective readiness criteria for a later AgentHarness migration.

## Solution

Upgrade the effective Pi runtime family to 0.84.1 through the existing Pi Adapter seam. Keep `createAgentSession` plus `SessionManager` as the production adapter and preserve the existing `PiSessionHandle` interface as the only Agent Worker-facing execution interface.

Reduce redundant direct Pi dependency declarations where packaged-build evidence proves they are unnecessary. Enforce one effective version family for pi-agent-core, pi-ai, pi-coding-agent, and pi-tui in the resolved dependency graph. Keep the existing pinned pi-mcp-adapter and pi-web-access versions unless compatibility evidence requires a separate follow-up migration.

Add compatibility gates for old session recovery, streaming deltas, tool schemas, compaction, cancellation, Extension and MCP lifecycle, Windows packaging, and visible version metadata. Record an AgentHarness readiness gate based on executable behavior rather than export availability. Do not add a dormant production AgentHarness adapter until the upstream implementation can satisfy the existing `PiSessionHandle` behavior.

## User Stories

1. As a VC Desktop user, I want existing Threads to open after the Pi upgrade, so that an infrastructure update does not lose my conversation history.
2. As a VC Desktop user, I want an interrupted or restarted Thread to preserve its visible trajectory, so that I can continue work without duplicated or missing turns.
3. As a VC Desktop user, I want text and thinking output to stream normally, so that responses remain responsive after Pi changes its event payloads.
4. As a VC Desktop user, I want the final assistant response to match the streamed response, so that delta assembly does not duplicate or omit content.
5. As a VC Desktop user, I want manual Thread Compaction to remain visible and reliable, so that I can deliberately reduce context when needed.
6. As a VC Desktop user, I want threshold Thread Compaction to remain reliable, so that long-running work does not fail unexpectedly near the context limit.
7. As a VC Desktop user, I want truncated Provider responses to recover according to Pi behavior, so that temporary output-limit conditions do not silently end useful work.
8. As a VC Desktop user, I want Stop to cancel the active Turn promptly, so that I retain control over long or mistaken runs.
9. As a VC Desktop user, I want stopping a Turn to leave the Thread in a valid state, so that the next Turn can proceed without dangling tool calls.
10. As a VC Desktop user, I want Project read tools to remain confined to the authorized Project, so that a runtime upgrade does not weaken path policy.
11. As a VC Desktop user, I want task-relevant capabilities to remain the only Host tools active for a Turn, so that the Minimal Default Harness remains compact.
12. As a VC Desktop user, I want Pi-native Extensions to continue loading only at an Agent Worker session boundary, so that browsing and settings remain local Host actions.
13. As a VC Desktop user, I want configured MCP servers to remain dormant before submitted work, so that application startup does not contact external systems.
14. As a VC Desktop user, I want MCP child processes to close when the Agent Session is retired, so that integrations do not leak processes or credentials.
15. As a VC Desktop user, I want public web research to continue through the pinned Pi Extension, so that the application retains one supported web implementation.
16. As a VC Desktop user, I want custom Provider URLs and API keys to continue working, so that existing Model Profiles remain usable.
17. As a VC Desktop user, I want Provider cancellation and retry behavior to remain bounded, so that stalled requests do not mutate state after cancellation.
18. As a Windows user, I want Project paths, Git Bash paths, MSYS paths, and WSL paths to resolve correctly, so that file tools behave consistently.
19. As a Windows user, I want the packaged application to contain exactly the Pi runtime and Extension assets it needs, so that development success is not contradicted by packaged failure.
20. As a user, I want Doctor to report the actual bundled Pi versions, so that diagnostics describe the software I am running.
21. As a maintainer, I want one effective Pi runtime version family, so that runtime classes, events, and Extension contexts do not cross incompatible package copies.
22. As a maintainer, I want direct dependencies to correspond to actual source or packaging needs, so that package manifests explain rather than obscure architecture.
23. As a maintainer, I want the Pi Adapter to remain the single seam for Agent execution, so that future runtime replacements remain local.
24. As a maintainer, I want Worker and Host code to depend only on `PiSessionHandle` behavior, so that they do not learn Pi-specific session or lane concepts.
25. As a maintainer, I want old 0.80.8 session fixtures exercised by the 0.84.1 runtime, so that persistence compatibility is proven rather than assumed.
26. As a maintainer, I want Host/Pi high-water reconciliation preserved, so that the upgrade does not change the current authority model accidentally.
27. As a maintainer, I want TypeBox tool schemas exercised against the upgraded runtime, so that nullable unions and validation behavior remain correct.
28. As a maintainer, I want pi-web-access peer resolution inspected, so that it uses the intended Pi runtime instance.
29. As a maintainer, I want the pinned pi-mcp-adapter tested without upgrading its major version, so that two independent migrations are not conflated.
30. As a maintainer, I want lockfile checks to detect multiple Pi runtime versions, so that accidental mixed-runtime installations fail early.
31. As a maintainer, I want integration tests to observe events through the Pi Adapter seam, so that tests survive internal runtime refactoring.
32. As a maintainer, I want packaged smoke evidence on Windows, so that native helpers and bundled Extensions are verified in the actual distribution shape.
33. As a maintainer, I want version-labelled diagnostics and compatibility evidence updated atomically with the runtime, so that stale evidence is not presented as current.
34. As a maintainer, I want AgentHarness v2 adoption decided by executable readiness criteria, so that a default export is not mistaken for production maturity.
35. As a maintainer, I want a future AgentHarness adapter to replace the current adapter rather than layer underneath it, so that migration deletes complexity.
36. As a maintainer, I want Agent execution state to have one authority if AgentHarness is eventually adopted, so that Host and Pi do not maintain competing durable operation logs.
37. As a maintainer, I want Product-owned Project, Thread, Material, Memory, Reflection, Output, authorization, and provenance semantics to remain Host-owned, so that generic runtime adoption does not erase the VC domain model.
38. As a maintainer, I want no production code path to instantiate AgentHarness v2 in this release, so that unimplemented upstream operations cannot affect users.
39. As a maintainer, I want a small throwaway readiness probe to be possible later, so that future upstream versions can be evaluated without changing production Threads.
40. As a maintainer, I want rollback to 0.80.8 to remain possible before new session data is accepted as the release baseline, so that failed compatibility work is recoverable.

## Implementation Decisions

- The Pi Adapter remains the deep Module for Pi-backed execution. Its external interface remains `PiSessionHandle`; callers do not receive `AgentSession`, `SessionManager`, AgentHarness, lane, repository, or Pi event types.
- The existing production adapter continues to use `createAgentSession`, `AgentSession`, and `SessionManager` at Pi 0.84.1.
- AgentHarness v2 is not instantiated by production, test-production, migration, Doctor, or settings paths in this specification.
- The upgrade target is 0.84.1. Version 0.84.0 is not an accepted target because 0.84.1 contains immediate corrective fixes.
- pi-agent-core, pi-ai, pi-coding-agent, and pi-tui must resolve to one compatible 0.84.1 version family in the Agent Worker dependency closure.
- The Pi Adapter directly owns pi-ai and pi-coding-agent because its implementation imports their interfaces.
- Direct pi-agent-core and pi-tui declarations may be removed from application manifests only when type checking, Agent Worker bundling, dependency inspection, and packaged smoke tests prove they are transitive-only. They must not remain merely to create the appearance of version alignment.
- Workspace-level overrides may enforce the Pi version family if they improve dependency determinism. Overrides do not replace correct direct dependency declarations.
- The lockfile is reviewed as an architectural artifact. Multiple pi-agent-core, pi-ai, pi-coding-agent, or pi-tui versions in the Agent Worker runtime closure are a failed upgrade unless an explicitly documented, isolated tool-only dependency requires them.
- pi-web-access remains at the currently pinned version for this slice. Its peer dependencies must resolve to the upgraded Pi runtime and its production web tools must pass compatibility tests.
- pi-mcp-adapter remains at 1.5.1 for this slice. A migration to its 2.x line requires a separate specification and fresh real MCP compatibility evidence.
- The project-owned TypeBox version is not upgraded pre-emptively. Existing tool definitions are compiled and exercised against Pi 0.84.1 first; TypeBox alignment becomes a separate evidenced change if validation or type failures require it.
- JSON/RPC cumulative `message_update` payloads are not relied upon. Streaming continues to consume text and thinking deltas and treats the terminal assistant message as authoritative.
- `pending` or otherwise non-terminal Provider streaming state must not be projected as a successfully completed Turn.
- Host/Pi high-water reconciliation, Physical Model Context rebuilding, and retained Thread history remain unchanged during this upgrade.
- Pi v4 SessionRepo does not replace coding-agent `SessionManager` in this slice. No migration of existing Pi JSONL session files to v4 Harness storage is performed.
- Manual, threshold, and overflow compaction continue to be projected into existing visible Thread events.
- Session disposal continues to emit the Pi Extension shutdown lifecycle needed by the pinned MCP adapter. Any upstream lifecycle change must be handled inside the Pi Adapter.
- Doctor, capability metadata, compatibility evidence, notices, and visible dependency descriptions must report the actual packaged versions after the upgrade.
- AgentHarness readiness is evaluated against behavior: prompt, tool execution, event observation, restore, abort, resume, compaction, queueing, Extension integration, and durable session compatibility must be implemented upstream.
- A future AgentHarness migration must replace the current execution implementation behind `PiSessionHandle`; it must not add a second durable session alongside `SessionManager` and Host trajectory.
- Before a future migration, the authority model must be explicitly revised: Harness durable operations may become the Agent execution authority, while Host trajectory remains the Product-visible event projection and VC domain record.
- Host-owned Project, Thread, Material, Model Profile, Memory, Dream, Reflection, Output, authorization, provenance, and Worker isolation remain outside the generic Agent runtime.
- A future AgentHarness adoption requires its own ADR or an explicit amendment to the Pi SDK integration ADR because it changes session authority and recovery semantics.
- Upgrade failure must leave the 0.80.8 baseline available in source control. No destructive conversion of user session files is allowed.

## Testing Decisions

- `PiSessionHandle` is the highest and primary testing seam. Tests submit work and observe deltas, completion, failure, compaction, cancellation, acknowledgement, reconciliation, and disposal without inspecting the underlying `AgentSession` or future Harness implementation.
- Existing Pi Adapter integration tests are prior art for streaming, provider tool schemas, custom URL Providers, native Extensions, MCP lifecycle, context retention, and session reconciliation.
- A compatibility fixture produced by 0.80.8 must be opened by the upgraded runtime and classified correctly as resumed, Host ahead, Pi ahead, or irreconcilable.
- Streaming tests must verify that multiple text and thinking deltas assemble exactly once and that the terminal message remains authoritative.
- Stop tests must verify prompt rejection or interruption, absence of a false completed event, and successful subsequent work on a valid Thread.
- Compaction tests must cover manual, threshold, aborted, failed, and successful outcomes through visible events.
- Tool tests must exercise Project path containment, active capability selection, tool result error mapping, nullable schema values, and parallel tool event ordering where relevant.
- Extension tests must verify discovery remains dormant before session binding, tools become active after binding, reload emits shutdown, and disposal leaves no surviving Extension context.
- MCP tests must retain lazy connection, bounded discovery/call behavior, and child-process shutdown. Real MCP evidence is required before release acceptance.
- Web Extension tests must verify the expected tools load and execute with the upgraded Pi peer runtime.
- Provider tests must cover built-in catalog lookup, custom URL registration, API-key application, abort propagation, and sanitized failure projection.
- Dependency tests or build assertions must inspect the resolved Agent Worker closure and fail on unintended mixed Pi runtime versions.
- Build verification must include Agent Worker bundling because all earendil-works packages are currently inlined into that artifact.
- Packaged Windows smoke must verify application startup, one Pi-backed Turn, one Project read, Extension resource discovery, and clean shutdown.
- Doctor tests must assert reported versions are derived from the accepted dependency baseline rather than stale literals where practical.
- Tests should assert externally visible behavior and durable outcomes, not private fields, exact internal call sequences, or upstream class identity.
- If direct dependency declarations are removed, tests must prove both development and packaged module resolution; a passing TypeScript build alone is insufficient.
- No AgentHarness production compatibility test is required in this slice because production does not instantiate it. An optional isolated readiness test may document current `HarnessNotImplemented` behavior but must not become a permanent assertion that blocks upstream progress.

## Out of Scope

- Migrating production execution to AgentHarness v2.
- Migrating coding-agent `SessionManager` files to v4 SessionRepo storage.
- Introducing lanes, parallel lane execution, durable operation recovery, or remote Pi sessions into Product Threads.
- Changing the Host/Pi authority model or deleting high-water reconciliation.
- Replacing the Agent Worker process model.
- Upgrading pi-mcp-adapter to 2.x.
- Upgrading pi-web-access unless required by demonstrated incompatibility.
- Pre-emptively upgrading the project-owned TypeBox dependency.
- Adopting Pi fullscreen TUI, terminal Mermaid/LaTeX rendering, terminal history, or other CLI/TUI functionality.
- Changing VC domain semantics, Memory, Dream, Reflection, Output provenance, Access Mode, or authorization.
- Adding new Providers or exposing new Pi CLI configuration surfaces merely because 0.84.1 supports them.

## Further Notes

- The purpose of this slice is reliability and architectural locality, not feature expansion.
- The deletion test governs future AgentHarness adoption. A successful migration must remove SessionManager reconciliation or Worker operation complexity; an adapter that retains both old and new durable execution models is rejected.
- AgentHarness v2 should be re-evaluated only after upstream implements prompt, existing-session restore, compaction, abort/resume, observation, hooks, and lane execution and then ships at least one stabilization patch.
- The supporting release analysis is maintained in the repository research notes and should be updated if the accepted target version changes before implementation begins.
