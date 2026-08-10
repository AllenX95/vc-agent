import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VcSkillsDirectoryAdapter, provisionUserOfficeSkills } from "@vc-agent/host-services";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("user-supplied Office skill provisioning", () => {
  it("copies a complete local package without rewriting the source or creating activation state", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-office-skills-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const source = join(sourceRoot, "skills", "docx");
    mkdirSync(join(source, "scripts"), { recursive: true });
    mkdirSync(join(source, "resources"), { recursive: true });
    const skillBody = ["---", "name: docx", "description: create Word documents", "---", "Use resources/template.txt and run scripts/build.py."].join("\n");
    writeFileSync(join(source, "SKILL.md"), skillBody, "utf8");
    writeFileSync(join(source, "scripts", "build.py"), "print('fixture')", "utf8");
    writeFileSync(join(source, "resources", "template.txt"), "template", "utf8");
    writeFileSync(join(source, "LICENSE.txt"), "Fixture license", "utf8");

    const skills = new VcSkillsDirectoryAdapter({ root: join(root, "app-data", "skills") });
    const [result] = await provisionUserOfficeSkills({ sourceRoot, skills, packageIds: ["docx"] });

    expect(result).toBeDefined();
    expect(result!.skill.name).toBe("docx");
    expect(result!.skillHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(existsSync(join(result!.destinationPath, "scripts", "build.py"))).toBe(true);
    expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe(skillBody);
    expect(skills.discover().skills.map((skill) => skill.name)).toEqual(["docx"]);
    expect(skills.discover().diagnostics.some((diagnostic) => diagnostic.code.includes("ACTIVATION"))).toBe(false);
  });

  it("treats an existing valid destination as already available", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-office-skills-existing-"));
    roots.push(root);
    const source = join(root, "docx");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "---\nname: docx\ndescription: review\n---\nReview this package.", "utf8");

    const skills = new VcSkillsDirectoryAdapter({ root: join(root, "app-data", "skills") });
    const first = await provisionUserOfficeSkills({ sourceRoot: root, skills, packageIds: ["docx"] });
    const second = await provisionUserOfficeSkills({ sourceRoot: root, skills, packageIds: ["docx"], skipActive: true });
    expect(second[0]!.destinationPath).toBe(first[0]!.destinationPath);
    expect(skills.discover().skills).toHaveLength(1);
  });
});
