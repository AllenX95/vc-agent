# User-Supplied Local Office Skill Provisioning

## Source boundary

Office skill packages are optional user-supplied inputs. The repository and installer contain no Office skill package bytes, vendor URL, pinned source revision, or automatic download path.

The provisioning helper accepts only an explicit local source directory supplied by the user. The source may contain packages at `skills/<format>/` or `<format>/`, for example `docx`, `pptx`, and `xlsx`.

## Provisioning

Run the explicit local-only provisioning command from the repository root:

```powershell
pnpm skills:provision:office -- --source-root C:\path\to\skills --skills-root C:\path\to\app-data\skills
```

Use `--skills docx` (or a comma-separated list) to select formats. Omitting `--source-root` fails; the command does not clone, fetch, install, or read another agent's live Skill directory.

The default Skills Directory is `%LOCALAPPDATA%\vc-agent\skills` on Windows (or the platform app-data directory under `vc-agent`; `VC_AGENT_SKILLS_ROOT` remains an explicit override). The directory contains `inventory.json`, copied imports, overlays, active revisions, and bounded job staging data.

## Runtime behavior

The Desktop Host opens the app-owned directory at startup, projects only task-relevant active Skills into the immutable Worker/Pi resource snapshot, and reports imported/active Office Skills through Environment Doctor. It does not auto-import, auto-activate, install dependencies, or silently fall back to another package or Office engine.

The `OfficeSkillOrchestrator` remains the execution seam: imported `SKILL.md` packages are instruction/resource packages with scripts, not trusted vc-agent executables. A concrete isolated adapter must still be supplied for a real document-generation job; fixture adapters remain test-only.

## Real Office runner contract

The Desktop Host does not guess an entry point from `SKILL.md` and does not fall back to a vc-agent-owned document engine. A real Office run is admitted only when `VC_AGENT_OFFICE_RUNNER` names an executable (optional JSON argument array in `VC_AGENT_OFFICE_RUNNER_ARGS`). The executable is started by the Utility Worker with no shell and receives one JSON manifest on stdin.

The runner must write the declared output(s) and exit zero. The Worker enforces the staging boundary, timeout, cancellation, output bound, and a structural Office check (`%PDF-` for PDF or an OOXML ZIP containing `[Content_Types].xml` for DOCX/PPTX/XLSX). Missing runner/dependencies, malformed output, timeout, cancellation, and non-zero exit remain explicit failures; no alternate Skill, package revision, provider, or document engine fallback is attempted.

For an end-to-end external evidence run, use `pnpm office:compat` with `--source-root`, `--runner`, and an evidence path outside the repository (or the corresponding `VC_AGENT_REAL_OFFICE_*` variables). The command imports the explicitly supplied local package, executes create/edit/replace through `OfficeSkillOrchestrator`, and records only sanitized metadata and a source content hash.
