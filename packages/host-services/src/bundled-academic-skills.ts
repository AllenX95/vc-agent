import { existsSync } from "node:fs";
import { join } from "node:path";
import { VcSkillsDirectoryAdapter, type VcSkillMetadata, type VcSkillsDirectoryAdapterOptions } from "./vc-skills-directory.js";

export const BUNDLED_ACADEMIC_SKILL_IDS = [
  "paper-technical-diligence",
  "founder-academic-diligence",
  "technical-claim-verification",
  "novelty-and-prior-art-map",
  "research-to-company-map",
  "arxiv-fulltext-reader"
] as const;

export type BundledAcademicSkillId = typeof BUNDLED_ACADEMIC_SKILL_IDS[number];

/**
 * Result of copying the reviewed academic Skill directories into the one
 * dedicated VC Agent Skills Directory.
 */
export interface BundledAcademicSkillInstallResult {
  readonly installed: readonly VcSkillMetadata[];
  readonly imported: readonly BundledAcademicSkillId[];
}

export type VcSkillDirectorySource = VcSkillsDirectoryAdapter | { readonly root: string };

export interface BundledAcademicSkillInstallInput {
  readonly sourceRoot: string;
  readonly skills: VcSkillDirectorySource;
}

/**
 * Copy bundled academic Skills into the dedicated directory.
 *
 * Presence in the directory is availability; no package revision, inspect,
 * activation, overlay, or projection state is created. Re-running the
 * installer is idempotent for already valid destinations.
 */
export async function installBundledAcademicSkills(input: BundledAcademicSkillInstallInput): Promise<BundledAcademicSkillInstallResult> {
  const skills = asAdapter(input.skills);
  for (const packageId of BUNDLED_ACADEMIC_SKILL_IDS) {
    if (!existsSync(join(input.sourceRoot, packageId, "SKILL.md"))) throw new Error(`BUNDLED_ACADEMIC_SKILL_MISSING:${packageId}`);
  }

  const imported: BundledAcademicSkillId[] = [];
  for (const packageId of BUNDLED_ACADEMIC_SKILL_IDS) {
    const current = skills.discover().skills.find((skill) => skill.name === packageId);
    if (current !== undefined) continue;
    const result = skills.importSkill({ sourceDirectory: join(input.sourceRoot, packageId), destinationName: packageId });
    const installed = result.skills.find((skill) => skill.name === packageId);
    if (installed === undefined) throw new Error(`BUNDLED_ACADEMIC_SKILL_INCOMPATIBLE:${packageId}`);
    imported.push(packageId);
  }

  const installed = skills.discover().skills.filter((skill) => BUNDLED_ACADEMIC_SKILL_IDS.includes(skill.name as BundledAcademicSkillId));
  if (installed.length !== BUNDLED_ACADEMIC_SKILL_IDS.length) {
    const missing = BUNDLED_ACADEMIC_SKILL_IDS.find((packageId) => !installed.some((skill) => skill.name === packageId));
    throw new Error(`BUNDLED_ACADEMIC_SKILL_INCOMPATIBLE:${missing ?? "unknown"}`);
  }
  return { installed, imported };
}

function asAdapter(source: VcSkillDirectorySource | undefined): VcSkillsDirectoryAdapter {
  if (source === undefined) throw new Error("VC_SKILLS_DIRECTORY_REQUIRED");
  if (source instanceof VcSkillsDirectoryAdapter) return source;
  const options: VcSkillsDirectoryAdapterOptions = { root: source.root };
  return new VcSkillsDirectoryAdapter(options);
}
