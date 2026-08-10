import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SkillCreationWorkflow, VcSkillsDirectoryAdapter } from "@vc-agent/host-services";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Skill Creator workflow", () => {
  it("requires explicit intent, reviews a complete draft, and copies it into the dedicated directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-creator-"));
    roots.push(root);
    const skills = new VcSkillsDirectoryAdapter({ root: join(root, "skills") });
    const workflow = new SkillCreationWorkflow({ skills });
    await expect(workflow.createDraft({ explicitIntent: false, packageId: "new-skill", files: { "SKILL.md": "# no" } })).rejects.toThrow("SKILL_CREATOR_CAPABILITY_REJECTED");
    const draft = await workflow.createDraft({
      explicitIntent: true,
      packageId: "new-skill",
      files: { "SKILL.md": "---\nname: new-skill\ndescription: A new Skill.\n---\nUse resources/example.txt.", "resources/example.txt": "resource", "LICENSE": "license" },
      dependencies: ["python"]
    });
    expect(draft.state).toBe("draft_ready");
    const review = await workflow.review(draft.draftId);
    expect(review.status).toBe("reviewable");
    expect(review.fileInventory).toEqual(["LICENSE", "SKILL.md", "resources/example.txt"]);
    expect(review.exactDiff).toContain("resources/example.txt");
    await expect(workflow.accept(draft.draftId)).rejects.toThrow("SKILL_CREATOR_CAPABILITY_REJECTED");
    const accepted = await workflow.accept(draft.draftId, { accessMode: "standard", confirmed: true });
    expect(accepted.destinationPath).toContain("new-skill");
    expect(skills.discover().skills.map((skill) => skill.name)).toEqual(["new-skill"]);
  });

  it("keeps an existing Skill when an update job fails and detects stale targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-creator-update-"));
    roots.push(root);
    const source = join(root, "source");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "---\nname: base\ndescription: Base Skill.\n---\nbase", "utf8");
    const skills = new VcSkillsDirectoryAdapter({ root: join(root, "skills") });
    const imported = skills.importSkill({ sourceDirectory: source, destinationName: "base" });
    const workflow = new SkillCreationWorkflow({ skills, adapter: { run: async () => { throw new Error("SKILL_CREATOR_JOB_FAILED"); } } });
    const failed = await workflow.updateDraft({ explicitIntent: true, packageId: "base", targetSkillPath: imported.destinationPath, files: { "SKILL.md": "---\nname: base\ndescription: Base Skill.\n---\nchanged" } });
    expect(failed.state).toBe("failed");
    expect(readFileSync(join(imported.destinationPath, "SKILL.md"), "utf8")).toContain("base");

    const succeeding = new SkillCreationWorkflow({ skills });
    const draft = await succeeding.updateDraft({ explicitIntent: true, packageId: "base", targetSkillPath: imported.destinationPath, files: { "SKILL.md": "---\nname: base\ndescription: Base Skill.\n---\nchanged" } });
    writeFileSync(join(imported.destinationPath, "SKILL.md"), "external", "utf8");
    const review = await succeeding.review(draft.draftId);
    expect(review.status).toBe("stale");
    expect(review.draft.state).toBe("stale");
  });
});
