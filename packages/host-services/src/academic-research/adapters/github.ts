import type { AcademicEntity, AcademicEvidence, AcademicResearchRequest } from "@vc-agent/contracts";
import type { AcademicHttpAccess } from "../http-access.js";
import type { AcademicSourceAdapter, AcademicSourceExecutionContext, AcademicSourceResult } from "../models.js";
import { contentHash, evidenceId, stableId } from "../normalize.js";

export class GitHubAdapter implements AcademicSourceAdapter {
  readonly source = "github" as const;
  readonly #http: AcademicHttpAccess;

  constructor(http: AcademicHttpAccess) {
    this.#http = http;
  }

  supports(request: AcademicResearchRequest): boolean {
    if (request.sources !== undefined && !request.sources.includes(this.source)) return false;
    if (request.operation === "graph" || request.operation === "fetch_content") return false;
    if (request.targets === undefined) return request.operation === "link_artifacts";
    return request.targets.includes("repositories");
  }

  async execute(request: AcademicResearchRequest, context: AcademicSourceExecutionContext): Promise<AcademicSourceResult> {
    try {
      if (request.operation === "search" || request.operation === "link_artifacts") return await this.#search(request, context);
      return await this.#inspect(request, context);
    } catch (error) {
      return unavailable(safeCode(error, "GITHUB_UNAVAILABLE"));
    }
  }

  async #search(request: AcademicResearchRequest, context: AcademicSourceExecutionContext): Promise<AcademicSourceResult> {
    const headers = requestHeaders(context.credentials.github);
    const entities: Extract<AcademicEntity, { owner: string }>[] = [];
    let total = 0;
    const queries = request.queries ?? [request.identifier?.value ?? ""];
    for (const query of queries.filter(Boolean)) {
      const qualifiers = [
        `"${query.replaceAll('"', " ")}" in:name,description,readme`,
        ...(request.filters?.minStars === undefined ? [] : [`stars:>=${request.filters.minStars}`]),
        ...(request.filters?.updatedAfter === undefined ? [] : [`pushed:>=${request.filters.updatedAfter}`])
      ];
      const url = new URL("https://api.github.com/search/repositories");
      url.searchParams.set("q", qualifiers.join(" "));
      url.searchParams.set("per_page", String(request.limit));
      url.searchParams.set("sort", request.sort === "activity" || request.sort === "recent" ? "updated" : request.sort === "popularity" ? "stars" : "best-match");
      const response = await this.#http.request({ url: url.toString(), headers, signal: context.signal });
      if (!response.status.toString().startsWith("2")) throw githubError(response.status);
      const payload = asRecord(response.json());
      total += number(payload?.total_count) ?? 0;
      for (const item of Array.isArray(payload?.items) ? payload.items : []) {
        const entity = mapRepository(item, context.retrievedAt);
        if (entity !== undefined) entities.push(entity);
      }
    }
    const limited = uniqueBy(entities, (entity) => entity.entityId).slice(0, request.limit);
    return {
      source: this.source,
      entities: limited,
      edges: [],
      evidence: limited.map(repositoryEvidence),
      warnings: context.credentials.github === undefined ? [{ code: "GITHUB_UNAUTHENTICATED", message: "GitHub search is using the lower unauthenticated quota.", source: this.source }] : [],
      omittedItems: Math.max(0, total - limited.length),
      status: "completed"
    };
  }

  async #inspect(request: AcademicResearchRequest, context: AcademicSourceExecutionContext): Promise<AcademicSourceResult> {
    const slug = githubSlug(request.identifier!.value);
    if (slug === undefined) return unavailable("GITHUB_IDENTIFIER_INVALID");
    const headers = requestHeaders(context.credentials.github);
    const response = await this.#http.request({ url: `https://api.github.com/repos/${slug}`, headers, signal: context.signal });
    if (response.status === 404) return unavailable("GITHUB_NOT_FOUND");
    if (!response.status.toString().startsWith("2")) throw githubError(response.status);
    const entity = mapRepository(response.json(), context.retrievedAt);
    if (entity === undefined) return unavailable("GITHUB_RESPONSE_INVALID");
    const evidence: AcademicEvidence[] = [repositoryEvidence(entity)];
    const warnings: Array<{ code: string; message: string; source: "github" }> = [];
    if (request.contentLevel === "abstract" || request.contentLevel === "sections" || request.operation === "inspect") {
      const readme = await this.#http.request({ url: `https://api.github.com/repos/${slug}/readme`, headers: { ...headers, accept: "application/vnd.github.raw+json" }, signal: context.signal, maxBytes: 1_000_000 });
      if (readme.status.toString().startsWith("2")) {
        const text = readme.text();
        evidence.push({
          evidenceId: evidenceId("github", slug, "readme"),
          source: "github",
          sourceEntityId: entity.entityId,
          sourceUrl: `${entity.url}#readme`,
          retrievedAt: context.retrievedAt,
          evidenceType: "readme",
          supportedFields: ["publisherClaims", "paperLinks", "artifactCompleteness"],
          excerpt: text.slice(0, request.maxChars),
          contentHash: contentHash(text)
        });
      } else warnings.push({ code: "GITHUB_README_UNAVAILABLE", message: "Repository metadata was retrieved, but README was unavailable.", source: "github" });
    }
    return { source: this.source, entities: [entity], edges: [], evidence, warnings, omittedItems: 0, status: warnings.length === 0 ? "completed" : "partial" };
  }
}

function mapRepository(value: unknown, retrievedAt: string): Extract<AcademicEntity, { owner: string }> | undefined {
  const raw = asRecord(value);
  const fullName = string(raw?.full_name);
  const htmlUrl = string(raw?.html_url);
  if (fullName === undefined || htmlUrl === undefined || raw?.private === true) return undefined;
  const [owner, name] = fullName.split("/");
  if (owner === undefined || name === undefined) return undefined;
  const sourceUrl = htmlUrl;
  return {
    entityId: stableId("github_repository", fullName.toLowerCase()),
    type: "github_repository",
    owner,
    name,
    url: htmlUrl,
    ...(string(raw?.description) === undefined ? {} : { description: string(raw?.description)! }),
    ...(string(raw?.created_at) === undefined ? {} : { createdAt: string(raw?.created_at)! }),
    ...(string(raw?.updated_at) === undefined ? {} : { updatedAt: string(raw?.updated_at)! }),
    ...(string(asRecord(raw?.license)?.spdx_id) === undefined ? {} : { license: string(asRecord(raw?.license)?.spdx_id)! }),
    tags: Array.isArray(raw?.topics) ? raw.topics.filter((item): item is string => typeof item === "string") : [],
    metrics: {
      ...(number(raw?.stargazers_count) === undefined ? {} : { stars: number(raw?.stargazers_count)! }),
      ...(number(raw?.forks_count) === undefined ? {} : { forks: number(raw?.forks_count)! })
    },
    files: [],
    linkedWorkIds: [],
    sourceRecords: [{ source: "github", sourceId: fullName, sourceUrl, retrievedAt, contentHash: contentHash(JSON.stringify(value)) }]
  };
}

function repositoryEvidence(entity: Extract<AcademicEntity, { owner: string }>): AcademicEvidence {
  const record = entity.sourceRecords[0]!;
  return {
    evidenceId: evidenceId("github", record.sourceId, "repository"),
    source: "github",
    sourceEntityId: entity.entityId,
    sourceUrl: record.sourceUrl,
    retrievedAt: record.retrievedAt,
    evidenceType: "repository",
    supportedFields: ["owner", "name", "description", "updatedAt", "license", "stars", "forks"],
    contentHash: record.contentHash
  };
}

function requestHeaders(token: string | undefined): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
  };
}

function githubSlug(value: string): string | undefined {
  const normalized = value.trim().replace(/^https?:\/\/github\.com\//iu, "").replace(/\.git$/iu, "").replace(/\/+$/u, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized) ? normalized : undefined;
}
function githubError(status: number): Error { return new Error(status === 403 || status === 429 ? "GITHUB_RATE_LIMITED" : `GITHUB_HTTP_${status}`); }
function unavailable(code: string): AcademicSourceResult { return { source: "github", entities: [], edges: [], evidence: [], warnings: [{ code, message: code.replaceAll("_", " "), source: "github" }], omittedItems: 0, status: "unavailable" }; }
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined; }
function safeCode(error: unknown, fallback: string): string { const message = error instanceof Error ? error.message : fallback; return /^[A-Z0-9_]+$/u.test(message) ? message : fallback; }
function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] { return [...new Map(items.map((item) => [key(item), item])).values()]; }
