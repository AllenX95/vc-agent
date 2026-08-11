import { createHash } from "node:crypto";
import {
  assertCoverageComplete,
  projectCoverageSummary
} from "./coverage-ledger.js";
import {
  coverageLedgerSchema,
  learningProposalSchema,
  type CoverageLedger,
  type CoverageSummary,
  type LearningProposal,
  type MemoryEvolutionAction,
  type ProposalDestination
} from "@vc-agent/contracts";
import type { MemoryReviewExtractionCandidate, MemoryReviewExtractionResult } from "./memory-review-extraction.js";

/** Prompt text is duplicated so bundled Host code does not depend on source-file paths. */
export const MEMORY_REVIEW_SYNTHESIS_STAGE_INSTRUCTIONS = `You are running the final Memory Review synthesis in a new isolated context.

Use only the de-identified extraction results, opaque source/scope references, and bounded Memory cards supplied below. Do not browse, retrieve materials, infer facts from omitted exchanges, or use hidden reasoning as a source. Every proposed source must be an opaque source reference present in the extraction input, and every candidate origin must be one of the supplied extraction candidates.

Project Memory proposals are allowed only when every source belongs to exactly one Project scope. A proposal that combines scopes or includes an Unscoped source must target Long-term Memory. Long-term learning must remain reusable across Projects at no greater specificity than an industry, financing stage, or comparable investment situation. Never emit a Project name, company identifier, local path, raw dialogue, source excerpt, unpublished metric, or transaction term in a Long-term Memory proposal. This stage creates reviewable proposals and never authorizes a write.

Return one JSON object with bounded summary, uncertainty, and proposals only.`;

const SYNTHESIS_SCHEMA_VERSION = 1 as const;
const MAX_PROPOSALS = 100;
const MAX_CARDS = 100;
const MAX_SCOPES = 10_000;
const MAX_SOURCES = 100_000;
const MAX_CANDIDATES = 100_000;

export interface MemoryReviewSynthesisCard {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly applicability?: readonly string[];
  readonly limitations?: string;
  readonly tags?: readonly string[];
  readonly version?: number | string;
  readonly maturity?: string;
  readonly recallPolicy?: string;
  readonly conflictState?: string;
  /** Project cards may carry a local identity only at the Host boundary. */
  readonly scope?: "project" | "long_term" | "unscoped";
  readonly projectId?: string;
  readonly scopeReference?: string;
  readonly status?: "current" | "superseded";
}

export interface MemoryReviewSynthesisBuildInput {
  readonly batchId: string;
  readonly cutoff: string;
  readonly coverage: CoverageLedger;
  /** Only completed/approved extraction results may be supplied. */
  readonly extractionResults: readonly (MemoryReviewExtractionResult & { readonly approved?: boolean })[];
  readonly projectMemoryCards?: readonly MemoryReviewSynthesisCard[];
  readonly longTermMemoryCards?: readonly MemoryReviewSynthesisCard[];
  /** Stable, run-frozen values. They are included in the input hash. */
  readonly promptSnapshot?: unknown;
  readonly profileSnapshot?: unknown;
  /** Optional local terms (for example a Project display name) that may not cross the Long-term boundary. */
  readonly forbiddenTerms?: readonly string[];
}

export interface MemoryReviewSynthesisScope {
  readonly scopeReference: string;
  readonly scopeKind: "project" | "unscoped";
  readonly sourceReferences: readonly string[];
  readonly candidates: readonly {
    readonly candidateReference: string;
    readonly sourceReferences: readonly string[];
    readonly title?: string;
    readonly summary?: string;
    readonly destination?: ProposalDestination;
  }[];
}

/**
 * The normalized, content-bounded input sent to the synthesis model. The
 * Coverage Ledger remains attached for Host validation but is never emitted
 * by the prompt builder with Project identities.
 */
export interface MemoryReviewSynthesisInput {
  readonly schemaVersion: typeof SYNTHESIS_SCHEMA_VERSION;
  readonly batchId: string;
  readonly cutoff: string;
  readonly coverage: CoverageLedger;
  readonly scopes: readonly MemoryReviewSynthesisScope[];
  readonly projectMemoryCards: readonly MemoryReviewSynthesisCard[];
  readonly longTermMemoryCards: readonly MemoryReviewSynthesisCard[];
  readonly promptSnapshot?: unknown;
  readonly profileSnapshot?: unknown;
  readonly inputHash: string;
}

export interface MemoryReviewSynthesisMetadata {
  readonly schemaVersion: typeof SYNTHESIS_SCHEMA_VERSION;
  readonly batchReference: string;
  readonly inputHash: string;
  readonly cutoff: string;
  readonly summary: string;
  readonly uncertainty: string;
  readonly coverage: CoverageSummary;
  readonly scopeCount: number;
  readonly sourceCount: number;
  readonly representedSourceCount: number;
  readonly noSignalSourceCount: number;
  readonly carriedOverSourceCount: number;
  readonly promptSnapshot?: unknown;
  readonly profileSnapshot?: unknown;
  readonly createdAt: string;
}

export interface MemoryReviewSynthesisResult {
  readonly schemaVersion: typeof SYNTHESIS_SCHEMA_VERSION;
  readonly proposals: readonly LearningProposal[];
  readonly metadata: MemoryReviewSynthesisMetadata;
}

export interface MemoryReviewSynthesisExecutionInput {
  readonly input: MemoryReviewSynthesisInput;
  readonly generate: (prompt: string) => string | Promise<string>;
  readonly now?: string;
}

interface InternalSynthesisState {
  readonly sourceAliases: ReadonlyMap<string, string>;
  readonly scopeAliases: ReadonlyMap<string, string>;
  readonly candidateAliases: ReadonlyMap<string, string>;
  readonly candidateIds: ReadonlySet<string>;
  readonly candidateById: ReadonlyMap<string, MemoryReviewExtractionCandidate>;
  readonly sourceEntries: ReadonlyMap<string, CoverageLedger["entries"][number]>;
  readonly sourceScope: ReadonlyMap<string, string>;
  readonly scopeKind: ReadonlyMap<string, "project" | "unscoped">;
  readonly projectCardIdsByScope: ReadonlyMap<string, ReadonlySet<string>>;
  readonly longTermCardIds: ReadonlySet<string>;
  readonly forbiddenTerms: readonly string[];
}

const states = new WeakMap<object, InternalSynthesisState>();

/**
 * Build one deterministic synthesis input from terminal Coverage and approved
 * extraction results. This is the only authority gate before model execution.
 */
export function buildMemoryReviewSynthesisInput(input: MemoryReviewSynthesisBuildInput): MemoryReviewSynthesisInput {
  if (!input.batchId.trim()) throw new Error("Memory Review synthesis batchId is required.");
  if (!input.cutoff.trim()) throw new Error("Memory Review synthesis cutoff is required.");
  const coverage = coverageLedgerSchema.parse(input.coverage);
  assertCoverageComplete(coverage);
  if (coverage.entries.length > MAX_SOURCES) throw new Error("Memory Review synthesis source set exceeds bounds.");

  const sourceEntries = new Map(coverage.entries.map((entry) => [entry.sourceReference, entry]));
  const sourceAliases = new Map<string, string>();
  const scopeAliases = new Map<string, string>();
  const candidateAliases = new Map<string, string>();
  const candidateIds = new Set<string>();
  const candidateById = new Map<string, MemoryReviewExtractionCandidate>();
  const sourceScope = new Map<string, string>();
  const scopeKind = new Map<string, "project" | "unscoped">();
  const dispositions = new Map<string, { status: string; proposalIds: readonly string[] }>();
  const scopesByIdentity = new Map<string, { kind: "project" | "unscoped"; projectId?: string; threadId?: string; sourceReferences: string[] }>();

  for (const entry of coverage.entries) {
    const identity = entry.scope === "project"
      ? `project:${entry.projectId ?? ""}`
      : `unscoped:${entry.threadId ?? entry.sourceReference}`;
    if (entry.scope === "project" && !entry.projectId) throw new Error(`Project source is missing project identity: ${entry.sourceReference}`);
    const group = scopesByIdentity.get(identity) ?? { kind: entry.scope, ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }), ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }), sourceReferences: [] };
    group.sourceReferences.push(entry.sourceReference);
    scopesByIdentity.set(identity, group);
    const scopeReference = opaqueReference("scope_ref", input.batchId, identity);
    scopeAliases.set(identity, scopeReference);
    sourceAliases.set(entry.sourceReference, opaqueReference("source_ref", input.batchId, entry.sourceReference));
    sourceScope.set(entry.sourceReference, identity);
    scopeKind.set(identity, entry.scope);
  }

  const results = [...input.extractionResults].sort((left, right) => left.chunkId.localeCompare(right.chunkId));
  const chunkIds = new Set<string>();
  for (const result of results) {
    if (result.approved === false) throw new Error(`Memory Review extraction result is not approved: ${result.chunkId}`);
    if (chunkIds.has(result.chunkId)) throw new Error(`Duplicate Memory Review extraction result: ${result.chunkId}`);
    chunkIds.add(result.chunkId);
    const seenInResult = new Set<string>();
    for (const disposition of result.dispositions) {
      if (seenInResult.has(disposition.sourceReference)) throw new Error(`Duplicate source disposition in extraction result: ${disposition.sourceReference}`);
      seenInResult.add(disposition.sourceReference);
      const entry = sourceEntries.get(disposition.sourceReference);
      if (entry === undefined) throw new Error(`Synthesis extraction result used a source outside the Coverage Ledger: ${disposition.sourceReference}`);
      if (dispositions.has(disposition.sourceReference)) throw new Error(`Source was dispositioned by multiple extraction results: ${disposition.sourceReference}`);
      const proposalIds = disposition.proposalIds ?? [];
      if (entry.status !== disposition.status || (entry.proposalIds.join("\0") !== proposalIds.join("\0"))) {
        throw new Error(`Extraction disposition does not match the Coverage Ledger: ${disposition.sourceReference}`);
      }
      dispositions.set(disposition.sourceReference, { status: disposition.status, proposalIds });
    }

    for (const candidate of result.candidates) {
      if (candidateIds.has(candidate.id)) throw new Error(`Duplicate extraction candidate across chunks: ${candidate.id}`);
      candidateIds.add(candidate.id);
      candidateById.set(candidate.id, candidate);
      candidateAliases.set(candidate.id, opaqueReference("candidate_ref", input.batchId, candidate.id));
      const refs = candidate.sourceReferences ?? result.dispositions.filter((item) => (item.proposalIds ?? []).includes(candidate.id)).map((item) => item.sourceReference);
      for (const reference of refs) {
        const entry = sourceEntries.get(reference);
        if (entry === undefined || !seenInResult.has(reference)) throw new Error(`Extraction candidate used a source outside its chunk: ${reference}`);
        if (sourceScope.get(reference) !== sourceScope.get(refs[0]!)) throw new Error(`Extraction candidate crosses Project/Unscoped scope: ${candidate.id}`);
      }
    }
  }

  for (const entry of coverage.entries) {
    if (!dispositions.has(entry.sourceReference)) {
      if (entry.status === "carried_over" && entry.availability === "deleted") {
        dispositions.set(entry.sourceReference, { status: entry.status, proposalIds: [] });
      } else {
        throw new Error(`Synthesis extraction results omitted Coverage Ledger source: ${entry.sourceReference}`);
      }
    }
    if (entry.status === "represented") {
      for (const proposalId of entry.proposalIds) {
        if (!candidateIds.has(proposalId)) throw new Error(`Coverage Ledger proposal candidate is missing from extraction results: ${proposalId}`);
      }
    }
  }
  if (candidateIds.size > MAX_CANDIDATES) throw new Error("Memory Review synthesis candidate set exceeds bounds.");

  const projectScopeIdentities = [...scopesByIdentity.entries()].filter(([, scope]) => scope.kind === "project").map(([identity]) => identity);
  const projectMemoryCards = normalizeProjectCards(input.projectMemoryCards ?? [], projectScopeIdentities, scopeAliases);
  const longTermMemoryCards = normalizeLongTermCards(input.longTermMemoryCards ?? []);
  if (projectMemoryCards.length > MAX_CARDS || longTermMemoryCards.length > MAX_CARDS) throw new Error("Memory Review synthesis Memory cards exceed bounds.");

  const scopes: MemoryReviewSynthesisScope[] = [...scopesByIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([identity, scope]) => {
      const sourceReferences = [...scope.sourceReferences].sort((left, right) => left.localeCompare(right));
      const candidateForScope = [...candidateById.entries()]
        .filter(([, candidate]) => (candidate.sourceReferences ?? [...dispositions.entries()].filter(([, disposition]) => disposition.proposalIds.includes(candidate.id)).map(([reference]) => reference)).some((reference) => sourceScope.get(reference) === identity))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([candidateId, candidate]) => ({
          candidateReference: candidateAliases.get(candidateId)!,
          sourceReferences: (candidate.sourceReferences ?? [...dispositions.entries()].filter(([, disposition]) => disposition.proposalIds.includes(candidateId)).map(([reference]) => reference)).map((reference) => sourceAliases.get(reference)!).sort(),
          ...(candidate.title === undefined ? {} : { title: bound(candidate.title, 200) }),
          ...(candidate.summary === undefined ? {} : { summary: bound(candidate.summary, 2_000) }),
          ...(candidate.destination === undefined ? {} : { destination: candidate.destination })
        }));
      return {
        scopeReference: scopeAliases.get(identity)!,
        scopeKind: scope.kind,
        sourceReferences: sourceReferences.map((reference) => sourceAliases.get(reference)!),
        candidates: candidateForScope
      };
    });
  if (scopes.length > MAX_SCOPES) throw new Error("Memory Review synthesis scope set exceeds bounds.");

  const result: MemoryReviewSynthesisInput = {
    schemaVersion: SYNTHESIS_SCHEMA_VERSION,
    batchId: input.batchId,
    cutoff: input.cutoff,
    coverage,
    scopes,
    projectMemoryCards,
    longTermMemoryCards,
    ...(input.promptSnapshot === undefined ? {} : { promptSnapshot: input.promptSnapshot }),
    ...(input.profileSnapshot === undefined ? {} : { profileSnapshot: input.profileSnapshot }),
    inputHash: ""
  };
  const inputHash = memoryReviewSynthesisInputHash(result);
  const normalized = { ...result, inputHash };
  const projectCardIdsByScope = new Map<string, ReadonlySet<string>>();
  for (const card of projectMemoryCards) {
    if (card.scopeReference !== undefined) {
      const identity = [...scopeAliases.entries()].find(([, reference]) => reference === card.scopeReference)?.[0];
      if (identity !== undefined) projectCardIdsByScope.set(identity, new Set([...(projectCardIdsByScope.get(identity) ?? new Set<string>()), card.id]));
    }
  }
  const sourceReferenceLookup = new Map<string, string>();
  for (const [actual, alias] of sourceAliases) { sourceReferenceLookup.set(alias, actual); sourceReferenceLookup.set(actual, actual); }
  const scopeLookup = new Map<string, string>();
  for (const [identity, alias] of scopeAliases) { scopeLookup.set(alias, identity); scopeLookup.set(identity, identity); }
  const candidateLookup = new Map<string, string>();
  for (const [actual, alias] of candidateAliases) { candidateLookup.set(alias, actual); candidateLookup.set(actual, actual); }
  states.set(normalized, {
    sourceAliases: sourceReferenceLookup,
    scopeAliases: scopeLookup,
    candidateAliases: candidateLookup,
    candidateIds,
    candidateById,
    sourceEntries,
    sourceScope,
    scopeKind,
    projectCardIdsByScope,
    longTermCardIds: new Set(longTermMemoryCards.map((card) => card.id)),
    forbiddenTerms: (input.forbiddenTerms ?? []).map((term) => term.trim()).filter((term) => term.length >= 3)
  });
  return normalized;
}

/** Build the one model-facing prompt for a prepared synthesis input. */
export function buildMemoryReviewSynthesisPrompt(input: MemoryReviewSynthesisInput, options: { readonly stageInstructions?: string } = {}): string {
  assertInputHash(input);
  const context = {
    schemaVersion: SYNTHESIS_SCHEMA_VERSION,
    batchReference: opaqueReference("memory_review", input.batchId, input.batchId),
    cutoff: input.cutoff,
    inputHash: input.inputHash,
    scopes: input.scopes,
    projectMemoryCards: input.projectMemoryCards,
    longTermMemoryCards: input.longTermMemoryCards,
    coverage: projectCoverageSummary(input.coverage),
    ...(input.promptSnapshot === undefined ? {} : { promptSnapshot: input.promptSnapshot }),
    ...(input.profileSnapshot === undefined ? {} : { profileSnapshot: input.profileSnapshot })
  };
  const instructions = options.stageInstructions ?? MEMORY_REVIEW_SYNTHESIS_STAGE_INSTRUCTIONS;
  return `${instructions}\n\nSynthesis input (de-identified):\n${stableJson(context)}\n\nOutput schema:\n{"summary": string, "uncertainty": string, "proposals": [{"id": string, "title": string, "content": string, "applicability": string[], "limitations": string, "destination": "project_memory" | "long_term_memory", "action": "add" | "reinforce" | "narrow" | "revise" | "contradict" | "merge_condense", "sourceReferences": string[], "targetEntryIds": string[], "candidateIds"?: string[]}]}\nReturn JSON only.`;
}

/** Parse, validate, de-identify, and normalize one model synthesis response. */
export function parseMemoryReviewSynthesis(raw: string, input: MemoryReviewSynthesisInput, options: { readonly now?: string } = {}): MemoryReviewSynthesisResult {
  assertInputHash(input);
  const state = states.get(input);
  if (state === undefined) throw new Error("Memory Review synthesis input was not prepared by buildMemoryReviewSynthesisInput.");
  const object = parseJsonObject(raw);
  if (object.inputHash !== undefined && object.inputHash !== input.inputHash) throw new Error("Memory Review synthesis input hash changed.");
  const proposalsRaw = object.proposals;
  if (!Array.isArray(proposalsRaw)) throw new Error("Memory Review synthesis response is missing proposals.");
  if (proposalsRaw.length > MAX_PROPOSALS) throw new Error("Memory Review synthesis proposals exceed bounds.");
  const seenProposalIds = new Set<string>();
  const proposals: LearningProposal[] = proposalsRaw.map((value, index) => {
    if (value === null || typeof value !== "object") throw new Error(`Invalid Memory Review synthesis proposal at index ${index}.`);
    const record = value as Record<string, unknown>;
    const id = stringValue(record.id, `proposal-${index + 1}`);
    if (seenProposalIds.has(id)) throw new Error(`Duplicate Memory Review proposal id: ${id}`);
    seenProposalIds.add(id);
    const destination = parseDestination(record.destination);
    const rawSourceReferences = record.sourceReferences ?? record.sources;
    if (!Array.isArray(rawSourceReferences) || rawSourceReferences.length === 0 || rawSourceReferences.some((reference) => typeof reference !== "string")) {
      throw new Error(`Memory Review proposal ${id} is missing source references.`);
    }
    const sourceReferences = rawSourceReferences.map((reference) => resolveSourceReference(reference, state)).filter(uniqueStrings);
    if (sourceReferences.length !== rawSourceReferences.length) throw new Error(`Memory Review proposal ${id} contains duplicate source references.`);
    const entries = sourceReferences.map((reference) => state.sourceEntries.get(reference)!);
    if (entries.some((entry) => entry.status !== "represented")) throw new Error(`Memory Review proposal ${id} references a source without a represented extraction candidate.`);
    const scopeIdentities = [...new Set(sourceReferences.map((reference) => state.sourceScope.get(reference)!))];
    if (destination === "project_memory" && (scopeIdentities.length !== 1 || state.scopeKind.get(scopeIdentities[0]!) !== "project")) {
      throw new Error("Project Memory proposal must use exactly one Project scope.");
    }
    const candidateIds = parseCandidateIds(record, state, id);
    if (candidateIds.length > 0 && candidateIds.some((candidateId) => !state.candidateIds.has(candidateId))) throw new Error(`Memory Review proposal ${id} used a candidate outside extraction inputs.`);
    const targetEntryIds = parseStringArray(record.targetEntryIds ?? record.targets, `proposal ${id} targetEntryIds`);
    if (destination === "long_term_memory") {
      if (targetEntryIds.some((targetId) => !state.longTermCardIds.has(targetId))) throw new Error(`Long-term Memory proposal ${id} targeted an unavailable Memory card.`);
    } else {
      const allowedProjectIds = state.projectCardIdsByScope.get(scopeIdentities[0]!) ?? new Set<string>();
      if (targetEntryIds.some((targetId) => !allowedProjectIds.has(targetId))) throw new Error(`Project Memory proposal ${id} targeted an unavailable Project Memory card.`);
    }
    const title = stringValue(record.title ?? nestedValue(record.learning, "title"), "");
    const content = stringValue(record.content ?? nestedValue(record.learning, "content") ?? record.summary, "");
    if (!title || !content) throw new Error(`Memory Review proposal ${id} requires title and content.`);
    const applicability = parseStringArray(record.applicability ?? nestedValue(record.learning, "applicability"), `proposal ${id} applicability`, true);
    const limitations = stringValue(record.limitations ?? nestedValue(record.learning, "limitations"), "");
    if (destination === "long_term_memory" && containsLongTermLeakage(`${title}\n${content}\n${applicability.join("\n")}\n${limitations}`, state.forbiddenTerms)) {
      throw new Error("Long-term Memory proposal is not de-identified.");
    }
    const action = parseAction(record.action ?? record.memoryAction, targetEntryIds.length > 0 ? "reinforce" : "add");
    const normalized = learningProposalSchema.parse({ id, title, content, applicability, limitations, destination, action, sourceReferences, targetEntryIds });
    return normalized;
  });
  const summary = bound(stringValue(object.summary, "Synthesis completed."), 4_000);
  const uncertainty = bound(stringValue(object.uncertainty, ""), 1_000);
  const coverage = projectCoverageSummary(input.coverage);
  const createdAt = options.now ?? new Date().toISOString();
  const metadata: MemoryReviewSynthesisMetadata = {
    schemaVersion: SYNTHESIS_SCHEMA_VERSION,
    batchReference: opaqueReference("memory_review", input.batchId, input.batchId),
    inputHash: input.inputHash,
    cutoff: input.cutoff,
    summary,
    uncertainty,
    coverage,
    scopeCount: input.scopes.length,
    sourceCount: coverage.eligibleCount,
    representedSourceCount: coverage.representedCount,
    noSignalSourceCount: coverage.noSignalCount,
    carriedOverSourceCount: coverage.carriedOverCount,
    ...(input.promptSnapshot === undefined ? {} : { promptSnapshot: input.promptSnapshot }),
    ...(input.profileSnapshot === undefined ? {} : { profileSnapshot: input.profileSnapshot }),
    createdAt
  };
  return { schemaVersion: SYNTHESIS_SCHEMA_VERSION, proposals, metadata };
}

/** Execute the true external model port after the deterministic build gate. */
export async function executeMemoryReviewSynthesis(input: MemoryReviewSynthesisExecutionInput): Promise<MemoryReviewSynthesisResult> {
  const prompt = buildMemoryReviewSynthesisPrompt(input.input);
  const raw = await input.generate(prompt);
  return parseMemoryReviewSynthesis(raw, input.input, input.now === undefined ? {} : { now: input.now });
}

export function memoryReviewSynthesisInputHash(input: Omit<MemoryReviewSynthesisInput, "inputHash"> | MemoryReviewSynthesisInput): string {
  return createHash("sha256").update(stableJson({
    schemaVersion: input.schemaVersion,
    batchId: input.batchId,
    cutoff: input.cutoff,
    scopes: input.scopes,
    projectMemoryCards: input.projectMemoryCards,
    longTermMemoryCards: input.longTermMemoryCards,
    promptSnapshot: input.promptSnapshot,
    profileSnapshot: input.profileSnapshot,
    coverage: input.coverage
  })).digest("hex");
}

function normalizeProjectCards(cards: readonly MemoryReviewSynthesisCard[], projectScopeIdentities: readonly string[], scopeAliases: ReadonlyMap<string, string>): MemoryReviewSynthesisCard[] {
  const seen = new Set<string>();
  return cards.filter((card) => card.status !== "superseded").map((card) => {
    if (!card.id.trim() || !card.title.trim()) throw new Error("Project Memory cards require id and title.");
    if (seen.has(card.id)) throw new Error(`Duplicate Project Memory card: ${card.id}`);
    seen.add(card.id);
    const identity = card.scopeReference === undefined
      ? card.projectId === undefined ? (projectScopeIdentities.length === 1 ? projectScopeIdentities[0] : undefined) : `project:${card.projectId}`
      : [...scopeAliases.entries()].find(([, reference]) => reference === card.scopeReference)?.[0];
    if (identity === undefined || !scopeAliases.has(identity)) throw new Error(`Project Memory card has ambiguous scope: ${card.id}`);
    return boundedCard(card, scopeAliases.get(identity)!);
  });
}

function normalizeLongTermCards(cards: readonly MemoryReviewSynthesisCard[]): MemoryReviewSynthesisCard[] {
  const seen = new Set<string>();
  return cards.filter((card) => card.status !== "superseded").map((card) => {
    if (!card.id.trim() || !card.title.trim()) throw new Error("Long-term Memory cards require id and title.");
    if (seen.has(card.id)) throw new Error(`Duplicate Long-term Memory card: ${card.id}`);
    seen.add(card.id);
    if (card.projectId !== undefined || card.scope === "project") throw new Error(`Long-term Memory card is Project-specific: ${card.id}`);
    if (containsLongTermLeakage(`${card.title}\n${card.content}\n${(card.applicability ?? []).join("\n")}\n${card.limitations ?? ""}`, [])) throw new Error(`Long-term Memory card is not de-identified: ${card.id}`);
    return boundedCard(card);
  });
}

function boundedCard(card: MemoryReviewSynthesisCard, scopeReference?: string): MemoryReviewSynthesisCard {
  return {
    id: bound(card.id, 200),
    title: bound(card.title, 200),
    content: bound(card.content, 4_000),
    ...(card.applicability === undefined ? {} : { applicability: card.applicability.slice(0, 20).map((item) => bound(item, 200)) }),
    ...(card.limitations === undefined ? {} : { limitations: bound(card.limitations, 2_000) }),
    ...(card.tags === undefined ? {} : { tags: card.tags.slice(0, 20).map((item) => bound(item, 100)) }),
    ...(card.version === undefined ? {} : { version: card.version }),
    ...(card.maturity === undefined ? {} : { maturity: bound(card.maturity, 100) }),
    ...(card.recallPolicy === undefined ? {} : { recallPolicy: bound(card.recallPolicy, 100) }),
    ...(card.conflictState === undefined ? {} : { conflictState: bound(card.conflictState, 100) }),
    ...(scopeReference === undefined ? {} : { scopeReference })
  };
}

function assertInputHash(input: MemoryReviewSynthesisInput): void {
  if (input.inputHash !== memoryReviewSynthesisInputHash(input)) throw new Error("Memory Review synthesis input hash changed.");
}

function parseDestination(value: unknown): ProposalDestination {
  if (value === "project_memory" || value === "long_term_memory") return value;
  throw new Error("Memory Review synthesis proposal has an invalid destination.");
}

function parseAction(value: unknown, fallback: MemoryEvolutionAction): MemoryEvolutionAction {
  if (value === undefined) return fallback;
  if (["add", "reinforce", "narrow", "revise", "contradict", "merge_condense"].includes(String(value))) return String(value) as MemoryEvolutionAction;
  throw new Error("Memory Review synthesis proposal has an invalid Memory Evolution action.");
}

function parseCandidateIds(record: Record<string, unknown>, state: InternalSynthesisState, proposalId: string): string[] {
  const value = record.candidateIds ?? record.candidateReferences;
  if (value === undefined) return [];
  const values = parseStringArray(value, `proposal ${proposalId} candidateIds`);
  return values.map((candidate) => {
    const resolved = state.candidateAliases.get(candidate) ?? candidate;
    if (!state.candidateIds.has(resolved)) throw new Error(`Memory Review proposal ${proposalId} used a candidate outside extraction inputs.`);
    return resolved;
  });
}

function parseStringArray(value: unknown, label: string, optional = false): string[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) throw new Error(`${label} must be a string array.`);
  const result = value.map((item) => item.trim());
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates.`);
  return result;
}

function resolveSourceReference(reference: string, state: InternalSynthesisState): string {
  const resolved = state.sourceAliases.get(reference);
  if (resolved === undefined || !state.sourceEntries.has(resolved)) throw new Error(`Memory Review proposal used a source outside synthesis inputs: ${reference}`);
  return resolved;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function nestedValue(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function uniqueStrings(value: string, index: number, values: readonly string[]): boolean { return values.indexOf(value) === index; }

function containsLongTermLeakage(value: string, forbiddenTerms: readonly string[]): boolean {
  const normalized = value.normalize("NFKC");
  const lower = normalized.toLocaleLowerCase();
  if (forbiddenTerms.some((term) => lower.includes(term.normalize("NFKC").toLocaleLowerCase()))) return true;
  return /(?:^|\n)\s*(?:company|project|deal|transaction|公司|项目|交易)\s*[:：]|(?:[A-Z]:\\|\\\\|\/Users\/|\/home\/)|\b(?:[A-Z][A-Za-z0-9&.-]*\s+){0,3}[A-Z][A-Za-z0-9&.-]*\s+(?:Inc\.?|Corp\.?|Corporation|Ltd\.?|LLC|Limited)\b|[\p{Script=Han}A-Za-z0-9]{2,30}(?:股份有限公司|有限公司|集团)|(?:pre[- ]?money|post[- ]?money|term sheet|valuation|ARR|MRR|估值|投前|投后|交易条款|收入|营收)\s*[:：]?\s*(?:[$¥￥€£]|\d)/iu.test(normalized);
}

function opaqueReference(prefix: string, batchId: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(`${batchId}\0${value}`).digest("hex").slice(0, 24)}`;
}

function bound(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(raw)?.[1]?.trim();
  const text = fenced ?? raw.trim();
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("Memory Review synthesis response did not contain JSON.");
    try { parsed = JSON.parse(text.slice(start, end + 1)); }
    catch { throw new Error("Memory Review synthesis response contained invalid JSON."); }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Memory Review synthesis response must be a JSON object.");
  return parsed as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
