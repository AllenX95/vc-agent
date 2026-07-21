import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  dreamReviewStateSchema,
  dreamScheduleMetadataSchema,
  type DreamBatch,
  type DreamCandidateInput,
  type DreamCarryover,
  type DreamExtractionScope,
  type DreamGlobalSynthesis,
  type DreamPreparedPatch,
  type DreamSynthesisProposal,
  type DreamDueProposal,
  type DreamProfileSnapshot,
  type DreamReviewState,
  type DreamScheduleMetadata,
  type DreamTrajectoryInput,
  type DreamScopeSummary,
  type ProviderFailure,
  type PendingDreamReminder,
  type SystemPromptRevision,
  type Thread,
  type TrajectoryEvent
} from "@vc-agent/contracts";
import type { MemoryCandidate } from "./project-memory.js";
import { selectEligibleReflectionTrajectory } from "./dream-eligibility.js";
import { buildDreamExtractionScopes, dreamScopeInputHash } from "./dream-extraction.js";

const DEFAULT_INTERVAL_DAYS = 7;

export interface DreamReviewStoreOptions {
  readonly now?: () => Date;
  readonly createRoot?: boolean;
}

export interface CreateDreamBatchInput {
  readonly promptRevision: SystemPromptRevision;
  readonly profile: DreamProfileSnapshot;
  readonly trajectory: readonly DreamTrajectoryInput[];
  readonly candidates: readonly MemoryCandidate[];
  readonly projectMemoryHashes?: Readonly<Record<string, string | undefined>>;
}

export class DreamReviewStore {
  readonly #root: string;
  readonly #path: string;
  readonly #schedulePath: string;
  readonly #now: () => Date;
  readonly #createRoot: boolean;

  constructor(root: string, options: DreamReviewStoreOptions = {}) {
    this.#root = root;
    this.#path = join(root, "review-state.json");
    this.#schedulePath = join(root, "schedule.json");
    this.#now = options.now ?? (() => new Date());
    this.#createRoot = options.createRoot !== false;
  }

  load(): DreamReviewState {
    if (!existsSync(this.#path)) return emptyState(this.#now().toISOString());
    return dreamReviewStateSchema.parse(JSON.parse(readFileSync(this.#path, "utf8")));
  }

  synchronizeSchedulingIndex(trajectory: readonly DreamTrajectoryInput[], candidates: readonly MemoryCandidate[]): DreamReviewState {
    const state = this.load();
    const eligibilityIndex = trajectory.map((item) => ({
      sourceReference: item.sourceReference,
      scope: item.scope,
      ...(item.projectId === undefined ? {} : { projectId: item.projectId }),
      threadId: item.threadId,
      completedAt: item.completedAt
    }));
    const candidateIndex = candidates.filter((candidate) => candidate.status === "active").map((candidate) => ({
      candidateId: candidate.id,
      scope: candidate.scope,
      ...(candidate.projectId === undefined ? {} : { projectId: candidate.projectId }),
      threadId: candidate.threadId,
      capturedAt: candidate.capturedAt
    }));
    const updated = this.#withSchedule({ ...state, eligibilityIndex, candidateIndex });
    this.#save(updated);
    return updated;
  }

  setReviewIntervalDays(reviewIntervalDays: number): DreamReviewState {
    if (!Number.isInteger(reviewIntervalDays) || reviewIntervalDays < 1 || reviewIntervalDays > 365) throw new Error("Dream review interval must be between 1 and 365 days");
    const state = this.load();
    const updated = this.#withSchedule({ ...state, schedule: { ...state.schedule, reviewIntervalDays } });
    this.#save(updated);
    return updated;
  }

  defer(until: string): DreamReviewState {
    const deferredUntil = new Date(until);
    if (Number.isNaN(deferredUntil.valueOf())) throw new Error("Invalid Dream reminder deferral");
    const state = this.load();
    const updated = { ...state, schedule: { ...state.schedule, deferredUntil: deferredUntil.toISOString(), updatedAt: this.#now().toISOString() } };
    this.#save(updated);
    return updated;
  }

  dueCheck(profile?: DreamProfileSnapshot): DreamDueProposal | undefined {
    const schedule = this.#loadSchedule();
    if (schedule.activeBatchId !== undefined || schedule.carryoverCount > 0) return undefined;
    if (schedule.pendingCandidateCount === 0 && schedule.eligibleSessionCount === 0) return undefined;
    const anchor = schedule.lastCompletedDreamAt ?? schedule.oldestUnresolvedAt;
    if (anchor === undefined) return undefined;
    const dueAt = addDays(anchor, schedule.reviewIntervalDays);
    const now = this.#now().toISOString();
    if (now < dueAt || (schedule.deferredUntil !== undefined && now < schedule.deferredUntil)) return undefined;
    return {
      kind: "due_proposal",
      dueAt,
      candidateCount: schedule.pendingCandidateCount,
      eligibleSessionCount: schedule.eligibleSessionCount,
      representedProjectCount: schedule.representedProjectIds.length,
      ...(schedule.lastCompletedDreamAt === undefined ? {} : { lastCompletedDreamAt: schedule.lastCompletedDreamAt }),
      ...(profile === undefined ? {} : { profile })
    };
  }

  pendingReminder(): PendingDreamReminder | undefined {
    const state = this.load();
    if (state.schedule.deferredUntil !== undefined && this.#now().toISOString() < state.schedule.deferredUntil) return undefined;
    const active = state.batches.find((batch) => batch.id === state.schedule.activeBatchId && !terminal(batch.status));
    if (active !== undefined) {
      return {
        kind: "resumable_run",
        batchId: active.id,
        affectedScopeCount: active.representedScopeCount,
        oldestUnresolvedAt: oldestDate([
          ...active.trajectoryInputs.map((item) => item.completedAt),
          ...active.candidateInputs.map((item) => item.occurredAt),
          ...active.carryoverInputs.map((item) => item.oldestUnresolvedAt)
        ]) ?? active.createdAt,
        lastSavedStage: active.currentStage
      };
    }
    if (state.carryover.length === 0) return undefined;
    return {
      kind: "carryover",
      affectedScopeCount: scopeCount(state.carryover),
      oldestUnresolvedAt: oldestDate(state.carryover.map((item) => item.oldestUnresolvedAt))!
    };
  }

  createBatch(input: CreateDreamBatchInput): DreamBatch {
    const state = this.load();
    const active = state.batches.find((batch) => batch.id === state.schedule.activeBatchId && !terminal(batch.status));
    if (active !== undefined) throw new Error("An existing Dream run must be resumed or discarded before creating another batch");
    const previous = state.schedule.lastCommittedCutoff;
    const eligibleTrajectory = input.trajectory
      .filter((item) => (previous === undefined || item.completedAt > previous))
      .sort((left, right) => left.completedAt.localeCompare(right.completedAt));
    const cutoff = eligibleTrajectory.at(-1)?.completedAt ?? state.schedule.latestEligibleCompletedAt ?? previous;
    if (cutoff === undefined && state.carryover.length === 0) throw new Error("Dream requires at least one eligible completed user-facing session");
    const effectiveCutoff = cutoff ?? state.carryover.reduce((latest, item) => item.oldestUnresolvedAt > latest ? item.oldestUnresolvedAt : latest, state.carryover[0]!.oldestUnresolvedAt);
    const candidateInputs = input.candidates
      .filter((candidate) => candidate.status === "active" && candidate.capturedAt <= effectiveCutoff && (previous === undefined || candidate.capturedAt > previous))
      .map(toCandidateInput);
    if (eligibleTrajectory.length === 0 && candidateInputs.length === 0 && state.carryover.length === 0) throw new Error("Dream has no eligible inputs inside the frozen cutoff");
    const now = this.#now().toISOString();
    const scopes = [
      ...eligibleTrajectory.map(scopeKey),
      ...candidateInputs.map(scopeKey),
      ...state.carryover.map(scopeKey)
    ];
    const representedProjectIds = [...new Set([
      ...eligibleTrajectory.flatMap((item) => item.projectId === undefined ? [] : [item.projectId]),
      ...candidateInputs.flatMap((item) => item.projectId === undefined ? [] : [item.projectId]),
      ...state.carryover.flatMap((item) => item.projectId === undefined ? [] : [item.projectId])
    ])];
    const batch: DreamBatch = {
      schemaVersion: 1,
      id: randomUUID(),
      status: "ready",
      currentStage: "batch_created",
      cutoff: effectiveCutoff,
      ...(previous === undefined ? {} : { previousCommittedCutoff: previous }),
      promptSnapshot: { revisionId: input.promptRevision.id, hash: input.promptRevision.hash },
      profileSnapshot: input.profile,
      trajectoryInputs: eligibleTrajectory.filter((item) => item.completedAt <= effectiveCutoff),
      candidateInputs,
      carryoverInputs: state.carryover,
      extractionScopes: [],
      partialCoverageScopeIds: [],
      representedProjectIds,
      representedScopeCount: new Set(scopes).size,
      createdAt: now,
      updatedAt: now
    };
    batch.extractionScopes = buildDreamExtractionScopes(batch, input.projectMemoryHashes ?? {}, now);
    const updated = this.#withSchedule({ ...state, batches: [...state.batches, batch], schedule: { ...state.schedule, activeBatchId: batch.id, deferredUntil: undefined } });
    this.#save(updated);
    return batch;
  }

  resume(batchId: string): DreamBatch {
    const state = this.load();
    const batch = state.batches.find((item) => item.id === batchId);
    if (batch === undefined || terminal(batch.status) || state.schedule.activeBatchId !== batch.id) throw new Error("Dream run is not resumable");
    const resumed = { ...batch, status: "ready" as const, updatedAt: this.#now().toISOString() };
    this.#save({ ...state, batches: replaceBatch(state.batches, resumed) });
    return resumed;
  }

  markResumable(batchId: string): DreamBatch {
    const state = this.load();
    const batch = state.batches.find((item) => item.id === batchId);
    if (batch === undefined || terminal(batch.status)) throw new Error("Dream run is not active");
    const resumable = { ...batch, status: "resumable" as const, updatedAt: this.#now().toISOString() };
    this.#save({ ...state, batches: replaceBatch(state.batches, resumable) });
    return resumable;
  }

  startScope(batchId: string, scopeId: string, currentProjectMemoryHash?: string): DreamExtractionScope {
    const state = this.load();
    const batch = activeBatch(state, batchId);
    const scope = requiredScope(batch, scopeId);
    if (["running", "approved", "skipped"].includes(scope.status)) throw new Error("Dream extraction scope cannot be started in its current state");
    const expectedHash = dreamScopeInputHash({ id: scope.id, sourceReferences: scope.sourceReferences, projectMemoryHash: currentProjectMemoryHash });
    const now = this.#now().toISOString();
    if (expectedHash !== scope.inputHash) {
      const stale = { ...scope, status: "stale" as const, projectMemoryHash: currentProjectMemoryHash, inputHash: expectedHash, result: undefined, failure: undefined, updatedAt: now };
      this.#save({ ...state, batches: replaceBatch(state.batches, replaceScope(batch, stale, "review_pending", "scope_review")) });
      throw new Error("Dream extraction scope is stale and must be explicitly resumed again");
    }
    const running = { ...scope, status: "running" as const, attemptCount: scope.attemptCount + 1, startedAt: now, failure: undefined, updatedAt: now };
    this.#save({ ...state, batches: replaceBatch(state.batches, replaceScope(batch, running, "running", "scope_extraction")) });
    return running;
  }

  completeScope(batchId: string, scopeId: string, result: DreamScopeSummary): DreamExtractionScope {
    const state = this.load();
    const batch = activeBatch(state, batchId);
    const scope = requiredScope(batch, scopeId);
    if (scope.status !== "running") throw new Error("Dream extraction scope is not running");
    if (result.scopeKind !== scope.kind) throw new Error("Dream extraction result changed scope");
    const now = this.#now().toISOString();
    const completed = { ...scope, status: "succeeded" as const, result, failure: undefined, completedAt: now, updatedAt: now };
    this.#save({ ...state, batches: replaceBatch(state.batches, replaceScope(batch, completed, "review_pending", "scope_review")) });
    return completed;
  }

  failScope(batchId: string, scopeId: string, failure: ProviderFailure): DreamExtractionScope {
    const state = this.load();
    const batch = activeBatch(state, batchId);
    const scope = requiredScope(batch, scopeId);
    if (scope.status !== "running") throw new Error("Dream extraction scope is not running");
    const now = this.#now().toISOString();
    const failed = { ...scope, status: "failed" as const, failure: sanitizeDreamFailure(failure), updatedAt: now };
    this.#save({ ...state, batches: replaceBatch(state.batches, replaceScope(batch, failed, "review_pending", "scope_review")) });
    return failed;
  }

  reviewScope(batchId: string, scopeId: string, decision: "approve" | "skip" | "keep_pending"): DreamExtractionScope {
    const state = this.load();
    const batch = activeBatch(state, batchId);
    const scope = requiredScope(batch, scopeId);
    if (decision === "approve" && scope.status !== "succeeded") throw new Error("Only a successful Dream scope can be approved");
    if (decision === "keep_pending" && scope.result === undefined) throw new Error("Keep Pending requires a successful Dream scope result");
    if (decision === "skip" && !["succeeded", "failed"].includes(scope.status)) throw new Error("Only a completed or failed Dream scope can be skipped");
    const now = this.#now().toISOString();
    const reviewed = { ...scope, status: decision === "approve" ? "approved" as const : decision === "skip" ? "skipped" as const : "keep_pending" as const, reviewedAt: now, updatedAt: now };
    const extractionScopes = batch.extractionScopes.map((item) => item.id === reviewed.id ? reviewed : item);
    const allCovered = extractionScopes.every((item) => item.status === "approved" || item.status === "skipped");
    const partialCoverageScopeIds = extractionScopes.filter((item) => item.status === "skipped").map((item) => item.id);
    const nextBatch = { ...batch, extractionScopes, partialCoverageScopeIds, status: allCovered ? "synthesis_pending" as const : "review_pending" as const, currentStage: allCovered ? "global_synthesis" as const : "scope_review" as const, updatedAt: now };
    const existingOtherScopeCarryover = state.carryover.filter((item) => !sameScope(item, reviewed));
    const carryover = decision === "skip" || decision === "keep_pending"
      ? [...existingOtherScopeCarryover, ...scopeCarryoverRecords(batch, reviewed, now, decision === "skip" ? "skipped" : "keep_pending")]
      : existingOtherScopeCarryover;
    this.#save(this.#withSchedule({ ...state, batches: replaceBatch(state.batches, nextBatch), carryover }));
    return reviewed;
  }

  synthesisReadiness(batchId: string): { ready: boolean; partialCoverageScopeIds: string[]; blockingScopeIds: string[] } {
    const batch = this.load().batches.find((item) => item.id === batchId);
    if (batch === undefined) throw new Error("Dream batch not found");
    const blockingScopeIds = batch.extractionScopes.filter((scope) => scope.status !== "approved" && scope.status !== "skipped").map((scope) => scope.id);
    return { ready: blockingScopeIds.length === 0, partialCoverageScopeIds: [...batch.partialCoverageScopeIds], blockingScopeIds };
  }

  beginSynthesis(batchId: string): DreamBatch {
    const state = this.load();
    const batch = activeBatch(state, batchId);
    const readiness = this.synthesisReadiness(batchId);
    if (!readiness.ready) throw new Error("DREAM_SYNTHESIS_BLOCKED_BY_SCOPE_REVIEW");
    if (batch.synthesis !== undefined && batch.synthesis.status !== "stale") throw new Error("DREAM_SYNTHESIS_ALREADY_EXISTS");
    const running = { ...batch, status: "running" as const, currentStage: "global_synthesis" as const, synthesisFailure: undefined, preparedPatch: undefined, updatedAt: this.#now().toISOString() };
    this.#save({ ...state, batches: replaceBatch(state.batches, running) });
    return running;
  }

  completeSynthesis(batchId: string, synthesis: DreamGlobalSynthesis): DreamBatch {
    const state = this.load();
    const batch = activeBatch(state, batchId);
    if (batch.status !== "running" || batch.currentStage !== "global_synthesis") throw new Error("DREAM_SYNTHESIS_NOT_RUNNING");
    const completed = { ...batch, status: "synthesis_pending" as const, synthesis, synthesisFailure: undefined, preparedPatch: undefined, updatedAt: this.#now().toISOString() };
    this.#save({ ...state, batches: replaceBatch(state.batches, completed) });
    return completed;
  }

  failSynthesis(batchId: string, failure: ProviderFailure): DreamBatch {
    const state = this.load();
    const batch = activeBatch(state, batchId);
    if (batch.currentStage !== "global_synthesis") throw new Error("DREAM_SYNTHESIS_NOT_ACTIVE");
    const failed = { ...batch, status: "resumable" as const, synthesisFailure: sanitizeDreamFailure(failure), updatedAt: this.#now().toISOString() };
    this.#save({ ...state, batches: replaceBatch(state.batches, failed) });
    return failed;
  }

  reviewSynthesisProposals(batchId: string, updates: readonly { proposalId: string; decision: "approve" | "reject"; destination?: DreamSynthesisProposal["destination"] }[]): DreamBatch {
    const state = this.load();
    const batch = activeBatch(state, batchId);
    if (batch.synthesis === undefined || batch.synthesis.status === "stale") throw new Error("DREAM_SYNTHESIS_NOT_REVIEWABLE");
    const updateById = new Map(updates.map((update) => [update.proposalId, update]));
    if (updateById.size !== updates.length) throw new Error("DUPLICATE_DREAM_PROPOSAL_REVIEW");
    const proposals = batch.synthesis.proposals.map((proposal) => {
      const update = updateById.get(proposal.id);
      if (update === undefined) return proposal;
      const destination = update.destination ?? proposal.destination;
      const changed = changeProposalDestination(batch, proposal, destination);
      return { ...changed, status: update.decision === "approve" ? "approved" as const : "rejected" as const };
    });
    if ([...updateById.keys()].some((id) => !proposals.some((proposal) => proposal.id === id))) throw new Error("DREAM_PROPOSAL_NOT_FOUND");
    const allReviewed = proposals.every((proposal) => proposal.status !== "pending");
    const now = this.#now().toISOString();
    const synthesis = { ...batch.synthesis, proposals, status: allReviewed ? "reviewed" as const : "review_pending" as const, ...(allReviewed ? { reviewedAt: now } : {}), staleAt: undefined };
    const reviewed = { ...batch, synthesis, status: allReviewed ? "patch_pending" as const : "synthesis_pending" as const, currentStage: allReviewed ? "patch_preparation" as const : "global_synthesis" as const, preparedPatch: undefined, updatedAt: now };
    this.#save({ ...state, batches: replaceBatch(state.batches, reviewed) });
    return reviewed;
  }

  setPreparedPatch(batchId: string, patch: DreamPreparedPatch): DreamBatch {
    const state = this.load();
    const batch = activeBatch(state, batchId);
    if (batch.synthesis?.status !== "reviewed" || patch.synthesisId !== batch.synthesis.id) throw new Error("DREAM_SYNTHESIS_NOT_READY_FOR_PATCH");
    const prepared = { ...batch, status: "patch_pending" as const, currentStage: "patch_preparation" as const, preparedPatch: patch, updatedAt: this.#now().toISOString() };
    this.#save({ ...state, batches: replaceBatch(state.batches, prepared) });
    return prepared;
  }

  discardPreparedPatch(batchId: string, patchId: string): DreamBatch {
    const state = this.load();
    const batch = activeBatch(state, batchId);
    if (batch.preparedPatch?.id !== patchId || batch.preparedPatch.status !== "prepared") throw new Error("DREAM_PATCH_NOT_PREPARED");
    const preparedPatch = { ...batch.preparedPatch, status: "discarded" as const };
    const updated = { ...batch, preparedPatch, status: "patch_pending" as const, currentStage: "patch_preparation" as const, updatedAt: this.#now().toISOString() };
    this.#save({ ...state, batches: replaceBatch(state.batches, updated) });
    return updated;
  }

  markSynthesisStale(batchId: string): DreamBatch {
    const state = this.load();
    const batch = activeBatch(state, batchId);
    if (batch.synthesis === undefined || batch.synthesis.status === "stale") return batch;
    const now = this.#now().toISOString();
    const synthesis = { ...batch.synthesis, status: "stale" as const, staleAt: now };
    const preparedPatch = batch.preparedPatch === undefined ? undefined : { ...batch.preparedPatch, status: "stale" as const, staleAt: now };
    const stale = { ...batch, synthesis, preparedPatch, status: "synthesis_pending" as const, currentStage: "global_synthesis" as const, updatedAt: now };
    this.#save({ ...state, batches: replaceBatch(state.batches, stale) });
    return stale;
  }

  completionFiles(batchId: string, patchId: string, keepPendingScopeIds: readonly string[], resolvedCandidateIds: readonly string[]): Array<{ path: string; baseHash: string; resultContent: string }> {
    const state = this.load();
    const batch = activeBatch(state, batchId);
    if (batch.preparedPatch?.id !== patchId || batch.preparedPatch.status !== "prepared") throw new Error("DREAM_PATCH_NOT_PREPARED");
    const now = this.#now().toISOString();
    let carryover = state.carryover;
    for (const scopeId of keepPendingScopeIds) {
      const scope = requiredScope(batch, scopeId);
      carryover = [...carryover.filter((item) => !sameScope(item, scope)), ...scopeCarryoverRecords(batch, scope, now, "keep_pending")];
    }
    const committedPatch = { ...batch.preparedPatch, status: "committed" as const, committedAt: now };
    const completed = { ...batch, status: "completed" as const, currentStage: "completed" as const, preparedPatch: committedPatch, completedAt: now, updatedAt: now };
    const updated = this.#withSchedule({
      ...state,
      batches: replaceBatch(state.batches, completed),
      carryover,
      candidateIndex: state.candidateIndex.filter((item) => !resolvedCandidateIds.includes(item.candidateId)),
      schedule: { ...state.schedule, activeBatchId: undefined, lastCompletedDreamAt: now, lastCommittedCutoff: batch.cutoff, deferredUntil: undefined }
    });
    const stateContent = `${JSON.stringify(updated, null, 2)}\n`;
    const scheduleContent = `${JSON.stringify(updated.schedule, null, 2)}\n`;
    return [
      { path: this.#path, baseHash: stateHash(this.#path, read(this.#path)), resultContent: stateContent },
      { path: this.#schedulePath, baseHash: stateHash(this.#schedulePath, read(this.#schedulePath)), resultContent: scheduleContent }
    ];
  }

  recoverInterruptedScopes(): DreamReviewState {
    const state = this.load();
    const now = this.#now().toISOString();
    let changed = false;
    const batches = state.batches.map((batch) => {
      let batchChanged = batch.status === "running" && batch.currentStage === "global_synthesis";
      if (batchChanged) changed = true;
      const extractionScopes = batch.extractionScopes.map((scope) => {
        if (scope.status !== "running") return scope;
        changed = true;
        batchChanged = true;
        return {
          ...scope,
          status: "failed" as const,
          failure: { kind: "worker" as const, code: "APPLICATION_RESTART", message: "Dream scope extraction was interrupted by application restart and remains Pending for explicit retry.", provider: batch.profileSnapshot.provider, model: batch.profileSnapshot.model },
          updatedAt: now
        };
      });
      if (!batchChanged) return batch;
      return batch.currentStage === "global_synthesis"
        ? { ...batch, extractionScopes, status: "resumable" as const, synthesisFailure: { kind: "worker" as const, code: "APPLICATION_RESTART", message: "Global Dream Synthesis was interrupted by application restart and requires explicit retry.", provider: batch.profileSnapshot.provider, model: batch.profileSnapshot.model }, updatedAt: now }
        : { ...batch, extractionScopes, status: "resumable" as const, currentStage: "scope_review" as const, updatedAt: now };
    });
    if (!changed) return state;
    const updated = { ...state, batches };
    this.#save(updated);
    return updated;
  }

  revalidateProjectMemory(projectMemoryHashes: Readonly<Record<string, string | undefined>>): DreamReviewState {
    const state = this.load();
    const now = this.#now().toISOString();
    let changed = false;
    const batches = state.batches.map((batch) => {
      if (terminal(batch.status)) return batch;
      let batchChanged = false;
      const extractionScopes = batch.extractionScopes.map((scope) => {
        if (scope.kind !== "project" || scope.status === "running") return scope;
        const projectMemoryHash = projectMemoryHashes[scope.projectId!];
        if (projectMemoryHash === scope.projectMemoryHash) return scope;
        changed = true;
        batchChanged = true;
        const inputHash = dreamScopeInputHash({ id: scope.id, sourceReferences: scope.sourceReferences, projectMemoryHash });
        if (scope.result === undefined) return { ...scope, projectMemoryHash, inputHash, updatedAt: now };
        return { ...scope, status: "stale" as const, projectMemoryHash, inputHash, reviewedAt: undefined, updatedAt: now };
      });
      return batchChanged ? { ...batch, extractionScopes, status: "resumable" as const, currentStage: "scope_review" as const, updatedAt: now } : batch;
    });
    if (!changed) return state;
    const updated = { ...state, batches };
    this.#save(updated);
    return updated;
  }

  discard(batchId: string): DreamBatch {
    const state = this.load();
    const batch = state.batches.find((item) => item.id === batchId);
    if (batch === undefined || terminal(batch.status)) throw new Error("Dream run is not discardable");
    const now = this.#now().toISOString();
    const discarded = { ...batch, status: "discarded" as const, currentStage: "discarded" as const, discardedAt: now, updatedAt: now };
    this.#save(this.#withSchedule({ ...state, batches: replaceBatch(state.batches, discarded), schedule: { ...state.schedule, activeBatchId: undefined } }));
    return discarded;
  }

  complete(batchId: string, carryover: readonly DreamCarryover[]): DreamBatch {
    const state = this.load();
    const batch = state.batches.find((item) => item.id === batchId);
    if (batch === undefined || terminal(batch.status)) throw new Error("Dream run is not completable");
    const now = this.#now().toISOString();
    const completed = { ...batch, status: "completed" as const, currentStage: "completed" as const, completedAt: now, updatedAt: now };
    this.#save(this.#withSchedule({
      ...state,
      batches: replaceBatch(state.batches, completed),
      carryover: [...carryover],
      schedule: { ...state.schedule, activeBatchId: undefined, lastCompletedDreamAt: now, lastCommittedCutoff: batch.cutoff, deferredUntil: undefined }
    }));
    return completed;
  }

  redactThreadSources(threadId: string): DreamReviewState {
    const state = this.load();
    const deletedAt = this.#now().toISOString();
    const batches = state.batches.map((batch) => {
      const affected = batch.trajectoryInputs.some((item) => item.threadId === threadId) || batch.candidateInputs.some((item) => item.threadId === threadId) || batch.carryoverInputs.some((item) => item.threadId === threadId);
      if (!affected) return batch;
      const trajectoryInputs = batch.trajectoryInputs.filter((item) => item.threadId !== threadId);
      const candidateInputs = batch.candidateInputs.map((item) => item.threadId === threadId ? redactCandidate(item, deletedAt) : item);
      const carryoverInputs = batch.carryoverInputs.map((item) => item.threadId === threadId ? redactCarryover(item, deletedAt) : item);
      const extractionScopes = batch.extractionScopes.map((scope) => {
        const scopeAffected = scope.kind === "unscoped" ? scope.threadId === threadId : batch.trajectoryInputs.some((item) => item.threadId === threadId && item.projectId === scope.projectId) || batch.candidateInputs.some((item) => item.threadId === threadId && item.projectId === scope.projectId);
        if (!scopeAffected) return scope;
        const sourceReferences = sourceReferencesForScope({ trajectoryInputs, candidateInputs, carryoverInputs }, scope);
        const inputHash = dreamScopeInputHash({ id: scope.id, sourceReferences, projectMemoryHash: scope.projectMemoryHash });
        return { ...scope, status: "stale" as const, result: undefined, failure: undefined, sourceReferences, inputHash, updatedAt: deletedAt };
      });
      return { ...batch, trajectoryInputs, candidateInputs, carryoverInputs, extractionScopes, status: "resumable" as const, currentStage: "scope_review" as const, updatedAt: deletedAt };
    });
    const carryover = state.carryover.map((item) => item.threadId === threadId ? redactCarryover(item, deletedAt) : item);
    const updated = this.#withSchedule({
      ...state,
      batches,
      carryover,
      eligibilityIndex: state.eligibilityIndex.filter((item) => item.threadId !== threadId),
      candidateIndex: state.candidateIndex.filter((item) => item.threadId !== threadId)
    });
    this.#save(updated);
    return updated;
  }

  #withSchedule(state: DreamReviewState): DreamReviewState {
    const afterCutoff = (value: string) => state.schedule.lastCommittedCutoff === undefined || value > state.schedule.lastCommittedCutoff;
    const eligibility = state.eligibilityIndex.filter((item) => afterCutoff(item.completedAt));
    const candidates = state.candidateIndex.filter((item) => afterCutoff(item.capturedAt));
    const unresolvedDates = [
      ...eligibility.map((item) => item.completedAt),
      ...candidates.map((item) => item.capturedAt),
      ...state.carryover.map((item) => item.oldestUnresolvedAt)
    ];
    return dreamReviewStateSchema.parse({
      ...state,
      schedule: {
        ...state.schedule,
        pendingCandidateCount: candidates.length,
        eligibleSessionCount: eligibility.length,
        representedProjectIds: [...new Set([
          ...eligibility.flatMap((item) => item.projectId === undefined ? [] : [item.projectId]),
          ...candidates.flatMap((item) => item.projectId === undefined ? [] : [item.projectId]),
          ...state.carryover.flatMap((item) => item.projectId === undefined ? [] : [item.projectId])
        ])],
        ...(oldestDate(unresolvedDates) === undefined ? { oldestUnresolvedAt: undefined } : { oldestUnresolvedAt: oldestDate(unresolvedDates) }),
        ...(eligibility.at(-1) === undefined ? { latestEligibleCompletedAt: undefined } : { latestEligibleCompletedAt: [...eligibility].sort((a, b) => a.completedAt.localeCompare(b.completedAt)).at(-1)!.completedAt }),
        carryoverCount: state.carryover.length,
        updatedAt: this.#now().toISOString()
      }
    });
  }

  #save(state: DreamReviewState): void {
    if (!this.#createRoot) throw new Error("Dream review state is read-only");
    mkdirSync(this.#root, { recursive: true });
    const parsed = dreamReviewStateSchema.parse(state);
    this.#atomicWrite(this.#path, parsed);
    this.#atomicWrite(this.#schedulePath, parsed.schedule);
  }

  #loadSchedule(): DreamScheduleMetadata {
    if (!existsSync(this.#schedulePath)) return emptyState(this.#now().toISOString()).schedule;
    return dreamScheduleMetadataSchema.parse(JSON.parse(readFileSync(this.#schedulePath, "utf8")));
  }

  #atomicWrite(path: string, value: unknown): void {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try { renameSync(temporary, path); }
    catch (error) { rmSync(temporary, { force: true }); throw error; }
  }
}

export function selectEligibleDreamTrajectory(
  threads: readonly Thread[],
  eventsByThread: ReadonlyMap<string, readonly TrajectoryEvent[]>,
  reflectionThreadIds: ReadonlySet<string>,
  excludedThreadIds: ReadonlySet<string> = new Set()
): DreamTrajectoryInput[] {
  const selected: DreamTrajectoryInput[] = [];
  for (const thread of threads) {
    if (excludedThreadIds.has(thread.id)) continue;
    const events = eventsByThread.get(thread.id) ?? [];
    if (reflectionThreadIds.has(thread.id)) {
      selected.push(...selectEligibleReflectionTrajectory(events).map((item) => ({
        sourceKind: "reflection_dialogue" as const,
        reflectionSignal: item.signal,
        scope: thread.scope,
        ...(thread.scope === "project" ? { projectId: thread.projectId } : {}),
        threadId: item.threadId,
        turnId: item.turnId,
        completedAt: item.completedAt,
        sourceReference: item.sourceReference,
        userText: item.userText.slice(0, 200_000),
        assistantText: item.assistantText.slice(0, 200_000)
      })));
      continue;
    }
    const submitted = new Map(events.filter((event): event is Extract<TrajectoryEvent, { event: "turn.submitted" }> => event.event === "turn.submitted").map((event) => [event.turnId, event]));
    for (const completion of events.filter((event): event is Extract<TrajectoryEvent, { event: "turn.completed" }> => event.event === "turn.completed")) {
      const user = submitted.get(completion.turnId);
      if (user === undefined) continue;
      selected.push({
        sourceKind: "ordinary_dialogue",
        scope: thread.scope,
        ...(thread.scope === "project" ? { projectId: thread.projectId } : {}),
        threadId: thread.id,
        turnId: completion.turnId,
        completedAt: completion.occurredAt,
        sourceReference: `thread:${thread.id}/turn:${completion.turnId}`,
        userText: user.payload.text.slice(0, 200_000),
        assistantText: completion.payload.message.slice(0, 200_000)
      });
    }
  }
  return selected.sort((left, right) => left.completedAt.localeCompare(right.completedAt) || left.sourceReference.localeCompare(right.sourceReference));
}

function emptyState(now: string): DreamReviewState {
  return {
    schemaVersion: 1,
    schedule: {
      schemaVersion: 1,
      reviewIntervalDays: DEFAULT_INTERVAL_DAYS,
      pendingCandidateCount: 0,
      eligibleSessionCount: 0,
      representedProjectIds: [],
      carryoverCount: 0,
      updatedAt: now
    },
    batches: [],
    carryover: [],
    eligibilityIndex: [],
    candidateIndex: []
  };
}

function toCandidateInput(candidate: MemoryCandidate): DreamCandidateInput {
  return {
    candidateId: candidate.id,
    origin: "captured",
    scope: candidate.scope,
    ...(candidate.projectId === undefined ? {} : { projectId: candidate.projectId }),
    threadId: candidate.threadId,
    turnId: candidate.turnId,
    occurredAt: candidate.capturedAt,
    sourceKind: candidate.sourceKind,
    signal: candidate.signal,
    sourceReference: candidate.sourceReference,
    sourceStatus: "available",
    sourceText: candidate.sourceSnippet
  };
}

function redactCandidate(candidate: DreamCandidateInput, deletedAt: string): DreamCandidateInput {
  const { sourceText: _sourceText, ...metadata } = candidate;
  return { ...metadata, sourceStatus: "source_deleted", sourceDeletedAt: deletedAt };
}

function redactCarryover(carryover: DreamCarryover, deletedAt: string): DreamCarryover {
  const { sourceText: _sourceText, ...metadata } = carryover;
  return { ...metadata, sourceStatus: "source_deleted", sourceDeletedAt: deletedAt };
}

function terminal(status: DreamBatch["status"]): boolean {
  return status === "completed" || status === "discarded";
}

function replaceBatch(batches: readonly DreamBatch[], replacement: DreamBatch): DreamBatch[] {
  return batches.map((batch) => batch.id === replacement.id ? replacement : batch);
}

function scopeKey(item: { readonly scope: "project" | "unscoped"; readonly projectId?: string | undefined; readonly threadId?: string | undefined }): string {
  return item.scope === "project" ? `project:${item.projectId}` : `unscoped:${item.threadId}`;
}

function scopeCount(items: readonly { readonly scope: "project" | "unscoped"; readonly projectId?: string | undefined; readonly threadId?: string | undefined }[]): number {
  return new Set(items.map(scopeKey)).size;
}

function oldestDate(values: readonly string[]): string | undefined {
  return [...values].sort().at(0);
}

function addDays(value: string, days: number): string {
  return new Date(new Date(value).valueOf() + days * 24 * 60 * 60 * 1_000).toISOString();
}

function read(path: string): string { return existsSync(path) ? readFileSync(path, "utf8") : ""; }
function stateHash(path: string, content: string): string { return existsSync(path) ? createHash("sha256").update(content).digest("hex") : "missing"; }

function activeBatch(state: DreamReviewState, batchId: string): DreamBatch {
  const batch = state.batches.find((item) => item.id === batchId);
  if (batch === undefined || terminal(batch.status) || state.schedule.activeBatchId !== batch.id) throw new Error("Dream run is not active");
  return batch;
}

function requiredScope(batch: DreamBatch, scopeId: string): DreamExtractionScope {
  const scope = batch.extractionScopes.find((item) => item.id === scopeId);
  if (scope === undefined) throw new Error("Dream extraction scope not found");
  return scope;
}

function replaceScope(batch: DreamBatch, replacement: DreamExtractionScope, status: DreamBatch["status"], currentStage: DreamBatch["currentStage"]): DreamBatch {
  return { ...batch, status, currentStage, extractionScopes: batch.extractionScopes.map((scope) => scope.id === replacement.id ? replacement : scope), updatedAt: replacement.updatedAt };
}

function sanitizeDreamFailure(failure: ProviderFailure): ProviderFailure {
  return { ...failure, message: failure.message.replace(/(?:api[_ -]?key|token|credential)\s*[:=]\s*\S+/giu, "[redacted]").slice(0, 1_200) };
}

function scopeCarryoverRecords(batch: DreamBatch, scope: DreamExtractionScope, now: string, reason: "skipped" | "keep_pending"): DreamCarryover[] {
  const base = { sourceBatchId: batch.id, scope: scope.kind, ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }), reason, sourceStatus: "available" as const };
  const candidates: DreamCarryover[] = batch.candidateInputs.filter((item) => sameScope(item, scope)).map((item) => ({
    ...base, id: randomUUID(), kind: "candidate", threadId: item.threadId, candidateId: item.candidateId,
    sourceReference: item.sourceReference, oldestUnresolvedAt: item.occurredAt,
    ...(item.sourceText === undefined ? {} : { sourceText: item.sourceText.slice(0, 2_000) })
  }));
  const candidateReferences = new Set(candidates.map((item) => item.sourceReference));
  const trajectory: DreamCarryover[] = batch.trajectoryInputs.filter((item) => sameScope(item, scope) && !candidateReferences.has(item.sourceReference)).map((item) => ({
    ...base, id: randomUUID(), kind: "trajectory_scope", threadId: item.threadId,
    sourceReference: item.sourceReference, oldestUnresolvedAt: item.completedAt,
    sourceText: `${item.userText}\n\nAssistant response:\n${item.assistantText}`.slice(0, 2_000)
  }));
  const prior = batch.carryoverInputs.filter((item) => sameScope(item, scope) && !candidateReferences.has(item.sourceReference)).map((item) => ({
    ...item, id: randomUUID(), sourceBatchId: batch.id, reason, oldestUnresolvedAt: item.oldestUnresolvedAt || now
  }));
  return [...new Map([...prior, ...trajectory, ...candidates].map((item) => [item.sourceReference, item])).values()];
}

function sameScope(item: { scope: "project" | "unscoped"; projectId?: string | undefined; threadId?: string | undefined }, scope: DreamExtractionScope): boolean {
  return scope.kind === "project" ? item.scope === "project" && item.projectId === scope.projectId : item.scope === "unscoped" && item.threadId === scope.threadId;
}

function sourceReferencesForScope(
  batch: Pick<DreamBatch, "trajectoryInputs" | "candidateInputs" | "carryoverInputs">,
  scope: DreamExtractionScope
): string[] {
  const matches = (item: { scope: "project" | "unscoped"; projectId?: string | undefined; threadId?: string | undefined }) => scope.kind === "project"
    ? item.scope === "project" && item.projectId === scope.projectId
    : item.scope === "unscoped" && item.threadId === scope.threadId;
  return [...new Set([
    ...batch.trajectoryInputs.filter(matches).map((item) => item.sourceReference),
    ...batch.candidateInputs.filter(matches).map((item) => item.sourceReference),
    ...batch.carryoverInputs.filter(matches).map((item) => item.sourceReference)
  ])].sort();
}

function changeProposalDestination(batch: DreamBatch, proposal: DreamSynthesisProposal, destination: DreamSynthesisProposal["destination"]): DreamSynthesisProposal {
  if (destination === proposal.destination) return proposal;
  if (destination === "project_memory") {
    const sourceScopeIds = proposal.sourceScopeReferences.map((reference) => batch.synthesis!.scopeMap.find((item) => item.scopeReference === reference)?.scopeId);
    const scopes = sourceScopeIds.map((id) => batch.extractionScopes.find((scope) => scope.id === id));
    if (scopes.length !== 1 || scopes[0]?.kind !== "project") throw new Error("DREAM_PROJECT_MEMORY_SCOPE_AMBIGUOUS");
    if (proposal.learning === undefined) throw new Error("DREAM_MEMORY_PROPOSAL_REQUIRES_LEARNING");
    return { ...proposal, destination, memoryAction: undefined, targetEntryIds: [] };
  }
  if (destination === "long_term_memory") {
    if (proposal.learning === undefined) throw new Error("DREAM_MEMORY_PROPOSAL_REQUIRES_LEARNING");
    if (!proposal.comparisonSummary.trim()) throw new Error("DREAM_LONG_TERM_COMPARISON_REQUIRED");
    return { ...proposal, destination, memoryAction: "add", targetEntryIds: [] };
  }
  if (destination === "merge_condense") {
    if (proposal.learning === undefined || proposal.targetEntryIds.length < 2) throw new Error("DREAM_MERGE_TARGETS_REQUIRED");
    return { ...proposal, destination, memoryAction: "merge_condense" };
  }
  return { ...proposal, destination, memoryAction: undefined, targetEntryIds: [] };
}
