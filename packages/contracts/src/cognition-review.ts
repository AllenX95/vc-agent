import { z } from "zod";

/**
 * Contracts shared by the Host and the two product intents (Reflection and
 * Memory Review).  These records deliberately contain references and hashes,
 * never raw Thread Trajectory bodies.  Trajectory remains the source of truth
 * for user/assistant content and is resolved only when a chunk is executed.
 */

export const cognitionReviewSchemaVersion = 1 as const;

export const cognitionScopeSchema = z.enum(["project", "unscoped"]);
export type CognitionScope = z.infer<typeof cognitionScopeSchema>;

export const learningEpochSchema = z.object({
  schemaVersion: z.literal(cognitionReviewSchemaVersion),
  learningEpochStartedAt: z.string().datetime(),
  /** Cutover state is optional for the steady-state epoch file. */
  status: z.enum(["pending_reset", "active", "failed_reset"]).optional()
});
export type LearningEpoch = z.infer<typeof learningEpochSchema>;

export const eligibleLearningSourceKindSchema = z.enum([
  "ordinary_exchange",
  "confirmed_judgment",
  "reflection_exchange",
  "explicit_memory_action"
]);
export type EligibleLearningSourceKind = z.infer<typeof eligibleLearningSourceKindSchema>;

/** A content-free pointer into Thread Trajectory or a confirmed artifact. */
export const eligibleLearningSourceSchema = z.object({
  sourceReference: z.string().min(1),
  sourceKind: eligibleLearningSourceKindSchema,
  scope: cognitionScopeSchema,
  projectId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  completedAt: z.string().datetime(),
  sourceVersion: z.string().min(1).optional(),
  availability: z.enum(["available", "deleted"]).default("available")
}).strict().superRefine((source, context) => {
  if (source.scope === "project" && source.projectId === undefined) {
    context.addIssue({ code: "custom", path: ["projectId"], message: "Project sources require projectId." });
  }
  if (source.scope === "unscoped" && source.projectId !== undefined) {
    context.addIssue({ code: "custom", path: ["projectId"], message: "Unscoped sources cannot carry projectId." });
  }
});
export type EligibleLearningSource = z.infer<typeof eligibleLearningSourceSchema>;

export const sourceDispositionStatusSchema = z.enum([
  "pending",
  "processing",
  "no_signal",
  "represented",
  "carried_over"
]);
export type SourceDispositionStatus = z.infer<typeof sourceDispositionStatusSchema>;
export const terminalSourceDispositionStatusSchema = z.enum(["no_signal", "represented", "carried_over"]);
export type TerminalSourceDispositionStatus = z.infer<typeof terminalSourceDispositionStatusSchema>;

/** One source's authoritative state in a frozen Coverage Ledger. */
export const coverageLedgerEntrySchema = z.object({
  sourceReference: z.string().min(1),
  sourceKind: eligibleLearningSourceKindSchema,
  scope: cognitionScopeSchema,
  projectId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  completedAt: z.string().datetime(),
  chunkId: z.string().min(1).optional(),
  status: sourceDispositionStatusSchema,
  proposalIds: z.array(z.string().min(1)).max(100),
  availability: z.enum(["available", "deleted"]),
  dispositionReason: z.string().max(500).optional(),
  updatedAt: z.string().datetime()
}).strict();
export type CoverageLedgerEntry = z.infer<typeof coverageLedgerEntrySchema>;

export const coverageLedgerSchema = z.object({
  schemaVersion: z.literal(cognitionReviewSchemaVersion),
  batchId: z.string().min(1),
  cutoff: z.string().datetime(),
  entries: z.array(coverageLedgerEntrySchema).max(100_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).superRefine((ledger, context) => {
  const seen = new Set<string>();
  ledger.entries.forEach((entry, index) => {
    if (seen.has(entry.sourceReference)) {
      context.addIssue({ code: "custom", path: ["entries", index, "sourceReference"], message: "Coverage Ledger source references must be unique." });
    }
    seen.add(entry.sourceReference);
    if (new Set(entry.proposalIds).size !== entry.proposalIds.length) {
      context.addIssue({ code: "custom", path: ["entries", index, "proposalIds"], message: "Duplicate proposal references are not allowed." });
    }
    if (entry.status === "represented" && entry.proposalIds.length === 0) {
      context.addIssue({ code: "custom", path: ["entries", index, "proposalIds"], message: "Represented sources require at least one proposal reference." });
    }
    if (entry.status !== "represented" && entry.proposalIds.length > 0) {
      context.addIssue({ code: "custom", path: ["entries", index, "proposalIds"], message: "Only represented sources may reference proposals." });
    }
  });
});
export type CoverageLedger = z.infer<typeof coverageLedgerSchema>;

export const extractionChunkStatusSchema = z.enum(["pending", "processing", "completed", "failed", "interrupted"]);
export type ExtractionChunkStatus = z.infer<typeof extractionChunkStatusSchema>;

export const extractionChunkSchema = z.object({
  schemaVersion: z.literal(cognitionReviewSchemaVersion),
  id: z.string().min(1),
  scope: cognitionScopeSchema,
  projectId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  sourceReferences: z.array(z.string().min(1)).min(1).max(100_000),
  inputHash: z.string().min(1),
  status: extractionChunkStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  failureCode: z.string().min(1).optional()
}).strict().superRefine((chunk, context) => {
  if (new Set(chunk.sourceReferences).size !== chunk.sourceReferences.length) {
    context.addIssue({ code: "custom", path: ["sourceReferences"], message: "An extraction chunk cannot contain duplicate sources." });
  }
  if (chunk.scope === "project" && chunk.projectId === undefined) {
    context.addIssue({ code: "custom", path: ["projectId"], message: "Project chunks require projectId." });
  }
  if (chunk.scope === "unscoped" && chunk.projectId !== undefined) {
    context.addIssue({ code: "custom", path: ["projectId"], message: "Unscoped chunks cannot carry projectId." });
  }
});
export type ExtractionChunk = z.infer<typeof extractionChunkSchema>;

export const sourceDispositionInputSchema = z.object({
  sourceReference: z.string().min(1),
  status: terminalSourceDispositionStatusSchema,
  proposalIds: z.array(z.string().min(1)).max(100).optional(),
  reason: z.string().max(500).optional()
}).strict();
export type SourceDispositionInput = z.infer<typeof sourceDispositionInputSchema>;

export const extractionChunkResultSchema = z.object({
  schemaVersion: z.literal(cognitionReviewSchemaVersion),
  chunkId: z.string().min(1),
  dispositions: z.array(sourceDispositionInputSchema).max(100_000),
  completedAt: z.string().datetime()
}).strict().superRefine((result, context) => {
  const seen = new Set<string>();
  result.dispositions.forEach((disposition, index) => {
    if (seen.has(disposition.sourceReference)) {
      context.addIssue({ code: "custom", path: ["dispositions", index, "sourceReference"], message: "A chunk result cannot disposition a source twice." });
    }
    seen.add(disposition.sourceReference);
    if (disposition.status === "represented" && (disposition.proposalIds === undefined || disposition.proposalIds.length === 0)) {
      context.addIssue({ code: "custom", path: ["dispositions", index, "proposalIds"], message: "Represented sources require at least one proposal reference." });
    }
    if (disposition.proposalIds !== undefined && new Set(disposition.proposalIds).size !== disposition.proposalIds.length) {
      context.addIssue({ code: "custom", path: ["dispositions", index, "proposalIds"], message: "Duplicate proposal references are not allowed." });
    }
  });
});
export type ExtractionChunkResult = z.infer<typeof extractionChunkResultSchema>;

export const coverageSummarySchema = z.object({
  eligibleCount: z.number().int().nonnegative(),
  noSignalCount: z.number().int().nonnegative(),
  representedCount: z.number().int().nonnegative(),
  carriedOverCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  processingCount: z.number().int().nonnegative(),
  complete: z.boolean()
}).superRefine((summary, context) => {
  if (summary.noSignalCount + summary.representedCount + summary.carriedOverCount + summary.pendingCount + summary.processingCount !== summary.eligibleCount) {
    context.addIssue({ code: "custom", message: "Coverage summary counts must partition the eligible source set." });
  }
  if (summary.complete && (summary.pendingCount !== 0 || summary.processingCount !== 0)) {
    context.addIssue({ code: "custom", message: "Complete coverage cannot contain pending or processing sources." });
  }
});
export type CoverageSummary = z.infer<typeof coverageSummarySchema>;

export const proposalDestinationSchema = z.enum(["project_memory", "long_term_memory"]);
export type ProposalDestination = z.infer<typeof proposalDestinationSchema>;
export const cognitionMemoryEvolutionActionSchema = z.enum(["add", "reinforce", "narrow", "revise", "contradict", "merge_condense"]);
export type MemoryEvolutionAction = z.infer<typeof cognitionMemoryEvolutionActionSchema>;

export const learningProposalSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(50_000),
  applicability: z.array(z.string().min(1).max(200)).max(20),
  limitations: z.string().max(2_000),
  destination: proposalDestinationSchema,
  action: cognitionMemoryEvolutionActionSchema,
  sourceReferences: z.array(z.string().min(1)).min(1).max(100),
  targetEntryIds: z.array(z.string().min(1)).max(100).default([]),
  /** Host-captured scope hint; renderer/model paths are never accepted. */
  projectId: z.string().min(1).optional()
}).strict();
export type LearningProposal = z.infer<typeof learningProposalSchema>;

export const proposalDecisionSchema = z.enum(["adopt", "defer", "reject"]);
export type ProposalDecision = z.infer<typeof proposalDecisionSchema>;
export const proposalDecisionInputSchema = z.object({
  proposalId: z.string().min(1),
  decision: proposalDecisionSchema
}).strict();
export type ProposalDecisionInput = z.infer<typeof proposalDecisionInputSchema>;
export const proposalDecisionRecordSchema = proposalDecisionInputSchema.extend({ decidedAt: z.string().datetime() });
export type ProposalDecisionRecord = z.infer<typeof proposalDecisionRecordSchema>;

export const cognitionDependencySchema = z.object({
  kind: z.enum(["memory", "project_memory", "long_term_memory", "material", "source", "judgment_destination"]),
  reference: z.string().min(1),
  hash: z.string().min(1),
  required: z.boolean().default(true)
}).strict();
export type CognitionDependency = z.infer<typeof cognitionDependencySchema>;

export const cognitionPatchPreviewSchema = z.object({
  id: z.string().min(1),
  files: z.array(z.object({ path: z.string().min(1), baseHash: z.string().min(1), afterHash: z.string().min(1) }).strict()).max(100),
  confirmationRequired: z.literal(true)
}).strict();
export type CognitionPatchPreview = z.infer<typeof cognitionPatchPreviewSchema>;

export const cognitionJudgmentRecordDraftSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  judgment: z.string().min(1).max(50_000),
  rationale: z.array(z.string().min(1).max(5_000)).max(50),
  uncertainty: z.array(z.string().min(1).max(5_000)).max(50),
  evidenceReferences: z.array(z.string().min(1)).max(100),
  createdAt: z.string().datetime()
}).strict();
export type CognitionJudgmentRecordDraft = z.infer<typeof cognitionJudgmentRecordDraftSchema>;

export const reviewBundleStatusSchema = z.enum([
  "analysis_completed",
  "waiting_for_review",
  "reviewing",
  "prepared",
  "stale",
  "committed",
  "discarded"
]);
export type ReviewBundleStatus = z.infer<typeof reviewBundleStatusSchema>;

export const reviewBundleSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["reflection", "memory_review"]),
  status: reviewBundleStatusSchema,
  judgment: cognitionJudgmentRecordDraftSchema.optional(),
  proposals: z.array(learningProposalSchema).max(100),
  decisions: z.array(proposalDecisionRecordSchema).max(100),
  coverage: coverageSummarySchema.optional(),
  dependencies: z.array(cognitionDependencySchema).max(500),
  patch: cognitionPatchPreviewSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine((bundle, context) => {
  const proposalIds = new Set(bundle.proposals.map((proposal) => proposal.id));
  const decisions = new Set<string>();
  bundle.decisions.forEach((decision, index) => {
    if (!proposalIds.has(decision.proposalId)) {
      context.addIssue({ code: "custom", path: ["decisions", index, "proposalId"], message: "Decision references an unknown proposal." });
    }
    if (decisions.has(decision.proposalId)) {
      context.addIssue({ code: "custom", path: ["decisions", index, "proposalId"], message: "A proposal may have only one terminal decision." });
    }
    decisions.add(decision.proposalId);
  });
  if (bundle.kind === "reflection" && bundle.judgment === undefined && ["prepared", "committed"].includes(bundle.status)) {
    context.addIssue({ code: "custom", path: ["judgment"], message: "A prepared or committed Reflection bundle requires a Judgment Record draft." });
  }
});
export type ReviewBundle = z.infer<typeof reviewBundleSchema>;

export const autoMemoryReviewPolicySchema = z.object({
  enabled: z.boolean(),
  profileId: z.string().min(1),
  minEligibleExchangeCount: z.number().int().nonnegative(),
  maxIntervalDays: z.number().int().positive(),
  maxInputTokensPerRun: z.number().int().positive()
}).strict();
export type AutoMemoryReviewPolicy = z.infer<typeof autoMemoryReviewPolicySchema>;

export const memoryReviewInputSchema = z.object({
  kind: z.literal("memory_review"),
  cutoff: z.string().datetime(),
  sources: z.array(eligibleLearningSourceSchema).max(100_000),
  /** Terminal coverage is supplied by the Host after strict extraction. */
  coverageLedger: coverageLedgerSchema,
  /** Synthesis output is required by CognitionReviewModule.prepare. */
  proposals: z.array(learningProposalSchema).max(100).optional(),
  dependencies: z.array(cognitionDependencySchema).max(500).optional(),
  batchId: z.string().min(1).optional(),
  policy: autoMemoryReviewPolicySchema.optional()
}).strict();
export type MemoryReviewInput = z.infer<typeof memoryReviewInputSchema>;

export const reflectionReviewInputSchema = z.object({
  kind: z.literal("reflection"),
  judgment: cognitionJudgmentRecordDraftSchema,
  proposals: z.array(learningProposalSchema).max(100),
  dependencies: z.array(cognitionDependencySchema).max(500)
}).strict();
export type ReflectionReviewInput = z.infer<typeof reflectionReviewInputSchema>;

export const cognitionCommitResultSchema = z.object({
  schemaVersion: z.literal(cognitionReviewSchemaVersion),
  reviewId: z.string().min(1),
  status: z.enum(["committed", "stale", "failed"]),
  cutoff: z.string().datetime().optional(),
  adoptedProposalIds: z.array(z.string().min(1)),
  carriedOverSourceReferences: z.array(z.string().min(1)),
  errorCode: z.string().min(1).optional()
}).strict();
export type CognitionCommitResult = z.infer<typeof cognitionCommitResultSchema>;

export interface CognitionReviewModule {
  prepare(input: ReflectionReviewInput | MemoryReviewInput): ReviewBundle;
  decide(reviewId: string, decisions: readonly ProposalDecisionInput[]): ReviewBundle;
  commit(reviewId: string): CognitionCommitResult;
  discard(reviewId: string): void;
}
