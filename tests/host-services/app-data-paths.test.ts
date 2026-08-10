import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveVcAgentSkillsRoot, resolveVcAgentUserDataRoot } from "../../packages/host-services/src/index.js";

describe("vc-agent application data paths", () => {
  it("keeps default user data and Skills under the vc-agent directory", () => {
    const environment = { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" };
    const userData = resolveVcAgentUserDataRoot(environment, "C:\\fallback");
    expect(userData).toBe(resolve(environment.LOCALAPPDATA, "vc-agent"));
    expect(resolveVcAgentSkillsRoot(environment, "C:\\fallback")).toBe(resolve(userData, "pi-agent", "skills"));
  });

  it("respects explicit vc-agent roots without consulting another agent directory", () => {
    const environment = {
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      VC_AGENT_USER_DATA_DIR: "D:\\vc-agent-data",
      VC_AGENT_SKILLS_ROOT: "D:\\vc-agent-skills"
    };
    expect(resolveVcAgentUserDataRoot(environment, "C:\\fallback")).toBe(resolve(environment.VC_AGENT_USER_DATA_DIR));
    expect(resolveVcAgentSkillsRoot(environment, "C:\\fallback")).toBe(resolve(environment.VC_AGENT_SKILLS_ROOT));
  });
});
