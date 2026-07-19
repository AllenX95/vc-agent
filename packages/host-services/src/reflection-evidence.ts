import type { CanonicalParse, ContextReference, MaterialInventoryItem } from "@vc-agent/contracts";
import type { BoundedRecallEnvelope, MaterialRecallItem, RecallContext } from "./recall.js";

export interface ReflectionEvidenceAccess {
  listMaterials(): readonly MaterialInventoryItem[];
  loadParse(materialId: string): Promise<CanonicalParse | undefined>;
}

export interface ReflectionEvidenceDrilldownQuery {
  readonly referenceId: string;
  readonly claim: string;
}

interface MaterialBlockReference {
  readonly materialId: string;
  readonly blockId: string;
  readonly contentVersion: string;
}

export class ReflectionEvidenceDrilldownSource {
  readonly #access: ReflectionEvidenceAccess;

  constructor(access: ReflectionEvidenceAccess) {
    this.#access = access;
  }

  async recall(query: ReflectionEvidenceDrilldownQuery, context: RecallContext): Promise<BoundedRecallEnvelope<MaterialRecallItem>> {
    const reference = parseMaterialBlockReference(query.referenceId);
    if (reference === undefined) {
      return unavailable(query, context, "The Assessment reference is not a stable parsed-block reference. Treat its claim as unsupported unless it is independently re-established.");
    }
    const material = this.#access.listMaterials().find((candidate) => candidate.id === reference.materialId && candidate.availability === "active");
    if (material === undefined) {
      return unavailable(query, context, "The referenced Material is unavailable in this Reflection scope. Treat its claim as unsupported.", reference);
    }
    if (material.sourceHash !== reference.contentVersion) {
      return unavailable(query, context, "The referenced Material has changed since the Independent Assessment. Do not rely on the handoff claim without a new assessment.", reference, material, "changed");
    }
    if (material.parseStatus === "stale") {
      return unavailable(query, context, "The referenced parse is stale. Choose a parse refresh before relying on the handoff claim.", reference, material, "stale");
    }
    const parse = await this.#access.loadParse(material.id);
    if (parse === undefined || parse.material.sourceHash !== reference.contentVersion) {
      return unavailable(query, context, "The exact referenced parse is unavailable. Treat the handoff claim as unsupported.", reference, material);
    }
    const block = parse.blocks.find((candidate) => candidate.id === reference.blockId);
    if (block === undefined) {
      return unavailable(query, context, "The referenced block cannot be resolved in the exact parse. Treat the handoff claim as unsupported.", reference, material);
    }
    const content = block.rows === undefined ? block.text ?? "" : block.rows.map((row) => row.join(" | ")).join("\n");
    if (content.length === 0) {
      return unavailable(query, context, "The referenced block contains no reviewable text. Treat the handoff claim as unsupported.", reference, material);
    }
    const bounded = content.slice(0, context.maxChars);
    const truncated = bounded.length < content.length;
    return {
      schemaVersion: 1,
      sourceClass: "material",
      disclosureLevel: "evidence_drilldown",
      items: [{ materialId: material.id, label: `${material.relativePath} / ${block.id}`, content: bounded, sourceRefs: [query.referenceId] }],
      complete: !truncated,
      omittedItems: truncated ? 1 : 0,
      warnings: [
        `Assessment claim: ${query.claim}`,
        "A resolved excerpt is not a support verdict. Compare it with the Assessment claim and explicitly mark the claim supported, mixed, or unsupported.",
        ...(truncated ? ["The referenced block was truncated by the per-call Evidence Drilldown budget."] : [])
      ],
      contextReference: contextReference(query, context, reference, material, "active")
    };
  }
}

export function parseMaterialBlockReference(referenceId: string): MaterialBlockReference | undefined {
  const match = /^material:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/block:([^@]+)@([a-f0-9]{64})$/iu.exec(referenceId);
  if (match === null) return undefined;
  return { materialId: match[1]!, blockId: match[2]!, contentVersion: match[3]!.toLowerCase() };
}

function unavailable(
  query: ReflectionEvidenceDrilldownQuery,
  context: RecallContext,
  warning: string,
  reference?: MaterialBlockReference,
  material?: MaterialInventoryItem,
  status: ContextReference["status"] = "source_unavailable"
): BoundedRecallEnvelope<MaterialRecallItem> {
  return {
    schemaVersion: 1,
    sourceClass: "material",
    disclosureLevel: "evidence_drilldown",
    items: [],
    complete: false,
    omittedItems: 0,
    warnings: [`Assessment claim: ${query.claim}`, warning],
    contextReference: contextReference(query, context, reference, material, status)
  };
}

function contextReference(
  query: ReflectionEvidenceDrilldownQuery,
  context: RecallContext,
  reference: MaterialBlockReference | undefined,
  material: MaterialInventoryItem | undefined,
  status: ContextReference["status"]
): ContextReference {
  return {
    schemaVersion: 1,
    sourceClass: "material",
    sourceId: reference?.materialId ?? query.referenceId,
    label: material?.relativePath ?? "Unresolved Assessment evidence reference",
    sourceRange: reference?.blockId ?? query.referenceId,
    ...(reference === undefined ? {} : { contentVersion: reference.contentVersion }),
    originatingTool: "reflection_evidence_drilldown",
    originatingTurnId: context.turnId,
    retrievedAt: context.retrievedAt,
    status
  };
}
