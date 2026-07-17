import { randomUUID } from "node:crypto";
import type { CanonicalParse, ContextReference, MaterialInventoryItem } from "@vc-agent/contracts";

export interface BoundedRecallEnvelope<T> {
  readonly schemaVersion: 1;
  readonly sourceClass: "material" | "project_state" | "memory" | "web" | "mcp";
  readonly disclosureLevel: string;
  readonly items: readonly T[];
  readonly complete: boolean;
  readonly omittedItems: number;
  readonly warnings: readonly string[];
  readonly contextReference: ContextReference;
}

export interface RecallSource<TQuery, TItem> {
  readonly sourceClass: BoundedRecallEnvelope<TItem>["sourceClass"];
  recall(query: TQuery, context: RecallContext): Promise<BoundedRecallEnvelope<TItem>>;
}

export interface RecallContext {
  readonly turnId: string;
  readonly maxItems: number;
  readonly maxChars: number;
  readonly retrievedAt: string;
}

export interface MaterialRecallQuery {
  readonly disclosureLevel: "cards" | "outline" | "excerpt" | "full";
  readonly materialId?: string;
  readonly blockIds?: readonly string[];
  readonly query?: string;
}

export interface MaterialRecallItem {
  readonly materialId: string;
  readonly label: string;
  readonly content: string;
  readonly sourceRefs: readonly string[];
}

export interface MaterialRecallAccess {
  listMaterials(): readonly MaterialInventoryItem[];
  loadParse(materialId: string): Promise<CanonicalParse | undefined>;
}

export class MaterialRecallSource implements RecallSource<MaterialRecallQuery, MaterialRecallItem> {
  readonly sourceClass = "material" as const;
  readonly #access: MaterialRecallAccess;

  constructor(access: MaterialRecallAccess) { this.#access = access; }

  async recall(query: MaterialRecallQuery, context: RecallContext): Promise<BoundedRecallEnvelope<MaterialRecallItem>> {
    const materials = this.#access.listMaterials().filter((item) => item.availability === "active");
    if (query.disclosureLevel === "cards") {
      const selected = materials.slice(0, context.maxItems);
      return envelope(query, context, selected.map((material) => ({
        materialId: material.id,
        label: material.relativePath,
        content: `${material.mediaType}; ${material.size} bytes; parse=${material.parseStatus}; versions=${material.parsedVersionCount}`,
        sourceRefs: [`material:${material.id}@${material.sourceHash}`]
      })), materials.length - selected.length, materials.length <= selected.length, materials[0]);
    }
    const material = materials.find((item) => item.id === query.materialId);
    if (material === undefined) return envelope(query, context, [], 0, true, undefined, ["Material is unavailable or outside the active scope."]);
    if (material.parseStatus === "stale") return envelope(query, context, [], 0, false, material, ["PARSE_REFRESH_CHOICE_REQUIRED"]);
    const parse = await this.#access.loadParse(material.id);
    if (parse === undefined) return envelope(query, context, [], 0, false, material, ["Canonical Parse is unavailable; parse the Material before expanding it."]);

    if (query.disclosureLevel === "outline") {
      const outline: MaterialRecallItem[] = [];
      let usedChars = 0;
      let omittedBlocks = 0;
      for (const unit of parse.structure.units) {
        if (outline.length >= context.maxItems || usedChars >= context.maxChars) break;
        const lines: string[] = [];
        const representedIds: string[] = [];
        for (const id of unit.blockIds) {
          const block = parse.blocks.find((candidate) => candidate.id === id);
          const line = block?.type === "heading" ? `${"#".repeat(block.level ?? 1)} ${block.text ?? ""}` : `${block?.type ?? "block"}:${id}`;
          const separator = lines.length === 0 ? 0 : 1;
          if (usedChars + lines.join("\n").length + separator + line.length > context.maxChars) break;
          lines.push(line);
          representedIds.push(id);
        }
        omittedBlocks += unit.blockIds.length - representedIds.length;
        if (representedIds.length === 0) break;
        const content = lines.join("\n");
        usedChars += content.length;
        outline.push({
          materialId: material.id,
          label: unit.name ?? `${parse.structure.kind} ${unit.index}`,
          content,
          sourceRefs: representedIds.map((id) => `material:${material.id}/block:${id}@${material.sourceHash}`)
        });
      }
      const omitted = Math.max(0, parse.structure.units.length - outline.length) + omittedBlocks;
      const warnings = omitted === 0 ? [] : [`${omitted} outline item(s) omitted by the bounded retrieval envelope.`];
      return envelope(query, context, outline, omitted, omitted === 0, material, warnings);
    }

    const requestedIds = new Set(query.blockIds ?? []);
    const needle = query.query?.trim().toLocaleLowerCase();
    const candidates = parse.blocks.filter((block) => requestedIds.size > 0
      ? requestedIds.has(block.id)
      : needle === undefined || needle.length === 0 || blockText(block).toLocaleLowerCase().includes(needle));
    const selected: MaterialRecallItem[] = [];
    let usedChars = 0;
    for (const block of candidates) {
      if (selected.length >= context.maxItems) break;
      const content = blockText(block);
      if (usedChars + content.length > context.maxChars) break;
      usedChars += content.length;
      selected.push({ materialId: material.id, label: `${material.relativePath} / ${block.id}`, content, sourceRefs: [`material:${material.id}/block:${block.id}@${material.sourceHash}`] });
    }
    const omitted = Math.max(0, candidates.length - selected.length);
    const warnings = omitted === 0 ? [] : [`${omitted} block(s) omitted by the bounded retrieval envelope; retrieve another batch before claiming full review.`];
    return envelope(query, context, selected, omitted, omitted === 0, material, warnings);
  }
}

function blockText(block: CanonicalParse["blocks"][number]): string {
  if (block.rows !== undefined) return block.rows.map((row) => row.join(" | ")).join("\n");
  return block.text ?? "";
}

function envelope(
  query: MaterialRecallQuery,
  context: RecallContext,
  items: readonly MaterialRecallItem[],
  omittedItems: number,
  complete: boolean,
  material?: MaterialInventoryItem,
  warnings: readonly string[] = []
): BoundedRecallEnvelope<MaterialRecallItem> {
  const sourceId = material?.id ?? "material-inventory";
  return {
    schemaVersion: 1,
    sourceClass: "material",
    disclosureLevel: query.disclosureLevel,
    items,
    complete,
    omittedItems,
    warnings,
    contextReference: {
      schemaVersion: 1,
      sourceClass: "material",
      sourceId,
      label: material?.relativePath ?? "Material Inventory",
      sourceRange: query.disclosureLevel === "cards" ? "cards" : query.blockIds?.join(",") || query.query || query.disclosureLevel,
      ...(material === undefined ? {} : { contentVersion: material.sourceHash }),
      originatingTool: "material_recall",
      originatingTurnId: context.turnId,
      retrievedAt: context.retrievedAt,
      status: material?.parseStatus === "stale" ? "stale" : "active"
    }
  };
}

export function retrievalMetadata(envelope: BoundedRecallEnvelope<unknown>, body: string) {
  return { payloadId: randomUUID(), retention: "turn_scoped" as const, bodyBytes: Buffer.byteLength(body, "utf8"), contextReference: envelope.contextReference };
}
