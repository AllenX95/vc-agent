/**
 * Host-owned context budgeting.  Keep the byte-to-token estimator here so
 * ordinary Turns and explicit model-backed workflows make the same admission
 * decision and expose the same contribution categories.
 */

export const CONTEXT_BUDGET_ESTIMATOR_REVISION = "context-budget-v1" as const;
export const DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS = 2_048;
export const ESTIMATED_BYTES_PER_TOKEN = 4;

export interface ContextBudgetInput {
  readonly systemPromptBytes: number;
  readonly toolSchemaBytes: number;
  readonly taskBytes: number;
  readonly retainedHistoryBytes: number;
  readonly retrievalBytes: number;
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
}

export interface ContextBudgetDecision {
  readonly contributions: {
    readonly systemPromptTokens: number;
    readonly toolSchemaTokens: number;
    readonly taskTokens: number;
    readonly retainedHistoryTokens: number;
    readonly retrievalTokens: number;
  };
  readonly usableContextTokens: number;
  readonly estimatedInputTokens: number;
  readonly action: "admit" | "compact_then_admit" | "reject_current_input" | "reject_additional_retrieval";
}

export interface ContextBudgetTelemetry extends ContextBudgetDecision {
  readonly estimatorRevision: typeof CONTEXT_BUDGET_ESTIMATOR_REVISION;
  readonly safetyMarginTokens: number;
}

export function estimateUtf8Tokens(bytes: number): number {
  assertNonNegativeInteger(bytes, "bytes");
  return Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN);
}

export function estimateTextTokens(text: string): number {
  return estimateUtf8Tokens(Buffer.byteLength(text, "utf8"));
}

export class ContextBudgetService {
  readonly #safetyMarginTokens: number;

  constructor(options: { readonly safetyMarginTokens?: number } = {}) {
    const margin = options.safetyMarginTokens ?? DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS;
    if (!Number.isInteger(margin) || margin < 0) throw new Error("Context budget safety margin must be a non-negative integer.");
    this.#safetyMarginTokens = margin;
  }

  get estimatorRevision(): typeof CONTEXT_BUDGET_ESTIMATOR_REVISION { return CONTEXT_BUDGET_ESTIMATOR_REVISION; }
  get safetyMarginTokens(): number { return this.#safetyMarginTokens; }

  decide(input: ContextBudgetInput): ContextBudgetDecision {
    for (const [name, value] of Object.entries(input)) {
      if (name === "contextWindowTokens" || name === "reservedOutputTokens" || name.endsWith("Bytes")) {
        assertNonNegativeInteger(value, name);
      }
    }
    if (input.contextWindowTokens < 1) throw new Error("Context window must be a positive integer.");

    const contributions = {
      systemPromptTokens: estimateUtf8Tokens(input.systemPromptBytes),
      toolSchemaTokens: estimateUtf8Tokens(input.toolSchemaBytes),
      taskTokens: estimateUtf8Tokens(input.taskBytes),
      retainedHistoryTokens: estimateUtf8Tokens(input.retainedHistoryBytes),
      retrievalTokens: estimateUtf8Tokens(input.retrievalBytes)
    };
    const usableContextTokens = Math.max(0, input.contextWindowTokens - input.reservedOutputTokens - this.#safetyMarginTokens);
    const currentInputTokens = contributions.systemPromptTokens + contributions.toolSchemaTokens + contributions.taskTokens;
    const estimatedInputTokens = currentInputTokens + contributions.retainedHistoryTokens + contributions.retrievalTokens;
    const action = currentInputTokens > usableContextTokens
      ? "reject_current_input"
      : currentInputTokens + contributions.retrievalTokens > usableContextTokens
        ? "reject_additional_retrieval"
        : estimatedInputTokens > usableContextTokens
          ? "compact_then_admit"
          : "admit";
    return { contributions, usableContextTokens, estimatedInputTokens, action };
  }

  telemetry(input: ContextBudgetInput): ContextBudgetTelemetry {
    return { ...this.decide(input), estimatorRevision: this.estimatorRevision, safetyMarginTokens: this.safetyMarginTokens };
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`Context budget ${name} must be a non-negative integer.`);
}
