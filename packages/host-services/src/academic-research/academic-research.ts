import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  academicResearchRequestSchema,
  academicResearchResultSchema,
  type AcademicEdge,
  type AcademicEntity,
  type AcademicEvidence,
  type AcademicResearchRequest,
  type AcademicResearchResult,
  type AcademicSource
} from "@vc-agent/contracts";
import { ArxivAdapter } from "./adapters/arxiv.js";
import { GitHubAdapter } from "./adapters/github.js";
import { HuggingFaceAdapter } from "./adapters/huggingface.js";
import { OpenAlexAdapter } from "./adapters/openalex.js";
import { DefaultAcademicHttpAccess, type AcademicHttpAccess } from "./http-access.js";
import type { AcademicPdfExtractor, AcademicSourceAdapter, AcademicSourceResult } from "./models.js";
import { contentHash, deduplicateEntities, normalizeArxivId, normalizedTitle } from "./normalize.js";

export interface AcademicResearchContext {
  readonly turnId: string;
  readonly credentials?: Readonly<Partial<Record<AcademicSource, string>>>;
  readonly signal?: AbortSignal;
  readonly retrievedAt?: string;
}

export interface AcademicResearchServiceOptions {
  readonly adapters?: readonly AcademicSourceAdapter[];
  readonly http?: AcademicHttpAccess;
  readonly extractPdf?: AcademicPdfExtractor;
  readonly arxivMinimumIntervalMs?: number;
  readonly now?: () => string;
  readonly cache?: AcademicResearchCache;
  readonly runStore?: AcademicResearchRunStore;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly result: AcademicResearchResult;
}

export class AcademicResearchCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get(key: string): AcademicResearchResult | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return structuredClone(entry.result);
  }

  set(key: string, result: AcademicResearchResult, ttlMs: number): void {
    this.#entries.set(key, { expiresAt: this.#now() + ttlMs, result: structuredClone(result) });
  }

  clear(): void {
    this.#entries.clear();
  }
}

export class AcademicResearchRunStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  write(request: AcademicResearchRequest, result: AcademicResearchResult): string {
    const directory = resolve(this.#root, result.runId);
    if (!directory.startsWith(`${this.#root}${sep}`)) throw new Error("ACADEMIC_RUN_PATH_REJECTED");
    mkdirSync(directory, { recursive: true });
    this.#writeJson(directory, "request.json", request);
    this.#writeJson(directory, "source-status.json", result.sourceStatus);
    this.#writeJson(directory, "entities.json", result.entities);
    this.#writeJson(directory, "edges.json", result.edges);
    this.#writeJson(directory, "evidence.json", result.evidence.map(({ excerpt, ...record }) => ({ ...record, excerptChars: excerpt?.length ?? 0 })));
    this.#writeJson(directory, "warnings.json", result.warnings);
    return directory;
  }

  #writeJson(directory: string, name: string, value: unknown): void {
    const target = join(directory, name);
    const temporary = `${target}.partial`;
    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export class AcademicResearchService {
  readonly #adapters: readonly AcademicSourceAdapter[];
  readonly #now: () => string;
  readonly #cache: AcademicResearchCache;
  readonly #runStore: AcademicResearchRunStore | undefined;

  constructor(options: AcademicResearchServiceOptions = {}) {
    const http = options.http ?? new DefaultAcademicHttpAccess();
    this.#adapters = options.adapters ?? [
      new OpenAlexAdapter(http),
      new ArxivAdapter(http, {
        ...(options.extractPdf === undefined ? {} : { extractPdf: options.extractPdf }),
        ...(options.arxivMinimumIntervalMs === undefined ? {} : { minimumIntervalMs: options.arxivMinimumIntervalMs })
      }),
      new GitHubAdapter(http),
      new HuggingFaceAdapter(http)
    ];
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#cache = options.cache ?? new AcademicResearchCache();
    this.#runStore = options.runStore;
  }

  async execute(input: AcademicResearchRequest, context: AcademicResearchContext): Promise<AcademicResearchResult> {
    const request = academicResearchRequestSchema.parse(input);
    const retrievedAt = context.retrievedAt ?? this.#now();
    const cacheKey = contentHash(JSON.stringify({ request, credentials: Object.keys(context.credentials ?? {}).sort() }));
    const cached = request.operation === "fetch_content" ? undefined : this.#cache.get(cacheKey);
    if (cached !== undefined) {
      return academicResearchResultSchema.parse({
        ...cached,
        sourceStatus: cached.sourceStatus.map((status) => ({ ...status, cacheStatus: status.attempted ? "hit" : status.cacheStatus }))
      });
    }

    const selected = this.#adapters.map((adapter) => ({
      adapter,
      request: requestForAdapter(request, adapter.source)
    })).filter((selection) => selection.adapter.supports(selection.request));
    const results = await Promise.all(selected.map(async ({ adapter, request: sourceRequest }): Promise<AcademicSourceResult> => {
      try {
        return await adapter.execute(sourceRequest, {
          retrievedAt,
          credentials: context.credentials ?? {},
          ...(context.signal === undefined ? {} : { signal: context.signal })
        });
      } catch (error) {
        return {
          source: adapter.source,
          entities: [],
          edges: [],
          evidence: [],
          warnings: [{ code: "ACADEMIC_SOURCE_FAILED", message: `${adapter.source} failed: ${safeMessage(error)}`, source: adapter.source }],
          omittedItems: 0,
          status: "unavailable"
        };
      }
    }));

    const deduplicated = deduplicateEntities(results.flatMap((result) => result.entities));
    const evidence = uniqueBy(results.flatMap((result) => result.evidence), (item) => item.evidenceId);
    const edges = uniqueEdges([...results.flatMap((result) => result.edges), ...linkArtifacts(deduplicated.entities, evidence)]);
    const failed = results.filter((result) => result.status === "unavailable").length;
    const partial = results.some((result) => result.status === "partial");
    const result: AcademicResearchResult = {
      schemaVersion: 1,
      runId: randomUUID(),
      operation: request.operation,
      status: selected.length === 0 || failed === selected.length ? "unavailable" : failed > 0 || partial ? "partial" : "completed",
      entities: deduplicated.entities.slice(0, request.limit),
      edges: edges.slice(0, 200),
      evidence: evidence.slice(0, 100),
      omittedItems: results.reduce((sum, item) => sum + item.omittedItems, deduplicated.omitted),
      warnings: [
        ...results.flatMap((result) => result.warnings),
        ...(selected.length === 0 ? [{ code: "ACADEMIC_OPERATION_UNSUPPORTED", message: "No configured academic source supports this request." }] : [])
      ],
      sourceStatus: allSources().map((source) => {
        const sourceResult = results.find((result) => result.source === source);
        return sourceResult === undefined
          ? { source, attempted: false, status: "not_applicable" as const, retrievedAt, cacheStatus: "bypass" as const }
          : {
              source,
              attempted: true,
              status: sourceResult.status,
              retrievedAt,
              cacheStatus: "miss" as const,
              ...(sourceResult.httpStatusClass === undefined ? {} : { httpStatusClass: sourceResult.httpStatusClass }),
              ...(sourceResult.rateLimitReset === undefined ? {} : { rateLimitReset: sourceResult.rateLimitReset }),
              ...(sourceResult.warnings[0] === undefined ? {} : { warningCode: sourceResult.warnings[0].code })
            };
      }),
      contextReference: {
        sourceId: `academic:${cacheKey}`,
        label: request.operation === "search" ? `Academic search: ${(request.queries ?? []).join(" | ").slice(0, 300)}` : `Academic ${request.operation}: ${request.identifier?.value.slice(0, 300) ?? ""}`,
        sourceRange: `${deduplicated.entities.length} entities, ${evidence.length} evidence records`,
        contentVersion: cacheKey,
        retrievedAt
      }
    };
    const parsed = academicResearchResultSchema.parse(result);
    this.#runStore?.write(request, parsed);
    if (request.operation !== "fetch_content" && parsed.status !== "unavailable") this.#cache.set(cacheKey, parsed, cacheTtl(request));
    return parsed;
  }
}

function requestForAdapter(request: AcademicResearchRequest, source: AcademicSource): AcademicResearchRequest {
  if (request.operation !== "link_artifacts" || (source !== "openalex" && source !== "arxiv")) return request;
  return {
    operation: "search",
    queries: [request.identifier!.value],
    targets: ["works"],
    sources: [source],
    ...(request.filters === undefined ? {} : { filters: request.filters }),
    sort: "relevance",
    limit: request.limit,
    maxChars: request.maxChars
  };
}

function linkArtifacts(entities: readonly AcademicEntity[], evidence: readonly AcademicEvidence[]): AcademicEdge[] {
  const works = entities.filter((entity): entity is Extract<AcademicEntity, { type: "work" }> => entity.type === "work");
  const artifacts = entities.filter((entity): entity is Extract<AcademicEntity, { owner: string }> => entity.type !== "work" && entity.type !== "author");
  const edges: AcademicEdge[] = [];
  for (const work of works) {
    for (const artifact of artifacts) {
      const artifactEvidence = evidence.filter((item) => item.sourceEntityId === artifact.entityId);
      const body = `${artifact.name} ${artifact.description ?? ""} ${artifactEvidence.map((item) => item.excerpt ?? "").join(" ")}`.toLowerCase();
      const arxiv = work.identifiers.arxiv;
      const high = arxiv !== undefined && body.includes(arxiv.toLowerCase());
      const title = normalizedTitle(work.title);
      const medium = title.length >= 12 && normalizedTitle(body).includes(title);
      if (!high && !medium) continue;
      edges.push({
        sourceEntityId: artifact.entityId,
        targetEntityId: work.entityId,
        relation: "artifact_of",
        confidence: high ? "high" : "medium",
        evidenceIds: artifactEvidence.map((item) => item.evidenceId)
      });
    }
  }
  return edges;
}

function cacheTtl(request: AcademicResearchRequest): number {
  if (request.operation === "search") {
    if (request.sources?.includes("arxiv")) return 6 * 60 * 60 * 1_000;
    if (request.sources?.includes("github") || request.sources?.includes("huggingface")) return 2 * 60 * 60 * 1_000;
    return 24 * 60 * 60 * 1_000;
  }
  return request.targets?.some((target) => target === "repositories" || target === "models" || target === "datasets" || target === "spaces")
    ? 6 * 60 * 60 * 1_000
    : 7 * 24 * 60 * 60 * 1_000;
}

function allSources(): AcademicSource[] { return ["openalex", "arxiv", "github", "huggingface"]; }
function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] { return [...new Map(items.map((item) => [key(item), item])).values()]; }
function uniqueEdges(edges: readonly AcademicEdge[]): AcademicEdge[] { return uniqueBy(edges, (edge) => `${edge.sourceEntityId}\0${edge.targetEntityId}\0${edge.relation}`); }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : "Unknown source failure").slice(0, 500); }

export { ArxivAdapter, GitHubAdapter, HuggingFaceAdapter, OpenAlexAdapter };
export { DefaultAcademicHttpAccess, type AcademicHttpAccess } from "./http-access.js";
export type {
  AcademicPdfExtraction,
  AcademicPdfExtractor,
  AcademicPdfSection,
  AcademicSourceAdapter,
  AcademicSourceExecutionContext,
  AcademicSourceResult
} from "./models.js";
