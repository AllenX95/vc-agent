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
    expect(command.expectedStateVersion).toBe(1);
    expect(command.scope).toBe("unscoped");
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

  it("supports visible editable execution queue commands and events", () => {
    const metadata = { schemaVersion: 1, commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actor: { actorType: "user", actorId: "local-user" }, sentAt: new Date().toISOString() };
    const itemId = crypto.randomUUID();
    expect(hostCommandSchema.safeParse({ ...metadata, command: "execution_queue.update", payload: { itemId, text: "Revised follow-up" } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "execution_queue.cancel", payload: { itemId } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "execution_queue.activate", payload: { itemId } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "execution_queue.reorder", payload: { itemId, beforeItemId: crypto.randomUUID() } }).success).toBe(true);
    const event = {
      schemaVersion: 1, eventId: crypto.randomUUID(), correlationId: crypto.randomUUID(), sequence: 0,
      actor: { actorType: "host", actorId: "desktop-host" }, provenance: { producerType: "host", producerId: "desktop-host" }, occurredAt: new Date().toISOString(),
      event: "execution_queue.updated", payload: { items: [{ schemaVersion: 1, id: itemId, threadId: "thread-1", kind: "ordinary_turn", status: "queued", reason: "thread_active", text: "Follow-up", position: 0, submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], runningCount: 1, capacity: 2, telemetry: { capacity: 2, runningCount: 1, queuedCount: 1, draftCount: 0, averageQueueDelayMs: 0, longestRunningMs: 10, failureCount: 0, oldestQueuedAt: new Date().toISOString() } }
    };
    expect(hostEventSchema.parse(event).event).toBe("execution_queue.updated");
  });

  it("supports explicit Skills Directory lifecycle commands and projections", () => {
    const metadata = { schemaVersion: 1, commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actor: { actorType: "user", actorId: "local-user" }, sentAt: new Date().toISOString() };
    const revisionId = crypto.randomUUID();
    expect(hostCommandSchema.safeParse({ ...metadata, command: "skills.list" }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "skills.import" }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "skills.inspect", payload: { revisionId } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "skills.activate", payload: { revisionId } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "skills.disable", payload: { packageId: "office-docs" } }).success).toBe(true);
  });

  it("supports the typed C1 Integration command families", () => {
    const metadata = { schemaVersion: 1, commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actor: { actorType: "user", actorId: "local-user" }, sentAt: new Date().toISOString() };
    const revisionId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const stagedRevisionId = crypto.randomUUID();
    const draftId = crypto.randomUUID();
    const sourceHash = "a".repeat(64);
    const profile = { id: "profile-1", provider: "fixture", model: "fixture-model" };
    const commands = [
      { command: "integration.state.load" },
      { command: "office.task.prepare", payload: { kind: "create", format: "docx", projectId: "project-1", projectPath: "C:/project", threadId: "thread-1", turnId: "turn-1", profile, skillRevisionId: revisionId, outputDirectory: "C:/project/outputs", explicitIntent: true } },
      { command: "office.task.run", payload: { planId: crypto.randomUUID() } },
      { command: "office.result.commit", payload: { resultId: crypto.randomUUID() } },
      { command: "skill_creator.prepare", payload: { operation: "create", explicitIntent: true, packageId: "fixture-skill", files: { "SKILL.md": "# fixture" } } },
      { command: "skill_creator.review", payload: { draftId } },
      { command: "skill_creator.handoff", payload: { draftId, confirmed: true } },
      { command: "page_recovery.inspect" },
      { command: "page_recovery.run", payload: { materialId: crypto.randomUUID(), projectId: crypto.randomUUID(), relativePath: "fixture.pdf", mediaType: "application/pdf", sourceHash } },
      { command: "mcp.server.list" },
      { command: "mcp.server.save", payload: { serverId, name: "Fixture", transport: "fixture", enabled: true, allowedScopes: ["project"] } },
      { command: "mcp.activate", payload: { serverId, toolIds: [], scope: "project" } },
      { command: "extension.list" },
      { command: "extension.stage" },
      { command: "extension.inspect", payload: { stagedRevisionId } }
    ] as const;
    for (const command of commands) expect(hostCommandSchema.safeParse({ ...metadata, ...command }).success, command.command).toBe(true);
  });

  it("requires explicit current-task evidence for D1 delegation and exposes a bounded task tree", () => {
    const metadata = { schemaVersion: 1, commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actor: { actorType: "user", actorId: "local-user" }, sentAt: new Date().toISOString() };
    const runId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();
    const command = { ...metadata, command: "sub_agent.run.authorize", payload: { parentThreadId: "thread-1", parentTurnId: "turn-1", explicitIntentEvidence: { source: "user", text: "Delegate this current task.", confirmed: true, taskLifetime: "current_task" }, tasks: [{ role: "researcher", objective: "Bounded evidence", contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1000 }, capabilitySet: ["read_context"] }] } };
    expect(hostCommandSchema.safeParse(command).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...command, payload: { ...command.payload, explicitIntentEvidence: { ...command.payload.explicitIntentEvidence, confirmed: false } } }).success).toBe(false);
    const projection = { run: { schemaVersion: 1, id: runId, parentThreadId: "thread-1", parentTurnId: "turn-1", explicitIntentEvidence: command.payload.explicitIntentEvidence, taskLimit: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, status: "authorized", taskIds: [taskId], createdAt: now, updatedAt: now }, tasks: [{ schemaVersion: 1, id: taskId, runId, role: "researcher", objective: "Bounded evidence", contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1000 }, capabilitySet: ["read_context"], resolvedProfile: { profileId: "profile-1", name: "Fixture", provider: "fixture", model: "fixture-v1", thinkingLevel: "minimal" }, status: "queued", attemptIds: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, createdAt: now, updatedAt: now }], attempts: [] };
    expect(hostEventSchema.safeParse({ ...metadata, eventId: crypto.randomUUID(), sequence: 1, provenance: { producerType: "host", producerId: "desktop-host" }, occurredAt: now, event: "sub_agent.task.queued", payload: { projection, task: projection.tasks[0] } }).success).toBe(true);
  });
});
