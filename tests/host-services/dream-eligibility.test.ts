import { describe, expect, it } from "vitest";
import type { TrajectoryEvent } from "@vc-agent/contracts";
import { detectReflectionDreamEligibility, selectEligibleReflectionTrajectory } from "@vc-agent/host-services";

describe("Reflection Dream eligibility", () => {
  it("detects attributable adoption, correction, and confirmation without classifying ordinary prompts", () => {
    expect(detectReflectionDreamEligibility("同意这个判断，我会采用代表性 cohort 的门槛。")).toMatchObject({ signal: "adoption" });
    expect(detectReflectionDreamEligibility("我不同意这个结论，核心风险应改为渠道集中度。")).toMatchObject({ signal: "correction" });
    expect(detectReflectionDreamEligibility("我的判断是暂不投资，等待留存数据。")).toMatchObject({ signal: "confirmation" });
    expect(detectReflectionDreamEligibility("I adopt this diligence threshold.")).toMatchObject({ signal: "adoption" });
    expect(detectReflectionDreamEligibility("I disagree and revise my view.")).toMatchObject({ signal: "correction" });
    expect(detectReflectionDreamEligibility("Prepare a Judgment Record and learning proposal.")).toBeUndefined();
    expect(detectReflectionDreamEligibility("Which result should change the decision?")).toBeUndefined();
    expect(detectReflectionDreamEligibility("你同意这个观点吗？")).toBeUndefined();
  });

  it("selects only completed qualifying User exchanges", () => {
    const events: TrajectoryEvent[] = [
      submitted("turn-adopt", "I adopt the representative cohort threshold.", "adoption"),
      completed("turn-adopt", "Then the remaining question is cohort construction.", 2),
      submitted("turn-unadopted", "Please challenge the current view."),
      completed("turn-unadopted", "The current evidence is weak.", 4),
      submitted("turn-failed", "I confirm the current view.", "confirmation", 5),
      failed("turn-failed", 6)
    ];
    expect(selectEligibleReflectionTrajectory(events)).toEqual([{
      sourceKind: "reflection_dialogue",
      signal: "adoption",
      threadId: "reflection-thread",
      turnId: "turn-adopt",
      completedAt: "2026-07-19T00:00:02.000Z",
      sourceReference: "thread:reflection-thread/turn:turn-adopt",
      userText: "I adopt the representative cohort threshold.",
      assistantText: "Then the remaining question is cohort construction."
    }]);
  });
});

function submitted(turnId: string, text: string, signal?: "adoption" | "correction" | "confirmation", sequence = 1): TrajectoryEvent {
  return {
    ...metadata(turnId, sequence), event: "turn.submitted",
    payload: { text, idempotencyKey: `key-${turnId}`, ...(signal === undefined ? {} : { dreamEligibility: { sourceKind: "reflection_dialogue" as const, signal } }) }
  };
}

function completed(turnId: string, message: string, sequence: number): TrajectoryEvent {
  return {
    ...metadata(turnId, sequence), event: "turn.completed",
    payload: { message, profile: { id: "profile", name: "Profile", provider: "fixture", model: "fixture", thinkingLevel: "medium" }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
  };
}

function failed(turnId: string, sequence: number): TrajectoryEvent {
  return { ...metadata(turnId, sequence), event: "turn.failed", payload: { failure: { kind: "provider", code: "FAILED", message: "Failed" } } };
}

function metadata(turnId: string, sequence: number) {
  return {
    schemaVersion: 1 as const, eventId: `event-${turnId}-${sequence}`, correlationId: "correlation", sequence, threadId: "reflection-thread", turnId,
    actor: { actorType: "user" as const, actorId: "user" }, provenance: { producerType: "user" as const, producerId: "user" }, occurredAt: `2026-07-19T00:00:${String(sequence).padStart(2, "0")}.000Z`
  };
}
