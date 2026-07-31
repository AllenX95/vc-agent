import { existsSync } from "node:fs";
import { join } from "node:path";
import { SkillPackageManager, type SkillInventoryItem } from "./skills-directory.js";

export const BUNDLED_ACADEMIC_SKILL_IDS = [
  "paper-technical-diligence",
  "founder-academic-diligence",
  "technical-claim-verification",
  "novelty-and-prior-art-map",
  "research-to-company-map"
] as const;

export type BundledAcademicSkillId = typeof BUNDLED_ACADEMIC_SKILL_IDS[number];

export interface BundledAcademicSkillInstallResult {
  readonly installed: readonly SkillInventoryItem[];
  readonly activated: readonly BundledAcademicSkillId[];
}

export async function installBundledAcademicSkills(input: {
  readonly manager: SkillPackageManager;
  readonly sourceRoot: string;
}): Promise<BundledAcademicSkillInstallResult> {
  for (const packageId of BUNDLED_ACADEMIC_SKILL_IDS) {
    if (!existsSync(join(input.sourceRoot, packageId, "SKILL.md"))) throw new Error(`BUNDLED_ACADEMIC_SKILL_MISSING:${packageId}`);
  }

  const activated: BundledAcademicSkillId[] = [];
  for (const packageId of BUNDLED_ACADEMIC_SKILL_IDS) {
    const imported = await input.manager.importLocalDirectory({
      sourceDirectory: join(input.sourceRoot, packageId),
      packageId,
      sourceKind: "bundled_reviewed"
    });
    const current = input.manager.getRevision(imported.package.revisionId);
    if (current?.enabled && current.state === "active") continue;
    const report = await input.manager.inspect(imported.package.revisionId);
    if (report.status !== "compatible") throw new Error(`BUNDLED_ACADEMIC_SKILL_INCOMPATIBLE:${packageId}`);
    await input.manager.activate(imported.package.revisionId);
    activated.push(packageId);
  }

  return {
    installed: input.manager.inventory().filter((item) => BUNDLED_ACADEMIC_SKILL_IDS.includes(item.packageId as BundledAcademicSkillId)),
    activated
  };
}
