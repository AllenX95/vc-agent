import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { dreamGlobalSynthesisSchema, dreamSynthesisProposalSchema, type DreamBatch, type DreamGlobalSynthesis, type DreamSynthesisProposal } from "@vc-agent/contracts";
import type { LongTermMemoryDocument, LongTermMemoryEntry } from "./long-term-memory.js";

export const DREAM_GLOBAL_SYNTHESIS_INSTRUCTIONS = `You are running Global Dream Synthesis in a new isolated context.
Use only approved, de-identified scope summaries, opaque scope/source references, and bounded Long-term Memory cards.
Never infer or emit Project names, paths, company identifiers, raw dialogue, source excerpts, or unnecessary deal facts.
Long-term learning must be reusable at no greater specificity than industry, financing stage, or a comparable investment situation.
Compare every Long-term proposal with active Memory. Frequency, confidence, or model preference never justify Narrow or Revise; use Contradict to preserve unresolved substantive disagreement.
Project Memory is allowed only from exactly one Project scope reference. Unscoped or multi-scope proposals cannot target Project Memory.
Return only the requested JSON. This creates review proposals and never authorizes a write.`;

const modelSynthesisSchema = z.object({
  summary: z.string().min(1).max(4_000),
  uncertainty: z.string().max(1_000),
  proposals: z.array(dreamSynthesisProposalSchema).max(50)
});

export interface DreamSynthesisInput {
  readonly schemaVersion: 1;
  readonly batchReference: string;
  readonly partialCoverageScopeReferences: readonly string[];
  readonly scopes: readonly {
    scopeReference: string;
    scopeKind: "project" | "unscoped";
    summary: string;
    uncertainty: string;
    sourceReferences: readonly string[];
    candidates: readonly {
      candidateId: string;
      origin: "captured" | "recovered" | "carryover";
      sourceKind: "ordinary_user_signal" | "reflection_dialogue" | "confirmed_judgment";
      attributableSignal: string;
      sourceReferences: readonly string[];
      uncertainty: string;
      summary: string;
      proposedDestination: "project_memory" | "long_term_memory" | "keep_pending" | "discard";
    }[];
  }[];
  readonly longTermMemoryCards: readonly {
    id: string;
    version: number;
    title: string;
    tags: readonly string[];
    applicability: readonly string[];
    maturity: string;
    conflictState: string;
    content: string;
  }[];
  readonly longTermMemoryHash: string;
}

export function buildDreamSynthesisInput(batch: DreamBatch, memory: LongTermMemoryDocument): DreamSynthesisInput {
  const approved = batch.extractionScopes.filter((scope) => scope.status === "approved" && scope.result !== undefined);
  const scopeReferences = new Map(approved.map((scope) => [scope.id, opaqueScopeReference(batch.id, scope.id)]));
  const terms = approved.flatMap((scope) => words(`${scope.result!.summary} ${scope.result!.candidates.map((candidate) => candidate.summary).join(" ")}`));
  const cards = relevantMemoryCards(memory.entries.filter((entry) => entry.status === "current"), terms);
  return {
    schemaVersion: 1,
    batchReference: `dream_batch_${createHash("sha256").update(batch.id).digest("hex").slice(0, 20)}`,
    partialCoverageScopeReferences: batch.partialCoverageScopeIds.map((id) => opaqueScopeReference(batch.id, id)),
    scopes: approved.map((scope) => ({
      scopeReference: scopeReferences.get(scope.id)!,
      scopeKind: scope.kind,
      summary: scope.result!.summary,
      uncertainty: scope.result!.uncertainty,
      sourceReferences: scope.result!.sourceReferences,
      candidates: scope.result!.candidates
    })),
    longTermMemoryCards: cards,
    longTermMemoryHash: memory.sourceHash
  };
}

export function buildDreamGlobalSynthesisPrompt(input: DreamSynthesisInput): string {
  return `Synthesize reviewed Dream scopes into reviewable proposals.\n\nDe-identified synthesis input:\n${JSON.stringify(input)}\n\nReturn JSON with summary, uncertainty, and proposals. Each proposal requires id, sourceScopeReferences, sourceReferences, candidateOrigins, destination, targetEntryIds, uncertainty, comparisonSummary, rationale, and—only for a Memory destination—learning. Long-term Memory also requires memoryAction. Use destination=merge_condense with memoryAction=merge_condense for merge-only condensation.`;
}

export function dreamSynthesisInputHash(input: DreamSynthesisInput): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

export function parseDreamGlobalSynthesis(
  raw: string,
  batch: DreamBatch,
  input: DreamSynthesisInput,
  forbiddenTerms: readonly string[],
  now = new Date().toISOString()
): DreamGlobalSynthesis {
  const parsed = modelSynthesisSchema.parse(JSON.parse(extractJson(raw)));
  const scopeMap = input.scopes.map((scope) => ({ scopeReference: scope.scopeReference, scopeId: batch.extractionScopes.find((item) => opaqueScopeReference(batch.id, item.id) === scope.scopeReference)!.id }));
  const scopeByReference = new Map(input.scopes.map((scope) => [scope.scopeReference, scope]));
  const allowedSources = new Set(input.scopes.flatMap((scope) => [
    ...scope.sourceReferences,
    ...scope.candidates.flatMap((candidate) => candidate.sourceReferences)
  ]));
  const activeMemoryIds = new Set(input.longTermMemoryCards.map((entry) => entry.id));
  const proposalIds = new Set<string>();
  const proposals: DreamSynthesisProposal[] = parsed.proposals.map((proposal) => {
    if (proposalIds.has(proposal.id)) throw new Error("DUPLICATE_DREAM_PROPOSAL_ID");
    proposalIds.add(proposal.id);
    if (proposal.sourceScopeReferences.some((reference) => !scopeByReference.has(reference))) throw new Error("DREAM_PROPOSAL_SCOPE_OUTSIDE_SYNTHESIS");
    if (proposal.sourceReferences.some((reference) => !allowedSources.has(reference))) throw new Error("DREAM_PROPOSAL_SOURCE_OUTSIDE_SYNTHESIS");
    const sourceScopes = proposal.sourceScopeReferences.map((reference) => scopeByReference.get(reference)!);
    if (proposal.destination === "project_memory" && (sourceScopes.length !== 1 || sourceScopes[0]!.scopeKind !== "project")) throw new Error("DREAM_PROJECT_MEMORY_SCOPE_AMBIGUOUS");
    if ((proposal.destination === "long_term_memory" || proposal.destination === "merge_condense") && !proposal.comparisonSummary.trim()) throw new Error("DREAM_LONG_TERM_COMPARISON_REQUIRED");
    if (proposal.memoryAction === "narrow" || proposal.memoryAction === "revise") throw new Error("DREAM_REVISION_REQUIRES_USER_RESOLUTION_SIGNAL");
    if (proposal.targetEntryIds.some((id) => !activeMemoryIds.has(id))) throw new Error("DREAM_MEMORY_TARGET_NOT_ACTIVE");
    const expectedTargets = proposal.memoryAction === "add" ? 0 : proposal.memoryAction === "merge_condense" ? 2 : proposal.memoryAction === undefined ? 0 : 1;
    if (proposal.memoryAction === "merge_condense" ? proposal.targetEntryIds.length < expectedTargets : proposal.targetEntryIds.length !== expectedTargets) throw new Error("DREAM_MEMORY_TARGET_COUNT_INVALID");
    if (proposal.learning !== undefined) validateReusableSpecificity(proposal.learning, forbiddenTerms);
    return { ...proposal, status: "pending" };
  });
  return dreamGlobalSynthesisSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    status: "review_pending",
    inputHash: dreamSynthesisInputHash(input),
    longTermMemoryHash: input.longTermMemoryHash,
    summary: parsed.summary,
    uncertainty: parsed.uncertainty,
    partialCoverageScopeReferences: input.partialCoverageScopeReferences,
    scopeMap,
    proposals,
    createdAt: now
  });
}

export function opaqueScopeReference(batchId: string, scopeId: string): string {
  return `scope_ref_${createHash("sha256").update(`${batchId}\0${scopeId}`).digest("hex").slice(0, 24)}`;
}

function relevantMemoryCards(entries: readonly LongTermMemoryEntry[], terms: readonly string[]) {
  return entries.map((entry) => {
    const haystack = `${entry.title} ${entry.tags.join(" ")} ${entry.applicability.join(" ")} ${entry.content}`.toLocaleLowerCase();
    const score = terms.filter((term) => haystack.includes(term)).length;
    return { entry, score };
  }).sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id)).slice(0, 20).map(({ entry }) => ({
    id: entry.id, version: entry.version, title: entry.title, tags: entry.tags, applicability: entry.applicability,
    maturity: entry.maturity, conflictState: entry.conflictState, content: entry.content.slice(0, 320)
  }));
}

function validateReusableSpecificity(learning: NonNullable<DreamSynthesisProposal["learning"]>, forbiddenTerms: readonly string[]): void {
  const text = `${learning.title} ${learning.tags.join(" ")} ${learning.applicability.join(" ")} ${learning.limitations} ${learning.content}`.toLocaleLowerCase();
  for (const term of forbiddenTerms.map((item) => item.trim().toLocaleLowerCase()).filter((item) => item.length >= 3)) {
    if (text.includes(term)) throw new Error("DREAM_LONG_TERM_LEARNING_NOT_DEIDENTIFIED");
  }
  if (/\b(?:series\s+[a-z]|seed|pre-seed)\s+(?:at|on)\s+[$€£¥]?\d|[$€£¥]\s*\d[\d,.]*\s*(?:m|mm|million|亿|万)/iu.test(text)) throw new Error("DREAM_LONG_TERM_LEARNING_TOO_DEAL_SPECIFIC");
}

function words(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
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
  if (start < 0 || end < start) throw new Error("Dream synthesis response did not contain JSON");
  return raw.slice(start, end + 1);
}
