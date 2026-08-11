import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createReflectionDrafts, ReflectionDraftStore } from "../../../packages/host-services/src/cognition-review/reflection-drafts.js";

describe("ReflectionDraftStore", () => {
  it("provides a narrow root-based composition seam", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-reflection-draft-factory-"));
    try {
      const drafts = createReflectionDrafts({ root });
      expect(drafts.list("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toEqual({ judgments: [], learningProposals: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains analysis drafts without exposing confirmation or patch authority", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-reflection-drafts-"));
    try {
      let id = 0;
      const ids = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222"
      ];
      const store = new ReflectionDraftStore(join(root, "reflection-drafts.jsonl"), {
        now: () => new Date("2026-08-11T00:00:00.000Z"),
        createId: () => ids[id++]!
      });
      const created = store.propose("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
        judgmentRecord: {
          view: "Watch",
          reasoning: ["Evidence is limited."],
          uncertainties: [],
          counterarguments: [],
          evidenceReferences: ["material-ref"],
          decisionState: "watch",
          sourceAvailability: "partial"
        },
        learningProposals: []
      });
      expect(created.judgments).toHaveLength(1);
      expect(store.list("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").judgments[0]).toMatchObject({ status: "draft", runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
      expect(existsSync(join(root, "outputs"))).toBe(false);
      expect("confirmJudgment" in store).toBe(false);
      expect("markPatchPrepared" in store).toBe(false);
      expect("markPatchCommitted" in store).toBe(false);
      expect("markPatchDiscarded" in store).toBe(false);

      const discarded = store.discardRunDrafts("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      expect(discarded.judgments[0]?.status).toBe("discarded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
