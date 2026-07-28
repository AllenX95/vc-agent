import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareProjectCommand } from "../../apps/utility-worker/src/project-command.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Utility Worker Project command boundary", () => {
  it("builds fixed executable arguments without a shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-command-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "outputs"));

    const prepared = await prepareProjectCommand(root, {
      program: "rg",
      query: "execution risk",
      path: "outputs",
      glob: "*.md",
      ignoreCase: true
    });

    expect(prepared).toMatchObject({
      executable: "rg",
      cwd: root,
      args: expect.arrayContaining(["--line-number", "--ignore-case", "--glob", "*.md", "execution risk"])
    });
    expect(prepared).not.toHaveProperty("shell");
  });

  it("rejects path traversal and junction escape before spawning", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "vc-agent-command-scope-"));
    temporaryDirectories.push(sandbox);
    const root = join(sandbox, "project");
    const outside = join(sandbox, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "outside");
    symlinkSync(outside, join(root, "linked-outside"), "junction");

    await expect(prepareProjectCommand(root, { program: "pdfinfo", path: "../outside/secret.txt" }))
      .rejects.toThrow(/outside the active Project/i);
    await expect(prepareProjectCommand(root, { program: "rg", query: "outside", path: "linked-outside", ignoreCase: false }))
      .rejects.toThrow(/outside the active Project/i);
  });

  it("permits only read-only Git operations through the contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-command-git-"));
    temporaryDirectories.push(root);
    const status = await prepareProjectCommand(root, { program: "git", operation: "status", maxCount: 20 });

    expect(status.args).toEqual([
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=NUL",
      "-c", "submodule.recurse=false",
      "-C", root,
      "--no-pager",
      "status",
      "--short"
    ]);
  });
});
