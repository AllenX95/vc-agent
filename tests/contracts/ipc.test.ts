import { describe, expect, it } from "vitest";
import {
  IPC_SCHEMA_VERSION,
  createBootstrapCommand,
  hostCommandSchema,
  hostEventSchema,
  trajectoryEventSchema
} from "@vc-agent/contracts";

describe("versioned IPC contracts", () => {
  it("creates a versioned command with explicit actor identity", () => {
    const command = createBootstrapCommand();
    expect(command.schemaVersion).toBe(IPC_SCHEMA_VERSION);
    expect(command.actor).toEqual({ actorType: "user", actorId: "local-user" });
    expect(hostCommandSchema.parse(command)).toEqual(command);
  });

  it("rejects unsupported schema versions", () => {
    const command = { ...createBootstrapCommand(), schemaVersion: 2 };
    expect(hostCommandSchema.safeParse(command).success).toBe(false);
  });

  it("supports non-singleton agent provenance", () => {
    const event = {
      schemaVersion: IPC_SCHEMA_VERSION,
      eventId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      sequence: 4,
      actor: { actorType: "sub_agent", actorId: "agent-2", parentActorId: "agent-1" },
      provenance: { producerType: "sub_agent", producerId: "agent-2" },
      occurredAt: new Date().toISOString(),
      event: "diagnostic.raised",
      payload: { code: "HOST_FAILURE", message: "Fixture failure", recoverable: true }
    };
    expect(hostEventSchema.parse(event).actor.actorId).toBe("agent-2");
  });

  it("keeps tool and artifact trajectory provenance actor-neutral", () => {
    const event = {
      schemaVersion: IPC_SCHEMA_VERSION,
      eventId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      sequence: 9,
      threadId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      actor: { actorType: "sub_agent", actorId: "agent-2", parentActorId: "agent-1" },
      provenance: { producerType: "sub_agent", producerId: "agent-2" },
      occurredAt: new Date().toISOString(),
      event: "tool.completed",
      payload: { toolCallId: "tool-1", capabilityId: "output.write", summary: "Created output", artifactIds: ["artifact-1"] }
    };
    expect(trajectoryEventSchema.parse(event).provenance.producerId).toBe("agent-2");
  });

  it("requires an affirmative Memory Patch confirmation in the IPC contract", () => {
    const base = {
      schemaVersion: 1, command: "long_term_memory.patch.commit", commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(),
      actor: { actorType: "user", actorId: "local-user" }, sentAt: new Date().toISOString(), payload: { patchId: "patch-00000001", confirmed: false }
    };
    expect(hostCommandSchema.safeParse(base).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...base, payload: { ...base.payload, confirmed: true } }).success).toBe(true);
  });

  it("requires explicit versioned commands to start and stop Independent Evidence", () => {
    const metadata = { schemaVersion: 1, commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actor: { actorType: "user", actorId: "local-user" }, sentAt: new Date().toISOString() };
    const runId = crypto.randomUUID();
    expect(hostCommandSchema.safeParse({ ...metadata, command: "reflection.independent.start", payload: { runId } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "reflection.independent.stop", payload: { runId } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "reflection.independent.start", payload: {} }).success).toBe(false);
  });
});
