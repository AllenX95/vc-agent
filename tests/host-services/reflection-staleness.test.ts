import { describe, expect, it } from "vitest";
import type { MaterialInventoryItem } from "@vc-agent/contracts";
import { captureReflectionDependencies, staleReflectionDependencies } from "@vc-agent/host-services";

const material: MaterialInventoryItem = {
  id: "64a14515-99f5-43d4-9b3a-cf2c13afd4a6", projectId: "c7c2cc65-7215-42f0-9c5b-ad33c74ffea0", relativePath: "memo.md", extension: ".md", mediaType: "text/markdown",
  size: 100, modifiedAt: "2026-07-19T00:00:00.000Z", sourceHash: "a".repeat(64), parseStatus: "available", parsedVersionCount: 1, availability: "active"
};
const evidenceReference = `material:${material.id}/block:paragraph-1@${material.sourceHash}`;
const state = {
  materials: [material],
  projectMemory: [{ id: "pm-retention", value: { id: "pm-retention", body: "Retention risk" } }],
  longTermMemory: [
    { id: "ltm-retention", value: { id: "ltm-retention", version: 1, content: "Use representative cohorts" } },
    { id: "ltm-unrelated", value: { id: "ltm-unrelated", version: 1, content: "Validate market size" } }
  ]
};

describe("Reflection outcome dependency staleness", () => {
  it("captures exact evidence and recalled or targeted Memory entries", () => {
    const dependencies = captureReflectionDependencies({
      evidenceReferenceIds: [evidenceReference, "material-inventory"], projectMemoryEntryIds: ["pm-retention"], longTermMemoryEntryIds: ["ltm-retention", "ltm-retention"], state
    });
    expect(dependencies.map((dependency) => [dependency.kind, dependency.targetId])).toEqual([
      ["material", material.id], ["project_memory", "pm-retention"], ["long_term_memory", "ltm-retention"]
    ]);
    expect(dependencies.every((dependency) => /^[a-f0-9]{64}$/u.test(dependency.contentVersion))).toBe(true);
  });

  it("ignores unrelated Memory edits but detects exact target and evidence changes", () => {
    const dependencies = captureReflectionDependencies({ evidenceReferenceIds: [evidenceReference], projectMemoryEntryIds: [], longTermMemoryEntryIds: ["ltm-retention"], state });
    const unrelatedChanged = { ...state, longTermMemory: [state.longTermMemory[0]!, { id: "ltm-unrelated", value: { id: "ltm-unrelated", version: 2, content: "Changed" } }] };
    expect(staleReflectionDependencies(dependencies, unrelatedChanged)).toEqual([]);

    const relevantChanged = { ...state, longTermMemory: [{ id: "ltm-retention", value: { id: "ltm-retention", version: 2, content: "Narrowed" } }, state.longTermMemory[1]!] };
    expect(staleReflectionDependencies(dependencies, relevantChanged)).toMatchObject([{ dependency: { kind: "long_term_memory", targetId: "ltm-retention" }, reason: "changed" }]);

    const evidenceChanged = { ...state, materials: [{ ...material, sourceHash: "b".repeat(64), parseStatus: "stale" as const }] };
    expect(staleReflectionDependencies(dependencies, evidenceChanged)).toMatchObject([{ dependency: { kind: "material", targetId: material.id }, reason: "changed" }]);
  });

  it("distinguishes unavailable Memory sources from deleted entries", () => {
    const dependencies = captureReflectionDependencies({ evidenceReferenceIds: [], projectMemoryEntryIds: ["pm-retention"], longTermMemoryEntryIds: ["ltm-retention"], state });
    expect(staleReflectionDependencies(dependencies, { materials: [], longTermMemory: [] })).toMatchObject([
      { dependency: { kind: "project_memory" }, reason: "source_unavailable" },
      { dependency: { kind: "long_term_memory" }, reason: "deleted" }
    ]);
  });
});
