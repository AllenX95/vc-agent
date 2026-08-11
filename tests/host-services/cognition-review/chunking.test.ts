import { describe, expect, it } from "vitest";
import { ContextBudgetService } from "../../../packages/host-services/src/context-budget.js";
import { buildMemoryReviewChunks, type MemoryReviewChunkInput } from "../../../packages/host-services/src/cognition-review/chunking.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const options = {
  budgetService: new ContextBudgetService({ safetyMarginTokens: 0 }),
  contextWindowTokens: 256,
  reservedOutputTokens: 8,
  stageInstructions: "Extract dispositions.",
  outputSchema: "{ dispositions: [] }",
  now: "2026-08-11T00:00:00.000Z",
  promptSnapshot: { hash: "prompt-hash" },
  profileSnapshot: { id: "memory-review-profile" }
};

function source(index: number, body = `User exchange ${index}\nAssistant response ${index}`): MemoryReviewChunkInput {
  const completedAt = `2026-08-10T00:00:${String(index).padStart(2, "0")}.000Z`;
  return {
    sourceReference: `thread:t/turn:${index}`,
    sourceKind: "ordinary_exchange",
    scope: "project",
    projectId,
    threadId: "t",
    turnId: `turn-${index}`,
    completedAt,
    body: { userText: body, assistantText: `Response ${index}` }
  };
}

describe("Memory Review chunk construction", () => {
  it("assigns all thirteen sources to deterministic budgeted chunks", () => {
    const sources = Array.from({ length: 13 }, (_, index) => source(index + 1));
    const first = buildMemoryReviewChunks(sources, options);
    const second = buildMemoryReviewChunks(sources, options);
    const references = first.flatMap((chunk) => chunk.sourceReferences);

    expect(first.length).toBeGreaterThan(1);
    expect(references).toHaveLength(13);
    expect(new Set(references)).toHaveProperty("size", 13);
    expect(references).toEqual(sources.map((item) => item.sourceReference));
    expect(first.map((chunk) => ({ id: chunk.id, refs: chunk.sourceReferences, hash: chunk.inputHash }))).toEqual(
      second.map((chunk) => ({ id: chunk.id, refs: chunk.sourceReferences, hash: chunk.inputHash }))
    );
  });

  it("keeps an oversized source as a bounded excerpt instead of dropping it", () => {
    const oversized = source(1, "x".repeat(100_000));
    const chunks = buildMemoryReviewChunks([oversized], {
      ...options,
      contextWindowTokens: 256,
      reservedOutputTokens: 4
    });
    const member = chunks[0]?.sources[0];

    expect(chunks.flatMap((chunk) => chunk.sourceReferences)).toEqual([oversized.sourceReference]);
    expect(member?.truncated).toBe(true);
    expect((member?.userText.length ?? 0)).toBeLessThan(100_000);
  });

  it("isolates Project and Unscoped scopes", () => {
    const unscoped: MemoryReviewChunkInput = {
      sourceReference: "thread:u/turn:1",
      sourceKind: "ordinary_exchange",
      scope: "unscoped",
      threadId: "u",
      turnId: "turn-1",
      completedAt: "2026-08-10T00:00:01.000Z",
      body: { userText: "unscoped", assistantText: "answer" }
    };
    const chunks = buildMemoryReviewChunks([source(1), unscoped], options);
    expect(chunks.map((chunk) => chunk.scope)).toEqual(["project", "unscoped"]);
    expect(chunks.every((chunk) => chunk.sources.every((item) => item.scope === chunk.scope))).toBe(true);
  });

  it("fails deterministically when even static extraction metadata cannot fit", () => {
    expect(() => buildMemoryReviewChunks([source(1)], {
      ...options,
      contextWindowTokens: 2,
      reservedOutputTokens: 0
    })).toThrow(/too small to admit extraction metadata/iu);
  });
});
