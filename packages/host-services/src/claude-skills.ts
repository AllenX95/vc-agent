import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SkillPackageManager, type SkillImportResult, type SkillInventoryItem, type SkillCompatibilityReport } from "./skills-directory.js";

/**
 * Pinned, user-supplied source metadata for the Anthropic Skills repository.
 * The repository contents are deliberately not part of vc-agent's source tree
 * or installer; provisioning copies them into the app-owned Skills Directory.
 */
export const ANTHROPIC_SKILLS_SOURCE = {
  repository: "https://github.com/anthropics/skills.git",
  revision: "fa0fa64bdc967915dc8399e803be67759e1e62b8",
  skills: [
    {
      packageId: "docx",
      sourcePath: "skills/docx",
      formats: ["docx"] as const,
      keywords: ["word", "docx", "dotx", "wordprocessing", "document"] as const,
      dependencies: ["docx", "pandoc", "soffice", "pdftoppm"] as const
    },
    {
      packageId: "pptx",
      sourcePath: "skills/pptx",
      formats: ["pptx"] as const,
      keywords: ["pptx", "potx", "slide", "slides", "deck", "presentation"] as const,
      dependencies: ["pptxgenjs", "markitdown", "python", "soffice", "pdftoppm"] as const
    },
    {
      packageId: "xlsx",
      sourcePath: "skills/xlsx",
      formats: ["xlsx"] as const,
      keywords: ["xlsx", "xlsm", "xltx", "csv", "tsv", "spreadsheet", "workbook"] as const,
      dependencies: ["openpyxl", "pandas", "markitdown", "python", "soffice"] as const
    },
    {
      packageId: "skill-creator",
      sourcePath: "skills/skill-creator",
      formats: [] as const,
      keywords: ["skill", "skill-creator", "creator", "eval", "benchmark"] as const,
      dependencies: ["python", "claude"] as const
    }
  ] as const
} as const;

export type AnthropicSkillPackageId = (typeof ANTHROPIC_SKILLS_SOURCE.skills)[number]["packageId"];

export interface ProvisionedAnthropicSkill {
  readonly packageId: AnthropicSkillPackageId;
  readonly sourceDirectory: string;
  readonly imported: SkillImportResult;
  readonly overlay: SkillInventoryItem;
  readonly report: SkillCompatibilityReport;
}

export interface ProvisionAnthropicSkillsInput {
  readonly sourceRoot: string;
  readonly manager: SkillPackageManager;
  readonly packageIds?: readonly AnthropicSkillPackageId[];
  readonly skipActive?: boolean;
}

/**
 * Imports complete upstream packages and applies only a Host-owned metadata
 * overlay. It never edits the source package; activation is controlled by the
 * explicit provisioning call (`skipActive` is available for review-only flow).
 */
export async function provisionAnthropicSkills(input: ProvisionAnthropicSkillsInput): Promise<readonly ProvisionedAnthropicSkill[]> {
  const sourceRoot = resolve(input.sourceRoot);
  const selected = new Set(input.packageIds ?? ANTHROPIC_SKILLS_SOURCE.skills.map((skill) => skill.packageId));
  const results: ProvisionedAnthropicSkill[] = [];
  for (const definition of ANTHROPIC_SKILLS_SOURCE.skills) {
    if (!selected.has(definition.packageId)) continue;
    const sourceDirectory = join(sourceRoot, definition.sourcePath);
    if (!existsSync(sourceDirectory)) throw new Error(`SKILL_SOURCE_MISSING:${definition.packageId}`);
    const imported = await input.manager.importLocalDirectory({ sourceDirectory, packageId: definition.packageId, sourceKind: "local_directory" });
    const skillMarkdown = readFileSync(join(imported.stagedPath, "SKILL.md"), "utf8");
    const overlay = await input.manager.setOverlay(imported.package.revisionId, {
      "SKILL.md": addCompatibilityMetadata(skillMarkdown, definition.keywords, definition.dependencies, definition.packageId),
      "vc-agent-source.json": JSON.stringify({
        schemaVersion: 1,
        source: ANTHROPIC_SKILLS_SOURCE.repository,
        revision: ANTHROPIC_SKILLS_SOURCE.revision,
        packageId: definition.packageId,
        formats: definition.formats
      }, null, 2) + "\n"
    });
    const report = await input.manager.inspect(overlay.revisionId);
    if (report.status !== "compatible") throw new Error(`SKILL_PACKAGE_INCOMPATIBLE:${definition.packageId}`);
    if (input.skipActive !== true) await input.manager.activate(overlay.revisionId);
    const active = input.manager.getRevision(overlay.revisionId);
    if (active === undefined) throw new Error(`SKILL_REFERENCE_MISSING:${definition.packageId}`);
    results.push({ packageId: definition.packageId, sourceDirectory, imported, overlay: active, report });
  }
  return results;
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
