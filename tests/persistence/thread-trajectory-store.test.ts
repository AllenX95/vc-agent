import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InflightTurnCheckpoint, TrajectoryEvent, TrajectoryProfile } from "@vc-agent/contracts";
import { ThreadTrajectoryStore } from "@vc-agent/persistence";

const temporaryDirectories: string[] = [];
const profile: TrajectoryProfile = {
  id: "profile-1",
  name: "Research",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  thinkingLevel: "off"
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "vc-agent-trajectory-"));
  temporaryDirectories.push(directory);
  return { directory, store: new ThreadTrajectoryStore(join(directory, "threads")) };
}

function metadata(sequence: number, eventId = `event-${sequence}`) {
  return {
    schemaVersion: 1 as const,
    eventId,
    correlationId: "correlation-1",
    sequence,
    threadId: "thread-1",
    turnId: "turn-1",
    actor: { actorType: "user" as const, actorId: "local-user" },
    provenance: { producerType: "user" as const, producerId: "local-user" },
    occurredAt: new Date(1_700_000_000_000 + sequence).toISOString()
  };
}

function submitted(): TrajectoryEvent {
  return {
    ...metadata(1),
    event: "turn.submitted",
    payload: { text: "Assess this company", idempotencyKey: "idempotency-1", profile }
  };
}

function checkpoint(): InflightTurnCheckpoint {
  return {
    schemaVersion: 1,
    checkpointId: "checkpoint-1",
    interruptionEventId: "interruption-stable-1",
    correlationId: "correlation-1",
    threadId: "thread-1",
    turnId: "turn-1",
    profile,
    partialMessage: "Partial visible answer",
    startedTools: [],
    lastWorkerSequence: 4,
    lastHostSequence: 6,
    updatedAt: new Date().toISOString()
  };
}

describe("ThreadTrajectoryStore", () => {
  it("appends flushed transparent events and projects retained conversation", () => {
    const { store } = fixture();
    store.append(submitted());
    store.append({
      ...metadata(2),
      actor: { actorType: "agent", actorId: "primary-agent" },
      provenance: { producerType: "agent", producerId: "primary-agent" },
      event: "turn.completed",
      payload: {
        message: "The company has an attractive wedge.",
        profile,
        usage: { input: 10, output: 8, cacheRead: 0, cacheWrite: 0, reasoning: 3, totalTokens: 18 },
        citations: [{ id: "S1", url: "https://example.com/report", title: "Report", accessedAt: "2026-08-02T00:00:00.000Z", originatingTool: "web_fetch", toolCallId: "tool-1" }],
        contextUsage: { tokens: 12_500, contextWindow: 128_000, percent: 9.765625 }
      }
    });

    expect(store.projectTurns("thread-1")).toMatchObject([
      {
        text: "Assess this company",
        assistantText: "The company has an attractive wedge.",
        status: "completed",
        usage: { input: 10, reasoning: 3, output: 8 },
        citations: [{ id: "S1", url: "https://example.com/report", title: "Report" }],
        contextUsage: { tokens: 12_500, contextWindow: 128_000 }
      }
    ]);
    expect(store.contextHistory("thread-1")).toMatchObject([
      { user: "Assess this company", assistant: "The company has an attractive wedge.", status: "completed" }
    ]);
    const lines = readFileSync(store.trajectoryPath("thread-1"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => JSON.parse(line).schemaVersion === 1)).toBe(true);
  });

  it("atomically recovers one orphan checkpoint without Pi and deduplicates by stable terminal id", () => {
    const { store } = fixture();
    store.append(submitted());
    store.writeCheckpoint(checkpoint());
    store.writeCheckpoint({ ...checkpoint(), partialMessage: "Latest visible answer", authorization: "Bearer must-not-persist" } as InflightTurnCheckpoint);
    const inflightDirectory = join(store.threadDirectory("thread-1"), "inflight");
    expect(readdirSync(inflightDirectory)).toEqual(["turn-1.json"]);
    expect(readFileSync(join(inflightDirectory, "turn-1.json"), "utf8")).not.toContain("must-not-persist");

    const recovered = store.recoverInterruptedTurns("thread-1");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ eventId: "interruption-stable-1", event: "turn.interrupted", sequence: 7 });
    expect(store.projectTurns("thread-1")[0]).toMatchObject({ status: "interrupted", assistantText: "Latest visible answer" });
    expect(store.recoverInterruptedTurns("thread-1")).toEqual([]);
    expect(readdirSync(inflightDirectory)).toEqual([]);
  });

  it("removes a stale checkpoint when a terminal event already exists", () => {
    const { store } = fixture();
    store.append(submitted());
    store.append({
      ...metadata(2),
      event: "turn.failed",
      payload: { profile, failure: { kind: "provider", code: "invalid_key", message: "Invalid key" } }
    });
    store.writeCheckpoint(checkpoint());
    expect(store.recoverInterruptedTurns("thread-1")).toEqual([]);
    expect(store.loadEvents("thread-1")).toHaveLength(2);
  });

  it("projects durable tool and Artifact activity for restart inspection", () => {
    const { store } = fixture();
    store.append(submitted());
    store.append({
      ...metadata(2),
      event: "tool.started",
      payload: { toolCallId: "tool-1", capabilityId: "output.write_text", arguments: { path: "memo.txt", contentBytes: 12 }, expectedStateVersion: 2 }
    });
    store.append({
      ...metadata(3),
      event: "tool.completed",
      payload: { toolCallId: "tool-1", capabilityId: "output.write_text", summary: "Created Output", artifactIds: ["artifact-1"] }
    });
    store.append({
      ...metadata(4),
      event: "artifact.created",
      payload: { artifactId: "artifact-1", mediaType: "text/plain", destination: "C:\\outputs\\memo.txt", sourceTurnId: "turn-1" }
    });
    expect(store.projectActivities("thread-1")).toMatchObject([
      { kind: "tool", label: "output.write_text", status: "completed", content: "Created Output", sequence: 3 },
      { kind: "artifact", artifact: { id: "artifact-1", mediaType: "text/plain" }, sequence: 4 }
    ]);
  });

  it("rejects non-monotonic trajectory sequence numbers", () => {
    const { store } = fixture();
    store.append(submitted());
    expect(() => store.append({ ...submitted(), eventId: "another-event" })).toThrow("must increase");
  });

  it("rejects Thread ids that escape the app-owned storage root", () => {
    const { store } = fixture();
    expect(() => store.threadDirectory("../outside")).toThrow("escapes");
  });

  it("deletes retained trajectory and physical context only through the explicit history operation", () => {
    const { store } = fixture();
    store.append(submitted());
    store.writeCheckpoint(checkpoint());
    expect(store.loadEvents("thread-1")).toHaveLength(1);
    store.deleteThreadHistory("thread-1");
    expect(store.loadEvents("thread-1")).toEqual([]);
    expect(store.loadCheckpoints("thread-1")).toEqual([]);
  });
});
