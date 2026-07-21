import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DreamBatch, DreamPreparedPatch, DreamSynthesisProposal } from "@vc-agent/contracts";
import { DreamReviewStore } from "./dream-review.js";
import { LongTermMemoryStore } from "./long-term-memory.js";
import { MemoryEvolutionStore, type AtomicMemoryFileAddition, type LocalMemoryProvenanceRecord, type MemoryPatchRequest } from "./memory-evolution.js";
import { MemoryCandidateStore, ProjectMemoryStore, type ProjectMemoryDraft } from "./project-memory.js";

interface StoredDreamPatch {
  readonly schemaVersion: 1;
  readonly batchId: string;
  readonly patch: DreamPreparedPatch;
  readonly additions: AtomicMemoryFileAddition[];
  readonly projectTargets: Array<{ projectId: string; projectPath: string }>;
}

export interface DreamCommitProject { readonly id: string; readonly path: string; }

export class DreamCommitStore {
  readonly #root: string;
  readonly #reviews: DreamReviewStore;
  readonly #evolution: MemoryEvolutionStore;
  readonly #projectMemory: ProjectMemoryStore;
  readonly #candidates: MemoryCandidateStore;
  readonly #now: () => Date;

  constructor(root: string, dependencies: { reviews: DreamReviewStore; evolution: MemoryEvolutionStore; memory: LongTermMemoryStore; projectMemory: ProjectMemoryStore; candidates: MemoryCandidateStore }, now: () => Date = () => new Date()) {
    this.#root = root;
    this.#reviews = dependencies.reviews;
    this.#evolution = dependencies.evolution;
    this.#projectMemory = dependencies.projectMemory;
    this.#candidates = dependencies.candidates;
    this.#now = now;
  }

  prepare(batchId: string, projects: ReadonlyMap<string, DreamCommitProject>): DreamPreparedPatch {
    let batch = requiredBatch(this.#reviews, batchId);
    if (batch.synthesis?.status !== "reviewed" || batch.preparedPatch?.status === "prepared") throw new Error("DREAM_SYNTHESIS_NOT_READY_FOR_PATCH");
    const preparedAt = this.#now();
    const preparedAtIso = preparedAt.toISOString();
    const approved = batch.synthesis.proposals.filter((proposal) => proposal.status === "approved");
    const requests = approved.filter((proposal) => proposal.destination === "long_term_memory" || proposal.destination === "merge_condense").map((proposal) => toMemoryRequest(batch, proposal, preparedAtIso));
    const memoryPatch = requests.length === 0 ? this.#evolution.prepareAtomicAnchor(`Dream ${batch.id} Project Memory transaction.`) : this.#evolution.prepareMany(requests);
    let preparedReviewPatch: DreamPreparedPatch | undefined;
    try {
    const projectDrafts = new Map<string, ProjectMemoryDraft[]>();
    for (const proposal of approved.filter((item) => item.destination === "project_memory")) {
      const scope = proposalProjectScope(batch, proposal);
      const project = projects.get(scope.projectId!);
      if (project === undefined || proposal.learning === undefined) throw new Error("DREAM_PROJECT_MEMORY_TARGET_UNAVAILABLE");
      const sourceIds = proposal.sourceReferences.map((reference) => opaqueDreamSource(batch.id, reference));
      const draft: ProjectMemoryDraft = {
        title: proposal.learning.title, tags: proposal.learning.tags,
        body: `${proposal.learning.content}\n\nLimitations: ${proposal.learning.limitations}\nUncertainty: ${proposal.uncertainty || "Not stated"}\nSource References: ${sourceIds.join(", ")}`
      };
      projectDrafts.set(project.id, [...(projectDrafts.get(project.id) ?? []), draft]);
    }
    const projectTargets: StoredDreamPatch["projectTargets"] = [];
    const projectAdditions: AtomicMemoryFileAddition[] = [];
    const projectFiles: DreamPreparedPatch["files"] = [];
    for (const [projectId, drafts] of projectDrafts) {
      const project = projects.get(projectId)!;
      const preview = this.#projectMemory.previewAppendMany(project.id, project.path, drafts, preparedAt);
      projectTargets.push({ projectId: project.id, projectPath: project.path });
      projectAdditions.push({ path: preview.path, baseHash: preview.baseHash, resultContent: preview.content });
      projectFiles.push({ kind: "project_memory", path: preview.path, baseHash: preview.baseHash, resultHash: preview.resultHash, changed: preview.before !== preview.content, diff: textDiff(preview.path, preview.before, preview.content) });
    }
    const memoryFiles: DreamPreparedPatch["files"] = memoryPatch.files.map((file) => ({ kind: file.kind === "active" ? "long_term_memory" : file.kind, path: file.path, baseHash: file.baseHash, resultHash: file.resultHash, changed: file.changed, diff: file.diff }));
    const patch: DreamPreparedPatch = {
      schemaVersion: 1, id: randomUUID(), status: "prepared", synthesisId: batch.synthesis.id, synthesisInputHash: batch.synthesis.inputHash,
      longTermPatchId: memoryPatch.id, proposalIds: approved.map((proposal) => proposal.id), partialCoverageScopeReferences: batch.synthesis.partialCoverageScopeReferences,
      files: [...projectFiles, ...memoryFiles], confirmationRequired: true, createdAt: preparedAtIso
    };
    preparedReviewPatch = patch;
    this.#reviews.setPreparedPatch(batch.id, patch);
    batch = requiredBatch(this.#reviews, batch.id);
    const candidatePreview = this.#candidates.previewResolutions(candidateResolutions(batch), preparedAtIso);
    const completionFiles = this.#reviews.completionFiles(batch.id, patch.id, keepPendingScopeIds(batch), candidatePreview.resolvedIds);
    const additions: AtomicMemoryFileAddition[] = [...projectAdditions, ...(candidatePreview.resolvedIds.length === 0 ? [] : [{ path: candidatePreview.path, baseHash: candidatePreview.baseHash, resultContent: candidatePreview.content }]), ...completionFiles];
    atomicWrite(this.#path(patch.id), `${JSON.stringify({ schemaVersion: 1, batchId: batch.id, patch, additions, projectTargets } satisfies StoredDreamPatch, null, 2)}\n`);
    return patch;
    } catch (error) {
      try { this.#evolution.discard(memoryPatch.id); } catch { /* A missing preview is already non-committable. */ }
      if (preparedReviewPatch !== undefined) {
        try { this.#reviews.discardPreparedPatch(batch.id, preparedReviewPatch.id); } catch { /* Preserve the original preparation failure. */ }
      }
      throw error;
    }
  }

  commit(batchId: string, patchId: string): DreamBatch {
    const stored = this.#load(patchId);
    const batch = requiredBatch(this.#reviews, batchId);
    if (stored === undefined || stored.batchId !== batch.id || batch.preparedPatch?.id !== patchId || batch.preparedPatch.status !== "prepared") throw new Error("DREAM_PATCH_NOT_PREPARED");
    if (batch.synthesis?.id !== stored.patch.synthesisId || batch.synthesis.inputHash !== stored.patch.synthesisInputHash) throw new Error("STALE_DREAM_PATCH");
    this.#evolution.commitWithAdditionalFiles(stored.patch.longTermPatchId, stored.additions);
    for (const target of stored.projectTargets) { try { this.#projectMemory.rebuild(target.projectId, target.projectPath); } catch { /* Derived Project Memory indexes remain rebuildable. */ } }
    rmSync(this.#path(patchId), { force: true });
    return requiredBatch(this.#reviews, batchId);
  }

  discard(batchId: string, patchId: string): void {
    const stored = this.#load(patchId);
    if (stored?.batchId !== batchId) throw new Error("DREAM_PATCH_NOT_FOUND");
    this.#evolution.discard(stored.patch.longTermPatchId);
    rmSync(this.#path(patchId), { force: true });
  }

  #path(id: string): string { if (!/^[a-f0-9-]{36}$/iu.test(id)) throw new Error("INVALID_DREAM_PATCH_ID"); return join(this.#root, "patches", `${id}.json`); }
  #load(id: string): StoredDreamPatch | undefined { const path = this.#path(id); return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as StoredDreamPatch : undefined; }
}

function toMemoryRequest(batch: DreamBatch, proposal: DreamSynthesisProposal, now: string): MemoryPatchRequest {
  if (proposal.learning === undefined || proposal.memoryAction === undefined) throw new Error("DREAM_LONG_TERM_PROPOSAL_INCOMPLETE");
  const provenanceRecords = proposal.sourceReferences.map((reference) => provenance(batch, proposal, reference, now));
  return { action: proposal.memoryAction, targetEntryIds: proposal.targetEntryIds, proposed: { ...proposal.learning, sourceReferenceIds: provenanceRecords.map((record) => record.sourceReferenceId) }, rationale: `${proposal.rationale}\nComparison: ${proposal.comparisonSummary}`, provenanceRecords };
}

function provenance(batch: DreamBatch, proposal: DreamSynthesisProposal, reference: string, now: string): LocalMemoryProvenanceRecord {
  const sourceScopeReference = proposal.sourceScopeReferences.find((scopeReference) => {
    const scopeId = batch.synthesis!.scopeMap.find((item) => item.scopeReference === scopeReference)?.scopeId;
    return scopeId !== undefined && batch.extractionScopes.find((scope) => scope.id === scopeId)?.sourceReferences.includes(reference);
  }) ?? proposal.sourceScopeReferences[0]!;
  const scopeId = batch.synthesis!.scopeMap.find((item) => item.scopeReference === sourceScopeReference)!.scopeId;
  const scope = batch.extractionScopes.find((item) => item.id === scopeId)!;
  const trajectory = batch.trajectoryInputs.find((item) => item.sourceReference === reference);
  return { schemaVersion: 1, sourceReferenceId: opaqueDreamSource(batch.id, reference), scope: scope.kind, ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }), workflowType: "dream", workflowRunId: batch.id, ...(trajectory?.threadId === undefined ? {} : { threadId: trajectory.threadId }), ...(trajectory?.turnId === undefined ? {} : { turnId: trajectory.turnId }), evidenceReferences: [reference], availability: "active", createdAt: now };
}

function proposalProjectScope(batch: DreamBatch, proposal: DreamSynthesisProposal) {
  if (proposal.sourceScopeReferences.length !== 1) throw new Error("DREAM_PROJECT_MEMORY_SCOPE_AMBIGUOUS");
  const scopeId = batch.synthesis!.scopeMap.find((item) => item.scopeReference === proposal.sourceScopeReferences[0])?.scopeId;
  const scope = batch.extractionScopes.find((item) => item.id === scopeId);
  if (scope?.kind !== "project") throw new Error("DREAM_PROJECT_MEMORY_SCOPE_AMBIGUOUS");
  return scope;
}

function candidateResolutions(batch: DreamBatch): Record<string, "dismissed" | "promoted"> {
  const proposals = batch.synthesis!.proposals;
  const keepReferences = new Set(proposals.filter((proposal) => proposal.status === "approved" && proposal.destination === "keep_pending").flatMap((proposal) => proposal.sourceReferences));
  const resolutions: Record<string, "dismissed" | "promoted"> = {};
  for (const candidate of batch.candidateInputs) {
    if (keepReferences.has(candidate.sourceReference)) continue;
    const related = proposals.filter((proposal) => proposal.sourceReferences.includes(candidate.sourceReference));
    if (related.some((proposal) => proposal.status === "approved" && ["project_memory", "long_term_memory", "merge_condense"].includes(proposal.destination))) resolutions[candidate.candidateId] = "promoted";
    else if (related.length > 0 && related.every((proposal) => proposal.status !== "pending")) resolutions[candidate.candidateId] = "dismissed";
  }
  return resolutions;
}

function keepPendingScopeIds(batch: DreamBatch): string[] {
  const keep = new Set(batch.synthesis!.proposals.filter((proposal) => proposal.status === "approved" && proposal.destination === "keep_pending").flatMap((proposal) => proposal.sourceScopeReferences));
  const referenced = new Set(batch.synthesis!.proposals.flatMap((proposal) => proposal.sourceReferences));
  for (const candidate of batch.candidateInputs) if (!referenced.has(candidate.sourceReference)) {
    const scope = batch.extractionScopes.find((item) => item.kind === candidate.scope && (item.kind === "project" ? item.projectId === candidate.projectId : item.threadId === candidate.threadId));
    const scopeReference = batch.synthesis!.scopeMap.find((item) => item.scopeId === scope?.id)?.scopeReference;
    if (scopeReference !== undefined) keep.add(scopeReference);
  }
  return [...keep].flatMap((reference) => batch.synthesis!.scopeMap.find((item) => item.scopeReference === reference)?.scopeId ?? []);
}

function opaqueDreamSource(batchId: string, reference: string): string { return `src_ref_${createHash("sha256").update(`${batchId}\0${reference}`).digest("hex").slice(0, 32)}`; }
function requiredBatch(store: DreamReviewStore, id: string): DreamBatch { const batch = store.load().batches.find((item) => item.id === id); if (batch === undefined) throw new Error("DREAM_BATCH_NOT_FOUND"); return batch; }
function atomicWrite(path: string, content: string): void { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; writeFileSync(temporary, content, "utf8"); try { renameSync(temporary, path); } catch (error) { rmSync(temporary, { force: true }); throw error; } }
function textDiff(label: string, before: string, after: string): string { if (before === after) return `--- ${label}\n+++ ${label}\n(no changes)\n`; const left = before.split(/\r?\n/u); const right = after.split(/\r?\n/u); let prefix = 0; while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1; return [`--- ${label}`, `+++ ${label}`, `@@ line ${prefix + 1} @@`, ...left.slice(prefix).map((line) => `-${line}`), ...right.slice(prefix).map((line) => `+${line}`), ""].join("\n"); }
