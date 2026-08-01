import { describe, expect, it } from "vitest";
import { ContextBudgetService, CONTEXT_BUDGET_ESTIMATOR_REVISION, estimateTextTokens } from "@vc-agent/host-services";

describe("ContextBudgetService", () => {
  it("uses one estimator and preserves contribution categories", () => {
    const service = new ContextBudgetService({ safetyMarginTokens: 2 });
    const decision = service.decide({
      systemPromptBytes: 8,
      toolSchemaBytes: 4,
      taskBytes: 12,
      retainedHistoryBytes: 8,
      retrievalBytes: 4,
      contextWindowTokens: 20,
      reservedOutputTokens: 2
    });

    expect(decision).toEqual({
      contributions: { systemPromptTokens: 2, toolSchemaTokens: 1, taskTokens: 3, retainedHistoryTokens: 2, retrievalTokens: 1 },
      usableContextTokens: 16,
      estimatedInputTokens: 9,
      action: "admit"
    });
    expect(service.telemetry({
      systemPromptBytes: 8, toolSchemaBytes: 4, taskBytes: 12, retainedHistoryBytes: 8, retrievalBytes: 4, contextWindowTokens: 20, reservedOutputTokens: 2
    })).toMatchObject({ estimatorRevision: CONTEXT_BUDGET_ESTIMATOR_REVISION, safetyMarginTokens: 2 });
  });

  it.each([
    ["current input", { systemPromptBytes: 44, toolSchemaBytes: 0, taskBytes: 0, retainedHistoryBytes: 0, retrievalBytes: 0 }, "reject_current_input"],
    ["retrieval", { systemPromptBytes: 8, toolSchemaBytes: 0, taskBytes: 8, retainedHistoryBytes: 0, retrievalBytes: 40 }, "reject_additional_retrieval"],
    ["history", { systemPromptBytes: 8, toolSchemaBytes: 0, taskBytes: 8, retainedHistoryBytes: 40, retrievalBytes: 0 }, "compact_then_admit"]
  ] as const)("takes the safe boundary action for %s overflow", (_name, bytes, action) => {
    const result = new ContextBudgetService({ safetyMarginTokens: 0 }).decide({ ...bytes, contextWindowTokens: 10, reservedOutputTokens: 0 });
    expect(result.action).toBe(action);
  });

  it("estimates UTF-8 text by bytes rather than JavaScript code units", () => {
    expect(estimateTextTokens("你好")).toBe(2);
  });
});
