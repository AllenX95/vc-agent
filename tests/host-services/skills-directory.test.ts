import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillPackageManager, SkillResourceProjector } from "@vc-agent/host-services";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(input: { name?: string; missing?: boolean; script?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "vc-skill-source-"));
  roots.push(root);
  mkdirSync(join(root, "resources"), { recursive: true });
  const scriptLine = input.script === true ? "\n- Run scripts/build.py with python." : "";
  writeFileSync(join(root, "SKILL.md"), [
    "---",
    "name: " + (input.name ?? "Office Docs"),
    "description: create documents",
    "keywords: office, document",
    ...(input.script === true ? ["executables: build.py"] : []),
    "---",
    "# Office Docs",
    "Use resources/template.txt." + scriptLine
  ].join("\n"), "utf8");
  if (input.missing !== true) writeFileSync(join(root, "resources", "template.txt"), "template", "utf8");
  if (input.script === true) {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "build.py"), "print('ok')", "utf8");
  }
  writeFileSync(join(root, "LICENSE"), "test license", "utf8");
  return root;
}

describe("Skills Directory", () => {
  it("is lazy, copies a complete package, and activates only explicitly", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-skills-"));
    roots.push(root);
    const source = fixture({ script: true });
    const appRoot = join(root, "app-data", "skills");
    const manager = new SkillPackageManager({ root: appRoot });
    expect(manager.inventory()).toEqual([]);
    expect(() => manager.open()).not.toThrow();
    expect(manager.inventory()).toEqual([]);

    const imported = await manager.importLocalDirectory({ sourceDirectory: source, packageId: "office-docs" });
    rmSync(source, { recursive: true, force: true });
    const report = await manager.inspect(imported.package.revisionId);
    expect(report.status).toBe("compatible");
    expect(report.package.enabled).toBe(false);
    expect(report.package.licensePresent).toBe(true);
    expect(report.package.files).toEqual(["LICENSE", "SKILL.md", "resources/template.txt", "scripts/build.py"]);
    expect(report.package.declaredDependencies).toEqual(["build.py"]);
    expect(() => manager.getRevision(imported.package.revisionId)!.enabled).not.toBe(true);

    const activation = await manager.activate(imported.package.revisionId);
    expect(activation).toMatchObject({ packageId: "office-docs", reason: "explicit" });
    expect(manager.inventory().find((item) => item.packageId === "office-docs")).toMatchObject({ enabled: true, state: "active" });
  });

  it("blocks missing references and undeclared executable dependencies", async () => {
    const appRoot = mkdtempSync(join(tmpdir(), "vc-skills-"));
    roots.push(appRoot);
    const missing = fixture({ missing: true });
    const manager = new SkillPackageManager({ root: join(appRoot, "skills") });
    const importedMissing = await manager.importLocalDirectory({ sourceDirectory: missing, packageId: "missing" });
    const missingReport = await manager.inspect(importedMissing.package.revisionId);
    expect(missingReport.status).toBe("incompatible");
    expect(missingReport.missingReferences).toContain("resources/template.txt");

    const executable = fixture({ script: true });
    writeFileSync(join(executable, "SKILL.md"), "# no declaration\nUse scripts/build.py.", "utf8");
    const importedExecutable = await manager.importLocalDirectory({ sourceDirectory: executable, packageId: "executable" });
    const executableReport = await manager.inspect(importedExecutable.package.revisionId);
    expect(executableReport.undeclaredExecutables).toContain("scripts/build.py");
    expect(executableReport.findings.some((finding) => finding.code === "SKILL_DEPENDENCY_UNDECLARED")).toBe(true);
  });

  it("projects only relevant active resources and invalidates changed active bytes", async () => {
    const appRoot = mkdtempSync(join(tmpdir(), "vc-skills-"));
    roots.push(appRoot);
    const manager = new SkillPackageManager({ root: join(appRoot, "skills") });
    const imported = await manager.importLocalDirectory({ sourceDirectory: fixture(), packageId: "office-docs" });
    await manager.inspect(imported.package.revisionId);
    await manager.activate(imported.package.revisionId);
    const projector = new SkillResourceProjector({ manager });
    const decisions = projector.resolve({ task: "Please create an office document", scope: "project" });
    expect(decisions).toHaveLength(1);
    const snapshot = projector.project(decisions);
    expect(snapshot.instructions[0]?.content).toContain("Office Docs");
    expect(snapshot.resources[0]?.relativePath).toBe("resources/template.txt");
    expect(snapshot.instructions[0]?.content).not.toContain("Protected Credential");

    const record = manager.getRevision(imported.package.revisionId)!;
    writeFileSync(join(manager.activePath(record), "SKILL.md"), "changed", "utf8");
    const invalidated = await manager.invalidateChanged();
    expect(invalidated[0]).toMatchObject({ enabled: false, state: "invalidated" });
    expect(createHash("sha256").update(snapshot.revisionId).digest("hex")).toHaveLength(64);
  });
});
