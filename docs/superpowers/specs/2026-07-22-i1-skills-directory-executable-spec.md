# I1 Skills Directory Executable Specification

Date: 2026-07-22  
Status: Approved for implementation  
Parent: `2026-07-22-integration-slice-spec-index.md`  
Blocked by: R1 complete

## Outcome

The User can explicitly import a complete Skill package into one isolated app-owned Skills Directory, inspect deterministic compatibility and package diffs, enable a validated revision, and activate only task-relevant instructions/resources without reading any live external Skill root.

## Non-goals

- No package marketplace, automatic discovery, update, dependency installation, remote import, repository bundling, or redistribution.
- No arbitrary Pi Extension admission; I6 owns executable Worker code trust.
- No custom Skill authoring engine; I3 reuses Skill Creator.
- No eager injection of all Skills into ordinary Turns.

## Governing Decisions

ADR 0028, 0034, 0036, 0048, 0050, 0054, 0055, 0057, and 0058.

## Directory Layout

```text
<app-data>/skills/
  imports/<import-id>/source/       # immutable copied candidate
  overlays/<package-id>/<revision>/ # Host-owned compatibility overlay
  active/<package-id>/<revision>/   # validated activation snapshot
  jobs/<job-id>/                    # bounded temporary staging
```

The root is created lazily only when the User opens Skills management or begins explicit import. External source paths are transient import inputs and MUST NOT be retained in inventory, backup, logs, Provider context, or active package metadata.

## Deep Modules And Interfaces

### `SkillPackageManager`

```ts
interface SkillPackageManager {
  importLocalDirectory(request: LocalSkillImport): Promise<SkillImportResult>;
  inspect(packageRevisionId: string): Promise<SkillCompatibilityReport>;
  activate(packageRevisionId: string): Promise<SkillActivationResult>;
  disable(packageId: string): Promise<SkillInventoryItem>;
  inventory(): SkillInventoryItem[];
}
```

The implementation owns staged complete-directory copy, canonical path containment, symlink handling, hashing, manifest/reference traversal, overlay application, activation snapshot creation, and atomic inventory commit. Callers cannot copy individual `SKILL.md` files or directly mutate `active/`.

### `SkillResourceProjector`

```ts
interface SkillResourceProjector {
  resolve(request: { task: string; scope: ExecutionScope; enabledSkillIds?: string[] }): SkillActivationDecision[];
  project(decisions: SkillActivationDecision[]): RuntimeSkillSnapshot;
}
```

The module deterministically selects relevant Skills, applies bounded instruction/resource limits, and returns a versioned Runtime Resource Snapshot contribution. It exposes no cognitive write capability and cannot widen execution scope.

## Required Behavior

| Requirement | Behavior |
| --- | --- |
| I1-REQ-001 | Opening ordinary Settings MUST NOT create or scan a Skills Directory; opening Skills management may create the empty app-owned root without Pi. |
| I1-REQ-002 | Import MUST copy the complete selected directory into staging before validation and MUST NOT follow the external source after copy. |
| I1-REQ-003 | Copy MUST reject escaping symlinks, path traversal, special devices, unreadable entries, cyclic references, and configured size/file-count limits. |
| I1-REQ-004 | Inventory MUST record package id, revision id, source kind only, import time, content hash, compatibility, declared dependencies, overlay revision, enabled state, and license presence. |
| I1-REQ-005 | Inspection MUST traverse `SKILL.md` references and report missing files, unsupported directives, undeclared executable dependencies, escaping paths, malformed metadata, and incompatible runtime assumptions. |
| I1-REQ-006 | Host-owned overlay SHOULD contain compatibility changes. Direct imported-package edits require a recorded exact diff and explicit User approval before activation. |
| I1-REQ-007 | Activation MUST atomically create an immutable content-addressed snapshot whose bytes match the inspected package plus approved overlay. |
| I1-REQ-008 | Skills MUST be disabled by default after import; inspection success does not activate them. |
| I1-REQ-009 | Runtime projection MUST include only task-relevant enabled Skills and bounded referenced resources at a Prompt Load Boundary. |
| I1-REQ-010 | Skill capabilities MUST remain behind Host authorization, Output Intent, Project scope, Provider Authorization, Access Mode, and Capability validation. |
| I1-REQ-011 | Skills MUST have no Project Memory, Long-term Memory, Reflection, Dream, Extension approval, Protected Credential, or state-migration write interface. |
| I1-REQ-012 | Backup MUST include active packages and overlays but exclude import source paths, secrets, caches, temporary jobs, and live external references. |
| I1-REQ-013 | Changed active bytes MUST invalidate activation and prevent projection until reinspection and explicit activation. |
| I1-REQ-014 | Import, inspection, inventory, disablement, and backup MUST start no Worker, Pi session, or Provider request. |

## Package State Machine

```text
copying -> copied -> inspecting -> compatible | incompatible | blocked
compatible -> awaiting_activation -> active -> disabled
active -- byte/overlay change --> invalidated
invalidated -> inspecting
copying/inspecting -> failed
```

Only `active` revisions enter Runtime Resource Snapshots. Restart resumes no copy or inspection automatically; incomplete staging is shown as failed/abandoned and may be removed explicitly.

## Persistence And Migration

Persist `skill_packages`, `skill_revisions`, `skill_dependencies`, `skill_compatibility_findings`, and `skill_activation_revisions`. Store relative app-owned paths and hashes, never external source paths. Inventory commits and active snapshot renames are atomic. Unsupported newer inventory schema enters read-only Skills inspection without activation or import.

## UI

- Settings → Skills shows empty, importing, inspection, compatible, blocked, active, disabled, and invalidated states.
- Import is an explicit local directory picker followed by a review showing package identity, files, dependencies, license, findings, overlay, and diff.
- Enable/disable is separate from import. Standard and Full Access both retain explicit activation because it changes model behavior; Full Access does not silently enable.
- Runtime tool activity identifies producing Skill and revision without exposing imported source location.

## Failure Codes

`SKILL_COPY_FAILED`, `SKILL_PACKAGE_TOO_LARGE`, `SKILL_PATH_ESCAPE`, `SKILL_REFERENCE_MISSING`, `SKILL_METADATA_INVALID`, `SKILL_DIRECTIVE_UNSUPPORTED`, `SKILL_DEPENDENCY_UNDECLARED`, `SKILL_OVERLAY_CONFLICT`, `SKILL_HASH_MISMATCH`, `SKILL_ACTIVATION_INVALIDATED`, and `SKILL_RESOURCE_LIMIT_EXCEEDED`.

## Test Traceability

| Test | Requirements | Assertion |
| --- | --- | --- |
| I1-T-001 Lazy root | 001, 014 | Launch/general settings cause no directory, Worker, or Pi; Skills view creates only empty root. |
| I1-T-002 Complete import | 002, 004 | Nested scripts/resources/license are copied and inventoried; source can be removed afterward. |
| I1-T-003 Path safety | 003, 005 | Escaping symlink/traversal/cycle/limit fixtures block. |
| I1-T-004 Compatibility | 005, 006 | Missing reference and unsupported directive surface; overlay produces reviewable diff. |
| I1-T-005 Activation | 007, 008, 013 | Import stays disabled; explicit activation projects exact hash; changed bytes invalidate. |
| I1-T-006 Task projection | 009, 010, 011 | Relevant Skill only; unrelated Turn size unchanged; forbidden capabilities absent. |
| I1-T-007 Backup/restart | 012, 014 | Active package restores; no source path/job payload; no eager runtime. |
| I1-T-008 Migration | 004, 007 | Older inventory migrates atomically; newer schema cannot activate. |

## Implementation Order

1. Define contracts, storage records, limits, and fixture packages.
2. Implement staged copier and deterministic inspector through `SkillPackageManager` interface tests.
3. Implement overlay/diff and immutable activation.
4. Add Skills UI, Environment Doctor inventory, and backup integration.
5. Implement task activation and Runtime Resource Snapshot projection.
6. Add migration, restart, security, and E2E coverage.

## Definition Of Done And Decision Gate

All I1 requirements pass; no production code reads a live Claude Code/Codex/Pi Skill root; no active package can bypass the Resource Snapshot or Capability Gateway. Do not begin I2 until a fixture package with scripts and resources survives source deletion, restart, activation, and task-scoped projection.
