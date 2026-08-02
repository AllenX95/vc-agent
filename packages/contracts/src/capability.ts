import { z } from "zod";
import { actorRefSchema, IPC_SCHEMA_VERSION, provenanceRefSchema } from "./ipc.js";

export const CAPABILITY_RESULT_CONTENT_MAX_CHARS = 20_000;
export const CAPABILITY_INPUT_LIMITS = {
  materialRecall: { maxItems: 12, maxChars: 12_000 },
  projectStateRecall: { maxItems: 6, maxChars: 8_000 },
  memoryRecall: { maxItems: 8, maxChars: 8_000 },
  reflectionEvidenceDrilldown: { maxChars: 6_000 },
  webRecall: { maxItems: 6, maxChars: 8_000 },
  academicResearch: { maxItems: 25, maxChars: 15_000 }
} as const;

export const accessModeSchema = z.enum(["standard", "full"]);
export type AccessMode = z.infer<typeof accessModeSchema>;

export const capabilityTurnKindSchema = z.enum([
  "ordinary",
  "reflection_independent",
  "reflection_dialogue",
  "dream",
  "extension_audit",
  "sub_agent",
  "compaction"
]);
export type CapabilityTurnKind = z.infer<typeof capabilityTurnKindSchema>;

export const capabilityTierSchema = z.enum(["bootstrap", "common_read", "on_demand", "preconditioned", "protected_workflow", "host_only"]);
export type CapabilityTier = z.infer<typeof capabilityTierSchema>;

export const capabilityMetadataSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  /** Optional in the migration slice; when present, this is the concise catalog guidance. */
  useWhen: z.string().min(1).max(1_000).optional(),
  tier: capabilityTierSchema.optional(),
  activationClass: z.enum(["ordinary_task", "preconditioned_execution", "protected_workflow", "host_only"]),
  sideEffectClass: z.enum(["none", "local_read", "network_read", "local_write", "external_write", "destructive"]),
  allowedScopes: z.array(z.enum(["unscoped", "project"])).min(1),
  executor: z.enum(["host", "utility"]),
  modelCallable: z.boolean(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown())
});
export type CapabilityMetadata = z.infer<typeof capabilityMetadataSchema>;

export const capabilityCatalogEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  useWhen: z.string().min(1).max(1_000),
  tier: capabilityTierSchema,
  sideEffectClass: z.enum(["none", "local_read", "network_read", "local_write", "external_write", "destructive"]),
  requiresUserIntent: z.boolean()
});
export type CapabilityCatalogEntry = z.infer<typeof capabilityCatalogEntrySchema>;

export const capabilitySurfaceSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  kind: capabilityTurnKindSchema,
  scope: z.enum(["unscoped", "project"]),
  visibleCapabilityIds: z.array(z.string().min(1)).readonly(),
  executableCapabilityIds: z.array(z.string().min(1)).readonly(),
  requestableCatalog: z.array(capabilityCatalogEntrySchema).readonly(),
  initialToolSchemaEstimatedTokens: z.number().int().nonnegative()
});
export type CapabilitySurfaceSnapshot = z.infer<typeof capabilitySurfaceSnapshotSchema>;

export const decisionClassSchema = z.enum(["G1", "G2", "G3", "G4"]);
export type DecisionClass = z.infer<typeof decisionClassSchema>;

export const capabilityActivationRejectionSchema = z.object({
  id: z.string().min(1),
  code: z.enum(["CAPABILITY_UNAVAILABLE", "SCOPE_REJECTED", "STALE_CATALOG", "USER_INTENT_REQUIRED", "WORKFLOW_REQUIRED"]),
  reason: z.string().min(1).max(1_000)
});
export type CapabilityActivationRejection = z.infer<typeof capabilityActivationRejectionSchema>;

export const capabilityActivationResultSchema = z.object({
  catalogRevision: z.string().regex(/^[a-f0-9]{64}$/),
  activatedCapabilities: z.array(z.string().min(1)),
  alreadyVisible: z.array(z.string().min(1)),
  rejected: z.array(capabilityActivationRejectionSchema)
});
export type CapabilityActivationResult = z.infer<typeof capabilityActivationResultSchema>;

export const capabilityActivationRequestSchema = z.object({
  mode: z.literal("activate"),
  need: z.string().trim().min(1).max(1_000),
  capabilityIds: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
  catalogRevision: z.string().regex(/^[a-f0-9]{64}$/)
});
export type CapabilityActivationRequest = z.infer<typeof capabilityActivationRequestSchema>;

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
  sourceClass: z.enum(["material", "project_state", "memory", "web", "mcp", "academic"]),
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
  content: z.string().max(CAPABILITY_RESULT_CONTENT_MAX_CHARS),
  code: z.string().min(1).optional(),
  artifact: artifactRecordSchema.optional(),
  activatedCapabilities: z.array(z.string().min(1)).optional(),
  activation: capabilityActivationResultSchema.optional(),
  retrieval: retrievalPayloadMetadataSchema.optional()
});
export type CapabilityExecutionResult = z.infer<typeof capabilityExecutionResultSchema>;

export function normalizeCapabilityExecutionResult(value: unknown): CapabilityExecutionResult {
  const parsed = capabilityExecutionResultSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const candidate = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const requestId = typeof candidate.requestId === "string" && candidate.requestId.length > 0
    ? candidate.requestId
    : "unknown-capability-request";
  return {
    schemaVersion: IPC_SCHEMA_VERSION,
    requestId,
    status: "failed",
    code: "CAPABILITY_RESPONSE_INVALID",
    content: "Capability execution completed, but its response violated the bounded Worker IPC contract. Narrow the requested range and retry."
  };
}

export const actionProposalSchema = z.object({
  requestId: z.string().min(1),
  capabilityId: z.string().min(1),
  decisionClass: decisionClassSchema,
  action: z.string().min(1),
  target: z.string().min(1),
  reason: z.string().min(1),
  expectedEffect: z.string().min(1),
  preview: z.string().max(20_000).optional()
});
export type ActionProposal = z.infer<typeof actionProposalSchema>;
