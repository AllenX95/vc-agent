import { describe, expect, it } from "vitest";
import { BoundedExecutionScheduler, ExecutionLifecycleCoordinator, type ExecutionSchedulerStore, type ModelExecutionLease } from "@vc-agent/host-services";

function createHarness() {
  const leases = new Map<string, ModelExecutionLease>();
  const order: string[] = [];
  const store: ExecutionSchedulerStore = {
    listExecutionLeases: () => [...leases.values()],
    acquireExecutionLease: (input) => {
      const lease = { ...input, acquiredAt: "2026-08-01T00:00:00.000Z" };
      leases.set(lease.id, lease);
      return lease;
    },
    releaseExecutionLease: (id) => leases.delete(id),
    listExecutionQueue: () => []
  };
  const scheduler = new BoundedExecutionScheduler({ capacity: 2, store, now: () => Date.parse("2026-08-01T00:00:01.000Z") });
  const coordinator = new ExecutionLifecycleCoordinator({
    scheduler,
    callbacks: {
      appendTerminalTrajectory: () => order.push("trajectory"),
      removeCheckpoint: () => order.push("checkpoint"),
      drainQueue: () => order.push("drain")
    }
  });
  return { coordinator, leases, order };
}

describe("ExecutionLifecycleCoordinator", () => {
  it("acquires one lease and reconciles terminal state before checkpoint removal", () => {
    const { coordinator, leases, order } = createHarness();
    expect(coordinator.admit({ id: "execution-1", scopeKey: "thread-1", kind: "ordinary_turn" }).admitted).toBe(true);
    coordinator.beginTurn({ executionId: "execution-1", threadId: "thread-1", turnId: "turn-1", workerId: "worker-1" });
    coordinator.recordTerminal({ executionId: "execution-1", threadId: "thread-1", turnId: "turn-1", outcome: "completed", workerId: "worker-1" });
    coordinator.recordTerminal({ executionId: "execution-1", threadId: "thread-1", turnId: "turn-1", outcome: "failed", workerId: "worker-1" });

    expect(order).toEqual(["trajectory", "checkpoint"]);
    expect(leases.size).toBe(0);
    expect(coordinator.activeExecutionCount).toBe(0);
  });

  it("reconciles worker exit and releases the orphaned lease", () => {
    const { coordinator, leases } = createHarness();
    coordinator.admit({ id: "execution-2", scopeKey: "thread-2", kind: "dream_synthesis" });
    coordinator.beginTurn({ executionId: "execution-2", threadId: "thread-2", turnId: "turn-2", workerId: "worker-crashed" });

    expect(coordinator.reconcileWorkerExit("worker-crashed")).toMatchObject({ reconciledExecutionIds: ["execution-2"] });
    expect(leases.size).toBe(0);
  });

  it("releases an admitted execution interrupted before a Worker turn begins", () => {
    const { coordinator, leases, order } = createHarness();
    coordinator.admit({ id: "execution-prestart", scopeKey: "thread-prestart", kind: "ordinary_turn" });
    coordinator.interrupt({ executionId: "execution-prestart", reason: "User stopped before dispatch." });
    coordinator.recordTerminal({ executionId: "execution-prestart", threadId: "thread-prestart", turnId: "turn-prestart", outcome: "interrupted" });
    expect(leases.size).toBe(0);
    expect(order).toEqual([]);
  });

  it("reconciles begun executions and releases admitted-but-not-started work on shutdown", async () => {
    const { coordinator, leases, order } = createHarness();
    coordinator.admit({ id: "execution-3", scopeKey: "thread-3", kind: "ordinary_turn" });
    coordinator.beginTurn({ executionId: "execution-3", threadId: "thread-3", turnId: "turn-3" });
    coordinator.admit({ id: "execution-4", scopeKey: "thread-4", kind: "compaction" });

    const report = await coordinator.shutdown(1000);
    expect(report.reconciledExecutionIds).toEqual(["execution-3"]);
    expect(report.releasedLeaseIds).toEqual(["execution-3", "execution-4"]);
    expect(order).toEqual(["trajectory", "checkpoint", "drain"]);
    expect(leases.size).toBe(0);
  });
});
