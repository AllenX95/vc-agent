import type { AcademicEdge, AcademicEntity, AcademicEvidence, AcademicResearchRequest } from "@vc-agent/contracts";
import type { AcademicHttpAccess } from "../http-access.js";
import type { AcademicSourceAdapter, AcademicSourceExecutionContext, AcademicSourceResult } from "../models.js";
import { contentHash, evidenceId, normalizeArxivId, normalizeDoi, normalizeOpenAlexId, stableId } from "../normalize.js";

interface OpenAlexList {
  readonly meta?: { readonly count?: number };
  readonly results?: unknown[];
}

export class OpenAlexAdapter implements AcademicSourceAdapter {
  readonly source = "openalex" as const;
  readonly #http: AcademicHttpAccess;

  constructor(http: AcademicHttpAccess) {
    this.#http = http;
  }

  supports(request: AcademicResearchRequest): boolean {
    if (request.sources !== undefined && !request.sources.includes(this.source)) return false;
    if (request.operation === "fetch_content" || request.operation === "link_artifacts") return false;
    return request.targets === undefined || request.targets.some((target) => target === "works" || target === "authors");
  }

  async execute(request: AcademicResearchRequest, context: AcademicSourceExecutionContext): Promise<AcademicSourceResult> {
    const apiKey = context.credentials.openalex;
    if (apiKey === undefined || apiKey.length === 0) return unavailable("OPENALEX_CREDENTIAL_REQUIRED", context.retrievedAt);
    try {
      if (request.operation === "search") return await this.#search(request, context, apiKey);
      if (request.operation === "graph") return await this.#graph(request, context, apiKey);
      return await this.#get(request, context, apiKey);
    } catch (error) {
      return unavailable(safeCode(error, "OPENALEX_UNAVAILABLE"), context.retrievedAt);
    }
  }

  async #search(request: AcademicResearchRequest, context: AcademicSourceExecutionContext, apiKey: string): Promise<AcademicSourceResult> {
    const target = request.targets?.includes("authors") && !request.targets.includes("works") ? "authors" : "works";
    const entities: AcademicEntity[] = [];
    let total = 0;
    for (const query of request.queries ?? []) {
      const url = new URL(`https://api.openalex.org/${target}`);
      url.searchParams.set(query.length > 180 ? "search.semantic" : "search", query);
      url.searchParams.set("per_page", String(Math.min(request.limit, 25)));
      url.searchParams.set("api_key", apiKey);
      if (target === "works") {
        const filters: string[] = [];
        if (request.filters?.dateFrom !== undefined) filters.push(`from_publication_date:${request.filters.dateFrom}`);
        if (request.filters?.dateTo !== undefined) filters.push(`to_publication_date:${request.filters.dateTo}`);
        if (filters.length > 0) url.searchParams.set("filter", filters.join(","));
      }
      const response = await this.#http.request({ url: url.toString(), signal: context.signal });
      if (!response.status.toString().startsWith("2")) throw new Error(`OPENALEX_HTTP_${response.status}`);
      const payload = response.json() as OpenAlexList;
      total += payload.meta?.count ?? 0;
      for (const item of payload.results ?? []) {
        const mapped = target === "authors" ? mapAuthor(item, context.retrievedAt) : mapWork(item, context.retrievedAt);
        if (mapped !== undefined) entities.push(mapped);
      }
    }
    const limited = entities.slice(0, request.limit);
    const evidence = limited.flatMap(entityEvidence);
    return {
      source: this.source,
      entities: limited,
      edges: [],
      evidence,
      warnings: [],
      omittedItems: Math.max(0, total - limited.length),
      status: "completed"
    };
  }

  async #get(request: AcademicResearchRequest, context: AcademicSourceExecutionContext, apiKey: string): Promise<AcademicSourceResult> {
    const identifier = request.identifier!;
    const isAuthor = request.targets?.length === 1 && request.targets[0] === "authors";
    const path = resolvePath(identifier.kind, identifier.value, isAuthor);
    if (path === undefined) {
      const searchRequest: AcademicResearchRequest = { ...request, operation: "search", queries: [identifier.value], targets: isAuthor ? ["authors"] : ["works"] };
      return this.#search(searchRequest, context, apiKey);
    }
    const url = new URL(`https://api.openalex.org/${path}`);
    url.searchParams.set("api_key", apiKey);
    const response = await this.#http.request({ url: url.toString(), signal: context.signal });
    if (response.status === 404) return unavailable("OPENALEX_NOT_FOUND", context.retrievedAt);
    if (!response.status.toString().startsWith("2")) throw new Error(`OPENALEX_HTTP_${response.status}`);
    const entity = isAuthor ? mapAuthor(response.json(), context.retrievedAt) : mapWork(response.json(), context.retrievedAt);
    if (entity === undefined) return unavailable("OPENALEX_RESPONSE_INVALID", context.retrievedAt);
    return { source: this.source, entities: [entity], edges: [], evidence: entityEvidence(entity), warnings: [], omittedItems: 0, status: "completed" };
  }

  async #graph(request: AcademicResearchRequest, context: AcademicSourceExecutionContext, apiKey: string): Promise<AcademicSourceResult> {
    const resolved = await this.#get({ ...request, operation: "inspect", targets: ["works"] }, context, apiKey);
    const seed = resolved.entities.find((entity): entity is Extract<AcademicEntity, { type: "work" }> => entity.type === "work");
    if (seed === undefined) return resolved;
    if (request.relation === "references") {
      const response = await this.#http.request({
        url: `https://api.openalex.org/works/${seed.identifiers.openalex}?api_key=${encodeURIComponent(apiKey)}`,
        signal: context.signal
      });
      if (!response.status.toString().startsWith("2")) throw new Error(`OPENALEX_HTTP_${response.status}`);
      const raw = asRecord(response.json());
      const referenceIds = Array.isArray(raw?.referenced_works) ? raw.referenced_works.filter((value): value is string => typeof value === "string") : [];
      return this.#fetchGraphEntities(seed, referenceIds, "references", request, context, apiKey);
    }
    if (request.relation === "citations") {
      const url = new URL("https://api.openalex.org/works");
      url.searchParams.set("filter", `cites:${seed.identifiers.openalex}`);
      url.searchParams.set("per_page", String(request.limit));
      url.searchParams.set("api_key", apiKey);
      const response = await this.#http.request({ url: url.toString(), signal: context.signal });
      if (!response.status.toString().startsWith("2")) throw new Error(`OPENALEX_HTTP_${response.status}`);
      const payload = response.json() as OpenAlexList;
      const entities = (payload.results ?? []).map((item) => mapWork(item, context.retrievedAt)).filter((item): item is Extract<AcademicEntity, { type: "work" }> => item !== undefined);
      const evidence = [...resolved.evidence, ...entities.flatMap(entityEvidence)];
      const edges = entities.map((entity): AcademicEdge => ({
        sourceEntityId: entity.entityId,
        targetEntityId: seed.entityId,
        relation: "cites",
        confidence: "high",
        evidenceIds: entityEvidence(entity).map((item) => item.evidenceId)
      }));
      return { source: this.source, entities: [seed, ...entities], edges, evidence, warnings: [], omittedItems: Math.max(0, (payload.meta?.count ?? entities.length) - entities.length), status: "completed" };
    }
    return { ...resolved, warnings: [{ code: "OPENALEX_RELATION_UNSUPPORTED", message: `OpenAlex v0.1 does not implement ${request.relation}.`, source: this.source }], status: "partial" };
  }

  async #fetchGraphEntities(seed: Extract<AcademicEntity, { type: "work" }>, ids: readonly string[], relation: "references", request: AcademicResearchRequest, context: AcademicSourceExecutionContext, apiKey: string): Promise<AcademicSourceResult> {
    const selected = ids.slice(0, request.limit);
    if (selected.length === 0) return { source: this.source, entities: [seed], edges: [], evidence: entityEvidence(seed), warnings: [], omittedItems: 0, status: "completed" };
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("filter", `openalex_id:${selected.map((id) => normalizeOpenAlexId(id)).filter(Boolean).join("|")}`);
    url.searchParams.set("per_page", String(selected.length));
    url.searchParams.set("api_key", apiKey);
    const response = await this.#http.request({ url: url.toString(), signal: context.signal });
    if (!response.status.toString().startsWith("2")) throw new Error(`OPENALEX_HTTP_${response.status}`);
    const payload = response.json() as OpenAlexList;
    const entities = (payload.results ?? []).map((item) => mapWork(item, context.retrievedAt)).filter((item): item is Extract<AcademicEntity, { type: "work" }> => item !== undefined);
    const evidence = [seed, ...entities].flatMap(entityEvidence);
    const edges = entities.map((entity): AcademicEdge => ({
      sourceEntityId: seed.entityId,
      targetEntityId: entity.entityId,
      relation,
      confidence: "high",
      evidenceIds: entityEvidence(seed).map((item) => item.evidenceId)
    }));
    return { source: this.source, entities: [seed, ...entities], edges, evidence, warnings: [], omittedItems: Math.max(0, ids.length - entities.length), status: "completed" };
  }
}

function mapWork(value: unknown, retrievedAt: string): Extract<AcademicEntity, { type: "work" }> | undefined {
  const raw = asRecord(value);
  const id = string(raw?.id);
  const title = string(raw?.title) ?? string(raw?.display_name);
  if (id === undefined || title === undefined) return undefined;
  const openalex = normalizeOpenAlexId(id);
  if (openalex === undefined) return undefined;
  const ids = asRecord(raw?.ids);
  const doi = normalizeDoi(string(ids?.doi) ?? string(raw?.doi));
  const arxiv = normalizeArxivId(string(ids?.arxiv));
  const authorships = Array.isArray(raw?.authorships) ? raw.authorships : [];
  const authors = authorships.map((entry, index) => {
    const record = asRecord(entry);
    const author = asRecord(record?.author);
    const name = string(author?.display_name);
    const authorId = string(author?.id);
    return name === undefined ? undefined : { entityId: authorId === undefined ? stableId("author", name) : `author_openalex_${normalizeOpenAlexId(authorId) ?? stableId("x", authorId)}`, displayName: name, position: index + 1 };
  }).filter((item): item is NonNullable<typeof item> => item !== undefined);
  const institutions = authorships.flatMap((entry) => {
    const record = asRecord(entry);
    return (Array.isArray(record?.institutions) ? record.institutions : []).map((institution) => {
      const item = asRecord(institution);
      const name = string(item?.display_name);
      const institutionId = string(item?.id);
      return name === undefined ? undefined : { entityId: institutionId === undefined ? stableId("institution", name) : stableId("institution", institutionId), displayName: name };
    }).filter((item): item is NonNullable<typeof item> => item !== undefined);
  });
  const topics = (Array.isArray(raw?.topics) ? raw.topics : []).map((topic) => string(asRecord(topic)?.display_name)).filter((item): item is string => item !== undefined);
  const locations = asRecord(raw?.best_oa_location) ?? asRecord(raw?.primary_location);
  const sourceUrl = `https://openalex.org/${openalex}`;
  return {
    entityId: `work_openalex_${openalex}`,
    type: "work",
    title,
    ...(reconstructAbstract(raw?.abstract_inverted_index) === undefined ? {} : { abstract: reconstructAbstract(raw?.abstract_inverted_index)! }),
    authors,
    institutions: uniqueBy(institutions, (item) => item.entityId),
    ...(string(raw?.publication_date) === undefined ? {} : { publicationDate: string(raw?.publication_date)! }),
    identifiers: { ...(doi === undefined ? {} : { doi }), ...(arxiv === undefined ? {} : { arxiv }), openalex },
    categories: [],
    topics,
    ...(number(raw?.cited_by_count) === undefined ? {} : { citationCount: number(raw?.cited_by_count)! }),
    referenceCount: Array.isArray(raw?.referenced_works) ? raw.referenced_works.length : 0,
    primaryUrl: string(locations?.landing_page_url) ?? sourceUrl,
    ...(string(locations?.pdf_url) === undefined ? {} : { pdfUrl: string(locations?.pdf_url)! }),
    publicationStatus: "indexed_publication",
    sourceRecords: [{ source: "openalex", sourceId: openalex, sourceUrl, retrievedAt, contentHash: contentHash(JSON.stringify(value)) }]
  };
}

function mapAuthor(value: unknown, retrievedAt: string): Extract<AcademicEntity, { type: "author" }> | undefined {
  const raw = asRecord(value);
  const id = normalizeOpenAlexId(string(raw?.id));
  const displayName = string(raw?.display_name);
  if (id === undefined || displayName === undefined) return undefined;
  const last = Array.isArray(raw?.last_known_institutions) ? raw.last_known_institutions : [];
  const affiliations = last.map((value) => {
    const item = asRecord(value);
    const name = string(item?.display_name);
    const institutionId = string(item?.id);
    return name === undefined ? undefined : { entityId: stableId("institution", institutionId ?? name), displayName: name };
  }).filter((item): item is NonNullable<typeof item> => item !== undefined);
  const sourceUrl = `https://openalex.org/${id}`;
  return {
    entityId: `author_openalex_${id}`,
    type: "author",
    displayName,
    alternativeNames: Array.isArray(raw?.display_name_alternatives) ? raw.display_name_alternatives.filter((item): item is string => typeof item === "string") : [],
    affiliations,
    identifiers: { openalex: id },
    workIds: [],
    resolutionStatus: "candidate",
    sourceRecords: [{ source: "openalex", sourceId: id, sourceUrl, retrievedAt, contentHash: contentHash(JSON.stringify(value)) }]
  };
}

function entityEvidence(entity: AcademicEntity): AcademicEvidence[] {
  const record = entity.sourceRecords[0];
  if (record === undefined) return [];
  const supportedFields = entity.type === "work" ? ["title", "authors", "identifiers", "publicationDate", "citationCount", "topics"] : entity.type === "author" ? ["displayName", "affiliations", "identifiers"] : [];
  return [{
    evidenceId: evidenceId("openalex", record.sourceId, "metadata"),
    source: "openalex",
    sourceEntityId: entity.entityId,
    sourceUrl: record.sourceUrl,
    retrievedAt: record.retrievedAt,
    evidenceType: "metadata",
    supportedFields,
    ...(record.contentHash === undefined ? {} : { contentHash: record.contentHash })
  }];
}

function resolvePath(kind: NonNullable<AcademicResearchRequest["identifier"]>["kind"], value: string, author: boolean): string | undefined {
  if (author) {
    const id = normalizeOpenAlexId(value);
    return id?.startsWith("A") ? `authors/${id}` : undefined;
  }
  if (kind === "doi") return `works/doi:${normalizeDoi(value)}`;
  if (kind === "openalex") {
    const id = normalizeOpenAlexId(value);
    return id?.startsWith("W") ? `works/${id}` : undefined;
  }
  if (kind === "arxiv") return `works/arxiv:${normalizeArxivId(value)}`;
  if (kind === "url") {
    const oa = normalizeOpenAlexId(value);
    if (oa?.startsWith("W")) return `works/${oa}`;
    const doi = normalizeDoi(value);
    if (doi !== undefined && value.toLowerCase().includes("doi.org")) return `works/doi:${doi}`;
  }
  return undefined;
}

function reconstructAbstract(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const words: Array<{ word: string; position: number }> = [];
  for (const [word, positions] of Object.entries(record)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) if (typeof position === "number") words.push({ word, position });
  }
  words.sort((a, b) => a.position - b.position);
  return words.length === 0 ? undefined : words.map((item) => item.word).join(" ");
}

function unavailable(code: string, retrievedAt: string): AcademicSourceResult {
  return { source: "openalex", entities: [], edges: [], evidence: [], warnings: [{ code, message: code.replaceAll("_", " "), source: "openalex" }], omittedItems: 0, status: "unavailable" };
}
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined; }
function safeCode(error: unknown, fallback: string): string { const message = error instanceof Error ? error.message : fallback; return /^[A-Z0-9_]+$/u.test(message) ? message : fallback; }
function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] { return [...new Map(items.map((item) => [key(item), item])).values()]; }
