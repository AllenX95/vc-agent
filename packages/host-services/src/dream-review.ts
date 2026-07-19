import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  dreamReviewStateSchema,
  dreamScheduleMetadataSchema,
  type DreamBatch,
  type DreamCandidateInput,
  type DreamCarryover,
  type DreamDueProposal,
  type DreamProfileSnapshot,
  type DreamReviewState,
  type DreamScheduleMetadata,
  type DreamTrajectoryInput,
  type PendingDreamReminder,
  type SystemPromptRevision,
  type Thread,
  type TrajectoryEvent
} from "@vc-agent/contracts";
import type { MemoryCandidate } from "./project-memory.js";
import { selectEligibleReflectionTrajectory } from "./dream-eligibility.js";

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
      representedProjectIds,
      representedScopeCount: new Set(scopes).size,
      createdAt: now,
      updatedAt: now
    };
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
    const batches = state.batches.map((batch) => ({
      ...batch,
      trajectoryInputs: batch.trajectoryInputs.filter((item) => item.threadId !== threadId),
      candidateInputs: batch.candidateInputs.map((item) => item.threadId === threadId ? redactCandidate(item, deletedAt) : item),
      carryoverInputs: batch.carryoverInputs.map((item) => item.threadId === threadId ? redactCarryover(item, deletedAt) : item),
      updatedAt: batch.trajectoryInputs.some((item) => item.threadId === threadId) || batch.candidateInputs.some((item) => item.threadId === threadId) ? deletedAt : batch.updatedAt
    }));
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
