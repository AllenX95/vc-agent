import { z } from "zod";

export const IPC_SCHEMA_VERSION = 1 as const;

export const actorRefSchema = z.object({
  actorType: z.enum(["user", "host", "agent", "sub_agent", "utility"]),
  actorId: z.string().min(1),
  parentActorId: z.string().min(1).optional()
});

export type ActorRef = z.infer<typeof actorRefSchema>;

export const provenanceRefSchema = z.object({
  producerType: z.enum(["user", "host", "agent", "sub_agent", "utility"]),
  producerId: z.string().min(1)
});

export type ProvenanceRef = z.infer<typeof provenanceRefSchema>;

const commandMetadataSchema = z.object({
  schemaVersion: z.literal(IPC_SCHEMA_VERSION),
  commandId: z.string().min(1),
  correlationId: z.string().min(1),
  actor: actorRefSchema,
  sentAt: z.string().datetime()
});

const bootstrapCommandSchema = commandMetadataSchema.extend({
  command: z.literal("app.bootstrap")
});

export const hostCommandSchema = z.discriminatedUnion("command", [
  bootstrapCommandSchema
]);

export type HostCommand = z.infer<typeof hostCommandSchema>;

const eventMetadataSchema = z.object({
  schemaVersion: z.literal(IPC_SCHEMA_VERSION),
  eventId: z.string().min(1),
  correlationId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  actor: actorRefSchema,
  provenance: provenanceRefSchema,
  occurredAt: z.string().datetime()
});

export const bootstrapStateSchema = z.object({
  applicationVersion: z.string().min(1),
  stateSchemaVersion: z.number().int().positive(),
  storagePath: z.string().min(1),
  entityCounts: z.object({
    projects: z.literal(0),
    threads: z.literal(0),
    modelProfiles: z.literal(0),
    taskAssignments: z.literal(0)
  }),
  runtimeActivity: z.object({
    agentWorkersStarted: z.literal(0),
    piSessionsStarted: z.literal(0),
    providerRequests: z.literal(0),
    externalNetworkRequests: z.number().int().nonnegative()
  })
});

const bootstrapCompletedEventSchema = eventMetadataSchema.extend({
  event: z.literal("app.bootstrap.completed"),
  payload: bootstrapStateSchema
});

const diagnosticRaisedEventSchema = eventMetadataSchema.extend({
  event: z.literal("diagnostic.raised"),
  payload: z.object({
    code: z.enum(["UNSUPPORTED_SCHEMA_VERSION", "INVALID_COMMAND", "HOST_FAILURE"]),
    message: z.string().min(1),
    recoverable: z.boolean()
  })
});

export const hostEventSchema = z.discriminatedUnion("event", [
  bootstrapCompletedEventSchema,
  diagnosticRaisedEventSchema
]);

export type HostEvent = z.infer<typeof hostEventSchema>;
export type BootstrapState = z.infer<typeof bootstrapStateSchema>;

export interface VcAgentBridge {
  invoke(command: HostCommand): Promise<HostEvent>;
  onEvent(listener: (event: HostEvent) => void): () => void;
}

export function createBootstrapCommand(): HostCommand {
  return {
    schemaVersion: IPC_SCHEMA_VERSION,
    command: "app.bootstrap",
    commandId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    actor: { actorType: "user", actorId: "local-user" },
    sentAt: new Date().toISOString()
  };
}
