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
