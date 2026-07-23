# I5 MCP Adapter Executable Specification

Date: 2026-07-22  
Status: Approved for implementation  
Parent: `2026-07-22-integration-slice-spec-index.md`  
Blocked by: R1 and Capability Gateway

## Outcome

VC Desktop uses one reviewed, pinned `pi-mcp-adapter` to lazily connect explicitly configured MCP servers. The Host owns configuration, credential references, activation, scope, authorization, bounded results, and visible provenance; ordinary Turns carry no MCP schemas unless the task activates them.

## Non-goals

- No second native MCP client, direct Renderer/Host protocol implementation, import from another Agent's config, eager connection, automatic OAuth, server fallback, or all-tools injection.
- Sampling, elicitation, MCP Apps, server-initiated actions, local-file upload, and direct tools are disabled unless explicitly configured by a future accepted requirement within the same permission model.

## Governing Decisions

ADR 0037, 0042, 0048, 0055, 0056, R1, and Capability Gateway.

## Deep Modules And Interfaces

### `McpIntegrationManager`

```ts
interface McpIntegrationManager {
  configure(request: McpServerConfigurationRequest): Promise<McpServerRecord>;
  inventory(): McpServerStatus[];
  resolveActivation(request: McpActivationRequest): Promise<McpActivationDecision>;
  execute(request: McpProxyExecutionRequest): Promise<CapabilityExecutionResult>;
  disconnect(serverId: string): Promise<void>;
  shutdown(): Promise<void>;
}
```

The module hides adapter lifecycle, metadata cache, connection state, schema normalization, output bounding, credential resolution, scope/permission mapping, disconnect, and restart behavior. Production uses the pinned Pi adapter; tests use a fixture adapter at the same internal seam.

## Server Configuration

Persist non-secret server id/name, transport, endpoint/command metadata permitted by Access Mode, credential reference, enabled capabilities, authorization scope, adapter version, metadata cache revision, and last sanitized status. Secrets and OAuth tokens remain in the OS-protected credential adapter.

Viewing status MUST read local records/cache only. Test Connection is an explicit Host action and does not inject tools into a Turn.

## Required Behavior

| Requirement | Behavior |
| --- | --- |
| I5-REQ-001 | MCP protocol execution MUST occur only through the pinned `pi-mcp-adapter`; no Renderer, Host, Agent, or alternate client bypass exists. |
| I5-REQ-002 | Configuration and Settings inspection MUST NOT connect; connection occurs only for explicit Test Connection or admitted task activation. |
| I5-REQ-003 | Ordinary Runtime Resource Snapshots MUST contain no MCP tool schemas or server metadata unless deterministic task preactivation or an accepted Capability Activation Request selects them. |
| I5-REQ-004 | Activation MUST select a bounded server/tool subset and freeze schema/cache revision for the Turn. |
| I5-REQ-005 | Read results MUST carry server/tool provenance, truncation/retirement metadata, content type, size, and stable context reference. |
| I5-REQ-006 | Large MCP payloads MUST retire after the Turn under ADR 0056 and be re-retrievable by authoritative reference when permitted. |
| I5-REQ-007 | Writes, external submission, sampling, elicitation, local-file upload, OAuth/credential expansion, and permission expansion MUST cross Host authorization. |
| I5-REQ-008 | Standard Access requires scoped confirmation for protected actions; Full Access suppresses eligible prompts but cannot widen configured server, tool, Project, or submission scope. |
| I5-REQ-009 | Unscoped Threads MUST receive no Project path/file/state merely because a server is configured or activated. |
| I5-REQ-010 | Credential values MUST never enter configuration export, Thread Trajectory, logs, model-visible result, or UI; only references and sanitized status persist. |
| I5-REQ-011 | Server failure, timeout, disconnect, schema mismatch, adapter failure, or Provider Failure MUST NOT switch server/client/tool/Provider or retry automatically. |
| I5-REQ-012 | App restart MUST reconnect to no server and start no Worker/Pi; stale connection state becomes disconnected while cached metadata remains explicitly stale/last-known. |
| I5-REQ-013 | Server/tool, activation reason, duration, bounded bytes, truncation, disconnect, and sanitized failure counts MUST be locally observable. |

## Lifecycle State Machine

```text
unconfigured -> configured(disconnected)
configured -> testing -> disconnected | unavailable
configured -> activating -> connected -> executing -> connected
connected -> idle_timeout/manual_disconnect/shutdown -> disconnected
any_connected_state -> failed -> disconnected
restart -> disconnected
```

Schema state is `unknown | cached | current_for_connection | mismatched`. A mismatch blocks the affected tool activation until explicit refresh/review; it does not silently accept changed write semantics.

## Activation And Capability Mapping

- Deterministic preactivation may use explicit server/tool mentions or an exact configured task rule; ambiguous discovery requires a Capability Activation Request visible to the User.
- Adapter tools map to Host capability metadata: side-effect class, allowed scopes, credential use, external submission, input/output bounds, and confirmation policy.
- MCP server instructions cannot override VC system policy, activate other servers, grant filesystem access, or commit Host state.

## UI And Environment Doctor

- Settings → MCP lists configured servers, pinned adapter version, disconnected/connected/unavailable state, credential-reference presence, cache age, enabled capability classes, and sanitized failures.
- Add/Edit Server validates without connecting; Test Connection is explicit and cancellable.
- Conversation tool activity shows server/tool, activation reason, read/write class, confirmation, truncation, and provenance.
- Doctor verifies adapter integrity and configuration shape only; it does not connect.

## Failure Codes

`MCP_ADAPTER_UNAVAILABLE`, `MCP_SERVER_CONFIGURATION_INVALID`, `MCP_CREDENTIAL_UNAVAILABLE`, `MCP_CONNECTION_FAILED`, `MCP_TIMEOUT`, `MCP_DISCONNECTED`, `MCP_SCHEMA_MISMATCH`, `MCP_TOOL_INACTIVE`, `MCP_SCOPE_REJECTED`, `MCP_ACTION_REJECTED`, `MCP_RESULT_TOO_LARGE`, and `UNKNOWN_TOOL_OUTCOME`.

## Test Traceability

| Test | Requirements | Assertion |
| --- | --- | --- |
| I5-T-001 Lazy configuration | 001, 002, 012 | View/edit/restart makes zero fixture connections and no Pi. |
| I5-T-002 Task activation | 003, 004 | Unrelated Turn has no schema; exact task activates bounded subset. |
| I5-T-003 Bounded read | 005, 006 | Provenance and truncation present; payload retires next Turn. |
| I5-T-004 Standard write | 007, 008 | Denial sends nothing; approval sends exact scoped action. |
| I5-T-005 Full write | 008 | No prompt but no scope expansion; activity remains visible. |
| I5-T-006 Unscoped isolation | 009, 010 | No Project path/state/secret appears in request or result. |
| I5-T-007 Failure matrix | 011 | Timeout/disconnect/schema change has no fallback or retry. |
| I5-T-008 Credential/log hygiene | 010, 013 | Secret absent from state, logs, trajectory, UI, and telemetry. |
| I5-T-009 Shutdown | 012 | Active connection closes and does not reconnect on launch. |

## Implementation Order

1. Pin/review adapter revision and define server/config/status contracts.
2. Implement Host configuration and protected credential references without connection.
3. Add adapter lifecycle and fixture server through `McpIntegrationManager` interface tests.
4. Add activation projection, Capability Gateway mapping, bounded results, and retirement.
5. Add Settings/Doctor, migration, failure, shutdown, and E2E coverage.

## Definition Of Done And Decision Gate

All requirements pass against a fixture server and pinned adapter. Stop if integration requires a second client, eager schema loading, direct secret exposure, or bypassing the Host Capability Gateway for protected MCP behavior.
