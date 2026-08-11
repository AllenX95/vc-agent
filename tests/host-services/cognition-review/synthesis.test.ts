import { describe, expect, it } from "vitest";
import type { CoverageLedger } from "@vc-agent/contracts";
import { createCoverageLedger } from "../../../packages/host-services/src/cognition-review/coverage-ledger.js";
import {
  buildMemoryReviewSynthesisInput,
  buildMemoryReviewSynthesisPrompt,
  executeMemoryReviewSynthesis,
  parseMemoryReviewSynthesis,
  type MemoryReviewSynthesisCard,
  type MemoryReviewSynthesisInput
} from "../../../packages/host-services/src/cognition-review/memory-review-synthesis.js";

const now = "2026-08-11T00:00:00.000Z";
const projectId = "11111111-1111-4111-8111-111111111111";

function ledger(statuses: { project: "no_signal" | "represented"; unscoped?: "represented" } = { project: "represented", unscoped: "represented" }): CoverageLedger {
  const base = createCoverageLedger({
    batchId: "batch-1",
    cutoff: now,
    createdAt: now,
    sources: [
      { sourceReference: "thread:project-thread/turn:1", sourceKind: "ordinary_exchange", scope: "project", projectId, threadId: "project-thread", turnId: "turn-1", completedAt: now },
      { sourceReference: "thread:project-thread/turn:2", sourceKind: "ordinary_exchange", scope: "project", projectId, threadId: "project-thread", turnId: "turn-2", completedAt: "2026-08-10T00:00:00.000Z" },
      { sourceReference: "thread:unscoped-thread/turn:3", sourceKind: "ordinary_exchange", scope: "unscoped", threadId: "unscoped-thread", turnId: "turn-3", completedAt: "2026-08-09T00:00:00.000Z" }
    ]
  });
  return {
    ...base,
    entries: base.entries.map((entry) => entry.sourceReference.endsWith("turn:1")
      ? { ...entry, status: statuses.project, proposalIds: statuses.project === "represented" ? ["candidate-project"] : [] }
      : entry.sourceReference.endsWith("turn:2")
        ? { ...entry, status: "no_signal", proposalIds: [] }
        : { ...entry, status: statuses.unscoped ?? "represented", proposalIds: (statuses.unscoped ?? "represented") === "represented" ? ["candidate-unscoped"] : [] }),
    updatedAt: now
  };
}

const extractionResults = [
  {
    schemaVersion: 1 as const,
    chunkId: "chunk-project",
    dispositions: [
      { sourceReference: "thread:project-thread/turn:1", status: "represented" as const, proposalIds: ["candidate-project"] },
      { sourceReference: "thread:project-thread/turn:2", status: "no_signal" as const }
    ],
    candidates: [{ id: "candidate-project", title: "Evidence threshold", summary: "Prefer explicit uncertainty before an investment decision.", sourceReferences: ["thread:project-thread/turn:1"], destination: "project_memory" as const }],
    completedAt: now
  },
  {
    schemaVersion: 1 as const,
    chunkId: "chunk-unscoped",
    dispositions: [{ sourceReference: "thread:unscoped-thread/turn:3", status: "represented" as const, proposalIds: ["candidate-unscoped"] }],
    candidates: [{ id: "candidate-unscoped", title: "Uncertainty discipline", summary: "Record what would change the view.", sourceReferences: ["thread:unscoped-thread/turn:3"], destination: "long_term_memory" as const }],
    completedAt: now
  }
];

const projectCards: readonly MemoryReviewSynthesisCard[] = [{
  id: "project-card-1",
  title: "Current project judgment",
  content: "A bounded project card.",
  applicability: ["this project"],
  scope: "project",
  projectId
}];
const longTermCards: readonly MemoryReviewSynthesisCard[] = [{
  id: "memory-card-1",
  title: "Test uncertainty explicitly",
  content: "Make the disconfirming evidence explicit.",
  applicability: ["early-stage investments"],
  limitations: "Sector context still matters.",
  tags: ["diligence"],
  version: 1,
  scope: "long_term"
}];

function input(overrides: Partial<Parameters<typeof buildMemoryReviewSynthesisInput>[0]> = {}): MemoryReviewSynthesisInput {
  return buildMemoryReviewSynthesisInput({
    batchId: "batch-1",
    cutoff: now,
    coverage: ledger(),
    extractionResults,
    projectMemoryCards: projectCards,
    longTermMemoryCards: longTermCards,
    promptSnapshot: { revisionId: "prompt-1", hash: "a".repeat(64) },
    profileSnapshot: { id: "memory-review", provider: "fixture", model: "fixture" },
    ...overrides
  });
}

describe("Memory Review synthesis seam", () => {
  it("builds deterministic, de-identified synthesis input and prompt", () => {
    const first = input();
    const second = input();
    expect(first.inputHash).toBe(second.inputHash);
    const prompt = buildMemoryReviewSynthesisPrompt(first);
    expect(prompt).toContain("scope_ref_");
    expect(prompt).toContain("memory-card-1");
    expect(prompt).not.toContain(projectId);
    expect(prompt).not.toContain("C:\\projects");
  });

  it("blocks synthesis until the strict Coverage Ledger is terminal", () => {
    expect(() => input({ coverage: ledger({ project: "represented", unscoped: "represented", }) && {
      ...ledger(),
      entries: ledger().entries.map((entry) => entry.sourceReference.endsWith("turn:2") ? { ...entry, status: "pending" as const } : entry)
    } })).toThrow(/coverage.*incomplete|synthesis.*blocked/iu);
  });

  it("normalizes proposals and preserves Project versus Long-term routing", () => {
    const parsed = parseMemoryReviewSynthesis(JSON.stringify({
      summary: "Two bounded learnings.",
      uncertainty: "Medium.",
      proposals: [
        { id: "proposal-project", title: "Evidence threshold", content: "Keep the threshold visible.", applicability: ["this project"], limitations: "Local context only.", destination: "project_memory", action: "add", sourceReferences: ["thread:project-thread/turn:1"], targetEntryIds: [] },
        { id: "proposal-long-term", title: "State disconfirming evidence", content: "Record what would change an investment view.", applicability: ["early-stage investments"], limitations: "Not a substitute for current evidence.", destination: "long_term_memory", action: "add", sourceReferences: ["thread:project-thread/turn:1", "thread:unscoped-thread/turn:3"], targetEntryIds: [] }
      ]
    }), input());
    expect(parsed.proposals).toHaveLength(2);
    expect(parsed.proposals[0]).toMatchObject({ destination: "project_memory", sourceReferences: ["thread:project-thread/turn:1"] });
    expect(parsed.proposals[1]?.destination).toBe("long_term_memory");
    expect(parsed.metadata.inputHash).toBe(input().inputHash);
  });

  it("rejects references and long-term content that are not in the bounded inputs", () => {
    const synthesisInput = input();
    const outside = {
      summary: "S",
      uncertainty: "U",
      proposals: [{ id: "p", title: "Leak", content: "Secret Project Name has a $20m round at C:\\projects\\secret.", applicability: ["early-stage"], limitations: "", destination: "long_term_memory", action: "add", sourceReferences: ["thread:outside/turn:9"], targetEntryIds: [] }]
    };
    expect(() => parseMemoryReviewSynthesis(JSON.stringify(outside), synthesisInput)).toThrow(/source.*outside|deident|project.*specific|long.?term/iu);
  });

  it("executes through an injected generator while carrying frozen snapshots", async () => {
    let prompt = "";
    const result = await executeMemoryReviewSynthesis({
      input: input(),
      generate: (value) => { prompt = value; return JSON.stringify({ summary: "S", uncertainty: "U", proposals: [] }); },
      now
    });
    expect(prompt).toContain("prompt-1");
    expect(result.proposals).toEqual([]);
    expect(result.metadata.scopeCount).toBe(2);
  });
});
