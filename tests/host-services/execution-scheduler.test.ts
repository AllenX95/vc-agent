import { describe, expect, it } from "vitest";
import { BoundedExecutionScheduler, MODEL_EXECUTION_KINDS, type ExecutionSchedulerStore, type ModelExecutionLease } from "@vc-agent/host-services";

class MemoryExecutionStore implements ExecutionSchedulerStore {
  readonly leases = new Map<string, ModelExecutionLease>();
  readonly queue: Array<{ status: "queued" | "draft"; submittedAt: string }> = [];
  now = "2026-07-22T00:00:00.000Z";

  listExecutionLeases() { return [...this.leases.values()]; }
  acquireExecutionLease(input: Omit<ModelExecutionLease, "acquiredAt">) {
    const lease = { ...input, acquiredAt: this.now };
    this.leases.set(input.id, lease);
    return lease;
  }
  releaseExecutionLease(id: string) { return this.leases.delete(id); }
  listExecutionQueue() { return this.queue; }
}

describe("BoundedExecutionScheduler", () => {
  it("admits every registered model stage through the same bounded capacity", () => {
    for (const kind of MODEL_EXECUTION_KINDS) {
      const store = new MemoryExecutionStore();
      const scheduler = new BoundedExecutionScheduler({ capacity: 1, store });
      expect(scheduler.admit({ id: `${kind}-1`, scopeKey: "scope-1", kind }).admitted).toBe(true);
      expect(scheduler.admit({ id: `${kind}-2`, scopeKey: "scope-2", kind })).toEqual({ admitted: false, runningCount: 1, capacity: 1 });
      expect(scheduler.release(`${kind}-1`)).toBe(true);
    }
  });

  it("owns queue delay, running duration, capacity, and sanitized failure telemetry", () => {
    const store = new MemoryExecutionStore();
    store.queue.push({ status: "queued", submittedAt: "2026-07-22T00:00:05.000Z" }, { status: "draft", submittedAt: "2026-07-22T00:00:06.000Z" });
    const scheduler = new BoundedExecutionScheduler({ capacity: 2, store, now: () => Date.parse("2026-07-22T00:00:10.000Z") });
    expect(scheduler.admit({ id: "turn-1", scopeKey: "thread-1", kind: "ordinary_turn" }).admitted).toBe(true);
    scheduler.recordQueueAdmission("2026-07-22T00:00:08.000Z");
    scheduler.recordFailure();
    expect(scheduler.telemetry()).toEqual({
      capacity: 2,
      runningCount: 1,
      queuedCount: 1,
      draftCount: 1,
      averageQueueDelayMs: 2_000,
      longestRunningMs: 10_000,
      failureCount: 1,
      oldestQueuedAt: "2026-07-22T00:00:05.000Z"
    });
  });
});
