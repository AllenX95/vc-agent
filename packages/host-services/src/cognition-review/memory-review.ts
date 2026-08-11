import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  autoMemoryReviewPolicySchema,
  cognitionDependencySchema,
  coverageLedgerSchema,
  eligibleLearningSourceSchema,
  extractionChunkSchema,
  learningProposalSchema,
  memoryReviewInputSchema,
  type AutoMemoryReviewPolicy,
  type CognitionDependency,
  type CoverageLedger,
  type EligibleLearningSource,
  type ExtractionChunk as PersistedExtractionChunk,
  type MemoryReviewInput,
  type ReviewBundle
} from "@vc-agent/contracts";
import type { CognitionReviewModule } from "@vc-agent/contracts";
import { selectEligibleLearningSources, type EligibilitySelectionInput } from "./eligibility.js";
import { applyCoverageDispositions, assertCoverageComplete, createCoverageLedger, projectCoverageSummary } from "./coverage-ledger.js";
import {
  buildMemoryReviewChunks,
  type ChunkingOptions,
  type ExtractionChunk,
  type MemoryReviewChunkInput,
  type MemoryReviewSourceBody
} from "./chunking.js";
import { executeMemoryReviewExtraction, validateMemoryReviewExtraction, type MemoryReviewExtractionResult } from "./memory-review-extraction.js";
import {
  buildMemoryReviewSynthesisInput,
  type MemoryReviewSynthesisBuildInput,
  type MemoryReviewSynthesisCard,
  type MemoryReviewSynthesisInput,
  type MemoryReviewSynthesisResult
} from "./memory-review-synthesis.js";
import { executeMemoryReviewSynthesis } from "./memory-review-synthesis.js";
import {
  evaluateAutomaticMemoryReview,
  type AutomaticMemoryReviewDecision,
  type AutomaticMemoryReviewEvaluationOptions
} from "./automatic-review.js";

const RUN_SCHEMA_VERSION = 1 as const;

export type MemoryReviewPreparationStatus = "preparing" | "waiting_for_review" | "completed" | "failed" | "cancelled";
export type MemoryReviewPreparationMode = "manual" | "automatic";

/** Allowlisted, content-free Profile identity frozen for one run. */
export const memoryReviewProfileSnapshotSchema = z.object({
  id: z.string().min(1).max(200),
  provider: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  thinkingLevel: z.string().min(1).max(100).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional()
}).strict();
export type MemoryReviewProfileSnapshot = z.infer<typeof memoryReviewProfileSnapshotSchema>;

/** Prompt identity only; prompt text is never persisted in a run record. */
export const memoryReviewPromptSnapshotSchema = z.object({
  revisionId: z.string().min(1).max(200),
  hash: z.string().regex(/^[a-f0-9]{64}$/iu)
}).strict();
export type MemoryReviewPromptSnapshot = z.infer<typeof memoryReviewPromptSnapshotSchema>;

/** Content-free bounded progress for Renderer/telemetry projections. */
export interface MemoryReviewProgress {
  readonly batchId: string;
  readonly reviewId?: string;
  readonly status: MemoryReviewPreparationStatus;
  readonly eligible: number;
  readonly processed: number;
  readonly noSignal: number;
  readonly represented: number;
  readonly carriedOver: number;
  readonly completedChunks: number;
  readonly totalChunks: number;
  readonly failureCode?: string;
}

export interface MemoryReviewChunkingOptions extends Omit<ChunkingOptions, "resolveSource" | "now" | "budgetService"> {
  readonly contextWindowTokens?: number;
  readonly reservedOutputTokens?: number;
}

export interface MemoryReviewPreparationInput {
  readonly batchId?: string;
  readonly cutoff: string;
  /** Sources are references only; optional body values are transient build input. */
  readonly sources?: readonly MemoryReviewChunkInput[];
  readonly eligibility?: EligibilitySelectionInput;
  readonly profileSnapshot: MemoryReviewProfileSnapshot;
  readonly promptSnapshot?: MemoryReviewPromptSnapshot;
  readonly dependencies?: readonly CognitionDependency[];
  readonly projectMemoryCards?: readonly MemoryReviewSynthesisCard[];
  readonly longTermMemoryCards?: readonly MemoryReviewSynthesisCard[];
  readonly chunking?: MemoryReviewChunkingOptions;
}

export interface AutomaticMemoryReviewPreparationInput extends MemoryReviewPreparationInput {
  readonly policy: AutoMemoryReviewPolicy;
  readonly profileAvailable?: boolean;
  readonly activeBatch?: boolean;
  readonly bundleUnderReview?: boolean;
  readonly lastAutomaticStartAt?: string | Date;
  readonly pendingEligibleExchangeCount?: number;
  readonly explicitCandidate?: boolean;
  readonly lastReviewCompletedAt?: string | Date;
  readonly phase?: "startup" | "post_user_work";
  readonly userWorkCompletedInAppRun?: boolean;
  readonly executionIdle?: boolean;
  readonly timeZone?: string;
}

export interface MemoryReviewPreparationResult extends MemoryReviewRunRecord {}

export interface AutomaticMemoryReviewPreparationResult {
  readonly decision: AutomaticMemoryReviewDecision;
  readonly run?: MemoryReviewPreparationResult;
}

export interface MemoryReviewExtractionRunnerInput {
  readonly batchId: string;
  readonly mode: MemoryReviewPreparationMode;
  readonly chunk: ExtractionChunk;
  readonly profileSnapshot: MemoryReviewProfileSnapshot;
  readonly promptSnapshot?: MemoryReviewPromptSnapshot;
}

export type MemoryReviewExtractionRunner = (input: MemoryReviewExtractionRunnerInput) => MemoryReviewExtractionResult | Promise<MemoryReviewExtractionResult>;

export interface MemoryReviewSynthesisRunnerInput {
  readonly batchId: string;
  readonly mode: MemoryReviewPreparationMode;
  readonly input: MemoryReviewSynthesisInput;
  readonly profileSnapshot: MemoryReviewProfileSnapshot;
  readonly promptSnapshot?: MemoryReviewPromptSnapshot;
}

export type MemoryReviewSynthesisRunner = (input: MemoryReviewSynthesisRunnerInput) => MemoryReviewSynthesisResult | Promise<MemoryReviewSynthesisResult>;

export interface MemoryReviewRunRecord {
  readonly schemaVersion: typeof RUN_SCHEMA_VERSION;
  readonly batchId: string;
  readonly mode: MemoryReviewPreparationMode;
  readonly status: MemoryReviewPreparationStatus;
  readonly cutoff: string;
  readonly sources: readonly EligibleLearningSource[];
  readonly ledger: CoverageLedger;
  readonly chunks: readonly PersistedExtractionChunk[];
  readonly extractionResults: readonly MemoryReviewExtractionResult[];
  readonly profileSnapshot: MemoryReviewProfileSnapshot;
  readonly promptSnapshot?: MemoryReviewPromptSnapshot;
  readonly dependencies: readonly CognitionDependency[];
  readonly projectMemoryCards: readonly MemoryReviewSynthesisCard[];
  readonly longTermMemoryCards: readonly MemoryReviewSynthesisCard[];
  readonly chunking: PersistedChunkingOptions;
  readonly reviewId?: string;
  readonly failureCode?: string;
  readonly cancelRequested: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PersistedChunkingOptions {
  readonly contextWindowTokens?: number;
  readonly reservedOutputTokens?: number;
  readonly systemPrompt?: string;
  readonly toolSchema?: string;
  readonly stageInstructions?: string;
  readonly outputSchema?: string;
}

/** Durable adapter used by orchestration. The file adapter below is the production default seam. */
export interface MemoryReviewRunStore {
  load(batchId: string): MemoryReviewRunRecord | undefined;
  save(record: MemoryReviewRunRecord): void;
  list(): readonly MemoryReviewRunRecord[];
  remove?(batchId: string): void;
}

/**
 * Small atomic JSON adapter. It stores only bounded references/results and no
 * Thread Trajectory bodies. A CognitionReviewStore work directory can be
 * passed as the parent path by the desktop Host.
 */
export class FileMemoryReviewRunStore implements MemoryReviewRunStore {
  readonly #root: string;

  constructor(root: string) {
    if (!root.trim()) throw new Error("Memory Review run store root is required.");
    this.#root = root;
  }

  load(batchId: string): MemoryReviewRunRecord | undefined {
    const path = this.#path(batchId);
    if (!existsSync(path)) return undefined;
    return parseRun(JSON.parse(readFileSync(path, "utf8")));
  }

  save(record: MemoryReviewRunRecord): void {
    const parsed = parseRun(record);
    mkdirSync(this.#root, { recursive: true });
    const path = this.#path(parsed.batchId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    try { renameSync(temporary, path); }
    catch (error) { rmSync(temporary, { force: true }); throw error; }
  }

  list(): readonly MemoryReviewRunRecord[] {
    if (!existsSync(this.#root)) return [];
    return readdirSync(this.#root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .flatMap((entry) => {
        try { return [parseRun(JSON.parse(readFileSync(join(this.#root, entry.name), "utf8")))]; }
        catch { return []; }
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.batchId.localeCompare(right.batchId));
  }

  remove(batchId: string): void { rmSync(this.#path(batchId), { force: true }); }

  #path(batchId: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(batchId)) throw new Error("Memory Review batch id contains unsupported path characters.");
    return join(this.#root, `${batchId}.json`);
  }
}

export interface MemoryReviewOrchestratorOptions {
  readonly persistence: MemoryReviewRunStore;
  readonly reviewModule: CognitionReviewModule;
  readonly extractChunk: MemoryReviewExtractionRunner;
  readonly synthesize: MemoryReviewSynthesisRunner;
  readonly resolveSource?: (source: EligibleLearningSource) => MemoryReviewSourceBody | undefined | Promise<MemoryReviewSourceBody | undefined>;
  readonly onProgress?: (progress: MemoryReviewProgress) => void;
  readonly now?: () => Date;
  readonly createBatchId?: () => string;
  readonly automaticNow?: AutomaticMemoryReviewEvaluationOptions;
}

/** Context supplied to the Host-owned model adapter by the production factory. */
export interface MemoryReviewGenerationContext {
  readonly batchId: string;
  readonly mode: MemoryReviewPreparationMode;
  readonly stage: "extraction" | "synthesis";
  readonly workerKey: string;
  readonly profileSnapshot: MemoryReviewProfileSnapshot;
  readonly promptSnapshot?: MemoryReviewPromptSnapshot;
}

/**
 * The factory accepts one generation seam for both bounded model stages.  A
 * caller that only needs the prompt can ignore the second argument; the
 * Host's production adapter uses the frozen run context to select a worker.
 */
export type MemoryReviewGenerator = (prompt: string, context: MemoryReviewGenerationContext) => string | Promise<string>;

export interface CreateMemoryReviewOrchestratorOptions extends Omit<MemoryReviewOrchestratorOptions, "persistence" | "extractChunk" | "synthesize"> {
  /** Parent Cognition Review root. Runs are stored below `<root>/runs`. */
  readonly root: string;
  /** Override the default `<root>/runs` location for tests or migrations. */
  readonly runRoot?: string;
  readonly generate: MemoryReviewGenerator;
}

/**
 * Shared manual/automatic Memory Review preparation path. It owns no commit
 * operation: the resulting Review Bundle must go through the Cognition Review
 * Module's explicit decide/commit seam later.
 */
export class MemoryReviewOrchestrator {
  readonly #persistence: MemoryReviewRunStore;
  readonly #reviewModule: CognitionReviewModule;
  readonly #extractChunk: MemoryReviewExtractionRunner;
  readonly #synthesize: MemoryReviewSynthesisRunner;
  readonly #resolveSource: (source: EligibleLearningSource) => MemoryReviewSourceBody | undefined | Promise<MemoryReviewSourceBody | undefined>;
  readonly #onProgress: ((progress: MemoryReviewProgress) => void) | undefined;
  readonly #now: () => Date;
  readonly #createBatchId: () => string;
  readonly #automaticNow: AutomaticMemoryReviewEvaluationOptions;

  constructor(options: MemoryReviewOrchestratorOptions) {
    this.#persistence = options.persistence;
    this.#reviewModule = options.reviewModule;
    this.#extractChunk = options.extractChunk;
    this.#synthesize = options.synthesize;
    this.#resolveSource = options.resolveSource ?? (() => undefined);
    this.#onProgress = options.onProgress;
    this.#now = options.now ?? (() => new Date());
    this.#createBatchId = options.createBatchId ?? randomUUID;
    this.#automaticNow = options.automaticNow ?? { now: this.#now };
  }

  /** Read-only projection used by Host scheduling and recovery. */
  listRuns(): readonly MemoryReviewRunRecord[] {
    return this.#persistence.list();
  }

  /**
   * Mark the preparation run represented by a committed Review Bundle as
   * terminal.  Bundle authority remains in CognitionReviewModule; this only
   * updates the bounded preparation projection.
   */
  completeReview(reviewId: string): MemoryReviewPreparationResult | undefined {
    return this.#finishReview(reviewId, "completed");
  }

  /** Mark a discarded Review Bundle's preparation projection as cancelled. */
  discardReview(reviewId: string): MemoryReviewPreparationResult | undefined {
    return this.#finishReview(reviewId, "cancelled");
  }

  /** Prepare a manual Memory Review through the same path used by automatic work. */
  async prepare(input: MemoryReviewPreparationInput): Promise<MemoryReviewPreparationResult> {
    return this.#prepareCommon(input, "manual");
  }

  /**
   * Evaluate the model-free admission gate, then use the exact same
   * preparation path. A non-admitted result never creates a batch or calls a
   * model runner.
   */
  async prepareAutomatically(input: AutomaticMemoryReviewPreparationInput): Promise<AutomaticMemoryReviewPreparationResult> {
    const policy = autoMemoryReviewPolicySchema.parse(input.policy);
    const profileSnapshotResult = memoryReviewProfileSnapshotSchema.safeParse(input.profileSnapshot);
    const configuredProfileId = (policy as AutoMemoryReviewPolicy & { readonly profileId?: string }).profileId;
    const profileMatchesAssignment = profileSnapshotResult.success && (configuredProfileId === undefined || profileSnapshotResult.data.id === configuredProfileId);
    const decision = evaluateAutomaticMemoryReview({
      policy,
      profileAvailable: input.profileAvailable === true && profileMatchesAssignment,
      activeBatch: input.activeBatch ?? this.#hasActiveBatch(),
      ...(input.bundleUnderReview === undefined ? {} : { bundleUnderReview: input.bundleUnderReview }),
      ...(input.lastAutomaticStartAt === undefined ? {} : { lastAutomaticStartAt: input.lastAutomaticStartAt }),
      ...(input.pendingEligibleExchangeCount === undefined && input.sources === undefined ? {} : { pendingEligibleExchangeCount: input.pendingEligibleExchangeCount ?? input.sources?.length ?? 0 }),
      ...(input.explicitCandidate === undefined ? {} : { explicitCandidate: input.explicitCandidate }),
      ...(input.lastReviewCompletedAt === undefined ? {} : { lastReviewCompletedAt: input.lastReviewCompletedAt }),
      ...(input.phase === undefined ? {} : { phase: input.phase }),
      ...(input.userWorkCompletedInAppRun === undefined ? {} : { userWorkCompletedInAppRun: input.userWorkCompletedInAppRun }),
      ...(input.executionIdle === undefined ? {} : { executionIdle: input.executionIdle })
    }, {
      ...this.#automaticNow,
      now: this.#automaticNow.now,
      ...(input.timeZone === undefined && this.#automaticNow.timeZone === undefined ? {} : { timeZone: input.timeZone ?? this.#automaticNow.timeZone })
    });
    if (!decision.admitted) return { decision };
    const maxInputTokens = policy.maxInputTokensPerRun;
    const automaticInput: MemoryReviewPreparationInput = {
      ...input,
      ...(input.chunking === undefined ? { chunking: { contextWindowTokens: maxInputTokens } } : {
        chunking: {
          ...input.chunking,
          ...(input.chunking.contextWindowTokens === undefined ? { contextWindowTokens: maxInputTokens } : { contextWindowTokens: Math.min(input.chunking.contextWindowTokens, maxInputTokens) })
        }
      })
    };
    return { decision, run: await this.#prepareCommon(automaticInput, "automatic") };
  }

  /** Resume a failed/interrupted run. Completed chunks remain untouched. */
  async resume(batchId: string, options: { readonly retryFailed?: boolean } = {}): Promise<MemoryReviewPreparationResult> {
    const current = this.#requireRun(batchId);
    if (current.status === "waiting_for_review" || current.status === "completed") return current;
    if ((current.status === "failed" || current.status === "cancelled") && options.retryFailed !== true) return current;
    const reset = options.retryFailed === true ? resetRunForRetry(current, this.#now().toISOString()) : current;
    this.#persistence.save(reset);
    let runtimeChunks: ExtractionChunk[];
    try { runtimeChunks = await this.#rebuildRuntimeChunks(reset); }
    catch (error) { return this.#finishFailure(reset, classifyFailure(error, "CHUNK_PLAN_CHANGED")); }
    return this.#execute(reset, runtimeChunks);
  }

  /** Request cancellation; an in-flight model call is allowed to reach its boundary. */
  cancel(batchId: string): MemoryReviewPreparationResult {
    const current = this.#requireRun(batchId);
    if (["waiting_for_review", "completed", "failed", "cancelled"].includes(current.status)) return current;
    const updated = cloneRun({ ...current, cancelRequested: true, updatedAt: this.#now().toISOString() });
    this.#persistence.save(updated);
    this.#emit(updated);
    return updated;
  }

  #prepareCommon(input: MemoryReviewPreparationInput, mode: MemoryReviewPreparationMode): Promise<MemoryReviewPreparationResult> {
    return this.#prepareCommonAsync(input, mode);
  }

  async #prepareCommonAsync(input: MemoryReviewPreparationInput, mode: MemoryReviewPreparationMode): Promise<MemoryReviewPreparationResult> {
    if (this.#hasActiveBatch()) throw new Error("MEMORY_REVIEW_ACTIVE_BATCH");
    const now = this.#now().toISOString();
    const batchId = input.batchId ?? this.#createBatchId();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(batchId)) throw new Error("MEMORY_REVIEW_BATCH_ID_INVALID");
    if (this.#persistence.load(batchId) !== undefined) throw new Error("MEMORY_REVIEW_BATCH_EXISTS");
    const sourceInputs = this.#selectSources(input);
    const profileSnapshot = memoryReviewProfileSnapshotSchema.parse(input.profileSnapshot);
    const promptSnapshot = input.promptSnapshot === undefined ? undefined : memoryReviewPromptSnapshotSchema.parse(input.promptSnapshot);
    const sources = sourceInputs.map((source) => eligibleLearningSourceSchema.parse(stripBody(source)));
    const seen = new Set<string>();
    for (const source of sources) {
      if (seen.has(source.sourceReference)) throw new Error("MEMORY_REVIEW_DUPLICATE_SOURCE");
      seen.add(source.sourceReference);
      if (new Date(source.completedAt).valueOf() > new Date(input.cutoff).valueOf()) throw new Error("MEMORY_REVIEW_SOURCE_AFTER_CUTOFF");
    }
    const materialized = await Promise.all(sourceInputs.filter((source) => source.availability !== "deleted").map(async (source) => {
      const body = source.body ?? await this.#resolveSource(source);
      return body === undefined ? { ...source } : { ...source, body };
    }));
    const chunking = persistChunkingOptions(input.chunking);
    const runtimeChunks = materialized.length === 0 ? [] : buildMemoryReviewChunks(materialized, {
      ...input.chunking,
      ...chunking,
      ...(promptSnapshot === undefined ? {} : { promptSnapshot: cloneJson(promptSnapshot) }),
      profileSnapshot: cloneJson(profileSnapshot),
      projectMemory: input.chunking?.projectMemory
    });
    let ledger = createCoverageLedger({ batchId, cutoff: input.cutoff, sources: sources.map(toCoverageSource), createdAt: now });
    const deletedSources = sources.filter((source) => source.availability === "deleted");
    if (deletedSources.length > 0) {
      ledger = applyCoverageDispositions(ledger, deletedSources.map((source) => ({
        sourceReference: source.sourceReference,
        status: "carried_over" as const,
        reason: "source_deleted"
      })), { updatedAt: now });
    }
    const record = cloneRun({
      schemaVersion: RUN_SCHEMA_VERSION,
      batchId,
      mode,
      status: "preparing",
      cutoff: input.cutoff,
      sources,
      ledger,
      chunks: runtimeChunks.map(toPersistedChunk),
      extractionResults: [],
      profileSnapshot: cloneJson(profileSnapshot),
      ...(promptSnapshot === undefined ? {} : { promptSnapshot: cloneJson(promptSnapshot) }),
      dependencies: [...(input.dependencies ?? [])],
      projectMemoryCards: [...(input.projectMemoryCards ?? [])].map((card) => cloneJson(card)),
      longTermMemoryCards: [...(input.longTermMemoryCards ?? [])].map((card) => cloneJson(card)),
      chunking,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now
    });
    this.#persistence.save(record);
    this.#emit(record);
    return this.#execute(record, runtimeChunks);
  }

  async #execute(initial: MemoryReviewRunRecord, runtimeChunks?: readonly ExtractionChunk[]): Promise<MemoryReviewPreparationResult> {
    let current = this.#requireRun(initial.batchId);
    const runtime = runtimeChunks ?? await this.#rebuildRuntimeChunks(current);
    const runtimeById = new Map(runtime.map((chunk) => [chunk.id, chunk]));
    for (const persisted of current.chunks) {
      if (persisted.status === "completed") continue;
      if (current.cancelRequested) return this.#finishCancelled(current);
      const chunk = runtimeById.get(persisted.id);
      if (chunk === undefined) return this.#finishFailure(current, "CHUNK_PLAN_CHANGED");
      const processing = cloneRun({
        ...current,
        chunks: current.chunks.map((candidate) => candidate.id === persisted.id ? { ...candidate, status: "processing" as const, attemptCount: candidate.attemptCount + 1, updatedAt: this.#now().toISOString() } : candidate),
        updatedAt: this.#now().toISOString()
      });
      current = processing;
      this.#persistence.save(current);
      this.#emit(current);
      try {
        const result = await this.#extractChunk({
          batchId: current.batchId,
          mode: current.mode,
          chunk,
          profileSnapshot: current.profileSnapshot,
          ...(current.promptSnapshot === undefined ? {} : { promptSnapshot: current.promptSnapshot })
        });
        if (current.cancelRequested || this.#requireRun(current.batchId).cancelRequested) return this.#finishCancelled(this.#requireRun(current.batchId));
        const validated = validateMemoryReviewExtraction(result, chunk, { validProposalIds: result.candidates.map((candidate) => candidate.id) });
        const ledger = applyCoverageDispositions(current.ledger, validated.dispositions, { proposalIds: validated.candidates.map((candidate) => candidate.id), updatedAt: this.#now().toISOString() });
        current = cloneRun({
          ...current,
          ledger,
          extractionResults: [...current.extractionResults.filter((candidate) => candidate.chunkId !== validated.chunkId), validated],
          chunks: current.chunks.map((candidate) => candidate.id === persisted.id ? { ...candidate, status: "completed" as const, completedAt: validated.completedAt, updatedAt: this.#now().toISOString(), failureCode: undefined } : candidate),
          updatedAt: this.#now().toISOString()
        });
        this.#persistence.save(current);
        this.#emit(current);
      } catch (error) {
        return this.#finishFailure(current, classifyFailure(error, "EXTRACTION_VALIDATION_FAILED"));
      }
    }

    if (current.cancelRequested || this.#requireRun(current.batchId).cancelRequested) return this.#finishCancelled(this.#requireRun(current.batchId));
    try {
      const coverage = assertCoverageComplete(current.ledger);
      const synthesisInput = buildMemoryReviewSynthesisInput({
        batchId: current.batchId,
        cutoff: current.cutoff,
        coverage: current.ledger,
        extractionResults: current.extractionResults,
        projectMemoryCards: current.projectMemoryCards,
        longTermMemoryCards: current.longTermMemoryCards,
        promptSnapshot: current.promptSnapshot,
        profileSnapshot: current.profileSnapshot
      } satisfies MemoryReviewSynthesisBuildInput);
      const synthesis = await this.#synthesize({
        batchId: current.batchId,
        mode: current.mode,
        input: synthesisInput,
        profileSnapshot: current.profileSnapshot,
        ...(current.promptSnapshot === undefined ? {} : { promptSnapshot: current.promptSnapshot })
      });
      if (current.cancelRequested || this.#requireRun(current.batchId).cancelRequested) return this.#finishCancelled(this.#requireRun(current.batchId));
      const proposals = synthesis.proposals.map((proposal) => learningProposalSchema.parse(proposal));
      validateSynthesisProposals(current.ledger, proposals);
      const finalLedger = remapSynthesisCoverage(current.ledger, proposals, this.#now().toISOString());
      assertCoverageComplete(finalLedger);
      const reviewInput = memoryReviewInputSchema.parse({
        kind: "memory_review",
        cutoff: current.cutoff,
        sources: current.sources,
        coverageLedger: finalLedger,
        proposals,
        dependencies: current.dependencies,
        batchId: current.batchId
      });
      const bundle = this.#reviewModule.prepare(reviewInput);
      current = cloneRun({ ...current, status: "waiting_for_review", reviewId: bundle.id, ledger: finalLedger, updatedAt: this.#now().toISOString() });
      this.#persistence.save(current);
      this.#emit(current);
      void coverage;
      return current;
    } catch (error) {
      return this.#finishFailure(current, classifyFailure(error, "SYNTHESIS_VALIDATION_FAILED"));
    }
  }

  #selectSources(input: MemoryReviewPreparationInput): MemoryReviewChunkInput[] {
    if (input.sources !== undefined) return [...input.sources];
    if (input.eligibility === undefined) throw new Error("MEMORY_REVIEW_SOURCES_REQUIRED");
    return selectEligibleLearningSources(input.eligibility);
  }

  async #rebuildRuntimeChunks(run: MemoryReviewRunRecord): Promise<ExtractionChunk[]> {
    const sourceInputs = await Promise.all(run.sources.filter((source) => source.availability !== "deleted").map(async (source) => {
      const body = await this.#resolveSource(source);
      return body === undefined ? { ...source } : { ...source, body };
    }));
    const runtime = sourceInputs.length === 0 ? [] : buildMemoryReviewChunks(sourceInputs, {
      ...run.chunking,
      promptSnapshot: run.promptSnapshot,
      profileSnapshot: run.profileSnapshot
    });
    const persistedById = new Map(run.chunks.map((chunk) => [chunk.id, chunk]));
    if (runtime.length !== run.chunks.length || runtime.some((chunk) => {
      const persisted = persistedById.get(chunk.id);
      return persisted === undefined || persisted.inputHash !== chunk.inputHash || persisted.sourceReferences.join("\u0000") !== chunk.sourceReferences.join("\u0000");
    })) throw new Error("CHUNK_PLAN_CHANGED");
    return runtime;
  }

  #finishFailure(current: MemoryReviewRunRecord, failureCode: string): MemoryReviewPreparationResult {
    const updated = cloneRun({ ...current, status: "failed", failureCode, cancelRequested: false, updatedAt: this.#now().toISOString() });
    this.#persistence.save(updated);
    this.#emit(updated);
    return updated;
  }

  #finishCancelled(current: MemoryReviewRunRecord): MemoryReviewPreparationResult {
    const updated = cloneRun({ ...current, status: "cancelled", cancelRequested: false, updatedAt: this.#now().toISOString() });
    this.#persistence.save(updated);
    this.#emit(updated);
    return updated;
  }

  #requireRun(batchId: string): MemoryReviewRunRecord {
    const run = this.#persistence.load(batchId);
    if (run === undefined) throw new Error("MEMORY_REVIEW_BATCH_NOT_FOUND");
    return run;
  }

  #hasActiveBatch(): boolean {
    return this.#persistence.list().some((run) => run.status === "preparing" || run.status === "waiting_for_review");
  }

  #finishReview(reviewId: string, status: "completed" | "cancelled"): MemoryReviewPreparationResult | undefined {
    const current = this.#persistence.list().find((run) => run.reviewId === reviewId);
    if (current === undefined) return undefined;
    if (current.status === "completed" || current.status === "cancelled") return current;
    if (current.status !== "waiting_for_review") {
      throw new Error("MEMORY_REVIEW_REVIEW_NOT_TERMINAL");
    }
    const updated = cloneRun({ ...current, status, cancelRequested: false, updatedAt: this.#now().toISOString() });
    this.#persistence.save(updated);
    this.#emit(updated);
    return updated;
  }

  #emit(run: MemoryReviewRunRecord): void {
    if (this.#onProgress === undefined) return;
    const summary = projectCoverageSummary(run.ledger);
    const progress: MemoryReviewProgress = {
      batchId: run.batchId,
      ...(run.reviewId === undefined ? {} : { reviewId: run.reviewId }),
      status: run.status,
      eligible: summary.eligibleCount,
      processed: summary.noSignalCount + summary.representedCount + summary.carriedOverCount,
      noSignal: summary.noSignalCount,
      represented: summary.representedCount,
      carriedOver: summary.carriedOverCount,
      completedChunks: run.chunks.filter((chunk) => chunk.status === "completed").length,
      totalChunks: run.chunks.length,
      ...(run.failureCode === undefined ? {} : { failureCode: run.failureCode })
    };
    try { this.#onProgress(progress); } catch { /* Progress observers cannot alter cognition state. */ }
  }
}

/**
 * Production composition seam for Memory Review.  The file run store and the
 * extraction/synthesis prompt adapters stay behind this factory so Host code
 * crosses one narrow orchestration interface.
 */
export function createMemoryReviewOrchestrator(options: CreateMemoryReviewOrchestratorOptions): MemoryReviewOrchestrator {
  if (!options.root.trim()) throw new Error("Memory Review root is required.");
  const persistence = new FileMemoryReviewRunStore(options.runRoot ?? join(options.root, "runs"));
  const now = options.now;
  return new MemoryReviewOrchestrator({
    ...options,
    persistence,
    extractChunk: async (input) => executeMemoryReviewExtraction({
      chunk: input.chunk,
      ...(options.resolveSource === undefined ? {} : {
        resolveSource: (sourceReference) => {
          const source = input.chunk.sources.find((candidate) => candidate.sourceReference === sourceReference);
          return source === undefined ? undefined : options.resolveSource!(source);
        }
      }),
      generate: (prompt) => options.generate(prompt, {
        batchId: input.batchId,
        mode: input.mode,
        stage: "extraction",
        workerKey: input.chunk.id,
        profileSnapshot: input.profileSnapshot,
        ...(input.promptSnapshot === undefined ? {} : { promptSnapshot: input.promptSnapshot })
      }),
      ...(now === undefined ? {} : { now: now().toISOString() })
    }),
    synthesize: async (input) => executeMemoryReviewSynthesis({
      input: input.input,
      generate: (prompt) => options.generate(prompt, {
        batchId: input.batchId,
        mode: input.mode,
        stage: "synthesis",
        workerKey: "synthesis",
        profileSnapshot: input.profileSnapshot,
        ...(input.promptSnapshot === undefined ? {} : { promptSnapshot: input.promptSnapshot })
      }),
      ...(now === undefined ? {} : { now: now().toISOString() })
    })
  });
}

function persistChunkingOptions(options: MemoryReviewChunkingOptions | undefined): PersistedChunkingOptions {
  return {
    ...(options?.contextWindowTokens === undefined ? {} : { contextWindowTokens: options.contextWindowTokens }),
    ...(options?.reservedOutputTokens === undefined ? {} : { reservedOutputTokens: options.reservedOutputTokens }),
    ...(options?.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    ...(options?.toolSchema === undefined ? {} : { toolSchema: options.toolSchema }),
    ...(options?.stageInstructions === undefined ? {} : { stageInstructions: options.stageInstructions }),
    ...(options?.outputSchema === undefined ? {} : { outputSchema: options.outputSchema })
  };
}

function toPersistedChunk(chunk: ExtractionChunk): PersistedExtractionChunk {
  return extractionChunkSchema.parse({
    schemaVersion: 1,
    id: chunk.id,
    scope: chunk.scope,
    ...(chunk.projectId === undefined ? {} : { projectId: chunk.projectId }),
    ...(chunk.threadId === undefined ? {} : { threadId: chunk.threadId }),
    sourceReferences: chunk.sourceReferences,
    inputHash: chunk.inputHash,
    status: chunk.status,
    attemptCount: chunk.attemptCount,
    createdAt: chunk.createdAt,
    updatedAt: chunk.updatedAt,
    ...(chunk.completedAt === undefined ? {} : { completedAt: chunk.completedAt }),
    ...(chunk.failureCode === undefined ? {} : { failureCode: chunk.failureCode })
  });
}

function toCoverageSource(source: EligibleLearningSource): {
  readonly sourceReference: string;
  readonly sourceKind: EligibleLearningSource["sourceKind"];
  readonly scope: EligibleLearningSource["scope"];
  readonly projectId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly sourceVersion?: string;
  readonly completedAt: string;
  readonly availability?: EligibleLearningSource["availability"];
} {
  return {
    sourceReference: source.sourceReference,
    sourceKind: source.sourceKind,
    scope: source.scope,
    ...(source.projectId === undefined ? {} : { projectId: source.projectId }),
    ...(source.threadId === undefined ? {} : { threadId: source.threadId }),
    ...(source.turnId === undefined ? {} : { turnId: source.turnId }),
    ...(source.sourceVersion === undefined ? {} : { sourceVersion: source.sourceVersion }),
    completedAt: source.completedAt,
    ...(source.availability === undefined ? {} : { availability: source.availability })
  };
}

function resetRunForRetry(current: MemoryReviewRunRecord, updatedAt: string): MemoryReviewRunRecord {
  const { failureCode: _failureCode, ...withoutFailure } = current;
  return cloneRun({
    ...withoutFailure,
    status: "preparing",
    cancelRequested: false,
    chunks: current.chunks.map((chunk) => {
      if (!["failed", "interrupted", "processing"].includes(chunk.status)) return chunk;
      const { failureCode: _chunkFailure, completedAt: _completedAt, ...withoutChunkFailure } = chunk;
      return { ...withoutChunkFailure, status: "pending" as const, updatedAt };
    }),
    updatedAt
  });
}

function remapSynthesisCoverage(ledger: CoverageLedger, proposals: readonly ReturnType<typeof learningProposalSchema.parse>[], updatedAt: string): CoverageLedger {
  const bySource = new Map<string, string[]>();
  for (const proposal of proposals) {
    for (const sourceReference of proposal.sourceReferences) {
      const ids = bySource.get(sourceReference) ?? [];
      if (!ids.includes(proposal.id)) ids.push(proposal.id);
      bySource.set(sourceReference, ids);
    }
  }
  return coverageLedgerSchema.parse({
    ...ledger,
    entries: ledger.entries.map((entry) => {
      if (entry.status !== "represented") return { ...entry, updatedAt };
      const proposalIds = bySource.get(entry.sourceReference) ?? [];
      return proposalIds.length > 0
        ? { ...entry, proposalIds, updatedAt }
        : { ...entry, status: "carried_over" as const, proposalIds: [], dispositionReason: "synthesis_candidate_not_retained", updatedAt };
    }),
    updatedAt
  });
}

function validateSynthesisProposals(ledger: CoverageLedger, proposals: readonly ReturnType<typeof learningProposalSchema.parse>[]): void {
  const entries = new Map(ledger.entries.map((entry) => [entry.sourceReference, entry]));
  const seen = new Set<string>();
  for (const proposal of proposals) {
    if (seen.has(proposal.id)) throw new Error("MEMORY_REVIEW_DUPLICATE_PROPOSAL");
    seen.add(proposal.id);
    const sourceEntries = proposal.sourceReferences.map((reference) => {
      const entry = entries.get(reference);
      if (entry === undefined) throw new Error("MEMORY_REVIEW_PROPOSAL_SOURCE_OUTSIDE_LEDGER");
      if (entry.status !== "represented") throw new Error("MEMORY_REVIEW_PROPOSAL_SOURCE_NOT_REPRESENTED");
      return entry;
    });
    if (proposal.destination === "project_memory") {
      if (sourceEntries.length === 0 || sourceEntries.some((entry) => entry.scope !== "project") || new Set(sourceEntries.map((entry) => entry.projectId)).size !== 1) {
        throw new Error("MEMORY_REVIEW_PROJECT_SCOPE_INVALID");
      }
    }
  }
}

function stripBody(source: MemoryReviewChunkInput): EligibleLearningSource {
  const { body: _body, ...reference } = source;
  return eligibleLearningSourceSchema.parse(reference);
}

function classifyFailure(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (/^MEMORY_REVIEW_[A-Z0-9_]+$/u.test(message) || /^CHUNK_PLAN_CHANGED$/u.test(message)) return message;
  if (fallback === "EXTRACTION_VALIDATION_FAILED" && /(?:outside|omitted|duplicate|represented|disposition|chunk result)/iu.test(message)) return "EXTRACTION_VALIDATION_FAILED";
  return "MODEL_EXECUTION_FAILED";
}

function cloneRun(run: MemoryReviewRunRecord): MemoryReviewRunRecord {
  return JSON.parse(JSON.stringify(run)) as MemoryReviewRunRecord;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseRun(value: unknown): MemoryReviewRunRecord {
  if (value === null || typeof value !== "object") throw new Error("Invalid Memory Review run record.");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RUN_SCHEMA_VERSION || typeof record.batchId !== "string" || typeof record.cutoff !== "string") throw new Error("Invalid Memory Review run record.");
  const sources = Array.isArray(record.sources) ? record.sources.map((source) => eligibleLearningSourceSchema.parse(source)) : (() => { throw new Error("Invalid Memory Review run sources."); })();
  const ledger = coverageLedgerSchema.parse(record.ledger);
  const chunks = Array.isArray(record.chunks) ? record.chunks.map((chunk) => extractionChunkSchema.parse(chunk)) : (() => { throw new Error("Invalid Memory Review run chunks."); })();
  if (!Array.isArray(record.extractionResults)) throw new Error("Invalid Memory Review extraction results.");
  const extractionResults = record.extractionResults.map((result) => {
    if (result === null || typeof result !== "object") throw new Error("Invalid Memory Review extraction result.");
    const raw = result as MemoryReviewExtractionResult;
    const chunk = chunks.find((candidate) => candidate.id === raw.chunkId);
    if (chunk === undefined) throw new Error("Memory Review extraction result references an unknown chunk.");
    return validateMemoryReviewExtraction(raw, chunk, { validProposalIds: Array.isArray(raw.candidates) ? raw.candidates.map((candidate) => candidate.id) : [] });
  });
  const profileSnapshot = memoryReviewProfileSnapshotSchema.parse(record.profileSnapshot);
  const promptSnapshot = record.promptSnapshot === undefined ? undefined : memoryReviewPromptSnapshotSchema.parse(record.promptSnapshot);
  const dependencies = Array.isArray(record.dependencies) ? record.dependencies.map((dependency) => cognitionDependencySchema.parse(dependency)) : [];
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    batchId: record.batchId,
    mode: record.mode === "automatic" ? "automatic" : "manual",
    status: record.status === "waiting_for_review" || record.status === "completed" || record.status === "failed" || record.status === "cancelled" ? record.status : "preparing",
    cutoff: record.cutoff,
    sources,
    ledger,
    chunks,
    extractionResults,
    profileSnapshot,
    ...(promptSnapshot === undefined ? {} : { promptSnapshot }),
    dependencies,
    projectMemoryCards: Array.isArray(record.projectMemoryCards) ? record.projectMemoryCards as MemoryReviewSynthesisCard[] : [],
    longTermMemoryCards: Array.isArray(record.longTermMemoryCards) ? record.longTermMemoryCards as MemoryReviewSynthesisCard[] : [],
    chunking: (record.chunking ?? {}) as PersistedChunkingOptions,
    ...(typeof record.reviewId === "string" ? { reviewId: record.reviewId } : {}),
    ...(typeof record.failureCode === "string" ? { failureCode: record.failureCode } : {}),
    cancelRequested: record.cancelRequested === true,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString()
  };
}
