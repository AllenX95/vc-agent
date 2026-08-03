import {
  CAPABILITY_RESULT_CONTENT_MAX_CHARS,
  type CapabilityExecutionResult,
  type CitationManifest,
  type CitationSource
} from "@vc-agent/contracts";

type CitationRecord = {
  readonly url: string;
  readonly title?: string;
  readonly accessedAt?: string;
};

type JsonObject = Record<string, unknown>;

/**
 * Owns the small, turn-scoped citation manifest shared by Host, Worker, and
 * Renderer. The model only receives source IDs; the Host remains authoritative
 * for the URL that each ID resolves to.
 */
export class CitationRegistry {
  readonly #sources: CitationSource[] = [];
  readonly #sourceIdByUrl = new Map<string, string>();

  get manifest(): CitationManifest {
    return this.#sources.map((source) => ({ ...source }));
  }

  annotateCapabilityResult(
    result: CapabilityExecutionResult,
    input: { readonly capabilityId: string; readonly toolCallId: string }
  ): CapabilityExecutionResult {
    if (!isCitationBearingCapability(input.capabilityId, result)) return result;
    const records = sourceRecords(result);
    const sources = records.map((record) => this.#register(record, input));
    if (sources.length === 0) return result;

    const parsed = parseJsonObject(result.content);
    if (parsed !== undefined) {
      const annotated = annotateStructuredResult(parsed, this.#sourceIdByUrl);
      const content = JSON.stringify(annotated);
      if (content.length <= CAPABILITY_RESULT_CONTENT_MAX_CHARS) return { ...result, content };
    } else {
      const sourceBlock = sources.map((source) => `[${source.id}] ${source.url}`).join("\n");
      const content = `${result.content}\n\nAvailable source IDs:\n${sourceBlock}`;
      if (content.length <= CAPABILITY_RESULT_CONTENT_MAX_CHARS) return { ...result, content };
    }

    // The original bounded payload remains valid even when adding the small
    // citation annotations would cross the Worker IPC limit. The manifest is
    // still retained and will be rendered by the Host at Turn completion.
    return result;
  }

  formatAssistantMessage(message: string): { readonly message: string; readonly citations: CitationManifest } {
    if (this.#sources.length === 0) return { message, citations: [] };
    const byId = new Map(this.#sources.map((source) => [source.id, source]));
    const linked = message.replace(/\[(S[1-9][0-9]*)\](?:\(<[^>\n]*>\)|\([^\)\n]*\))?/gu, (marker, id: string) => {
      const source = byId.get(id);
      return source === undefined ? `[${id}]` : `[${id}](<${source.url}>)`;
    });
    const sourceList = this.#sources.map((source) => {
      const title = source.title === undefined ? "" : ` ${source.title} —`;
      return `- [${source.id}]${title} [打开链接](<${source.url}>)`;
    }).join("\n");
    return {
      message: `${linked.trimEnd()}\n\n### 参考来源\n\n${sourceList}`,
      citations: this.manifest
    };
  }

  #register(record: CitationRecord, input: { readonly capabilityId: string; readonly toolCallId: string }): CitationSource {
    const url = normalizeUrl(record.url);
    const existingId = this.#sourceIdByUrl.get(url);
    if (existingId !== undefined) return this.#sources.find((source) => source.id === existingId)!;
    const source: CitationSource = {
      id: `S${this.#sources.length + 1}`,
      url,
      ...(normalizeTitle(record.title) === undefined ? {} : { title: normalizeTitle(record.title) }),
      accessedAt: normalizeDate(record.accessedAt),
      originatingTool: input.capabilityId,
      toolCallId: input.toolCallId
    };
    this.#sourceIdByUrl.set(url, source.id);
    this.#sources.push(source);
    return source;
  }
}

function isCitationBearingCapability(capabilityId: string, result: CapabilityExecutionResult): boolean {
  return capabilityId === "web_search"
    || capabilityId === "web_fetch"
    || capabilityId === "source_check"
    || capabilityId === "academic_research"
    || result.retrieval?.contextReference.sourceClass === "web"
    || result.retrieval?.contextReference.sourceClass === "academic";
}

function sourceRecords(result: CapabilityExecutionResult): CitationRecord[] {
  const records: CitationRecord[] = [];
  const parsed = parseJsonObject(result.content);
  if (parsed !== undefined) collectUrlRecords(parsed, records);
  const referenceUrl = result.retrieval?.contextReference.sourceId;
  if (records.length === 0 && referenceUrl !== undefined && isHttpUrl(referenceUrl)) {
    records.push({
      url: referenceUrl,
      ...(result.retrieval?.contextReference.label === undefined ? {} : { title: result.retrieval.contextReference.label }),
      ...(result.retrieval?.contextReference.retrievedAt === undefined ? {} : { accessedAt: result.retrieval.contextReference.retrievedAt })
    });
  }
  return uniqueRecords(records);
}

function collectUrlRecords(value: unknown, records: CitationRecord[], depth = 0): void {
  if (depth > 5 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectUrlRecords(item, records, depth + 1);
    return;
  }
  const object = value as JsonObject;
  if (typeof object.url === "string" && isHttpUrl(object.url)) {
    records.push({
      url: object.url,
      ...(typeof object.title === "string" ? { title: object.title } : typeof object.name === "string" ? { title: object.name } : {}),
      ...(typeof object.accessedAt === "string" ? { accessedAt: object.accessedAt } : typeof object.retrievedAt === "string" ? { accessedAt: object.retrievedAt } : {})
    });
  }
  for (const [key, child] of Object.entries(object)) {
    if (key === "content" || key === "text" || key === "snippet" || key === "body") continue;
    collectUrlRecords(child, records, depth + 1);
  }
}

function annotateStructuredResult(value: JsonObject, sourceIdByUrl: ReadonlyMap<string, string>): JsonObject {
  const next: JsonObject = { ...value };
  const candidateArrays = [next.items, next.citations, next.sources].filter(Array.isArray) as unknown[][];
  for (const items of candidateArrays) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const object = item as JsonObject;
      const url = typeof object.url === "string" ? normalizeUrl(object.url) : undefined;
      const citationId = url === undefined ? undefined : sourceIdByUrl.get(url);
      if (citationId !== undefined) items[index] = { ...object, citationId };
    }
  }
  return next;
}

function parseJsonObject(value: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : undefined;
  } catch {
    return undefined;
  }
}

function uniqueRecords(records: readonly CitationRecord[]): CitationRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const url = normalizeUrl(record.url);
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function normalizeUrl(value: string): string {
  try { return new URL(value).toString(); }
  catch { return value; }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function normalizeTitle(value: string | undefined): string | undefined {
  const title = value?.replace(/\s+/gu, " ").trim().slice(0, 500);
  return title === undefined || title.length === 0 ? undefined : title;
}

function normalizeDate(value: string | undefined): string {
  if (value !== undefined && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}
