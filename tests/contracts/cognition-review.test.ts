import { describe, expect, it } from "vitest";
import {
  autoMemoryReviewPolicySchema,
  coverageLedgerSchema,
  eligibleLearningSourceSchema,
  extractionChunkResultSchema,
  learningEpochSchema,
  reviewBundleSchema
} from "@vc-agent/contracts";

const at = "2026-08-11T00:00:00.000Z";

describe("Cognition Review contracts", () => {
  it("keeps the Learning Epoch and source index content-free", () => {
    expect(learningEpochSchema.parse({ schemaVersion: 1, learningEpochStartedAt: at })).toEqual({
      schemaVersion: 1,
      learningEpochStartedAt: at
    });
    expect(eligibleLearningSourceSchema.safeParse({
      sourceReference: "thread:t/turn:1",
      sourceKind: "ordinary_exchange",
      scope: "unscoped",
      threadId: "t",
      completedAt: at,
      userText: "must not be indexed"
    }).success).toBe(false);
  });

  it("rejects invalid strict coverage and represented extraction results", () => {
    expect(coverageLedgerSchema.safeParse({
      schemaVersion: 1,
      batchId: "batch",
      cutoff: at,
      createdAt: at,
      updatedAt: at,
      entries: [{
        sourceReference: "source",
        sourceKind: "ordinary_exchange",
        scope: "unscoped",
        threadId: "thread",
        completedAt: at,
        status: "represented",
        proposalIds: [],
        availability: "available",
        updatedAt: at
      }]
    }).success).toBe(false);
    expect(extractionChunkResultSchema.safeParse({
      schemaVersion: 1,
      chunkId: "chunk",
      completedAt: at,
      dispositions: [{ sourceReference: "source", status: "represented" }]
    }).success).toBe(false);
  });

  it("validates automatic review policy and prepared Reflection bundles", () => {
    expect(autoMemoryReviewPolicySchema.parse({
      enabled: false,
      profileId: "memory-profile",
      minEligibleExchangeCount: 20,
      maxIntervalDays: 7,
      maxInputTokensPerRun: 10_000
    }).enabled).toBe(false);
    const bundle = reviewBundleSchema.parse({
      id: "review",
      kind: "reflection",
      status: "prepared",
      judgment: {
        id: "judgment",
        title: "View",
        judgment: "unchanged",
        rationale: ["evidence"],
        uncertainty: [],
        evidenceReferences: [],
        createdAt: at
      },
      proposals: [],
      decisions: [],
      dependencies: [],
      createdAt: at,
      updatedAt: at
    });
    expect(bundle.kind).toBe("reflection");
  });
});
