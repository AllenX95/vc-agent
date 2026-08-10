import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLED_ACADEMIC_SKILL_IDS, VcSkillsDirectoryAdapter, installBundledAcademicSkills } from "@vc-agent/host-services";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bundled VC academic skills", () => {
  it("copies all bundled packages into the dedicated directory and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-academic-skills-"));
    roots.push(root);
    const skills = new VcSkillsDirectoryAdapter({ root: join(root, "skills") });
    const sourceRoot = resolve("skills/academic-research");

    const first = await installBundledAcademicSkills({ skills, sourceRoot });
    expect(first.imported).toEqual(BUNDLED_ACADEMIC_SKILL_IDS);
    expect(first.installed.map((skill) => skill.name)).toEqual([...BUNDLED_ACADEMIC_SKILL_IDS].sort((a, b) => a.localeCompare(b)));
    expect(first.installed.every((skill) => skills.isContained(skill.baseDir))).toBe(true);

    const second = await installBundledAcademicSkills({ skills, sourceRoot });
    expect(second.imported).toEqual([]);
    expect(skills.discover().skills).toHaveLength(BUNDLED_ACADEMIC_SKILL_IDS.length);
  });

  it("reports a missing reviewed source before copying any package", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-academic-missing-"));
    roots.push(root);
    const skills = new VcSkillsDirectoryAdapter({ root: join(root, "skills") });
    await expect(installBundledAcademicSkills({ skills, sourceRoot: join(root, "missing") })).rejects.toThrow("BUNDLED_ACADEMIC_SKILL_MISSING");
    expect(skills.discover().skills).toEqual([]);
  });
});
