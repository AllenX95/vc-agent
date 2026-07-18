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
