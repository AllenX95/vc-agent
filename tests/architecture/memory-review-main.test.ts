import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const mainSource = () => readFileSync(resolve(process.cwd(), "apps/desktop/src/main/main.ts"), "utf8");

describe("Memory Review desktop composition", () => {
  it("composes intent-level prepare/cancel/policy commands through the shared orchestrator", () => {
    const source = mainSource();
    expect(source).toContain("MemoryReviewOrchestrator");
    expect(source).toContain("case \"memory_review.prepare\":");
    expect(source).toContain("case \"memory_review.cancel\":");
    expect(source).toContain("case \"memory_review.policy.set\":");
    expect(source).toContain("stateStore.setAutoMemoryReviewPolicy");
    expect(source).toContain("memoryReviewOrchestrator.prepareAutomatically");
    expect(source).toContain("createMemoryReviewOrchestrator");
    expect(source).not.toContain("executeMemoryReviewExtraction");
    expect(source).not.toContain("executeMemoryReviewSynthesis");
    expect(source).toContain("loadCommittedCutoff");
    expect(source).toContain("markThreadSourcesDeleted");
    expect(source).toContain('runs.filter((run) => run.status === "completed")');
    expect(source).not.toContain("Memory Review preparation is not available yet.");
    expect(source).not.toContain("Memory Review policy storage is not available yet.");
  });

  it("keeps automatic model admission after user work and scheduler idle", () => {
    const source = mainSource();
    expect(source).toContain("evaluateAutomaticMemoryReview");
    expect(source).toContain("userWorkCompletedInAppRun");
    expect(source).toContain("executionIdle");
    expect(source).toContain("kind: \"internal_model_stage\"");
  });

  it("keeps Cognition Review terminal transitions scoped to their owning workflow", () => {
    const source = mainSource();
    expect(source).toContain("const reflectionRun = reflectionRunForReview(command.payload.reviewId);");
    expect(source).toContain("reflectionRuns.discard(reflectionRun.id)");
    expect(source).toContain('markMemoryReviewRunTerminal(command.payload.reviewId, "cancelled")');
    expect(source).toContain("reflectionRuns.complete(run.id)");
    expect(source).not.toContain("reflectionRuns.complete(run.id, command.payload.reviewId)");
  });

  it("executes each Memory Review stage with the frozen Profile snapshot", () => {
    const source = mainSource();
    const start = source.indexOf("function runMemoryReviewModel(");
    const end = source.indexOf("function settleMemoryReviewWorkerStage", start);
    const runModel = source.slice(start, end);
    expect(runModel).toContain("input.profileSnapshot.thinkingLevel");
    expect(runModel).toContain("input.profileSnapshot.contextWindow");
    expect(runModel).toContain("input.profileSnapshot.maxOutputTokens");
    expect(runModel).toContain("MEMORY_REVIEW_FROZEN_CONFIGURATION_UNAVAILABLE");
    expect(runModel).not.toContain("toWorkerModelProfile(profile,");
  });
});
