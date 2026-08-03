import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLED_ACADEMIC_SKILL_IDS,
  installBundledAcademicSkills,
  SkillPackageManager,
  SkillResourceProjector
} from "@vc-agent/host-services";
import { SnapshotResourceLoader } from "@vc-agent/pi-adapter";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bundled VC academic skills", () => {
  it("explicitly installs all bundled packages once and exposes a task-scoped Pi runtime snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-academic-skills-"));
    roots.push(root);
    const manager = new SkillPackageManager({ root: join(root, "skills") });
    const sourceRoot = resolve("skills/academic-research");

    const first = await installBundledAcademicSkills({ manager, sourceRoot });
    expect(first.activated).toEqual(BUNDLED_ACADEMIC_SKILL_IDS);
    expect(first.installed).toHaveLength(BUNDLED_ACADEMIC_SKILL_IDS.length);
    expect(first.installed.every((item) => item.sourceKind === "bundled_reviewed" && item.enabled && item.state === "active")).toBe(true);

    const second = await installBundledAcademicSkills({ manager, sourceRoot });
    expect(second.activated).toEqual([]);
    expect(manager.inventory()).toHaveLength(BUNDLED_ACADEMIC_SKILL_IDS.length);

    const projector = new SkillResourceProjector({ manager });
    const decisions = projector.resolve({ task: "请对这篇论文做论文技术尽调", scope: "project" });
    expect(decisions.map((decision) => decision.packageId)).toEqual(["paper-technical-diligence"]);
    const snapshot = projector.project(decisions);
    expect(snapshot.instructions).toHaveLength(1);
    expect(snapshot.resources.map((resource) => resource.relativePath)).toEqual(expect.arrayContaining([
      "agents/openai.yaml",
      "references/evidence-policy.md",
      "references/methodology.md"
    ]));

    const loader = new SnapshotResourceLoader({
      cwd: root,
      resources: {
        schemaVersion: 1,
        revisionId: "academic-runtime-test",
        systemPrompt: "Base prompt",
        appendSystemPrompt: [],
        skills: snapshot
      },
      extensions: { schemaVersion: 1, revisionId: "extensions-empty", enabled: [] }
    });
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["paper-technical-diligence"]);
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(readFileSync(loader.getSkills().skills[0]!.filePath, "utf8")).toContain("experimental validity");
  });

  it.each([
    ["创始人学术尽调", "founder-academic-diligence"],
    ["验证BP中的全球首个", "technical-claim-verification"],
    ["制作技术原创性图谱", "novelty-and-prior-art-map"],
    ["从论文到公司的产业化映射", "research-to-company-map"],
    ["下载 ArXiv 全文", "arxiv-fulltext-reader"]
  ])("matches the Chinese trigger %s to %s", async (task, packageId) => {
    const root = mkdtempSync(join(tmpdir(), "vc-academic-trigger-"));
    roots.push(root);
    const manager = new SkillPackageManager({ root: join(root, "skills") });
    await installBundledAcademicSkills({ manager, sourceRoot: resolve("skills/academic-research") });
    const projector = new SkillResourceProjector({ manager });
    expect(projector.resolve({ task, scope: "unscoped" }).map((decision) => decision.packageId)).toContain(packageId);
  });
});
