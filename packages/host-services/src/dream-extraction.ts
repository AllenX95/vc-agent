import { createHash } from "node:crypto";
import { dreamScopeSummarySchema, type DreamBatch, type DreamExtractionScope, type DreamScopeSummary } from "@vc-agent/contracts";
import type { ProjectMemoryDocument } from "./project-memory.js";

export const DREAM_EXTRACTION_STAGE_INSTRUCTIONS = `You are running one isolated Dream Extraction Pass.
Use only the supplied scope-local candidates, Project Memory (Project scopes only), and bounded eligible dialogue excerpts.
Recover a candidate only from an attributable User signal or a confirmed Judgment Record. Materials, web pages, OCR, tools, and ordinary assistant text are not personal Memory.
Do not infer a Project for Unscoped input. An Unscoped result cannot target Project Memory.
Return only the JSON contract requested by the prompt. Keep the summary bounded and de-identified: no Project name, path, company name, transaction-specific metric, original excerpt, or hidden reasoning.`;

const MAX_TRAJECTORY_ITEMS = 12;
const MAX_TRAJECTORY_TEXT = 4_000;
const MAX_MEMORY_ENTRIES = 12;
const MAX_MEMORY_BODY = 1_000;

export interface DreamScopeExtractionContext {
  readonly schemaVersion: 1;
  readonly batchId: string;
  readonly scopeId: string;
  readonly scopeKind: "project" | "unscoped";
  readonly candidates: readonly {
    candidateId: string;
    origin: "captured" | "recovered" | "carryover";
    sourceKind: string;
    signal: string;
    sourceReference: string;
    sourceText?: string;
  }[];
  readonly trajectoryExcerpts: readonly {
    sourceKind: "ordinary_dialogue" | "reflection_dialogue";
    reflectionSignal?: "adoption" | "correction" | "confirmation";
    sourceReference: string;
    userText: string;
    assistantText: string;
  }[];
  readonly projectMemory?: readonly {
    id: string;
    title: string;
    tags: readonly string[];
    body: string;
    sourceReference: string;
  }[];
  readonly carryover: readonly { sourceReference: string; reason: string; sourceText?: string }[];
}

export function dreamScopeId(kind: "project" | "unscoped", identity: string): string {
  return `${kind}:${identity}`;
}

export function dreamScopeInputHash(input: unknown): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

export function buildDreamExtractionScopes(
  batch: Pick<DreamBatch, "trajectoryInputs" | "candidateInputs" | "carryoverInputs">,
  projectMemoryHashes: Readonly<Record<string, string | undefined>>,
  now: string
): DreamExtractionScope[] {
  const identities = new Map<string, { kind: "project" | "unscoped"; projectId?: string; threadId?: string }>();
  for (const item of [...batch.trajectoryInputs, ...batch.candidateInputs, ...batch.carryoverInputs]) {
    const identity = item.scope === "project" ? item.projectId : item.threadId;
    if (identity === undefined) continue;
    identities.set(dreamScopeId(item.scope, identity), item.scope === "project" ? { kind: "project", projectId: identity } : { kind: "unscoped", threadId: identity });
  }
  return [...identities.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, identity]) => {
    const sourceReferences = scopeSourceReferences(batch, identity);
    const projectMemoryHash = identity.projectId === undefined ? undefined : projectMemoryHashes[identity.projectId];
    return {
      schemaVersion: 1,
      id,
      ...identity,
      status: "pending",
      inputHash: dreamScopeInputHash({ id, sourceReferences, projectMemoryHash }),
      ...(projectMemoryHash === undefined ? {} : { projectMemoryHash }),
      attemptCount: 0,
      sourceReferences,
      updatedAt: now
    };
  });
}

export function buildDreamScopeExtractionContext(
  batch: DreamBatch,
  scope: DreamExtractionScope,
  projectMemory?: ProjectMemoryDocument
): DreamScopeExtractionContext {
  const matches = (item: { scope: "project" | "unscoped"; projectId?: string | undefined; threadId?: string | undefined }) => scope.kind === "project"
    ? item.scope === "project" && item.projectId === scope.projectId
    : item.scope === "unscoped" && item.threadId === scope.threadId;
  const candidates = batch.candidateInputs.filter(matches).map((candidate) => ({
    candidateId: candidate.candidateId,
    origin: candidate.origin,
    sourceKind: candidate.sourceKind,
    signal: candidate.signal,
    sourceReference: candidate.sourceReference,
    ...(candidate.sourceText === undefined ? {} : { sourceText: candidate.sourceText.slice(0, 2_000) })
  }));
  const trajectoryExcerpts = batch.trajectoryInputs.filter(matches).slice(0, MAX_TRAJECTORY_ITEMS).map((item) => ({
    sourceKind: item.sourceKind,
    ...(item.reflectionSignal === undefined ? {} : { reflectionSignal: item.reflectionSignal }),
    sourceReference: item.sourceReference,
    userText: item.userText.slice(0, MAX_TRAJECTORY_TEXT),
    assistantText: item.assistantText.slice(0, MAX_TRAJECTORY_TEXT)
  }));
  const carryover = batch.carryoverInputs.filter(matches).map((item) => ({
    sourceReference: item.sourceReference,
    reason: item.reason,
    ...(item.sourceText === undefined ? {} : { sourceText: item.sourceText.slice(0, 2_000) })
  }));
  return {
    schemaVersion: 1,
    batchId: batch.id,
    scopeId: scope.id,
    scopeKind: scope.kind,
    candidates,
    trajectoryExcerpts,
    ...(scope.kind !== "project" || projectMemory === undefined ? {} : {
      projectMemory: projectMemory.entries.slice(0, MAX_MEMORY_ENTRIES).map((entry) => ({
        id: entry.id,
        title: entry.title.slice(0, 200),
        tags: entry.tags.slice(0, 20),
        body: entry.body.slice(0, MAX_MEMORY_BODY),
        sourceReference: `project-memory:${entry.id}@${projectMemory.sourceHash}`
      }))
    }),
    carryover
  };
}

export function buildDreamScopeExtractionPrompt(context: DreamScopeExtractionContext): string {
  return `Extract and organize personal investment-learning candidates from this one isolated Dream scope.\n\nScope-local input:\n${JSON.stringify(context)}\n\nReturn one JSON object with: schemaVersion=1, scopeKind, deidentified=true, summary, uncertainty, sourceReferences, and candidates. Each candidate must include candidateId, origin, sourceKind, attributableSignal, sourceReferences, uncertainty, summary, and proposedDestination. Never include raw excerpts or full reasoning.`;
}

export function parseDreamScopeSummary(raw: string, scope: DreamExtractionScope, additionalSourceReferences: readonly string[] = []): DreamScopeSummary {
  const json = extractJson(raw);
  const parsed = dreamScopeSummarySchema.parse(JSON.parse(json));
  if (parsed.scopeKind !== scope.kind) throw new Error("Dream extraction result changed its isolated scope");
  const allowed = new Set([...scope.sourceReferences, ...additionalSourceReferences]);
  for (const reference of [...parsed.sourceReferences, ...parsed.candidates.flatMap((candidate) => candidate.sourceReferences)]) {
    if (!allowed.has(reference)) throw new Error("Dream extraction result used a source outside its isolated scope");
  }
  return parsed;
}

function scopeSourceReferences(
  batch: Pick<DreamBatch, "trajectoryInputs" | "candidateInputs" | "carryoverInputs">,
  identity: { kind: "project" | "unscoped"; projectId?: string | undefined; threadId?: string | undefined }
): string[] {
  const matches = (item: { scope: "project" | "unscoped"; projectId?: string | undefined; threadId?: string | undefined }) => identity.kind === "project"
    ? item.scope === "project" && item.projectId === identity.projectId
    : item.scope === "unscoped" && item.threadId === identity.threadId;
  return [...new Set([
    ...batch.trajectoryInputs.filter(matches).map((item) => item.sourceReference),
    ...batch.candidateInputs.filter(matches).map((item) => item.sourceReference),
    ...batch.carryoverInputs.filter(matches).map((item) => item.sourceReference)
  ])].sort();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(raw)?.[1]?.trim();
  if (fenced !== undefined) return fenced;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Dream extraction response did not contain JSON");
  return raw.slice(start, end + 1);
}
