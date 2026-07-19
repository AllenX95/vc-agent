import { fauxAssistantMessage, fauxToolCall } from "@vc-agent/pi-adapter/testing";

export function dogfoodFixtureResponses() {
  return [
    fauxAssistantMessage(fauxToolCall("material_recall", { disclosureLevel: "cards", maxItems: 4, maxChars: 2_000 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("project_state_recall", { source: "project_context", query: "current focus", maxItems: 2, maxChars: 2_000 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("memory_recall", { source: "project_memory", disclosureLevel: "cards", query: "risk", maxItems: 2, maxChars: 2_000 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("web_search", { query: "current venture market evidence", maxResults: 2, maxChars: 2_000 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("output.write_text", {
      path: "dogfood-investment-note.md",
      mediaType: "text/markdown",
      content: "# Dogfood Investment Note\n\n## Sourced facts\n- The project material was inventoried and parsed [material inventory].\n- Public market evidence was reviewed [https://example.com/market].\n\n## User-confirmed judgment\n- Execution stability is the core risk [Project Memory].\n\n## Inference and uncertainty\n- The opportunity may be attractive, but evidence remains incomplete and the execution risk requires diligence.\n",
      sourceReferences: ["material-inventory", "project-context:current-working-state", "project-memory:risk", "https://example.com/market"],
      warnings: ["Fixture evidence is intentionally bounded; the investment inference remains uncertain."]
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Completed the bounded project review and created dogfood-investment-note.md.")
  ];
}

export function longTermMemoryFixtureResponses() {
  return [
    fauxAssistantMessage(fauxToolCall("memory_recall", { source: "long_term_memory", disclosureLevel: "cards", query: "market sizing memo", maxItems: 4, maxChars: 2_000 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("memory_recall", { source: "long_term_memory", disclosureLevel: "full", entryIds: ["ltm-tam-framing"], maxItems: 2, maxChars: 3_000 }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Recalled relevant Long-term Memory as prior judgment, not source evidence.")
  ];
}

export function explicitLongTermMemoryFixtureResponses() {
  return [
    fauxAssistantMessage(fauxToolCall("memory_recall", { source: "long_term_memory", disclosureLevel: "cards", query: "founder reference diligence", maxItems: 4, maxChars: 2_000 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("memory_recall", { source: "long_term_memory", disclosureLevel: "full", entryIds: ["ltm-founder-reference"], maxItems: 2, maxChars: 3_000 }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Completed the Long-term Memory policy fixture.")
  ];
}

export function reflectionFixtureResponses() {
  return [
    fauxAssistantMessage(fauxToolCall("material_recall", { disclosureLevel: "cards", maxItems: 8, maxChars: 4_000 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(JSON.stringify({
      schemaVersion: 1,
      conclusion: "The current evidence supports continued diligence, but not a final investment decision.",
      rationale: ["The available project materials establish a bounded basis for review."],
      uncertainties: ["Material coverage may be incomplete."],
      counterarguments: ["Metadata alone does not validate the underlying investment claims."],
      evidenceReferences: [{ referenceId: "material-inventory", claim: "Project materials were available for progressive review.", support: "supporting" }],
      decisionChangingQuestions: ["Which unresolved commercial assumption has the highest downside impact?"],
      createdAt: "2026-07-19T00:00:00.000Z"
    }))
  ];
}

export function memoryAwareReflectionFixtureResponses() {
  return [
    fauxAssistantMessage(fauxToolCall("memory_recall", { source: "project_memory", disclosureLevel: "cards", query: "retention execution risk", maxItems: 4, maxChars: 3_000 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("memory_recall", { source: "long_term_memory", disclosureLevel: "cards", query: "early stage retention execution risk", maxItems: 4, maxChars: 3_000 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("memory_recall", { source: "long_term_memory", disclosureLevel: "full", entryIds: ["ltm-reflection-pattern"], maxItems: 2, maxChars: 3_000 }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The source evidence remains incomplete. Your historical judgment emphasizes retention risk, but it is not source evidence and may over-weight execution before cohort data matures. Which retention result would change your current view?"),
    fauxAssistantMessage("That threshold clarifies the decision rule. The remaining tension is whether the current evidence can measure it without selection bias.")
  ];
}

export function memoryAwareReflectionContinuationFixtureResponses() {
  return [
    fauxAssistantMessage(fauxToolCall("reflection_outcome_propose", {
      judgmentRecord: {
        view: "Require month-six retention above 80% in a representative cohort before increasing conviction.",
        reasoning: ["The threshold turns the retention concern into a falsifiable decision rule."],
        uncertainties: ["The current evidence does not establish that the measured cohort is representative."],
        counterarguments: ["A strict month-six threshold may understate value for products with naturally episodic use."],
        evidenceReferences: ["material-inventory", "project-memory-retention"],
        decisionState: "watch",
        sourceAvailability: "partial"
      },
      learningProposals: [{
        action: "add",
        targetEntryIds: [],
        proposed: {
          id: "ltm-representative-retention-threshold",
          title: "Require representative retention thresholds",
          date: "2026-07-19",
          tags: ["retention", "diligence"],
          applicability: ["early-stage software", "Series A diligence"],
          maturity: "evidence-backed",
          recallPolicy: "automatic",
          limitations: "The threshold should be adapted for naturally episodic products.",
          content: "Define a falsifiable retention threshold and require a representative cohort before increasing investment conviction."
        },
        rationale: "The Reflection converted a recurring retention concern into a confirmed decision rule.",
        comparisonSummary: "Compared with active Memory, this adds an explicit falsifiable threshold requirement rather than repeating the general need for representative cohorts."
      }]
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("I prepared a non-authoritative Judgment Record draft and a de-identified Long-term Learning Proposal. Confirm them separately in the Reflection workspace.")
  ];
}
