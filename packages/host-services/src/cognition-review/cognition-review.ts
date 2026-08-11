import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  cognitionDependencySchema,
  coverageLedgerSchema,
  eligibleLearningSourceSchema,
  learningProposalSchema,
  memoryReviewInputSchema,
  proposalDecisionInputSchema,
  reflectionReviewInputSchema,
  reviewBundleSchema,
  type CognitionCommitResult,
  type CognitionDependency,
  type CognitionJudgmentRecordDraft,
  type CoverageLedger,
  type EligibleLearningSource,
  type LearningProposal,
  type MemoryReviewInput,
  type ProposalDecisionInput,
  type ReflectionReviewInput,
  type ReviewBundle
} from "@vc-agent/contracts";
import type { CognitionReviewModule as CognitionReviewModuleContract } from "@vc-agent/contracts";
import { assertCoverageComplete, projectCoverageSummary } from "./coverage-ledger.js";
import { CognitionReviewStore } from "./store.js";
import type { FileTransactionAdapter } from "./journaled-file-transaction.js";
import {
  commitPreparedCognitionPatch,
  prepareCognitionPatch,
  type CognitionReviewCommitOptions,
  type CognitionReviewDependencyResolution,
  type CognitionReviewProject,
  type JournalTargetRecord,
  type ReviewMeta,
  type SourceMeta,
  type StoredPreparedCognitionPatch
} from "./commit.js";
import { LongTermMemoryStore } from "../long-term-memory.js";
import { MemoryEvolutionStore } from "../memory-evolution.js";
import { ProjectMemoryStore } from "../project-memory.js";

export interface CognitionReviewModuleOptions {
  readonly store: CognitionReviewStore;
  readonly memory?: LongTermMemoryStore;
  readonly evolution: MemoryEvolutionStore;
  readonly projectMemory: ProjectMemoryStore;
  readonly transaction: FileTransactionAdapter;
  readonly projects?: ReadonlyMap<string, CognitionReviewProject> | Readonly<Record<string, CognitionReviewProject>>;
  readonly resolveProject?: (projectId: string) => CognitionReviewProject | undefined;
  /** Host-owned destination resolver. The input/model never supplies a path. */
  readonly judgmentPath?: string | ((draft: CognitionJudgmentRecordDraft, bundle: ReviewBundle) => string);
  readonly resolveDependency?: (dependency: CognitionDependency) => CognitionReviewDependencyResolution | undefined;
  readonly captureDependency?: (dependency: CognitionDependency) => CognitionDependency | CognitionReviewDependencyResolution | undefined;
  readonly now?: () => Date;
  readonly createId?: () => string;
  /** Installation-level cutoff file; defaults inside the Cognition Review root. */
  readonly cutoffPath?: string;
}

/**
 * The sole external authority seam for Reflection and Memory Review. Internal
 * patch construction, source disposition, and journal publication are kept in
 * commit.ts and are intentionally not exposed as a second commit API.
 */
export class CognitionReviewModule implements CognitionReviewModuleContract {
  readonly #store: CognitionReviewStore;
  readonly #memory: LongTermMemoryStore | undefined;
  readonly #evolution: MemoryEvolutionStore;
  readonly #projectMemory: ProjectMemoryStore;
  readonly #transaction: FileTransactionAdapter;
  readonly #options: CognitionReviewModuleOptions;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #cutoffPath: string;

  constructor(options: CognitionReviewModuleOptions) {
    this.#store = options.store;
    this.#memory = options.memory;
    this.#evolution = options.evolution;
    this.#projectMemory = options.projectMemory;
    this.#transaction = options.transaction;
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#cutoffPath = options.cutoffPath ?? join(options.store.rootPath, "committed-cutoff.json");
    this.#recover();
  }

  prepare(input: ReflectionReviewInput | MemoryReviewInput): ReviewBundle {
    this.#recover();
    const parsed = this.#parseInput(input);
    const now = this.#now().toISOString();
    const id = this.#createReviewId();
    const activeLease = this.#hasActiveLease();
    const bundle = reviewBundleSchema.parse({
      id,
      kind: parsed.kind,
      status: activeLease ? "analysis_completed" : "reviewing",
      ...(parsed.kind === "reflection" ? { judgment: parsed.judgment } : {}),
      proposals: parsed.proposals,
      decisions: [],
      ...(parsed.kind === "memory_review" ? { coverage: parsed.coverageSummary } : {}),
      dependencies: parsed.dependencies,
      createdAt: now,
      updatedAt: now
    });
    this.#store.saveReviewBundle(bundle);
    this.#saveMeta(id, parsed.meta);
    return bundle;
  }

  decide(reviewId: string, decisions: readonly ProposalDecisionInput[]): ReviewBundle {
    this.#recover();
    let bundle = this.#requireBundle(reviewId);
    if (!["reviewing", "waiting_for_review", "analysis_completed"].includes(bundle.status)) {
      throw new Error("COGNITION_REVIEW_NOT_DECIDABLE");
    }
    if (bundle.status !== "reviewing") {
      if (this.#hasActiveLease(bundle.id)) throw new Error("COGNITION_REVIEW_LEASE_UNAVAILABLE");
      bundle = this.#saveStatus(bundle, "reviewing");
    }
    const parsedDecisions = decisions.map((decision) => proposalDecisionInputSchema.parse(decision));
    const known = new Set(bundle.proposals.map((proposal) => proposal.id));
    const current = new Map(bundle.decisions.map((decision) => [decision.proposalId, decision]));
    for (const decision of parsedDecisions) {
      if (!known.has(decision.proposalId)) throw new Error("COGNITION_REVIEW_UNKNOWN_PROPOSAL");
      if (current.has(decision.proposalId)) throw new Error("COGNITION_REVIEW_DUPLICATE_DECISION");
      current.set(decision.proposalId, { ...decision, decidedAt: this.#now().toISOString() });
    }
    const updated: ReviewBundle = reviewBundleSchema.parse({ ...bundle, decisions: [...current.values()], updatedAt: this.#now().toISOString() });
    if (updated.decisions.length < updated.proposals.length) {
      this.#store.saveReviewBundle(updated);
      return updated;
    }
    const meta = this.#requireMeta(updated.id);
    const prepared = prepareCognitionPatch(updated, meta, this.#commitOptions(), { evolution: this.#evolution, projectMemory: this.#projectMemory });
    const withPatch = reviewBundleSchema.parse({ ...updated, status: "prepared", patch: prepared.preview, updatedAt: this.#now().toISOString() });
    this.#store.saveReviewBundle(withPatch);
    this.#saveMeta(updated.id, { ...meta, prepared });
    return withPatch;
  }

  commit(reviewId: string): CognitionCommitResult {
    this.#recover();
    const bundle = this.#requireBundle(reviewId);
    if (bundle.status !== "prepared") throw new Error("COGNITION_REVIEW_NOT_PREPARED");
    const meta = this.#requireMeta(reviewId);
    const prepared = meta.prepared ?? this.#readPreparedFromPatch(bundle, meta);
    const result = commitPreparedCognitionPatch(bundle, prepared, this.#commitOptions(), this.#transaction, { evolution: this.#evolution, projectMemory: this.#projectMemory, reviewStore: this.#store }, meta.dependencies);
    if (result.status === "committed") {
      this.#deleteMeta(reviewId);
      this.#promoteNextWaiting();
    }
    return result;
  }

  discard(reviewId: string): void {
    this.#recover();
    const bundle = this.#requireBundle(reviewId);
    if (!["analysis_completed", "waiting_for_review", "reviewing", "prepared", "stale"].includes(bundle.status)) {
      throw new Error("COGNITION_REVIEW_NOT_DISCARDABLE");
    }
    this.#store.saveReviewBundle({ ...bundle, status: "discarded", updatedAt: this.#now().toISOString(), patch: undefined });
    this.#deleteMeta(reviewId);
    this.#promoteNextWaiting();
  }

  #parseInput(input: ReflectionReviewInput | MemoryReviewInput): ParsedReviewInput {
    if (input.kind === "reflection") {
      const parsed = reflectionReviewInputSchema.parse(input);
      const proposals = normalizeProposals(parsed.proposals);
      const dependencies = this.#captureDependencies(parsed.dependencies);
      return { kind: "reflection", judgment: parsed.judgment, proposals, dependencies, meta: { kind: "reflection", dependencies, sources: sourceMetaFromDependencies(dependencies) } };
    }
    const parsed = memoryReviewInputSchema.parse(input);
    if (parsed.proposals === undefined) throw new Error("COGNITION_MEMORY_PROPOSALS_REQUIRED");
    const proposals = normalizeProposals(parsed.proposals);
    const ledger = this.#memoryLedger(parsed, proposals);
    assertCoverageComplete(ledger);
    const dependencies = this.#captureDependencies(parsed.dependencies ?? []);
    const sources = parsed.sources.map((source) => eligibleLearningSourceSchema.parse(source));
    const sourceMeta = sources.map(sourceToMeta);
    const sourceMap = new Map(sourceMeta.map((source) => [source.sourceReference, source]));
    for (const entry of ledger.entries) {
      if (entry.status === "represented" && entry.proposalIds.some((id) => !proposals.some((proposal) => proposal.id === id))) throw new Error("COGNITION_MEMORY_COVERAGE_UNKNOWN_PROPOSAL");
      if (entry.scope === "project" && entry.projectId === undefined) throw new Error("COGNITION_MEMORY_PROJECT_SCOPE_REQUIRED");
      sourceMap.set(entry.sourceReference, {
        sourceReference: entry.sourceReference,
        scope: entry.scope,
        ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }),
        ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }),
        ...(entry.turnId === undefined ? {} : { turnId: entry.turnId }),
        availability: entry.availability
      });
    }
    // CoverageSummary is a projection, never an authority supplied by the
    // renderer/model. Derive it from the Host-validated ledger every time.
    const summary = projectCoverageSummary(ledger);
    if (!summary.complete) throw new Error("COGNITION_MEMORY_COVERAGE_INCOMPLETE");
    return {
      kind: "memory_review",
      proposals,
      dependencies,
      coverageSummary: summary,
      meta: { kind: "memory_review", cutoff: parsed.cutoff, ledger, dependencies, sources: [...sourceMap.values()] }
    };
  }

  #memoryLedger(input: MemoryReviewInput, proposals: readonly LearningProposal[]): CoverageLedger {
    const ledger = coverageLedgerSchema.parse(input.coverageLedger);
    const sourceRefs = new Set(input.sources.map((source) => source.sourceReference));
    const ledgerRefs = new Set(ledger.entries.map((entry) => entry.sourceReference));
    if (sourceRefs.size !== ledgerRefs.size || [...sourceRefs].some((reference) => !ledgerRefs.has(reference))) {
      throw new Error("COGNITION_MEMORY_COVERAGE_SOURCE_SET_MISMATCH");
    }
    const proposalIds = new Set(proposals.map((proposal) => proposal.id));
    for (const entry of ledger.entries) {
      if (entry.status === "represented" && entry.proposalIds.some((id) => !proposalIds.has(id))) throw new Error("COGNITION_MEMORY_COVERAGE_UNKNOWN_PROPOSAL");
    }
    return ledger;
  }

  #captureDependencies(dependencies: readonly CognitionDependency[]): CognitionDependency[] {
    return dependencies.map((dependency) => {
      const parsed = cognitionDependencySchema.parse(dependency);
      const captured = this.#options.captureDependency?.(parsed);
      if (captured !== undefined && "hash" in captured) return cognitionDependencySchema.parse({ ...parsed, hash: captured.hash });
      const resolved = this.#options.resolveDependency?.(parsed);
      if (resolved !== undefined) return cognitionDependencySchema.parse({ ...parsed, hash: resolved.hash });
      return parsed;
    });
  }

  #commitOptions(): CognitionReviewCommitOptions {
    return {
      ...(this.#memory === undefined ? {} : { memory: this.#memory }),
      ...(this.#options.projects === undefined ? {} : { projects: this.#options.projects }),
      ...(this.#options.resolveProject === undefined ? {} : { resolveProject: this.#options.resolveProject }),
      ...(this.#options.judgmentPath === undefined ? {} : { judgmentPath: this.#options.judgmentPath }),
      ...(this.#options.resolveDependency === undefined ? {} : { resolveDependency: this.#options.resolveDependency }),
      ...(this.#options.captureDependency === undefined ? {} : { captureDependency: this.#options.captureDependency }),
      now: this.#now,
      reviewRoot: this.#store.rootPath,
      bundlePath: (id) => this.#store.reviewPath(id),
      metadataPath: (id) => this.#metadataPath(id),
      ledgerPath: (batchId) => this.#store.coverageLedgerPath(batchId),
      cutoffPath: this.#cutoffPath
    };
  }

  #requireBundle(id: string): ReviewBundle {
    if (!id.trim()) throw new Error("COGNITION_REVIEW_ID_REQUIRED");
    const bundle = this.#store.loadReviewBundle(id);
    if (bundle === undefined) throw new Error("COGNITION_REVIEW_NOT_FOUND");
    return bundle;
  }

  #requireMeta(id: string): ReviewMeta {
    const path = this.#metadataPath(id);
    if (!existsSync(path)) throw new Error("COGNITION_REVIEW_METADATA_NOT_FOUND");
    return JSON.parse(readFileSync(path, "utf8")) as ReviewMeta;
  }

  #saveMeta(id: string, meta: ReviewMeta): void {
    const path = this.#metadataPath(id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }

  #deleteMeta(id: string): void {
    const path = this.#metadataPath(id);
    try { rmSync(path, { force: true }); } catch { /* Metadata is non-authoritative cleanup. */ }
  }

  #metadataPath(id: string): string {
    if (!safeId(id)) throw new Error("COGNITION_REVIEW_ID_INVALID");
    return join(this.#store.workPath, `${id}.review.json`);
  }

  #saveStatus(bundle: ReviewBundle, status: ReviewBundle["status"]): ReviewBundle {
    const updated = reviewBundleSchema.parse({ ...bundle, status, updatedAt: this.#now().toISOString() });
    this.#store.saveReviewBundle(updated);
    return updated;
  }

  #hasActiveLease(exceptReviewId?: string): boolean {
    return this.#store.listReviewBundles().some((bundle) =>
      bundle.id !== exceptReviewId
      && ["waiting_for_review", "reviewing", "prepared", "stale"].includes(bundle.status)
    );
  }

  #promoteNextWaiting(): void {
    if (this.#hasActiveLease()) return;
    const next = this.#store.listReviewBundles().find((bundle) => bundle.status === "analysis_completed");
    if (next !== undefined) this.#saveStatus(next, "waiting_for_review");
  }

  #recover(): void { this.#transaction.recover(); }

  #createReviewId(): string {
    const id = this.#createId();
    return safeId(id) ? id : `review-${randomUUID()}`;
  }

  #readPreparedFromPatch(bundle: ReviewBundle, meta: ReviewMeta): StoredPreparedCognitionPatch {
    if (meta.prepared !== undefined) return meta.prepared;
    throw new Error("COGNITION_REVIEW_PATCH_NOT_FOUND");
  }
}

interface ParsedReviewInputBase {
  readonly proposals: readonly LearningProposal[];
  readonly dependencies: readonly CognitionDependency[];
  readonly meta: ReviewMeta;
}
interface ParsedReflectionInput extends ParsedReviewInputBase {
  readonly kind: "reflection";
  readonly judgment: CognitionJudgmentRecordDraft;
}
interface ParsedMemoryInput extends ParsedReviewInputBase {
  readonly kind: "memory_review";
  readonly coverageSummary: ReviewBundle["coverage"];
}
type ParsedReviewInput = ParsedReflectionInput | ParsedMemoryInput;
function normalizeProposals(proposals: readonly LearningProposal[]): LearningProposal[] {
  const seen = new Set<string>();
  return proposals.map((proposal) => {
    const parsed = learningProposalSchema.parse(proposal);
    if (seen.has(parsed.id)) throw new Error("COGNITION_REVIEW_DUPLICATE_PROPOSAL");
    seen.add(parsed.id);
    if (parsed.destination === "project_memory" && parsed.action !== "add") throw new Error("COGNITION_PROJECT_MEMORY_ACTION_INVALID");
    if (parsed.destination === "long_term_memory" && parsed.action === "add" && parsed.targetEntryIds.length > 0) throw new Error("COGNITION_LONG_TERM_ADD_TARGET_INVALID");
    return parsed;
  });
}

function sourceToMeta(source: EligibleLearningSource): SourceMeta {
  return {
    sourceReference: source.sourceReference,
    scope: source.scope,
    ...(source.projectId === undefined ? {} : { projectId: source.projectId }),
    ...(source.threadId === undefined ? {} : { threadId: source.threadId }),
    ...(source.turnId === undefined ? {} : { turnId: source.turnId }),
    availability: source.availability
  };
}

function sourceMetaFromDependencies(dependencies: readonly CognitionDependency[]): SourceMeta[] {
  return dependencies.filter((dependency) => dependency.kind === "source").map((dependency) => ({ sourceReference: dependency.reference, scope: "unscoped" as const }));
}

function safeId(value: string): boolean { return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value); }
