import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { SkillPackageManager, type SkillCompatibilityReport, type SkillImportResult, type SkillInventoryItem } from "./skills-directory.js";

/**
 * Office skill formats supported by the optional local provisioning helper.
 * The helper intentionally has no vendor URL, revision, or bundled package
 * bytes. The caller must provide the source directory explicitly.
 */
export const USER_OFFICE_SKILL_FORMATS = ["docx", "pptx", "xlsx"] as const;
export type UserOfficeSkillFormat = (typeof USER_OFFICE_SKILL_FORMATS)[number];

const OFFICE_SKILL_METADATA: Readonly<Record<UserOfficeSkillFormat, { readonly keywords: readonly string[]; readonly dependencies: readonly string[] }>> = {
  docx: { keywords: ["word", "docx", "dotx", "wordprocessing", "document"], dependencies: ["docx", "pandoc", "soffice", "pdftoppm"] },
  pptx: { keywords: ["pptx", "potx", "slide", "slides", "deck", "presentation"], dependencies: ["pptxgenjs", "markitdown", "python", "soffice", "pdftoppm"] },
  xlsx: { keywords: ["xlsx", "xlsm", "xltx", "csv", "tsv", "spreadsheet", "workbook"], dependencies: ["openpyxl", "pandas", "markitdown", "python", "soffice"] }
};

export interface ProvisionedUserOfficeSkill {
  readonly packageId: UserOfficeSkillFormat;
  readonly sourceDirectory: string;
  readonly imported: SkillImportResult;
  readonly overlay: SkillInventoryItem;
  readonly report: SkillCompatibilityReport;
}

export interface ProvisionUserOfficeSkillsInput {
  readonly sourceRoot: string;
  readonly manager: SkillPackageManager;
  readonly packageIds?: readonly UserOfficeSkillFormat[];
  readonly skipActive?: boolean;
}

/**
 * Import complete, user-selected local Office skill packages and apply only a
 * Host-owned compatibility/provenance overlay. No network access or package
 * installation is performed by this function.
 */
export async function provisionUserOfficeSkills(input: ProvisionUserOfficeSkillsInput): Promise<readonly ProvisionedUserOfficeSkill[]> {
  const sourceRoot = resolve(input.sourceRoot);
  const selected = new Set(input.packageIds ?? USER_OFFICE_SKILL_FORMATS);
  const results: ProvisionedUserOfficeSkill[] = [];
  for (const packageId of USER_OFFICE_SKILL_FORMATS) {
    if (!selected.has(packageId)) continue;
    const sourceDirectory = findLocalPackageDirectory(sourceRoot, packageId);
    if (sourceDirectory === undefined) throw new Error(`SKILL_SOURCE_MISSING:${packageId}`);
    const imported = await input.manager.importLocalDirectory({ sourceDirectory, packageId, sourceKind: "local_directory" });
    const skillMarkdown = readFileSync(join(imported.stagedPath, "SKILL.md"), "utf8");
    const metadata = OFFICE_SKILL_METADATA[packageId];
    const overlay = await input.manager.setOverlay(imported.package.revisionId, {
      "SKILL.md": addCompatibilityMetadata(skillMarkdown, metadata.keywords, metadata.dependencies, packageId),
      "vc-agent-source.json": JSON.stringify({
        schemaVersion: 1,
        sourceKind: "user_supplied_local",
        packageId,
        formats: [packageId]
      }, null, 2) + "\n"
    });
    const report = await input.manager.inspect(overlay.revisionId);
    if (report.status !== "compatible") throw new Error(`SKILL_PACKAGE_INCOMPATIBLE:${packageId}`);
    if (input.skipActive !== true) await input.manager.activate(overlay.revisionId);
    const active = input.manager.getRevision(overlay.revisionId);
    if (active === undefined) throw new Error(`SKILL_REFERENCE_MISSING:${packageId}`);
    results.push({ packageId, sourceDirectory, imported, overlay: active, report });
  }
  return results;
}

export function isUserOfficeSkillPackage(packageId: string): packageId is UserOfficeSkillFormat {
  return (USER_OFFICE_SKILL_FORMATS as readonly string[]).includes(packageId);
}

function findLocalPackageDirectory(sourceRoot: string, packageId: UserOfficeSkillFormat): string | undefined {
  const candidates = [join(sourceRoot, "skills", packageId), join(sourceRoot, packageId)];
  const nested = candidates.find((candidate) => existsSync(join(candidate, "SKILL.md")));
  if (nested !== undefined) return nested;
  return basename(sourceRoot).toLowerCase() === packageId && existsSync(join(sourceRoot, "SKILL.md")) ? sourceRoot : undefined;
}

function addCompatibilityMetadata(content: string, keywords: readonly string[], dependencies: readonly string[], packageId: string): string {
  if (!content.startsWith("---")) throw new Error(`SKILL_METADATA_INVALID:${packageId}`);
  const end = content.indexOf("\n---", 3);
  if (end < 0) throw new Error(`SKILL_METADATA_INVALID:${packageId}`);
  const frontMatter = content.slice(3, end);
  const existing = new Set(frontMatter.split(/\r?\n/u).map((line) => /^\s*([A-Za-z0-9_-]+)\s*:/u.exec(line)?.[1]?.toLowerCase()).filter((key): key is string => key !== undefined));
  const additions = [
    ...(existing.has("keywords") ? [] : [`keywords: ${keywords.join(", ")}`]),
    ...(existing.has("dependencies") ? [] : [`dependencies: ${dependencies.join(", ")}`]),
    ...(existing.has("executables") ? [] : ["executables: py"])
  ];
  return additions.length === 0 ? content : content.slice(0, end) + "\n" + additions.join("\n") + content.slice(end);
}
