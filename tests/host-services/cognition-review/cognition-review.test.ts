import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CognitionReviewModule } from "../../../packages/host-services/src/cognition-review/cognition-review.js";
import { CognitionReviewStore } from "../../../packages/host-services/src/cognition-review/store.js";
import { JournaledFileTransactionAdapter } from "../../../packages/host-services/src/cognition-review/journaled-file-transaction.js";
import { LongTermMemoryStore } from "../../../packages/host-services/src/long-term-memory.js";
import { MemoryEvolutionStore } from "../../../packages/host-services/src/memory-evolution.js";
import { ProjectMemoryStore } from "../../../packages/host-services/src/project-memory.js";

const at = "2026-08-11T00:00:00.000Z";

describe("CognitionReviewModule interface", () => {
  it("prepares a Reflection review and discards it without creating cognition", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-cognition-review-"));
    try {
      const store = new CognitionReviewStore(join(root, "app"));
      const memory = new LongTermMemoryStore(join(root, "memory", "long-term"));
      const evolution = new MemoryEvolutionStore(memory, { now: () => new Date(at) });
      const projectMemory = new ProjectMemoryStore(join(root, "memory", "project-index"));
      const transaction = new JournaledFileTransactionAdapter({
        transactionRoot: join(root, "transactions"),
        allowedRoots: [root]
      });
      const module = new CognitionReviewModule({
        store,
        memory,
        evolution,
        projectMemory,
        transaction,
        now: () => new Date(at)
      });

      const review = module.prepare({
        kind: "reflection",
        judgment: {
          id: "judgment-1",
          title: "View",
          judgment: "Hold",
          rationale: ["Evidence is mixed."],
          uncertainty: ["Small sample."],
          evidenceReferences: [],
          createdAt: at
        },
        proposals: [],
        dependencies: []
      });
      expect(review.status).toBe("reviewing");

      const prepared = module.decide(review.id, []);
      expect(prepared.status).toBe("prepared");
      module.discard(review.id);

      expect(store.loadReviewBundle(review.id)?.status).toBe("discarded");
      expect(store.listReviewBundles()).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires exact terminal coverage and carries deferred sources while committing the cutoff", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-cognition-review-"));
    try {
      const store = new CognitionReviewStore(join(root, "app"));
      const memory = new LongTermMemoryStore(join(root, "memory", "long-term"));
      const evolution = new MemoryEvolutionStore(memory, { now: () => new Date(at) });
      const projectMemory = new ProjectMemoryStore(join(root, "memory", "project-index"));
      const transaction = new JournaledFileTransactionAdapter({ transactionRoot: join(root, "transactions"), allowedRoots: [root] });
      const module = new CognitionReviewModule({ store, memory, evolution, projectMemory, transaction, now: () => new Date(at) });
      const sourceOne = source("source-one");
      const sourceTwo = source("source-two");
      const sourceThree = source("source-three");
      const ledger = {
        schemaVersion: 1 as const,
        batchId: "batch-one",
        cutoff: at,
        createdAt: at,
        updatedAt: at,
        entries: [
          { ...sourceOne, status: "represented" as const, proposalIds: ["proposal-one"], updatedAt: at },
          { ...sourceTwo, status: "represented" as const, proposalIds: ["proposal-two"], updatedAt: at },
          { ...sourceThree, status: "carried_over" as const, proposalIds: [], dispositionReason: "source unavailable during extraction", updatedAt: at }
        ]
      };
      expect(() => module.prepare({
        kind: "memory_review",
        cutoff: at,
        sources: [sourceToInput(sourceOne)],
        coverageLedger: ledger,
        proposals: [proposal("proposal-one", "source-one"), proposal("proposal-two", "source-two")]
      })).toThrow("COGNITION_MEMORY_COVERAGE_SOURCE_SET_MISMATCH");
      const review = module.prepare({
        kind: "memory_review",
        cutoff: at,
        sources: [sourceToInput(sourceOne), sourceToInput(sourceTwo), sourceToInput(sourceThree)],
        coverageLedger: ledger,
        proposals: [proposal("proposal-one", "source-one"), proposal("proposal-two", "source-two")]
      });
      expect(review.coverage?.complete).toBe(true);
      module.decide(review.id, [
        { proposalId: "proposal-one", decision: "reject" },
        { proposalId: "proposal-two", decision: "defer" }
      ]);
      const result = module.commit(review.id);
      expect(result).toMatchObject({ status: "committed", cutoff: at, carriedOverSourceReferences: ["source-two", "source-three"] });
      expect(store.loadCoverageLedger("batch-one")?.entries.map((entry) => [entry.sourceReference, entry.status])).toEqual([
        ["source-one", "no_signal"],
        ["source-two", "carried_over"],
        ["source-three", "carried_over"]
      ]);
      expect(readFileSync(join(root, "app", "cognition-v2", "committed-cutoff.json"), "utf8")).toContain(at);
      expect(existsSync(join(root, "memory", "long-term", "long-term-memory.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds one global review lease and promotes completed analysis after commit", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-cognition-review-"));
    try {
      const store = new CognitionReviewStore(join(root, "app"));
      const memory = new LongTermMemoryStore(join(root, "memory", "long-term"));
      const evolution = new MemoryEvolutionStore(memory, { now: () => new Date(at) });
      const projectMemory = new ProjectMemoryStore(join(root, "memory", "project-index"));
      const transaction = new JournaledFileTransactionAdapter({ transactionRoot: join(root, "transactions"), allowedRoots: [root] });
      const module = new CognitionReviewModule({ store, memory, evolution, projectMemory, transaction, now: () => new Date(at) });
      const makeReflection = (id: string) => ({
        kind: "reflection" as const,
        judgment: { id, title: id, judgment: "Hold", rationale: ["Evidence."], uncertainty: [], evidenceReferences: [], createdAt: at },
        proposals: [],
        dependencies: []
      });
      const first = module.prepare(makeReflection("lease-one"));
      const second = module.prepare(makeReflection("lease-two"));
      expect(first.status).toBe("reviewing");
      expect(second.status).toBe("analysis_completed");
      module.decide(first.id, []);
      module.commit(first.id);
      expect(store.loadReviewBundle(second.id)?.status).toBe("waiting_for_review");
      const third = module.prepare(makeReflection("lease-three"));
      expect(third.status).toBe("analysis_completed");
      module.decide(second.id, []);
      expect(store.loadReviewBundle(second.id)?.status).toBe("prepared");
      expect(store.loadReviewBundle(third.id)?.status).toBe("analysis_completed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function source(sourceReference: string) {
  return {
    sourceReference,
    sourceKind: "ordinary_exchange" as const,
    scope: "unscoped" as const,
    threadId: "thread-1",
    turnId: sourceReference,
    completedAt: at,
    status: "pending" as const,
    proposalIds: [] as string[],
    availability: "available" as const
  };
}

function sourceToInput(entry: ReturnType<typeof source>) {
  return {
    sourceReference: entry.sourceReference,
    sourceKind: entry.sourceKind,
    scope: entry.scope,
    threadId: entry.threadId,
    turnId: entry.turnId,
    completedAt: entry.completedAt
  };
}

function proposal(id: string, sourceReference: string) {
  return {
    id,
    title: id,
    content: `Learning ${id}`,
    applicability: ["venture"],
    limitations: "None",
    destination: "long_term_memory" as const,
    action: "add" as const,
    sourceReferences: [sourceReference],
    targetEntryIds: []
  };
}
