import { resolve } from "node:path";
import {
  BUNDLED_ACADEMIC_SKILL_IDS,
  installBundledAcademicSkills,
  resolveVcAgentSkillsRoot,
  VcSkillsDirectoryAdapter
} from "../packages/host-services/src/index.ts";

/** Copy the reviewed academic Skill bundle into the app-owned directory. */
async function main(): Promise<void> {
  const sourceRoot = resolve(process.env.VC_AGENT_BUNDLED_ACADEMIC_SKILLS_ROOT ?? resolve(process.cwd(), "skills", "academic-research"));
  const skillsRoot = resolve(process.env.VC_AGENT_SKILLS_ROOT ?? resolveVcAgentSkillsRoot(process.env, process.env.APPDATA ?? process.cwd()));
  const skills = new VcSkillsDirectoryAdapter({ root: skillsRoot });
  const result = await installBundledAcademicSkills({ skills, sourceRoot });
  const available = result.installed.map((skill) => skill.name);
  if (available.length !== BUNDLED_ACADEMIC_SKILL_IDS.length) throw new Error(`ACADEMIC_SKILLS_UNAVAILABLE:${available.join(",")}`);
  console.log(JSON.stringify({ sourceRoot, skillsRoot, available, imported: result.imported }, null, 2));
}

void main();
