import { describe, expect, it } from "vitest";
import type { TrajectoryEvent } from "@vc-agent/contracts";
import { selectEligibleLearningSources } from "@vc-agent/host-services";

const epoch = "2026-08-01T00:00:00.000Z";

describe("Cognition Review eligibility", () => {
  it("selects completed ordinary and explicit reflection signals while excluding non-learning work", () => {
    const events: TrajectoryEvent[] = [
      submitted("ordinary", "Review the retention evidence.", "2026-08-02T00:00:00.000Z"),
      completed("ordinary", "The retention evidence is mixed.", "2026-08-02T00:00:01.000Z"),
      submitted("reflection", "I adopt this threshold.", "2026-08-02T00:01:00.000Z", { cognitionSourceKind: "reflection_exchange" }),
      completed("reflection", "Noted.", "2026-08-02T00:01:01.000Z"),
      submitted("failed", "I confirm this.", "2026-08-02T00:02:00.000Z"),
      failed("failed", "2026-08-02T00:02:01.000Z"),
      submitted("evidence", "Evidence pass only.", "2026-08-02T00:03:00.000Z", { workflowKind: "independent_evidence" }),
      completed("evidence", "Evidence result.", "2026-08-02T00:03:01.000Z"),
      submitted("old", "Before epoch.", "2026-07-31T23:00:00.000Z"),
      completed("old", "Old result.", "2026-07-31T23:00:01.000Z")
    ];

    expect(selectEligibleLearningSources({
      learningEpochStartedAt: epoch,
      events,
      scope: { kind: "unscoped", threadId: "thread-1" }
    })).toMatchObject([
      { sourceReference: "thread:thread-1/turn:ordinary", sourceKind: "ordinary_exchange" },
      { sourceReference: "thread:thread-1/turn:reflection", sourceKind: "reflection_exchange" }
    ]);
  });
});

function submitted(turnId: string, text: string, occurredAt: string, payload: Record<string, unknown> = {}): TrajectoryEvent {
  return {
    ...metadata(turnId, occurredAt, "user"),
    event: "turn.submitted",
    payload: { text, idempotencyKey: `key-${turnId}`, ...payload }
  } as TrajectoryEvent;
}

function completed(turnId: string, message: string, occurredAt: string): TrajectoryEvent {
  return {
    ...metadata(turnId, occurredAt, "agent"),
    event: "turn.completed",
    payload: { message, profile: { id: "profile", name: "Profile", provider: "fixture", model: "fixture", thinkingLevel: "medium" }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
  } as TrajectoryEvent;
}

function failed(turnId: string, occurredAt: string): TrajectoryEvent {
  return {
    ...metadata(turnId, occurredAt, "agent"),
    event: "turn.failed",
    payload: { failure: { kind: "provider", code: "FAILED", message: "failed" } }
  } as TrajectoryEvent;
}

function metadata(turnId: string, occurredAt: string, actorType: "user" | "agent") {
  return {
    schemaVersion: 1 as const,
    eventId: `${turnId}-${occurredAt}`,
    correlationId: "correlation",
    sequence: 1,
    threadId: "thread-1",
    turnId,
    actor: { actorType, actorId: actorType },
    provenance: { producerType: actorType, producerId: actorType },
    occurredAt
  };
}
