import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { USER_OFFICE_SKILL_FORMATS, SkillPackageManager, provisionUserOfficeSkills, resolveVcAgentSkillsRoot, type UserOfficeSkillFormat } from "../packages/host-services/src/index.ts";

/**
 * Provisions user-selected local Office skill packages. A source directory is
 * mandatory so this command cannot download or vendor a third-party package.
 */
async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const sourceRoot = resolveRequired(flags["source-root"] ?? process.env.VC_AGENT_OFFICE_SKILL_SOURCE, "VC_AGENT_OFFICE_SKILL_SOURCE");
  const skillsRoot = resolve(flags["skills-root"] ?? resolveVcAgentSkillsRoot(process.env, process.env.APPDATA ?? tmpdir()));
  const requested = flags.skills?.split(",").map((value) => value.trim()).filter(Boolean);
  const selected = requested === undefined ? undefined : requested.filter((value): value is UserOfficeSkillFormat => (USER_OFFICE_SKILL_FORMATS as readonly string[]).includes(value));
  if (requested !== undefined && (selected === undefined || selected.length !== requested.length)) throw new Error("OFFICE_SKILL_FORMAT_UNSUPPORTED");
  const manager = new SkillPackageManager({ root: skillsRoot });
  const results = await provisionUserOfficeSkills({ sourceRoot, manager, ...(selected === undefined ? {} : { packageIds: selected }) });
  console.log(JSON.stringify({
    source: { kind: "user_supplied_local" },
    skillsRoot,
    packages: results.map((result) => ({ packageId: result.packageId, revisionId: result.overlay.revisionId, active: result.overlay.enabled && result.overlay.state === "active", contentHash: result.overlay.contentHash, activeHash: result.overlay.activeHash, compatibility: result.report.status }))
  }, null, 2));
}

void main();

function parseFlags(values: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined || !value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function resolveRequired(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") throw new Error(`OFFICE_SKILL_SOURCE_REQUIRED:${name}`);
  return resolve(value);
}
