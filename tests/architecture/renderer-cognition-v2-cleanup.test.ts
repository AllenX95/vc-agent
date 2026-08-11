import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rendererRoot = resolve(process.cwd(), "apps/desktop/src/renderer");

function readRendererSource(): string {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:css|ts|tsx)$/u.test(entry.name)) files.push(path);
    }
  };
  visit(rendererRoot);
  return files.map((path) => readFileSync(path, "utf8")).join("\n");
}

describe("renderer cognition-v2 cleanup", () => {
  it("does not expose retired Dream or stage-level Reflection commands", () => {
    const source = readRendererSource();
    expect(source).not.toMatch(/\bdream\b/iu);
    expect(source).not.toMatch(/reflection\.(?:memory_aware|outcome|judgment|learning)(?:[.\w-]*)/iu);
    expect(source).not.toContain('command: "reflection.list"');
    expect(source).not.toMatch(/(?:Independent Evidence Profile|Memory-Aware Reflection Profile)/u);
  });

  it("keeps the intent-level Reflection and Cognition Review entry points", () => {
    const source = readRendererSource();
    expect(source).toContain('command: "reflection.start"');
    expect(source).toContain('command: "reflection.finish"');
    expect(source).toContain('command: "memory_review.prepare"');
    expect(source).toContain('command: "cognition_review.commit"');
    expect(source).toContain("/memory-review");
  });
});
