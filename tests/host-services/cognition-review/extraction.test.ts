import { describe, expect, it } from "vitest";
import { ContextBudgetService } from "../../../packages/host-services/src/context-budget.js";
import { estimateTextTokens } from "../../../packages/host-services/src/context-budget.js";
import { buildMemoryReviewChunks, type MemoryReviewChunkInput } from "../../../packages/host-services/src/cognition-review/chunking.js";
import {
  buildMemoryReviewExtractionPrompt,
  executeMemoryReviewExtraction,
  parseMemoryReviewExtraction,
  validateMemoryReviewExtraction
} from "../../../packages/host-services/src/cognition-review/memory-review-extraction.js";

const source: MemoryReviewChunkInput = {
  sourceReference: "thread:t/turn:1",
  sourceKind: "ordinary_exchange",
  scope: "unscoped",
  threadId: "t",
  turnId: "turn-1",
  completedAt: "2026-08-10T00:00:01.000Z",
  body: { userText: "I prefer durable evidence.", assistantText: "Understood." }
};

const chunk = buildMemoryReviewChunks([source], {
  budgetService: new ContextBudgetService({ safetyMarginTokens: 0 }),
  contextWindowTokens: 256,
  reservedOutputTokens: 16,
  now: "2026-08-11T00:00:00.000Z"
})[0]!;

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    chunkId: chunk.id,
    dispositions: [{ sourceReference: source.sourceReference, status: "no_signal" }],
    candidates: [],
    completedAt: "2026-08-11T00:00:00.000Z",
    ...overrides
  };
}

describe("Memory Review extraction coverage seam", () => {
  it("accepts exactly one terminal disposition for every chunk source", () => {
    const parsed = parseMemoryReviewExtraction(JSON.stringify(result()), chunk);
    expect(parsed.dispositions).toEqual([{ sourceReference: source.sourceReference, status: "no_signal" }]);
  });

  it("rejects missing, duplicate, and out-of-chunk source references", () => {
    expect(() => parseMemoryReviewExtraction(JSON.stringify(result({ dispositions: [] })), chunk)).toThrow(/omitted source disposition/iu);
    expect(() => parseMemoryReviewExtraction(JSON.stringify(result({ dispositions: [
      { sourceReference: source.sourceReference, status: "no_signal" },
      { sourceReference: source.sourceReference, status: "carried_over" }
    ] })), chunk)).toThrow();
    expect(() => parseMemoryReviewExtraction(JSON.stringify(result({ dispositions: [
      { sourceReference: "thread:other/turn:9", status: "no_signal" }
    ] })), chunk)).toThrow(/outside its chunk|omitted source disposition/iu);
  });

  it("rejects represented sources without a valid declared candidate", () => {
    expect(() => parseMemoryReviewExtraction(JSON.stringify(result({ dispositions: [
      { sourceReference: source.sourceReference, status: "represented", proposalIds: [] }
    ] })), chunk)).toThrow();
    expect(() => parseMemoryReviewExtraction(JSON.stringify(result({ dispositions: [
      { sourceReference: source.sourceReference, status: "represented", proposalIds: ["missing"] }
    ] })), chunk)).toThrow(/missing proposal|valid proposal/iu);
    expect(() => parseMemoryReviewExtraction(JSON.stringify(result({ dispositions: [
      { sourceReference: source.sourceReference, status: "represented", proposalIds: ["proposal-1"] }
    ], candidates: [{ id: "proposal-2" }] })), chunk)).toThrow(/missing proposal/iu);
  });

  it("accepts a represented source when its candidate is declared", () => {
    const parsed = validateMemoryReviewExtraction({
      ...result({
        dispositions: [{ sourceReference: source.sourceReference, status: "represented", proposalIds: ["proposal-1"] }],
        candidates: [{ id: "proposal-1", sourceReferences: [source.sourceReference], summary: "Durable evidence preference" }]
      })
    }, chunk);
    expect(parsed.candidates[0]?.id).toBe("proposal-1");
  });

  it("resolves source bodies only while executing the chunk", async () => {
    let seenPrompt = "";
    const parsed = await executeMemoryReviewExtraction({
      chunk,
      resolveSource: (reference) => reference === source.sourceReference ? { userText: "resolved user body", assistantText: "resolved assistant body" } : undefined,
      generate: async (prompt) => {
        seenPrompt = prompt;
        return JSON.stringify(result());
      },
      now: "2026-08-11T00:00:00.000Z"
    });
    expect(seenPrompt).toContain("resolved user body");
    expect(parsed.dispositions[0]?.sourceReference).toBe(source.sourceReference);
    expect(buildMemoryReviewExtractionPrompt(chunk)).toContain(source.sourceReference);
  });

  it("does not re-expand an oversized prepared excerpt during execution", async () => {
    const oversized = { ...source, body: { userText: "x".repeat(100_000), assistantText: "y".repeat(100_000) } };
    const oversizedChunk = buildMemoryReviewChunks([oversized], {
      budgetService: new ContextBudgetService({ safetyMarginTokens: 0 }),
      contextWindowTokens: 256,
      reservedOutputTokens: 4,
      stageInstructions: "Extract.",
      outputSchema: "{}",
      now: "2026-08-11T00:00:00.000Z"
    })[0]!;
    let prompt = "";
    await executeMemoryReviewExtraction({
      chunk: oversizedChunk,
      resolveSource: () => ({ userText: "z".repeat(100_000), assistantText: "q".repeat(100_000) }),
      generate: (value) => {
        prompt = value;
        return JSON.stringify(result({ chunkId: oversizedChunk.id }));
      },
      now: "2026-08-11T00:00:00.000Z"
    });
    expect(prompt).not.toContain("z".repeat(10_000));
    expect(estimateTextTokens(prompt)).toBeLessThan(oversizedChunk.budget.usableContextTokens);
  });
});
