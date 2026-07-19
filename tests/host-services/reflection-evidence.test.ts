import { describe, expect, it } from "vitest";
import type { CanonicalParse, MaterialInventoryItem } from "@vc-agent/contracts";
import { ReflectionEvidenceDrilldownSource, parseMaterialBlockReference } from "@vc-agent/host-services";

const material: MaterialInventoryItem = {
  id: "64a14515-99f5-43d4-9b3a-cf2c13afd4a6",
  projectId: "c7c2cc65-7215-42f0-9c5b-ad33c74ffea0",
  relativePath: "materials/company.md",
  extension: ".md",
  mediaType: "text/markdown",
  size: 1_000,
  modifiedAt: "2026-07-19T00:00:00.000Z",
  sourceHash: "a".repeat(64),
  parseStatus: "available",
  parsedVersionCount: 1,
  availability: "active"
};
const referenceId = `material:${material.id}/block:paragraph-1@${material.sourceHash}`;
const sourceReference = { relativePath: material.relativePath, sourceHash: material.sourceHash, locator: { kind: "document" as const } };
const parse: CanonicalParse = {
  schemaVersion: 1,
  parseId: "01b34e5e-2cc3-4eb0-bf6f-4d9e027bfb27",
  material: { id: material.id, projectId: material.projectId, relativePath: material.relativePath, mediaType: material.mediaType, sourceHash: material.sourceHash },
  parser: { id: "markdown", version: "1", runtime: "node" },
  createdAt: "2026-07-19T00:00:00.000Z",
  structure: { kind: "document", unitCount: 1, units: [{ index: 1, name: "Company", blockIds: ["paragraph-1"] }] },
  blocks: [{ id: "paragraph-1", type: "paragraph", text: "R".repeat(700), source: sourceReference }],
  warnings: [], recoveryRequests: [], provenance: { localOnly: true, stages: [] }
};
const context = { turnId: "reflection-turn", maxItems: 1, maxChars: 500, retrievedAt: "2026-07-19T00:01:00.000Z" };

describe("Reflection Evidence Drilldown", () => {
  it("resolves only the exact block and content version under the per-call budget", async () => {
    const source = new ReflectionEvidenceDrilldownSource({ listMaterials: () => [material], loadParse: async () => parse });
    const result = await source.recall({ referenceId, claim: "Retention is proven." }, context);
    expect(parseMaterialBlockReference(referenceId)).toEqual({ materialId: material.id, blockId: "paragraph-1", contentVersion: material.sourceHash });
    expect(result).toMatchObject({ disclosureLevel: "evidence_drilldown", complete: false, omittedItems: 1, contextReference: { sourceId: material.id, sourceRange: "paragraph-1", contentVersion: material.sourceHash, status: "active" } });
    expect(result.items).toEqual([{ materialId: material.id, label: "materials/company.md / paragraph-1", content: "R".repeat(500), sourceRefs: [referenceId] }]);
    expect(result.warnings.join(" ")).toContain("not a support verdict");
  });

  it("does not resolve an old reference after the Material content changes", async () => {
    const changed = { ...material, sourceHash: "b".repeat(64), parseStatus: "stale" as const };
    const source = new ReflectionEvidenceDrilldownSource({ listMaterials: () => [changed], loadParse: async () => parse });
    const result = await source.recall({ referenceId, claim: "Retention is proven." }, context);
    expect(result.items).toEqual([]);
    expect(result.contextReference.status).toBe("changed");
    expect(result.warnings.join(" ")).toContain("new assessment");
  });

  it("marks a non-stable handoff reference unavailable instead of broadening recall", async () => {
    let parseLoads = 0;
    const source = new ReflectionEvidenceDrilldownSource({ listMaterials: () => [material], loadParse: async () => { parseLoads += 1; return parse; } });
    const result = await source.recall({ referenceId: "material-inventory", claim: "Materials exist." }, context);
    expect(result.items).toEqual([]);
    expect(result.contextReference.status).toBe("source_unavailable");
    expect(result.warnings.join(" ")).toContain("unsupported");
    expect(parseLoads).toBe(0);
  });
});
