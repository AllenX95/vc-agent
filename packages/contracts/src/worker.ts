import { z } from "zod";
import { contextUsageSchema, IPC_SCHEMA_VERSION, providerFailureSchema, thinkingLevelSchema, usageSchema } from "./ipc.js";
import { physicalContextHistoryItemSchema } from "./trajectory.js";
import { capabilityExecutionRequestSchema, capabilityExecutionResultSchema, capabilitySurfaceSnapshotSchema } from "./capability.js";

const runtimeSkillDecisionSchema = z.object({
  packageId: z.string().min(1),
  revisionId: z.string().min(1),
  reason: z.enum(["task_match", "explicit"]),
  resources: z.array(z.string().min(1)),
  capabilities: z.array(z.string().min(1))
});

const runtimeSkillInstructionSchema = z.object({
  packageId: z.string().min(1),
  revisionId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  filePath: z.string().min(1),
  baseDir: z.string().min(1),
  content: z.string()
});

const runtimeSkillResourceSchema = z.object({
  packageId: z.string().min(1),
  relativePath: z.string().min(1),
  content: z.string()
});

export const runtimeSkillSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  revisionId: z.string().min(1),
  decisions: z.array(runtimeSkillDecisionSchema),
  instructions: z.array(runtimeSkillInstructionSchema),
  resources: z.array(runtimeSkillResourceSchema)
});
export type RuntimeSkillSnapshot = z.infer<typeof runtimeSkillSnapshotSchema>;

export const runtimeResourceSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  revisionId: z.string().min(1),
  systemPrompt: z.string(),
  appendSystemPrompt: z.array(z.string()),
  /** Task-scoped, Host-owned Skill projection. Older replay commands may omit it. */
  skills: runtimeSkillSnapshotSchema.optional()
});
export type RuntimeResourceSnapshot = z.infer<typeof runtimeResourceSnapshotSchema>;

export const extensionInventorySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  revisionId: z.string().min(1),
  enabled: z.array(
    z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      entryPath: z.string().min(1),
      integrity: z.string().min(1),
      trust: z.enum(["bundled-reviewed", "approved-trusted"])
    })
  )
});
export type ExtensionInventorySnapshot = z.infer<typeof extensionInventorySnapshotSchema>;

const workerCommandBase = z.object({
  schemaVersion: z.literal(IPC_SCHEMA_VERSION),
  commandId: z.string().min(1),
  correlationId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  /** Added by the Host runtime boundary before dispatch. Optional for old persisted/replay-safe commands. */
  ownerKey: z.string().min(1).optional(),
  workerRevision: z.string().min(1).optional(),
  sessionKey: z.string().min(1).optional()
});
const executeTurn = workerCommandBase.extend({
  command: z.literal("turn.execute"),
  compactOnly: z.literal(true).optional(),
  cwd: z.string().min(1),
  threadDirectory: z.string().min(1),
  previousSessionFile: z.string().min(1).optional(),
  hostHighWater: z.object({ eventId: z.string().min(1), sequence: z.number().int().positive() }).optional(),
  contextHistory: z.array(physicalContextHistoryItemSchema),
  estimatedInputTokens: z.number().int().nonnegative(),
  currentInputTokens: z.number().int().nonnegative(),
  /** New surface contract; activeCapabilities remains for replay compatibility during migration. */
  capabilitySurface: capabilitySurfaceSnapshotSchema.optional(),
  activeCapabilities: z.array(z.string().min(1)),
  expectedStateVersion: z.number().int().positive(),
  executionScope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unscoped"), threadId: z.string().min(1) }),
    z.object({ kind: z.literal("project"), projectId: z.string().uuid() })
  ]),
  prompt: z.string().min(1),
  profile: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    apiKey: z.string().min(1),
    thinkingLevel: thinkingLevelSchema,
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional()
  }),
  resources: runtimeResourceSnapshotSchema,
  extensions: extensionInventorySnapshotSchema
});
const stopTurn = workerCommandBase.extend({ command: z.literal("turn.stop") });
const acknowledgeTrajectory = workerCommandBase.extend({
  command: z.literal("trajectory.acknowledge"),
  eventId: z.string().min(1),
  sequence: z.number().int().positive()
});
const resolveCapabilityExecution = workerCommandBase.extend({
  command: z.literal("capability.execution.resolve"),
  result: capabilityExecutionResultSchema
});

export const workerCommandSchema = z.discriminatedUnion("command", [executeTurn, stopTurn, acknowledgeTrajectory, resolveCapabilityExecution]);
export type WorkerCommand = z.infer<typeof workerCommandSchema>;

const workerEventBase = z.object({
  schemaVersion: z.literal(IPC_SCHEMA_VERSION),
  correlationId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  workerSequence: z.number().int().positive(),
  ownerKey: z.string().min(1).optional(),
  workerRevision: z.string().min(1).optional(),
  sessionKey: z.string().min(1).optional()
});
const contextReady = workerEventBase.extend({
  event: z.literal("physical_context.ready"),
  sessionFile: z.string().min(1),
  reconciliation: z.enum(["resumed", "missing", "host_ahead", "pi_ahead", "irreconcilable"]),
  retainedTurnCount: z.number().int().nonnegative(),
  contextUsage: contextUsageSchema.optional()
});
const started = workerEventBase.extend({ event: z.literal("turn.started") });
const delta = workerEventBase.extend({ event: z.literal("message.delta"), delta: z.string() });
const thinkingDelta = workerEventBase.extend({ event: z.literal("thinking.delta"), delta: z.string() });
const completed = workerEventBase.extend({
  event: z.literal("turn.completed"),
  message: z.string(),
  usage: usageSchema,
  contextUsage: contextUsageSchema.optional(),
  responseId: z.string().optional(),
  piEntryId: z.string().optional()
});
const failed = workerEventBase.extend({ event: z.literal("turn.failed"), failure: providerFailureSchema });
const interrupted = workerEventBase.extend({
  event: z.literal("turn.interrupted"),
  reason: z.enum(["user_stop", "provider_interrupted"])
});
const acknowledged = workerEventBase.extend({ event: z.literal("trajectory.acknowledged"), eventId: z.string().min(1), sequence: z.number().int().positive() });
const capabilityRequested = workerEventBase.extend({ event: z.literal("capability.execution.requested"), request: capabilityExecutionRequestSchema });
const nativeToolStarted = workerEventBase.extend({
  event: z.literal("native_tool.started"),
  toolCallId: z.string().min(1),
  toolName: z.enum(["read", "ls", "find", "grep"]),
  arguments: z.record(z.string(), z.unknown())
});
const nativeToolCompleted = workerEventBase.extend({
  event: z.literal("native_tool.completed"),
  toolCallId: z.string().min(1),
  toolName: z.enum(["read", "ls", "find", "grep"]),
  content: z.string().max(20_000),
  isError: z.boolean()
});
const compactionStarted = workerEventBase.extend({
  event: z.literal("thread.compaction.started"),
  reason: z.enum(["manual", "threshold", "overflow"])
});
const compactionCompleted = workerEventBase.extend({
  event: z.literal("thread.compaction.completed"),
  reason: z.enum(["manual", "threshold", "overflow"]),
  tokensBefore: z.number().int().nonnegative(),
  estimatedTokensAfter: z.number().int().nonnegative().optional()
});
const compactionFailed = workerEventBase.extend({
  event: z.literal("thread.compaction.failed"),
  reason: z.enum(["manual", "threshold", "overflow"]),
  failure: providerFailureSchema
});

export const workerEventSchema = z.discriminatedUnion("event", [contextReady, started, delta, thinkingDelta, completed, failed, interrupted, acknowledged, capabilityRequested, nativeToolStarted, nativeToolCompleted, compactionStarted, compactionCompleted, compactionFailed]);
export type WorkerEvent = z.infer<typeof workerEventSchema>;
