import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CognitionReviewModule } from "../../../packages/host-services/src/cognition-review/cognition-review.js";
import { JournaledFileTransactionAdapter, type JournaledFileTransactionFaultInjection } from "../../../packages/host-services/src/cognition-review/journaled-file-transaction.js";
import { CognitionReviewStore } from "../../../packages/host-services/src/cognition-review/store.js";
import { LongTermMemoryStore } from "../../../packages/host-services/src/long-term-memory.js";
import { MemoryEvolutionStore } from "../../../packages/host-services/src/memory-evolution.js";
import { ProjectMemoryStore } from "../../../packages/host-services/src/project-memory.js";

const at = "2026-08-11T00:00:00.000Z";

describe("Cognition Review journaled commit", () => {
  it("commits a Reflection Judgment Record when no learning proposal is adopted", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-cognition-commit-"));
    try {
      const module = fixture(root);
      const review = module.prepare({
        kind: "reflection",
        judgment: {
          id: "judgment-only",
          title: "Investment View",
          judgment: "Hold",
          rationale: ["Evidence is mixed."],
          uncertainty: [],
          evidenceReferences: [],
          createdAt: at
        },
        proposals: [],
        dependencies: []
      });
      module.decide(review.id, []);

      const result = module.commit(review.id);
      expect(result.status).toBe("committed");
      expect(readFileSync(join(root, "app", "cognition-v2", "judgment-records", "judgment-only.json"), "utf8")).toContain("Investment View");
      expect(existsSync(join(root, "app", "cognition-v2", "reviews", `${review.id}.json`))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("commits a Judgment and an adopted Long-term Memory proposal in one review", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-cognition-commit-"));
    try {
      const module = fixture(root);
      const review = module.prepare({
        kind: "reflection",
        judgment: {
          id: "judgment-learning",
          title: "Learning View",
          judgment: "Use explicit downside cases",
          rationale: ["The evidence supports a reusable process."],
          uncertainty: [],
          evidenceReferences: ["source-1"],
          createdAt: at
        },
        proposals: [{
          id: "proposal-learning",
          title: "Model downside cases",
          content: "Always write a downside case before advancing diligence.",
          applicability: ["early-stage investments"],
          limitations: "Not a substitute for evidence.",
          destination: "long_term_memory",
          action: "add",
          sourceReferences: ["source-1"],
          targetEntryIds: []
        }],
        dependencies: [{ kind: "source", reference: "source-1", hash: "source-v1", required: true }]
      });
      module.decide(review.id, [{ proposalId: "proposal-learning", decision: "adopt" }]);

      const result = module.commit(review.id);
      expect(result).toMatchObject({ status: "committed", adoptedProposalIds: ["proposal-learning"] });
      expect(new LongTermMemoryStore(join(root, "memory", "long-term")).readCurrent().entries).toMatchObject([{ title: "Model downside cases" }]);
      expect(readFileSync(join(root, "app", "cognition-v2", "judgment-records", "judgment-learning.json"), "utf8")).toContain("Learning View");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks the bundle stale and writes nothing when a prepared Memory target changes", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-cognition-commit-"));
    try {
      const module = fixture(root);
      const memoryPath = join(root, "memory", "long-term", "long-term-memory.md");
      const review = module.prepare({
        kind: "reflection",
        judgment: {
          id: "judgment-stale",
          title: "Stale View",
          judgment: "Hold",
          rationale: ["Evidence."],
          uncertainty: [],
          evidenceReferences: ["source-stale"],
          createdAt: at
        },
        proposals: [{
          id: "proposal-stale",
          title: "Stale learning",
          content: "This must not be published after a target edit.",
          applicability: ["venture"],
          limitations: "None",
          destination: "long_term_memory",
          action: "add",
          sourceReferences: ["source-stale"],
          targetEntryIds: []
        }],
        dependencies: [{ kind: "source", reference: "source-stale", hash: "v1", required: true }]
      });
      module.decide(review.id, [{ proposalId: "proposal-stale", decision: "adopt" }]);
      writeFileSync(memoryPath, `${readFileSync(memoryPath, "utf8")}\nmanual edit\n`, "utf8");

      const result = module.commit(review.id);
      expect(result.status).toBe("stale");
      expect(existsSync(join(root, "app", "cognition-v2", "judgment-records", "judgment-stale.json"))).toBe(false);
      expect(readFileSync(memoryPath, "utf8")).toContain("manual edit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("revalidates Host-captured dependency hashes before publication", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-cognition-commit-"));
    try {
      let dependencyHash = "v1";
      const store = new CognitionReviewStore(join(root, "app"));
      const memory = new LongTermMemoryStore(join(root, "memory", "long-term"));
      const evolution = new MemoryEvolutionStore(memory, { now: () => new Date(at) });
      const projectMemory = new ProjectMemoryStore(join(root, "memory", "project-index"));
      const transaction = new JournaledFileTransactionAdapter({ transactionRoot: join(root, "transactions"), allowedRoots: [root] });
      const module = new CognitionReviewModule({
        store,
        memory,
        evolution,
        projectMemory,
        transaction,
        now: () => new Date(at),
        resolveDependency: () => ({ hash: dependencyHash })
      });
      const review = module.prepare({
        kind: "reflection",
        judgment: { id: "judgment-dependency", title: "Dependency", judgment: "Hold", rationale: ["Evidence."], uncertainty: [], evidenceReferences: ["source-dependency"], createdAt: at },
        proposals: [],
        dependencies: [{ kind: "source", reference: "source-dependency", hash: "model-declared-hash", required: true }]
      });
      module.decide(review.id, []);
      dependencyHash = "v2";

      const result = module.commit(review.id);
      expect(result.status).toBe("stale");
      expect(existsSync(join(root, "app", "cognition-v2", "judgment-records", "judgment-dependency.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks a prepared review stale when a required dependency can no longer be resolved", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-cognition-commit-"));
    try {
      let dependencyAvailable = true;
      const store = new CognitionReviewStore(join(root, "app"));
      const memory = new LongTermMemoryStore(join(root, "memory", "long-term"));
      const evolution = new MemoryEvolutionStore(memory, { now: () => new Date(at) });
      const projectMemory = new ProjectMemoryStore(join(root, "memory", "project-index"));
      const transaction = new JournaledFileTransactionAdapter({ transactionRoot: join(root, "transactions"), allowedRoots: [root] });
      const module = new CognitionReviewModule({
        store,
        memory,
        evolution,
        projectMemory,
        transaction,
        now: () => new Date(at),
        resolveDependency: () => dependencyAvailable ? { hash: "v1" } : undefined
      });
      const review = module.prepare({
        kind: "reflection",
        judgment: { id: "judgment-missing-dependency", title: "Dependency", judgment: "Hold", rationale: ["Evidence."], uncertainty: [], evidenceReferences: ["source-dependency"], createdAt: at },
        proposals: [],
        dependencies: [{ kind: "source", reference: "source-dependency", hash: "model-declared-hash", required: true }]
      });
      module.decide(review.id, []);
      dependencyAvailable = false;

      const result = module.commit(review.id);
      expect(result.status).toBe("stale");
      expect(existsSync(join(root, "app", "cognition-v2", "judgment-records", "judgment-missing-dependency.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a failed commit without partial cognition after an activation fault", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-cognition-commit-"));
    try {
      const store = new CognitionReviewStore(join(root, "app"));
      const memory = new LongTermMemoryStore(join(root, "memory", "long-term"));
      const evolution = new MemoryEvolutionStore(memory, { now: () => new Date(at) });
      const projectMemory = new ProjectMemoryStore(join(root, "memory", "project-index"));
      const fault: JournaledFileTransactionFaultInjection = { phase: "commit-point", beforeCommitPoint: true, mode: "throw" };
      const transaction = new JournaledFileTransactionAdapter({ transactionRoot: join(root, "transactions"), allowedRoots: [root], faultInjection: fault });
      const module = new CognitionReviewModule({ store, memory, evolution, projectMemory, transaction, now: () => new Date(at) });
      const review = module.prepare({
        kind: "reflection",
        judgment: { id: "judgment-fault", title: "Fault", judgment: "Hold", rationale: ["Evidence."], uncertainty: [], evidenceReferences: ["source-fault"], createdAt: at },
        proposals: [{
          id: "proposal-fault",
          title: "Fault learning",
          content: "Must remain unpublished.",
          applicability: ["venture"],
          limitations: "None",
          destination: "long_term_memory",
          action: "add",
          sourceReferences: ["source-fault"],
          targetEntryIds: []
        }],
        dependencies: [{ kind: "source", reference: "source-fault", hash: "v1", required: true }]
      });
      module.decide(review.id, [{ proposalId: "proposal-fault", decision: "adopt" }]);
      const memoryBefore = readFileSync(join(root, "memory", "long-term", "long-term-memory.md"), "utf8");

      const result = module.commit(review.id);
      expect(result.status).toBe("failed");
      expect(existsSync(join(root, "app", "cognition-v2", "judgment-records", "judgment-fault.json"))).toBe(false);
      expect(readFileSync(join(root, "memory", "long-term", "long-term-memory.md"), "utf8")).toBe(memoryBefore);
      expect(store.loadReviewBundle(review.id)?.status).toBe("prepared");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function fixture(root: string): CognitionReviewModule {
  const store = new CognitionReviewStore(join(root, "app"));
  const memory = new LongTermMemoryStore(join(root, "memory", "long-term"));
  const evolution = new MemoryEvolutionStore(memory, { now: () => new Date(at) });
  const projectMemory = new ProjectMemoryStore(join(root, "memory", "project-index"));
  const transaction = new JournaledFileTransactionAdapter({ transactionRoot: join(root, "transactions"), allowedRoots: [root] });
  return new CognitionReviewModule({ store, memory, evolution, projectMemory, transaction, now: () => new Date(at) });
}
