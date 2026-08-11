import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");
const present = (relative: string) => existsSync(resolve(root, relative));

describe("Cognition v2 public-surface cutover", () => {
  it("removes retired Dream and legacy Reflection contracts", () => {
    const index = read("packages/contracts/src/index.ts");
    const ipc = read("packages/contracts/src/ipc.ts");
    expect(index).not.toMatch(/(?:dream\.ts|dream-workflow\.ts)/iu);
    expect(ipc).not.toMatch(/(?:dream_scope|dream_synthesis|reflection\.independent|reflection\.memory_aware|reflection\.outcome|reflection\.judgment|reflection\.learning\.prepare_patch)/iu);
    expect(present("packages/contracts/src/dream.ts")).toBe(false);
    expect(present("packages/contracts/src/dream-workflow.ts")).toBe(false);
  });

  it("makes ReviewBundle commit the only model-derived Memory write authority", () => {
    const ipc = read("packages/contracts/src/ipc.ts");
    const main = read("apps/desktop/src/main/main.ts");
    const renderer = read("apps/desktop/src/renderer/App.tsx");
    for (const source of [ipc, main, renderer]) {
      expect(source).not.toMatch(/long_term_memory\.patch\.(?:prepare|commit|discard)/u);
      expect(source).not.toContain("project.memory.append.confirm");
    }
  });

  it("exposes no retired Dream, shallow Memory Review, or ReflectionOutcome authority", () => {
    const index = read("packages/host-services/src/index.ts");
    expect(index).not.toMatch(/(?:DreamReviewStore|DreamCommitStore|buildDream|DREAM_|MemoryReviewService|ReflectionOutcomeStore|reflection-outcomes)/u);
    expect(index).toContain("createMemoryReviewOrchestrator");
    expect(index).not.toMatch(/(?:FileMemoryReviewRunStore|executeMemoryReviewExtraction|executeMemoryReviewSynthesis|createCoverageLedger|JournaledFileTransactionAdapter)/u);
    for (const relative of [
      "packages/host-services/src/memory-review.ts",
      "packages/host-services/src/dream-eligibility.ts",
      "packages/host-services/src/dream-review.ts",
      "packages/host-services/src/dream-extraction.ts",
      "packages/host-services/src/dream-synthesis.ts",
      "packages/host-services/src/dream-commit.ts",
      "packages/host-services/src/reflection-outcomes.ts",
      "packages/host-services/src/reflection-staleness.ts"
    ]) expect(present(relative)).toBe(false);
  });

  it("does not recreate the retired reflection_runs persistence authority", () => {
    const runtime = read("packages/persistence/src/index.ts");
    expect(runtime).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+reflection_runs/iu);
    expect(runtime).not.toMatch(/(?:CREATE|SELECT|INSERT|UPDATE|DELETE|ALTER)[^;\n]*reflection_runs/iu);
    const migration = read("packages/persistence/src/state-migration.ts");
    // One explicit destructive cutover is intentional: old Reflection data is
    // dropped once, then the runtime must never recreate or query that table.
    expect(migration).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+reflection_runs/iu);
    expect(migration).not.toMatch(/(?:CREATE|SELECT|INSERT|UPDATE|DELETE|ALTER)[^;\n]*reflection_runs/iu);
  });
});
