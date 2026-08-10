import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { OfficeSkillOrchestrator, VcSkillsDirectoryAdapter, type OfficeTaskRequest } from "@vc-agent/host-services";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function activeSkill(root: string): { skills: VcSkillsDirectoryAdapter; skillPath: string } {
  const source = join(root, "skill-source");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: docx\ndescription: document\n---\nCreate a docx.", "utf8");
  const skills = new VcSkillsDirectoryAdapter({ root: join(root, "skills") });
  const imported = skills.importSkill({ sourceDirectory: source, destinationName: "docx" });
  return { skills, skillPath: imported.destinationPath };
}

function request(root: string, skillPath: string, kind: "create" | "edit" | "review", sourcePath?: string): OfficeTaskRequest {
  return {
    kind,
    format: "docx",
    projectId: "00000000-0000-4000-8000-000000000001",
    projectPath: root,
    threadId: "thread-1",
    turnId: "turn-1",
    profile: { id: "profile-1", provider: "fixture", model: "fixture-model" },
    skillPath,
    outputDirectory: join(root, "outputs"),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    sourceReferences: ["material:1"],
    explicitIntent: true
  };
}

describe("Office Skill Orchestrator", () => {
  it("runs a fixture job, freezes Skill provenance, and registers the output", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-office-"));
    roots.push(root);
    const { skills, skillPath } = activeSkill(root);
    const registered: unknown[] = [];
    const orchestrator = new OfficeSkillOrchestrator({
      skills,
      root: join(root, "office-state"),
      adapter: {
        run: async ({ plan }) => {
          writeFileSync(plan.stagedOutputPath, "docx fixture", "utf8");
          return { outputPath: plan.stagedOutputPath, warnings: ["fixture"] };
        }
      },
      registerOutput: (output) => registered.push(output)
    });
    const plan = await orchestrator.prepare(request(root, skillPath, "create"));
    expect(plan.skillRoot).toBe(skillPath);
    expect(plan.skillHash).toMatch(/^[a-f0-9]{64}$/u);
    const staged = await orchestrator.execute(plan.planId);
    expect(staged).toMatchObject({ status: "validated", format: "docx" });
    const output = await orchestrator.commit(staged.resultId);
    expect(output).toMatchObject({ projectId: "00000000-0000-4000-8000-000000000001", producer: { skillName: "docx", skillHash: plan.skillHash } });
    expect(readFileSync(output.destination, "utf8")).toBe("docx fixture");
    expect(registered).toHaveLength(1);
  });

  it("creates an edited copy and gates original replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-office-edit-"));
    roots.push(root);
    const source = join(root, "source.docx");
    writeFileSync(source, "original", "utf8");
    const { skills, skillPath } = activeSkill(root);
    const orchestrator = new OfficeSkillOrchestrator({
      skills,
      root: join(root, "office-state"),
      adapter: { run: async ({ plan }) => { writeFileSync(plan.stagedOutputPath, "edited", "utf8"); return { outputPath: plan.stagedOutputPath }; } }
    });
    const plan = await orchestrator.prepare(request(root, skillPath, "edit", source));
    expect(plan.job.inputPaths).not.toContain(source);
    expect(readFileSync(plan.job.inputPaths[0]!, "utf8")).toBe("original");
    const staged = await orchestrator.execute(plan.planId);
    const denied = await orchestrator.replaceOriginal({ resultId: staged.resultId, sourcePath: source, expectedSourceHash: staged.sourceHash!, accessMode: "standard", confirmed: false });
    expect(denied).toMatchObject({ status: "confirmation_required" });
    const approved = await orchestrator.replaceOriginal({ resultId: staged.resultId, sourcePath: source, expectedSourceHash: staged.sourceHash!, accessMode: "standard", confirmed: true });
    expect(approved).toMatchObject({ status: "replaced" });
    expect(readFileSync(source, "utf8")).toBe("edited");
  });

  it("rejects a changed Skill before running the isolated job", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-office-skill-stale-"));
    roots.push(root);
    const { skills, skillPath } = activeSkill(root);
    let runs = 0;
    const orchestrator = new OfficeSkillOrchestrator({
      skills,
      root: join(root, "office-state"),
      adapter: { run: async ({ plan }) => { runs += 1; writeFileSync(plan.stagedOutputPath, "edited", "utf8"); return { outputPath: plan.stagedOutputPath }; } }
    });
    const plan = await orchestrator.prepare(request(root, skillPath, "create"));
    writeFileSync(join(skillPath, "SKILL.md"), "---\nname: docx\ndescription: changed\n---\nChanged.", "utf8");
    const failed = await orchestrator.execute(plan.planId);
    expect(failed).toMatchObject({ status: "failed", warnings: ["OFFICE_SKILL_CHANGED"] });
    expect(runs).toBe(0);
  });
});
