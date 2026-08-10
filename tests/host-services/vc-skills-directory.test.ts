import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VcSkillsDirectoryAdapter } from "../../packages/host-services/src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix = "vc-skills-adapter-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeSkill(directory: string, input: { name?: string; description?: string; body?: string } = {}): void {
  const name = input.name ?? basename(directory);
  const description = input.description ?? "A VC Agent test Skill.";
  const body = input.body ?? "# Skill\n\nUse the included references.";
  writeFileSync(join(directory, "SKILL.md"), [
    "---",
    "name: " + name,
    "description: " + description,
    "---",
    "",
    body,
    ""
  ].join("\n"), "utf8");
}

function canSymlink(target: string, path: string, type: "file" | "junction" = "file"): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

describe("VcSkillsDirectoryAdapter", () => {
  it("discovers only valid Skills below its dedicated root", () => {
    const root = tempRoot();
    const dedicated = join(root, "vc-agent", "skills");
    const adapter = new VcSkillsDirectoryAdapter({ root: dedicated });
    const investment = join(dedicated, "investment-research");
    const ambient = join(root, "ambient", "coding-agent");
    const project = join(root, "project", ".agents", "skills", "project-skill");
    adapter.ensureRoot();
    mkdirSync(ambient, { recursive: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(investment, { recursive: true });
    writeSkill(investment, { name: "investment-research" });
    writeSkill(ambient, { name: "ambient-skill" });
    writeSkill(project, { name: "ambient-skill" });

    const snapshot = adapter.discover();
    expect(snapshot.root).toBe(resolve(dedicated));
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["investment-research"]);
    expect(adapter.additionalSkillPaths()).toEqual([resolve(dedicated)]);
    expect(snapshot.skills[0]?.filePath.startsWith(resolve(dedicated))).toBe(true);
  });

  it("reports malformed metadata and deterministic name collisions without activation state", () => {
    const root = tempRoot();
    const dedicated = join(root, "skills");
    const adapter = new VcSkillsDirectoryAdapter({ root: dedicated });
    adapter.ensureRoot();
    const first = join(dedicated, "first");
    const second = join(dedicated, "second");
    const malformed = join(dedicated, "malformed");
    for (const directory of [first, second, malformed]) mkdirSync(directory, { recursive: true });
    writeSkill(first, { name: "duplicate" });
    writeSkill(second, { name: "duplicate" });
    writeFileSync(join(malformed, "SKILL.md"), "---\nname: Bad Name\n---\n", "utf8");

    const snapshot = adapter.discover();
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["duplicate", "duplicate"]);
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "SKILL_COLLISION")).toBe(true);
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "SKILL_DESCRIPTION_MISSING")).toBe(true);
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "SKILL_NAME_INVALID")).toBe(true);
  });

  it("rejects direct and multi-hop links that escape the dedicated directory", () => {
    const root = tempRoot();
    const dedicated = join(root, "skills");
    const outside = join(root, "outside");
    const outsideSkill = join(outside, "outside-skill");
    const adapter = new VcSkillsDirectoryAdapter({ root: dedicated });
    adapter.ensureRoot();
    mkdirSync(outsideSkill, { recursive: true });
    writeSkill(outsideSkill, { name: "outside-skill" });
    const direct = join(dedicated, "direct");
    mkdirSync(direct, { recursive: true });
    const directLink = join(direct, "escaped");
    const directCreated = canSymlink(outsideSkill, directLink, process.platform === "win32" ? "junction" : "file");
    if (!directCreated) return;

    const hopTwo = join(dedicated, "hop-two");
    const hopOne = join(dedicated, "hop-one");
    const hopTwoCreated = canSymlink(outsideSkill, hopTwo, process.platform === "win32" ? "junction" : "file");
    const hopOneCreated = hopTwoCreated && canSymlink(hopTwo, hopOne, process.platform === "win32" ? "junction" : "file");
    if (!hopOneCreated) return;

    const snapshot = adapter.discover();
    expect(snapshot.skills.map((skill) => skill.name)).not.toContain("outside-skill");
    expect(snapshot.diagnostics.filter((diagnostic) => diagnostic.code === "SKILL_PATH_ESCAPE").length).toBeGreaterThanOrEqual(2);
  });

  it("rejects reference paths that escape even when the target is not linked", () => {
    const root = tempRoot();
    const dedicated = join(root, "skills");
    const skillDirectory = join(dedicated, "escape-reference");
    mkdirSync(skillDirectory, { recursive: true });
    writeSkill(skillDirectory, { name: "escape-reference", body: "[outside](../../outside.txt)" });
    const adapter = new VcSkillsDirectoryAdapter({ root: dedicated });

    const snapshot = adapter.discover();
    expect(snapshot.skills).toEqual([]);
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "SKILL_REFERENCE_ESCAPE")).toBe(true);
  });

  it("imports a complete directory, dereferences safe links, and remains usable after source removal", () => {
    const root = tempRoot();
    const dedicated = join(root, "skills");
    const source = join(root, "source-skill");
    mkdirSync(join(source, "references"), { recursive: true });
    writeSkill(source, { name: "imported-skill", body: "See [guide](references/guide.md)." });
    writeFileSync(join(source, "references", "guide.md"), "guide", "utf8");
    const safeLink = join(source, "references", "guide-alias.md");
    const linked = canSymlink(join(source, "references", "guide.md"), safeLink);
    const adapter = new VcSkillsDirectoryAdapter({ root: dedicated });

    const result = adapter.importSkill({ sourceDirectory: source, destinationName: "imported-skill" });
    rmSync(source, { recursive: true, force: true });
    expect(readFileSync(join(result.destinationPath, "SKILL.md"), "utf8")).toContain("imported-skill");
    expect(result.files).toContain("references/guide.md");
    expect(adapter.discover().skills.map((skill) => skill.name)).toEqual(["imported-skill"]);
    if (linked) expect(readdirSync(join(result.destinationPath, "references"), { withFileTypes: true }).find((entry) => entry.name === "guide-alias.md")?.isSymbolicLink()).toBe(false);
  });

  it("does not retain an escaping link during import", () => {
    const root = tempRoot();
    const dedicated = join(root, "skills");
    const source = join(root, "source-skill");
    const outside = join(root, "secret.txt");
    mkdirSync(source, { recursive: true });
    writeSkill(source, { name: "unsafe-import" });
    writeFileSync(outside, "secret", "utf8");
    const linked = canSymlink(outside, join(source, "secret.txt"));
    if (!linked) return;
    const adapter = new VcSkillsDirectoryAdapter({ root: dedicated });
    expect(() => adapter.importSkill({ sourceDirectory: source, destinationName: "unsafe-import" })).toThrow("SKILL_PATH_ESCAPE");
    expect(adapter.discover().skills).toEqual([]);
  });

  it("atomically replaces an existing Skill and preserves the old copy when source validation fails", () => {
    const root = tempRoot();
    const dedicated = join(root, "skills");
    const original = join(root, "original");
    const replacement = join(root, "replacement");
    mkdirSync(original, { recursive: true });
    mkdirSync(replacement, { recursive: true });
    writeSkill(original, { name: "replaceable", description: "old", body: "old body" });
    writeSkill(replacement, { name: "replaceable", description: "new", body: "new body" });
    const adapter = new VcSkillsDirectoryAdapter({ root: dedicated });
    const first = adapter.importSkill({ sourceDirectory: original, destinationName: "replaceable" });
    const updated = adapter.replaceSkill({ sourceDirectory: replacement, destinationName: "replaceable" });
    expect(updated.destinationPath).toBe(first.destinationPath);
    expect(readFileSync(join(updated.destinationPath, "SKILL.md"), "utf8")).toContain("new body");

    const invalid = join(root, "invalid");
    mkdirSync(invalid, { recursive: true });
    writeFileSync(join(invalid, "SKILL.md"), "---\nname: Bad Name\ndescription: invalid\n---\n", "utf8");
    expect(() => adapter.replaceSkill({ sourceDirectory: invalid, destinationName: "replaceable" })).toThrow("SKILL_METADATA_INVALID");
    expect(readFileSync(join(updated.destinationPath, "SKILL.md"), "utf8")).toContain("new body");
  });

  it("filters Pi-loaded structural Skills to the canonical dedicated root", () => {
    const root = tempRoot();
    const dedicated = join(root, "skills");
    const adapter = new VcSkillsDirectoryAdapter({ root: dedicated });
    adapter.ensureRoot();
    const inside = join(dedicated, "inside");
    const outside = join(root, "outside");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(inside, "SKILL.md"), "skill", "utf8");
    writeFileSync(join(outside, "SKILL.md"), "skill", "utf8");
    const loaded = [
      { filePath: join(inside, "SKILL.md"), baseDir: inside, id: "inside" },
      { filePath: join(outside, "SKILL.md"), baseDir: outside, id: "outside" }
    ];
    expect(adapter.filterLoadedSkills(loaded).map((skill) => skill.id)).toEqual(["inside"]);
  });
});
