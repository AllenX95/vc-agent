import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, normalize, resolve, sep } from "node:path";
import {
  subAgentAttemptSchema,
  subAgentProjectionSchema,
  subAgentRunSchema,
  subAgentTaskInputSchema,
  subAgentTaskSchema,
  type SubAgentAttempt,
  type SubAgentCapability,
  type SubAgentExplicitIntentEvidence,
  type SubAgentFailure,
  type SubAgentHandoff,
  type SubAgentProfileSnapshot,
  type SubAgentProjection,
  type SubAgentRole,
  type SubAgentRun,
  type SubAgentTask,
  type SubAgentTaskInput,
  type SubAgentUsage
} from "@vc-agent/contracts";
import type { BoundedExecutionScheduler, ModelExecutionLease } from "./execution-scheduler.js";
import type { SubAgentContextBundle } from "./sub-agent-context.js";
import { estimateTokens } from "./system-prompt.js";

export interface SubAgentExecutionInput {
  readonly run: SubAgentRun;
  readonly task: SubAgentTask;
  readonly attempt: SubAgentAttempt;
  readonly signal: AbortSignal;
}

export interface SubAgentExecutionResult {
  readonly assistantMessage: string;
  readonly usage: SubAgentUsage;
  readonly handoff?: SubAgentHandoff;
  readonly toolEvents?: readonly { capability: string; status: "started" | "completed" | "failed" | "rejected"; summary: string }[];
  readonly contextHash?: string;
}

export interface SubAgentProviderExecutionInput {
  readonly attemptId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly parentThreadId: string;
  readonly parentTurnId: string;
  readonly profile: SubAgentProfileSnapshot;
  readonly prompt: string;
  readonly contextBoundary: SubAgentTask["contextBoundary"];
  readonly capabilitySet: readonly SubAgentCapability[];
  readonly contextBundle?: SubAgentContextBundle;
  readonly outputTarget?: string;
  readonly signal: AbortSignal;
}

export interface SubAgentProviderExecutionResult {
  readonly assistantMessage: string;
  readonly usage: SubAgentUsage;
  readonly handoff?: SubAgentHandoff;
  readonly toolEvents?: readonly { capability: string; status: "started" | "completed" | "failed" | "rejected"; summary: string }[];
  readonly contextHash?: string;
  readonly contextBundle?: SubAgentContextBundle;
}

export interface SubAgentAdapter {
  execute(input: SubAgentExecutionInput): Promise<SubAgentExecutionResult>;
  terminate?(attemptId: string): Promise<void> | void;
  readonly kind?: "provider" | "fixture" | "unavailable";
}

export interface SubAgentProfileResolver {
  resolve(input: { readonly role: SubAgentRole; readonly requestedProfileId?: string; readonly parentThreadId?: string }): SubAgentProfileSnapshot | undefined;
}

export interface SubAgentRuntimeEvent {
  readonly event:
    | "sub_agent.run.authorized"
    | "sub_agent.run.inspected"
    | "sub_agent.run.stopped"
    | "sub_agent.run.completed"
    | "sub_agent.run.interrupted"
    | "sub_agent.task.created"
    | "sub_agent.task.queued"
    | "sub_agent.task.started"
    | "sub_agent.task.updated"
    | "sub_agent.task.completed"
    | "sub_agent.task.failed"
    | "sub_agent.task.retry"
    | "sub_agent.task.skipped"
    | "sub_agent.handoff.adopted"
    | "sub_agent.handoff.rejected"
    | "sub_agent.record.deleted"
    | "sub_agent.attempt.created"
    | "sub_agent.budget.exhausted";
  readonly projection: SubAgentProjection;
  readonly task?: SubAgentTask;
  readonly attempt?: SubAgentAttempt;
  readonly remainingTokens?: number;
}

interface PersistedSubAgentState {
  schemaVersion: 1;
  runs: SubAgentRun[];
  tasks: SubAgentTask[];
  attempts: SubAgentAttempt[];
}

interface RunningAttempt {
  readonly controller: AbortController;
  readonly lease?: ModelExecutionLease;
}

const DEFAULT_TASK_LIMIT = 8;
const DEFAULT_CONTEXT_CHARS = 25_000;
const DEFAULT_CAPACITY = 2;

/**
 * Host-owned, flat and bounded Sub-Agent runtime.  The runtime is intentionally
 * adapter based: the Host may inject a real provider session, while tests and
 * a dependency-free installation use the deterministic fixture adapter.  It
 * never invents a provider or retries a failed task automatically.
 */
export class SubAgentRuntime {
  readonly #path: string;
  readonly #resolver: SubAgentProfileResolver;
  readonly #adapter: SubAgentAdapter;
  readonly #scheduler: BoundedExecutionScheduler | undefined;
  readonly #capacity: number;
  readonly #maxTasksPerRun: number;
  readonly #now: () => number;
  readonly #runs = new Map<string, SubAgentRun>();
  readonly #tasks = new Map<string, SubAgentTask>();
  readonly #attempts = new Map<string, SubAgentAttempt>();
  readonly #queue: string[] = [];
  readonly #running = new Map<string, RunningAttempt>();
  readonly #claimedTargets = new Map<string, string>();
  readonly #onEvent: (event: SubAgentRuntimeEvent) => void;
  readonly #readOnly: boolean;
  #accepting = true;

  constructor(input: {
    path: string;
    resolver: SubAgentProfileResolver;
    adapter: SubAgentAdapter;
    scheduler?: BoundedExecutionScheduler;
    capacity?: number;
    maxTasksPerRun?: number;
    now?: () => number;
    onEvent?: (event: SubAgentRuntimeEvent) => void;
    readOnly?: boolean;
  }) {
    this.#path = input.path;
    this.#resolver = input.resolver;
    this.#adapter = input.adapter;
    this.#scheduler = input.scheduler;
    this.#capacity = input.capacity ?? DEFAULT_CAPACITY;
    this.#maxTasksPerRun = input.maxTasksPerRun ?? DEFAULT_TASK_LIMIT;
    this.#now = input.now ?? Date.now;
    this.#onEvent = input.onEvent ?? (() => undefined);
    this.#readOnly = input.readOnly ?? false;
    if (!Number.isInteger(this.#capacity) || this.#capacity < 1) throw new Error("SUB_AGENT_CAPACITY_INVALID");
    if (!Number.isInteger(this.#maxTasksPerRun) || this.#maxTasksPerRun < 1 || this.#maxTasksPerRun > 32) throw new Error("SUB_AGENT_TASK_LIMIT_INVALID");
    this.#load();
  }

  listRuns(): SubAgentRun[] {
    return [...this.#runs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  inspect(runId: string): SubAgentProjection | undefined {
    const run = this.#runs.get(runId);
    if (run === undefined) return undefined;
    return this.#projection(runId);
  }

  authorize(input: {
    readonly parentThreadId: string;
    readonly parentTurnId: string;
    readonly explicitIntentEvidence: SubAgentExplicitIntentEvidence;
    readonly taskLimit?: number | undefined;
    readonly sharedTokenBudget?: number | undefined;
    readonly tasks: readonly SubAgentTaskInput[];
  }): SubAgentProjection {
    if (!this.#accepting) throw new Error("SUB_AGENT_RUNTIME_CLOSED");
    if (input.explicitIntentEvidence.source !== "user" || input.explicitIntentEvidence.confirmed !== true || input.explicitIntentEvidence.taskLifetime !== "current_task") {
      throw new Error("SUB_AGENT_EXPLICIT_INTENT_REQUIRED");
    }
    const taskLimit = input.taskLimit ?? this.#maxTasksPerRun;
    if (input.tasks.length === 0 || input.tasks.length > taskLimit || taskLimit > this.#maxTasksPerRun) throw new Error("SUB_AGENT_TASK_LIMIT_EXCEEDED");
    if (input.sharedTokenBudget !== undefined && (!Number.isInteger(input.sharedTokenBudget) || input.sharedTokenBudget < 1)) throw new Error("SUB_AGENT_BUDGET_INVALID");
    const id = randomUUID();
    const now = this.#timestamp();
    const run: SubAgentRun = {
      schemaVersion: 1, id, parentThreadId: input.parentThreadId, parentTurnId: input.parentTurnId,
      explicitIntentEvidence: { ...input.explicitIntentEvidence, text: sanitizeText(input.explicitIntentEvidence.text, 5_000) },
      taskLimit, ...(input.sharedTokenBudget === undefined ? {} : { sharedTokenBudget: input.sharedTokenBudget }),
      usage: zeroUsage(), status: "authorized", taskIds: [], createdAt: now, updatedAt: now
    };
    this.#runs.set(id, run);
    for (const raw of input.tasks) {
      const parsed = subAgentTaskInputSchema.parse(raw);
      const profile = this.#resolver.resolve({ role: parsed.role, parentThreadId: input.parentThreadId, ...(parsed.profileId === undefined ? {} : { requestedProfileId: parsed.profileId }) });
      if (profile === undefined) throw new Error(`SUB_AGENT_PROFILE_UNAVAILABLE:${parsed.role}`);
      validateCapabilities(parsed.capabilitySet);
      if (parsed.contextBoundary.scope === "project" && parsed.contextBoundary.projectId === undefined) throw new Error("SUB_AGENT_PROJECT_SCOPE_REQUIRED");
      if (parsed.contextBoundary.scope === "unscoped" && parsed.contextBoundary.projectId !== undefined) throw new Error("SUB_AGENT_UNSCOPED_PROJECT_LEAK");
      if (parsed.outputTarget !== undefined) {
        if (parsed.contextBoundary.outputRoot === undefined) throw new Error("SUB_AGENT_OUTPUT_LOCATION_REQUIRED");
        const outputRoot = normalizeTarget(parsed.contextBoundary.outputRoot);
        const outputTarget = normalizeTarget(parsed.outputTarget);
        if (outputTarget !== outputRoot && !outputTarget.startsWith(`${outputRoot}${sep}`)) throw new Error("SUB_AGENT_OUTPUT_TARGET_OUTSIDE_SCOPE");
      }
      const task: SubAgentTask = {
        schemaVersion: 1, id: randomUUID(), runId: id, role: parsed.role, objective: sanitizeText(parsed.objective, 20_000),
        contextBoundary: { ...parsed.contextBoundary, ...(parsed.contextBoundary.outputRoot === undefined ? {} : { outputRoot: normalizeTarget(parsed.contextBoundary.outputRoot) }), sourceReferenceIds: [...parsed.contextBoundary.sourceReferenceIds], maxChars: Math.min(parsed.contextBoundary.maxChars, DEFAULT_CONTEXT_CHARS) },
        capabilitySet: [...new Set(parsed.capabilitySet)] as SubAgentCapability[], ...(parsed.outputTarget === undefined ? {} : { outputTarget: normalizeTarget(parsed.outputTarget) }),
        resolvedProfile: profile, status: "created", attemptIds: [], usage: zeroUsage(), createdAt: now, updatedAt: now
      };
      this.#tasks.set(task.id, task);
      run.taskIds.push(task.id);
      this.#emit({ event: "sub_agent.task.created", projection: this.#projection(id), task });
    }
    this.#save();
    this.#emit({ event: "sub_agent.run.authorized", projection: this.#projection(id) });
    for (const taskId of run.taskIds) this.#enqueue(taskId);
    this.#drain();
    return this.#projection(id);
  }

  stop(runId: string, reason = "User stopped this Sub-Agent run."): SubAgentProjection | undefined {
    const run = this.#runs.get(runId);
    if (run === undefined) return undefined;
    const now = this.#timestamp();
    const nextRun = { ...run, status: "stopped" as const, stopReason: sanitizeText(reason, 200), updatedAt: now };
    this.#runs.set(runId, nextRun);
    for (const taskId of nextRun.taskIds) {
      const task = this.#tasks.get(taskId);
      if (task === undefined || ["completed", "failed", "skipped", "deleted"].includes(task.status)) continue;
      const running = task.attemptIds.map((id) => this.#running.get(id)).find((entry) => entry !== undefined);
      if (running !== undefined) running.controller.abort();
      this.#tasks.set(taskId, { ...task, status: "stopped", updatedAt: now });
    }
    this.#queue.splice(0, this.#queue.length, ...this.#queue.filter((taskId) => this.#tasks.get(taskId)?.runId !== runId));
    this.#save();
    const projection = this.#projection(runId);
    this.#emit({ event: "sub_agent.run.stopped", projection });
    return projection;
  }

  retry(taskId: string): SubAgentProjection | undefined {
    const task = this.#tasks.get(taskId);
    if (task === undefined || !["failed", "interrupted", "stopped"].includes(task.status)) return task === undefined ? undefined : this.#projection(task.runId);
    const run = this.#runs.get(task.runId);
    if (run === undefined || ["stopped", "deleted", "budget_exhausted"].includes(run.status)) throw new Error("SUB_AGENT_RUN_NOT_RETRYABLE");
    if (run.sharedTokenBudget !== undefined && run.usage.totalTokens >= run.sharedTokenBudget) throw new Error("SUB_AGENT_BUDGET_EXHAUSTED");
    const now = this.#timestamp();
    const nextTask = { ...task, status: "queued" as const, failure: undefined, updatedAt: now };
    this.#tasks.set(taskId, nextTask);
    this.#runs.set(run.id, { ...run, status: "running", updatedAt: now });
    this.#save();
    this.#enqueue(taskId);
    this.#drain();
    const projection = this.#projection(run.id);
    this.#emit({ event: "sub_agent.task.retry", projection, task: nextTask });
    return projection;
  }

  skip(taskId: string): SubAgentProjection | undefined {
    const task = this.#tasks.get(taskId);
    if (task === undefined) return undefined;
    if (!["created", "queued", "failed", "interrupted", "stopped"].includes(task.status)) return this.#projection(task.runId);
    const now = this.#timestamp();
    const nextTask = { ...task, status: "skipped" as const, updatedAt: now };
    this.#tasks.set(taskId, nextTask);
    this.#save();
    this.#emit({ event: "sub_agent.task.skipped", projection: this.#projection(task.runId), task: nextTask });
    this.#completeRunIfSettled(task.runId);
    return this.#projection(task.runId);
  }

  adoptHandoff(taskId: string): SubAgentProjection | undefined {
    return this.#reviewHandoff(taskId, "adopted");
  }

  rejectHandoff(taskId: string): SubAgentProjection | undefined {
    return this.#reviewHandoff(taskId, "rejected");
  }

  deleteRecord(runId: string, taskId?: string): SubAgentProjection | undefined {
    const run = this.#runs.get(runId);
    if (run === undefined) return undefined;
    const now = this.#timestamp();
    const ids = taskId === undefined ? run.taskIds : [taskId];
    for (const id of ids) {
      const task = this.#tasks.get(id);
      if (task === undefined || task.runId !== runId) continue;
      this.#tasks.set(id, { ...task, status: "deleted", objective: "[deleted]", contextBoundary: { scope: task.contextBoundary.scope, ...(task.contextBoundary.projectId === undefined ? {} : { projectId: task.contextBoundary.projectId }), sourceReferenceIds: [], maxChars: 1 }, handoff: undefined, failure: { code: "SOURCE_UNAVAILABLE", message: "Sub-Agent task details were deleted by the User." }, updatedAt: now, deletedAt: now });
      for (const attemptId of task.attemptIds) {
        const attempt = this.#attempts.get(attemptId);
        if (attempt !== undefined) this.#attempts.set(attemptId, { ...attempt, messages: [{ role: "assistant", content: "[deleted]" }], toolEvents: [], failure: { code: "SOURCE_UNAVAILABLE", message: "Sub-Agent attempt details were deleted by the User." }, updatedAt: now });
      }
    }
    const allDeleted = run.taskIds.every((id) => this.#tasks.get(id)?.status === "deleted");
    this.#runs.set(runId, { ...run, status: allDeleted ? "deleted" : run.status, updatedAt: now, ...(allDeleted ? { deletedAt: now } : {}) });
    this.#save();
    const projection = this.#projection(runId);
    this.#emit({ event: "sub_agent.record.deleted", projection });
    return projection;
  }

  deleteForParentThread(parentThreadId: string): void {
    for (const run of this.#runs.values()) if (run.parentThreadId === parentThreadId) this.deleteRecord(run.id);
  }

  async shutdown(): Promise<void> {
    this.#accepting = false;
    const now = this.#timestamp();
    for (const run of this.#runs.values()) {
      if (!["queued", "running", "authorized"].includes(run.status)) continue;
      this.#runs.set(run.id, { ...run, status: "interrupted", stopReason: "Application shutdown interrupted this Sub-Agent run; retry is explicit.", updatedAt: now });
    }
    for (const task of this.#tasks.values()) {
      if (!["created", "queued", "running"].includes(task.status)) continue;
      this.#tasks.set(task.id, { ...task, status: "interrupted", failure: { code: "APPLICATION_SHUTDOWN", message: "Sub-Agent task was interrupted by application shutdown; retry is explicit." }, updatedAt: now });
    }
    for (const [attemptId, running] of this.#running) {
      running.controller.abort();
      await Promise.resolve(this.#adapter.terminate?.(attemptId)).catch(() => undefined);
    }
    this.#queue.length = 0;
    this.#save();
  }

  snapshot(): { readonly accepting: boolean; readonly running: number; readonly queued: number; readonly adapter: string } {
    return { accepting: this.#accepting, running: this.#running.size, queued: this.#queue.length, adapter: this.#adapter.kind ?? "provider" };
  }

  #enqueue(taskId: string): void {
    const task = this.#tasks.get(taskId);
    if (task === undefined || ["completed", "skipped", "deleted", "running"].includes(task.status) || this.#queue.includes(taskId)) return;
    const run = this.#runs.get(task.runId);
    if (run === undefined || ["stopped", "deleted", "budget_exhausted"].includes(run.status)) return;
    const now = this.#timestamp();
    this.#tasks.set(taskId, { ...task, status: "queued", updatedAt: now });
    this.#runs.set(run.id, { ...run, status: "queued", updatedAt: now });
    this.#queue.push(taskId);
    const queuedTask = this.#tasks.get(taskId);
    this.#emit({ event: "sub_agent.task.queued", projection: this.#projection(run.id), ...(queuedTask === undefined ? {} : { task: queuedTask }) });
  }

  #drain(): void {
    while (this.#queue.length > 0 && this.#running.size < this.#capacity) {
      const taskId = this.#queue.shift();
      if (taskId === undefined) break;
      const task = this.#tasks.get(taskId);
      if (task === undefined || task.status !== "queued") continue;
      const run = this.#runs.get(task.runId);
      if (run === undefined || ["stopped", "deleted", "budget_exhausted"].includes(run.status)) continue;
      if (run.sharedTokenBudget !== undefined && run.usage.totalTokens >= run.sharedTokenBudget) {
        this.#budgetExhausted(run.id);
        continue;
      }
      // Perform a conservative preflight before creating a Provider request.
      // The objective is the only payload guaranteed to be known here; the
      // adapter adds bounded context and system instructions later. Refusing
      // when even this minimum estimate cannot fit prevents a request that is
      // already over the shared run budget.
      if (run.sharedTokenBudget !== undefined && run.usage.totalTokens + estimateTokens(task.objective) > run.sharedTokenBudget) {
        this.#budgetExhausted(run.id);
        continue;
      }
      const attempt: SubAgentAttempt = {
        schemaVersion: 1, id: randomUUID(), taskId, instructionRevision: task.attemptIds.length + 1, profile: task.resolvedProfile,
        status: "created", messages: [{ role: "user", content: sanitizeText(task.objective, 20_000) }], toolEvents: [], usage: zeroUsage(), createdAt: this.#timestamp(), updatedAt: this.#timestamp()
      };
      this.#attempts.set(attempt.id, attempt);
      this.#tasks.set(taskId, { ...task, status: "running", attemptIds: [...task.attemptIds, attempt.id], updatedAt: this.#timestamp() });
      this.#runs.set(run.id, { ...run, status: "running", updatedAt: this.#timestamp() });
      let lease: ModelExecutionLease | undefined;
      if (this.#scheduler !== undefined) {
        // The persistence schema's generic internal stage is the shared lease
        // bucket; this keeps D1 inside the installation-wide scheduler without
        // introducing a second un-migrated SQLite enum value.
        const admission = this.#scheduler.admit({ id: attempt.id, scopeKey: `sub-agent:${run.id}`, kind: "internal_model_stage" });
        if (!admission.admitted) {
          this.#tasks.set(taskId, { ...this.#tasks.get(taskId)!, status: "queued", attemptIds: task.attemptIds, updatedAt: this.#timestamp() });
          this.#attempts.delete(attempt.id);
          this.#queue.unshift(taskId);
          break;
        }
        lease = admission.lease;
      }
      const controller = new AbortController();
      this.#running.set(attempt.id, { controller, ...(lease === undefined ? {} : { lease }) });
      this.#save();
      this.#emit({ event: "sub_agent.attempt.created", projection: this.#projection(run.id), attempt });
      const startedTask = this.#tasks.get(taskId);
      this.#emit({ event: "sub_agent.task.started", projection: this.#projection(run.id), ...(startedTask === undefined ? {} : { task: startedTask }), attempt });
      void this.#execute(run.id, taskId, attempt.id, controller).catch(() => undefined);
    }
  }

  async #execute(runId: string, taskId: string, attemptId: string, controller: AbortController): Promise<void> {
    const run = this.#runs.get(runId);
    const task = this.#tasks.get(taskId);
    const attempt = this.#attempts.get(attemptId);
    if (run === undefined || task === undefined || attempt === undefined) return;
    this.#attempts.set(attemptId, { ...attempt, status: "running", updatedAt: this.#timestamp() });
    try {
      if (task.outputTarget !== undefined) this.#claimTarget(task.outputTarget, taskId);
      const result = await this.#adapter.execute({ run, task, attempt: this.#attempts.get(attemptId)!, signal: controller.signal });
      if (controller.signal.aborted) throw new Error("SUB_AGENT_STOPPED");
      const usage = normalizeUsage(result.usage);
      const updatedRun = this.#runs.get(runId);
      const updatedTask = this.#tasks.get(taskId);
      if (updatedRun === undefined || updatedTask === undefined) return;
      if (updatedRun.sharedTokenBudget !== undefined && updatedRun.usage.totalTokens + usage.totalTokens > updatedRun.sharedTokenBudget) {
        this.#budgetExhausted(runId);
        this.#finishAttempt(attemptId, { status: "failed", failure: { code: "SUB_AGENT_BUDGET_EXCEEDED", message: "Shared Sub-Agent token budget was exceeded." }, usage });
        return;
      }
      if (result.handoff?.outputPath !== undefined && task.outputTarget !== undefined && normalizeTarget(result.handoff.outputPath) !== task.outputTarget) throw new Error("SUB_AGENT_OUTPUT_TARGET_MISMATCH");
      const nextAttempt = { ...this.#attempts.get(attemptId)!, status: "completed" as const, messages: [{ role: "user" as const, content: sanitizeText(task.objective, 20_000) }, { role: "assistant" as const, content: sanitizeText(result.assistantMessage, 20_000) }], toolEvents: (result.toolEvents ?? []).map((item) => ({ ...item, summary: sanitizeText(item.summary, 1_200) })), usage, ...(result.contextHash === undefined ? {} : { contextHash: result.contextHash }), updatedAt: this.#timestamp() };
      this.#attempts.set(attemptId, nextAttempt);
      const nextTask = { ...updatedTask, status: "completed" as const, handoff: result.handoff === undefined ? undefined : sanitizeHandoff(result.handoff), usage: addUsage(updatedTask.usage, usage), updatedAt: this.#timestamp() };
      this.#tasks.set(taskId, nextTask);
      this.#runs.set(runId, { ...updatedRun, usage: addUsage(updatedRun.usage, usage), updatedAt: this.#timestamp() });
      this.#save();
      this.#emit({ event: "sub_agent.task.completed", projection: this.#projection(runId), task: nextTask, attempt: nextAttempt });
      this.#completeRunIfSettled(runId);
    } catch (error) {
      const failure: SubAgentFailure = { code: error instanceof Error ? error.message.slice(0, 120) : "SUB_AGENT_FAILED", message: sanitizeText(error instanceof Error ? error.message : "Sub-Agent execution failed.", 1_200) };
      const current = this.#tasks.get(taskId);
      const currentAttempt = this.#attempts.get(attemptId);
      const status = !this.#accepting ? "interrupted" as const : controller.signal.aborted ? "stopped" as const : "failed" as const;
      if (currentAttempt !== undefined) this.#attempts.set(attemptId, { ...currentAttempt, status, failure, updatedAt: this.#timestamp() });
      if (current !== undefined) this.#tasks.set(taskId, { ...current, status, failure, updatedAt: this.#timestamp() });
      this.#save();
      const failedTask = this.#tasks.get(taskId);
      const failedAttempt = this.#attempts.get(attemptId);
      this.#emit({ event: "sub_agent.task.failed", projection: this.#projection(runId), ...(failedTask === undefined ? {} : { task: failedTask }), ...(failedAttempt === undefined ? {} : { attempt: failedAttempt }) });
      this.#completeRunIfSettled(runId);
    } finally {
      const running = this.#running.get(attemptId);
      if (running?.lease !== undefined) this.#scheduler?.release(running.lease.id, "failed");
      this.#running.delete(attemptId);
      if (task.outputTarget !== undefined) this.#claimedTargets.delete(task.outputTarget);
      this.#drain();
    }
  }

  #finishAttempt(attemptId: string, input: { status: "failed"; failure: SubAgentFailure; usage: SubAgentUsage }): void {
    const attempt = this.#attempts.get(attemptId);
    if (attempt === undefined) return;
    this.#attempts.set(attemptId, { ...attempt, status: input.status, failure: input.failure, usage: input.usage, updatedAt: this.#timestamp() });
  }

  #claimTarget(target: string, taskId: string): void {
    const normalized = normalizeTarget(target);
    const owner = this.#claimedTargets.get(normalized);
    if (owner !== undefined && owner !== taskId) throw new Error("OUTPUT_TARGET_COLLISION");
    this.#claimedTargets.set(normalized, taskId);
  }

  #budgetExhausted(runId: string): void {
    const run = this.#runs.get(runId);
    if (run === undefined) return;
    const next = { ...run, status: "budget_exhausted" as const, updatedAt: this.#timestamp() };
    this.#runs.set(runId, next);
    for (const taskId of next.taskIds) {
      const task = this.#tasks.get(taskId);
      if (task !== undefined && ["created", "queued"].includes(task.status)) this.#tasks.set(taskId, { ...task, status: "failed", failure: { code: "SUB_AGENT_BUDGET_EXHAUSTED", message: "Shared Sub-Agent token budget is exhausted." }, updatedAt: this.#timestamp() });
    }
    this.#save();
    this.#emit({ event: "sub_agent.budget.exhausted", projection: this.#projection(runId), remainingTokens: Math.max(0, (run.sharedTokenBudget ?? 0) - run.usage.totalTokens) });
  }

  #completeRunIfSettled(runId: string): void {
    const run = this.#runs.get(runId);
    if (run === undefined || ["stopped", "interrupted", "deleted", "budget_exhausted", "completed"].includes(run.status)) return;
    const tasks = run.taskIds.map((id) => this.#tasks.get(id)).filter((task): task is SubAgentTask => task !== undefined);
    if (tasks.some((task) => ["created", "queued", "running"].includes(task.status))) return;
    const failed = tasks.some((task) => task.status === "failed");
    const next = { ...run, status: failed ? "failed" as const : "completed" as const, updatedAt: this.#timestamp() };
    this.#runs.set(runId, next);
    this.#save();
    this.#emit({ event: failed ? "sub_agent.task.updated" : "sub_agent.run.completed", projection: this.#projection(runId) });
  }

  #reviewHandoff(taskId: string, reviewStatus: "adopted" | "rejected"): SubAgentProjection | undefined {
    const task = this.#tasks.get(taskId);
    if (task === undefined) return undefined;
    if (task.handoff === undefined) throw new Error("SUB_AGENT_HANDOFF_NOT_AVAILABLE");
    if (task.handoff.adoptedByParent || task.handoff.reviewStatus === "adopted" || task.handoff.reviewStatus === "rejected") throw new Error("SUB_AGENT_HANDOFF_ALREADY_REVIEWED");
    const nextTask: SubAgentTask = {
      ...task,
      handoff: { ...task.handoff, adoptedByParent: reviewStatus === "adopted", reviewStatus },
      updatedAt: this.#timestamp()
    };
    this.#tasks.set(taskId, nextTask);
    this.#save();
    const projection = this.#projection(task.runId);
    this.#emit({ event: reviewStatus === "adopted" ? "sub_agent.handoff.adopted" : "sub_agent.handoff.rejected", projection, task: nextTask });
    return projection;
  }

  #projection(runId: string): SubAgentProjection {
    const run = this.#runs.get(runId);
    if (run === undefined) throw new Error("SUB_AGENT_RUN_NOT_FOUND");
    return subAgentProjectionSchema.parse({ run, tasks: run.taskIds.map((id) => this.#tasks.get(id)).filter((item): item is SubAgentTask => item !== undefined), attempts: run.taskIds.flatMap((id) => { const task = this.#tasks.get(id); return task?.attemptIds.map((attemptId) => this.#attempts.get(attemptId)).filter((item): item is SubAgentAttempt => item !== undefined) ?? []; }) });
  }

  #emit(event: SubAgentRuntimeEvent): void { this.#onEvent(event); }

  #load(): void {
    if (!existsSync(this.#path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#path, "utf8")) as PersistedSubAgentState;
      if (raw?.schemaVersion !== 1) return;
      for (const run of raw.runs ?? []) {
        const parsed = subAgentRunSchema.safeParse(run);
        if (parsed.success) this.#runs.set(parsed.data.id, parsed.data);
      }
      for (const task of raw.tasks ?? []) {
        const parsed = subAgentTaskSchema.safeParse(task);
        if (parsed.success) this.#tasks.set(parsed.data.id, parsed.data);
      }
      for (const attempt of raw.attempts ?? []) {
        const parsed = subAgentAttemptSchema.safeParse(attempt);
        if (parsed.success) this.#attempts.set(parsed.data.id, parsed.data.status === "running" ? { ...parsed.data, status: "interrupted", failure: { code: "APPLICATION_RESTART", message: "Sub-Agent attempt was interrupted by application restart; retry is explicit." }, updatedAt: this.#timestamp() } : parsed.data);
      }
      let recovered = false;
      for (const run of this.#runs.values()) {
        if (!["authorized", "queued", "running"].includes(run.status)) continue;
        this.#runs.set(run.id, { ...run, status: "interrupted", stopReason: "Application restarted before this Sub-Agent run completed; retry is explicit.", updatedAt: this.#timestamp() });
        recovered = true;
      }
      for (const task of this.#tasks.values()) {
        if (!["queued", "running"].includes(task.status)) continue;
        this.#tasks.set(task.id, { ...task, status: "interrupted", failure: { code: "APPLICATION_RESTART", message: "Sub-Agent task was interrupted by application restart; retry is explicit." }, updatedAt: this.#timestamp() });
        recovered = true;
      }
      if (recovered) this.#save();
    } catch {
      this.#runs.clear(); this.#tasks.clear(); this.#attempts.clear();
    }
  }

  #save(): void {
    if (this.#readOnly) return;
    mkdirSync(dirname(this.#path), { recursive: true });
    const partial = `${this.#path}.partial`;
    writeFileSync(partial, JSON.stringify({ schemaVersion: 1, runs: [...this.#runs.values()], tasks: [...this.#tasks.values()], attempts: [...this.#attempts.values()] satisfies SubAgentAttempt[] }, null, 2) + "\n", "utf8");
    renameSync(partial, this.#path);
  }

  #timestamp(): string { return new Date(this.#now()).toISOString(); }
}

export function createSubAgentProfileResolver(input: {
  readonly profiles: readonly SubAgentProfileSnapshot[];
  readonly roleProfiles?: Readonly<Partial<Record<SubAgentRole, string>>>;
  readonly defaultProfileId?: string;
  readonly primaryProfileId?: string;
}): SubAgentProfileResolver {
  const byId = new Map(input.profiles.map((profile) => [profile.profileId, profile]));
  return {
    resolve: ({ role, requestedProfileId }) => {
      const selection = requestedProfileId === undefined
        ? input.roleProfiles?.[role] === undefined
          ? input.defaultProfileId === undefined
            ? { id: input.primaryProfileId, resolutionSource: "primary_active" as const }
            : { id: input.defaultProfileId, resolutionSource: "default_sub_agent" as const }
          : { id: input.roleProfiles[role], resolutionSource: "role_assignment" as const }
        : { id: requestedProfileId, resolutionSource: "explicit_override" as const };
      const profile = selection.id === undefined ? undefined : byId.get(selection.id);
      return profile === undefined ? undefined : { ...profile, resolutionSource: selection.resolutionSource };
    }
  };
}

function zeroUsage(): SubAgentUsage { return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }; }
function sanitizeText(value: string, max: number): string { return value.replace(/Bearer\s+[A-Za-z0-9._-]+/giu, "Bearer [redacted]").replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]").replace(/(?:[A-Za-z]:\\|\\\\|\/Users\/|\/home\/)[^\s"']+/gu, "[path redacted]").slice(0, max); }
function normalizeUsage(usage: SubAgentUsage): SubAgentUsage { const inputTokens = Math.max(0, Math.floor(usage.inputTokens)); const outputTokens = Math.max(0, Math.floor(usage.outputTokens)); return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }; }
function addUsage(left: SubAgentUsage, right: SubAgentUsage): SubAgentUsage { const next = normalizeUsage({ inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens, totalTokens: 0 }); return next; }
function sanitizeHandoff(handoff: SubAgentHandoff): SubAgentHandoff { return { ...handoff, summary: sanitizeText(handoff.summary, 20_000), provenance: handoff.provenance.map((item) => ({ referenceId: sanitizeText(item.referenceId, 200), source: sanitizeText(item.source, 200) })), ...(handoff.outputPath === undefined ? {} : { outputPath: normalizeTarget(handoff.outputPath) }) }; }
function normalizeTarget(value: string): string { return normalize(resolve(value)); }
function validateCapabilities(capabilities: readonly SubAgentCapability[]): void {
  if (new Set(capabilities).size !== capabilities.length) throw new Error("SUB_AGENT_CAPABILITY_DUPLICATE");
  if (capabilities.includes("write_output") && capabilities.length > 4) throw new Error("SUB_AGENT_CAPABILITY_SET_INVALID");
}
