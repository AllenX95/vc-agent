import { z } from "zod";
import { contextBudgetTelemetrySchema, contextUsageSchema, IPC_SCHEMA_VERSION, providerFailureSchema, thinkingLevelSchema, usageSchema } from "./ipc.js";
import { physicalContextHistoryItemSchema } from "./trajectory.js";
import { capabilityExecutionRequestSchema, capabilityExecutionResultSchema, capabilitySurfaceSnapshotSchema } from "./capability.js";
/**
 * Host-owned prompt/context metadata carried across the Worker seam.
 *
 * Pi resource discovery (Extensions, MCP, and Skills) is intentionally absent
 * here. Those resources are loaded by the native Pi ResourceRuntime from
 * `piResources`; the Host only supplies its own prompt contribution.
 */
export const runtimeResourceSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  revisionId: z.string().min(1),
  systemPrompt: z.string(),
  appendSystemPrompt: z.array(z.string())
});
export type RuntimeResourceSnapshot = z.infer<typeof runtimeResourceSnapshotSchema>;

/**
 * Application-owned Pi resource roots for the native loading path.
 *
 * This is deliberately a path/configuration contract, not an admission or
 * activation record.  The Worker passes the values to Pi's native
 * DefaultResourceLoader; the legacy snapshots below remain optional
 * compatibility inputs while the desktop sender is migrated.
 */
export const piResourcesSchema = z.object({
  agentDir: z.string().min(1),
  skillsRoot: z.string().min(1),
  extensionPaths: z.array(z.string().min(1)).optional(),
  mcpConfigPath: z.string().min(1).optional(),
  projectResourcesTrusted: z.boolean().optional()
});
export type PiResources = z.infer<typeof piResourcesSchema>;

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
  contextBudget: contextBudgetTelemetrySchema.optional(),
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
  /** Native Pi resource roots. Omitted by old/replay commands. */
  piResources: piResourcesSchema.optional()
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
const runtimeToolStarted = workerEventBase.extend({
  event: z.literal("runtime_tool.started"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  source: z.enum(["bundled_extension", "pi_extension"]),
  sourceId: z.string().min(1),
  sourceRevision: z.string().min(1),
  arguments: z.record(z.string(), z.unknown())
});
const runtimeToolCompleted = workerEventBase.extend({
  event: z.literal("runtime_tool.completed"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  source: z.enum(["bundled_extension", "pi_extension"]),
  sourceId: z.string().min(1),
  sourceRevision: z.string().min(1),
  content: z.string().max(20_000),
  isError: z.boolean(),
  durationMs: z.number().int().nonnegative()
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

export const workerEventSchema = z.discriminatedUnion("event", [contextReady, started, delta, thinkingDelta, completed, failed, interrupted, acknowledged, capabilityRequested, nativeToolStarted, nativeToolCompleted, runtimeToolStarted, runtimeToolCompleted, compactionStarted, compactionCompleted, compactionFailed]);
export type WorkerEvent = z.infer<typeof workerEventSchema>;
