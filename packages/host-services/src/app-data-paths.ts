import { join, resolve } from "node:path";

type AppDataEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveVcAgentUserDataRoot(environment: AppDataEnvironment, appDataFallback: string): string {
  const explicit = environment.VC_AGENT_USER_DATA_DIR?.trim();
  if (explicit !== undefined && explicit !== "") return resolve(explicit);
  const base = environment.LOCALAPPDATA?.trim() || appDataFallback;
  return resolve(base, "vc-agent");
}

export function resolveVcAgentSkillsRoot(environment: AppDataEnvironment, appDataFallback: string): string {
  const explicit = environment.VC_AGENT_SKILLS_ROOT?.trim();
  if (explicit !== undefined && explicit !== "") return resolve(explicit);
  return join(resolveVcAgentUserDataRoot(environment, appDataFallback), "skills");
}
