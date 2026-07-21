import { z } from "zod";

const promptSnapshotSchema = z.object({
  revisionId: z.string().uuid(),
  hash: z.string().regex(/^[a-f0-9]{64}$/)
});

export const dreamProfileSnapshotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"])
});
export type DreamProfileSnapshot = z.infer<typeof dreamProfileSnapshotSchema>;

export const dreamTrajectoryInputSchema = z.object({
  sourceKind: z.enum(["ordinary_dialogue", "reflection_dialogue"]),
  reflectionSignal: z.enum(["adoption", "correction", "confirmation"]).optional(),
  scope: z.enum(["project", "unscoped"]),
  projectId: z.string().uuid().optional(),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  completedAt: z.string().datetime(),
  sourceReference: z.string().min(1).max(500),
  userText: z.string().max(200_000),
  assistantText: z.string().max(200_000)
}).superRefine((value, context) => {
  if ((value.scope === "project") !== (value.projectId !== undefined)) {
    context.addIssue({ code: "custom", message: "Project Dream trajectory requires exactly one Project identity" });
  }
  if ((value.sourceKind === "reflection_dialogue") !== (value.reflectionSignal !== undefined)) {
    context.addIssue({ code: "custom", message: "Only Reflection Dream trajectory carries a Reflection signal" });
  }
});
export type DreamTrajectoryInput = z.infer<typeof dreamTrajectoryInputSchema>;

export const dreamCandidateInputSchema = z.object({
  candidateId: z.string().uuid(),
  origin: z.enum(["captured", "recovered", "carryover"]),
  scope: z.enum(["project", "unscoped"]),
  projectId: z.string().uuid().optional(),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  occurredAt: z.string().datetime(),
  sourceKind: z.enum(["ordinary_user_signal", "ordinary_dialogue", "reflection_dialogue", "confirmed_judgment"]),
  signal: z.enum(["explicit_remember", "strong_user_judgment", "reflection_adoption", "reflection_correction", "reflection_confirmation", "user_correction", "confirmed_judgment", "explicit_memory_action"]),
  sourceReference: z.string().min(1).max(500),
  sourceStatus: z.enum(["available", "source_deleted"]),
  sourceText: z.string().min(1).max(2_000).optional(),
  sourceDeletedAt: z.string().datetime().optional()
}).superRefine((value, context) => {
  if ((value.scope === "project") !== (value.projectId !== undefined)) {
    context.addIssue({ code: "custom", message: "Project Dream candidate requires exactly one Project identity" });
  }
  if ((value.sourceStatus === "available") !== (value.sourceText !== undefined)) {
    context.addIssue({ code: "custom", message: "Deleted Dream candidate sources cannot retain content" });
  }
});
export type DreamCandidateInput = z.infer<typeof dreamCandidateInputSchema>;

export const dreamCarryoverSchema = z.object({
  id: z.string().uuid(),
  sourceBatchId: z.string().uuid(),
  kind: z.enum(["candidate", "trajectory_scope"]),
  scope: z.enum(["project", "unscoped"]),
  projectId: z.string().uuid().optional(),
  threadId: z.string().min(1).optional(),
  candidateId: z.string().uuid().optional(),
  sourceReference: z.string().min(1).max(500),
  reason: z.enum(["keep_pending", "skipped", "failed", "interrupted", "unresolved"]),
  oldestUnresolvedAt: z.string().datetime(),
  sourceStatus: z.enum(["available", "source_deleted"]),
  sourceText: z.string().min(1).max(2_000).optional(),
  sourceDeletedAt: z.string().datetime().optional()
}).superRefine((value, context) => {
  if ((value.scope === "project") !== (value.projectId !== undefined)) {
    context.addIssue({ code: "custom", message: "Project Dream carryover requires exactly one Project identity" });
  }
  if (value.sourceStatus === "source_deleted" && value.sourceText !== undefined) {
    context.addIssue({ code: "custom", message: "Deleted Dream carryover cannot retain source content" });
  }
});
export type DreamCarryover = z.infer<typeof dreamCarryoverSchema>;

export const dreamScopeCandidateSummarySchema = z.object({
  candidateId: z.string().min(1).max(80),
  origin: z.enum(["captured", "recovered", "carryover"]),
  sourceKind: z.enum(["ordinary_user_signal", "reflection_dialogue", "confirmed_judgment"]),
  attributableSignal: z.enum(["explicit_remember", "strong_user_judgment", "reflection_adoption", "reflection_correction", "reflection_confirmation", "user_correction", "confirmed_judgment", "explicit_memory_action"]),
  sourceReferences: z.array(z.string().min(1).max(500)).min(1).max(20),
  uncertainty: z.string().max(1_000),
  summary: z.string().min(1).max(2_000),
  proposedDestination: z.enum(["project_memory", "long_term_memory", "keep_pending", "discard"])
});
export type DreamScopeCandidateSummary = z.infer<typeof dreamScopeCandidateSummarySchema>;

export const dreamScopeSummarySchema = z.object({
  schemaVersion: z.literal(1),
  scopeKind: z.enum(["project", "unscoped"]),
  deidentified: z.literal(true),
  summary: z.string().min(1).max(4_000),
  uncertainty: z.string().max(1_000),
  sourceReferences: z.array(z.string().min(1).max(500)).max(100),
  candidates: z.array(dreamScopeCandidateSummarySchema).max(30)
}).superRefine((value, context) => {
  if (value.scopeKind === "unscoped" && value.candidates.some((candidate) => candidate.proposedDestination === "project_memory")) {
    context.addIssue({ code: "custom", message: "Unscoped Dream extraction cannot propose Project Memory" });
  }
});
export type DreamScopeSummary = z.infer<typeof dreamScopeSummarySchema>;

const dreamScopeFailureSchema = z.object({
  kind: z.enum(["provider", "configuration", "worker"]),
  code: z.string().min(1),
  message: z.string().min(1).max(2_000),
  provider: z.string().optional(),
  model: z.string().optional(),
  requestId: z.string().optional()
});

export const dreamExtractionScopeSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(120),
  kind: z.enum(["project", "unscoped"]),
  projectId: z.string().uuid().optional(),
  threadId: z.string().min(1).optional(),
  status: z.enum(["pending", "running", "succeeded", "approved", "failed", "skipped", "keep_pending", "stale"]),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  projectMemoryHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  attemptCount: z.number().int().nonnegative(),
  sourceReferences: z.array(z.string().min(1).max(500)).max(200),
  result: dreamScopeSummarySchema.optional(),
  failure: dreamScopeFailureSchema.optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  reviewedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime()
}).superRefine((value, context) => {
  if ((value.kind === "project") !== (value.projectId !== undefined) || (value.kind === "unscoped") !== (value.threadId !== undefined)) {
    context.addIssue({ code: "custom", message: "Dream extraction scope identity is invalid" });
  }
  if (["succeeded", "approved", "skipped", "keep_pending"].includes(value.status) && value.result === undefined && value.status !== "skipped") {
    context.addIssue({ code: "custom", message: "Reviewed Dream extraction scope requires a result" });
  }
  if (value.result !== undefined && value.result.scopeKind !== value.kind) {
    context.addIssue({ code: "custom", message: "Dream extraction result scope does not match its isolated scope" });
  }
  if (value.status === "failed" && value.failure === undefined) {
    context.addIssue({ code: "custom", message: "Failed Dream extraction scope requires a sanitized failure" });
  }
});
export type DreamExtractionScope = z.infer<typeof dreamExtractionScopeSchema>;

const dreamLearningDraftSchema = z.object({
  title: z.string().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tags: z.array(z.string().min(1).max(80)).max(20),
  applicability: z.array(z.string().min(1).max(200)).max(20),
  maturity: z.literal("user-confirmed"),
  recallPolicy: z.enum(["automatic", "explicit-only"]),
  limitations: z.string().min(1).max(2_000),
  content: z.string().min(1).max(4_000)
});

export const dreamSynthesisProposalSchema = z.object({
  id: z.string().min(6).max(80),
  sourceScopeReferences: z.array(z.string().min(6).max(80)).min(1).max(20),
  sourceReferences: z.array(z.string().min(1).max(500)).min(1).max(100),
  candidateOrigins: z.array(z.enum(["captured", "recovered", "carryover"])).min(1).max(3),
  destination: z.enum(["project_memory", "long_term_memory", "keep_pending", "discard", "merge_condense"]),
  memoryAction: z.enum(["add", "reinforce", "narrow", "revise", "contradict", "merge_condense"]).optional(),
  targetEntryIds: z.array(z.string().min(6).max(80)).max(20),
  learning: dreamLearningDraftSchema.optional(),
  uncertainty: z.string().max(1_000),
  comparisonSummary: z.string().max(2_000),
  rationale: z.string().min(1).max(2_000),
  status: z.enum(["pending", "approved", "rejected"]).default("pending")
}).superRefine((value, context) => {
  const memoryDestination = value.destination === "project_memory" || value.destination === "long_term_memory" || value.destination === "merge_condense";
  if (memoryDestination && value.learning === undefined) context.addIssue({ code: "custom", message: "Dream Memory proposal requires a learning draft" });
  if (value.destination === "merge_condense" && value.memoryAction !== "merge_condense") context.addIssue({ code: "custom", message: "Merge / Condense destination requires merge_condense semantics" });
  if (value.destination === "long_term_memory" && value.memoryAction === undefined) context.addIssue({ code: "custom", message: "Long-term Memory proposal requires an evolution action" });
  if (value.destination === "project_memory" && value.memoryAction !== undefined) context.addIssue({ code: "custom", message: "Project Memory proposal does not use Long-term evolution actions" });
});
export type DreamSynthesisProposal = z.infer<typeof dreamSynthesisProposalSchema>;

export const dreamGlobalSynthesisSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  status: z.enum(["review_pending", "reviewed", "stale"]),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  longTermMemoryHash: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().min(1).max(4_000),
  uncertainty: z.string().max(1_000),
  partialCoverageScopeReferences: z.array(z.string().min(6).max(80)),
  scopeMap: z.array(z.object({ scopeReference: z.string().min(6).max(80), scopeId: z.string().min(1).max(120) })),
  proposals: z.array(dreamSynthesisProposalSchema).max(50),
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime().optional(),
  staleAt: z.string().datetime().optional()
});
export type DreamGlobalSynthesis = z.infer<typeof dreamGlobalSynthesisSchema>;

export const dreamPreparedPatchSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  status: z.enum(["prepared", "stale", "committed", "discarded"]),
  synthesisId: z.string().uuid(),
  synthesisInputHash: z.string().regex(/^[a-f0-9]{64}$/),
  longTermPatchId: z.string().min(8).max(80),
  proposalIds: z.array(z.string().min(6).max(80)),
  partialCoverageScopeReferences: z.array(z.string().min(6).max(80)),
  files: z.array(z.object({
    kind: z.enum(["project_memory", "long_term_memory", "condensation_archive", "cognitive_evolution_history", "local_provenance", "recall_index", "dream_state", "candidate_store"]),
    path: z.string().min(1),
    baseHash: z.string().min(1),
    resultHash: z.string().min(1),
    changed: z.boolean(),
    diff: z.string()
  })),
  confirmationRequired: z.literal(true),
  createdAt: z.string().datetime(),
  committedAt: z.string().datetime().optional(),
  staleAt: z.string().datetime().optional()
});
export type DreamPreparedPatch = z.infer<typeof dreamPreparedPatchSchema>;

export const dreamBatchSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  status: z.enum(["ready", "running", "resumable", "review_pending", "synthesis_pending", "patch_pending", "completed", "discarded"]),
  currentStage: z.enum(["batch_created", "scope_extraction", "scope_review", "global_synthesis", "patch_preparation", "completed", "discarded"]),
  cutoff: z.string().datetime(),
  previousCommittedCutoff: z.string().datetime().optional(),
  promptSnapshot: promptSnapshotSchema,
  profileSnapshot: dreamProfileSnapshotSchema,
  trajectoryInputs: z.array(dreamTrajectoryInputSchema),
  candidateInputs: z.array(dreamCandidateInputSchema),
  carryoverInputs: z.array(dreamCarryoverSchema),
  extractionScopes: z.array(dreamExtractionScopeSchema).default([]),
  partialCoverageScopeIds: z.array(z.string().min(1).max(120)).default([]),
  synthesis: dreamGlobalSynthesisSchema.optional(),
  synthesisFailure: dreamScopeFailureSchema.optional(),
  preparedPatch: dreamPreparedPatchSchema.optional(),
  representedProjectIds: z.array(z.string().uuid()),
  representedScopeCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  discardedAt: z.string().datetime().optional()
});
export type DreamBatch = z.infer<typeof dreamBatchSchema>;

export const dreamScheduleMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  reviewIntervalDays: z.number().int().min(1).max(365),
  pendingCandidateCount: z.number().int().nonnegative(),
  eligibleSessionCount: z.number().int().nonnegative(),
  representedProjectIds: z.array(z.string().uuid()),
  oldestUnresolvedAt: z.string().datetime().optional(),
  latestEligibleCompletedAt: z.string().datetime().optional(),
  lastCompletedDreamAt: z.string().datetime().optional(),
  lastCommittedCutoff: z.string().datetime().optional(),
  deferredUntil: z.string().datetime().optional(),
  activeBatchId: z.string().uuid().optional(),
  carryoverCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime()
});
export type DreamScheduleMetadata = z.infer<typeof dreamScheduleMetadataSchema>;

export const dreamDueProposalSchema = z.object({
  kind: z.literal("due_proposal"),
  dueAt: z.string().datetime(),
  candidateCount: z.number().int().nonnegative(),
  eligibleSessionCount: z.number().int().nonnegative(),
  representedProjectCount: z.number().int().nonnegative(),
  lastCompletedDreamAt: z.string().datetime().optional(),
  profile: dreamProfileSnapshotSchema.optional()
});
export type DreamDueProposal = z.infer<typeof dreamDueProposalSchema>;

export const pendingDreamReminderSchema = z.object({
  kind: z.enum(["resumable_run", "carryover"]),
  batchId: z.string().uuid().optional(),
  affectedScopeCount: z.number().int().nonnegative(),
  oldestUnresolvedAt: z.string().datetime(),
  lastSavedStage: dreamBatchSchema.shape.currentStage.optional()
});
export type PendingDreamReminder = z.infer<typeof pendingDreamReminderSchema>;

export const dreamReviewStateSchema = z.object({
  schemaVersion: z.literal(1),
  schedule: dreamScheduleMetadataSchema,
  batches: z.array(dreamBatchSchema),
  carryover: z.array(dreamCarryoverSchema),
  eligibilityIndex: z.array(z.object({
    sourceReference: z.string().min(1).max(500),
    scope: z.enum(["project", "unscoped"]),
    projectId: z.string().uuid().optional(),
    threadId: z.string().min(1),
    completedAt: z.string().datetime()
  })),
  candidateIndex: z.array(z.object({
    candidateId: z.string().uuid(),
    scope: z.enum(["project", "unscoped"]),
    projectId: z.string().uuid().optional(),
    threadId: z.string().min(1),
    capturedAt: z.string().datetime()
  }))
});
export type DreamReviewState = z.infer<typeof dreamReviewStateSchema>;
