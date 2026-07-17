import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  inflightTurnCheckpointSchema,
  trajectoryEventSchema,
  type ContextReference,
  type InflightTurnCheckpoint,
  type PhysicalContextHistoryItem,
  type TrajectoryEvent,
  type TrajectoryActivity,
  type TrajectoryProfile,
  type TrajectoryTurn
} from "@vc-agent/contracts";

const HOST_ACTOR = { actorType: "host", actorId: "desktop-host" } as const;
const HOST_PROVENANCE = { producerType: "host", producerId: "desktop-host" } as const;

export class ThreadTrajectoryStore {
  readonly #threadsRoot: string;

  constructor(threadsRoot: string) {
    this.#threadsRoot = threadsRoot;
    mkdirSync(threadsRoot, { recursive: true });
  }

  threadDirectory(threadId: string): string {
    const root = resolve(this.#threadsRoot);
    const directory = resolve(root, threadId);
    if (!directory.startsWith(`${root}${sep}`)) throw new Error("Thread id escapes the Thread storage root");
    return directory;
  }

  physicalContextDirectory(threadId: string): string {
    return join(this.threadDirectory(threadId), "pi");
  }

  trajectoryPath(threadId: string): string {
    return join(this.threadDirectory(threadId), "trajectory.jsonl");
  }

  loadEvents(threadId: string): TrajectoryEvent[] {
    const path = this.trajectoryPath(threadId);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .map((line) => trajectoryEventSchema.parse(JSON.parse(line)));
  }

  nextSequence(threadId: string): number {
    return (this.loadEvents(threadId).at(-1)?.sequence ?? 0) + 1;
  }

  append(event: TrajectoryEvent): void {
    const parsed = trajectoryEventSchema.parse(event);
    const events = this.loadEvents(parsed.threadId);
    if (events.some((item) => item.eventId === parsed.eventId)) return;
    const previous = events.at(-1);
    if (previous !== undefined && parsed.sequence <= previous.sequence) {
      throw new Error(`Trajectory sequence must increase after ${previous.sequence}`);
    }
    const directory = this.threadDirectory(parsed.threadId);
    mkdirSync(directory, { recursive: true });
    const path = this.trajectoryPath(parsed.threadId);
    appendFileSync(path, `${JSON.stringify(parsed)}\n`, { encoding: "utf8" });
    const descriptor = openSync(path, "a");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  writeCheckpoint(checkpoint: InflightTurnCheckpoint): void {
    const parsed = inflightTurnCheckpointSchema.parse(checkpoint);
    const directory = join(this.threadDirectory(parsed.threadId), "inflight");
    mkdirSync(directory, { recursive: true });
    const target = join(directory, `${parsed.turnId}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    const descriptor = openSync(temporary, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, target);
  }

  removeCheckpoint(threadId: string, turnId: string): void {
    rmSync(join(this.threadDirectory(threadId), "inflight", `${turnId}.json`), { force: true });
  }

  loadCheckpoints(threadId: string): InflightTurnCheckpoint[] {
    const directory = join(this.threadDirectory(threadId), "inflight");
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => inflightTurnCheckpointSchema.parse(JSON.parse(readFileSync(join(directory, name), "utf8"))));
  }

  recoverInterruptedTurns(threadId: string): TrajectoryEvent[] {
    const recovered: TrajectoryEvent[] = [];
    for (const checkpoint of this.loadCheckpoints(threadId)) {
      const events = this.loadEvents(threadId);
      const terminal = events.some(
        (event) => event.turnId === checkpoint.turnId && ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.event)
      );
      if (!terminal) {
        const event: TrajectoryEvent = {
          schemaVersion: 1,
          eventId: checkpoint.interruptionEventId,
          correlationId: checkpoint.correlationId,
          sequence: Math.max(this.nextSequence(threadId), checkpoint.lastHostSequence + 1),
          threadId,
          turnId: checkpoint.turnId,
          actor: HOST_ACTOR,
          provenance: HOST_PROVENANCE,
          occurredAt: new Date().toISOString(),
          event: "turn.interrupted",
          payload: {
            partialMessage: checkpoint.partialMessage,
            reason: "application_restart",
            ...(checkpoint.profile === undefined ? {} : { profile: checkpoint.profile }),
            tools: checkpoint.startedTools.map((tool) => ({ ...tool, status: tool.status === "started" ? "interrupted" as const : tool.status })),
            lastWorkerSequence: checkpoint.lastWorkerSequence,
            lastHostSequence: checkpoint.lastHostSequence
          }
        };
        this.append(event);
        recovered.push(event);
      }
      this.removeCheckpoint(threadId, checkpoint.turnId);
    }
    return recovered;
  }

  projectTurns(threadId: string): TrajectoryTurn[] {
    const turns = new Map<string, TrajectoryTurn>();
    for (const event of this.loadEvents(threadId)) {
      if (event.event === "turn.submitted") {
        turns.set(event.turnId, {
          threadId,
          turnId: event.turnId,
          text: event.payload.text,
          assistantText: "",
          status: "submitted",
          ...(event.payload.profile === undefined ? {} : { profile: event.payload.profile }),
          ...(event.payload.prompt === undefined ? {} : { prompt: event.payload.prompt }),
          submittedSequence: event.sequence,
          lastSequence: event.sequence
        });
        continue;
      }
      const turn = turns.get(event.turnId);
      if (turn === undefined) continue;
      if (event.event === "turn.started") {
        turns.set(event.turnId, { ...turn, status: "active", profile: event.payload.profile, lastSequence: event.sequence });
      } else if (event.event === "turn.completed") {
        turns.set(event.turnId, { ...turn, status: "completed", assistantText: event.payload.message, profile: event.payload.profile, usage: event.payload.usage, lastSequence: event.sequence });
      } else if (event.event === "turn.failed") {
        turns.set(event.turnId, { ...turn, status: "failed", ...(event.payload.profile === undefined ? {} : { profile: event.payload.profile }), failure: event.payload.failure, lastSequence: event.sequence });
      } else if (event.event === "turn.interrupted") {
        turns.set(event.turnId, { ...turn, status: "interrupted", assistantText: event.payload.partialMessage, ...(event.payload.profile === undefined ? {} : { profile: event.payload.profile }), interruptionReason: event.payload.reason, lastSequence: event.sequence });
      }
    }
    return [...turns.values()];
  }

  projectActivities(threadId: string): TrajectoryActivity[] {
    const activities = new Map<string, TrajectoryActivity>();
    for (const event of this.loadEvents(threadId)) {
      if (event.event === "tool.started") {
        activities.set(`tool:${event.payload.toolCallId}`, {
          id: `tool:${event.payload.toolCallId}`,
          threadId,
          turnId: event.turnId,
          sequence: event.sequence,
          kind: "tool",
          label: event.payload.capabilityId,
          status: "started",
          content: "Capability execution requested."
        });
      } else if (event.event === "tool.completed" || event.event === "tool.failed" || event.event === "tool.unknown_outcome") {
        const id = `tool:${event.payload.toolCallId}`;
        activities.set(id, {
          id,
          threadId,
          turnId: event.turnId,
          sequence: event.sequence,
          kind: "tool",
          label: event.payload.capabilityId,
          status: event.event === "tool.completed" ? "completed" : event.event === "tool.unknown_outcome" ? "unknown_outcome" : "failed",
          content: event.payload.summary
        });
      } else if (event.event === "artifact.created") {
        activities.set(`artifact:${event.payload.artifactId}`, {
          id: `artifact:${event.payload.artifactId}`,
          threadId,
          turnId: event.turnId,
          sequence: event.sequence,
          kind: "artifact",
          label: "Artifact created",
          status: "completed",
          content: event.payload.destination,
          artifact: { id: event.payload.artifactId, mediaType: event.payload.mediaType, destination: event.payload.destination }
        });
      } else if (event.event === "physical_context.rebuilt") {
        activities.set(`context:${event.eventId}`, {
          id: `context:${event.eventId}`,
          threadId,
          turnId: event.turnId,
          sequence: event.sequence,
          kind: "context",
          label: "Physical context rebuilt",
          status: "completed",
          content: `Rebuilt from ${event.payload.retainedTurnCount} retained turn${event.payload.retainedTurnCount === 1 ? "" : "s"}.`
        });
      } else if (event.event === "thread.compaction.started" || event.event === "thread.compaction.completed" || event.event === "thread.compaction.failed") {
        activities.set(`compaction:${event.eventId}`, {
          id: `compaction:${event.eventId}`,
          threadId,
          turnId: event.turnId,
          sequence: event.sequence,
          kind: "context",
          label: event.event === "thread.compaction.started" ? "Thread compaction started" : event.event === "thread.compaction.completed" ? "Thread compaction completed" : "Thread compaction failed",
          status: event.event === "thread.compaction.started" ? "started" : event.event === "thread.compaction.completed" ? "completed" : "failed",
          content: event.event === "thread.compaction.completed"
            ? `${event.payload.tokensBefore ?? 0} -> ${event.payload.estimatedTokensAfter ?? "estimated"} tokens`
            : event.event === "thread.compaction.failed" ? event.payload.failure?.message ?? "Provider failure" : event.payload.reason
        });
      } else if (event.event === "system_prompt.updated") {
        activities.set(`prompt:${event.eventId}`, {
          id: `prompt:${event.eventId}`,
          threadId,
          turnId: event.turnId,
          sequence: event.sequence,
          kind: "context",
          label: "System prompt updated",
          status: "completed",
          content: `${event.payload.previousRevisionId} -> ${event.payload.nextRevisionId}`
        });
      }
    }
    return [...activities.values()].sort((a, b) => a.sequence - b.sequence);
  }

  contextHistory(threadId: string): PhysicalContextHistoryItem[] {
    const references = new Map<string, ContextReference[]>();
    for (const event of this.loadEvents(threadId)) {
      if ((event.event === "tool.completed" || event.event === "tool.failed" || event.event === "tool.unknown_outcome") && event.payload.contextReference !== undefined) {
        const current = references.get(event.turnId) ?? [];
        current.push(event.payload.contextReference);
        references.set(event.turnId, current);
      }
    }
    return this.projectTurns(threadId)
      .filter((turn): turn is TrajectoryTurn & { status: "completed" | "interrupted" } => turn.status === "completed" || turn.status === "interrupted")
      .map((turn) => ({
        user: turn.text,
        assistant: turn.assistantText,
        status: turn.status,
        ...(turn.profile === undefined ? {} : { profile: turn.profile }),
        ...((references.get(turn.turnId)?.length ?? 0) === 0 ? {} : { contextReferences: references.get(turn.turnId) })
      }));
  }

  lastProfile(threadId: string): TrajectoryProfile | undefined {
    return this.projectTurns(threadId).filter((turn) => turn.profile !== undefined).at(-1)?.profile;
  }

  highWater(threadId: string): { eventId: string; sequence: number } | undefined {
    const event = this.loadEvents(threadId).filter((item) => ["turn.completed", "turn.failed", "turn.interrupted", "thread.compaction.completed"].includes(item.event)).at(-1);
    return event === undefined ? undefined : { eventId: event.eventId, sequence: event.sequence };
  }
}
