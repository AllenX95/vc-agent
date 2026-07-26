# Personal Build Gate evidence

The deterministic runner is `pnpm personal-build-gate`. It never starts a Provider, MCP server, OCR model, or Office runner. It reports `blocked` when those external paths or packaged lifecycle evidence are absent. The release runner consumes validated external evidence and returns non-zero unless the decision is `pass`.

To collect the packaged lifecycle bundle used by H1-REQ-007, 011, 018, and 019:

```powershell
$env:VC_AGENT_PYTHON = "C:\\path\\to\\utility-worker-parser-python.exe"
$env:VC_AGENT_H1_PACKAGED_EVIDENCE = "C:\\vc-agent-evidence\\h1-packaged.json"
pnpm h1:packaged
pnpm personal-build-gate
```

`h1:packaged` builds the Desktop artifacts, runs only the bounded Electron suites for process cancellation, external-edit refresh, cognition backup/restore, and single-instance locking, and writes sanitized metadata outside the repository. It does not copy traces, screenshots, project content, credentials, or test output bodies.

For the current build, the required external evidence has been supplied outside the repository: Microsoft Word, local OCR, vc-agent-owned filesystem MCP, D1 Provider-backed child sessions, and the packaged lifecycle bundle. The final command is:

```powershell
pnpm integration-gate:release
pnpm personal-build-gate:release
```

Both commands currently return `pass`. Re-running from a new machine requires re-supplying the evidence paths; missing evidence must remain `blocked` rather than being replaced by a fixture.
