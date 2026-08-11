import { z } from "zod";
import { citationManifestSchema } from "./citation.js";
import { subAgentExplicitIntentEvidenceSchema, subAgentProjectionSchema, subAgentRunProjectionSchema, subAgentRunSchema, subAgentTaskDetailProjectionSchema, subAgentTaskInputSchema, subAgentTaskSchema, subAgentAttemptSchema } from "./sub-agent.js";
import { piResourcesSettingsStateSchema } from "./pi-resources.js";
import { autoMemoryReviewPolicySchema, cognitionCommitResultSchema, proposalDecisionInputSchema, reviewBundleSchema } from "./cognition-review.js";

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
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;

export const academicCredentialSourceSchema = z.enum(["openalex", "github", "huggingface"]);
export type AcademicCredentialSource = z.infer<typeof academicCredentialSourceSchema>;

export const academicCredentialStatusSchema = z.object({
  source: academicCredentialSourceSchema,
  configured: z.boolean()
});
export type AcademicCredentialStatus = z.infer<typeof academicCredentialStatusSchema>;

export const integrationLifecycleStateSchema = z.enum(["pending", "queued", "running", "completed", "failed", "interrupted", "unknown_outcome"]);
export type IntegrationLifecycleState = z.infer<typeof integrationLifecycleStateSchema>;

const integrationStatusSchema = z.object({
  status: z.enum(["ready", "attention", "unavailable"]),
  message: z.string().min(1).max(400)
});

const integrationJobSummarySchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  state: integrationLifecycleStateSchema,
  message: z.string().min(1).max(400),
  updatedAt: z.string().datetime(),
  resultId: z.string().min(1).optional(),
  sourcePath: z.string().min(1).optional(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  editedCopyHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  changeSummaryPath: z.string().min(1).optional(),
  stagedOutputPath: z.string().min(1).optional(),
  previewPaths: z.array(z.string().min(1)).max(20).optional(),
  committedRelativePath: z.string().min(1).optional(),
  format: z.enum(["docx", "pptx", "xlsx", "pdf"]).optional(),
  skillRevisionId: z.string().uuid().optional(),
  sourceReferences: z.array(z.string().min(1)).max(100).optional()
});
export type IntegrationJobSummary = z.infer<typeof integrationJobSummarySchema>;

const officeIntegrationStateSchema = z.object({
  status: integrationStatusSchema,
  activeSkillCount: z.number().int().nonnegative(),
  supportedFormats: z.array(z.enum(["docx", "pptx", "xlsx", "pdf"])),
  jobs: z.array(integrationJobSummarySchema)
});

const skillCreatorIntegrationStateSchema = z.object({
  status: integrationStatusSchema,
  drafts: z.array(z.object({
    draftId: z.string().uuid(), packageId: z.string().min(1), operation: z.enum(["create", "update"]),
    state: z.string().min(1), files: z.array(z.string()), dependencies: z.array(z.string()),
    updatedAt: z.string().datetime(), failureCode: z.string().optional()
  }))
});

const pageRecoveryIntegrationStateSchema = z.object({
  status: integrationStatusSchema,
  availability: z.object({
    native: integrationStatusSchema, paddle: integrationStatusSchema, ovis: integrationStatusSchema,
    policyRevision: z.string().min(1)
  }),
  telemetry: z.object({
    policyRevision: z.string().min(1), pageCount: z.number().int().nonnegative(), nativePages: z.number().int().nonnegative(),
    paddlePages: z.number().int().nonnegative(), ovisPages: z.number().int().nonnegative(), retainedEarlierPages: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(), durationMs: z.number().int().nonnegative(), lastStatus: z.enum(["completed", "completed_with_warnings", "failed", "cancelled"])
  }),
  parses: z.array(integrationJobSummarySchema),
  lastParse: z.object({
    parseId: z.string().uuid(),
    pages: z.array(z.object({ pageNumber: z.number().int().positive(), selectedStage: z.enum(["native", "paddle", "ovis", "unavailable"]), retainedEarlier: z.boolean(), warningCodes: z.array(z.string().min(1)) }))
  }).optional()
});

export const integrationStateSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.string().datetime(),
  office: officeIntegrationStateSchema,
  skillCreator: skillCreatorIntegrationStateSchema,
  pageRecovery: pageRecoveryIntegrationStateSchema,
  runtime: z.object({ runningJobs: z.number().int().nonnegative(), queuedJobs: z.number().int().nonnegative(), failures: z.number().int().nonnegative() })
});
export type IntegrationState = z.infer<typeof integrationStateSchema>;

/** Intent-level cognition assignments surfaced by the current LLM Settings UI. */
export const COGNITION_TASK_MODEL_TYPES = ["reflection", "memory_review"] as const;
export type CognitionTaskModelType = (typeof COGNITION_TASK_MODEL_TYPES)[number];

const ALL_TASK_MODEL_TYPES = [
  "ordinary_conversation", "web_research", "document_generation",
  ...COGNITION_TASK_MODEL_TYPES,
  "visual_material_analysis", "sub_agent_default", "sub_agent_researcher", "sub_agent_critic", "sub_agent_synthesizer", "sub_agent_writer", "sub_agent_custom"
] as const;
export const taskModelTypeSchema = z.enum(ALL_TASK_MODEL_TYPES);
export type TaskModelType = z.infer<typeof taskModelTypeSchema>;
export const taskModelAssignmentSchema = z.object({ taskType: taskModelTypeSchema, profileId: z.string().min(1), updatedAt: z.string().datetime() });
export type TaskModelAssignment = z.infer<typeof taskModelAssignmentSchema>;

export const unscopedThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  scope: z.literal("unscoped"),
  activeProfileId: z.string().min(1).optional(),
  outputLocation: z.string().min(1).optional(),
  archivedAt: z.string().datetime().optional(),
  stateVersion: z.number().int().positive(),
  createdAt: z.string().datetime()
});
export type UnscopedThread = z.infer<typeof unscopedThreadSchema>;

export const projectSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1),
  path: z.string().min(1),
  identityStatus: z.enum(["stable", "path_bound"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type Project = z.infer<typeof projectSchema>;

export const reflectionProjectBriefSchema = z.object({
  schemaVersion: z.literal(1), scope: z.literal("project").default("project"), projectId: z.string().uuid(), sourceVersion: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string().datetime(),
  contextFields: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), value: z.string().max(2_000) })).max(20),
  materialCards: z.array(z.object({ materialId: z.string().uuid(), displayName: z.string().min(1), mediaType: z.string().min(1), size: z.number().int().nonnegative(), modifiedAt: z.string().datetime(), parseStatus: z.enum(["unparsed", "available", "stale"]) })).max(500),
  recordReferences: z.array(z.object({ kind: z.enum(["output", "judgment_record"]), id: z.string().min(1), label: z.string().min(1), mediaType: z.string().min(1).optional(), createdAt: z.string().datetime().optional() })).max(200)
});
export type ReflectionProjectBrief = z.infer<typeof reflectionProjectBriefSchema>;
export const reflectionUnscopedBriefSchema = z.object({
  schemaVersion: z.literal(1), scope: z.literal("unscoped"), sourceThreadId: z.string().min(1), sourceVersion: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string().datetime(),
  userInputs: z.array(z.object({ turnId: z.string().min(1), text: z.string().min(1).max(2_000) })),
  attachmentCards: z.array(z.object({ attachmentId: z.string().min(1), displayName: z.string().min(1), mediaType: z.string().min(1), size: z.number().int().nonnegative() })).max(100),
  recordReferences: z.array(z.object({ kind: z.literal("judgment_record"), id: z.string().min(1), label: z.string().min(1), createdAt: z.string().datetime().optional() })).max(100)
});
export type ReflectionUnscopedBrief = z.infer<typeof reflectionUnscopedBriefSchema>;
export const reflectionBriefSchema = z.union([reflectionProjectBriefSchema, reflectionUnscopedBriefSchema]);
export type ReflectionBrief = z.infer<typeof reflectionBriefSchema>;

export const independentAssessmentSchema = z.object({
  schemaVersion: z.literal(1), conclusion: z.string().min(1).max(30_000), rationale: z.array(z.string().min(1).max(5_000)).max(20),
  uncertainties: z.array(z.string().min(1).max(5_000)).max(20), counterarguments: z.array(z.string().min(1).max(5_000)).max(20),
  evidenceReferences: z.array(z.object({ referenceId: z.string().min(1), claim: z.string().min(1).max(5_000), support: z.enum(["supporting", "disconfirming", "mixed"] ) })).max(100),
  decisionChangingQuestions: z.array(z.string().min(1).max(5_000)).max(20), createdAt: z.string().datetime()
});
export type IndependentAssessment = z.infer<typeof independentAssessmentSchema>;

export const projectThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  scope: z.literal("project"),
  projectId: z.string().uuid(),
  activeProfileId: z.string().min(1).optional(),
  archivedAt: z.string().datetime().optional(),
  stateVersion: z.number().int().positive(),
  createdAt: z.string().datetime()
});
export type ProjectThread = z.infer<typeof projectThreadSchema>;
export const threadSchema = z.discriminatedUnion("scope", [unscopedThreadSchema, projectThreadSchema]);
export type Thread = z.infer<typeof threadSchema>;

export const MODEL_EXECUTION_KINDS = [
  "ordinary_turn",
  "compaction",
  "internal_model_stage"
] as const;
export const modelExecutionKindSchema = z.enum(MODEL_EXECUTION_KINDS);
export type ModelExecutionKind = z.infer<typeof modelExecutionKindSchema>;

export const executionQueueItemSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  threadId: z.string().min(1),
  kind: z.literal("ordinary_turn"),
  status: z.enum(["queued", "draft"]),
  reason: z.enum(["thread_active", "capacity"]),
  text: z.string().trim().min(1).max(200_000),
  retryOfTurnId: z.string().min(1).optional(),
  requestedProfileId: z.string().min(1).optional(),
  position: z.number().int().nonnegative(),
  submittedAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ExecutionQueueItem = z.infer<typeof executionQueueItemSchema>;

export const systemPromptRevisionSchema = z.object({
  id: z.string().uuid(),
  content: z.string().max(100_000),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRevisionId: z.string().uuid().optional(),
  changeNote: z.string().max(500).optional(),
  diff: z.string().max(200_000),
  source: z.enum(["shipped_default", "user_edit", "restore_default"]),
  createdAt: z.string().datetime()
});
export type SystemPromptRevision = z.infer<typeof systemPromptRevisionSchema>;

export const promptContributionSchema = z.object({
  promptEstimatedTokens: z.number().int().nonnegative(),
  toolSchemaEstimatedTokens: z.number().int().nonnegative(),
  taskEstimatedTokens: z.number().int().nonnegative(),
  contextEstimatedTokens: z.number().int().nonnegative(),
  recalledStateEstimatedTokens: z.number().int().nonnegative(),
  outputReserveEstimatedTokens: z.number().int().nonnegative(),
  skillEstimatedTokens: z.number().int().nonnegative(),
  materialEstimatedTokens: z.number().int().nonnegative(),
  contextBudget: z.object({
    estimatorRevision: z.string().min(1),
    safetyMarginTokens: z.number().int().nonnegative(),
    usableContextTokens: z.number().int().nonnegative(),
    estimatedInputTokens: z.number().int().nonnegative(),
    action: z.enum(["admit", "compact_then_admit", "reject_current_input", "reject_additional_retrieval"])
  }).optional()
});
export type PromptContribution = z.infer<typeof promptContributionSchema>;

export const contextBudgetTelemetrySchema = z.object({
  estimatorRevision: z.string().min(1),
  safetyMarginTokens: z.number().int().nonnegative(),
  usableContextTokens: z.number().int().nonnegative(),
  estimatedInputTokens: z.number().int().nonnegative(),
  action: z.enum(["admit", "compact_then_admit", "reject_current_input", "reject_additional_retrieval"])
});
export type ContextBudgetTelemetry = z.infer<typeof contextBudgetTelemetrySchema>;

export const capabilitySurfaceTelemetrySchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  visibleCapabilityIds: z.array(z.string().min(1)),
  requestableCapabilityCount: z.number().int().nonnegative(),
  initialToolSchemaEstimatedTokens: z.number().int().nonnegative(),
  preloadHintCount: z.number().int().nonnegative()
});
export type CapabilitySurfaceTelemetry = z.infer<typeof capabilitySurfaceTelemetrySchema>;

export const materialInventoryItemSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  relativePath: z.string().min(1),
  extension: z.string().min(1),
  mediaType: z.string().min(1),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string().datetime(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  parseStatus: z.enum(["unparsed", "available", "stale"]),
  parsedVersionCount: z.number().int().nonnegative(),
  availability: z.enum(["active", "deleted"])
});
export type MaterialInventoryItem = z.infer<typeof materialInventoryItemSchema>;

export const projectContextDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().uuid(),
  markdownPath: z.literal("outputs/system/project-context.md"),
  mirrorPath: z.literal("outputs/system/project-context.json"),
  content: z.string().max(100_000),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string().datetime(),
  sections: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    content: z.string(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive()
  })),
  warnings: z.array(z.object({
    code: z.enum(["MISSING_TITLE", "MISSING_SECTION", "UNKNOWN_SECTION", "DUPLICATE_SECTION"]),
    message: z.string().min(1),
    line: z.number().int().positive().optional()
  }))
});
export type ProjectContextDocument = z.infer<typeof projectContextDocumentSchema>;

export const projectMemoryEntrySchema = z.object({
  id: z.string().min(1), title: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tags: z.array(z.string()),
  source: z.string().min(1), scope: z.literal("project"), body: z.string(), relatedThread: z.string().min(1).optional(), relatedOutput: z.string().min(1).optional(),
  maturity: z.literal("user_confirmed"), provenanceStatus: z.enum(["traceable", "user_authored_no_evidence"])
});
export const projectMemoryDocumentSchema = z.object({
  schemaVersion: z.literal(1), projectId: z.string().uuid(), markdownPath: z.literal("outputs/system/project-memory.md"), content: z.string().max(200_000),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), updatedAt: z.string().datetime(), entries: z.array(projectMemoryEntrySchema),
  warnings: z.array(z.object({ code: z.enum(["MISSING_TITLE", "MALFORMED_ENTRY", "INVALID_SCOPE"]), message: z.string().min(1), line: z.number().int().positive().optional() }))
});
export type ProjectMemoryDocument = z.infer<typeof projectMemoryDocumentSchema>;
export const longTermMemoryEntrySchema = z.object({
  id: z.string().min(6).max(80), version: z.number().int().positive(), status: z.enum(["current", "superseded"]), title: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tags: z.array(z.string()), applicability: z.array(z.string()), maturity: z.enum(["user-confirmed", "evidence-backed", "retrospectively-supported"]),
  recallPolicy: z.enum(["automatic", "explicit-only"]), conflictState: z.string().min(1), limitations: z.string(), content: z.string(), sourceReferenceIds: z.array(z.string()),
  provenanceStatus: z.enum(["traceable", "user-authored-no-evidence"])
});
export const longTermMemoryDocumentSchema = z.object({
  schemaVersion: z.literal(1), rootPath: z.string().min(1), markdownPath: z.string().min(1), content: z.string().max(500_000),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), updatedAt: z.string().datetime(), entries: z.array(longTermMemoryEntrySchema),
  warnings: z.array(z.object({ code: z.enum(["MISSING_TITLE", "MALFORMED_ENTRY", "INVALID_FIELD", "DUPLICATE_ID", "PROJECT_SPECIFIC_CONTENT"]), message: z.string().min(1), line: z.number().int().positive().optional() })),
  files: z.array(z.object({ kind: z.enum(["active", "condensation_archive", "cognitive_evolution_history"]), name: z.string().min(1), path: z.string().min(1), size: z.number().int().nonnegative(), updatedAt: z.string().datetime(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }))
});
export type LongTermMemoryDocument = z.infer<typeof longTermMemoryDocumentSchema>;
export const memoryEvolutionActionSchema = z.enum(["add", "reinforce", "narrow", "revise", "contradict", "merge_condense"]);
export const memoryLearningDraftSchema = z.object({
  id: z.string().min(6).max(80).optional(), title: z.string().trim().min(1).max(200), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tags: z.array(z.string().trim().min(1).max(80)).max(20), applicability: z.array(z.string().trim().min(1).max(200)).max(20),
  maturity: z.enum(["user-confirmed", "evidence-backed", "retrospectively-supported"]), recallPolicy: z.enum(["automatic", "explicit-only"]),
  limitations: z.string().trim().max(2_000), content: z.string().trim().min(1).max(50_000), sourceReferenceIds: z.array(z.string().min(6).max(80)).max(40)
});
export const localMemoryProvenanceRecordSchema = z.object({
  schemaVersion: z.literal(1), sourceReferenceId: z.string().min(6).max(80), scope: z.enum(["project", "unscoped"]).optional(), projectId: z.string().uuid().optional(), workflowType: z.enum(["reflection", "memory_review"]),
  workflowRunId: z.string().min(1), judgmentRecordId: z.string().min(1).optional(), threadId: z.string().min(1).optional(), turnId: z.string().min(1).optional(),
  outputId: z.string().min(1).optional(), evidenceReferences: z.array(z.string().min(1)).max(40), availability: z.enum(["active", "source_unavailable"]), createdAt: z.string().datetime()
}).transform((record) => ({ ...record, scope: record.scope ?? (record.projectId === undefined ? "unscoped" as const : "project" as const) })).pipe(z.object({
  schemaVersion: z.literal(1), sourceReferenceId: z.string().min(6).max(80), scope: z.enum(["project", "unscoped"]), projectId: z.string().uuid().optional(), workflowType: z.enum(["reflection", "memory_review"]),
  workflowRunId: z.string().min(1), judgmentRecordId: z.string().min(1).optional(), threadId: z.string().min(1).optional(), turnId: z.string().min(1).optional(), outputId: z.string().min(1).optional(),
  evidenceReferences: z.array(z.string().min(1)).max(40), availability: z.enum(["active", "source_unavailable"]), createdAt: z.string().datetime()
}).superRefine((record, context) => {
  if (record.scope === "project" && record.projectId === undefined) context.addIssue({ code: "custom", message: "Project provenance requires projectId" });
  if (record.scope === "unscoped" && record.projectId !== undefined) context.addIssue({ code: "custom", message: "Unscoped provenance cannot include projectId" });
}));
export const memoryPatchRequestSchema = z.object({
  action: memoryEvolutionActionSchema, targetEntryIds: z.array(z.string().min(6).max(80)).max(20), proposed: memoryLearningDraftSchema.optional(),
  rationale: z.string().trim().min(1).max(5_000), resolutionSignal: z.object({ type: z.enum(["user_correction", "approved_reflection", "approved_retrospective"]), referenceId: z.string().min(1).max(200) }).optional(),
  provenanceRecords: z.array(localMemoryProvenanceRecordSchema).max(40).optional()
});
export const preparedMemoryPatchSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().min(8).max(80), action: memoryEvolutionActionSchema, targetEntryIds: z.array(z.string()), rationale: z.string(), createdAt: z.string().datetime(),
  confirmationRequired: z.literal(true), lineageDiff: z.string().max(100_000), files: z.array(z.object({
    kind: z.enum(["active", "condensation_archive", "cognitive_evolution_history", "local_provenance", "recall_index"]), path: z.string().min(1),
    baseHash: z.union([z.literal("missing"), z.string().regex(/^[a-f0-9]{64}$/)]), resultHash: z.union([z.literal("missing"), z.string().regex(/^[a-f0-9]{64}$/)]), changed: z.boolean(), diff: z.string().max(1_500_000)
  })).length(5)
});
export type PreparedMemoryPatch = z.infer<typeof preparedMemoryPatchSchema>;
export const memoryMaintenanceStateSchema = z.object({
  schemaVersion: z.literal(1), retention: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365), z.literal("permanent")]), automaticDeletion: z.boolean(),
  archiveItems: z.array(z.object({ archiveId: z.string().min(1), archivedAt: z.string().datetime(), reason: z.string(), sourceEntries: z.array(z.string()), replacement: z.string(), kept: z.boolean(), eligibleForCleanup: z.boolean(), expiresAt: z.string().datetime().optional() }))
});
export type MemoryMaintenanceState = z.infer<typeof memoryMaintenanceStateSchema>;
export const memoryCandidateSchema = z.object({
  id: z.string().uuid(), scope: z.enum(["project", "unscoped"]), projectId: z.string().uuid().optional(), threadId: z.string().min(1), turnId: z.string().min(1),
  sourceReference: z.string().min(1).max(500), capturedAt: z.string().datetime(), sourceSnippet: z.string().min(1).max(2_000), sourceKind: z.enum(["ordinary_user_signal", "reflection_dialogue"]).default("ordinary_user_signal"),
  signal: z.enum(["explicit_remember", "strong_user_judgment", "reflection_adoption", "reflection_correction", "reflection_confirmation"]), status: z.enum(["active", "dismissed", "promoted"])
});
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
export const projectOutputArtifactSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1), projectId: z.string().uuid(), mediaType: z.string().min(1), destination: z.string().min(1), relativePath: z.string().min(1),
  producer: z.object({ type: z.enum(["agent", "sub_agent", "user", "utility"]), id: z.string().min(1) }),
  source: z.object({ threadId: z.string().min(1), turnId: z.string().min(1), capabilityRequestId: z.string().min(1) }),
  profile: z.object({ id: z.string().min(1), provider: z.string().min(1), model: z.string().min(1) }), capabilityId: z.string().min(1),
  skillId: z.string().min(1).optional(), sourceReferences: z.array(z.string()), warnings: z.array(z.string()),
  relatedArtifacts: z.array(z.object({ relation: z.enum(["render", "diff", "supporting"]), path: z.string().min(1), mediaType: z.string().min(1).optional() })),
  createdAt: z.string().datetime()
});
export type ProjectOutputArtifact = z.infer<typeof projectOutputArtifactSchema>;

export const usageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  reasoning: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative()
});
export type TokenUsage = z.infer<typeof usageSchema>;

export const contextUsageSchema = z.object({
  tokens: z.number().nonnegative().nullable(),
  contextWindow: z.number().int().positive(),
  percent: z.number().nonnegative().nullable()
});
export type ContextUsage = z.infer<typeof contextUsageSchema>;

export const providerFailureSchema = z.object({
  kind: z.enum(["configuration", "provider", "worker"]),
  code: z.string().min(1),
  message: z.string().min(1).max(1200),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  requestId: z.string().min(1).optional()
});
export type ProviderFailure = z.infer<typeof providerFailureSchema>;

const reflectionRunBaseSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), threadId: z.string().min(1), framing: z.enum(["reflection", "retrospective"]),
  objective: z.string().min(1).max(5_000), focus: z.string().max(5_000).optional(), status: z.enum(["awaiting_profile", "ready", "independent_running", "independent_completed", "independent_failed", "independent_interrupted", "memory_aware_running", "dialogue_active", "memory_aware_failed", "memory_aware_interrupted", "completed", "discarded"]),
  promptSnapshot: z.object({ revisionId: z.string().uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) }),
  independentProfileId: z.string().min(1).optional(), launchOverrideProfileId: z.string().min(1).optional(), memoryAwareProfileId: z.string().min(1).optional(), memoryInitialTurnId: z.string().min(1).optional(), assessment: independentAssessmentSchema.optional(), failure: providerFailureSchema.optional(),
  sessionFile: z.string().min(1).optional(), createdAt: z.string().datetime(), updatedAt: z.string().datetime()
});
export const reflectionRunSchema = z.discriminatedUnion("scope", [
  reflectionRunBaseSchema.extend({ scope: z.literal("project"), projectId: z.string().uuid(), brief: reflectionProjectBriefSchema }),
  reflectionRunBaseSchema.extend({ scope: z.literal("unscoped"), sourceThreadId: z.string().min(1), brief: reflectionUnscopedBriefSchema })
]);
export type ReflectionRun = z.infer<typeof reflectionRunSchema>;

export const reflectionOutcomeDependencySchema = z.object({
  kind: z.enum(["material", "project_memory", "long_term_memory"]),
  referenceId: z.string().min(1).max(500),
  targetId: z.string().min(1).max(100),
  contentVersion: z.string().regex(/^[a-f0-9]{64}$/)
});
export type ReflectionOutcomeDependency = z.infer<typeof reflectionOutcomeDependencySchema>;
export const reflectionOutcomeStaleReasonSchema = z.object({
  dependency: reflectionOutcomeDependencySchema,
  reason: z.enum(["changed", "deleted", "source_unavailable"])
});
export type ReflectionOutcomeStaleReason = z.infer<typeof reflectionOutcomeStaleReasonSchema>;
export const judgmentRecordDraftSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), runId: z.string().uuid(), sourceReferenceId: z.string().min(6).max(80),
  view: z.string().trim().min(1).max(30_000), reasoning: z.array(z.string().trim().min(1).max(5_000)).max(20), uncertainties: z.array(z.string().trim().min(1).max(5_000)).max(20),
  counterarguments: z.array(z.string().trim().min(1).max(5_000)).max(20), evidenceReferences: z.array(z.string().min(1).max(500)).max(100),
  decisionState: z.enum(["invest", "pass", "watch", "unresolved"]), sourceAvailability: z.enum(["complete", "partial", "source_unavailable"]),
  dependencies: z.array(reflectionOutcomeDependencySchema).max(300).default([]), staleReasons: z.array(reflectionOutcomeStaleReasonSchema).max(300).default([]),
  status: z.enum(["draft", "stale", "confirmed", "discarded"]), createdAt: z.string().datetime(), staleAt: z.string().datetime().optional(), confirmedAt: z.string().datetime().optional()
});
export type JudgmentRecordDraft = z.infer<typeof judgmentRecordDraftSchema>;
export const longTermLearningProposalSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), runId: z.string().uuid(), action: memoryEvolutionActionSchema, targetEntryIds: z.array(z.string().min(6).max(80)).max(20),
  proposed: memoryLearningDraftSchema.omit({ sourceReferenceIds: true }), rationale: z.string().trim().min(1).max(5_000), comparisonSummary: z.string().trim().min(1).max(10_000),
  dependencies: z.array(reflectionOutcomeDependencySchema).max(300).default([]), staleReasons: z.array(reflectionOutcomeStaleReasonSchema).max(300).default([]),
  status: z.enum(["draft", "stale", "patch_prepared", "adopted", "discarded"]), preparedPatchId: z.string().min(8).max(80).optional(), createdAt: z.string().datetime(), staleAt: z.string().datetime().optional()
});
export type LongTermLearningProposal = z.infer<typeof longTermLearningProposalSchema>;
export const reflectionOutcomeProposalInputSchema = z.object({
  judgmentRecord: judgmentRecordDraftSchema.pick({ view: true, reasoning: true, uncertainties: true, counterarguments: true, evidenceReferences: true, decisionState: true, sourceAvailability: true }).optional(),
  learningProposals: z.array(longTermLearningProposalSchema.pick({ action: true, targetEntryIds: true, proposed: true, rationale: true, comparisonSummary: true })).max(3).default([])
}).refine((value) => value.judgmentRecord !== undefined || value.learningProposals.length > 0, "At least one Reflection outcome is required");
export type ReflectionOutcomeProposalInput = z.infer<typeof reflectionOutcomeProposalInputSchema>;

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
  citations: citationManifestSchema.optional(),
  contextUsage: contextUsageSchema.optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  recalledStateEstimatedTokens: z.number().int().nonnegative().optional(),
  failure: providerFailureSchema.optional(),
  interruptionReason: z.string().optional(),
  submittedSequence: z.number().int().positive(),
  lastSequence: z.number().int().positive(),
  prompt: z.object({ revisionId: z.string().uuid(), hash: z.string(), contributions: promptContributionSchema, capabilitySurface: capabilitySurfaceTelemetrySchema.optional() }).optional()
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
  runtime: z.object({ sourceClass: z.enum(["host", "pi_builtin", "bundled_extension", "pi_extension", "mcp"]), sourceId: z.string().min(1), sourceRevision: z.string().min(1), activationReason: z.string().min(1), actionClass: z.enum(["none", "local_read", "network_read", "local_write", "external_write", "destructive"]), confirmationState: z.enum(["not_required", "required", "approved", "rejected"]), durationMs: z.number().int().nonnegative().optional(), truncated: z.boolean().optional() }).optional(),
  artifact: z.object({ id: z.string().min(1), mediaType: z.string().min(1), destination: z.string().min(1) }).optional()
});

const commandMetadataSchema = z.object({
  schemaVersion: z.literal(IPC_SCHEMA_VERSION),
  commandId: z.string().min(1),
  correlationId: z.string().min(1),
  actor: actorRefSchema,
  sentAt: z.string().datetime(),
  expectedStateVersion: z.number().int().positive().default(1),
  scope: z.enum(["project", "unscoped"]).default("unscoped")
});

const bootstrapCommandSchema = commandMetadataSchema.extend({ command: z.literal("app.bootstrap") });
const exportRecoveryStateCommandSchema = commandMetadataSchema.extend({ command: z.literal("state.recovery.export") });
const createPersonalCognitionBackupCommandSchema = commandMetadataSchema.extend({ command: z.literal("personal_cognition.backup.create") });
const restorePersonalCognitionCommandSchema = commandMetadataSchema.extend({ command: z.literal("personal_cognition.restore") });
const listProfilesCommandSchema = commandMetadataSchema.extend({ command: z.literal("profile.list") });
const loadIntegrationStateCommandSchema = commandMetadataSchema.extend({ command: z.literal("integration.state.load") });
const prepareOfficeTaskCommandSchema = commandMetadataSchema.extend({
  command: z.literal("office.task.prepare"),
  payload: z.object({
    kind: z.enum(["create", "edit", "review"]), format: z.enum(["docx", "pptx", "xlsx", "pdf"]), projectId: z.string().min(1), projectPath: z.string().min(1),
    threadId: z.string().min(1), turnId: z.string().min(1), profile: modelProfileSchema.pick({ id: true, provider: true, model: true }),
    skillName: z.string().min(1).optional(), skillPath: z.string().min(1).optional(), outputDirectory: z.string().min(1), outputFileName: z.string().min(1).optional(), sourcePath: z.string().min(1).optional(),
    sourceReferences: z.array(z.string().min(1)).max(100).optional(), renderPreview: z.boolean().optional(), explicitIntent: z.literal(true)
  })
});
const chooseOfficeSourceCommandSchema = commandMetadataSchema.extend({
  command: z.literal("office.source.choose"),
  payload: z.object({ format: z.enum(["docx", "pptx", "xlsx", "pdf"]) })
});
const runOfficeTaskCommandSchema = commandMetadataSchema.extend({ command: z.literal("office.task.run"), payload: z.object({ planId: z.string().uuid() }) });
const cancelOfficeTaskCommandSchema = commandMetadataSchema.extend({ command: z.literal("office.task.cancel"), payload: z.object({ jobId: z.string().min(1) }) });
const commitOfficeResultCommandSchema = commandMetadataSchema.extend({ command: z.literal("office.result.commit"), payload: z.object({ resultId: z.string().uuid() }) });
const openOfficeArtifactCommandSchema = commandMetadataSchema.extend({
  command: z.literal("office.artifact.open"),
  payload: z.object({ resultId: z.string().uuid(), artifact: z.enum(["staged_output", "change_summary", "preview"]), previewIndex: z.number().int().nonnegative().optional() })
});
const replaceOfficeOriginalCommandSchema = commandMetadataSchema.extend({
  command: z.literal("office.source.replace"),
  payload: z.object({ resultId: z.string().uuid(), sourcePath: z.string().min(1), expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/), accessMode: z.enum(["standard", "full"]), confirmed: z.boolean(), duplicateRiskAcknowledged: z.boolean().optional(), simulateUnknownOutcome: z.boolean().optional() })
});
const listSkillCreatorDraftsCommandSchema = commandMetadataSchema.extend({ command: z.literal("skill_creator.list") });
const prepareSkillCreatorDraftCommandSchema = commandMetadataSchema.extend({
  command: z.literal("skill_creator.prepare"),
  payload: z.object({ operation: z.enum(["create", "update"]), explicitIntent: z.literal(true), packageId: z.string().min(1), profileId: z.string().min(1).optional(), files: z.record(z.string().min(1), z.string().max(200_000)), dependencies: z.array(z.string().min(1)).max(100).optional(), draftId: z.string().uuid().optional(), targetSkillName: z.string().min(1).optional(), targetSkillPath: z.string().min(1).optional() })
});
const reviewSkillCreatorDraftCommandSchema = commandMetadataSchema.extend({ command: z.literal("skill_creator.review"), payload: z.object({ draftId: z.string().uuid() }) });
const acceptSkillCreatorDraftCommandSchema = commandMetadataSchema.extend({ command: z.literal("skill_creator.handoff"), payload: z.object({ draftId: z.string().uuid(), confirmed: z.literal(true), accessMode: z.enum(["standard", "full"]).optional() }) });
const discardSkillCreatorDraftCommandSchema = commandMetadataSchema.extend({ command: z.literal("skill_creator.discard"), payload: z.object({ draftId: z.string().uuid() }) });
const inspectPageRecoveryCommandSchema = commandMetadataSchema.extend({ command: z.literal("page_recovery.inspect") });
const runPageRecoveryCommandSchema = commandMetadataSchema.extend({
  command: z.literal("page_recovery.run"),
  payload: z.object({ materialId: z.string().uuid(), projectId: z.string().uuid(), relativePath: z.string().min(1), mediaType: z.string().min(1), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), pageCount: z.number().int().positive().optional() })
});
const cancelPageRecoveryCommandSchema = commandMetadataSchema.extend({ command: z.literal("page_recovery.cancel"), payload: z.object({ parseId: z.string().uuid() }) });

// Pi-native resource commands deliberately expose only source-level intents.
const loadPiResourcesCommandSchema = commandMetadataSchema.extend({ command: z.literal("pi.resources.load") });
const openPiResourceCommandSchema = commandMetadataSchema.extend({
  command: z.literal("pi.resources.open"),
  payload: z.object({ target: z.enum(["extensions_folder", "mcp_config", "skills_folder"]) })
});
const reloadPiResourcesCommandSchema = commandMetadataSchema.extend({ command: z.literal("pi.resources.reload") });
const importPiSkillCommandSchema = commandMetadataSchema.extend({ command: z.literal("pi.resources.import_skill") });
const setPiProjectTrustCommandSchema = commandMetadataSchema.extend({
  command: z.literal("pi.resources.project_trust.set"),
  payload: z.object({ trusted: z.boolean() })
});
const setAccessModeCommandSchema = commandMetadataSchema.extend({
  command: z.literal("access.mode.set"),
  payload: z.object({ mode: z.enum(["standard", "full"]) })
});
const profileLimitOverridesSchema = z.object({
  contextWindow: z.number().int().min(1_024).max(100_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(10_000_000).optional()
}).refine(
  (value) => value.contextWindow === undefined || value.maxOutputTokens === undefined || value.maxOutputTokens < value.contextWindow,
  { message: "Max output tokens must be smaller than the context window.", path: ["maxOutputTokens"] }
);
const createProfileCommandSchema = commandMetadataSchema.extend({
  command: z.literal("profile.create"),
  payload: z.object({
    name: z.string().trim().min(1).max(80),
    provider: z.string().trim().min(1).max(2_048),
    model: z.string().trim().min(1).max(160),
    apiKey: z.string().min(1).max(8192),
    thinkingLevel: thinkingLevelSchema
  }).and(profileLimitOverridesSchema)
});
const updateProfileCommandSchema = commandMetadataSchema.extend({
  command: z.literal("profile.update"),
  payload: z.object({
    profileId: z.string().min(1),
    name: z.string().trim().min(1).max(80),
    provider: z.string().trim().min(1).max(2_048),
    model: z.string().trim().min(1).max(160),
    apiKey: z.string().min(1).max(8192).optional(),
    thinkingLevel: thinkingLevelSchema
  }).and(profileLimitOverridesSchema)
});
const setProfileCredentialCommandSchema = commandMetadataSchema.extend({ command: z.literal("profile.credential.set"), payload: z.object({ profileId: z.string().min(1), apiKey: z.string().min(1).max(8192) }) });
const listAcademicCredentialsCommandSchema = commandMetadataSchema.extend({ command: z.literal("academic.credentials.list") });
const setAcademicCredentialCommandSchema = commandMetadataSchema.extend({
  command: z.literal("academic.credentials.set"),
  payload: z.object({ source: academicCredentialSourceSchema, credential: z.string().min(1).max(8192) })
});
const clearAcademicCredentialCommandSchema = commandMetadataSchema.extend({
  command: z.literal("academic.credentials.clear"),
  payload: z.object({ source: academicCredentialSourceSchema })
});
const listPromptRevisionsCommandSchema = commandMetadataSchema.extend({ command: z.literal("prompt.revision.list") });
const createPromptRevisionCommandSchema = commandMetadataSchema.extend({
  command: z.literal("prompt.revision.create"),
  payload: z.object({ content: z.string().max(100_000), changeNote: z.string().trim().max(500).optional() })
});
const activatePromptRevisionCommandSchema = commandMetadataSchema.extend({
  command: z.literal("prompt.revision.activate"), payload: z.object({ revisionId: z.string().uuid() })
});
const restoreDefaultPromptCommandSchema = commandMetadataSchema.extend({
  command: z.literal("prompt.restore_default"), payload: z.object({ changeNote: z.string().trim().max(500).optional() })
});
const listTaskModelAssignmentsCommandSchema = commandMetadataSchema.extend({ command: z.literal("task_model_assignment.list") });
const setTaskModelAssignmentCommandSchema = commandMetadataSchema.extend({ command: z.literal("task_model_assignment.set"), payload: z.object({ taskType: taskModelTypeSchema, profileId: z.string().min(1) }) });
const clearTaskModelAssignmentCommandSchema = commandMetadataSchema.extend({ command: z.literal("task_model_assignment.clear"), payload: z.object({ taskType: taskModelTypeSchema }) });
/**
 * Intent-level cognition commands.  The Host owns all extraction, synthesis,
 * and persistence transitions behind this seam; no stage/profile/store input
 * is accepted by the Renderer-facing contract.
 */
const prepareMemoryReviewCommandSchema = commandMetadataSchema.extend({
  command: z.literal("memory_review.prepare"),
  payload: z.object({}).strict().optional()
}).strict();
const cancelMemoryReviewCommandSchema = commandMetadataSchema.extend({
  command: z.literal("memory_review.cancel"),
  payload: z.object({}).strict().optional()
}).strict();
const setMemoryReviewPolicyCommandSchema = commandMetadataSchema.extend({
  command: z.literal("memory_review.policy.set"),
  payload: z.object({ policy: autoMemoryReviewPolicySchema }).strict()
}).strict();
const decideCognitionReviewCommandSchema = commandMetadataSchema.extend({
  command: z.literal("cognition_review.decide"),
  payload: z.object({ reviewId: z.string().min(1), decisions: z.array(proposalDecisionInputSchema).max(100) }).strict()
}).strict();
const commitCognitionReviewCommandSchema = commandMetadataSchema.extend({
  command: z.literal("cognition_review.commit"),
  payload: z.object({ reviewId: z.string().min(1) }).strict()
}).strict();
const discardCognitionReviewCommandSchema = commandMetadataSchema.extend({
  command: z.literal("cognition_review.discard"),
  payload: z.object({ reviewId: z.string().min(1) }).strict()
}).strict();
const loadCognitionReviewCommandSchema = commandMetadataSchema.extend({
  command: z.literal("cognition_review.load"),
  payload: z.object({ reviewId: z.string().min(1) }).strict()
}).strict();
const startReflectionCommandSchema = commandMetadataSchema.extend({
  command: z.literal("reflection.start"),
  payload: z.discriminatedUnion("scope", [
    z.object({ scope: z.literal("project"), projectId: z.string().uuid(), focus: z.string().trim().max(5_000).optional() }).strict(),
    z.object({ scope: z.literal("unscoped"), threadId: z.string().min(1), focus: z.string().trim().max(5_000).optional() }).strict()
  ])
}).strict();
const finishReflectionCommandSchema = commandMetadataSchema.extend({
  command: z.literal("reflection.finish"),
  payload: z.object({ runId: z.string().uuid() }).strict()
}).strict();
const discardReflectionCommandSchema = commandMetadataSchema.extend({ command: z.literal("reflection.discard"), payload: z.object({ runId: z.string().uuid() }) });
const listThreadsCommandSchema = commandMetadataSchema.extend({ command: z.literal("thread.list") });
const listProjectsCommandSchema = commandMetadataSchema.extend({ command: z.literal("project.list") });
const openProjectCommandSchema = commandMetadataSchema.extend({ command: z.literal("project.open") });
const resolveProjectCollisionCommandSchema = commandMetadataSchema.extend({
  command: z.literal("project.collision.resolve"),
  payload: z.object({ collisionId: z.string().min(1), action: z.enum(["moved_project", "project_copy"]) })
});
const listProjectMaterialsCommandSchema = commandMetadataSchema.extend({
  command: z.literal("project.material.list"), payload: z.object({ projectId: z.string().uuid() })
});
const refreshProjectMaterialsCommandSchema = commandMetadataSchema.extend({
  command: z.literal("project.material.refresh"), payload: z.object({ projectId: z.string().uuid() })
});
const loadProjectContextCommandSchema = commandMetadataSchema.extend({
  command: z.literal("project.context.load"), payload: z.object({ projectId: z.string().uuid() })
});
const saveProjectContextCommandSchema = commandMetadataSchema.extend({
  command: z.literal("project.context.save"),
  payload: z.object({ projectId: z.string().uuid(), content: z.string().max(100_000), expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/) })
});
const loadProjectMemoryCommandSchema = commandMetadataSchema.extend({ command: z.literal("project.memory.load"), payload: z.object({ projectId: z.string().uuid() }) });
const saveProjectMemoryCommandSchema = commandMetadataSchema.extend({ command: z.literal("project.memory.save"), payload: z.object({ projectId: z.string().uuid(), content: z.string().max(200_000), expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/) }) });
const loadLongTermMemoryCommandSchema = commandMetadataSchema.extend({ command: z.literal("long_term_memory.load") });
const refreshLongTermMemoryCommandSchema = commandMetadataSchema.extend({ command: z.literal("long_term_memory.refresh") });
const saveLongTermMemoryCommandSchema = commandMetadataSchema.extend({ command: z.literal("long_term_memory.save"), payload: z.object({ content: z.string().max(500_000), expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/) }) });
const openLongTermMemoryFolderCommandSchema = commandMetadataSchema.extend({ command: z.literal("long_term_memory.open_folder") });
const loadMemoryMaintenanceCommandSchema = commandMetadataSchema.extend({ command: z.literal("long_term_memory.maintenance.load") });
const saveMemoryMaintenanceCommandSchema = commandMetadataSchema.extend({ command: z.literal("long_term_memory.maintenance.save"), payload: memoryMaintenanceStateSchema.pick({ retention: true, automaticDeletion: true }) });
const updateCondensationArchiveCommandSchema = commandMetadataSchema.extend({ command: z.literal("long_term_memory.archive.update"), payload: z.object({ archiveId: z.string().min(1), action: z.enum(["keep", "refresh"]) }) });
const cleanupCondensationArchiveCommandSchema = commandMetadataSchema.extend({ command: z.literal("long_term_memory.archive.cleanup"), payload: z.object({ archiveIds: z.array(z.string().min(1)).max(100) }) });
const inspectLongTermMemoryProvenanceCommandSchema = commandMetadataSchema.extend({ command: z.literal("long_term_memory.provenance.inspect"), payload: z.object({ threadId: z.string().min(1), sourceReferenceId: z.string().min(6).max(80) }) });
const dismissMemoryCandidateCommandSchema = commandMetadataSchema.extend({ command: z.literal("memory.candidate.dismiss"), payload: z.object({ candidateId: z.string().uuid() }) });
const listProjectOutputsCommandSchema = commandMetadataSchema.extend({ command: z.literal("project.output.list"), payload: z.object({ projectId: z.string().uuid() }) });
const openProjectOutputCommandSchema = commandMetadataSchema.extend({ command: z.literal("project.output.open"), payload: z.object({ projectId: z.string().uuid(), artifactId: z.string().min(1) }) });
const needMaterialCommandSchema = commandMetadataSchema.extend({
  command: z.literal("material.need"), payload: z.object({ materialId: z.string().uuid() })
});
const parseMaterialCommandSchema = commandMetadataSchema.extend({
  command: z.literal("material.parse.request"), payload: z.object({ materialId: z.string().uuid() })
});
const resolveParseRefreshCommandSchema = commandMetadataSchema.extend({
  command: z.literal("material.parse.refresh.resolve"),
  payload: z.object({ materialId: z.string().uuid(), choice: z.enum(["create_new_version", "replace_previous", "cancel"]) })
});
const loadThreadTrajectoryCommandSchema = commandMetadataSchema.extend({
  command: z.literal("thread.trajectory.load"),
  payload: z.object({ threadId: z.string().min(1) })
});
const deleteThreadTrajectoryCommandSchema = commandMetadataSchema.extend({ command: z.literal("thread.trajectory.delete"), payload: z.object({ threadId: z.string().min(1), confirmed: z.literal(true) }) });
const setThreadArchivedCommandSchema = commandMetadataSchema.extend({ command: z.literal("thread.archive.set"), payload: z.object({ threadId: z.string().min(1), archived: z.boolean() }) });
const deleteThreadCommandSchema = commandMetadataSchema.extend({ command: z.literal("thread.delete"), payload: z.object({ threadId: z.string().min(1), confirmed: z.literal(true) }) });
const renameThreadCommandSchema = commandMetadataSchema.extend({
  command: z.literal("thread.rename"),
  payload: z.object({ threadId: z.string().min(1), title: z.string().trim().min(1).max(120) })
});
const createThreadCommandSchema = commandMetadataSchema.extend({
  command: z.literal("thread.create.unscoped"),
  payload: z.object({ title: z.string().trim().min(1).max(120) })
});
const createProjectThreadCommandSchema = commandMetadataSchema.extend({
  command: z.literal("thread.create.project"),
  payload: z.object({ projectId: z.string().uuid(), title: z.string().trim().min(1).max(120) })
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
const listExecutionQueueCommandSchema = commandMetadataSchema.extend({ command: z.literal("execution_queue.list") });
const updateExecutionQueueItemCommandSchema = commandMetadataSchema.extend({
  command: z.literal("execution_queue.update"),
  payload: z.object({ itemId: z.string().uuid(), text: z.string().trim().min(1).max(200_000) })
});
const cancelExecutionQueueItemCommandSchema = commandMetadataSchema.extend({
  command: z.literal("execution_queue.cancel"), payload: z.object({ itemId: z.string().uuid() })
});
const activateExecutionQueueItemCommandSchema = commandMetadataSchema.extend({
  command: z.literal("execution_queue.activate"), payload: z.object({ itemId: z.string().uuid() })
});
const reorderExecutionQueueItemCommandSchema = commandMetadataSchema.extend({
  command: z.literal("execution_queue.reorder"),
  payload: z.object({ itemId: z.string().uuid(), beforeItemId: z.string().uuid().optional() })
});
const stopTurnCommandSchema = commandMetadataSchema.extend({
  command: z.literal("turn.stop"),
  payload: z.object({ threadId: z.string().min(1), turnId: z.string().min(1) })
});
const compactThreadCommandSchema = commandMetadataSchema.extend({
  command: z.literal("thread.compact"),
  payload: z.object({ threadId: z.string().min(1) })
});
const resolveCapabilityConfirmationCommandSchema = commandMetadataSchema.extend({
  command: z.literal("capability.confirmation.resolve"),
  payload: z.object({ requestId: z.string().min(1), approved: z.boolean() })
});
const authorizeSubAgentRunCommandSchema = commandMetadataSchema.extend({
  command: z.literal("sub_agent.run.authorize"),
  payload: z.object({
    parentThreadId: z.string().min(1),
    parentTurnId: z.string().min(1),
    explicitIntentEvidence: subAgentExplicitIntentEvidenceSchema,
    taskLimit: z.number().int().positive().max(32).optional(),
    sharedTokenBudget: z.number().int().positive().max(2_000_000).optional(),
    tasks: z.array(subAgentTaskInputSchema).min(1).max(32)
  })
});
const listSubAgentRunsCommandSchema = commandMetadataSchema.extend({ command: z.literal("sub_agent.run.list") });
const inspectSubAgentRunCommandSchema = commandMetadataSchema.extend({ command: z.literal("sub_agent.run.inspect"), payload: z.object({ runId: z.string().uuid() }) });
const inspectSubAgentTaskCommandSchema = commandMetadataSchema.extend({ command: z.literal("sub_agent.task.inspect"), payload: z.object({ runId: z.string().uuid(), taskId: z.string().uuid() }) });
const stopSubAgentRunCommandSchema = commandMetadataSchema.extend({ command: z.literal("sub_agent.run.stop"), payload: z.object({ runId: z.string().uuid(), reason: z.string().trim().max(200).optional() }) });
const retrySubAgentTaskCommandSchema = commandMetadataSchema.extend({ command: z.literal("sub_agent.task.retry"), payload: z.object({ taskId: z.string().uuid() }) });
const skipSubAgentTaskCommandSchema = commandMetadataSchema.extend({ command: z.literal("sub_agent.task.skip"), payload: z.object({ taskId: z.string().uuid() }) });
const adoptSubAgentHandoffCommandSchema = commandMetadataSchema.extend({ command: z.literal("sub_agent.handoff.adopt"), payload: z.object({ taskId: z.string().uuid() }) });
const rejectSubAgentHandoffCommandSchema = commandMetadataSchema.extend({ command: z.literal("sub_agent.handoff.reject"), payload: z.object({ taskId: z.string().uuid() }) });
const deleteSubAgentRecordCommandSchema = commandMetadataSchema.extend({ command: z.literal("sub_agent.record.delete"), payload: z.object({ runId: z.string().uuid(), taskId: z.string().uuid().optional(), confirmed: z.literal(true) }) });

export const hostCommandSchema = z.discriminatedUnion("command", [
  bootstrapCommandSchema,
  exportRecoveryStateCommandSchema,
  createPersonalCognitionBackupCommandSchema,
  restorePersonalCognitionCommandSchema,
  setAccessModeCommandSchema,
  listProfilesCommandSchema,
  loadIntegrationStateCommandSchema,
  chooseOfficeSourceCommandSchema,
  prepareOfficeTaskCommandSchema,
  runOfficeTaskCommandSchema,
  cancelOfficeTaskCommandSchema,
  commitOfficeResultCommandSchema,
  openOfficeArtifactCommandSchema,
  replaceOfficeOriginalCommandSchema,
  listSkillCreatorDraftsCommandSchema,
  prepareSkillCreatorDraftCommandSchema,
  reviewSkillCreatorDraftCommandSchema,
  acceptSkillCreatorDraftCommandSchema,
  discardSkillCreatorDraftCommandSchema,
  inspectPageRecoveryCommandSchema,
  runPageRecoveryCommandSchema,
  cancelPageRecoveryCommandSchema,
  loadPiResourcesCommandSchema,
  openPiResourceCommandSchema,
  reloadPiResourcesCommandSchema,
  importPiSkillCommandSchema,
  setPiProjectTrustCommandSchema,
  createProfileCommandSchema,
  updateProfileCommandSchema,
  setProfileCredentialCommandSchema,
  listAcademicCredentialsCommandSchema,
  setAcademicCredentialCommandSchema,
  clearAcademicCredentialCommandSchema,
  listPromptRevisionsCommandSchema,
  createPromptRevisionCommandSchema,
  activatePromptRevisionCommandSchema,
  restoreDefaultPromptCommandSchema,
  listTaskModelAssignmentsCommandSchema,
  setTaskModelAssignmentCommandSchema,
  clearTaskModelAssignmentCommandSchema,
  prepareMemoryReviewCommandSchema,
  cancelMemoryReviewCommandSchema,
  setMemoryReviewPolicyCommandSchema,
  decideCognitionReviewCommandSchema,
  commitCognitionReviewCommandSchema,
  discardCognitionReviewCommandSchema,
  loadCognitionReviewCommandSchema,
  startReflectionCommandSchema,
  finishReflectionCommandSchema,
  discardReflectionCommandSchema,
  listProjectsCommandSchema,
  openProjectCommandSchema,
  resolveProjectCollisionCommandSchema,
  listProjectMaterialsCommandSchema,
  refreshProjectMaterialsCommandSchema,
  loadProjectContextCommandSchema,
  saveProjectContextCommandSchema,
  loadProjectMemoryCommandSchema,
  saveProjectMemoryCommandSchema,
  loadLongTermMemoryCommandSchema,
  refreshLongTermMemoryCommandSchema,
  saveLongTermMemoryCommandSchema,
  openLongTermMemoryFolderCommandSchema,
  loadMemoryMaintenanceCommandSchema,
  saveMemoryMaintenanceCommandSchema,
  updateCondensationArchiveCommandSchema,
  cleanupCondensationArchiveCommandSchema,
  inspectLongTermMemoryProvenanceCommandSchema,
  dismissMemoryCandidateCommandSchema,
  listProjectOutputsCommandSchema,
  openProjectOutputCommandSchema,
  needMaterialCommandSchema,
  parseMaterialCommandSchema,
  resolveParseRefreshCommandSchema,
  listThreadsCommandSchema,
  loadThreadTrajectoryCommandSchema,
  deleteThreadTrajectoryCommandSchema,
  setThreadArchivedCommandSchema,
  deleteThreadCommandSchema,
  renameThreadCommandSchema,
  createThreadCommandSchema,
  createProjectThreadCommandSchema,
  selectThreadProfileCommandSchema,
  resolveThreadProfileChangeCommandSchema,
  chooseOutputLocationCommandSchema,
  submitTurnCommandSchema,
  listExecutionQueueCommandSchema,
  updateExecutionQueueItemCommandSchema,
  cancelExecutionQueueItemCommandSchema,
  activateExecutionQueueItemCommandSchema,
  reorderExecutionQueueItemCommandSchema,
  stopTurnCommandSchema,
  compactThreadCommandSchema,
  resolveCapabilityConfirmationCommandSchema,
  authorizeSubAgentRunCommandSchema,
  listSubAgentRunsCommandSchema,
  inspectSubAgentRunCommandSchema,
  inspectSubAgentTaskCommandSchema,
  stopSubAgentRunCommandSchema,
  retrySubAgentTaskCommandSchema,
  skipSubAgentTaskCommandSchema,
  adoptSubAgentHandoffCommandSchema,
  rejectSubAgentHandoffCommandSchema,
  deleteSubAgentRecordCommandSchema
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

/** Bounded, content-free Memory Review preparation projection. */
export const memoryReviewProgressSchema = z.object({
  reviewId: z.string().min(1).optional(),
  batchId: z.string().min(1).optional(),
  status: z.enum(["preparing", "waiting_for_review", "completed", "failed", "cancelled"]),
  eligible: z.number().int().nonnegative().max(100_000),
  processed: z.number().int().nonnegative().max(100_000),
  noSignal: z.number().int().nonnegative().max(100_000),
  represented: z.number().int().nonnegative().max(100_000),
  carriedOver: z.number().int().nonnegative().max(100_000),
  completedChunks: z.number().int().nonnegative().max(100_000),
  totalChunks: z.number().int().nonnegative().max(100_000),
  failureCode: z.string().regex(/^[A-Z0-9_]{1,80}$/).optional()
}).strict().superRefine((progress, context) => {
  if (progress.reviewId === undefined && progress.batchId === undefined) {
    context.addIssue({ code: "custom", path: ["reviewId"], message: "Memory Review progress requires a reviewId or batchId." });
  }
});
export type MemoryReviewProgress = z.infer<typeof memoryReviewProgressSchema>;

export const executionSchedulerTelemetrySchema = z.object({
  capacity: z.number().int().positive(),
  runningCount: z.number().int().nonnegative(),
  queuedCount: z.number().int().nonnegative(),
  draftCount: z.number().int().nonnegative(),
  averageQueueDelayMs: z.number().int().nonnegative(),
  longestRunningMs: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  oldestQueuedAt: z.string().datetime().optional()
});

export const bootstrapStateSchema = z.object({
  applicationVersion: z.string().min(1),
  stateSchemaVersion: z.number().int().positive(),
  storagePath: z.string().min(1),
  storageMode: z.enum(["read_write", "read_only_recovery"]),
  migration: z.object({
    status: z.enum(["fresh", "ready", "migrated", "newer_state", "migration_failed"]),
    storedVersion: z.number().int().nonnegative(),
    supportedVersion: z.number().int().positive(),
    rollbackAvailable: z.boolean(),
    diagnosticCode: z.string().min(1).max(80).optional(),
    diagnosticMessage: z.string().min(1).max(200).optional()
  }),
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
  }),
  piProviders: z.array(z.string().min(1)).optional(),
  executionScheduler: executionSchedulerTelemetrySchema,
  environmentDoctor: z.record(z.string().min(1).max(80), z.object({
    status: z.enum(["ready", "attention", "unavailable"]),
    message: z.string().min(1).max(200)
  })).optional()
});

const bootstrapCompletedEventSchema = eventMetadataSchema.extend({
  event: z.literal("app.bootstrap.completed"),
  payload: bootstrapStateSchema
});
const recoveryStateExportCompletedEventSchema = eventMetadataSchema.extend({
  event: z.literal("state.recovery.export.completed"),
  payload: z.object({ status: z.enum(["exported", "canceled"]), destination: z.string().min(1).max(4096).optional(), fileCount: z.number().int().nonnegative() })
});
const personalCognitionOperationCompletedEventSchema = eventMetadataSchema.extend({
  event: z.literal("personal_cognition.operation.completed"),
  payload: z.object({
    operation: z.enum(["backup", "restore"]),
    status: z.enum(["completed", "canceled"]),
    path: z.string().min(1).max(4096).optional(),
    fileCount: z.number().int().nonnegative(),
    requiresCredentialSetup: z.boolean()
  })
});
const accessModeChangedEventSchema = eventMetadataSchema.extend({
  event: z.literal("access.mode.changed"),
  payload: z.object({ mode: z.enum(["standard", "full"]) })
});
const diagnosticRaisedEventSchema = eventMetadataSchema.extend({
  event: z.literal("diagnostic.raised"),
  payload: z.object({
    code: z.enum(["UNSUPPORTED_SCHEMA_VERSION", "INVALID_COMMAND", "HOST_FAILURE", "READ_ONLY_RECOVERY_MODE"]),
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
const profileUpdatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("profile.updated"),
  payload: z.object({ profile: modelProfileSchema })
});
const piResourcesUpdatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("pi.resources.updated"),
  payload: z.object({
    state: piResourcesSettingsStateSchema,
    action: z.enum(["loaded", "opened", "reloaded", "imported", "project_trust_changed"])
  })
});
const integrationStateUpdatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("integration.state.updated"),
  payload: z.object({ state: integrationStateSchema, action: z.enum(["loaded", "changed", "recovered"]) })
});
const integrationJobUpdatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("integration.job.updated"),
  payload: z.object({ workflow: z.enum(["office", "skill_creator", "page_recovery"]), job: integrationJobSummarySchema })
});
const integrationDiagnosticEventSchema = eventMetadataSchema.extend({
  event: z.literal("integration.diagnostic"),
  payload: z.object({ workflow: z.enum(["office", "skill_creator", "page_recovery"]), code: z.string().min(1), message: z.string().min(1).max(1_200), recoverable: z.boolean() })
});
const officeSourceSelectedEventSchema = eventMetadataSchema.extend({
  event: z.literal("office.source.selected"),
  payload: z.object({ path: z.string().min(1).optional(), canceled: z.boolean() })
});
const officeArtifactOpenedEventSchema = eventMetadataSchema.extend({
  event: z.literal("office.artifact.opened"),
  payload: z.object({ resultId: z.string().uuid(), artifact: z.enum(["staged_output", "change_summary", "preview"]) })
});
const profileCredentialUpdatedEventSchema = eventMetadataSchema.extend({ event: z.literal("profile.credential.updated"), payload: z.object({ profile: modelProfileSchema }) });
const academicCredentialsUpdatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("academic.credentials.updated"),
  payload: z.object({
    credentials: z.array(academicCredentialStatusSchema).length(3),
    action: z.enum(["listed", "set", "cleared"])
  })
});
const promptRevisionsListedEventSchema = eventMetadataSchema.extend({
  event: z.literal("prompt.revisions.listed"),
  payload: z.object({ activeRevisionId: z.string().uuid(), revisions: z.array(systemPromptRevisionSchema) })
});
const promptRevisionCreatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("prompt.revision.created"), payload: z.object({ revision: systemPromptRevisionSchema, activeRevisionId: z.string().uuid() })
});
const promptRevisionActivatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("prompt.revision.activated"), payload: z.object({ revision: systemPromptRevisionSchema })
});
const systemPromptUpdatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("system_prompt.updated"),
  payload: z.object({ threadId: z.string().min(1), turnId: z.string().min(1), previousRevisionId: z.string().uuid(), nextRevisionId: z.string().uuid() })
});
const taskModelAssignmentsListedEventSchema = eventMetadataSchema.extend({ event: z.literal("task_model_assignments.listed"), payload: z.object({ assignments: z.array(taskModelAssignmentSchema) }) });
const taskModelAssignmentUpdatedEventSchema = eventMetadataSchema.extend({ event: z.literal("task_model_assignment.updated"), payload: z.object({ taskType: taskModelTypeSchema, assignment: taskModelAssignmentSchema.optional() }) });
const cognitionReviewBundleUpdatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("cognition_review.bundle.updated"),
  payload: z.object({ bundle: reviewBundleSchema }).strict()
});
const cognitionReviewBundlesListedEventSchema = eventMetadataSchema.extend({
  event: z.literal("cognition_review.bundles.listed"),
  payload: z.object({ bundles: z.array(reviewBundleSchema).max(100) }).strict()
});
const memoryReviewProgressUpdatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("memory_review.progress.updated"),
  payload: z.object({ progress: memoryReviewProgressSchema }).strict()
});
const memoryReviewPolicyUpdatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("memory_review.policy.updated"),
  payload: z.object({ policy: autoMemoryReviewPolicySchema }).strict()
});
const cognitionReviewCommitResultEventSchema = eventMetadataSchema.extend({
  event: z.literal("cognition_review.commit.result"),
  payload: z.object({ result: cognitionCommitResultSchema }).strict()
});
const reflectionRunCreatedEventSchema = eventMetadataSchema.extend({ event: z.literal("reflection.run.created"), payload: z.object({ run: reflectionRunSchema, thread: threadSchema }) });
const reflectionRunUpdatedEventSchema = eventMetadataSchema.extend({ event: z.literal("reflection.run.updated"), payload: z.object({ run: reflectionRunSchema }) });
const threadsListedEventSchema = eventMetadataSchema.extend({
  event: z.literal("threads.listed"),
  payload: z.object({ threads: z.array(threadSchema) })
});
const projectsListedEventSchema = eventMetadataSchema.extend({
  event: z.literal("projects.listed"),
  payload: z.object({ projects: z.array(projectSchema) })
});
const projectOpenedEventSchema = eventMetadataSchema.extend({
  event: z.literal("project.opened"),
  payload: z.object({ project: projectSchema })
});
const projectCollisionDetectedEventSchema = eventMetadataSchema.extend({
  event: z.literal("project.identity.collision"),
  payload: z.object({
    collisionId: z.string().min(1),
    projectId: z.string().uuid(),
    existingPath: z.string().min(1),
    selectedPath: z.string().min(1)
  })
});
const projectMaterialsListedEventSchema = eventMetadataSchema.extend({
  event: z.literal("project.materials.listed"),
  payload: z.object({ projectId: z.string().uuid(), materials: z.array(materialInventoryItemSchema) })
});
const projectMaterialsUpdatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("project.materials.updated"),
  payload: z.object({ projectId: z.string().uuid(), materials: z.array(materialInventoryItemSchema), changedMaterialIds: z.array(z.string().uuid()) })
});
const parseRefreshChoiceRequiredEventSchema = eventMetadataSchema.extend({
  event: z.literal("material.parse.refresh.choice.required"),
  payload: z.object({
    material: materialInventoryItemSchema,
    previousSourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    currentSourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    parserId: z.string().min(1),
    priorReferences: z.number().int().nonnegative()
  })
});
const parseRefreshChoiceResolvedEventSchema = eventMetadataSchema.extend({
  event: z.literal("material.parse.refresh.choice.resolved"),
  payload: z.object({ materialId: z.string().uuid(), choice: z.enum(["create_new_version", "replace_previous", "cancel"]), status: z.enum(["pending_parse", "cancelled"]) })
});
const materialParseStartedEventSchema = eventMetadataSchema.extend({
  event: z.literal("material.parse.started"), payload: z.object({ materialId: z.string().uuid(), jobId: z.string().uuid() })
});
const materialParseCompletedEventSchema = eventMetadataSchema.extend({
  event: z.literal("material.parse.completed"),
  payload: z.object({ material: materialInventoryItemSchema, parseId: z.string().uuid(), parserId: z.string().min(1), artifactPath: z.string().min(1), warningCount: z.number().int().nonnegative(), reused: z.boolean() })
});
const materialParseFailedEventSchema = eventMetadataSchema.extend({
  event: z.literal("material.parse.failed"), payload: z.object({ materialId: z.string().uuid(), code: z.string().min(1), message: z.string().min(1) })
});
const threadTrajectoryLoadedEventSchema = eventMetadataSchema.extend({
  event: z.literal("thread.trajectory.loaded"),
  payload: z.object({ threadId: z.string().min(1), turns: z.array(ipcTrajectoryTurnSchema), activities: z.array(ipcTrajectoryActivitySchema) })
});
const threadCreatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("thread.created"),
  payload: z.object({ thread: threadSchema })
});
const threadRenamedEventSchema = eventMetadataSchema.extend({
  event: z.literal("thread.renamed"),
  payload: z.object({ thread: threadSchema })
});
const threadProfileSelectedEventSchema = eventMetadataSchema.extend({
  event: z.literal("thread.profile.selected"),
  payload: z.object({ thread: threadSchema })
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
    thread: threadSchema,
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
    profile: modelProfileSchema,
    prompt: z.object({ revisionId: z.string().uuid(), hash: z.string(), contributions: promptContributionSchema, capabilitySurface: capabilitySurfaceTelemetrySchema.optional() })
  })
});
const turnQueuedEventSchema = eventMetadataSchema.extend({
  event: z.literal("turn.queued"), payload: z.object({ item: executionQueueItemSchema })
});
const executionQueueUpdatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("execution_queue.updated"),
  payload: z.object({ items: z.array(executionQueueItemSchema), runningCount: z.number().int().nonnegative(), capacity: z.number().int().positive(), telemetry: executionSchedulerTelemetrySchema })
});
const turnStartedEventSchema = eventMetadataSchema.extend({
  event: z.literal("turn.started"),
  payload: z.object({ threadId: z.string().min(1), turnId: z.string().min(1) })
});
const messageDeltaEventSchema = eventMetadataSchema.extend({
  event: z.literal("message.delta"),
  payload: z.object({ threadId: z.string().min(1), turnId: z.string().min(1), delta: z.string() })
});
const thinkingDeltaEventSchema = eventMetadataSchema.extend({
  event: z.literal("thinking.delta"),
  payload: z.object({ threadId: z.string().min(1), turnId: z.string().min(1), delta: z.string() })
});
const sessionContextUpdatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("session.context.updated"),
  payload: z.object({ threadId: z.string().min(1), contextUsage: contextUsageSchema })
});
const turnCompletedEventSchema = eventMetadataSchema.extend({
  event: z.literal("turn.completed"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    message: z.string(),
    profile: modelProfileSchema,
    usage: usageSchema,
    citations: citationManifestSchema.optional(),
    contextUsage: contextUsageSchema.optional(),
    latencyMs: z.number().int().nonnegative(),
    recalledStateEstimatedTokens: z.number().int().nonnegative(),
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
const projectContextEventSchema = eventMetadataSchema.extend({
  event: z.enum(["project.context.loaded", "project.context.updated"]),
  payload: z.object({ document: projectContextDocumentSchema, source: z.enum(["lazy_create", "load", "user_save", "external_edit"]) })
});
const projectMemoryEventSchema = eventMetadataSchema.extend({
  event: z.enum(["project.memory.loaded", "project.memory.updated"]),
  payload: z.object({ document: projectMemoryDocumentSchema, source: z.enum(["lazy_create", "load", "user_save", "confirmed_append", "external_edit"]) })
});
const longTermMemoryEventSchema = eventMetadataSchema.extend({
  event: z.enum(["long_term_memory.loaded", "long_term_memory.updated"]),
  payload: z.object({ document: longTermMemoryDocumentSchema, source: z.enum(["lazy_create", "load", "user_save", "manual_refresh", "external_edit"]) })
});
const longTermMemoryFolderOpenedEventSchema = eventMetadataSchema.extend({
  event: z.literal("long_term_memory.folder.opened"), payload: z.object({ path: z.string().min(1) })
});
const memoryMaintenanceEventSchema = eventMetadataSchema.extend({ event: z.enum(["long_term_memory.maintenance.loaded", "long_term_memory.maintenance.updated"]), payload: z.object({ state: memoryMaintenanceStateSchema }) });
const longTermMemoryProvenanceInspectedEventSchema = eventMetadataSchema.extend({
  event: z.literal("long_term_memory.provenance.inspected"), payload: z.object({ sourceReferenceId: z.string().min(6), status: z.enum(["available", "source_unavailable"]), record: localMemoryProvenanceRecordSchema.optional() })
});
const memoryCandidateEventSchema = eventMetadataSchema.extend({
  event: z.enum(["memory.candidate.captured", "memory.candidate.resolved"]), payload: z.object({ candidate: memoryCandidateSchema })
});
const threadTrajectoryDeletedEventSchema = eventMetadataSchema.extend({
  event: z.literal("thread.trajectory.deleted"),
  payload: z.object({ threadId: z.string().min(1), removedCandidateIds: z.array(z.string().uuid()), affectedBatchIds: z.array(z.string().uuid()) })
});
const threadArchivedEventSchema = eventMetadataSchema.extend({ event: z.literal("thread.archived"), payload: z.object({ thread: threadSchema }) });
const threadDeletedEventSchema = eventMetadataSchema.extend({
  event: z.literal("thread.deleted"),
  payload: z.object({ threadId: z.string().min(1), removedCandidateIds: z.array(z.string().uuid()), affectedBatchIds: z.array(z.string().uuid()) })
});
const projectOutputsEventSchema = eventMetadataSchema.extend({
  event: z.enum(["project.outputs.listed", "project.outputs.updated"]), payload: z.object({ projectId: z.string().uuid(), outputs: z.array(projectOutputArtifactSchema) })
});
const projectOutputOpenedEventSchema = eventMetadataSchema.extend({ event: z.literal("project.output.opened"), payload: z.object({ projectId: z.string().uuid(), artifactId: z.string().min(1), destination: z.string().min(1) }) });
const threadCompactionEventSchema = eventMetadataSchema.extend({
  event: z.enum(["thread.compaction.started", "thread.compaction.completed", "thread.compaction.failed"]),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    reason: z.enum(["manual", "threshold", "overflow"]),
    tokensBefore: z.number().int().nonnegative().optional(),
    estimatedTokensAfter: z.number().int().nonnegative().optional(),
    failure: providerFailureSchema.optional()
  })
});
const capabilityConfirmationRequiredEventSchema = eventMetadataSchema.extend({
  event: z.literal("capability.confirmation.required"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    requestId: z.string().min(1),
    capabilityId: z.string().min(1),
    decisionClass: z.enum(["G1", "G2", "G3", "G4"]),
    action: z.string().min(1),
    target: z.string().min(1),
    reason: z.string().min(1),
    expectedEffect: z.string().min(1),
    preview: z.string().max(20_000).optional()
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
    runtime: z.object({ sourceClass: z.enum(["host", "pi_builtin", "bundled_extension", "pi_extension", "mcp"]), sourceId: z.string().min(1), sourceRevision: z.string().min(1), activationReason: z.string().min(1), actionClass: z.enum(["none", "local_read", "network_read", "local_write", "external_write", "destructive"]), confirmationState: z.enum(["not_required", "required", "approved", "rejected"]), durationMs: z.number().int().nonnegative().optional(), truncated: z.boolean().optional() }).optional(),
    artifact: z.object({ id: z.string().min(1), mediaType: z.string().min(1), destination: z.string().min(1) }).optional()
  })
});
const subAgentProjectionEventSchema = eventMetadataSchema.extend({
  event: z.enum([
    "sub_agent.run.authorized",
    "sub_agent.run.inspected",
    "sub_agent.run.stopped",
    "sub_agent.run.completed",
    "sub_agent.run.interrupted",
    "sub_agent.task.created",
    "sub_agent.task.queued",
    "sub_agent.task.started",
    "sub_agent.task.updated",
    "sub_agent.task.completed",
    "sub_agent.task.failed",
    "sub_agent.task.retry",
    "sub_agent.task.skipped",
    "sub_agent.handoff.adopted",
    "sub_agent.handoff.rejected",
    "sub_agent.record.deleted"
  ]),
  payload: z.object({ projection: subAgentProjectionSchema, task: subAgentTaskSchema.optional(), attempt: subAgentAttemptSchema.optional() })
});
const subAgentAttemptCreatedEventSchema = eventMetadataSchema.extend({
  event: z.literal("sub_agent.attempt.created"),
  payload: z.object({ projection: subAgentProjectionSchema, attempt: subAgentAttemptSchema })
});
const subAgentRunsListedEventSchema = eventMetadataSchema.extend({
  event: z.literal("sub_agent.runs.listed"),
  payload: z.object({ projections: z.array(subAgentRunProjectionSchema).max(32) })
});
const subAgentTaskInspectedEventSchema = eventMetadataSchema.extend({
  event: z.literal("sub_agent.task.inspected"),
  payload: z.object({ projection: subAgentTaskDetailProjectionSchema })
});
const subAgentBudgetExhaustedEventSchema = eventMetadataSchema.extend({
  event: z.literal("sub_agent.budget.exhausted"),
  payload: z.object({ projection: subAgentProjectionSchema, remainingTokens: z.number().int().nonnegative() })
});

export const hostEventSchema = z.discriminatedUnion("event", [
  bootstrapCompletedEventSchema,
  recoveryStateExportCompletedEventSchema,
  personalCognitionOperationCompletedEventSchema,
  accessModeChangedEventSchema,
  diagnosticRaisedEventSchema,
  profilesListedEventSchema,
  profileCreatedEventSchema,
  profileUpdatedEventSchema,
  academicCredentialsUpdatedEventSchema,
  piResourcesUpdatedEventSchema,
  integrationStateUpdatedEventSchema,
  integrationJobUpdatedEventSchema,
  integrationDiagnosticEventSchema,
  officeSourceSelectedEventSchema,
  officeArtifactOpenedEventSchema,
  profileCredentialUpdatedEventSchema,
  promptRevisionsListedEventSchema,
  promptRevisionCreatedEventSchema,
  promptRevisionActivatedEventSchema,
  systemPromptUpdatedEventSchema,
  taskModelAssignmentsListedEventSchema,
  taskModelAssignmentUpdatedEventSchema,
  cognitionReviewBundleUpdatedEventSchema,
  cognitionReviewBundlesListedEventSchema,
  memoryReviewProgressUpdatedEventSchema,
  memoryReviewPolicyUpdatedEventSchema,
  cognitionReviewCommitResultEventSchema,
  reflectionRunCreatedEventSchema,
  reflectionRunUpdatedEventSchema,
  projectsListedEventSchema,
  projectOpenedEventSchema,
  projectCollisionDetectedEventSchema,
  projectMaterialsListedEventSchema,
  projectMaterialsUpdatedEventSchema,
  parseRefreshChoiceRequiredEventSchema,
  parseRefreshChoiceResolvedEventSchema,
  materialParseStartedEventSchema,
  materialParseCompletedEventSchema,
  materialParseFailedEventSchema,
  threadsListedEventSchema,
  threadTrajectoryLoadedEventSchema,
  threadCreatedEventSchema,
  threadRenamedEventSchema,
  threadProfileSelectedEventSchema,
  threadProfileChangeRequiredEventSchema,
  threadProfileChangeResolvedEventSchema,
  threadOutputLocationSelectedEventSchema,
  turnAcceptedEventSchema,
  turnQueuedEventSchema,
  executionQueueUpdatedEventSchema,
  turnStartedEventSchema,
  messageDeltaEventSchema,
  thinkingDeltaEventSchema,
  sessionContextUpdatedEventSchema,
  turnCompletedEventSchema,
  turnFailedEventSchema,
  turnInterruptedEventSchema,
  turnStopRequestedEventSchema,
  physicalContextRebuiltEventSchema,
  projectContextEventSchema,
  projectMemoryEventSchema,
  longTermMemoryEventSchema,
  longTermMemoryFolderOpenedEventSchema,
  memoryMaintenanceEventSchema,
  longTermMemoryProvenanceInspectedEventSchema,
  memoryCandidateEventSchema,
  threadTrajectoryDeletedEventSchema,
  threadArchivedEventSchema,
  threadDeletedEventSchema,
  projectOutputsEventSchema,
  projectOutputOpenedEventSchema,
  threadCompactionEventSchema,
  capabilityConfirmationRequiredEventSchema,
  capabilityExecutionUpdatedEventSchema,
  subAgentProjectionEventSchema,
  subAgentRunsListedEventSchema,
  subAgentTaskInspectedEventSchema,
  subAgentAttemptCreatedEventSchema,
  subAgentBudgetExhaustedEventSchema
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
  "schemaVersion" | "commandId" | "correlationId" | "actor" | "sentAt" | "expectedStateVersion" | "scope"
>;
type AnyHostCommandInput = { [TName in HostCommandName]: HostCommandInput<TName> }[HostCommandName];

export function createCommand(command: AnyHostCommandInput): HostCommand {
  const payload = "payload" in command && command.payload !== undefined && typeof command.payload === "object" && command.payload !== null ? command.payload as Record<string, unknown> : undefined;
  const scope = payload?.scope === "project" || typeof payload?.projectId === "string" || command.command.startsWith("project.") || command.command === "thread.create.project" ? "project" : "unscoped";
  return {
    ...command,
    schemaVersion: IPC_SCHEMA_VERSION,
    commandId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    actor: { actorType: "user", actorId: "local-user" },
    sentAt: new Date().toISOString(),
    expectedStateVersion: 1,
    scope
  } as HostCommand;
}

export function createBootstrapCommand(): HostCommand {
  return createCommand({ command: "app.bootstrap" });
}
