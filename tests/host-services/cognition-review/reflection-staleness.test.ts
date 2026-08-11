import { describe, expect, it } from "vitest";
import type { MaterialInventoryItem } from "@vc-agent/contracts";
import { captureReflectionDependencies, staleReflectionDependencies } from "../../../packages/host-services/src/cognition-review/reflection-staleness.js";

const material: MaterialInventoryItem = {
  id: "64a14515-99f5-43d4-9b3a-cf2c13afd4a6", projectId: "c7c2cc65-7215-42f0-9c5b-ad33c74ffea0", relativePath: "memo.md", extension: ".md", mediaType: "text/markdown",
  size: 100, modifiedAt: "2026-07-19T00:00:00.000Z", sourceHash: "a".repeat(64), parseStatus: "available", parsedVersionCount: 1, availability: "active"
};
const evidenceReference = `material:${material.id}/block:paragraph-1@${material.sourceHash}`;
const state = {
  materials: [material],
  projectMemory: [{ id: "pm-retention", value: { id: "pm-retention", body: "Retention risk" } }],
  longTermMemory: [{ id: "ltm-retention", value: { id: "ltm-retention", version: 1, content: "Use representative cohorts" } }]
};

describe("Cognition Review Reflection dependency staleness", () => {
  it("captures exact material and Memory dependencies", () => {
    const dependencies = captureReflectionDependencies({ evidenceReferenceIds: [evidenceReference], projectMemoryEntryIds: ["pm-retention"], longTermMemoryEntryIds: ["ltm-retention"], state });
    expect(dependencies.map((dependency) => [dependency.kind, dependency.targetId])).toEqual([
      ["material", material.id], ["project_memory", "pm-retention"], ["long_term_memory", "ltm-retention"]
    ]);
  });

  it("reports only changed or unavailable dependencies", () => {
    const dependencies = captureReflectionDependencies({ evidenceReferenceIds: [evidenceReference], projectMemoryEntryIds: [], longTermMemoryEntryIds: ["ltm-retention"], state });
    const changed = { ...state, materials: [{ ...material, sourceHash: "b".repeat(64), parseStatus: "stale" as const }] };
    expect(staleReflectionDependencies(dependencies, changed)).toMatchObject([{ dependency: { kind: "material" }, reason: "changed" }]);
    expect(staleReflectionDependencies(dependencies, { materials: [], longTermMemory: [] })).toMatchObject([
      { dependency: { kind: "material" }, reason: "deleted" },
      { dependency: { kind: "long_term_memory" }, reason: "deleted" }
    ]);
  });
});

