import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROJECT_READ_TOOL_METADATA,
  PROJECT_READ_TOOL_NAMES,
  createProjectReadToolDefinitions
} from "@vc-agent/pi-adapter";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Project-scoped Pi read tools", () => {
  it("exposes exactly the four read-only default tools as Project-only capabilities", () => {
    expect(PROJECT_READ_TOOL_NAMES).toEqual(["read", "ls", "find", "grep"]);
    expect(PROJECT_READ_TOOL_METADATA.map((entry) => entry.id)).toEqual(PROJECT_READ_TOOL_NAMES);
    expect(PROJECT_READ_TOOL_METADATA.every((entry) =>
      entry.sideEffectClass === "local_read" &&
      entry.executor === "utility" &&
      entry.allowedScopes.length === 1 &&
      entry.allowedScopes[0] === "project"
    )).toBe(true);
  });

  it("reads files inside the Project and rejects absolute paths outside it", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "vc-agent-project-tools-"));
    temporaryDirectories.push(sandbox);
    const projectRoot = join(sandbox, "project");
    const outsideRoot = join(sandbox, "outside");
    mkdirSync(projectRoot);
    mkdirSync(outsideRoot);
    writeFileSync(join(projectRoot, "inside.txt"), "inside project");
    const outsideFile = join(outsideRoot, "outside.txt");
    writeFileSync(outsideFile, "outside project");
    const read = createProjectReadToolDefinitions(projectRoot).find((tool) => tool.name === "read")!;

    const inside = await read.execute("read-inside", { path: "inside.txt" }, undefined, undefined, {} as never);
    expect(inside.content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining("inside project") }));
    await expect(read.execute("read-outside", { path: outsideFile }, undefined, undefined, {} as never))
      .rejects.toThrow(/outside the active Project/i);
  });

  it("rejects a junction or symlink that resolves outside the Project", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "vc-agent-project-link-"));
    temporaryDirectories.push(sandbox);
    const projectRoot = join(sandbox, "project");
    const outsideRoot = join(sandbox, "outside");
    mkdirSync(projectRoot);
    mkdirSync(outsideRoot);
    writeFileSync(join(outsideRoot, "secret.txt"), "must not escape");
    symlinkSync(outsideRoot, join(projectRoot, "linked-outside"), "junction");
    const read = createProjectReadToolDefinitions(projectRoot).find((tool) => tool.name === "read")!;

    await expect(read.execute("read-link", { path: join("linked-outside", "secret.txt") }, undefined, undefined, {} as never))
      .rejects.toThrow(/outside the active Project/i);
  });
});
