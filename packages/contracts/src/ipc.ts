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

export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export const modelProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  credentialRef: z.string().min(1),
  thinkingLevel: thinkingLevelSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;

export const unscopedThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  scope: z.literal("unscoped"),
  activeProfileId: z.string().min(1).optional(),
  outputLocation: z.string().min(1).optional(),
  stateVersion: z.number().int().positive(),
  createdAt: z.string().datetime()
});
export type UnscopedThread = z.infer<typeof unscopedThreadSchema>;

export const usageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  totalTokens: z.number().nonnegative()
});
export type TokenUsage = z.infer<typeof usageSchema>;

export const providerFailureSchema = z.object({
  kind: z.enum(["configuration", "provider", "worker"]),
  code: z.string().min(1),
  message: z.string().min(1).max(1200),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  requestId: z.string().min(1).optional()
});
export type ProviderFailure = z.infer<typeof providerFailureSchema>;

const ipcTrajectoryProfileSchema = modelProfileSchema.pick({
  id: true,
  name: true,
  provider: true,
  model: true,
  thinkingLevel: true
});
const ipcTrajectoryTurnSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  text: z.string(),
  assistantText: z.string(),
  status: z.enum(["submitted", "active", "completed", "failed", "interrupted"]),
  profile: ipcTrajectoryProfileSchema.optional(),
  usage: usageSchema.optional(),
  failure: providerFailureSchema.optional(),
  interruptionReason: z.string().optional(),
  submittedSequence: z.number().int().positive(),
  lastSequence: z.number().int().positive()
});
const ipcTrajectoryActivitySchema = z.object({
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

const commandMetadataSchema = z.object({
  schemaVersion: z.literal(IPC_SCHEMA_VERSION),
  commandId: z.string().min(1),
  correlationId: z.string().min(1),
  actor: actorRefSchema,
  sentAt: z.string().datetime()
});

const bootstrapCommandSchema = commandMetadataSchema.extend({ command: z.literal("app.bootstrap") });
const listProfilesCommandSchema = commandMetadataSchema.extend({ command: z.literal("profile.list") });
const setAccessModeCommandSchema = commandMetadataSchema.extend({
  command: z.literal("access.mode.set"),
  payload: z.object({ mode: z.enum(["standard", "full"]) })
});
const createProfileCommandSchema = commandMetadataSchema.extend({
  command: z.literal("profile.create"),
  payload: z.object({
    name: z.string().trim().min(1).max(80),
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(160),
    apiKey: z.string().min(1).max(8192),
    thinkingLevel: thinkingLevelSchema
  })
});
const listThreadsCommandSchema = commandMetadataSchema.extend({ command: z.literal("thread.list") });
const loadThreadTrajectoryCommandSchema = commandMetadataSchema.extend({
  command: z.literal("thread.trajectory.load"),
  payload: z.object({ threadId: z.string().min(1) })
});
const createThreadCommandSchema = commandMetadataSchema.extend({
  command: z.literal("thread.create.unscoped"),
  payload: z.object({ title: z.string().trim().min(1).max(120) })
});
const selectThreadProfileCommandSchema = commandMetadataSchema.extend({
  command: z.literal("thread.profile.select"),
  payload: z.object({ threadId: z.string().min(1), profileId: z.string().min(1) })
});
const resolveThreadProfileChangeCommandSchema = commandMetadataSchema.extend({
  command: z.literal("thread.profile.change.resolve"),
  payload: z.object({
    threadId: z.string().min(1),
    profileId: z.string().min(1),
    action: z.enum(["continue_current_thread", "start_new_thread"])
  })
});
const chooseOutputLocationCommandSchema = commandMetadataSchema.extend({
  command: z.literal("thread.output.location.choose"),
  payload: z.object({ threadId: z.string().min(1) })
});
const submitTurnCommandSchema = commandMetadataSchema.extend({
  command: z.literal("turn.submit"),
  payload: z.object({
    threadId: z.string().min(1),
    text: z.string().trim().min(1).max(200_000),
    retryOfTurnId: z.string().min(1).optional()
  })
});
const stopTurnCommandSchema = commandMetadataSchema.extend({
  command: z.literal("turn.stop"),
  payload: z.object({ threadId: z.string().min(1), turnId: z.string().min(1) })
});
const resolveCapabilityConfirmationCommandSchema = commandMetadataSchema.extend({
  command: z.literal("capability.confirmation.resolve"),
  payload: z.object({ requestId: z.string().min(1), approved: z.boolean() })
});

export const hostCommandSchema = z.discriminatedUnion("command", [
  bootstrapCommandSchema,
  setAccessModeCommandSchema,
  listProfilesCommandSchema,
  createProfileCommandSchema,
  listThreadsCommandSchema,
  loadThreadTrajectoryCommandSchema,
  createThreadCommandSchema,
  selectThreadProfileCommandSchema,
  resolveThreadProfileChangeCommandSchema,
  chooseOutputLocationCommandSchema,
  submitTurnCommandSchema,
  stopTurnCommandSchema,
  resolveCapabilityConfirmationCommandSchema
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
  accessMode: z.enum(["standard", "full"]),
  entityCounts: z.object({
    projects: z.number().int().nonnegative(),
    threads: z.number().int().nonnegative(),
    modelProfiles: z.number().int().nonnegative(),
    taskAssignments: z.number().int().nonnegative()
  }),
  runtimeActivity: z.object({
    agentWorkersStarted: z.number().int().nonnegative(),
    piSessionsStarted: z.number().int().nonnegative(),
    providerRequests: z.number().int().nonnegative(),
    externalNetworkRequests: z.number().int().nonnegative()
  })
});

const bootstrapCompletedEventSchema = eventMetadataSchema.extend({
  event: z.literal("app.bootstrap.completed"),
  payload: bootstrapStateSchema
});
const accessModeChangedEventSchema = eventMetadataSchema.extend({
  event: z.literal("access.mode.changed"),
  payload: z.object({ mode: z.enum(["standard", "full"]) })
});
const diagnosticRaisedEventSchema = eventMetadataSchema.extend({
  event: z.literal("diagnostic.raised"),
  payload: z.object({
    code: z.enum(["UNSUPPORTED_SCHEMA_VERSION", "INVALID_COMMAND", "HOST_FAILURE"]),
    message: z.string().min(1),
    recoverable: z.boolean()
  })
});
const profilesListedEventSchema = eventMetadataSchema.extend({
  event: z.literal("profiles.listed"),
  payload: z.object({ profiles: z.array(modelProfileSchema) })
});
const profileCreatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("profile.created"),
  payload: z.object({ profile: modelProfileSchema })
});
const threadsListedEventSchema = eventMetadataSchema.extend({
  event: z.literal("threads.listed"),
  payload: z.object({ threads: z.array(unscopedThreadSchema) })
});
const threadTrajectoryLoadedEventSchema = eventMetadataSchema.extend({
  event: z.literal("thread.trajectory.loaded"),
  payload: z.object({ threadId: z.string().min(1), turns: z.array(ipcTrajectoryTurnSchema), activities: z.array(ipcTrajectoryActivitySchema) })
});
const threadCreatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("thread.created"),
  payload: z.object({ thread: unscopedThreadSchema })
});
const threadProfileSelectedEventSchema = eventMetadataSchema.extend({
  event: z.literal("thread.profile.selected"),
  payload: z.object({ thread: unscopedThreadSchema })
});
const threadProfileChangeRequiredEventSchema = eventMetadataSchema.extend({
  event: z.literal("thread.profile.change.required"),
  payload: z.object({
    threadId: z.string().min(1),
    currentProfile: ipcTrajectoryProfileSchema,
    requestedProfile: ipcTrajectoryProfileSchema,
    retainedContext: z.literal("visible-retained-trajectory")
  })
});
const threadProfileChangeResolvedEventSchema = eventMetadataSchema.extend({
  event: z.literal("thread.profile.change.resolved"),
  payload: z.object({
    sourceThreadId: z.string().min(1),
    thread: unscopedThreadSchema,
    profile: modelProfileSchema,
    action: z.enum(["continue_current_thread", "start_new_thread"]),
    retainedContext: z.enum(["visible-retained-trajectory", "none"])
  })
});
const threadOutputLocationSelectedEventSchema = eventMetadataSchema.extend({
  event: z.literal("thread.output.location.selected"),
  payload: z.object({ thread: unscopedThreadSchema })
});
const turnAcceptedEventSchema = eventMetadataSchema.extend({
  event: z.literal("turn.accepted"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    text: z.string(),
    retryOfTurnId: z.string().min(1).optional(),
    profile: modelProfileSchema
  })
});
const turnStartedEventSchema = eventMetadataSchema.extend({
  event: z.literal("turn.started"),
  payload: z.object({ threadId: z.string().min(1), turnId: z.string().min(1) })
});
const messageDeltaEventSchema = eventMetadataSchema.extend({
  event: z.literal("message.delta"),
  payload: z.object({ threadId: z.string().min(1), turnId: z.string().min(1), delta: z.string() })
});
const turnCompletedEventSchema = eventMetadataSchema.extend({
  event: z.literal("turn.completed"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    message: z.string(),
    profile: modelProfileSchema,
    usage: usageSchema,
    responseId: z.string().optional()
  })
});
const turnFailedEventSchema = eventMetadataSchema.extend({
  event: z.literal("turn.failed"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    text: z.string(),
    retryOfTurnId: z.string().min(1).optional(),
    profile: modelProfileSchema.optional(),
    failure: providerFailureSchema
  })
});
const turnInterruptedEventSchema = eventMetadataSchema.extend({
  event: z.literal("turn.interrupted"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    partialMessage: z.string(),
    reason: z.enum(["user_stop", "worker_exit", "application_restart", "provider_interrupted"]),
    profile: modelProfileSchema.optional()
  })
});
const turnStopRequestedEventSchema = eventMetadataSchema.extend({
  event: z.literal("turn.stop.requested"),
  payload: z.object({ threadId: z.string().min(1), turnId: z.string().min(1) })
});
const physicalContextRebuiltEventSchema = eventMetadataSchema.extend({
  event: z.literal("physical_context.rebuilt"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    reason: z.enum(["missing", "host_ahead", "pi_ahead", "irreconcilable"]),
    retainedTurnCount: z.number().int().nonnegative()
  })
});
const capabilityConfirmationRequiredEventSchema = eventMetadataSchema.extend({
  event: z.literal("capability.confirmation.required"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    requestId: z.string().min(1),
    capabilityId: z.string().min(1),
    action: z.string().min(1),
    target: z.string().min(1),
    reason: z.string().min(1),
    expectedEffect: z.string().min(1)
  })
});
const capabilityExecutionUpdatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("capability.execution.updated"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    requestId: z.string().min(1),
    capabilityId: z.string().min(1),
    status: z.enum(["started", "completed", "rejected", "failed", "unknown_outcome"]),
    content: z.string().max(20_000),
    artifact: z.object({ id: z.string().min(1), mediaType: z.string().min(1), destination: z.string().min(1) }).optional()
  })
});

export const hostEventSchema = z.discriminatedUnion("event", [
  bootstrapCompletedEventSchema,
  accessModeChangedEventSchema,
  diagnosticRaisedEventSchema,
  profilesListedEventSchema,
  profileCreatedEventSchema,
  threadsListedEventSchema,
  threadTrajectoryLoadedEventSchema,
  threadCreatedEventSchema,
  threadProfileSelectedEventSchema,
  threadProfileChangeRequiredEventSchema,
  threadProfileChangeResolvedEventSchema,
  threadOutputLocationSelectedEventSchema,
  turnAcceptedEventSchema,
  turnStartedEventSchema,
  messageDeltaEventSchema,
  turnCompletedEventSchema,
  turnFailedEventSchema,
  turnInterruptedEventSchema,
  turnStopRequestedEventSchema,
  physicalContextRebuiltEventSchema,
  capabilityConfirmationRequiredEventSchema,
  capabilityExecutionUpdatedEventSchema
]);

export type HostEvent = z.infer<typeof hostEventSchema>;
export type BootstrapState = z.infer<typeof bootstrapStateSchema>;

export interface VcAgentBridge {
  invoke(command: HostCommand): Promise<HostEvent>;
  onEvent(listener: (event: HostEvent) => void): () => void;
}

type HostCommandName = HostCommand["command"];
type HostCommandFor<TName extends HostCommandName> = Extract<HostCommand, { command: TName }>;
type HostCommandInput<TName extends HostCommandName> = Omit<
  HostCommandFor<TName>,
  "schemaVersion" | "commandId" | "correlationId" | "actor" | "sentAt"
>;
type AnyHostCommandInput = { [TName in HostCommandName]: HostCommandInput<TName> }[HostCommandName];

export function createCommand(command: AnyHostCommandInput): HostCommand {
  return {
    ...command,
    schemaVersion: IPC_SCHEMA_VERSION,
    commandId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    actor: { actorType: "user", actorId: "local-user" },
    sentAt: new Date().toISOString()
  } as HostCommand;
}

export function createBootstrapCommand(): HostCommand {
  return createCommand({ command: "app.bootstrap" });
}
