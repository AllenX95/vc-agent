import { z } from "zod";

/**
 * D1 explicit Sub-Agent records.  These are deliberately independent from
 * provider SDK types: the Host persists only a redacted profile snapshot and
 * bounded execution evidence, never credentials or hidden reasoning.
 */
export const subAgentRoleSchema = z.enum(["researcher", "critic", "synthesizer", "writer", "custom"]);
export type SubAgentRole = z.infer<typeof subAgentRoleSchema>;

export const subAgentCapabilitySchema = z.enum(["read_context", "read_materials", "web_research", "write_output"]);
export type SubAgentCapability = z.infer<typeof subAgentCapabilitySchema>;

export const subAgentRunStatusSchema = z.enum(["authorized", "queued", "running", "completed", "failed", "stopped", "interrupted", "budget_exhausted", "deleted"]);
export type SubAgentRunStatus = z.infer<typeof subAgentRunStatusSchema>;
export const subAgentTaskStatusSchema = z.enum(["created", "queued", "running", "completed", "failed", "stopped", "interrupted", "skipped", "deleted"]);
export type SubAgentTaskStatus = z.infer<typeof subAgentTaskStatusSchema>;
export const subAgentAttemptStatusSchema = z.enum(["created", "running", "completed", "failed", "stopped", "interrupted"]);
export type SubAgentAttemptStatus = z.infer<typeof subAgentAttemptStatusSchema>;

export const subAgentExplicitIntentEvidenceSchema = z.object({
  source: z.literal("user"),
  text: z.string().trim().min(1).max(5_000),
  confirmed: z.literal(true),
  taskLifetime: z.literal("current_task")
});
export type SubAgentExplicitIntentEvidence = z.infer<typeof subAgentExplicitIntentEvidenceSchema>;

export const subAgentProfileSnapshotSchema = z.object({
  profileId: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  resolutionSource: z.enum(["explicit_override", "role_assignment", "default_sub_agent", "primary_active"]).optional()
});
export type SubAgentProfileSnapshot = z.infer<typeof subAgentProfileSnapshotSchema>;

export const subAgentUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
});
export type SubAgentUsage = z.infer<typeof subAgentUsageSchema>;

export const subAgentContextBoundarySchema = z.object({
  scope: z.enum(["project", "unscoped"]),
  projectId: z.string().uuid().optional(),
  sourceReferenceIds: z.array(z.string().min(1).max(200)).max(100),
  maxChars: z.number().int().positive().max(100_000),
  outputRoot: z.string().min(1).max(4_096).optional()
});
export type SubAgentContextBoundary = z.infer<typeof subAgentContextBoundarySchema>;

export const subAgentHandoffSchema = z.object({
  summary: z.string().trim().min(1).max(20_000),
  provenance: z.array(z.object({ referenceId: z.string().min(1).max(200), source: z.string().min(1).max(200) })).max(100),
  outputPath: z.string().min(1).max(4_096).optional(),
  adoptedByParent: z.boolean(),
  reviewStatus: z.enum(["pending_parent_review", "adopted", "rejected"]).optional()
});
export type SubAgentHandoff = z.infer<typeof subAgentHandoffSchema>;

export const subAgentFailureSchema = z.object({
  code: z.string().min(1).max(120),
  message: z.string().min(1).max(1_200)
});
export type SubAgentFailure = z.infer<typeof subAgentFailureSchema>;

export const subAgentRunSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  parentThreadId: z.string().min(1),
  parentTurnId: z.string().min(1),
  explicitIntentEvidence: subAgentExplicitIntentEvidenceSchema,
  taskLimit: z.number().int().positive().max(32),
  sharedTokenBudget: z.number().int().positive().optional(),
  usage: subAgentUsageSchema,
  status: subAgentRunStatusSchema,
  taskIds: z.array(z.string().uuid()).max(32),
  stopReason: z.string().min(1).max(200).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().optional()
});
export type SubAgentRun = z.infer<typeof subAgentRunSchema>;

export const subAgentTaskSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  runId: z.string().uuid(),
  role: subAgentRoleSchema,
  objective: z.string().trim().min(1).max(20_000),
  contextBoundary: subAgentContextBoundarySchema,
  capabilitySet: z.array(subAgentCapabilitySchema).min(1).max(8),
  outputTarget: z.string().min(1).max(4_096).optional(),
  resolvedProfile: subAgentProfileSnapshotSchema,
  status: subAgentTaskStatusSchema,
  attemptIds: z.array(z.string().uuid()).max(32),
  handoff: subAgentHandoffSchema.optional(),
  usage: subAgentUsageSchema,
  failure: subAgentFailureSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().optional()
});
export type SubAgentTask = z.infer<typeof subAgentTaskSchema>;

export const subAgentAttemptSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  instructionRevision: z.number().int().positive(),
  profile: subAgentProfileSnapshotSchema,
  status: subAgentAttemptStatusSchema,
  messages: z.array(z.object({ role: z.enum(["user", "assistant", "tool"]), content: z.string().max(20_000) })).max(20),
  toolEvents: z.array(z.object({ capability: z.string().min(1).max(120), status: z.enum(["started", "completed", "failed", "rejected"]), summary: z.string().max(1_200) })).max(100),
  usage: subAgentUsageSchema,
  contextHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  failure: subAgentFailureSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type SubAgentAttempt = z.infer<typeof subAgentAttemptSchema>;

export const subAgentTaskInputSchema = z.object({
  role: subAgentRoleSchema,
  objective: z.string().trim().min(1).max(20_000),
  contextBoundary: subAgentContextBoundarySchema,
  capabilitySet: z.array(subAgentCapabilitySchema).min(1).max(8),
  outputTarget: z.string().min(1).max(4_096).optional(),
  profileId: z.string().min(1).optional()
});
export type SubAgentTaskInput = z.infer<typeof subAgentTaskInputSchema>;

export const subAgentProjectionSchema = z.object({
  run: subAgentRunSchema,
  tasks: z.array(subAgentTaskSchema).max(32),
  attempts: z.array(subAgentAttemptSchema).max(256)
});
export type SubAgentProjection = z.infer<typeof subAgentProjectionSchema>;

/** Default Run/Task projection. Attempt bodies and tool events are loaded separately. */
export const subAgentTaskSummarySchema = subAgentTaskSchema.pick({
  schemaVersion: true,
  id: true,
  runId: true,
  role: true,
  objective: true,
  status: true,
  handoff: true,
  usage: true,
  failure: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true
}).extend({ attemptCount: z.number().int().nonnegative().max(32) });
export type SubAgentTaskSummary = z.infer<typeof subAgentTaskSummarySchema>;

export const subAgentRunProjectionSchema = z.object({
  run: subAgentRunSchema,
  tasks: z.array(subAgentTaskSummarySchema).max(32),
  attemptCount: z.number().int().nonnegative().max(256)
});
export type SubAgentRunProjection = z.infer<typeof subAgentRunProjectionSchema>;

export const subAgentTaskDetailProjectionSchema = z.object({
  run: subAgentRunSchema,
  task: subAgentTaskSchema,
  attempts: z.array(subAgentAttemptSchema).max(32)
});
export type SubAgentTaskDetailProjection = z.infer<typeof subAgentTaskDetailProjectionSchema>;
