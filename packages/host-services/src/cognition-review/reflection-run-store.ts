import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  independentAssessmentSchema,
  providerFailureSchema,
  reflectionBriefSchema,
  reflectionRunSchema,
  type IndependentAssessment,
  type ModelProfile,
  type ProjectThread,
  type ProviderFailure,
  type ReflectionBrief,
  type ReflectionRun,
  type SystemPromptRevision,
  type Thread,
  type UnscopedThread
} from "@vc-agent/contracts";

/**
 * The small Host-owned seam needed by the Reflection workflow to create and
 * update task Threads.  Reflection metadata itself is intentionally kept in
 * cognition-v2 files rather than HostStateStore's retired reflection_runs
 * table.  The callbacks let the persistence adapter continue owning ordinary
 * Thread state without making Reflection a persistence concern again.
 */
export interface ReflectionRunThreadAdapter {
  createProjectThread(projectId: string, title: string): ProjectThread;
  createUnscopedThread(title: string): UnscopedThread;
  getThread(threadId: string): Thread | undefined;
  selectThreadProfile(threadId: string, profileId: string): Thread;
  setThreadOutputLocation?(threadId: string, outputLocation: string): UnscopedThread;
}

export interface ReflectionRunStoreOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
  /** Set false for inspection-only recovery/read-only projections. */
  readonly createRoot?: boolean;
}

export type ReflectionRunCreateInput = {
  readonly framing: "reflection" | "retrospective";
  readonly objective: string;
  readonly focus?: string;
  readonly promptRevision: SystemPromptRevision;
  readonly independentProfileId?: string;
  readonly launchOverrideProfileId?: string;
} & (
  | { readonly scope: "project"; readonly projectId: string; readonly brief: Extract<ReflectionBrief, { scope: "project" }> }
  | { readonly scope: "unscoped"; readonly sourceThreadId: string; readonly brief: Extract<ReflectionBrief, { scope: "unscoped" }> }
);

interface ReflectionRunFile {
  readonly schemaVersion: 1;
  readonly runs: readonly ReflectionRun[];
}

/**
 * Durable Reflection run state for cognition-v2.
 *
 * This adapter deliberately mirrors only the lifecycle operations required by
 * the Host.  It is not a second cognition commit path: final Judgment and
 * Learning publication still cross CognitionReviewModule.
 */
export class ReflectionRunStore {
  readonly #path: string;
  readonly #threads: ReflectionRunThreadAdapter;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #createRoot: boolean;

  constructor(path: string, threads: ReflectionRunThreadAdapter, options: ReflectionRunStoreOptions = {}) {
    this.#path = path;
    this.#threads = threads;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#createRoot = options.createRoot !== false;
  }

  get path(): string { return this.#path; }

  create(input: ReflectionRunCreateInput): ReflectionRun {
    const parsedBrief = reflectionBriefSchema.parse(input.brief);
    const title = input.framing === "retrospective" ? "Investment Retrospective" : "Investment Reflection";
    const thread = input.scope === "project"
      ? this.#threads.createProjectThread(input.projectId, title)
      : this.#createUnscopedThread(input.sourceThreadId, title);
    const now = this.#now().toISOString();
    const run = reflectionRunSchema.parse({
      schemaVersion: 1,
      id: this.#newId(),
      threadId: thread.id,
      scope: input.scope,
      ...(input.scope === "project" ? { projectId: input.projectId } : { sourceThreadId: input.sourceThreadId }),
      framing: input.framing,
      objective: input.objective,
      ...(input.focus?.trim() === undefined || input.focus.trim() === "" ? {} : { focus: input.focus.trim() }),
      status: input.independentProfileId === undefined ? "awaiting_profile" : "ready",
      brief: parsedBrief,
      promptSnapshot: { revisionId: input.promptRevision.id, hash: input.promptRevision.hash },
      ...(input.independentProfileId === undefined ? {} : { independentProfileId: input.independentProfileId }),
      ...(input.launchOverrideProfileId === undefined ? {} : { launchOverrideProfileId: input.launchOverrideProfileId }),
      createdAt: now,
      updatedAt: now
    });
    this.#upsert(run);
    return run;
  }

  list(projectId?: string): ReflectionRun[] {
    return this.#read().runs
      .filter((run) => projectId === undefined || (run.scope === "project" && run.projectId === projectId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  }

  get(id: string): ReflectionRun | undefined { return this.#read().runs.find((run) => run.id === id); }

  getByThread(threadId: string): ReflectionRun | undefined { return this.#read().runs.find((run) => run.threadId === threadId); }

  selectProfile(id: string, profileId: string, launchOverride: boolean): ReflectionRun {
    const run = this.#require(id);
    if (!["awaiting_profile", "independent_failed", "independent_interrupted", "ready"].includes(run.status)) throw new Error("REFLECTION_PROFILE_SELECTION_STALE");
    return this.#replace(run, {
      independentProfileId: profileId,
      ...(launchOverride ? { launchOverrideProfileId: profileId } : { launchOverrideProfileId: undefined }),
      status: "ready",
      failure: undefined
    });
  }

  markIndependentRunning(id: string): ReflectionRun {
    const run = this.#require(id);
    if (!["ready", "independent_failed", "independent_interrupted"].includes(run.status) || run.independentProfileId === undefined) throw new Error("REFLECTION_RUN_NOT_READY");
    return this.#replace(run, { status: "independent_running", failure: undefined });
  }

  setSessionFile(id: string, sessionFile: string): ReflectionRun {
    const run = this.#require(id);
    if (run.status !== "independent_running") throw new Error("REFLECTION_RUN_NOT_ACTIVE");
    return this.#replace(run, { sessionFile });
  }

  completeIndependent(id: string, assessment: IndependentAssessment): ReflectionRun {
    const run = this.#require(id);
    if (run.status !== "independent_running") throw new Error("REFLECTION_RUN_NOT_ACTIVE");
    const parsed = independentAssessmentSchema.parse(assessment);
    return this.#replace(run, { status: "independent_completed", assessment: parsed, failure: undefined });
  }

  failIndependent(id: string, failure: ProviderFailure): ReflectionRun {
    const run = this.#require(id);
    if (run.status !== "independent_running") throw new Error("REFLECTION_RUN_NOT_ACTIVE");
    return this.#replace(run, { status: "independent_failed", failure: providerFailureSchema.parse(failure) });
  }

  interruptIndependent(id: string): ReflectionRun {
    const run = this.#require(id);
    if (run.status !== "independent_running") throw new Error("REFLECTION_RUN_NOT_ACTIVE");
    return this.#replace(run, { status: "independent_interrupted" });
  }

  recoverInterrupted(): ReflectionRun[] {
    const active = this.#read().runs.filter((run) => run.status === "independent_running" || run.status === "memory_aware_running");
    const updated = this.#read().runs.map((run) => {
      if (run.status === "independent_running") return this.#withUpdatedAt(run, { status: "independent_interrupted" });
      if (run.status === "memory_aware_running") return this.#withUpdatedAt(run, { status: "memory_aware_interrupted" });
      return run;
    });
    if (active.length > 0) this.#write({ schemaVersion: 1, runs: updated });
    return active.map((run) => updated.find((candidate) => candidate.id === run.id)!).filter((run): run is ReflectionRun => run !== undefined);
  }

  startMemoryAware(id: string, profileId: string, initialTurnId: string): ReflectionRun {
    const run = this.#require(id);
    if (!["independent_completed", "memory_aware_failed", "memory_aware_interrupted"].includes(run.status) || run.assessment === undefined) throw new Error("REFLECTION_NOT_READY_FOR_DIALOGUE");
    // Keep ordinary Thread profile state in its existing persistence adapter;
    // this callback is the only cross-store action in the lifecycle adapter.
    this.#threads.selectThreadProfile(run.threadId, profileId);
    return this.#replace(run, { status: "memory_aware_running", memoryAwareProfileId: profileId, memoryInitialTurnId: initialTurnId, failure: undefined });
  }

  activateDialogue(id: string): ReflectionRun {
    const run = this.#require(id);
    if (run.status !== "memory_aware_running") throw new Error("REFLECTION_DIALOGUE_NOT_ACTIVE");
    return this.#replace(run, { status: "dialogue_active", failure: undefined });
  }

  /** Mark a Reflection terminal only after CognitionReviewModule.commit succeeds. */
  complete(id: string): ReflectionRun {
    const run = this.#require(id);
    if (run.status !== "dialogue_active") throw new Error("REFLECTION_NOT_COMPLETABLE");
    return this.#replace(run, { status: "completed" });
  }

  failMemoryAware(id: string, failure: ProviderFailure): ReflectionRun {
    const run = this.#require(id);
    if (run.status !== "memory_aware_running") throw new Error("REFLECTION_DIALOGUE_NOT_ACTIVE");
    return this.#replace(run, { status: "memory_aware_failed", failure: providerFailureSchema.parse(failure) });
  }

  interruptMemoryAware(id: string): ReflectionRun {
    const run = this.#require(id);
    if (run.status !== "memory_aware_running") throw new Error("REFLECTION_DIALOGUE_NOT_ACTIVE");
    return this.#replace(run, { status: "memory_aware_interrupted" });
  }

  discard(id: string): ReflectionRun {
    const run = this.#require(id);
    if (run.status === "independent_running" || run.status === "memory_aware_running") throw new Error("REFLECTION_ACTIVE_CANNOT_DISCARD");
    return this.#replace(run, { status: "discarded" });
  }

  #createUnscopedThread(sourceThreadId: string, title: string): UnscopedThread {
    const source = this.#threads.getThread(sourceThreadId);
    if (source?.scope !== "unscoped") throw new Error("REFLECTION_SOURCE_THREAD_NOT_FOUND");
    const thread = this.#threads.createUnscopedThread(title);
    if (source.activeProfileId !== undefined) this.#threads.selectThreadProfile(thread.id, source.activeProfileId);
    if (source.outputLocation !== undefined && this.#threads.setThreadOutputLocation !== undefined) this.#threads.setThreadOutputLocation(thread.id, source.outputLocation);
    return this.#threads.getThread(thread.id) as UnscopedThread;
  }

  #newId(): string {
    const candidate = this.#createId();
    // ReflectionRun's existing contract uses UUIDs.  A deterministic test
    // adapter may provide another identifier, so retain a valid fallback.
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate) ? candidate : randomUUID();
  }

  #require(id: string): ReflectionRun {
    const run = this.get(id);
    if (run === undefined) throw new Error("REFLECTION_RUN_NOT_FOUND");
    return run;
  }

  #replace(run: ReflectionRun, patch: Partial<ReflectionRun>): ReflectionRun {
    const updated = reflectionRunSchema.parse({ ...run, ...patch, updatedAt: this.#now().toISOString() });
    this.#upsert(updated);
    return updated;
  }

  #withUpdatedAt(run: ReflectionRun, patch: Partial<ReflectionRun>): ReflectionRun {
    return reflectionRunSchema.parse({ ...run, ...patch, updatedAt: this.#now().toISOString() });
  }

  #upsert(run: ReflectionRun): void {
    const current = this.#read().runs.filter((candidate) => candidate.id !== run.id);
    this.#write({ schemaVersion: 1, runs: [...current, run] });
  }

  #read(): ReflectionRunFile {
    if (!existsSync(this.#path)) return { schemaVersion: 1, runs: [] };
    const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as ReflectionRunFile;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.runs)) throw new Error("REFLECTION_RUN_STORE_INVALID");
    return { schemaVersion: 1, runs: parsed.runs.map((run) => reflectionRunSchema.parse(run)) };
  }

  #write(file: ReflectionRunFile): void {
    if (!this.#createRoot) throw new Error("REFLECTION_RUN_STORE_READ_ONLY");
    mkdirSync(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    try { renameSync(temporary, this.#path); }
    catch (error) { rmSync(temporary, { force: true }); throw error; }
  }
}

// Keep this import available to consumers that already model profile lookup
// through Host callbacks without widening the adapter's runtime dependency.
export type ReflectionRunProfile = Pick<ModelProfile, "id" | "provider" | "model">;
