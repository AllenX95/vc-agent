import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inventoryProjectFiles } from "@vc-agent/host-services";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Material Inventory", () => {
  it("hashes supported Materials deterministically and excludes generated or temporary paths", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "vc-agent-inventory-"));
    directories.push(projectPath);
    mkdirSync(join(projectPath, "data"));
    mkdirSync(join(projectPath, "outputs", "parsed"), { recursive: true });
    writeFileSync(join(projectPath, "memo.md"), "Investment thesis");
    writeFileSync(join(projectPath, "data", "metrics.csv"), "year,revenue\n2026,10");
    writeFileSync(join(projectPath, "outputs", "generated.md"), "Generated output");
    writeFileSync(join(projectPath, "~$memo.docx"), "Temporary Office file");
    writeFileSync(join(projectPath, "binary.exe"), "Unsupported");

    const first = await inventoryProjectFiles(projectPath);
    expect(first.map((item) => item.relativePath)).toEqual(["data/metrics.csv", "memo.md"]);
    expect(first.every((item) => /^[a-f0-9]{64}$/.test(item.sourceHash))).toBe(true);
    const second = await inventoryProjectFiles(projectPath, first);
    expect(second).toEqual(first);
  });
});
