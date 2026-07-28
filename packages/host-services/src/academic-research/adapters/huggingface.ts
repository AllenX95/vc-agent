import type { AcademicEntity, AcademicEvidence, AcademicResearchRequest } from "@vc-agent/contracts";
import type { AcademicHttpAccess } from "../http-access.js";
import type { AcademicSourceAdapter, AcademicSourceExecutionContext, AcademicSourceResult } from "../models.js";
import { contentHash, evidenceId, stableId } from "../normalize.js";

type HfTarget = "models" | "datasets" | "spaces";

export class HuggingFaceAdapter implements AcademicSourceAdapter {
  readonly source = "huggingface" as const;
  readonly #http: AcademicHttpAccess;

  constructor(http: AcademicHttpAccess) {
    this.#http = http;
  }

  supports(request: AcademicResearchRequest): boolean {
    if (request.sources !== undefined && !request.sources.includes(this.source)) return false;
    if (request.operation === "graph" || request.operation === "fetch_content") return false;
    if (request.targets === undefined) return request.operation === "link_artifacts";
    return request.targets.some((target) => target === "models" || target === "datasets" || target === "spaces");
  }

  async execute(request: AcademicResearchRequest, context: AcademicSourceExecutionContext): Promise<AcademicSourceResult> {
    try {
      if (request.operation === "search" || request.operation === "link_artifacts") return await this.#search(request, context);
      return await this.#inspect(request, context);
    } catch (error) {
      return unavailable(safeCode(error, "HF_UNAVAILABLE"));
    }
  }

  async #search(request: AcademicResearchRequest, context: AcademicSourceExecutionContext): Promise<AcademicSourceResult> {
    const targets = hfTargets(request.targets);
    const entities: Extract<AcademicEntity, { owner: string }>[] = [];
    for (const target of targets) {
      for (const query of request.queries ?? [request.identifier?.value ?? ""]) {
        if (query.length === 0) continue;
        const url = new URL(`https://huggingface.co/api/${target}`);
        url.searchParams.set("search", query);
        url.searchParams.set("limit", String(request.limit));
        url.searchParams.set("sort", request.sort === "popularity" ? "downloads" : "lastModified");
        url.searchParams.set("direction", "-1");
        const response = await this.#http.request({ url: url.toString(), headers: headers(context.credentials.huggingface), signal: context.signal });
        if (!response.status.toString().startsWith("2")) throw hfError(response.status);
        const payload = response.json();
        if (!Array.isArray(payload)) throw new Error("HF_RESPONSE_INVALID");
        for (const item of payload) {
          const entity = mapHf(item, target, context.retrievedAt);
          if (entity !== undefined) entities.push(entity);
        }
      }
    }
    const limited = uniqueBy(entities, (entity) => entity.entityId).slice(0, request.limit);
    return {
      source: this.source,
      entities: limited,
      edges: [],
      evidence: limited.map(hfEvidence),
      warnings: [],
      omittedItems: Math.max(0, entities.length - limited.length),
      status: "completed"
    };
  }

  async #inspect(request: AcademicResearchRequest, context: AcademicSourceExecutionContext): Promise<AcademicSourceResult> {
    const parsed = hfIdentifier(request.identifier!.value, request.targets);
    if (parsed === undefined) return unavailable("HF_IDENTIFIER_INVALID");
    const response = await this.#http.request({ url: `https://huggingface.co/api/${parsed.target}/${parsed.id}`, headers: headers(context.credentials.huggingface), signal: context.signal });
    if (response.status === 404) return unavailable("HF_NOT_FOUND");
    if (!response.status.toString().startsWith("2")) throw hfError(response.status);
    const entity = mapHf(response.json(), parsed.target, context.retrievedAt);
    if (entity === undefined) return unavailable("HF_RESPONSE_INVALID");
    const evidence: AcademicEvidence[] = [hfEvidence(entity)];
    const cardUrl = cardUrlFor(parsed.target, parsed.id);
    const card = await this.#http.request({ url: cardUrl, headers: headers(context.credentials.huggingface), signal: context.signal, maxBytes: 1_000_000 });
    const warnings: Array<{ code: string; message: string; source: "huggingface" }> = [];
    if (card.status.toString().startsWith("2")) {
      const text = card.text();
      evidence.push({
        evidenceId: evidenceId("huggingface", `${parsed.target}/${parsed.id}`, "card"),
        source: "huggingface",
        sourceEntityId: entity.entityId,
        sourceUrl: entity.url,
        retrievedAt: context.retrievedAt,
        evidenceType: parsed.target === "models" ? "model_card" : parsed.target === "datasets" ? "dataset_card" : "space_card",
        supportedFields: ["publisherClaims", "license", "linkedPapers", "linkedArtifacts"],
        excerpt: text.slice(0, request.maxChars),
        contentHash: contentHash(text)
      });
    } else warnings.push({ code: "HF_CARD_UNAVAILABLE", message: "Hub metadata was retrieved, but the repository Card was unavailable.", source: "huggingface" });
    return { source: this.source, entities: [entity], edges: [], evidence, warnings, omittedItems: 0, status: warnings.length === 0 ? "completed" : "partial" };
  }
}

function mapHf(value: unknown, target: HfTarget, retrievedAt: string): Extract<AcademicEntity, { owner: string }> | undefined {
  const raw = asRecord(value);
  if (raw?.private === true || raw?.gated === true || raw?.gated === "auto" || raw?.gated === "manual") return undefined;
  const id = string(raw?.id) ?? string(raw?.modelId);
  if (id === undefined || !id.includes("/")) return undefined;
  const [owner, ...rest] = id.split("/");
  const name = rest.join("/");
  if (owner === undefined || name.length === 0) return undefined;
  const type = target === "models" ? "hf_model" : target === "datasets" ? "hf_dataset" : "hf_space";
  const prefix = target === "models" ? "" : `${target.slice(0, -1)}/`;
  const url = `https://huggingface.co/${prefix}${id}`;
  const siblings = Array.isArray(raw?.siblings) ? raw.siblings : [];
  return {
    entityId: stableId(type, id.toLowerCase()),
    type,
    owner,
    name,
    url,
    ...(string(raw?.description) === undefined ? {} : { description: string(raw?.description)! }),
    ...(string(raw?.createdAt) === undefined ? {} : { createdAt: string(raw?.createdAt)! }),
    ...(string(raw?.lastModified) === undefined ? {} : { updatedAt: string(raw?.lastModified)! }),
    ...(license(raw!) === undefined ? {} : { license: license(raw!)! }),
    tags: Array.isArray(raw?.tags) ? raw.tags.filter((item): item is string => typeof item === "string") : [],
    metrics: {
      ...(number(raw?.downloads) === undefined ? {} : { downloads: number(raw?.downloads)! }),
      ...(number(raw?.likes) === undefined ? {} : { likes: number(raw?.likes)! })
    },
    files: siblings.map((item) => string(asRecord(item)?.rfilename)).filter((item): item is string => item !== undefined).slice(0, 200),
    linkedWorkIds: [],
    sourceRecords: [{ source: "huggingface", sourceId: `${target}/${id}`, sourceUrl: url, retrievedAt, contentHash: contentHash(JSON.stringify(value)) }]
  };
}

function hfEvidence(entity: Extract<AcademicEntity, { owner: string }>): AcademicEvidence {
  const record = entity.sourceRecords[0]!;
  return {
    evidenceId: evidenceId("huggingface", record.sourceId, "metadata"),
    source: "huggingface",
    sourceEntityId: entity.entityId,
    sourceUrl: record.sourceUrl,
    retrievedAt: record.retrievedAt,
    evidenceType: "metadata",
    supportedFields: ["owner", "name", "updatedAt", "license", "tags", "downloads", "likes", "files"],
    contentHash: record.contentHash
  };
}

function hfTargets(targets: AcademicResearchRequest["targets"]): HfTarget[] {
  const selected = targets?.filter((target): target is HfTarget => target === "models" || target === "datasets" || target === "spaces");
  return selected === undefined || selected.length === 0 ? ["models", "datasets", "spaces"] : selected;
}
function hfIdentifier(value: string, targets: AcademicResearchRequest["targets"]): { target: HfTarget; id: string } | undefined {
  const normalized = value.trim().replace(/^https?:\/\/huggingface\.co\//iu, "").replace(/\/+$/u, "");
  let target: HfTarget = "models";
  let id = normalized;
  if (normalized.startsWith("datasets/")) { target = "datasets"; id = normalized.slice("datasets/".length); }
  else if (normalized.startsWith("spaces/")) { target = "spaces"; id = normalized.slice("spaces/".length); }
  else if (targets?.length === 1 && (targets[0] === "datasets" || targets[0] === "spaces" || targets[0] === "models")) target = targets[0];
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(id) ? { target, id } : undefined;
}
function cardUrlFor(target: HfTarget, id: string): string { const prefix = target === "models" ? "" : `${target.slice(0, -1)}s/`; return `https://huggingface.co/${prefix}${id}/raw/main/README.md`; }
function headers(token: string | undefined): Record<string, string> { return token === undefined ? {} : { authorization: `Bearer ${token}` }; }
function license(raw: Record<string, unknown>): string | undefined { const card = asRecord(raw.cardData); return string(card?.license); }
function hfError(status: number): Error { return new Error(status === 429 ? "HF_RATE_LIMITED" : `HF_HTTP_${status}`); }
function unavailable(code: string): AcademicSourceResult { return { source: "huggingface", entities: [], edges: [], evidence: [], warnings: [{ code, message: code.replaceAll("_", " "), source: "huggingface" }], omittedItems: 0, status: "unavailable" }; }
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined; }
function safeCode(error: unknown, fallback: string): string { const message = error instanceof Error ? error.message : fallback; return /^[A-Z0-9_]+$/u.test(message) ? message : fallback; }
function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] { return [...new Map(items.map((item) => [key(item), item])).values()]; }
