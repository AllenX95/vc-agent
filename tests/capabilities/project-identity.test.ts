import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectIdentityStore } from "@vc-agent/host-services";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ProjectIdentityStore", () => {
  it("creates only the minimal stable marker and can replace copied identity", () => {
    const projectPath = mkdtempSync(join(tmpdir(), "vc-agent-project-secret-deal-"));
    directories.push(projectPath);
    const store = new ProjectIdentityStore();
    const first = store.create(projectPath);
    const markerPath = store.markerPath(projectPath);
    const raw = readFileSync(markerPath, "utf8");

    expect(JSON.parse(raw)).toEqual({ schemaVersion: 1, projectId: first.projectId, createdAt: first.createdAt });
    expect(raw).not.toContain(projectPath);
    expect(raw).not.toContain("secret-deal");
    expect(readdirSync(join(projectPath, "outputs", "system"))).toEqual(["project.json"]);
    expect(store.read(projectPath)).toEqual(first);

    const copy = store.replaceForCopy(projectPath);
    expect(copy.projectId).not.toBe(first.projectId);
    expect(store.read(projectPath)).toEqual(copy);
  });
});
