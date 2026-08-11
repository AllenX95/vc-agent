import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LearningEpochReset } from "../../../packages/host-services/src/cognition-review/reset.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vc-agent-learning-epoch-"));
  roots.push(root);
  const project = join(root, "project");
  const output = join(root, "unscoped-output");
  mkdirSync(join(root, "memory", "long-term"), { recursive: true });
  mkdirSync(join(root, "memory", "dream"), { recursive: true });
  mkdirSync(join(root, "cognition-v2", "reviews"), { recursive: true });
  mkdirSync(join(project, "outputs", "system", "judgment-records"), { recursive: true });
  mkdirSync(join(output, "judgment-records"), { recursive: true });
  writeFileSync(join(root, "memory", "long-term", "long-term-memory.md"), "legacy memory", "utf8");
  writeFileSync(join(root, "memory", "dream", "review-state.json"), "legacy dream", "utf8");
  writeFileSync(join(root, "cognition-v2", "reviews", "old.json"), "legacy v2", "utf8");
  writeFileSync(join(project, "outputs", "system", "project-memory.md"), "legacy project memory", "utf8");
  writeFileSync(join(project, "outputs", "system", "judgment-records", "old.json"), "legacy judgment", "utf8");
  writeFileSync(join(output, "judgment-records", "old.json"), "legacy judgment", "utf8");
  const trajectory = join(root, "threads", "thread-1", "events.jsonl");
  const material = join(project, "materials", "memo.md");
  mkdirSync(join(root, "threads", "thread-1"), { recursive: true });
  mkdirSync(join(project, "materials"), { recursive: true });
  writeFileSync(trajectory, "ordinary trajectory\n", "utf8");
  writeFileSync(material, "ordinary material\n", "utf8");
  return { root, project, output, trajectory, material };
}

describe("LearningEpochReset", () => {
  it("logically deletes legacy cognition while preserving ordinary bytes", () => {
    const item = fixture();
    let status: "pending_reset" | "active" | "failed_reset" = "pending_reset";
    const reset = new LearningEpochReset({
      appDataRoot: item.root,
      projectRoots: [item.project],
      unscopedOutputRoots: [item.output],
      stateStore: { getCognitionCutoverStatus: () => status, setCognitionCutoverStatus: (next) => { status = next; } },
      now: () => new Date("2026-08-11T00:00:00.000Z")
    });
    const result = reset.reset();
    expect(result.status).toBe("reset");
    expect(status).toBe("active");
    expect(existsSync(join(item.root, "memory", "long-term"))).toBe(false);
    expect(existsSync(join(item.project, "outputs", "system", "project-memory.md"))).toBe(false);
    expect(existsSync(join(item.project, "outputs", "system", "judgment-records"))).toBe(false);
    expect(existsSync(join(item.output, "judgment-records"))).toBe(false);
    expect(readFileSync(item.trajectory, "utf8")).toBe("ordinary trajectory\n");
    expect(readFileSync(item.material, "utf8")).toBe("ordinary material\n");
    expect(JSON.parse(readFileSync(join(item.root, "cognition-v2", "epoch.json"), "utf8"))).toMatchObject({ schemaVersion: 1, learningEpochStartedAt: "2026-08-11T00:00:00.000Z", status: "active" });
  });

  it("treats an active epoch marker as steady state after the reset manifest is cleaned", () => {
    const item = fixture();
    let status: "pending_reset" | "active" | "failed_reset" = "pending_reset";
    const options = {
      appDataRoot: item.root,
      projectRoots: [item.project],
      unscopedOutputRoots: [item.output],
      stateStore: { getCognitionCutoverStatus: () => status, setCognitionCutoverStatus: (next: typeof status) => { status = next; } },
      now: () => new Date("2026-08-11T00:00:00.000Z")
    };
    expect(new LearningEpochReset(options).reset().status).toBe("reset");
    const retained = join(item.root, "cognition-v2", "reviews", "retained.json");
    writeFileSync(retained, "new v2 review", "utf8");

    const restarted = new LearningEpochReset(options);
    const result = restarted.reset();
    expect(result.status).toBe("already_active");
    expect(readFileSync(retained, "utf8")).toBe("new v2 review");
  });

  it("enters recovery instead of deleting v2 state when an active epoch file is invalid", () => {
    const item = fixture();
    let status: "pending_reset" | "active" | "failed_reset" = "active";
    const retained = join(item.root, "cognition-v2", "reviews", "retained.json");
    writeFileSync(retained, "new v2 review", "utf8");
    writeFileSync(join(item.root, "cognition-v2", "epoch.json"), "{}", "utf8");
    const reset = new LearningEpochReset({
      appDataRoot: item.root,
      stateStore: { getCognitionCutoverStatus: () => status, setCognitionCutoverStatus: (next) => { status = next; } },
      now: () => new Date("2026-08-11T00:00:00.000Z")
    });

    const result = reset.reset();
    expect(result.status).toBe("blocked");
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "RESET_ACTIVE_EPOCH_INVALID")).toBe(true);
    expect(readFileSync(retained, "utf8")).toBe("new v2 review");
  });

  it("rejects symlink targets before activation", () => {
    const item = fixture();
    const outside = mkdtempSync(join(tmpdir(), "vc-agent-learning-outside-"));
    roots.push(outside);
    rmSync(join(item.root, "memory", "dream"), { recursive: true, force: true });
    symlinkSync(outside, join(item.root, "memory", "dream"), "junction");
    const reset = new LearningEpochReset({ appDataRoot: item.root, now: () => new Date("2026-08-11T00:00:00.000Z") });
    const inspection = reset.inspect();
    expect(inspection.status).toBe("blocked");
    expect(inspection.diagnostics.some((diagnostic) => diagnostic.code === "RESET_PATH_SYMLINK")).toBe(true);
    expect(existsSync(join(outside, "sentinel"))).toBe(false);
  });

  it("rolls back an injected activation fault and can retry after restart", () => {
    const item = fixture();
    const reset = new LearningEpochReset({ appDataRoot: item.root, faultInjection: { phase: "activation", after: 1 }, now: () => new Date("2026-08-11T00:00:00.000Z") });
    expect(reset.reset().status).toBe("failed_reset");
    expect(readFileSync(join(item.root, "memory", "long-term", "long-term-memory.md"), "utf8")).toBe("legacy memory");
    const retry = new LearningEpochReset({ appDataRoot: item.root, now: () => new Date("2026-08-11T00:00:00.000Z") });
    expect(retry.reset().status).toBe("reset");
  });

  it("restores the already-open state rollback seam when reset fails", () => {
    const item = fixture();
    let rollbackCalls = 0;
    let status: "pending_reset" | "active" | "failed_reset" = "pending_reset";
    const reset = new LearningEpochReset({
      appDataRoot: item.root,
      stateStore: { getCognitionCutoverStatus: () => status, setCognitionCutoverStatus: (next) => { status = next; } },
      rollbackState: () => { rollbackCalls += 1; return true; },
      faultInjection: { phase: "activation", after: 1 },
      now: () => new Date("2026-08-11T00:00:00.000Z")
    });

    const result = reset.reset();
    expect(result.status).toBe("failed_reset");
    expect(rollbackCalls).toBe(1);
    expect(status).toBe("failed_reset");
    expect(existsSync(join(item.root, "cognition-v2", "epoch.json"))).toBe(false);
    expect(readFileSync(join(item.root, "memory", "long-term", "long-term-memory.md"), "utf8")).toBe("legacy memory");
  });

  it("recovers a crash journal before admitting a new epoch", () => {
    const item = fixture();
    const crashing = new LearningEpochReset({ appDataRoot: item.root, faultInjection: { phase: "activation", after: 1, mode: "crash" }, now: () => new Date("2026-08-11T00:00:00.000Z") });
    expect(crashing.reset().status).toBe("failed_reset");
    expect(existsSync(join(item.root, ".cognition-reset", "manifest.json"))).toBe(true);
    expect(existsSync(join(item.root, "cognition-v2", "epoch.json"))).toBe(false);

    const restarted = new LearningEpochReset({ appDataRoot: item.root, now: () => new Date("2026-08-11T00:00:00.000Z") });
    expect(existsSync(join(item.root, ".cognition-reset", "manifest.json"))).toBe(false);
    expect(readFileSync(join(item.root, "memory", "long-term", "long-term-memory.md"), "utf8")).toBe("legacy memory");
    expect(restarted.reset().status).toBe("reset");
  });
});
