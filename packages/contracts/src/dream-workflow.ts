import type { DreamBatch } from "./dream.js";

export type DreamPrimaryPhase = "collect" | "review" | "commit";

export interface DreamProjection {
  readonly phase: DreamPrimaryPhase;
  readonly scopeCount: number;
  readonly reviewedScopeCount: number;
  readonly proposalCount: number;
  readonly reviewedProposalCount: number;
  readonly partialCoverage: boolean;
  readonly unresolvedPriorPeriodCount: number;
  readonly synthesisRunning: boolean;
  readonly patchPrepared: boolean;
}

export function projectDream(batch: DreamBatch): DreamProjection {
  const reviewedScopeCount = batch.extractionScopes.filter((scope) => ["approved", "skipped", "keep_pending"].includes(scope.status)).length;
  const reviewedProposalCount = batch.synthesis?.proposals.filter((proposal) => proposal.status !== "pending").length ?? 0;
  const proposalCount = batch.synthesis?.proposals.length ?? 0;
  const patchPrepared = batch.preparedPatch?.status === "prepared";
  const synthesisRunning = batch.status === "running" && batch.currentStage === "global_synthesis";
  const phase: DreamPrimaryPhase = patchPrepared || batch.status === "patch_pending" ? "commit" : batch.synthesis !== undefined || synthesisRunning || reviewedScopeCount === batch.extractionScopes.length ? "review" : "collect";
  return {
    phase,
    scopeCount: batch.extractionScopes.length,
    reviewedScopeCount,
    proposalCount,
    reviewedProposalCount,
    partialCoverage: batch.partialCoverageScopeIds.length > 0,
    unresolvedPriorPeriodCount: batch.carryoverInputs.length,
    synthesisRunning,
    patchPrepared
  };
}
