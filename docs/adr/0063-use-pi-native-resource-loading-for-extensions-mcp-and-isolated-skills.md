# Use Pi-Native Resource Loading For Extensions, MCP, And Isolated Skills

Status: Accepted

Date: 2026-08-10

## Decision

VC Desktop uses one Pi resource-loading Module behind the Agent Worker session-creation Seam. The Module uses the pinned Pi fork's `DefaultResourceLoader` and `SettingsManager`, with an application-owned Pi agent directory. App-global Extensions are discovered from that directory or effective Pi settings and are trusted when present; project-local Extensions are optional and require one coarse project-resource trust decision. VC Desktop does not maintain a parallel Extension admission, approval, revision, activation, or rollback workflow.

The pinned `pi-mcp-adapter` is loaded as an ordinary Pi Extension. Its supported `mcp-config` flag points at an application-owned `mcp.json`. The adapter owns MCP search, description, calls, status, connection, and reconnection. Listing a server in effective configuration is the trust decision; VC Desktop does not project remote schemas into Host capabilities or add per-tool action classes and confirmations. MCP connections begin only after a submitted Turn creates and binds an Agent Session, and the normal session shutdown path closes them.

Pi default Skill discovery is disabled. The resource loader receives only the dedicated VC Agent Skills Directory through a small path-containment Adapter. The Adapter resolves canonical paths, rejects symbolic-link or junction escapes, and does not admit user Pi, `.agents`, `.codex`, project, or Extension-contributed Skill roots. Skill availability is derived from valid directory contents and uses Pi's native metadata/progressive-disclosure behavior.

Ordinary Pi `bash`, `write`, and `edit` remain disabled. Host-owned Project, Thread, Memory, Output, Reflection, Dream, authorization, trajectory, and durable-commit Modules remain authoritative. The application remains lazy: browsing, settings, diagnostics, and migration do not create a Pi session, execute integrations, connect MCP, or invoke a Provider. Reload replaces or defers resource state at an idle/session boundary and never hot-mutates an Active Turn.

## Consequences

- Pi Extension and MCP documentation can be followed directly through ordinary directories, settings, and `mcp.json`.
- The Host no longer pretends to sandbox trusted Worker Extension code or to govern every remote MCP tool call.
- MCP context remains compact because the adapter exposes one proxy tool instead of every remote schema.
- Skills remain reusable while being isolated from all other coding-agent Skill roots.
- The former admission, Global Extension Revision, MCP schema/activation, and generic Skill activation state must be migrated and deleted rather than hidden behind a new Interface.
- Filesystem backups or source control replace application-level integration rollback.
- Extension code and configured MCP servers are trusted as a set and can access the Worker process authority; this is an intentional trust-model change and must be disclosed in settings.

## Supersedes

This ADR supersedes the conflicting Extension-governance portions of ADR-0034,
the controlled MCP path in ADR-0037, the MCP confirmation implication of
ADR-0042, and ADR-0055's requirement that Pi receive only app-generated
reviewed Extension snapshots. It also supersedes the corresponding Extension,
MCP, and generic Skill-management requirements in the earlier capability-reuse
and I5/I6 integration specifications.

ADR-0028 remains governing for the dedicated VC Agent Skills Directory.
ADR-0008 remains governing for Pi SDK integration, ADR-0054 remains governing
for lazy Agent Worker activation, and ADR-0055 remains governing for Host-owned
product state and durable commits outside the resource-discovery decision
changed here.
