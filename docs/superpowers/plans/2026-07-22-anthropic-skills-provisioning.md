# Anthropic Skills Provisioning

## Source

The four user-supplied packages are imported from the Anthropic Skills repository at the pinned revision:

- repository: `https://github.com/anthropics/skills.git`
- revision: `fa0fa64bdc967915dc8399e803be67759e1e62b8`
- packages: `docx`, `pptx`, `xlsx`, `skill-creator`

The package bytes are not vendored into this repository and are not bundled into the installer.

## Provisioning

Run the explicit provisioning command from the repository root:

```powershell
pnpm skills:provision:anthropic
```

The command clones the pinned revision when `--source-root` is omitted, copies each complete package into the app-owned Skills Directory, adds a Host-owned compatibility/provenance overlay, inspects the effective package, and activates only compatible revisions. A local clone can be supplied for offline or reviewable provisioning:

```powershell
pnpm skills:provision:anthropic -- --source-root C:\path\to\skills --skills-root C:\path\to\app-data\skills
```

The default Skills Directory is `%APPDATA%\Electron\skills` (or `VC_AGENT_SKILLS_ROOT` when set). The directory contains `inventory.json`, copied imports, overlays, active revisions, and bounded job staging data.

## Runtime behavior

The Desktop Host opens the app-owned directory at startup, projects only task-relevant active Skills into the immutable Worker/Pi resource snapshot, and reports imported/active Office Skills through Environment Doctor. It does not auto-import, auto-activate, install dependencies, or silently fall back to another package or Office engine.

The existing `OfficeSkillOrchestrator` and `SkillCreatorWorkflow` remain the execution seams: upstream `SKILL.md` packages are instruction/resource packages with scripts, not a single trusted vc-agent executable. A concrete isolated adapter must still be supplied for a real document-generation or Skill-creator job; fixture adapters remain test-only.

## Real Office runner contract

The Desktop Host does not guess an entry point from `SKILL.md` and does not fall back to a vc-agent-owned document engine. A real Office run is admitted only when `VC_AGENT_OFFICE_RUNNER` names an executable (optional JSON argument array in `VC_AGENT_OFFICE_RUNNER_ARGS`). The executable is started by the Utility Worker with no shell and receives one JSON manifest on stdin:

```json
{
  "schemaVersion": 1,
  "jobId": "office-...",
  "kind": "create | edit",
  "format": "docx | pptx | xlsx | pdf",
  "skillRevisionId": "<active revision>",
  "skillRoot": "<app-owned active package root>",
  "inputPaths": ["<source paths>"],
  "stagingDirectory": "<job staging root>",
  "outputPath": "<exact staged output>",
  "previewPath": "<optional exact preview>",
  "logPath": "<sanitized bounded runner log>",
  "cancellationToken": "<job cancellation token>",
  "timeoutMs": 300000,
  "maxOutputBytes": 100000000
}
```

The runner must write the declared output(s) and exit zero. The Worker enforces the staging boundary, timeout, cancellation, output bound, and a structural Office check (`%PDF-` for PDF or an OOXML ZIP containing `[Content_Types].xml` for DOCX/PPTX/XLSX). Missing runner/dependencies, malformed output, timeout, cancellation, and non-zero exit remain explicit failures; no alternate Skill, package revision, provider, or LibreOffice fallback is attempted.

For an end-to-end external evidence run, use `pnpm office:compat` with `--source-root`, `--runner`, and an evidence path outside the repository (or the corresponding `VC_AGENT_REAL_OFFICE_*` variables). The command provisions the pinned upstream package, executes create/edit/replace through `OfficeSkillOrchestrator`, and writes only sanitized metadata. It never commits the user package, document bytes, full paths, or runner logs.
