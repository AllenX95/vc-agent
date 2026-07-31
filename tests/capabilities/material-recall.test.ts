import { describe, expect, it } from "vitest";
import type { CanonicalParse, MaterialInventoryItem } from "@vc-agent/contracts";
import { CAPABILITY_RESULT_CONTENT_MAX_CHARS } from "@vc-agent/contracts";
import { MaterialRecallSource, detectMaterialRecallIntent, detectProjectStateRecallIntent, serializeBoundedRetrieval } from "@vc-agent/host-services";
import { capabilitiesForTurn, createMaterialRecallCapability, createProjectStateRecallCapability, createReflectionEvidenceDrilldownCapability } from "@vc-agent/capabilities";

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
  it("keeps ordinary conversation tool-free and activates only task-implied capabilities", () => {
    expect(capabilitiesForTurn({
      scope: "project",
      materialRecall: false,
      projectStateRecall: false,
      memoryRecall: false,
      webResearch: false,
      outputWrite: false
    })).toEqual([]);
    expect(capabilitiesForTurn({
      scope: "project",
      materialRecall: true,
      projectStateRecall: false,
      memoryRecall: true,
      webResearch: false,
      outputWrite: true
    })).toEqual(["material_recall", "memory_recall", "output.write_text"]);
  });

  it("detects explicit Material and Project Context intent without treating normal chat as retrieval", () => {
    expect(detectMaterialRecallIntent("根据当前项目中的材料和 BP 做全面分析")).toBe(true);
    expect(detectMaterialRecallIntent("分析一下公司的重点技术成果pdf，评估一下公司的技术能力。")).toBe(true);
    expect(detectMaterialRecallIntent('Review @"diligence/Investment Memo.pdf"')).toBe(true);
    expect(detectMaterialRecallIntent("Email analyst@example.com")).toBe(false);
    expect(detectMaterialRecallIntent("你好，先讨论一下投资框架")).toBe(false);
    expect(detectProjectStateRecallIntent("读取当前项目背景和项目状态")).toBe(true);
    expect(detectProjectStateRecallIntent("Use project materials, Context and Memory.")).toBe(true);
    expect(detectProjectStateRecallIntent("分析项目材料里的商业模式")).toBe(false);
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

  it("fits the complete serialized retrieval envelope inside the Worker IPC contract", async () => {
    const ids = Array.from({ length: 1_200 }, (_, index) => `block-${index}`);
    const oversizedParse: CanonicalParse = {
      ...parse,
      structure: { kind: "document", units: [{ index: 0, name: "Oversized outline", blockIds: ids }] },
      blocks: ids.map((id) => ({ id, type: "paragraph", text: "", source: { unitIndex: 0 } }))
    };
    const source = new MaterialRecallSource({ listMaterials: () => [material], loadParse: async () => oversizedParse });
    const envelope = await source.recall(
      { disclosureLevel: "outline", materialId: material.id },
      { ...context, maxItems: 12, maxChars: 12_000 }
    );
    expect(JSON.stringify(envelope).length).toBeGreaterThan(CAPABILITY_RESULT_CONTENT_MAX_CHARS);

    const serialized = serializeBoundedRetrieval(envelope);
    expect(serialized.body.length).toBeLessThanOrEqual(CAPABILITY_RESULT_CONTENT_MAX_CHARS);
    expect(() => JSON.parse(serialized.body)).not.toThrow();
    expect(JSON.parse(serialized.body)).toMatchObject({ complete: false, items: [] });
  });

  it("clamps an oversized model-requested item budget instead of failing the Turn", () => {
    const capability = createMaterialRecallCapability(async () => { throw new Error("not executed"); });
    expect(capability.inputSchema.parse({ disclosureLevel: "cards", maxItems: 20 })).toMatchObject({
      disclosureLevel: "cards",
      maxItems: 12
    });
  });

  it("keeps Project Context model and Host limits aligned", () => {
    const capability = createProjectStateRecallCapability(async () => { throw new Error("not executed"); });
    expect(capability.inputSchema.parse({ source: "project_context", query: "materials", maxItems: 10, maxChars: 12_000 }))
      .toMatchObject({ maxItems: 6, maxChars: 8_000 });
    expect(capability.metadata.inputSchema).toMatchObject({
      properties: {
        maxItems: { maximum: 6 },
        maxChars: { maximum: 8_000 }
      }
    });
  });

  it("requires an explicit refresh choice for stale parses", async () => {
    const stale = { ...material, parseStatus: "stale" as const };
    const source = new MaterialRecallSource({ listMaterials: () => [stale], loadParse: async () => parse });
    const result = await source.recall({ disclosureLevel: "excerpt", materialId: stale.id }, context);
    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual(["PARSE_REFRESH_CHOICE_REQUIRED"]);
    expect(result.contextReference.status).toBe("stale");
  });

  it("returns the concrete parser failure instead of a generic unavailable warning", async () => {
    const unparsed = { ...material, parseStatus: "unparsed" as const, parsedVersionCount: 0 };
    const source = new MaterialRecallSource({
      listMaterials: () => [unparsed],
      loadParse: async () => ({
        status: "unavailable",
        code: "PARSER_RUNTIME_UNAVAILABLE",
        message: "PyMuPDF runtime could not be started."
      })
    });
    const result = await source.recall({ disclosureLevel: "full", materialId: unparsed.id }, context);
    expect(result.warnings).toEqual(["PARSER_RUNTIME_UNAVAILABLE: PyMuPDF runtime could not be started."]);
  });

  it("keeps Reflection drilldown inputs narrower than general Material recall", () => {
    const capability = createReflectionEvidenceDrilldownCapability(async () => { throw new Error("not executed"); });
    expect(capability.inputSchema.parse({ referenceId: "material:stable", maxChars: 6_000, materialId: material.id, query: "broaden" })).toEqual({ referenceId: "material:stable", maxChars: 6_000 });
    expect(capability.inputSchema.parse({ referenceId: "material:stable", maxChars: 6_001 })).toEqual({ referenceId: "material:stable", maxChars: 6_000 });
    expect(capability.metadata.allowedScopes).toEqual(["project"]);
  });
});
