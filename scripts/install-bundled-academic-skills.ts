import { resolve } from "node:path";
import {
  BUNDLED_ACADEMIC_SKILL_IDS,
  installBundledAcademicSkills,
  resolveVcAgentSkillsRoot,
  SkillPackageManager
} from "../packages/host-services/src/index.ts";

/** Install and activate the reviewed academic Skill bundle in the app-owned directory. */
async function main(): Promise<void> {
  const sourceRoot = resolve(process.env.VC_AGENT_BUNDLED_ACADEMIC_SKILLS_ROOT ?? resolve(process.cwd(), "skills", "academic-research"));
  const skillsRoot = resolve(process.env.VC_AGENT_SKILLS_ROOT ?? resolveVcAgentSkillsRoot(process.env, process.env.APPDATA ?? process.cwd()));
  const manager = new SkillPackageManager({ root: skillsRoot });
  const result = await installBundledAcademicSkills({ manager, sourceRoot });
  const active = result.installed.filter((item) => item.enabled && item.state === "active").map((item) => item.packageId);
  if (active.length !== BUNDLED_ACADEMIC_SKILL_IDS.length) throw new Error(`ACADEMIC_SKILLS_NOT_ACTIVE:${active.join(",")}`);
  console.log(JSON.stringify({ sourceRoot, skillsRoot, active }, null, 2));
}

void main();
