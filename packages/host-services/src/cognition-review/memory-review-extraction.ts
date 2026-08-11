import {
  extractionChunkResultSchema,
  sourceDispositionInputSchema,
  type ExtractionChunkResult,
  type SourceDispositionInput
} from "@vc-agent/contracts";
import type { ExtractionChunk, MemoryReviewChunkSource, MemoryReviewSourceBody } from "./chunking.js";
import { resolveMemoryReviewChunkSources } from "./chunking.js";

/** Prompt text is duplicated as a constant so bundled Host code does not rely on source-file paths. */
export const MEMORY_REVIEW_EXTRACTION_STAGE_INSTRUCTIONS = `You are running one isolated Memory Review extraction chunk.

Use only the scope-local sources and scope-compatible Project Memory cards supplied in this prompt. Never infer or disclose a Project for an Unscoped scope. Do not use materials, webpages, OCR, tool output, hidden reasoning, or ordinary assistant claims as personal Memory unless a source contains an attributable User signal or a confirmed cognitive artifact.

Every supplied sourceReference MUST appear exactly once in dispositions. A source may be marked no_signal, represented, or carried_over. represented MUST include at least one candidate/proposal id that is declared in candidates. Never invent a sourceReference outside this chunk. Return one JSON object only with schemaVersion=1, chunkId, dispositions, candidates, and completedAt. Keep summaries bounded, de-identified, and free of raw excerpts, credentials, or Project names.`;

export interface MemoryReviewExtractionCandidate {
  readonly id: string;
  readonly sourceReferences?: readonly string[];
  readonly summary?: string;
  readonly title?: string;
  readonly destination?: "project_memory" | "long_term_memory";
}

export interface MemoryReviewExtractionResult extends ExtractionChunkResult {
  readonly candidates: readonly MemoryReviewExtractionCandidate[];
}

export interface ExtractionParseOptions {
  /** Candidate/proposal IDs already normalized by a caller, if candidates are stored separately. */
  readonly validProposalIds?: readonly string[];
  readonly now?: string;
}

export interface MemoryReviewExtractionExecutionInput {
  readonly chunk: ExtractionChunk;
  readonly resolveSource?: (sourceReference: string) => MemoryReviewSourceBody | undefined | Promise<MemoryReviewSourceBody | undefined>;
  readonly generate: (prompt: string) => string | Promise<string>;
  readonly validProposalIds?: readonly string[];
  readonly now?: string;
}

/** Build the model prompt for one isolated chunk. */
export function buildMemoryReviewExtractionPrompt(
  chunk: Pick<ExtractionChunk, "id" | "scope" | "projectId" | "threadId" | "sourceReferences" | "sources"> & { readonly stageInstructions?: string; readonly outputSchema?: string },
  options: { readonly sources?: readonly MemoryReviewChunkSource[]; readonly projectMemory?: unknown; readonly stageInstructions?: string; readonly outputSchema?: string } = {}
): string {
  const sources = options.sources ?? chunk.sources;
  const scope = {
    kind: chunk.scope,
    ...(chunk.projectId === undefined ? {} : { projectId: chunk.projectId }),
    ...(chunk.threadId === undefined ? {} : { threadId: chunk.threadId })
  };
  const context = {
    schemaVersion: 1,
    chunkId: chunk.id,
    scope,
    sourceReferences: [...chunk.sourceReferences],
    sources: sources.map((source) => ({
      sourceReference: source.sourceReference,
      completedAt: source.completedAt,
      sourceKind: source.sourceKind,
      userText: source.userText,
      assistantText: source.assistantText,
      truncated: source.truncated
    })),
    ...(chunk.scope === "project" && options.projectMemory !== undefined ? { projectMemory: options.projectMemory } : {})
  };
  const instructions = options.stageInstructions ?? chunk.stageInstructions ?? MEMORY_REVIEW_EXTRACTION_STAGE_INSTRUCTIONS;
  const outputSchema = options.outputSchema ?? chunk.outputSchema ?? "Return JSON only.";
  return `${instructions}\n\nChunk input:\n${stableJson(context)}\n\n${outputSchema}\nReturn JSON only.`;
}

/**
 * Parse and validate one model result.  Validation is intentionally stricter
 * than the shared zod contract: the result must cover exactly this chunk and
 * every represented source must name a declared/known proposal.
 */
export function parseMemoryReviewExtraction(
  raw: string,
  chunk: Pick<ExtractionChunk, "id" | "sourceReferences">,
  options: ExtractionParseOptions = {}
): MemoryReviewExtractionResult {
  const object = parseJsonObject(raw);
  if (object.deidentified !== undefined && object.deidentified !== true) {
    throw new Error("Memory Review extraction result must be de-identified.");
  }
  if (object.scopeKind !== undefined && object.scopeKind !== undefined && typeof object.scopeKind === "string") {
    // Scope identity is enforced by source membership below.  A malformed
    // scope marker is rejected instead of being silently ignored.
    if (object.scopeKind !== "project" && object.scopeKind !== "unscoped") throw new Error("Memory Review extraction result changed its scope");
  }
  const dispositionsRaw = object.dispositions ?? object.sourceDispositions;
  if (!Array.isArray(dispositionsRaw)) throw new Error("Memory Review extraction result is missing dispositions.");
  const candidates = parseCandidates(object.candidates ?? object.proposals);
  const normalizedDispositions = dispositionsRaw.map((value) => normalizeDisposition(value));
  const result = extractionChunkResultSchema.parse({
    schemaVersion: object.schemaVersion ?? 1,
    chunkId: object.chunkId,
    dispositions: normalizedDispositions,
    completedAt: object.completedAt ?? options.now ?? new Date().toISOString()
  });
  if (result.chunkId !== chunk.id) throw new Error("Memory Review extraction result changed its chunk");

  const allowed = new Set(chunk.sourceReferences);
  validateRootReferences(object.sourceReferences, allowed);
  const seen = new Set<string>();
  for (const disposition of result.dispositions) {
    if (!allowed.has(disposition.sourceReference)) throw new Error(`Extraction result used a source outside its chunk: ${disposition.sourceReference}`);
    if (seen.has(disposition.sourceReference)) throw new Error(`Duplicate source disposition: ${disposition.sourceReference}`);
    seen.add(disposition.sourceReference);
  }
  const missing = chunk.sourceReferences.filter((reference) => !seen.has(reference));
  if (missing.length > 0) throw new Error(`Extraction result omitted source disposition(s): ${missing.join(", ")}`);

  const declaredProposalIds = new Set(options.validProposalIds ?? candidates.map((candidate) => candidate.id));
  for (const candidate of candidates) {
    if (candidate.sourceReferences !== undefined) {
      for (const reference of candidate.sourceReferences) {
        if (!allowed.has(reference)) throw new Error(`Candidate used a source outside its chunk: ${reference}`);
      }
    }
  }
  for (const disposition of result.dispositions) {
    if (disposition.status !== "represented") continue;
    const proposalIds = disposition.proposalIds ?? [];
    if (proposalIds.length === 0) throw new Error(`Represented source requires a valid proposal: ${disposition.sourceReference}`);
    if (declaredProposalIds.size === 0 || proposalIds.some((proposalId) => !declaredProposalIds.has(proposalId))) {
      throw new Error(`Represented source references a missing proposal: ${disposition.sourceReference}`);
    }
  }
  return { ...result, candidates };
}

/** Explicitly named validation seam for callers that already have parsed JSON. */
export function validateMemoryReviewExtraction(
  result: unknown,
  chunk: Pick<ExtractionChunk, "id" | "sourceReferences">,
  options: ExtractionParseOptions = {}
): MemoryReviewExtractionResult {
  return parseMemoryReviewExtraction(JSON.stringify(result), chunk, options);
}

/**
 * Resolve bodies immediately before generation and return only the bounded,
 * content-free result.  The local materialized array is cleared in `finally`
 * so a completed attempt does not retain Thread bodies.
 */
export async function executeMemoryReviewExtraction(input: MemoryReviewExtractionExecutionInput): Promise<MemoryReviewExtractionResult> {
  const materialized: MemoryReviewChunkSource[] = [];
  let prompt = "";
  try {
    const resolver = input.resolveSource ?? ((reference: string) => {
      const source = input.chunk.sources.find((candidate) => candidate.sourceReference === reference);
      return source === undefined ? undefined : { userText: source.userText, assistantText: source.assistantText };
    });
    const resolved = await resolveMemoryReviewChunkSources(input.chunk, resolver);
    materialized.push(...resolved);
    prompt = buildMemoryReviewExtractionPrompt(input.chunk, { sources: materialized });
    const raw = await input.generate(prompt);
    const parseOptions: ExtractionParseOptions = {
      ...(input.validProposalIds === undefined ? {} : { validProposalIds: input.validProposalIds }),
      ...(input.now === undefined ? {} : { now: input.now })
    };
    return parseMemoryReviewExtraction(raw, input.chunk, parseOptions);
  } finally {
    materialized.splice(0, materialized.length);
    prompt = "";
  }
}

function parseCandidates(value: unknown): MemoryReviewExtractionCandidate[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Memory Review extraction candidates must be an array.");
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    if (candidate === null || typeof candidate !== "object") throw new Error(`Invalid extraction candidate at index ${index}.`);
    const record = candidate as Record<string, unknown>;
    const id = record.id ?? record.proposalId ?? record.candidateId;
    if (typeof id !== "string" || id.trim() === "") throw new Error(`Extraction candidate ${index} is missing an id.`);
    if (ids.has(id)) throw new Error(`Duplicate extraction candidate: ${id}`);
    ids.add(id);
    const sourceReferences = record.sourceReferences ?? record.sources;
    if (sourceReferences !== undefined && (!Array.isArray(sourceReferences) || sourceReferences.some((reference) => typeof reference !== "string" || reference.length === 0))) {
      throw new Error(`Extraction candidate ${id} has invalid source references.`);
    }
    return {
      id,
      ...(sourceReferences === undefined ? {} : { sourceReferences: sourceReferences as string[] }),
      ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      ...((record.destination === "project_memory" || record.destination === "long_term_memory") ? { destination: record.destination } : {})
    };
  });
}

function validateRootReferences(value: unknown, allowed: ReadonlySet<string>): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((reference) => typeof reference !== "string")) {
    throw new Error("Memory Review extraction result has invalid source references.");
  }
  for (const reference of value) {
    if (!allowed.has(reference)) throw new Error(`Extraction result used a source outside its chunk: ${reference}`);
  }
}

function normalizeDisposition(value: unknown): SourceDispositionInput {
  if (value === null || typeof value !== "object") throw new Error("Invalid extraction source disposition.");
  const record = value as Record<string, unknown>;
  const proposalIds = record.proposalIds ?? record.candidateIds;
  return sourceDispositionInputSchema.parse({
    sourceReference: record.sourceReference,
    status: record.status,
    ...(proposalIds === undefined ? {} : { proposalIds }),
    ...(record.reason === undefined ? {} : { reason: record.reason })
  });
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(raw)?.[1]?.trim();
  const text = fenced ?? raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("Memory Review extraction response did not contain JSON.");
    try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error("Memory Review extraction response contained invalid JSON."); }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Memory Review extraction response must be a JSON object.");
  return parsed as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
