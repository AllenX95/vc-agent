import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Reflection cognition cutover", () => {
  it("routes Reflection outcomes through CognitionReviewModule instead of direct outcome writes", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/main/main.ts"), "utf8");
    expect(source).toContain("prepareReflectionCognitionBundle");
    expect(source).toContain("cognitionReviews.prepare(input)");
    expect(source).toContain('event: "cognition_review.commit.result"');
    expect(source).not.toContain("reflectionOutcomes.confirmJudgment");
    expect(source).not.toContain("reflectionOutcomes.markPatchPrepared");
    const finish = source.match(/case "reflection\.finish"[\s\S]{0,1500}/u)?.[0] ?? "";
    expect(finish).toContain("prepareReflectionCognitionBundle(run)");
    expect(source).not.toContain('case "reflection.judgment.confirm"');
    expect(source).not.toContain('case "reflection.learning.prepare_patch"');
    expect(source).not.toContain('event: "reflection.outcomes.updated"');
  });

  it("does not use HostStateStore reflection lifecycle methods", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/main/main.ts"), "utf8");
    expect(source).not.toMatch(/stateStore!?\.(?:createReflectionRun|getReflectionRun|getReflectionRunByThread|listReflectionRuns|markReflectionRunning|startMemoryAwareReflection|activateReflectionDialogue|completeIndependentAssessment|failIndependentAssessment|interruptIndependentAssessment|failMemoryAwareReflection|interruptMemoryAwareReflection|discardReflection)\b/u);
    expect(source).toContain("new ReflectionRunStore");
  });
});
