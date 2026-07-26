# External MCP compatibility evidence

`pnpm mcp:compat` is the only supported local smoke path for the real MCP gate. It starts a user-supplied stdio server through the pinned `pi-mcp-adapter@1.5.1`, discovers schemas only during explicit Test Connection, exercises a read tool, exercises a write tool with scoped confirmation, restarts the Host manager, and writes only a small sanitized evidence file outside the repository.

The command does not use the repository fixture server and does not export tool results, arguments, credentials, server logs, or full command lines.

Required inputs:

- `VC_AGENT_REAL_MCP_COMMAND` (or `--command`)
- `VC_AGENT_REAL_MCP_EVIDENCE` (or `--evidence`, an external path)
- `VC_AGENT_REAL_MCP_READ_TOOL` (or `--read-tool`)
- `VC_AGENT_REAL_MCP_WRITE_TOOL` (or `--write-tool`)

Optional JSON inputs:

- `VC_AGENT_REAL_MCP_ARGS`
- `VC_AGENT_REAL_MCP_READ_ARGUMENTS`
- `VC_AGENT_REAL_MCP_WRITE_ARGUMENTS`

Example:

```powershell
$env:VC_AGENT_REAL_MCP_COMMAND = "node"
$env:VC_AGENT_REAL_MCP_ARGS = '["C:\\path\\to\\your-mcp-server.mjs"]'
$env:VC_AGENT_REAL_MCP_READ_TOOL = "search"
$env:VC_AGENT_REAL_MCP_WRITE_TOOL = "update"
$env:VC_AGENT_REAL_MCP_READ_ARGUMENTS = '{"query":"compatibility"}'
$env:VC_AGENT_REAL_MCP_WRITE_ARGUMENTS = '{"value":1}'
$env:VC_AGENT_REAL_MCP_EVIDENCE = "C:\\vc-agent-evidence\\mcp-compatibility.json"
pnpm mcp:compat
```

The selected write tool must be classified as write-capable by the live schema/name policy. The evidence is accepted by G3-T-011 only when it contains all three workflows (`lazy-read`, `confirmed-write`, `restart`), has the pinned adapter revision, is marked sanitized, and lives outside the repository. A fixture run is useful for adapter tests but must not be copied into the external evidence path to close the real dependency gate.
