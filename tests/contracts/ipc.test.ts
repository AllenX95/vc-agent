import { describe, expect, it } from "vitest";
import {
  CAPABILITY_RESULT_CONTENT_MAX_CHARS,
  IPC_SCHEMA_VERSION,
  memoryReviewProgressSchema,
  normalizeCapabilityExecutionResult,
  createBootstrapCommand,
  hostCommandSchema,
  hostEventSchema,
  autoMemoryReviewPolicySchema,
  cognitionCommitResultSchema,
  reviewBundleSchema,
  reflectionUnscopedBriefSchema,
  taskModelAssignmentSchema,
  taskModelTypeSchema,
  trajectoryEventSchema
} from "@vc-agent/contracts";

describe("versioned IPC contracts", () => {
  it("accepts every reachable Unscoped Reflection user input instead of truncating at twelve", () => {
    const brief = {
      schemaVersion: 1,
      scope: "unscoped",
      sourceThreadId: "thread-1",
      sourceVersion: "a".repeat(64),
      createdAt: new Date().toISOString(),
      userInputs: Array.from({ length: 14 }, (_, index) => ({ turnId: `turn-${index}`, text: `Input ${index}` })),
      attachmentCards: [],
      recordReferences: []
    } as const;
    expect(reflectionUnscopedBriefSchema.safeParse(brief).success).toBe(true);
  });

  it("accepts intent-level cognition Model Profile assignments", () => {
    const updatedAt = new Date().toISOString();
    expect(taskModelTypeSchema.safeParse("reflection").success).toBe(true);
    expect(taskModelTypeSchema.safeParse("memory_review").success).toBe(true);
    expect(taskModelAssignmentSchema.safeParse({ taskType: "reflection", profileId: "profile-1", updatedAt }).success).toBe(true);
    expect(taskModelAssignmentSchema.safeParse({ taskType: "memory_review", profileId: "profile-2", updatedAt }).success).toBe(true);
  });

  it("exposes strict intent-level cognition commands without stage or launch-profile payloads", () => {
    const now = new Date().toISOString();
    const metadata = {
      schemaVersion: IPC_SCHEMA_VERSION,
      commandId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      actor: { actorType: "user", actorId: "local-user" },
      sentAt: now
    } as const;
    const policy = {
      enabled: false,
      profileId: "memory-profile",
      minEligibleExchangeCount: 20,
      maxIntervalDays: 7,
      maxInputTokensPerRun: 10_000
    };
    expect(hostCommandSchema.safeParse({ ...metadata, command: "memory_review.prepare" }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "memory_review.prepare", payload: {} }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "memory_review.prepare", payload: { profileId: "per-launch" } }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "memory_review.prepare", payload: { stage: "scope_extraction" } }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "memory_review.cancel" }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "memory_review.policy.set", payload: { policy } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "memory_review.policy.set", payload: policy }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "cognition_review.decide", payload: {
      reviewId: "review-1",
      decisions: [
        { proposalId: "proposal-1", decision: "adopt" },
        { proposalId: "proposal-2", decision: "defer" },
        { proposalId: "proposal-3", decision: "reject" }
      ]
    } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "cognition_review.decide", payload: {
      reviewId: "review-1", decisions: [], scopeStage: "synthesis"
    } }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "cognition_review.commit", payload: { reviewId: "review-1" } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "cognition_review.discard", payload: { reviewId: "review-1" } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "cognition_review.load", payload: { reviewId: "review-1" } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "cognition_review.load", payload: { reviewId: "review-1", chunkId: "chunk-1" } }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "cognition_review.get", payload: { reviewId: "review-1" } }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "cognition_review.list" }).success).toBe(false);
    const projectId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    expect(hostCommandSchema.safeParse({ ...metadata, command: "reflection.start", payload: { scope: "project", projectId } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "reflection.start", payload: { scope: "unscoped", threadId: "thread-1" } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "reflection.start", payload: { scope: "project", projectId, profileId: "per-launch" } }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "reflection.finish", payload: { runId } }).success).toBe(true);
  });

  it("projects bounded cognition review bundles, progress, policy, and commit results", () => {
    const now = new Date().toISOString();
    const eventMetadata = {
      schemaVersion: IPC_SCHEMA_VERSION,
      eventId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      sequence: 1,
      actor: { actorType: "host", actorId: "desktop-host" },
      provenance: { producerType: "host", producerId: "desktop-host" },
      occurredAt: now
    } as const;
    const bundle = {
      id: "review-1",
      kind: "memory_review",
      status: "waiting_for_review",
      proposals: [],
      decisions: [],
      dependencies: [],
      createdAt: now,
      updatedAt: now
    } as const;
    const progress = {
      reviewId: "review-1",
      batchId: "batch-1",
      status: "preparing",
      eligible: 2,
      processed: 1,
      noSignal: 0,
      represented: 1,
      carriedOver: 0,
      completedChunks: 1,
      totalChunks: 2
    } as const;
    const policy = {
      enabled: false,
      profileId: "memory-profile",
      minEligibleExchangeCount: 20,
      maxIntervalDays: 7,
      maxInputTokensPerRun: 10_000
    } as const;
    const result = {
      schemaVersion: 1,
      reviewId: "review-1",
      status: "committed",
      adoptedProposalIds: [],
      carriedOverSourceReferences: [],
      cutoff: now
    } as const;
    expect(reviewBundleSchema.safeParse(bundle).success).toBe(true);
    expect(memoryReviewProgressSchema.safeParse(progress).success).toBe(true);
    expect(autoMemoryReviewPolicySchema.safeParse(policy).success).toBe(true);
    expect(cognitionCommitResultSchema.safeParse(result).success).toBe(true);
    expect(hostEventSchema.safeParse({ ...eventMetadata, event: "cognition_review.bundle.updated", payload: { bundle } }).success).toBe(true);
    expect(hostEventSchema.safeParse({ ...eventMetadata, event: "cognition_review.bundles.listed", payload: { bundles: [bundle] } }).success).toBe(true);
    expect(hostEventSchema.safeParse({ ...eventMetadata, event: "memory_review.progress.updated", payload: { progress } }).success).toBe(true);
    expect(hostEventSchema.safeParse({ ...eventMetadata, event: "memory_review.policy.updated", payload: { policy } }).success).toBe(true);
    expect(hostEventSchema.safeParse({ ...eventMetadata, event: "cognition_review.commit.result", payload: { result } }).success).toBe(true);
    expect(hostEventSchema.safeParse({ ...eventMetadata, event: "memory_review.progress.updated", payload: {
      ...progress,
      stage: "scope_extraction",
      sourceReferences: ["raw-source"]
    } }).success).toBe(false);
    expect(hostEventSchema.safeParse({ ...eventMetadata, event: "cognition_review.bundle.updated", payload: {
      bundle: { ...bundle, rawModelOutput: "provider payload" }
    } }).success).toBe(false);
  });

  it("accepts transient thinking deltas and optional reasoning token usage", () => {
    const now = new Date().toISOString();
    const eventMetadata = {
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      sequence: 1,
      actor: { actorType: "agent", actorId: "primary-agent" },
      provenance: { producerType: "agent", producerId: "primary-agent" },
      occurredAt: now
    };
    expect(hostEventSchema.safeParse({
      ...eventMetadata,
      event: "thinking.delta",
      payload: { threadId: "thread-1", turnId: "turn-1", delta: "Reasoning summary" }
    }).success).toBe(true);
    expect(hostEventSchema.safeParse({
      ...eventMetadata,
      event: "session.context.updated",
      payload: { threadId: "thread-1", contextUsage: { tokens: 12_500, contextWindow: 128_000, percent: 9.765625 } }
    }).success).toBe(true);
    expect(hostEventSchema.safeParse({
      ...eventMetadata,
      event: "turn.completed",
      payload: {
        threadId: "thread-1",
        turnId: "turn-1",
        message: "Answer",
        profile: {
          id: "profile-1",
          name: "Profile",
          provider: "fixture",
          model: "fixture",
          credentialRef: "credential-1",
          thinkingLevel: "medium",
          createdAt: now,
          updatedAt: now
        },
        usage: { input: 10, output: 7, cacheRead: 0, cacheWrite: 0, reasoning: 3, totalTokens: 17 },
        contextUsage: { tokens: 12_500, contextWindow: 128_000, percent: 9.765625 },
        latencyMs: 5,
        recalledStateEstimatedTokens: 0
      }
    }).success).toBe(true);
  });

  it("turns an oversized capability response into an explicit bounded failure", () => {
    const result = normalizeCapabilityExecutionResult({
      schemaVersion: 1,
      requestId: "request-1",
      status: "completed",
      content: "x".repeat(CAPABILITY_RESULT_CONTENT_MAX_CHARS + 1)
    });
    expect(result).toMatchObject({
      requestId: "request-1",
      status: "failed",
      code: "CAPABILITY_RESPONSE_INVALID"
    });
    expect(result.content.length).toBeLessThanOrEqual(CAPABILITY_RESULT_CONTENT_MAX_CHARS);
  });

  it("creates a versioned command with explicit actor identity", () => {
    const command = createBootstrapCommand();
    expect(command.schemaVersion).toBe(IPC_SCHEMA_VERSION);
    expect(command.actor).toEqual({ actorType: "user", actorId: "local-user" });
    expect(command.expectedStateVersion).toBe(1);
    expect(command.scope).toBe("unscoped");
    expect(hostCommandSchema.parse(command)).toEqual(command);
  });

  it("rejects the retired bundled academic Skill activation command", () => {
    const command = { ...createBootstrapCommand(), command: "skills.academic.install" };
    expect(hostCommandSchema.safeParse(command).success).toBe(false);
  });

  it("accepts the Pi-native resource source commands and state event", () => {
    const metadata = {
      schemaVersion: IPC_SCHEMA_VERSION,
      commandId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      actor: { actorType: "user", actorId: "local-user" },
      sentAt: new Date().toISOString()
    };
    expect(hostCommandSchema.safeParse({ ...metadata, command: "pi.resources.load" }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "pi.resources.reload" }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "pi.resources.import_skill" }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "pi.skills.set_enabled", payload: { id: "fixture/SKILL.md", enabled: false } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "pi.resources.open", payload: { target: "mcp_config" } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "pi.resources.project_trust.set", payload: { trusted: true } }).success).toBe(true);

    const now = new Date().toISOString();
    const eventMetadata = {
      schemaVersion: IPC_SCHEMA_VERSION,
      eventId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      sequence: 1,
      actor: { actorType: "host", actorId: "desktop-host" },
      provenance: { producerType: "host", producerId: "desktop-host" },
      occurredAt: now
    };
    const state = {
      schemaVersion: 1,
      generation: 1,
      reloadPending: false,
      extensions: {
        status: "ready",
        directoryPath: "C:/vc-agent/pi/extensions",
        loadedCount: 1,
        diagnostics: [],
        trustDisclosure: "Extensions are trusted Worker code."
      },
      mcp: {
        status: "ready",
        configPath: "C:/vc-agent/pi/mcp.json",
        serverCount: 0,
        connectedServerCount: 0,
        diagnostics: [],
        trustDisclosure: "Configured MCP servers are trusted as a set."
      },
      skills: {
        status: "ready",
        directoryPath: "C:/vc-agent/skills",
        loadedCount: 2,
        items: [{ id: "fixture/SKILL.md", name: "fixture", description: "Fixture Skill", relativePath: "fixture/SKILL.md", enabled: true }],
        diagnostics: [],
        trustDisclosure: "Skills are trusted instructions.",
        sourceIsolationDisclosure: "Only this dedicated directory is searched."
      },
      diagnostics: []
    };
    expect(hostEventSchema.safeParse({ ...eventMetadata, event: "pi.resources.updated", payload: { state, action: "reloaded" } }).success).toBe(true);
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

  it("rejects retired direct model-derived Memory write commands", () => {
    const base = {
      schemaVersion: 1, command: "long_term_memory.patch.commit", commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(),
      actor: { actorType: "user", actorId: "local-user" }, sentAt: new Date().toISOString(), payload: { patchId: "patch-00000001", confirmed: true }
    };
    expect(hostCommandSchema.safeParse(base).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...base, command: "project.memory.append.confirm" }).success).toBe(false);
  });

  it("supports editing a saved Model Profile without requiring credential replacement", () => {
    const metadata = { schemaVersion: 1, commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actor: { actorType: "user", actorId: "local-user" }, sentAt: new Date().toISOString() };
    const command = {
      ...metadata,
      command: "profile.update",
      payload: { profileId: crypto.randomUUID(), name: "Updated", provider: "openai", model: "gpt-5", thinkingLevel: "medium", contextWindow: 200_000, maxOutputTokens: 32_000 }
    };
    expect(hostCommandSchema.safeParse(command).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...command, payload: { ...command.payload, maxOutputTokens: 200_000 } }).success).toBe(false);
  });

  it("supports protected academic source credential configuration without returning secrets", () => {
    const metadata = { schemaVersion: 1, commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actor: { actorType: "user", actorId: "local-user" }, sentAt: new Date().toISOString() };
    expect(hostCommandSchema.safeParse({ ...metadata, command: "academic.credentials.list" }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "academic.credentials.set", payload: { source: "openalex", credential: "secret-value" } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "academic.credentials.clear", payload: { source: "github" } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "academic.credentials.set", payload: { source: "arxiv", credential: "not-supported" } }).success).toBe(false);

    const event = {
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      sequence: 0,
      actor: { actorType: "host", actorId: "desktop-host" },
      provenance: { producerType: "host", producerId: "desktop-host" },
      occurredAt: new Date().toISOString(),
      event: "academic.credentials.updated",
      payload: {
        credentials: [
          { source: "openalex", configured: true },
          { source: "github", configured: false },
          { source: "huggingface", configured: false }
        ],
        action: "set"
      }
    };
    expect(hostEventSchema.parse(event)).not.toHaveProperty("payload.credential");
  });

  it("requires explicit confirmation to delete an entire Thread", () => {
    const metadata = { schemaVersion: 1, commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actor: { actorType: "user", actorId: "local-user" }, sentAt: new Date().toISOString() };
    const command = { ...metadata, command: "thread.delete", payload: { threadId: "thread-1", confirmed: true } };
    expect(hostCommandSchema.safeParse(command).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...command, payload: { ...command.payload, confirmed: false } }).success).toBe(false);
    expect(hostEventSchema.safeParse({
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      sequence: 0,
      actor: { actorType: "host", actorId: "desktop-host" },
      provenance: { producerType: "host", producerId: "desktop-host" },
      occurredAt: new Date().toISOString(),
      event: "thread.deleted",
      payload: { threadId: "thread-1", removedCandidateIds: [], affectedBatchIds: [] }
    }).success).toBe(true);
  });

  it("supports renaming a Thread through the versioned Host contract", () => {
    const metadata = { schemaVersion: 1, commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actor: { actorType: "user", actorId: "local-user" }, sentAt: new Date().toISOString() };
    expect(hostCommandSchema.safeParse({ ...metadata, command: "thread.rename", payload: { threadId: "thread-1", title: "Investment Thesis" } }).success).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "thread.rename", payload: { threadId: "thread-1", title: "   " } }).success).toBe(false);
    expect(hostEventSchema.safeParse({
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      sequence: 0,
      actor: { actorType: "host", actorId: "desktop-host" },
      provenance: { producerType: "host", producerId: "desktop-host" },
      occurredAt: new Date().toISOString(),
      event: "thread.renamed",
      payload: { thread: { id: "thread-1", title: "Investment Thesis", scope: "unscoped", stateVersion: 2, createdAt: new Date().toISOString() } }
    }).success).toBe(true);
  });

  it("rejects retired stage-level Reflection commands", () => {
    const metadata = { schemaVersion: 1, commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actor: { actorType: "user", actorId: "local-user" }, sentAt: new Date().toISOString() };
    const runId = crypto.randomUUID();
    expect(hostCommandSchema.safeParse({ ...metadata, command: "reflection.independent.start", payload: { runId } }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "reflection.independent.stop", payload: { runId } }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "reflection.memory_aware.start", payload: { runId } }).success).toBe(false);
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

  it("rejects retired generic Skill management commands", () => {
    const metadata = { schemaVersion: 1, commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actor: { actorType: "user", actorId: "local-user" }, sentAt: new Date().toISOString() };
    const revisionId = crypto.randomUUID();
    expect(hostCommandSchema.safeParse({ ...metadata, command: "skills.list" }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "skills.import" }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "skills.inspect", payload: { revisionId } }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "skills.activate", payload: { revisionId } }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "skills.disable", payload: { packageId: "office-docs" } }).success).toBe(false);
  });

  it("supports the protected workflow command families and rejects retired integration governance", () => {
    const metadata = { schemaVersion: 1, commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actor: { actorType: "user", actorId: "local-user" }, sentAt: new Date().toISOString() };
    const revisionId = crypto.randomUUID();
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
      { command: "pi.resources.reload" }
    ] as const;
    for (const command of commands) expect(hostCommandSchema.safeParse({ ...metadata, ...command }).success, command.command).toBe(true);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "mcp.server.list" }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "mcp.server.save", payload: { name: "Fixture", transport: "fixture", enabled: true, allowedScopes: ["project"] } }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "mcp.activate", payload: { serverId: crypto.randomUUID(), toolIds: [], scope: "project", threadId: "thread-1" } }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "extension.list" }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "extension.stage" }).success).toBe(false);
    expect(hostCommandSchema.safeParse({ ...metadata, command: "extension.inspect", payload: { stagedRevisionId } }).success).toBe(false);
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
