import { load } from "cheerio";
import type { AcademicEntity, AcademicEvidence, AcademicResearchRequest } from "@vc-agent/contracts";
import type { AcademicHttpAccess } from "../http-access.js";
import type { AcademicPdfExtractor, AcademicSourceAdapter, AcademicSourceExecutionContext, AcademicSourceResult } from "../models.js";
import { contentHash, evidenceId, normalizeArxivId, normalizeDoi, stableId } from "../normalize.js";

export class ArxivAdapter implements AcademicSourceAdapter {
  readonly source = "arxiv" as const;
  readonly #http: AcademicHttpAccess;
  readonly #extractPdf: AcademicPdfExtractor | undefined;
  readonly #minimumIntervalMs: number;
  #tail: Promise<void> = Promise.resolve();
  #lastRequestAt = 0;

  constructor(http: AcademicHttpAccess, options: { readonly extractPdf?: AcademicPdfExtractor; readonly minimumIntervalMs?: number } = {}) {
    this.#http = http;
    this.#extractPdf = options.extractPdf;
    this.#minimumIntervalMs = Math.max(0, options.minimumIntervalMs ?? 3_000);
  }

  supports(request: AcademicResearchRequest): boolean {
    if (request.sources !== undefined && !request.sources.includes(this.source)) return false;
    if (request.operation === "graph" || request.operation === "link_artifacts") return false;
    if (request.targets !== undefined && !request.targets.includes("works")) return false;
    return true;
  }

  async execute(request: AcademicResearchRequest, context: AcademicSourceExecutionContext): Promise<AcademicSourceResult> {
    try {
      if (request.operation === "fetch_content") return await this.#content(request, context);
      const query = request.operation === "search"
        ? (request.queries ?? []).map((item) => `all:"${escapeQuery(item)}"`).join(" OR ")
        : identifierQuery(request.identifier!.kind, request.identifier!.value);
      if (query === undefined) return unavailable("ARXIV_IDENTIFIER_UNSUPPORTED");
      const url = new URL("https://export.arxiv.org/api/query");
      url.searchParams.set("search_query", query);
      url.searchParams.set("start", "0");
      url.searchParams.set("max_results", String(request.limit));
      url.searchParams.set("sortBy", request.sort === "recent" ? "submittedDate" : "relevance");
      const response = await this.#queuedRequest(url.toString(), context.signal);
      if (!response.status.toString().startsWith("2")) throw new Error(`ARXIV_HTTP_${response.status}`);
      const entities = parseFeed(response.text(), context.retrievedAt).slice(0, request.limit);
      return {
        source: this.source,
        entities,
        edges: [],
        evidence: entities.flatMap(entityEvidence),
        warnings: entities.length === 0 ? [{ code: "ARXIV_NO_RESULTS", message: "arXiv returned no matching records.", source: this.source }] : [],
        omittedItems: 0,
        status: "completed"
      };
    } catch (error) {
      return unavailable(safeCode(error, "ARXIV_UNAVAILABLE"));
    }
  }

  async #content(request: AcademicResearchRequest, context: AcademicSourceExecutionContext): Promise<AcademicSourceResult> {
    if (this.#extractPdf === undefined) return unavailable("ARXIV_PDF_EXTRACTOR_UNAVAILABLE");
    const arxivId = normalizeArxivId(request.identifier!.value);
    if (arxivId === undefined) return unavailable("ARXIV_IDENTIFIER_INVALID");
    const url = `https://arxiv.org/pdf/${encodeURIComponent(arxivId)}`;
    const extraction = await this.#extractPdf({ url, arxivId, maxChars: request.maxChars, ...(context.signal === undefined ? {} : { signal: context.signal }) });
    const entityId = `work_arxiv_${arxivId.replace(/[/.]/gu, "_")}`;
    const evidence: AcademicEvidence[] = extraction.sections.map((section) => ({
      evidenceId: evidenceId("arxiv", arxivId, `paper_text:${section.pageFrom}-${section.pageTo}:${section.name}`),
      source: "arxiv",
      sourceEntityId: entityId,
      sourceUrl: `https://arxiv.org/abs/${arxivId}`,
      retrievedAt: context.retrievedAt,
      evidenceType: "paper_text",
      supportedFields: ["paperText", `section:${section.name}`],
      excerpt: section.text.slice(0, 8_000),
      contentHash: extraction.contentHash
    }));
    return {
      source: this.source,
      entities: [],
      edges: [],
      evidence,
      warnings: extraction.warnings.map((message) => ({ code: "ARXIV_PDF_WARNING", message, source: this.source })),
      omittedItems: 0,
      status: extraction.warnings.length > 0 ? "partial" : "completed"
    };
  }

  async #queuedRequest(url: string, signal?: AbortSignal) {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const wait = Math.max(0, this.#minimumIntervalMs - (Date.now() - this.#lastRequestAt));
      if (wait > 0) await abortableDelay(wait, signal);
      this.#lastRequestAt = Date.now();
      return await this.#http.request({ url, signal });
    } finally {
      release();
    }
  }
}

function parseFeed(xml: string, retrievedAt: string): Extract<AcademicEntity, { type: "work" }>[] {
  const $ = load(xml, { xmlMode: true });
  return $("entry").toArray().map((entry) => {
    const node = $(entry);
    const rawId = node.find("id").first().text().trim();
    const arxivId = normalizeArxivId(rawId);
    const title = normalizeWhitespace(node.find("title").first().text());
    if (arxivId === undefined || title.length === 0) return undefined;
    const authors = node.find("author").toArray().map((author, index) => {
      const name = normalizeWhitespace($(author).find("name").text());
      return { entityId: stableId("author", name), displayName: name, position: index + 1 };
    }).filter((author) => author.displayName.length > 0);
    const doi = normalizeDoi(node.find("arxiv\\:doi, doi").first().text());
    const categories = node.find("category").toArray().map((category) => $(category).attr("term") ?? "").filter(Boolean);
    const pdfUrl = node.find('link[type="application/pdf"]').attr("href") ?? `https://arxiv.org/pdf/${arxivId}`;
    const sourceUrl = `https://arxiv.org/abs/${arxivId}`;
    return {
      entityId: `work_arxiv_${arxivId.replace(/[/.]/gu, "_")}`,
      type: "work" as const,
      title,
      abstract: normalizeWhitespace(node.find("summary").first().text()),
      authors,
      institutions: [],
      firstSubmittedDate: node.find("published").first().text().trim() || undefined,
      lastUpdatedDate: node.find("updated").first().text().trim() || undefined,
      identifiers: { ...(doi === undefined ? {} : { doi }), arxiv: arxivId },
      categories,
      topics: [],
      primaryUrl: sourceUrl,
      pdfUrl,
      publicationStatus: "preprint" as const,
      sourceRecords: [{ source: "arxiv" as const, sourceId: arxivId, sourceUrl, retrievedAt, contentHash: contentHash(node.toString()) }]
    };
  }).filter((item): item is NonNullable<typeof item> => item !== undefined);
}

function entityEvidence(entity: Extract<AcademicEntity, { type: "work" }>): AcademicEvidence[] {
  const record = entity.sourceRecords[0]!;
  return [
    {
      evidenceId: evidenceId("arxiv", record.sourceId, "metadata"),
      source: "arxiv",
      sourceEntityId: entity.entityId,
      sourceUrl: record.sourceUrl,
      retrievedAt: record.retrievedAt,
      evidenceType: "metadata",
      supportedFields: ["title", "authors", "identifiers", "firstSubmittedDate", "lastUpdatedDate", "publicationStatus"],
      contentHash: record.contentHash
    },
    ...(entity.abstract === undefined ? [] : [{
      evidenceId: evidenceId("arxiv", record.sourceId, "abstract"),
      source: "arxiv" as const,
      sourceEntityId: entity.entityId,
      sourceUrl: record.sourceUrl,
      retrievedAt: record.retrievedAt,
      evidenceType: "abstract" as const,
      supportedFields: ["abstract"],
      excerpt: entity.abstract.slice(0, 4_000),
      contentHash: record.contentHash
    }])
  ];
}

function identifierQuery(kind: NonNullable<AcademicResearchRequest["identifier"]>["kind"], value: string): string | undefined {
  if (kind === "arxiv" || (kind === "url" && value.includes("arxiv.org"))) {
    const id = normalizeArxivId(value);
    return id === undefined ? undefined : `id:${id}`;
  }
  if (kind === "title") return `ti:"${escapeQuery(value)}"`;
  return undefined;
}
function escapeQuery(value: string): string { return value.replace(/["\\]/gu, " ").trim(); }
function normalizeWhitespace(value: string): string { return value.replace(/\s+/gu, " ").trim(); }
function unavailable(code: string): AcademicSourceResult { return { source: "arxiv", entities: [], edges: [], evidence: [], warnings: [{ code, message: code.replaceAll("_", " "), source: "arxiv" }], omittedItems: 0, status: "unavailable" }; }
function safeCode(error: unknown, fallback: string): string { const message = error instanceof Error ? error.message : fallback; return /^[A-Z0-9_:]+$/u.test(message) ? message.replaceAll(":", "_") : fallback; }
async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("ARXIV_ABORTED");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); reject(new Error("ARXIV_ABORTED")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
