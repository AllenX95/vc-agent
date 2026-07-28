import { createHash } from "node:crypto";
import type { AcademicEntity } from "@vc-agent/contracts";

export function normalizeDoi(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "").replace(/^doi:/iu, "").toLowerCase();
  return normalized.length === 0 ? undefined : normalized;
}

export function normalizeArxivId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim()
    .replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//iu, "")
    .replace(/\.pdf$/iu, "")
    .replace(/^arxiv:/iu, "")
    .replace(/v\d+$/iu, "");
  return /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}$/iu.test(normalized) || /^\d{4}\.\d{4,5}$/u.test(normalized) ? normalized : undefined;
}

export function normalizeOpenAlexId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/^https?:\/\/openalex\.org\//iu, "").toUpperCase();
  return /^W\d+$/u.test(normalized) || /^A\d+$/u.test(normalized) ? normalized : undefined;
}

export function normalizedTitle(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function stableId(kind: string, value: string): string {
  return `${kind}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function evidenceId(source: string, sourceId: string, kind: string): string {
  return stableId("evidence", `${source}\0${sourceId}\0${kind}`);
}

export function contentHash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deduplicateEntities(entities: readonly AcademicEntity[]): { entities: AcademicEntity[]; omitted: number } {
  const byKey = new Map<string, AcademicEntity>();
  let omitted = 0;
  for (const entity of entities) {
    const key = entity.type === "work"
      ? entity.identifiers.doi !== undefined ? `doi:${entity.identifiers.doi}` :
        entity.identifiers.arxiv !== undefined ? `arxiv:${entity.identifiers.arxiv}` :
          entity.identifiers.openalex !== undefined ? `openalex:${entity.identifiers.openalex}` :
            `title:${normalizedTitle(entity.title)}:${entity.authors[0]?.displayName.toLowerCase() ?? ""}`
      : `${entity.type}:${entity.entityId}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, entity);
      continue;
    }
    omitted += 1;
    if (existing.type === "work" && entity.type === "work") byKey.set(key, mergeWorks(existing, entity));
  }
  return { entities: [...byKey.values()], omitted };
}

function mergeWorks(left: Extract<AcademicEntity, { type: "work" }>, right: Extract<AcademicEntity, { type: "work" }>): Extract<AcademicEntity, { type: "work" }> {
  return {
    ...left,
    abstract: left.abstract ?? right.abstract,
    publicationDate: left.publicationDate ?? right.publicationDate,
    firstSubmittedDate: left.firstSubmittedDate ?? right.firstSubmittedDate,
    lastUpdatedDate: left.lastUpdatedDate ?? right.lastUpdatedDate,
    identifiers: { ...right.identifiers, ...left.identifiers },
    categories: [...new Set([...left.categories, ...right.categories])],
    topics: [...new Set([...left.topics, ...right.topics])],
    citationCount: Math.max(left.citationCount ?? 0, right.citationCount ?? 0) || undefined,
    referenceCount: Math.max(left.referenceCount ?? 0, right.referenceCount ?? 0) || undefined,
    primaryUrl: left.primaryUrl ?? right.primaryUrl,
    pdfUrl: left.pdfUrl ?? right.pdfUrl,
    publicationStatus: left.publicationStatus === "indexed_publication" || right.publicationStatus === "indexed_publication" ? "indexed_publication" : left.publicationStatus,
    sourceRecords: [...left.sourceRecords, ...right.sourceRecords]
  };
}

