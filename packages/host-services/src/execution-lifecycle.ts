import type { ModelExecutionKind } from "./execution-scheduler.js";
import type { BoundedExecutionScheduler, ExecutionAdmission, ModelExecutionLease } from "./execution-scheduler.js";

export type { ExecutionAdmission } from "./execution-scheduler.js";

export interface ExecutionAdmissionRequest {
  readonly id: string;
  readonly scopeKey: string;
  readonly kind: ModelExecutionKind;
}

export interface BeginTurnRequest {
  readonly executionId: string;
  readonly workerId?: string;
  readonly threadId: string;
  readonly turnId: string;
}

export interface CheckpointUpdate {
  readonly executionId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly state: "running" | "waiting_tool" | "partial" | "unknown_outcome";
  readonly summary?: string;
}

export type TerminalExecutionOutcome = "completed" | "failed" | "interrupted" | "worker_exit" | "shutdown";

export interface TerminalExecutionEvent {
  readonly executionId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly outcome: TerminalExecutionOutcome;
  readonly workerId?: string;
  readonly failureCode?: string;
}

export interface InterruptExecutionRequest {
  readonly executionId: string;
  readonly reason: string;
  readonly terminal?: Omit<TerminalExecutionEvent, "executionId" | "outcome"> & { readonly outcome?: TerminalExecutionOutcome };
}

export interface ReconciliationReport {
  readonly workerId: string;
  readonly reconciledExecutionIds: readonly string[];
  readonly alreadyReconciledExecutionIds: readonly string[];
}

export interface ExecutionShutdownReport {
  readonly reconciledExecutionIds: readonly string[];
  readonly releasedLeaseIds: readonly string[];
  readonly deadlineExceeded: boolean;
}

export interface ExecutionLifecycleCallbacks {
  /** Durable trajectory append. This callback is invoked before checkpoint removal. */
  readonly appendTerminalTrajectory: (event: TerminalExecutionEvent) => void;
  /** Remove the in-flight checkpoint only after the terminal trajectory is durable. */
  readonly removeCheckpoint: (executionId: string) => void;
  readonly beginTurn?: (request: BeginTurnRequest) => void;
  readonly updateCheckpoint?: (update: CheckpointUpdate) => void;
  readonly interrupt?: (request: InterruptExecutionRequest) => void;
  readonly drainQueue?: () => void;
}

interface ActiveExecution {
  readonly lease: ModelExecutionLease;
  readonly request: ExecutionAdmissionRequest;
  begin?: BeginTurnRequest;
}

/**
 * Host-owned ordering seam for model execution. Stores remain authoritative;
 * this coordinator only makes admission, checkpoint, terminal, and shutdown
 * ordering impossible to implement differently in each workflow.
 */
export class ExecutionLifecycleCoordinator {
  readonly #scheduler: BoundedExecutionScheduler;
  readonly #callbacks: ExecutionLifecycleCallbacks;
  readonly #now: () => number;
  readonly #active = new Map<string, ActiveExecution>();
  readonly #terminal = new Set<string>();

  constructor(input: { readonly scheduler: BoundedExecutionScheduler; readonly callbacks: ExecutionLifecycleCallbacks; readonly now?: () => number }) {
    this.#scheduler = input.scheduler;
    this.#callbacks = input.callbacks;
    this.#now = input.now ?? Date.now;
  }

  admit(request: ExecutionAdmissionRequest): ExecutionAdmission {
    const existing = this.#active.get(request.id);
    if (existing !== undefined) return { admitted: true, lease: existing.lease };
    const admission = this.#scheduler.admit(request);
    if (admission.admitted) this.#active.set(request.id, { lease: admission.lease, request });
    return admission;
  }

  beginTurn(request: BeginTurnRequest): void {
    const active = this.#active.get(request.executionId);
    if (active === undefined) throw new Error("EXECUTION_NOT_ADMITTED");
    if (active.begin !== undefined && (active.begin.threadId !== request.threadId || active.begin.turnId !== request.turnId)) {
      throw new Error("EXECUTION_TURN_ALREADY_BOUND");
    }
    active.begin = request;
    this.#callbacks.beginTurn?.(request);
  }

  updateCheckpoint(update: CheckpointUpdate): void {
    if (!this.#active.has(update.executionId)) throw new Error("EXECUTION_NOT_ADMITTED");
    this.#callbacks.updateCheckpoint?.(update);
  }

  recordTerminal(event: TerminalExecutionEvent): void {
    if (this.#terminal.has(event.executionId)) return;
    this.#terminal.add(event.executionId);
    const active = this.#active.get(event.executionId);

    // The ordering is deliberate: a durable terminal trajectory is the
    // recovery authority, so a checkpoint is never removed first.
    this.#callbacks.appendTerminalTrajectory(event);
    this.#callbacks.removeCheckpoint(event.executionId);
    if (active !== undefined) {
      this.#scheduler.release(active.lease.id, terminalToSchedulerOutcome(event.outcome));
      this.#active.delete(event.executionId);
    }
  }

  interrupt(request: InterruptExecutionRequest): void {
    if (!this.#active.has(request.executionId)) return;
    this.#callbacks.interrupt?.(request);
    const active = this.#active.get(request.executionId);
    const begin = active?.begin;
    if (request.terminal !== undefined) {
      this.recordTerminal({
        executionId: request.executionId,
        threadId: request.terminal.threadId,
        turnId: request.terminal.turnId,
        outcome: request.terminal.outcome ?? "interrupted",
        ...(request.terminal.workerId === undefined ? {} : { workerId: request.terminal.workerId }),
        ...(request.terminal.failureCode === undefined ? {} : { failureCode: request.terminal.failureCode })
      });
    } else if (begin !== undefined) {
      this.recordTerminal({ executionId: request.executionId, threadId: begin.threadId, turnId: begin.turnId, outcome: "interrupted", ...(begin.workerId === undefined ? {} : { workerId: begin.workerId }), failureCode: request.reason });
    } else if (active !== undefined) {
      this.#terminal.add(request.executionId);
      this.#scheduler.release(active.lease.id, "interrupted");
      this.#active.delete(request.executionId);
    }
  }

  reconcileWorkerExit(workerId: string): ReconciliationReport {
    const reconciledExecutionIds: string[] = [];
    const alreadyReconciledExecutionIds: string[] = [];
    for (const [executionId, active] of this.#active) {
      if (active.begin?.workerId !== workerId) continue;
      if (this.#terminal.has(executionId)) {
        alreadyReconciledExecutionIds.push(executionId);
        continue;
      }
      const begin = active.begin;
      this.recordTerminal({ executionId, threadId: begin.threadId, turnId: begin.turnId, workerId, outcome: "worker_exit", failureCode: "WORKER_EXIT" });
      reconciledExecutionIds.push(executionId);
    }
    return { workerId, reconciledExecutionIds, alreadyReconciledExecutionIds };
  }

  drainQueue(): void {
    this.#callbacks.drainQueue?.();
  }

  async shutdown(deadlineMs: number): Promise<ExecutionShutdownReport> {
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0) throw new Error("EXECUTION_SHUTDOWN_DEADLINE_INVALID");
    const startedAt = this.#now();
    const reconciledExecutionIds: string[] = [];
    const releasedLeaseIds: string[] = [];
    for (const [executionId, active] of [...this.#active]) {
      const begin = active.begin;
      if (begin === undefined) {
        this.#terminal.add(executionId);
        this.#scheduler.release(active.lease.id, "interrupted");
        this.#active.delete(executionId);
        releasedLeaseIds.push(active.lease.id);
        continue;
      }
      this.recordTerminal({ executionId, threadId: begin.threadId, turnId: begin.turnId, ...(begin.workerId === undefined ? {} : { workerId: begin.workerId }), outcome: "shutdown", failureCode: "APPLICATION_SHUTDOWN" });
      reconciledExecutionIds.push(executionId);
      releasedLeaseIds.push(active.lease.id);
    }
    this.drainQueue();
    return { reconciledExecutionIds, releasedLeaseIds, deadlineExceeded: this.#now() - startedAt > deadlineMs };
  }

  get activeExecutionCount(): number { return this.#active.size; }
}

function terminalToSchedulerOutcome(outcome: TerminalExecutionOutcome): "completed" | "failed" | "interrupted" {
  if (outcome === "completed") return "completed";
  if (outcome === "failed" || outcome === "worker_exit") return "failed";
  return "interrupted";
}
