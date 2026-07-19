import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReflectionOutcomeStore } from "@vc-agent/host-services";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vc-agent-reflection-outcomes-"));
  temporaryDirectories.push(root);
  let sequence = 0;
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333"
  ];
  return {
    root,
    store: new ReflectionOutcomeStore(join(root, "app-data", "outcomes.jsonl"), {
      now: () => new Date("2026-07-19T08:00:00.000Z"),
      createId: () => ids[sequence++]!
    })
  };
}

const proposal = {
  judgmentRecord: {
    view: "Retention evidence is promising but not yet representative.",
    reasoning: ["The observed cohort is small."],
    uncertainties: ["Month-six retention may regress."],
    counterarguments: ["Early cohorts can understate product maturity."],
    evidenceReferences: ["material-retention-table"],
    decisionState: "watch" as const,
    sourceAvailability: "partial" as const
  },
  learningProposals: [{
    action: "add" as const,
    targetEntryIds: [],
    proposed: {
      id: "ltm-retention-threshold",
      title: "Require representative retention",
      date: "2026-07-19",
      tags: ["retention"],
      applicability: ["early-stage software"],
      maturity: "evidence-backed" as const,
      recallPolicy: "automatic" as const,
      limitations: "Thresholds vary by product category.",
      content: "Require month-six retention from a representative cohort before conviction increases."
    },
    rationale: "Confirmed during Reflection.",
    comparisonSummary: "No active Memory entry encodes this representative-cohort requirement."
  }]
};

describe("ReflectionOutcomeStore", () => {
  it("persists non-authoritative drafts and restores their state", () => {
    const { root, store } = fixture();
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const created = store.propose(runId, proposal);

    expect(created.judgments[0]).toMatchObject({ status: "draft", runId, sourceReferenceId: "src_ref_11111111111141118111111111111111" });
    expect(created.learningProposals[0]).toMatchObject({ status: "draft", runId });
    expect(existsSync(join(root, "project", "outputs", "system", "judgment-records"))).toBe(false);
    expect(store.list(runId)).toEqual(created);
  });

  it("writes a confirmed Judgment Record without changing the Learning Proposal", () => {
    const { root, store } = fixture();
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const created = store.propose(runId, proposal);
    const judgment = store.confirmJudgment(created.judgments[0]!.id, join(root, "project"), { projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", threadId: "reflection-thread" });

    expect(judgment.status).toBe("confirmed");
    expect(readFileSync(join(root, "project", "outputs", "system", "judgment-records", `${judgment.id}.md`), "utf8")).toContain("Retention evidence is promising");
    expect(JSON.parse(readFileSync(join(root, "project", "outputs", "system", "judgment-records", `${judgment.id}.json`), "utf8"))).toMatchObject({ projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", threadId: "reflection-thread" });
    expect(store.list(runId).learningProposals[0]!.status).toBe("draft");
  });

  it("records independent discard, patch retry, and adoption transitions", () => {
    const { store } = fixture();
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const created = store.propose(runId, proposal);
    store.discard(created.judgments[0]!.id);
    store.markPatchPrepared(created.learningProposals[0]!.id, "patch-00000001");
    store.markPatchDiscarded("patch-00000001");
    expect(store.list(runId).learningProposals[0]).toMatchObject({ status: "draft", preparedPatchId: undefined });
    store.markPatchPrepared(created.learningProposals[0]!.id, "patch-00000002");
    store.markPatchCommitted("patch-00000002");

    const restored = store.list(runId);
    expect(restored.judgments[0]!.status).toBe("discarded");
    expect(restored.learningProposals[0]).toMatchObject({ status: "adopted", preparedPatchId: "patch-00000002" });
  });

  it("discards all pending drafts when the Reflection is discarded", () => {
    const { store } = fixture();
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    store.propose(runId, proposal);

    const discarded = store.discardRunDrafts(runId);
    expect(discarded.judgments[0]!.status).toBe("discarded");
    expect(discarded.learningProposals[0]!.status).toBe("discarded");
  });
});
