import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SkillCreationWorkflow, SkillPackageManager } from "@vc-agent/host-services";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Skill Creator workflow", () => {
  it("requires explicit intent, stages a complete draft, reviews it, and hands off disabled to I1", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-creator-"));
    roots.push(root);
    const manager = new SkillPackageManager({ root: join(root, "skills") });
    const workflow = new SkillCreationWorkflow({ manager });
    await expect(workflow.createDraft({ explicitIntent: false, packageId: "new-skill", files: { "SKILL.md": "# no" } })).rejects.toThrow("SKILL_CREATOR_CAPABILITY_REJECTED");
    const draft = await workflow.createDraft({
      explicitIntent: true,
      packageId: "new-skill",
      files: { "SKILL.md": "---\nname: New Skill\n---\nUse resources/example.txt.", "resources/example.txt": "resource", "LICENSE": "license" },
      dependencies: ["python"]
    });
    expect(draft.state).toBe("draft_ready");
    const review = await workflow.review(draft.draftId);
    expect(review.status).toBe("reviewable");
    expect(review.fileInventory).toEqual(["LICENSE", "SKILL.md", "resources/example.txt"]);
    expect(review.exactDiff).toContain("resources/example.txt");
    await expect(workflow.accept(draft.draftId)).rejects.toThrow("SKILL_CREATOR_CAPABILITY_REJECTED");
    const accepted = await workflow.accept(draft.draftId, { accessMode: "standard", confirmed: true });
    expect(accepted.package.sourceKind).toBe("creator_draft");
    expect(manager.inventory().find((item) => item.packageId === "new-skill")).toMatchObject({ enabled: false, state: "copied" });
  });

  it("preserves an active revision when an update job fails and detects stale targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-creator-"));
    roots.push(root);
    const source = join(root, "source");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "---\nname: Base\n---\nbase", "utf8");
    const manager = new SkillPackageManager({ root: join(root, "skills") });
    const imported = await manager.importLocalDirectory({ sourceDirectory: source, packageId: "base" });
    await manager.inspect(imported.package.revisionId);
    await manager.activate(imported.package.revisionId);
    const workflow = new SkillCreationWorkflow({
      manager,
      adapter: { run: async () => { throw new Error("SKILL_CREATOR_JOB_FAILED"); } }
    });
    const failed = await workflow.updateDraft({ explicitIntent: true, packageId: "base", targetRevisionId: imported.package.revisionId, files: { "SKILL.md": "---\nname: Base\n---\nchanged" } });
    expect(failed.state).toBe("failed");
    expect(readFileSync(join(manager.activePath(manager.getRevision(imported.package.revisionId)!), "SKILL.md"), "utf8")).toContain("base");

    const succeeding = new SkillCreationWorkflow({ manager });
    const draft = await succeeding.updateDraft({ explicitIntent: true, packageId: "base", targetRevisionId: imported.package.revisionId, files: { "SKILL.md": "---\nname: Base\n---\nchanged" } });
    writeFileSync(join(manager.sourcePath(manager.getRevision(imported.package.revisionId)!), "SKILL.md"), "external", "utf8");
    const review = await succeeding.review(draft.draftId);
    expect(review.status).toBe("stale");
    expect(review.draft.state).toBe("stale");
  });
});
