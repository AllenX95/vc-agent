import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ANTHROPIC_SKILLS_SOURCE, SkillPackageManager, provisionAnthropicSkills, type AnthropicSkillPackageId } from "../packages/host-services/src/index.ts";

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const skillsRoot = resolve(flags["skills-root"] ?? (process.env.VC_AGENT_SKILLS_ROOT ?? join(process.env.APPDATA ?? tmpdir(), "Electron", "skills")));
  const selected = flags.skills === undefined ? undefined : flags.skills.split(",").map((value) => value.trim()).filter((value): value is AnthropicSkillPackageId => ANTHROPIC_SKILLS_SOURCE.skills.some((skill) => skill.packageId === value));
  let temporarySource: string | undefined;
  let sourceRoot = flags["source-root"] === undefined ? undefined : resolve(flags["source-root"]);

  try {
    if (sourceRoot === undefined) {
      temporarySource = mkdtempSync(join(tmpdir(), "vc-agent-anthropic-skills-"));
      execFileSync("git", ["clone", "--depth", "1", ANTHROPIC_SKILLS_SOURCE.repository, temporarySource], { stdio: "inherit" });
      execFileSync("git", ["-C", temporarySource, "fetch", "--depth", "1", "origin", ANTHROPIC_SKILLS_SOURCE.revision], { stdio: "inherit" });
      execFileSync("git", ["-C", temporarySource, "checkout", ANTHROPIC_SKILLS_SOURCE.revision], { stdio: "inherit" });
      sourceRoot = temporarySource;
    }
    if (sourceRoot === undefined) throw new Error("SKILL_SOURCE_MISSING");
    const manager = new SkillPackageManager({ root: skillsRoot });
    const results = await provisionAnthropicSkills({ sourceRoot, manager, ...(selected === undefined ? {} : { packageIds: selected }) });
    console.log(JSON.stringify({
      source: { repository: ANTHROPIC_SKILLS_SOURCE.repository, revision: ANTHROPIC_SKILLS_SOURCE.revision },
      skillsRoot,
      packages: results.map((result) => ({ packageId: result.packageId, revisionId: result.overlay.revisionId, active: result.overlay.enabled && result.overlay.state === "active", contentHash: result.overlay.contentHash, activeHash: result.overlay.activeHash, compatibility: result.report.status }))
    }, null, 2));
  } finally {
    if (temporarySource !== undefined) rmSync(temporarySource, { recursive: true, force: true });
  }
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
