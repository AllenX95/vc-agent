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
