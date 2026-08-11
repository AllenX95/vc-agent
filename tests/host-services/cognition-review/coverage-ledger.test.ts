import { describe, expect, it } from "vitest";
import {
  applyCoverageDispositions,
  createCoverageLedger,
  projectCoverageSummary,
  type CoverageDispositionInput
} from "../../../packages/host-services/src/cognition-review/coverage-ledger.js";

const now = "2026-08-11T00:00:00.000Z";

describe("Cognition Review coverage ledger", () => {
  it("requires one terminal disposition for every frozen source", () => {
    const ledger = createCoverageLedger({
      batchId: "batch-1",
      cutoff: now,
      sources: [
        { sourceReference: "thread:t/turn:1", scope: "unscoped", threadId: "t", completedAt: now },
        { sourceReference: "thread:t/turn:2", scope: "unscoped", threadId: "t", completedAt: now }
      ],
      createdAt: now
    });

    const dispositions: CoverageDispositionInput[] = [
      { sourceReference: "thread:t/turn:1", status: "no_signal" },
      { sourceReference: "thread:t/turn:2", status: "represented", proposalIds: ["proposal-1"] }
    ];
    const updated = applyCoverageDispositions(ledger, dispositions, { proposalIds: ["proposal-1"] });

    expect(projectCoverageSummary(updated)).toMatchObject({
      eligibleCount: 2,
      noSignalCount: 1,
      representedCount: 1,
      carriedOverCount: 0,
      pendingCount: 0,
      complete: true
    });
  });
});
