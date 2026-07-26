import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { OfficeSkillOrchestrator, SkillPackageManager, type OfficeTaskRequest } from "@vc-agent/host-services";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function activeSkill(root: string): Promise<{ manager: SkillPackageManager; revisionId: string }> {
  const source = join(root, "skill-source");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: docx\nkeywords: document, docx\n---\nCreate a docx.", "utf8");
  const manager = new SkillPackageManager({ root: join(root, "skills") });
  const imported = await manager.importLocalDirectory({ sourceDirectory: source, packageId: "docx" });
  await manager.inspect(imported.package.revisionId);
  await manager.activate(imported.package.revisionId);
  return { manager, revisionId: imported.package.revisionId };
}

function request(root: string, revisionId: string, kind: "create" | "edit", sourcePath?: string): OfficeTaskRequest {
  return {
    kind,
    format: "docx",
    projectId: "00000000-0000-4000-8000-000000000001",
    projectPath: root,
    threadId: "thread-1",
    turnId: "turn-1",
    profile: { id: "profile-1", provider: "fixture", model: "fixture-model" },
    skillRevisionId: revisionId,
    outputDirectory: join(root, "outputs"),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    sourceReferences: ["material:1"],
    explicitIntent: true
  };
}

describe("Office Skill Orchestrator", () => {
  it("runs a declared fixture job, validates staged output, and registers provenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-office-"));
    roots.push(root);
    const { manager, revisionId } = await activeSkill(root);
    const registered: unknown[] = [];
    const orchestrator = new OfficeSkillOrchestrator({
      skills: manager,
      root: join(root, "office-state"),
      adapter: {
        run: async ({ plan }) => {
          writeFileSync(plan.stagedOutputPath, "docx fixture", "utf8");
          return { outputPath: plan.stagedOutputPath, warnings: ["fixture"] };
        }
      },
      registerOutput: (output) => registered.push(output)
    });
    const plan = await orchestrator.prepare(request(root, revisionId, "create"));
    const staged = await orchestrator.execute(plan.planId);
    expect(staged).toMatchObject({ status: "validated", format: "docx" });
    const output = await orchestrator.commit(staged.resultId);
    expect(output).toMatchObject({ projectId: "00000000-0000-4000-8000-000000000001", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", producer: { skillRevisionId: revisionId } });
    expect(readFileSync(output.destination, "utf8")).toBe("docx fixture");
    expect(registered).toHaveLength(1);
  });

  it("creates an edited copy and gates original replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-office-"));
    roots.push(root);
    const source = join(root, "source.docx");
    writeFileSync(source, "original", "utf8");
    const { manager, revisionId } = await activeSkill(root);
    const orchestrator = new OfficeSkillOrchestrator({
      skills: manager,
      root: join(root, "office-state"),
      adapter: { run: async ({ plan }) => { writeFileSync(plan.stagedOutputPath, "edited", "utf8"); return { outputPath: plan.stagedOutputPath }; } }
    });
    const plan = await orchestrator.prepare(request(root, revisionId, "edit", source));
    expect(plan.job.inputPaths).not.toContain(source);
    expect(readFileSync(plan.job.inputPaths[0]!, "utf8")).toBe("original");
    const staged = await orchestrator.execute(plan.planId);
    expect(staged.changeSummaryPath).toBeDefined();
    expect(readFileSync(source, "utf8")).toBe("original");
    const denied = await orchestrator.replaceOriginal({ resultId: staged.resultId, sourcePath: source, expectedSourceHash: staged.sourceHash!, accessMode: "standard", confirmed: false });
    expect(denied).toMatchObject({ status: "confirmation_required" });
    const approved = await orchestrator.replaceOriginal({ resultId: staged.resultId, sourcePath: source, expectedSourceHash: staged.sourceHash!, accessMode: "standard", confirmed: true });
    expect(approved).toMatchObject({ status: "replaced" });
    expect(readFileSync(source, "utf8")).toBe("edited");
  });

  it("preserves the source on dependency failure and surfaces unknown outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-office-"));
    roots.push(root);
    const source = join(root, "source.docx");
    writeFileSync(source, "original", "utf8");
    const { manager, revisionId } = await activeSkill(root);
    const orchestrator = new OfficeSkillOrchestrator({
      skills: manager,
      root: join(root, "office-state"),
      adapter: { run: async () => { throw new Error("OFFICE_DEPENDENCY_MISSING"); } }
    });
    const plan = await orchestrator.prepare(request(root, revisionId, "edit", source));
    const failed = await orchestrator.execute(plan.planId);
    expect(failed.status).toBe("failed");
    expect(readFileSync(source, "utf8")).toBe("original");

    const working = new OfficeSkillOrchestrator({
      skills: manager,
      root: join(root, "office-state-2"),
      adapter: { run: async ({ plan: next }) => { writeFileSync(next.stagedOutputPath, "edited", "utf8"); return { outputPath: next.stagedOutputPath }; } }
    });
    const nextPlan = await working.prepare(request(root, revisionId, "edit", source));
    const next = await working.execute(nextPlan.planId);
    const unknown = await working.replaceOriginal({ resultId: next.resultId, sourcePath: source, expectedSourceHash: next.sourceHash!, accessMode: "full", confirmed: true, simulateUnknownOutcome: true });
    expect(unknown).toMatchObject({ status: "unknown_outcome", code: "UNKNOWN_TOOL_OUTCOME", requiresInspection: true });
    expect(readFileSync(source, "utf8")).toBe("original");
  });
});
