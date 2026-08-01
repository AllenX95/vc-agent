import { describe, expect, it } from "vitest";
import { projectDream, type DreamBatch } from "@vc-agent/contracts";

const baseBatch = {
  schemaVersion: 1,
  id: "11111111-1111-4111-8111-111111111111",
  status: "review_pending",
  currentStage: "scope_review",
  cutoff: "2026-08-01T00:00:00.000Z",
  promptSnapshot: { revisionId: "22222222-2222-4222-8222-222222222222", hash: "a".repeat(64) },
  profileSnapshot: { id: "profile", name: "Profile", provider: "anthropic", model: "model", thinkingLevel: "off" },
  trajectoryInputs: [], candidateInputs: [], carryoverInputs: [],
  extractionScopes: [], partialCoverageScopeIds: [], representedProjectIds: [], representedScopeCount: 0,
  createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z"
} satisfies Omit<DreamBatch, "synthesis" | "preparedPatch">;

describe("Dream projection", () => {
  it("projects collect, review, and commit without deleting internal facts", () => {
    const collect = projectDream({ ...baseBatch, extractionScopes: [{ id: "scope", kind: "unscoped", threadId: "thread", status: "pending", inputHash: "b".repeat(64), attemptCount: 0, sourceReferences: [], updatedAt: baseBatch.updatedAt }] });
    expect(collect).toMatchObject({ phase: "collect", scopeCount: 1, reviewedScopeCount: 0 });

    const review = projectDream({ ...baseBatch, status: "synthesis_pending", currentStage: "global_synthesis", extractionScopes: [{ id: "scope", kind: "unscoped", threadId: "thread", status: "approved", inputHash: "b".repeat(64), attemptCount: 1, sourceReferences: [], result: { schemaVersion: 1, scopeKind: "unscoped", deidentified: true, summary: "summary", uncertainty: "none", sourceReferences: [], candidates: [] }, updatedAt: baseBatch.updatedAt }] });
    expect(review.phase).toBe("review");

    const commit = projectDream({ ...baseBatch, status: "patch_pending", currentStage: "patch_preparation", preparedPatch: { schemaVersion: 1, id: "33333333-3333-4333-8333-333333333333", status: "prepared", synthesisId: "44444444-4444-4444-8444-444444444444", synthesisInputHash: "c".repeat(64), longTermPatchId: "patch-id", proposalIds: [], partialCoverageScopeReferences: [], files: [], confirmationRequired: true, createdAt: baseBatch.createdAt }, synthesis: { schemaVersion: 1, id: "44444444-4444-4444-8444-444444444444", status: "reviewed", inputHash: "c".repeat(64), longTermMemoryHash: "d".repeat(64), summary: "summary", uncertainty: "none", partialCoverageScopeReferences: [], scopeMap: [], proposals: [], createdAt: baseBatch.createdAt, reviewedAt: baseBatch.updatedAt } });
    expect(commit).toMatchObject({ phase: "commit", patchPrepared: true });
  });
});
