import { createHash } from "node:crypto";
import type { EligibleLearningSource } from "@vc-agent/contracts";
import { extractionChunkSchema } from "@vc-agent/contracts";
import { ContextBudgetService, type ContextBudgetDecision } from "../context-budget.js";

/**
 * The source body is deliberately a runtime-only value.  Eligibility and the
 * persisted chunk record contain references and hashes; the body is resolved
 * when a chunk is about to be sent to a model and can then be retired.
 */
export interface MemoryReviewSourceBody {
  readonly userText?: string;
  readonly assistantText?: string;
  readonly sourceText?: string;
}

export interface MemoryReviewChunkSource extends EligibleLearningSource {
  /** A bounded, model-facing representation of the source. */
  readonly userText: string;
  readonly assistantText: string;
  readonly truncated: boolean;
}

export interface ExtractionChunk extends Omit<import("@vc-agent/contracts").ExtractionChunk, "id"> {
  readonly id: string;
  /** Runtime-only bounded bodies; never persist this field in cognition-v2. */
  readonly sources: readonly MemoryReviewChunkSource[];
  readonly budget: ChunkBudgetTelemetry;
  readonly promptSnapshot?: unknown;
  readonly profileSnapshot?: unknown;
  readonly stageInstructions?: string;
  readonly outputSchema?: string;
}

/** More explicit name for consumers that keep the contracts' ExtractionChunk type imported. */
export type MemoryReviewExtractionChunk = ExtractionChunk;

export interface ChunkBudgetTelemetry {
  readonly estimatorRevision: string;
  readonly safetyMarginTokens: number;
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
  readonly usableContextTokens: number;
  readonly estimatedInputTokens: number;
  readonly retrievalTokens: number;
}

export interface MemoryReviewChunkInput extends EligibleLearningSource {
  readonly body?: MemoryReviewSourceBody;
}

export interface ChunkingOptions {
  /** Use the shared implementation.  A default instance is provided for callers. */
  readonly budgetService?: ContextBudgetService;
  readonly contextWindowTokens?: number;
  readonly reservedOutputTokens?: number;
  readonly systemPrompt?: string;
  readonly toolSchema?: string;
  readonly stageInstructions?: string;
  readonly outputSchema?: string;
  /** Project Memory cards are included for Project scopes only. */
  readonly projectMemory?: unknown;
  /** Stable snapshots are included in the input hash for restart/staleness checks. */
  readonly promptSnapshot?: unknown;
  readonly profileSnapshot?: unknown;
  readonly now?: string;
  /** Optional resolver used when the body is not present in the source input. */
  readonly resolveSource?: (source: EligibleLearningSource) => MemoryReviewSourceBody | undefined | Promise<MemoryReviewSourceBody | undefined>;
}

export interface BuildExtractionChunksInput extends ChunkingOptions {
  readonly sources: readonly MemoryReviewChunkInput[];
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 16_384;
const DEFAULT_RESERVED_OUTPUT_TOKENS = 1_024;
const DEFAULT_STAGE_INSTRUCTIONS = "Inspect every source exactly once and return a strict source disposition.";
const DEFAULT_OUTPUT_SCHEMA = "{ schemaVersion: 1, chunkId, dispositions: [{ sourceReference, status, proposalIds?, reason? }] }";

/**
 * Build deterministic, scope-isolated extraction chunks.  Sources are ordered
 * by completedAt and then sourceReference, and each chunk is admitted by the
 * real ContextBudgetService rather than by a fixed item count.
 */
export function buildMemoryReviewChunks(input: BuildExtractionChunksInput): ExtractionChunk[];
export function buildMemoryReviewChunks(sources: readonly MemoryReviewChunkInput[], options?: ChunkingOptions): ExtractionChunk[];
export function buildMemoryReviewChunks(
  inputOrSources: BuildExtractionChunksInput | readonly MemoryReviewChunkInput[],
  options: ChunkingOptions = {}
): ExtractionChunk[] {
  const input: BuildExtractionChunksInput = Array.isArray(inputOrSources)
    ? { ...options, sources: inputOrSources as readonly MemoryReviewChunkInput[] }
    : inputOrSources as BuildExtractionChunksInput;
  const budgetService = input.budgetService ?? new ContextBudgetService();
  const contextWindowTokens = input.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const reservedOutputTokens = input.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
  const now = input.now ?? new Date().toISOString();
  const staticBytes = staticInputBytes(input);
  const sorted = [...input.sources].sort(compareSources);
  const groups = groupByScope(sorted);
  const chunks: ExtractionChunk[] = [];

  for (const [scopeId, group] of groups) {
    const scope = group[0]!;
    const projectMemoryBytes = scope.scope === "project" && input.projectMemory !== undefined
      ? Buffer.byteLength(stableJson(input.projectMemory), "utf8")
      : 0;
    let current: MemoryReviewChunkSource[] = [];
    let currentDecision = budgetDecision(budgetService, staticBytes, projectMemoryBytes, current, contextWindowTokens, reservedOutputTokens);
    if (!isAdmitted(currentDecision)) {
      throw new Error(`Context budget is too small to admit extraction metadata for ${scopeId}.`);
    }
    for (const source of group) {
      const full = boundedSource(source, source.body, Number.POSITIVE_INFINITY);
      const candidateDecision = budgetDecision(
        budgetService,
        staticBytes,
        projectMemoryBytes,
        [...current, full],
        contextWindowTokens,
        reservedOutputTokens
      );
      const canAdmitFull = isAdmitted(candidateDecision);
      if (current.length > 0 && !canAdmitFull) {
        chunks.push(makeChunk(scopeId, current, currentDecision, input, now, budgetService, contextWindowTokens, reservedOutputTokens));
        current = [];
        currentDecision = budgetDecision(budgetService, staticBytes, projectMemoryBytes, current, contextWindowTokens, reservedOutputTokens);
      }

      if (current.length === 0) {
        const singleDecision = budgetDecision(budgetService, staticBytes, projectMemoryBytes, [full], contextWindowTokens, reservedOutputTokens);
        if (isAdmitted(singleDecision)) {
          current = [full];
          currentDecision = singleDecision;
          continue;
        }

        // A single source can exceed the available budget.  Keep its stable
        // reference and a deterministic bounded excerpt instead of dropping
        // it.  If even the metadata does not fit, a reference-only excerpt is
        // still represented and is subsequently dispositioned by extraction.
        const excerpted = fitSourceToBudget(source, singleDecision, {
          budgetService,
          staticBytes,
          projectMemoryBytes,
          contextWindowTokens,
          reservedOutputTokens
        });
        current = [excerpted];
        currentDecision = budgetDecision(budgetService, staticBytes, projectMemoryBytes, current, contextWindowTokens, reservedOutputTokens);
        if (!isAdmitted(currentDecision)) throw new Error(`Context budget is too small to represent source ${source.sourceReference}.`);
        continue;
      }

      current.push(full);
      currentDecision = candidateDecision;
    }
    if (current.length > 0) chunks.push(makeChunk(scopeId, current, currentDecision, input, now, budgetService, contextWindowTokens, reservedOutputTokens));
  }
  return chunks;
}

/** Stable ordering shared by the ledger and chunk construction. */
function compareSources(left: Pick<EligibleLearningSource, "completedAt" | "sourceReference">, right: Pick<EligibleLearningSource, "completedAt" | "sourceReference">): number {
  return left.completedAt.localeCompare(right.completedAt) || left.sourceReference.localeCompare(right.sourceReference);
}

/** Resolve a body at execution time, without mutating the content-free chunk. */
export async function resolveMemoryReviewChunkSources(
  chunk: Pick<ExtractionChunk, "sources" | "sourceReferences">,
  resolver: (sourceReference: string) => MemoryReviewSourceBody | undefined | Promise<MemoryReviewSourceBody | undefined>
): Promise<MemoryReviewChunkSource[]> {
  const resolved: MemoryReviewChunkSource[] = [];
  for (const source of chunk.sources) {
    // A prepared excerpt is already bounded.  Never replace it with an
    // unbounded trajectory body at execution time.
    if (source.truncated) {
      resolved.push(source);
      continue;
    }
    const body = await resolver(source.sourceReference);
    const preparedBytes = Buffer.byteLength(stableJson(modelSource(source)), "utf8");
    resolved.push(boundedSource(source, body, preparedBytes));
  }
  // A chunk must never resolve a source outside its frozen membership.
  const expected = new Set(chunk.sourceReferences);
  if (resolved.some((source) => !expected.has(source.sourceReference))) throw new Error("Resolved source is outside the extraction chunk");
  return resolved;
}

function makeChunk(
  scopeId: string,
  sources: readonly MemoryReviewChunkSource[],
  decision: ContextBudgetDecision,
  input: BuildExtractionChunksInput,
  now: string,
  budgetService: ContextBudgetService,
  contextWindowTokens: number,
  reservedOutputTokens: number
): ExtractionChunk {
  if (!isAdmitted(decision)) throw new Error("Cannot create an extraction chunk that exceeds the context budget.");
  const scope = sources[0]!;
  const id = `chunk:${scopeId}:${chunksOrdinalPlaceholder(sources)}`;
  // The ordinal is replaced by the caller after construction.  The source
  // membership hash remains independent of list position and therefore stable
  // if another scope gains a chunk.
  const inputHash = createHash("sha256").update(stableJson({
    estimatorRevision: budgetService.estimatorRevision,
    safetyMarginTokens: budgetService.safetyMarginTokens,
    scope: scope.scope,
    projectId: scope.projectId,
    threadId: scope.threadId,
    sourceReferences: sources.map((source) => source.sourceReference),
    sourceBodies: sources.map((source) => ({ sourceReference: source.sourceReference, userText: source.userText, assistantText: source.assistantText, truncated: source.truncated })),
    promptSnapshot: input.promptSnapshot,
    profileSnapshot: input.profileSnapshot
  })).digest("hex");
  const base = extractionChunkSchema.parse({
    schemaVersion: 1,
    id,
    scope: scope.scope,
    ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
    ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
    sourceReferences: sources.map((source) => source.sourceReference),
    inputHash,
    status: "pending",
    attemptCount: 0,
    createdAt: now,
    updatedAt: now
  });
  return {
    ...base,
    sources: [...sources],
    budget: {
      estimatorRevision: budgetService.estimatorRevision,
      safetyMarginTokens: budgetService.safetyMarginTokens,
      contextWindowTokens,
      reservedOutputTokens,
      usableContextTokens: decision.usableContextTokens,
      estimatedInputTokens: decision.estimatedInputTokens,
      retrievalTokens: decision.contributions.retrievalTokens
    },
    ...(input.promptSnapshot === undefined ? {} : { promptSnapshot: input.promptSnapshot }),
    ...(input.profileSnapshot === undefined ? {} : { profileSnapshot: input.profileSnapshot }),
    stageInstructions: input.stageInstructions ?? DEFAULT_STAGE_INSTRUCTIONS,
    outputSchema: input.outputSchema ?? DEFAULT_OUTPUT_SCHEMA
  };
}

function chunksOrdinalPlaceholder(sources: readonly MemoryReviewChunkSource[]): string {
  return createHash("sha256").update(sources.map((source) => source.sourceReference).join("\n")).digest("hex").slice(0, 16);
}

function budgetDecision(
  service: ContextBudgetService,
  staticBytes: { systemPromptBytes: number; toolSchemaBytes: number; taskBytes: number },
  projectMemoryBytes: number,
  sources: readonly MemoryReviewChunkSource[],
  contextWindowTokens: number,
  reservedOutputTokens: number
): ContextBudgetDecision {
  // Budget the same envelope that buildMemoryReviewExtractionPrompt emits,
  // including source-reference/scope metadata and fixed prompt scaffolding;
  // budgeting only raw bodies would undercount a small chunk materially.
  const envelope = {
    schemaVersion: 1,
    chunkId: "chunk-id",
    scope: sources[0]?.scope,
    projectId: sources[0]?.projectId,
    threadId: sources[0]?.threadId,
    sourceReferences: sources.map((source) => source.sourceReference),
    sources: sources.map((source) => modelSource(source))
  };
  const retrievalBytes = projectMemoryBytes + Buffer.byteLength(stableJson(envelope), "utf8") + Buffer.byteLength("\n\nChunk input:\n\nReturn JSON only.", "utf8") + 64;
  return service.decide({
    ...staticBytes,
    retainedHistoryBytes: 0,
    retrievalBytes,
    contextWindowTokens,
    reservedOutputTokens
  });
}

function staticInputBytes(input: BuildExtractionChunksInput): { systemPromptBytes: number; toolSchemaBytes: number; taskBytes: number } {
  return {
    systemPromptBytes: Buffer.byteLength(input.systemPrompt ?? "", "utf8"),
    toolSchemaBytes: Buffer.byteLength(input.toolSchema ?? "", "utf8"),
    taskBytes: Buffer.byteLength(`${input.stageInstructions ?? DEFAULT_STAGE_INSTRUCTIONS}\n${input.outputSchema ?? DEFAULT_OUTPUT_SCHEMA}`, "utf8")
  };
}

function groupByScope(sources: readonly MemoryReviewChunkInput[]): Map<string, MemoryReviewChunkInput[]> {
  const groups = new Map<string, MemoryReviewChunkInput[]>();
  for (const source of sources) {
    const scopeIdentity = source.scope === "project" ? source.projectId : source.threadId;
    if (scopeIdentity === undefined) throw new Error(`Source ${source.sourceReference} is missing its scope identity`);
    const key = `${source.scope}:${scopeIdentity}`;
    const group = groups.get(key) ?? [];
    group.push(source);
    groups.set(key, group);
  }
  return new Map([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function boundedSource(source: MemoryReviewChunkInput | MemoryReviewChunkSource, body: MemoryReviewSourceBody | undefined, maxBytes: number): MemoryReviewChunkSource {
  const userText = body?.userText ?? ("userText" in source ? source.userText : "");
  const assistantText = body?.assistantText ?? ("assistantText" in source ? source.assistantText : "");
  const sourceText = body?.sourceText;
  const full = { userText: sourceText === undefined ? userText : `${sourceText}\n${userText}`, assistantText };
  if (!Number.isFinite(maxBytes)) {
    return { ...source, userText: full.userText, assistantText: full.assistantText, truncated: false };
  }
  const metadataBytes = Buffer.byteLength(stableJson({ sourceReference: source.sourceReference, completedAt: source.completedAt }), "utf8");
  const bodyBudget = Math.max(0, maxBytes - metadataBytes);
  const fullBytes = Buffer.byteLength(stableJson({ userText: full.userText, assistantText: full.assistantText }), "utf8");
  if (fullBytes <= bodyBudget) return { ...source, userText: full.userText, assistantText: full.assistantText, truncated: false };
  if (bodyBudget <= 0) return { ...source, userText: "", assistantText: "", truncated: true };
  const userShare = Math.floor(bodyBudget * 0.6);
  const assistantShare = Math.max(0, bodyBudget - userShare);
  const boundedUser = truncateUtf8(full.userText, userShare);
  const boundedAssistant = truncateUtf8(full.assistantText, assistantShare);
  return { ...source, userText: boundedUser, assistantText: boundedAssistant, truncated: true };
}

function isAdmitted(decision: ContextBudgetDecision): boolean {
  return decision.action !== "reject_current_input" && decision.action !== "reject_additional_retrieval" && decision.estimatedInputTokens <= decision.usableContextTokens;
}

interface FitSourceOptions {
  readonly budgetService: ContextBudgetService;
  readonly staticBytes: { systemPromptBytes: number; toolSchemaBytes: number; taskBytes: number };
  readonly projectMemoryBytes: number;
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
}

function fitSourceToBudget(source: MemoryReviewChunkInput, fullDecision: ContextBudgetDecision, options: FitSourceOptions): MemoryReviewChunkSource {
  const referenceBytes = Buffer.byteLength(stableJson({ sourceReference: source.sourceReference, completedAt: source.completedAt }), "utf8");
  const referenceOnly = boundedSource(source, source.body, referenceBytes);
  if (!isAdmitted(budgetDecision(options.budgetService, options.staticBytes, options.projectMemoryBytes, [referenceOnly], options.contextWindowTokens, options.reservedOutputTokens))) {
    throw new Error(`Context budget is too small to represent source ${source.sourceReference}.`);
  }
  const full = boundedSource(source, source.body, Number.POSITIVE_INFINITY);
  let low = referenceBytes;
  let high = Buffer.byteLength(stableJson(modelSource(full)), "utf8");
  let best = referenceOnly;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = boundedSource(source, source.body, middle);
    const decision = budgetDecision(options.budgetService, options.staticBytes, options.projectMemoryBytes, [candidate], options.contextWindowTokens, options.reservedOutputTokens);
    if (isAdmitted(decision)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  // Keep the argument in the signature so this helper cannot accidentally be
  // used without first deciding that the full body needs bounding.
  void fullDecision;
  return best;
}

function modelSource(source: Pick<MemoryReviewChunkSource, "sourceReference" | "completedAt" | "sourceKind" | "userText" | "assistantText" | "truncated">): unknown {
  return { sourceReference: source.sourceReference, completedAt: source.completedAt, sourceKind: source.sourceKind, userText: source.userText, assistantText: source.assistantText, truncated: source.truncated };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return `${value.slice(0, low)}…`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
