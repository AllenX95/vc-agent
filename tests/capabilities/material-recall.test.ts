import { describe, expect, it } from "vitest";
import type { CanonicalParse, MaterialInventoryItem } from "@vc-agent/contracts";
import { MaterialRecallSource } from "@vc-agent/host-services";
import { coreCapabilitiesForScope, createReflectionEvidenceDrilldownCapability } from "@vc-agent/capabilities";

const material: MaterialInventoryItem = {
  id: "64a14515-99f5-43d4-9b3a-cf2c13afd4a6",
  projectId: "c7c2cc65-7215-42f0-9c5b-ad33c74ffea0",
  relativePath: "materials/company.md",
  extension: ".md",
  mediaType: "text/markdown",
  size: 120,
  modifiedAt: "2026-07-17T00:00:00.000Z",
  sourceHash: "a".repeat(64),
  parseStatus: "available",
  parsedVersionCount: 1,
  availability: "active"
};

const parse: CanonicalParse = {
  schemaVersion: 1,
  source: {
    materialId: material.id,
    projectId: material.projectId,
    relativePath: material.relativePath,
    sourceHash: material.sourceHash,
    mediaType: material.mediaType,
    size: material.size,
    modifiedAt: material.modifiedAt
  },
  parser: { id: "markdown", version: "1", runtime: "node" },
  structure: { kind: "document", units: [{ index: 0, name: "Company", blockIds: ["heading-1", "paragraph-1", "paragraph-2"] }] },
  blocks: [
    { id: "heading-1", type: "heading", text: "Company", level: 1, source: { unitIndex: 0 } },
    { id: "paragraph-1", type: "paragraph", text: "Revenue grew quickly.", source: { unitIndex: 0 } },
    { id: "paragraph-2", type: "paragraph", text: "Retention remains uncertain.", source: { unitIndex: 0 } }
  ],
  warnings: [],
  createdAt: "2026-07-17T00:00:00.000Z"
};

const context = { turnId: "turn-1", maxItems: 1, maxChars: 100, retrievedAt: "2026-07-17T00:01:00.000Z" };

describe("bounded material recall", () => {
  it("keeps Project and Unscoped core surfaces exact", () => {
    expect(coreCapabilitiesForScope("project")).toEqual(["capability_request", "material_recall", "project_state_recall", "memory_recall"]);
    expect(coreCapabilitiesForScope("unscoped")).toEqual(["capability_request", "material_recall", "memory_recall"]);
  });
  it("discloses cards and outlines before stable referenced blocks", async () => {
    const source = new MaterialRecallSource({ listMaterials: () => [material], loadParse: async () => parse });
    const cards = await source.recall({ disclosureLevel: "cards" }, context);
    expect(cards.items[0]?.content).toContain("parse=available");
    expect(cards.contextReference.sourceRange).toBe("cards");

    const outline = await source.recall({ disclosureLevel: "outline", materialId: material.id }, context);
    expect(outline.items[0]?.content).toContain("# Company");

    const excerpt = await source.recall({ disclosureLevel: "excerpt", materialId: material.id, blockIds: ["paragraph-1"] }, context);
    expect(excerpt.items[0]).toMatchObject({ content: "Revenue grew quickly.", sourceRefs: [`material:${material.id}/block:paragraph-1@${material.sourceHash}`] });
  });

  it("reports every bounded omission instead of implying a full read", async () => {
    const source = new MaterialRecallSource({ listMaterials: () => [material], loadParse: async () => parse });
    const result = await source.recall({ disclosureLevel: "full", materialId: material.id }, context);
    expect(result.complete).toBe(false);
    expect(result.omittedItems).toBe(2);
    expect(result.warnings[0]).toContain("omitted");
  });

  it("requires an explicit refresh choice for stale parses", async () => {
    const stale = { ...material, parseStatus: "stale" as const };
    const source = new MaterialRecallSource({ listMaterials: () => [stale], loadParse: async () => parse });
    const result = await source.recall({ disclosureLevel: "excerpt", materialId: stale.id }, context);
    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual(["PARSE_REFRESH_CHOICE_REQUIRED"]);
    expect(result.contextReference.status).toBe("stale");
  });

  it("keeps Reflection drilldown inputs narrower than general Material recall", () => {
    const capability = createReflectionEvidenceDrilldownCapability(async () => { throw new Error("not executed"); });
    expect(capability.inputSchema.parse({ referenceId: "material:stable", maxChars: 6_000, materialId: material.id, query: "broaden" })).toEqual({ referenceId: "material:stable", maxChars: 6_000 });
    expect(capability.inputSchema.safeParse({ referenceId: "material:stable", maxChars: 6_001 }).success).toBe(false);
    expect(capability.metadata.allowedScopes).toEqual(["project"]);
  });
});
