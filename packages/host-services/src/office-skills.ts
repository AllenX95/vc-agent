import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  VcSkillsDirectoryAdapter,
  type VcSkillMetadata,
  type VcSkillImportResult
} from "./vc-skills-directory.js";

/** Office formats supported by the optional local provisioning helper. */
export const USER_OFFICE_SKILL_FORMATS = ["docx", "pptx", "xlsx"] as const;
export type UserOfficeSkillFormat = (typeof USER_OFFICE_SKILL_FORMATS)[number];

export interface ProvisionedUserOfficeSkill {
  readonly packageId: UserOfficeSkillFormat;
  readonly sourceDirectory: string;
  readonly destinationPath: string;
  readonly skill: VcSkillMetadata;
  readonly skillHash: string;
  readonly imported: VcSkillImportResult;
}

export type VcSkillDirectorySource = VcSkillsDirectoryAdapter | { readonly root: string };

export interface ProvisionUserOfficeSkillsInput {
  readonly sourceRoot: string;
  readonly skills: VcSkillDirectorySource;
  readonly packageIds?: readonly UserOfficeSkillFormat[];
}

/**
 * Copy complete, user-selected local Office Skill packages into the
 * dedicated VC Agent Skills Directory. The source is not rewritten and no
 * compatibility overlay, activation record, revision, or projector is made.
 */
export async function provisionUserOfficeSkills(input: ProvisionUserOfficeSkillsInput): Promise<readonly ProvisionedUserOfficeSkill[]> {
  const skills = asAdapter(input.skills);
  const sourceRoot = resolve(input.sourceRoot);
  const selected = new Set(input.packageIds ?? USER_OFFICE_SKILL_FORMATS);
  const results: ProvisionedUserOfficeSkill[] = [];
  for (const packageId of USER_OFFICE_SKILL_FORMATS) {
    if (!selected.has(packageId)) continue;
    const sourceDirectory = findLocalPackageDirectory(sourceRoot, packageId);
    if (sourceDirectory === undefined) throw new Error(`SKILL_SOURCE_MISSING:${packageId}`);

    // A valid destination already represents an available Skill. Do not
    // silently replace user edits; callers can remove it explicitly before
    // importing a new source.
    const existing = skills.discover().skills.find((skill) => skill.name === packageId);
    const imported = existing === undefined
      ? skills.importSkill({ sourceDirectory, destinationName: packageId })
      : {
          destinationPath: existing.baseDir,
          files: [],
          skills: [existing],
          diagnostics: []
        } satisfies VcSkillImportResult;
    const skill = imported.skills.find((candidate) => candidate.name === packageId);
    if (skill === undefined) throw new Error(`SKILL_PACKAGE_INCOMPATIBLE:${packageId}`);
    const skillHash = hashFile(join(skill.baseDir, "SKILL.md"));
    results.push({ packageId, sourceDirectory, destinationPath: imported.destinationPath, skill, skillHash, imported });
  }
  return results;
}

export function isUserOfficeSkillPackage(packageId: string): packageId is UserOfficeSkillFormat {
  return (USER_OFFICE_SKILL_FORMATS as readonly string[]).includes(packageId);
}

function asAdapter(source: VcSkillDirectorySource | undefined): VcSkillsDirectoryAdapter {
  if (source === undefined) throw new Error("VC_SKILLS_DIRECTORY_REQUIRED");
  if (source instanceof VcSkillsDirectoryAdapter) return source;
  return new VcSkillsDirectoryAdapter({ root: source.root });
}

function findLocalPackageDirectory(sourceRoot: string, packageId: UserOfficeSkillFormat): string | undefined {
  const candidates = [join(sourceRoot, "skills", packageId), join(sourceRoot, packageId)];
  const nested = candidates.find((candidate) => existsSync(join(candidate, "SKILL.md")));
  if (nested !== undefined) return nested;
  return basename(sourceRoot).toLowerCase() === packageId && existsSync(join(sourceRoot, "SKILL.md")) ? sourceRoot : undefined;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
