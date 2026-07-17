import { z } from "zod";
import { actorRefSchema, IPC_SCHEMA_VERSION, provenanceRefSchema } from "./ipc.js";

export const accessModeSchema = z.enum(["standard", "full"]);
export type AccessMode = z.infer<typeof accessModeSchema>;

export const capabilityMetadataSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  activationClass: z.enum(["ordinary_task", "preconditioned_execution", "protected_workflow", "host_only"]),
  sideEffectClass: z.enum(["none", "local_read", "network_read", "local_write", "external_write", "destructive"]),
  allowedScopes: z.array(z.enum(["unscoped", "project"])).min(1),
  executor: z.enum(["host", "utility"]),
  modelCallable: z.boolean(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown())
});
export type CapabilityMetadata = z.infer<typeof capabilityMetadataSchema>;

export const capabilityExecutionRequestSchema = z.object({
  schemaVersion: z.literal(IPC_SCHEMA_VERSION),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  toolCallId: z.string().min(1),
  capabilityId: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unscoped"), threadId: z.string().min(1) }),
    z.object({ kind: z.literal("project"), projectId: z.string().min(1) })
  ]),
  arguments: z.record(z.string(), z.unknown()),
  expectedStateVersion: z.number().int().positive(),
  actor: actorRefSchema,
  provenance: provenanceRefSchema
});
export type CapabilityExecutionRequest = z.infer<typeof capabilityExecutionRequestSchema>;

export const artifactRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  mediaType: z.string().min(1),
  producer: z.object({ type: z.enum(["agent", "sub_agent", "user", "utility"]), id: z.string().min(1) }),
  destination: z.string().min(1),
  source: z.object({ threadId: z.string().min(1), turnId: z.string().min(1), capabilityRequestId: z.string().min(1) }),
  createdAt: z.string().datetime()
});
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;

export const contextReferenceSchema = z.object({
  schemaVersion: z.literal(1),
  sourceClass: z.enum(["material", "project_state", "memory", "web", "mcp"]),
  sourceId: z.string().min(1),
  label: z.string().min(1),
  sourceRange: z.string().min(1),
  contentVersion: z.string().min(1).optional(),
  originatingTool: z.string().min(1),
  originatingTurnId: z.string().min(1),
  retrievedAt: z.string().datetime(),
  status: z.enum(["active", "stale", "changed", "deleted", "source_unavailable"])
});
export type ContextReference = z.infer<typeof contextReferenceSchema>;

export const retrievalPayloadMetadataSchema = z.object({
  payloadId: z.string().uuid(),
  retention: z.literal("turn_scoped"),
  bodyBytes: z.number().int().nonnegative(),
  contextReference: contextReferenceSchema
});
export type RetrievalPayloadMetadata = z.infer<typeof retrievalPayloadMetadataSchema>;

export const capabilityExecutionResultSchema = z.object({
  schemaVersion: z.literal(IPC_SCHEMA_VERSION),
  requestId: z.string().min(1),
  status: z.enum(["completed", "rejected", "failed", "unknown_outcome"]),
  content: z.string().max(20_000),
  code: z.string().min(1).optional(),
  artifact: artifactRecordSchema.optional(),
  activatedCapabilities: z.array(z.string().min(1)).optional(),
  retrieval: retrievalPayloadMetadataSchema.optional()
});
export type CapabilityExecutionResult = z.infer<typeof capabilityExecutionResultSchema>;

export const actionProposalSchema = z.object({
  requestId: z.string().min(1),
  capabilityId: z.string().min(1),
  action: z.string().min(1),
  target: z.string().min(1),
  reason: z.string().min(1),
  expectedEffect: z.string().min(1)
});
export type ActionProposal = z.infer<typeof actionProposalSchema>;
