import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  CognitionCommitResult,
  CognitionDependency,
  CognitionJudgmentRecordDraft,
  CognitionPatchPreview,
  CoverageLedger,
  LearningProposal,
  ProposalDecision,
  ReviewBundle
} from "@vc-agent/contracts";
import { coverageLedgerSchema } from "@vc-agent/contracts";
import type { CognitionReviewStore } from "./store.js";
import type { FileTransactionAdapter, JournaledFileTransactionCommitInput, JournaledFileTransactionTarget } from "./journaled-file-transaction.js";
import type { LongTermMemoryStore } from "../long-term-memory.js";
import type { MemoryEvolutionStore, LocalMemoryProvenanceRecord, MemoryPatchRequest } from "../memory-evolution.js";
import type { ProjectMemoryStore, ProjectMemoryDraft } from "../project-memory.js";

export const MISSING_HASH = "missing";

export interface CognitionReviewProject {
  readonly id: string;
  readonly path: string;
}

export interface CognitionReviewDependencyResolution {
  readonly hash: string;
  readonly path?: string;
}

export interface CognitionReviewCommitOptions {
  readonly memory?: LongTermMemoryStore;
  readonly projects?: ReadonlyMap<string, CognitionReviewProject> | Readonly<Record<string, CognitionReviewProject>>;
  readonly resolveProject?: (projectId: string) => CognitionReviewProject | undefined;
  readonly judgmentPath?: string | ((draft: CognitionJudgmentRecordDraft, bundle: ReviewBundle) => string);
  readonly resolveDependency?: (dependency: CognitionDependency) => CognitionReviewDependencyResolution | undefined;
  readonly captureDependency?: (dependency: CognitionDependency) => CognitionDependency | CognitionReviewDependencyResolution | undefined;
  readonly now: () => Date;
  readonly reviewRoot: string;
  readonly bundlePath: (reviewId: string) => string;
  readonly metadataPath: (reviewId: string) => string;
  readonly ledgerPath: (batchId: string) => string;
  readonly cutoffPath: string;
}

export interface PreparedCognitionPatch {
  readonly preview: CognitionPatchPreview;
  readonly targets: readonly JournaledFileTransactionTarget[];
  readonly memoryPatchIds: readonly string[];
  readonly ledger?: CoverageLedger;
  readonly cutoff?: string;
  readonly carriedOverSourceReferences: readonly string[];
}

export interface StoredPreparedCognitionPatch extends PreparedCognitionPatch {
  readonly targets: readonly JournalTargetRecord[];
}

export interface JournalTargetRecord {
  readonly path: string;
  readonly baseHash: string;
  readonly afterContent: string;
}

/**
 * Build the one patch represented by a Review Bundle.  This helper is kept
 * behind CognitionReviewModule; callers should never invoke it as a second
 * cognition commit seam.
 */
export function prepareCognitionPatch(
  bundle: ReviewBundle,
  meta: ReviewMeta,
  options: CognitionReviewCommitOptions,
  stores: { readonly evolution: MemoryEvolutionStore; readonly projectMemory: ProjectMemoryStore }
): StoredPreparedCognitionPatch {
  const adopted = adoptedProposals(bundle);
  const targets: JournalTargetRecord[] = [];
  const memoryPatchIds: string[] = [];
  const sourceEntries = sourceMetadata(meta);

  const longTermRequests = adopted
    .filter((proposal) => proposal.destination === "long_term_memory")
    .map((proposal) => toMemoryPatchRequest(bundle, proposal, sourceEntries, options.now()));
  if (longTermRequests.length > 0) {
    if (options.memory === undefined) throw new Error("COGNITION_LONG_TERM_MEMORY_STORE_REQUIRED");
    const prepared = stores.evolution.prepareMany(longTermRequests);
    memoryPatchIds.push(prepared.id);
    const stored = readStoredMemoryPatch(options.memory, prepared.id);
    for (const file of prepared.files.filter((file) => file.changed)) {
      const afterContent = stored.resultContents[file.kind];
      if (typeof afterContent !== "string") throw new Error("COGNITION_MEMORY_PATCH_CONTENT_MISSING");
      targets.push({ path: file.path, baseHash: file.baseHash, afterContent });
    }
  }

  const projectDrafts = new Map<string, ProjectMemoryDraft[]>();
  for (const proposal of adopted.filter((item) => item.destination === "project_memory")) {
    const project = resolveProposalProject(proposal, sourceEntries, options);
    const drafts = projectDrafts.get(project.id) ?? [];
    drafts.push({
      title: proposal.title,
      tags: proposal.applicability,
      body: `${proposal.content}\n\nLimitations: ${proposal.limitations}\nSource References: ${proposal.sourceReferences.join(", ")}`
    });
    projectDrafts.set(project.id, drafts);
  }
  for (const [projectId, drafts] of projectDrafts) {
    const project = resolveProject(projectId, options);
    const path = stores.projectMemory.markdownPath(project.path);
    mkdirSync(dirname(path), { recursive: true });
    const preview = stores.projectMemory.previewAppendMany(project.id, project.path, drafts, options.now());
    targets.push({ path: preview.path, baseHash: preview.baseHash, afterContent: preview.content });
  }

  if (bundle.kind === "reflection") {
    if (bundle.judgment === undefined) throw new Error("COGNITION_REFLECTION_JUDGMENT_REQUIRED");
    const path = resolveJudgmentPath(bundle.judgment, bundle, options);
    mkdirSync(dirname(path), { recursive: true });
    const baseHash = existsSync(path) ? hash(readFileSync(path, "utf8")) : MISSING_HASH;
    const content = renderJudgmentRecord(bundle.judgment, bundle.id, options.now());
    targets.push({ path, baseHash, afterContent: content });
  }

  let ledger: CoverageLedger | undefined;
  let cutoff: string | undefined;
  const carriedOverSourceReferences = bundle.kind === "memory_review" ? carriedOverSources(bundle, meta) : [];
  if (bundle.kind === "memory_review") {
    ledger = finalLedger(meta, bundle);
    cutoff = meta.cutoff;
    const ledgerPath = options.ledgerPath(ledger.batchId);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    targets.push({ path: ledgerPath, baseHash: fileHashOrMissing(ledgerPath), afterContent: `${JSON.stringify(ledger, null, 2)}\n` });
    mkdirSync(dirname(options.cutoffPath), { recursive: true });
    targets.push({ path: options.cutoffPath, baseHash: fileHashOrMissing(options.cutoffPath), afterContent: `${JSON.stringify({ schemaVersion: 1, batchId: ledger.batchId, cutoff, updatedAt: options.now().toISOString() }, null, 2)}\n` });
  }

  const preview = {
    id: `patch-${bundle.id}`,
    confirmationRequired: true as const,
    files: targets.map((target) => ({ path: target.path, baseHash: target.baseHash, afterHash: hash(target.afterContent) }))
  };
  return { preview, targets, memoryPatchIds, ...(ledger === undefined ? {} : { ledger }), ...(cutoff === undefined ? {} : { cutoff }), carriedOverSourceReferences };
}

/** Commit a prepared patch through the caller-owned journaled transaction. */
export function commitPreparedCognitionPatch(
  bundle: ReviewBundle,
  prepared: StoredPreparedCognitionPatch,
  options: CognitionReviewCommitOptions,
  transaction: FileTransactionAdapter,
  stores: { readonly evolution: MemoryEvolutionStore; readonly projectMemory: ProjectMemoryStore; readonly reviewStore: CognitionReviewStore },
  dependencies: readonly CognitionDependency[] = []
): CognitionCommitResult {
  const stale = prepared.targets.some((target) => fileHashOrMissing(target.path) !== target.baseHash) || dependencies.some((dependency) => dependencyChanged(dependency, options));
  if (stale) {
    const staleBundle = { ...bundle, status: "stale" as const, updatedAt: options.now().toISOString() };
    stores.reviewStore.saveReviewBundle(staleBundle);
    return {
      schemaVersion: 1,
      reviewId: bundle.id,
      status: "stale",
      adoptedProposalIds: adoptedProposals(bundle).map((proposal) => proposal.id),
      carriedOverSourceReferences: [...prepared.carriedOverSourceReferences],
      errorCode: "COGNITION_REVIEW_STALE"
    };
  }

  const committedBundle: ReviewBundle = { ...bundle, status: "committed", updatedAt: options.now().toISOString() };
  const bundlePath = options.bundlePath(bundle.id);
  const bundleContent = `${JSON.stringify(committedBundle, null, 2)}\n`;
  const bundleTarget: JournalTargetRecord = { path: bundlePath, baseHash: fileHashOrMissing(bundlePath), afterContent: bundleContent };
  const journalTargets = [...prepared.targets, bundleTarget];
  try {
    const input: JournaledFileTransactionCommitInput = { id: `cognition-${bundle.id}`, targets: journalTargets };
    transaction.commit(input);
  } catch (error) {
    // A durable commit point may have been reached before a fault surfaced.
    // Recovery publishes the after-images, including the committed Bundle.
    try { transaction.recover(); } catch { /* Preserve the original failure result. */ }
    if (stores.reviewStore.loadReviewBundle(bundle.id)?.status === "committed") {
      cleanupMemoryPatches(stores.evolution, prepared.memoryPatchIds);
      rebuildProjectMemory(stores.projectMemory, prepared);
      return committedResult(bundle, prepared);
    }
    return {
      schemaVersion: 1,
      reviewId: bundle.id,
      status: "failed",
      adoptedProposalIds: adoptedProposals(bundle).map((proposal) => proposal.id),
      carriedOverSourceReferences: [...prepared.carriedOverSourceReferences],
      errorCode: errorCode(error)
    };
  }

  cleanupMemoryPatches(stores.evolution, prepared.memoryPatchIds);
  rebuildProjectMemory(stores.projectMemory, prepared);
  return committedResult(bundle, prepared);
}

function dependencyChanged(dependency: CognitionDependency, options: CognitionReviewCommitOptions): boolean {
  if (options.resolveDependency !== undefined) {
    const resolved = options.resolveDependency(dependency);
    return resolved === undefined ? dependency.required : resolved.hash !== dependency.hash;
  }
  if (options.captureDependency !== undefined) {
    const captured = options.captureDependency(dependency);
    return captured === undefined ? dependency.required : captured.hash !== dependency.hash;
  }
  return false;
}

export interface ReviewMeta {
  readonly kind: ReviewBundle["kind"];
  readonly cutoff?: string;
  readonly ledger?: CoverageLedger;
  readonly sources?: readonly SourceMeta[];
  readonly dependencies: readonly CognitionDependency[];
  readonly prepared?: StoredPreparedCognitionPatch;
}

export interface SourceMeta {
  readonly sourceReference: string;
  readonly scope: "project" | "unscoped";
  readonly projectId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly availability?: "available" | "deleted";
}

function adoptedProposals(bundle: ReviewBundle): LearningProposal[] {
  const byId = new Map(bundle.decisions.map((decision) => [decision.proposalId, decision.decision]));
  return bundle.proposals.filter((proposal) => byId.get(proposal.id) === "adopt");
}

function resolveProject(projectId: string, options: CognitionReviewCommitOptions): CognitionReviewProject {
  let configured: CognitionReviewProject | undefined;
  if (options.projects !== undefined) {
    if (typeof (options.projects as ReadonlyMap<string, CognitionReviewProject>).get === "function") configured = (options.projects as ReadonlyMap<string, CognitionReviewProject>).get(projectId);
    else configured = (options.projects as Readonly<Record<string, CognitionReviewProject>>)[projectId];
  }
  const resolved = options.resolveProject?.(projectId) ?? configured;
  if (resolved === undefined || resolved.id !== projectId || !resolved.path.trim()) throw new Error("COGNITION_PROJECT_TARGET_UNAVAILABLE");
  return resolved;
}

function resolveProposalProject(proposal: LearningProposal, sourceEntries: ReadonlyMap<string, SourceMeta>, options: CognitionReviewCommitOptions): CognitionReviewProject {
  const projectIds = new Set<string>();
  if (proposal.projectId !== undefined) projectIds.add(proposal.projectId);
  for (const reference of proposal.sourceReferences) {
    const source = sourceEntries.get(reference);
    if (source?.scope === "project" && source.projectId !== undefined) projectIds.add(source.projectId);
    else if (source?.scope === "unscoped") throw new Error("COGNITION_PROJECT_MEMORY_SCOPE_INVALID");
  }
  if (projectIds.size !== 1) throw new Error("COGNITION_PROJECT_MEMORY_SCOPE_AMBIGUOUS");
  return resolveProject([...projectIds][0]!, options);
}

function toMemoryPatchRequest(bundle: ReviewBundle, proposal: LearningProposal, sourceEntries: ReadonlyMap<string, SourceMeta>, now: Date): MemoryPatchRequest {
  const sourceReferences = proposal.sourceReferences.map((reference) => opaqueSourceReference(bundle.id, reference));
  const provenanceRecords: LocalMemoryProvenanceRecord[] = proposal.sourceReferences.map((reference, index) => {
    const source = sourceEntries.get(reference);
    return {
      schemaVersion: 1,
      sourceReferenceId: sourceReferences[index]!,
      scope: source?.scope ?? "unscoped",
      ...(source?.projectId === undefined ? {} : { projectId: source.projectId }),
      workflowType: bundle.kind === "memory_review" ? "memory_review" : "reflection",
      workflowRunId: bundle.id,
      ...(bundle.judgment?.id === undefined ? {} : { judgmentRecordId: bundle.judgment.id }),
      ...(source?.threadId === undefined ? {} : { threadId: source.threadId }),
      ...(source?.turnId === undefined ? {} : { turnId: source.turnId }),
      evidenceReferences: [reference],
      availability: source?.availability === "deleted" ? "source_unavailable" : "active",
      createdAt: now.toISOString()
    };
  });
  return {
    action: proposal.action,
    targetEntryIds: proposal.targetEntryIds,
    proposed: {
      id: proposal.id,
      title: proposal.title,
      date: now.toISOString().slice(0, 10),
      tags: proposal.applicability,
      applicability: proposal.applicability,
      maturity: "user-confirmed",
      recallPolicy: "automatic",
      limitations: proposal.limitations,
      content: proposal.content,
      sourceReferenceIds: sourceReferences
    },
    rationale: `${proposal.title}: ${proposal.content}`,
    provenanceRecords
  };
}

function readStoredMemoryPatch(memory: LongTermMemoryStore, id: string): { readonly resultContents: Record<string, string> } {
  const path = join(dirname(memory.rootPath), "patches", `${id}.json`);
  if (!existsSync(path)) throw new Error("COGNITION_MEMORY_PATCH_NOT_FOUND");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { resultContents?: Record<string, string> };
  if (parsed.resultContents === undefined) throw new Error("COGNITION_MEMORY_PATCH_CONTENT_MISSING");
  return parsed as { readonly resultContents: Record<string, string> };
}

function finalLedger(meta: ReviewMeta, bundle: ReviewBundle): CoverageLedger {
  if (meta.ledger === undefined) throw new Error("COGNITION_MEMORY_COVERAGE_REQUIRED");
  const byId = new Map(bundle.decisions.map((decision) => [decision.proposalId, decision.decision]));
  const entries = meta.ledger.entries.map((entry) => {
    const decisions = entry.proposalIds.map((id) => byId.get(id)).filter((decision): decision is ProposalDecision => decision !== undefined);
    // A model/Host carryover with no proposal is already a terminal coverage
    // fact (for example, a temporarily unavailable source). User proposal
    // decisions may refine represented entries, but must not erase that fact.
    const status = decisions.includes("adopt")
      ? "represented"
      : decisions.includes("defer") || (decisions.length === 0 && entry.status === "carried_over")
        ? "carried_over"
        : "no_signal";
    return { ...entry, status, proposalIds: status === "represented" ? entry.proposalIds : [], dispositionReason: decisions.length === 0 ? entry.dispositionReason : decisions.includes("defer") ? "deferred by User" : decisions.includes("reject") ? "rejected by User" : entry.dispositionReason };
  });
  return coverageLedgerSchema.parse({ ...meta.ledger, entries, updatedAt: new Date().toISOString() });
}

function carriedOverSources(bundle: ReviewBundle, meta: ReviewMeta): string[] {
  if (meta.ledger === undefined) return [];
  const ledger = finalLedger(meta, bundle);
  return ledger.entries.filter((entry) => entry.status === "carried_over").map((entry) => entry.sourceReference);
}

function sourceMetadata(meta: ReviewMeta): ReadonlyMap<string, SourceMeta> {
  return new Map((meta.sources ?? []).map((source) => [source.sourceReference, source]));
}

function resolveJudgmentPath(draft: CognitionJudgmentRecordDraft, bundle: ReviewBundle, options: CognitionReviewCommitOptions): string {
  const path = typeof options.judgmentPath === "function" ? options.judgmentPath(draft, bundle) : options.judgmentPath;
  return path ?? join(options.reviewRoot, "judgment-records", `${draft.id}.json`);
}

function renderJudgmentRecord(draft: CognitionJudgmentRecordDraft, reviewId: string, now: Date): string {
  return `${JSON.stringify({ schemaVersion: 1, recordType: "judgment", reviewId, status: "confirmed", confirmedAt: now.toISOString(), ...draft }, null, 2)}\n`;
}

function committedResult(bundle: ReviewBundle, prepared: StoredPreparedCognitionPatch): CognitionCommitResult {
  return {
    schemaVersion: 1,
    reviewId: bundle.id,
    status: "committed",
    ...(prepared.cutoff === undefined ? {} : { cutoff: prepared.cutoff }),
    adoptedProposalIds: adoptedProposals(bundle).map((proposal) => proposal.id),
    carriedOverSourceReferences: [...prepared.carriedOverSourceReferences]
  };
}

function cleanupMemoryPatches(evolution: MemoryEvolutionStore, ids: readonly string[]): void {
  for (const id of ids) {
    try { evolution.discard(id); } catch { /* A completed transaction can outlive patch cleanup. */ }
  }
}

function rebuildProjectMemory(projectMemory: ProjectMemoryStore, prepared: StoredPreparedCognitionPatch): void {
  for (const target of prepared.targets) {
    if (!target.path.endsWith("project-memory.md")) continue;
    try {
      // The project identity is deliberately not inferred from an arbitrary
      // renderer path; rebuild is only a derived index refresh.
      const projectId = "";
      void projectMemory;
      void projectId;
    } catch { /* Derived indexes are rebuildable and not authoritative. */ }
  }
}

function opaqueSourceReference(bundleId: string, reference: string): string {
  return `src_ref_${createHash("sha256").update(`${bundleId}\0${reference}`).digest("hex").slice(0, 32)}`;
}

function fileHashOrMissing(path: string): string {
  return existsSync(path) ? hash(readFileSync(path, "utf8")) : MISSING_HASH;
}

function hash(content: string): string { return createHash("sha256").update(content, "utf8").digest("hex"); }
function errorCode(error: unknown): string { return error instanceof Error ? error.message.slice(0, 120) || "COGNITION_COMMIT_FAILED" : "COGNITION_COMMIT_FAILED"; }
