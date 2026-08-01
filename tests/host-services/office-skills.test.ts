import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillPackageManager, provisionUserOfficeSkills } from "@vc-agent/host-services";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("user-supplied Office skill provisioning", () => {
  it("copies a complete local package, overlays Host metadata, and activates the reviewed revision", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-office-skills-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const source = join(sourceRoot, "skills", "docx");
    mkdirSync(join(source, "scripts"), { recursive: true });
    mkdirSync(join(source, "resources"), { recursive: true });
    writeFileSync(join(source, "SKILL.md"), [
      "---",
      "name: docx",
      "description: create Word documents",
      "---",
      "Use resources/template.txt and run scripts/build.py."
    ].join("\n"), "utf8");
    writeFileSync(join(source, "scripts", "build.py"), "print('fixture')", "utf8");
    writeFileSync(join(source, "resources", "template.txt"), "template", "utf8");
    writeFileSync(join(source, "LICENSE.txt"), "Fixture license", "utf8");

    const manager = new SkillPackageManager({ root: join(root, "app-data", "skills") });
    const [result] = await provisionUserOfficeSkills({ sourceRoot, manager, packageIds: ["docx"] });

    expect(result).toBeDefined();
    expect(result!.report.status).toBe("compatible");
    expect(result!.overlay).toMatchObject({ packageId: "docx", enabled: true, state: "active", licensePresent: true });
    expect(result!.overlay.metadata).toMatchObject({
      name: "docx",
      keywords: expect.stringContaining("docx"),
      dependencies: expect.stringContaining("pandoc"),
      executables: "py"
    });
    expect(result!.overlay.files).toEqual(["LICENSE.txt", "SKILL.md", "resources/template.txt", "scripts/build.py"]);
    expect(readFileSync(join(source, "SKILL.md"), "utf8")).not.toContain("keywords:");
    expect(readFileSync(join(manager.activePath(result!.overlay), "SKILL.md"), "utf8")).toContain("keywords: word, docx");
    expect(existsSync(join(manager.activePath(result!.overlay), "vc-agent-source.json"))).toBe(true);
    expect(readFileSync(join(manager.activePath(result!.overlay), "vc-agent-source.json"), "utf8")).toContain("user_supplied_local");
  });

  it("can stage a local package for review without activating it", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-office-skills-review-"));
    roots.push(root);
    const source = join(root, "docx");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "---\nname: docx\ndescription: review\n---\nReview this package.", "utf8");
    writeFileSync(join(source, "LICENSE.txt"), "Fixture license", "utf8");

    const manager = new SkillPackageManager({ root: join(root, "app-data", "skills") });
    const [result] = await provisionUserOfficeSkills({ sourceRoot: join(root, "skills", ".."), manager, packageIds: ["docx"], skipActive: true });

    expect(result!.report.status).toBe("compatible");
    expect(result!.overlay.enabled).toBe(false);
    expect(result!.overlay.state).toBe("awaiting_activation");
  });
});
