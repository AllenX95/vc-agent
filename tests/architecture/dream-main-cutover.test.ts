import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const mainSource = () => readFileSync(resolve(process.cwd(), "apps/desktop/src/main/main.ts"), "utf8");

describe("cognition-v2 main runtime cutover", () => {
  it("removes the retired Dream runtime from the desktop composition", () => {
    const source = mainSource();
    expect(source).not.toMatch(/dream/iu);
    expect(source).not.toContain("MemoryReviewService");
    expect(source).not.toContain('kind: "dream_scope"');
    expect(source).not.toContain('kind: "dream_synthesis"');
  });

  it("keeps only the intent-level Reflection commands at the IPC boundary", () => {
    const source = mainSource();
    for (const command of ["reflection.start", "reflection.finish", "reflection.discard"]) {
      expect(source).toContain(`case "${command}":`);
    }
    for (const command of [
      "reflection.list",
      "reflection.start.project",
      "reflection.start.unscoped",
      "reflection.independent.start",
      "reflection.independent.stop",
      "reflection.memory_aware.start",
      "reflection.outcome.list",
      "reflection.outcome.discard",
      "reflection.judgment.confirm",
      "reflection.learning.prepare_patch"
    ]) {
      expect(source).not.toContain(`case "${command}":`);
    }
  });

  it("uses the generic internal model stage for Reflection execution admission", () => {
    const source = mainSource();
    expect(source).not.toContain('kind: "independent_evidence"');
    expect(source).not.toContain('kind: "memory_aware_reflection"');
    expect(source).toContain('kind: "internal_model_stage"');
  });
});
