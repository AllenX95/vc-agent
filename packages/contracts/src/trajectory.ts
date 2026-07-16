import { z } from "zod";
import {
  actorRefSchema,
  IPC_SCHEMA_VERSION,
  modelProfileSchema,
  promptContributionSchema,
  provenanceRefSchema,
  providerFailureSchema,
  usageSchema
} from "./ipc.js";

export const trajectoryProfileSchema = modelProfileSchema.pick({
  id: true,
  name: true,
  provider: true,
  model: true,
  thinkingLevel: true
});
export type TrajectoryProfile = z.infer<typeof trajectoryProfileSchema>;

const trajectoryEventBase = z.object({
  schemaVersion: z.literal(IPC_SCHEMA_VERSION),
  eventId: z.string().min(1),
  correlationId: z.string().min(1),
  sequence: z.number().int().positive(),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  actor: actorRefSchema,
  provenance: provenanceRefSchema,
  occurredAt: z.string().datetime()
});

const turnSubmitted = trajectoryEventBase.extend({
  event: z.literal("turn.submitted"),
  payload: z.object({
    text: z.string(),
    idempotencyKey: z.string().min(1),
    retryOfTurnId: z.string().min(1).optional(),
    profile: trajectoryProfileSchema.optional(),
    prompt: z.object({ revisionId: z.string().uuid(), hash: z.string(), contributions: promptContributionSchema }).optional()
  })
});
const systemPromptUpdated = trajectoryEventBase.extend({
  event: z.literal("system_prompt.updated"),
  payload: z.object({ previousRevisionId: z.string().uuid(), nextRevisionId: z.string().uuid() })
});
const turnStarted = trajectoryEventBase.extend({
  event: z.literal("turn.started"),
  payload: z.object({ profile: trajectoryProfileSchema })
});
const turnCompleted = trajectoryEventBase.extend({
  event: z.literal("turn.completed"),
  payload: z.object({
    message: z.string(),
    profile: trajectoryProfileSchema,
    usage: usageSchema,
    responseId: z.string().optional(),
    piEntryId: z.string().optional()
  })
});
const turnFailed = trajectoryEventBase.extend({
  event: z.literal("turn.failed"),
  payload: z.object({ profile: trajectoryProfileSchema.optional(), failure: providerFailureSchema })
});
const turnInterrupted = trajectoryEventBase.extend({
  event: z.literal("turn.interrupted"),
  payload: z.object({
    partialMessage: z.string(),
    reason: z.enum(["user_stop", "worker_exit", "application_restart", "provider_interrupted"]),
    profile: trajectoryProfileSchema.optional(),
    tools: z.array(z.object({
      toolCallId: z.string().min(1),
      capabilityId: z.string().min(1),
      status: z.enum(["started", "interrupted", "unknown_outcome"])
    })),
    lastWorkerSequence: z.number().int().nonnegative(),
    lastHostSequence: z.number().int().nonnegative()
  })
});
const toolTerminal = trajectoryEventBase.extend({
  event: z.enum(["tool.completed", "tool.failed", "tool.unknown_outcome"]),
  payload: z.object({
    toolCallId: z.string().min(1),
    capabilityId: z.string().min(1),
    summary: z.string().max(20_000),
    artifactIds: z.array(z.string().min(1))
  })
});
const toolStarted = trajectoryEventBase.extend({
  event: z.literal("tool.started"),
  payload: z.object({
    toolCallId: z.string().min(1),
    capabilityId: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
    expectedStateVersion: z.number().int().positive()
  })
});
const artifactCreated = trajectoryEventBase.extend({
  event: z.literal("artifact.created"),
  payload: z.object({
    artifactId: z.string().min(1),
    mediaType: z.string().min(1),
    destination: z.string().min(1),
    sourceTurnId: z.string().min(1)
  })
});
const contextRebuilt = trajectoryEventBase.extend({
  event: z.literal("physical_context.rebuilt"),
  payload: z.object({ reason: z.enum(["missing", "host_ahead", "pi_ahead", "irreconcilable"]), retainedTurnCount: z.number().int().nonnegative() })
});
const providerContinuation = trajectoryEventBase.extend({
  event: z.literal("provider_continuation.authorized"),
  payload: z.object({
    previousProvider: z.string().min(1),
    previousModel: z.string().min(1),
    nextProvider: z.string().min(1),
    nextModel: z.string().min(1),
    action: z.enum(["continue_current_thread", "start_new_thread"]),
    destinationThreadId: z.string().min(1),
    retainedContext: z.enum(["visible-retained-trajectory", "none"])
  })
});

export const trajectoryEventSchema = z.discriminatedUnion("event", [
  turnSubmitted,
  systemPromptUpdated,
  turnStarted,
  turnCompleted,
  turnFailed,
  turnInterrupted,
  toolStarted,
  toolTerminal,
  artifactCreated,
  contextRebuilt,
  providerContinuation
]);
export type TrajectoryEvent = z.infer<typeof trajectoryEventSchema>;

export const trajectoryTurnSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  text: z.string(),
  assistantText: z.string(),
  status: z.enum(["submitted", "active", "completed", "failed", "interrupted"]),
  profile: trajectoryProfileSchema.optional(),
  usage: usageSchema.optional(),
  failure: providerFailureSchema.optional(),
  interruptionReason: z.string().optional(),
  submittedSequence: z.number().int().positive(),
  lastSequence: z.number().int().positive(),
  prompt: z.object({ revisionId: z.string().uuid(), hash: z.string(), contributions: promptContributionSchema }).optional()
});
export type TrajectoryTurn = z.infer<typeof trajectoryTurnSchema>;

export const trajectoryActivitySchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  sequence: z.number().int().positive(),
  kind: z.enum(["tool", "artifact", "context"]),
  label: z.string().min(1),
  status: z.enum(["started", "completed", "failed", "unknown_outcome"]),
  content: z.string(),
  artifact: z.object({ id: z.string().min(1), mediaType: z.string().min(1), destination: z.string().min(1) }).optional()
});
export type TrajectoryActivity = z.infer<typeof trajectoryActivitySchema>;

export const inflightTurnCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  checkpointId: z.string().min(1),
  interruptionEventId: z.string().min(1),
  correlationId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  profile: trajectoryProfileSchema.optional(),
  partialMessage: z.string(),
  startedTools: z.array(z.object({
    toolCallId: z.string().min(1),
    capabilityId: z.string().min(1),
    status: z.enum(["started", "interrupted", "unknown_outcome"])
  })),
  lastWorkerSequence: z.number().int().nonnegative(),
  lastHostSequence: z.number().int().nonnegative(),
  updatedAt: z.string().datetime()
});
export type InflightTurnCheckpoint = z.infer<typeof inflightTurnCheckpointSchema>;

export const physicalContextHistoryItemSchema = z.object({
  user: z.string(),
  assistant: z.string(),
  status: z.enum(["completed", "interrupted"]),
  profile: trajectoryProfileSchema.optional()
});
export type PhysicalContextHistoryItem = z.infer<typeof physicalContextHistoryItemSchema>;
