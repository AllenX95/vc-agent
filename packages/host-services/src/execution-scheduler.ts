import { MODEL_EXECUTION_KINDS, type ModelExecutionKind } from "@vc-agent/contracts";

export { MODEL_EXECUTION_KINDS, type ModelExecutionKind };

export interface ModelExecutionLease {
  readonly id: string;
  readonly scopeKey: string;
  readonly kind: ModelExecutionKind;
  readonly acquiredAt: string;
}

export interface ExecutionSchedulerStore {
  listExecutionLeases(): ModelExecutionLease[];
  acquireExecutionLease(input: Omit<ModelExecutionLease, "acquiredAt">): ModelExecutionLease;
  releaseExecutionLease(id: string): boolean;
  listExecutionQueue(): Array<{ readonly status: "queued" | "draft"; readonly submittedAt: string }>;
}

export interface ExecutionSchedulerTelemetry {
  readonly capacity: number;
  readonly runningCount: number;
  readonly queuedCount: number;
  readonly draftCount: number;
  readonly averageQueueDelayMs: number;
  readonly longestRunningMs: number;
  readonly failureCount: number;
  readonly oldestQueuedAt?: string;
}

export type ExecutionAdmission =
  | { readonly admitted: true; readonly lease: ModelExecutionLease }
  | { readonly admitted: false; readonly runningCount: number; readonly capacity: number };

/**
 * Installation-wide admission, lease ownership, and sanitized runtime telemetry
 * for every model-backed execution stage.
 */
export class BoundedExecutionScheduler {
  readonly #capacity: number;
  readonly #store: ExecutionSchedulerStore;
  readonly #now: () => number;
  #admittedQueueDelayMs = 0;
  #admittedQueueCount = 0;
  #failureCount = 0;

  constructor(input: { capacity: number; store: ExecutionSchedulerStore; now?: () => number }) {
    if (!Number.isInteger(input.capacity) || input.capacity < 1) throw new Error("Execution capacity must be a positive integer.");
    this.#capacity = input.capacity;
    this.#store = input.store;
    this.#now = input.now ?? Date.now;
  }

  hasCapacity(): boolean {
    return this.#store.listExecutionLeases().length < this.#capacity;
  }

  admit(input: { id: string; scopeKey: string; kind: ModelExecutionKind }): ExecutionAdmission {
    const runningCount = this.#store.listExecutionLeases().length;
    if (runningCount >= this.#capacity) return { admitted: false, runningCount, capacity: this.#capacity };
    return { admitted: true, lease: this.#store.acquireExecutionLease(input) };
  }

  release(id: string, outcome: "completed" | "failed" | "interrupted" = "completed"): boolean {
    const released = this.#store.releaseExecutionLease(id);
    if (released && outcome === "failed") this.#failureCount += 1;
    return released;
  }

  recordQueueAdmission(submittedAt: string): void {
    this.#admittedQueueDelayMs += Math.max(0, this.#now() - Date.parse(submittedAt));
    this.#admittedQueueCount += 1;
  }

  recordFailure(): void {
    this.#failureCount += 1;
  }

  telemetry(): ExecutionSchedulerTelemetry {
    const now = this.#now();
    const leases = this.#store.listExecutionLeases();
    const queue = this.#store.listExecutionQueue();
    const queued = queue.filter((item) => item.status === "queued");
    const runningDurations = leases.map((lease) => Math.max(0, now - Date.parse(lease.acquiredAt)));
    return {
      capacity: this.#capacity,
      runningCount: leases.length,
      queuedCount: queued.length,
      draftCount: queue.length - queued.length,
      averageQueueDelayMs: this.#admittedQueueCount === 0 ? 0 : Math.round(this.#admittedQueueDelayMs / this.#admittedQueueCount),
      longestRunningMs: runningDurations.length === 0 ? 0 : Math.max(...runningDurations),
      failureCount: this.#failureCount,
      ...(queued[0]?.submittedAt === undefined ? {} : { oldestQueuedAt: queued.reduce((oldest, item) => item.submittedAt < oldest ? item.submittedAt : oldest, queued[0].submittedAt) })
    };
  }
}
