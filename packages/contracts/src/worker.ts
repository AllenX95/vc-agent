import { z } from "zod";
import { IPC_SCHEMA_VERSION, providerFailureSchema, thinkingLevelSchema, usageSchema } from "./ipc.js";

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

export const workerCommandSchema = z.object({
  schemaVersion: z.literal(IPC_SCHEMA_VERSION),
  command: z.literal("turn.execute"),
  commandId: z.string().min(1),
  correlationId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  cwd: z.string().min(1),
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
export type WorkerCommand = z.infer<typeof workerCommandSchema>;

const workerEventBase = z.object({
  schemaVersion: z.literal(IPC_SCHEMA_VERSION),
  correlationId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1)
});
const started = workerEventBase.extend({ event: z.literal("turn.started") });
const delta = workerEventBase.extend({ event: z.literal("message.delta"), delta: z.string() });
const completed = workerEventBase.extend({
  event: z.literal("turn.completed"),
  message: z.string(),
  usage: usageSchema,
  responseId: z.string().optional()
});
const failed = workerEventBase.extend({ event: z.literal("turn.failed"), failure: providerFailureSchema });

export const workerEventSchema = z.discriminatedUnion("event", [started, delta, completed, failed]);
export type WorkerEvent = z.infer<typeof workerEventSchema>;
