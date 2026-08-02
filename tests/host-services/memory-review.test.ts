import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LongTermMemoryStore, MemoryCandidateStore, MemoryEvolutionStore, MemoryReviewService } from "@vc-agent/host-services";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("MemoryReviewService", () => {
  it("projects candidates separately from adopted and historical Memory", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-memory-review-"));
    roots.push(root);
    const memory = new LongTermMemoryStore(join(root, "memory"));
    const evolution = new MemoryEvolutionStore(memory);
    const candidates = new MemoryCandidateStore(join(root, "candidates.jsonl"));
    const candidate = candidates.capture({ scope: "unscoped", threadId: "thread", turnId: "turn", sourceSnippet: "Review retention cohorts.", signal: "strong_user_judgment" });
    const service = new MemoryReviewService(memory, evolution, { candidates });

    expect(service.listPending()).toMatchObject([{ id: candidate.id, kind: "candidate", provenance: "captured", reviewStatus: "pending" }]);
    expect(service.listAdopted()).toMatchObject({ project: [], global: [] });
    expect(service.history()).toEqual([]);
  });

  it("uses the existing prepare/commit seam and keeps the change explicit", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-memory-review-"));
    roots.push(root);
    const memory = new LongTermMemoryStore(join(root, "memory"));
    const evolution = new MemoryEvolutionStore(memory);
    const service = new MemoryReviewService(memory, evolution);
    const patch = service.prepareChange({
      action: "add",
      targetEntryIds: [],
      proposed: { id: "ltm-explicit-review", title: "Explicit review", date: "2026-08-01", tags: ["review"], applicability: ["VC"], maturity: "user-confirmed", recallPolicy: "automatic", limitations: "None stated.", content: "Commit only after a visible review.", sourceReferenceIds: [] },
      rationale: "The User reviewed this change."
    });
    expect(patch.confirmationRequired).toBe(true);
    expect(service.commit(patch.id).entries.some((entry) => entry.id === "ltm-explicit-review")).toBe(true);
  });
});
