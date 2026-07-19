import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DreamCarryover, DreamProfileSnapshot, DreamTrajectoryInput, SystemPromptRevision, Thread, TrajectoryEvent } from "@vc-agent/contracts";
import { DreamReviewStore, MemoryCandidateStore, selectEligibleDreamTrajectory, type MemoryCandidate } from "@vc-agent/host-services";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const profile: DreamProfileSnapshot = { id: "dream-profile", name: "Dream", provider: "fixture", model: "dream-model", thinkingLevel: "medium" };
const prompt: SystemPromptRevision = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  content: "Minimal VC prompt",
  hash: "a".repeat(64),
  diff: "Initial",
  source: "shipped_default",
  createdAt: "2026-07-01T00:00:00.000Z"
};

describe("DreamReviewStore", () => {
  it("performs a seven-day Due Check from scheduling metadata without creating a batch", () => {
    const clock = { now: new Date("2026-07-08T00:00:00.000Z") };
    const { store, root } = fixture(() => clock.now);
    store.synchronizeSchedulingIndex([ordinaryInput("turn-1", "2026-07-01T00:00:00.000Z")], [candidate("2026-07-01T00:00:00.000Z")]);

    const beforeDueCheck = readFileSync(join(root, "review-state.json"), "utf8");
    const schedulePath = join(root, "schedule.json");
    expect(readFileSync(schedulePath, "utf8")).not.toContain("User view");
    expect(store.dueCheck(profile)).toMatchObject({ kind: "due_proposal", candidateCount: 1, eligibleSessionCount: 1, representedProjectCount: 1, profile: { id: "dream-profile" } });
    expect(store.load().batches).toEqual([]);
    expect(readFileSync(join(root, "review-state.json"), "utf8")).toBe(beforeDueCheck);
    expect(readFileSync(join(root, "review-state.json"), "utf8")).not.toContain("User view");

    renameSync(join(root, "review-state.json"), join(root, "review-state.unavailable"));
    expect(store.dueCheck(profile)?.kind).toBe("due_proposal");
    renameSync(join(root, "review-state.unavailable"), join(root, "review-state.json"));

    store.defer("2026-07-10T00:00:00.000Z");
    expect(store.dueCheck(profile)).toBeUndefined();
    clock.now = new Date("2026-07-10T00:00:00.000Z");
    expect(store.dueCheck(profile)?.kind).toBe("due_proposal");
  });

  it("freezes one cutoff and excludes new sessions from an active batch", () => {
    const clock = { now: new Date("2026-07-08T00:00:00.000Z") };
    const { store } = fixture(() => clock.now);
    const first = ordinaryInput("turn-1", "2026-07-01T00:00:00.000Z");
    const second = ordinaryInput("turn-2", "2026-07-02T00:00:00.000Z");
    store.synchronizeSchedulingIndex([first, second], [candidate("2026-07-01T12:00:00.000Z")]);
    const batch = store.createBatch({ promptRevision: prompt, profile, trajectory: [first, second], candidates: [candidate("2026-07-01T12:00:00.000Z")] });

    expect(batch).toMatchObject({ status: "ready", cutoff: second.completedAt, promptSnapshot: { revisionId: prompt.id }, profileSnapshot: { id: profile.id }, representedScopeCount: 1 });
    const later = ordinaryInput("turn-3", "2026-07-09T00:00:00.000Z");
    store.synchronizeSchedulingIndex([first, second, later], [candidate("2026-07-01T12:00:00.000Z")]);
    expect(store.load().batches[0]).toMatchObject({ cutoff: second.completedAt, trajectoryInputs: [{ turnId: "turn-1" }, { turnId: "turn-2" }] });
    expect(() => store.createBatch({ promptRevision: prompt, profile, trajectory: [first, second, later], candidates: [] })).toThrow("resumed or discarded");

    store.discard(batch.id);
    expect(store.load().schedule.lastCommittedCutoff).toBeUndefined();
    const replacement = store.createBatch({ promptRevision: prompt, profile, trajectory: [first, second, later], candidates: [] });
    expect(replacement.cutoff).toBe(later.completedAt);
  });

  it("keeps unresolved input as immediate Carryover after a completed cutoff", () => {
    const clock = { now: new Date("2026-07-08T00:00:00.000Z") };
    const { store } = fixture(() => clock.now);
    const input = ordinaryInput("turn-1", "2026-07-01T00:00:00.000Z");
    store.synchronizeSchedulingIndex([input], []);
    const batch = store.createBatch({ promptRevision: prompt, profile, trajectory: [input], candidates: [] });
    const carryover: DreamCarryover = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      sourceBatchId: batch.id,
      kind: "trajectory_scope",
      scope: "project",
      projectId: "11111111-1111-4111-8111-111111111111",
      threadId: "project-thread",
      sourceReference: input.sourceReference,
      reason: "keep_pending",
      oldestUnresolvedAt: input.completedAt,
      sourceStatus: "available",
      sourceText: "User view"
    };
    store.complete(batch.id, [carryover]);

    expect(store.load().schedule).toMatchObject({ lastCommittedCutoff: input.completedAt, carryoverCount: 1 });
    expect(store.dueCheck(profile)).toBeUndefined();
    expect(store.pendingReminder()).toMatchObject({ kind: "carryover", affectedScopeCount: 1, oldestUnresolvedAt: input.completedAt });
  });

  it("redacts deleted Thread content from active and archived Dream state", () => {
    const { store, root } = fixture(() => new Date("2026-07-08T00:00:00.000Z"));
    const input = ordinaryInput("turn-1", "2026-07-01T00:00:00.000Z");
    const captured = candidate("2026-07-01T00:00:00.000Z");
    store.synchronizeSchedulingIndex([input], [captured]);
    const batch = store.createBatch({ promptRevision: prompt, profile, trajectory: [input], candidates: [captured] });
    store.redactThreadSources("project-thread");

    const redacted = store.load().batches.find((item) => item.id === batch.id)!;
    expect(redacted.trajectoryInputs).toEqual([]);
    expect(redacted.candidateInputs[0]).toMatchObject({ sourceStatus: "source_deleted" });
    expect(redacted.candidateInputs[0]).not.toHaveProperty("sourceText");
    expect(readFileSync(join(root, "review-state.json"), "utf8")).not.toContain("User view");
  });
});

describe("Dream source selection", () => {
  it("includes completed ordinary and marked Reflection dialogue while excluding internal and failed turns", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const threads: Thread[] = [
      { id: "ordinary", title: "Ordinary", scope: "project", projectId, archivedAt: "2026-07-02T00:00:00.000Z", stateVersion: 1, createdAt: "2026-07-01T00:00:00.000Z" },
      { id: "reflection", title: "Investment Reflection", scope: "project", projectId, stateVersion: 1, createdAt: "2026-07-01T00:00:00.000Z" },
      { id: "internal", title: "Internal", scope: "unscoped", stateVersion: 1, createdAt: "2026-07-01T00:00:00.000Z" }
    ];
    const selected = selectEligibleDreamTrajectory(threads, new Map([
      ["ordinary", [submitted("ordinary", "turn-1", "My judgment", 1), completed("ordinary", "turn-1", "Challenge", 2), submitted("ordinary", "turn-failed", "Still mine", 3), failed("ordinary", "turn-failed", 4)]],
      ["reflection", [submitted("reflection", "turn-r", "I adopt this view", 1, "adoption"), completed("reflection", "turn-r", "Recorded", 2), submitted("reflection", "turn-unmarked", "Challenge this", 3), completed("reflection", "turn-unmarked", "Challenged", 4)]],
      ["internal", [submitted("internal", "turn-i", "Hidden task", 1), completed("internal", "turn-i", "Hidden result", 2)]]
    ]), new Set(["reflection"]), new Set(["internal"]));

    expect(selected.map((item) => ({ threadId: item.threadId, sourceKind: item.sourceKind, signal: item.reflectionSignal }))).toEqual([
      { threadId: "ordinary", sourceKind: "ordinary_dialogue", signal: undefined },
      { threadId: "reflection", sourceKind: "reflection_dialogue", signal: "adoption" }
    ]);
  });

  it("physically removes candidate source text for a deleted Thread", () => {
    const directory = mkdtempSync(join(tmpdir(), "vc-agent-candidate-delete-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "candidates.jsonl");
    const store = new MemoryCandidateStore(path);
    const removed = store.capture({ scope: "unscoped", threadId: "deleted", turnId: "turn-1", sourceSnippet: "private deleted judgment", signal: "strong_user_judgment" });
    store.capture({ scope: "unscoped", threadId: "retained", turnId: "turn-2", sourceSnippet: "retained judgment", signal: "strong_user_judgment" });

    expect(store.removeByThread("deleted")).toEqual([removed.id]);
    expect(store.list().map((item) => item.threadId)).toEqual(["retained"]);
    expect(readFileSync(path, "utf8")).not.toContain("private deleted judgment");
  });
});

function fixture(now: () => Date) {
  const root = mkdtempSync(join(tmpdir(), "vc-agent-dream-"));
  temporaryDirectories.push(root);
  return { root, store: new DreamReviewStore(root, { now }) };
}

function ordinaryInput(turnId: string, completedAt: string): DreamTrajectoryInput {
  return {
    sourceKind: "ordinary_dialogue",
    scope: "project",
    projectId: "11111111-1111-4111-8111-111111111111",
    threadId: "project-thread",
    turnId,
    completedAt,
    sourceReference: `thread:project-thread/turn:${turnId}`,
    userText: "User view",
    assistantText: "Assistant response"
  };
}

function candidate(capturedAt: string): MemoryCandidate {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    scope: "project",
    projectId: "11111111-1111-4111-8111-111111111111",
    threadId: "project-thread",
    turnId: "turn-1",
    sourceReference: "thread:project-thread/turn:turn-1",
    capturedAt,
    sourceSnippet: "Candidate view",
    sourceKind: "ordinary_user_signal",
    signal: "strong_user_judgment",
    status: "active"
  };
}

function submitted(threadId: string, turnId: string, text: string, sequence: number, reflectionSignal?: "adoption" | "correction" | "confirmation"): TrajectoryEvent {
  return {
    ...metadata(threadId, turnId, sequence), event: "turn.submitted",
    payload: { text, idempotencyKey: `key-${turnId}`, ...(reflectionSignal === undefined ? {} : { dreamEligibility: { sourceKind: "reflection_dialogue" as const, signal: reflectionSignal } }) }
  };
}

function completed(threadId: string, turnId: string, message: string, sequence: number): TrajectoryEvent {
  return { ...metadata(threadId, turnId, sequence), event: "turn.completed", payload: { message, profile: { id: "profile", name: "Profile", provider: "fixture", model: "fixture", thinkingLevel: "medium" }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } };
}

function failed(threadId: string, turnId: string, sequence: number): TrajectoryEvent {
  return { ...metadata(threadId, turnId, sequence), event: "turn.failed", payload: { failure: { kind: "provider", code: "FAILED", message: "Failed" } } };
}

function metadata(threadId: string, turnId: string, sequence: number) {
  return { schemaVersion: 1 as const, eventId: `${threadId}-${turnId}-${sequence}`, correlationId: "correlation", sequence, threadId, turnId, actor: { actorType: "user" as const, actorId: "user" }, provenance: { producerType: "user" as const, producerId: "user" }, occurredAt: `2026-07-01T00:00:${String(sequence).padStart(2, "0")}.000Z` };
}
