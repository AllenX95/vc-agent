import { z } from "zod";
import { IPC_SCHEMA_VERSION, providerFailureSchema, thinkingLevelSchema, usageSchema } from "./ipc.js";
import { physicalContextHistoryItemSchema } from "./trajectory.js";
import { capabilityExecutionRequestSchema, capabilityExecutionResultSchema } from "./capability.js";

export const runtimeResourceSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  revisionId: z.string().min(1),
  systemPrompt: z.string(),
  appendSystemPrompt: z.array(z.string())
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
      trust: z.literal("bundled-reviewed")
    })
  )
});
export type ExtensionInventorySnapshot = z.infer<typeof extensionInventorySnapshotSchema>;

const workerCommandBase = z.object({
  schemaVersion: z.literal(IPC_SCHEMA_VERSION),
  commandId: z.string().min(1),
  correlationId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1)
});
const executeTurn = workerCommandBase.extend({
  command: z.literal("turn.execute"),
  cwd: z.string().min(1),
  threadDirectory: z.string().min(1),
  previousSessionFile: z.string().min(1).optional(),
  hostHighWater: z.object({ eventId: z.string().min(1), sequence: z.number().int().positive() }).optional(),
  contextHistory: z.array(physicalContextHistoryItemSchema),
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
    thinkingLevel: thinkingLevelSchema
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
  workerSequence: z.number().int().positive()
});
const contextReady = workerEventBase.extend({
  event: z.literal("physical_context.ready"),
  sessionFile: z.string().min(1),
  reconciliation: z.enum(["resumed", "missing", "host_ahead", "pi_ahead", "irreconcilable"]),
  retainedTurnCount: z.number().int().nonnegative()
});
const started = workerEventBase.extend({ event: z.literal("turn.started") });
const delta = workerEventBase.extend({ event: z.literal("message.delta"), delta: z.string() });
const completed = workerEventBase.extend({
  event: z.literal("turn.completed"),
  message: z.string(),
  usage: usageSchema,
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

export const workerEventSchema = z.discriminatedUnion("event", [contextReady, started, delta, completed, failed, interrupted, acknowledged, capabilityRequested]);
export type WorkerEvent = z.infer<typeof workerEventSchema>;
