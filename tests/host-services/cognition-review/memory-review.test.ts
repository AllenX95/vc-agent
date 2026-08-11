import { describe, expect, it, vi } from "vitest";
import type {
  CognitionDependency,
  EligibleLearningSource,
  MemoryReviewInput,
  ReviewBundle
} from "@vc-agent/contracts";
import {
  createMemoryReviewOrchestrator,
  FileMemoryReviewRunStore,
  MemoryReviewOrchestrator,
  type MemoryReviewExtractionRunner,
  type MemoryReviewPreparationInput,
  type MemoryReviewProgress,
  type MemoryReviewSynthesisRunner
} from "../../../packages/host-services/src/cognition-review/memory-review.js";
import { buildMemoryReviewChunks } from "../../../packages/host-services/src/cognition-review/chunking.js";
import type { MemoryReviewExtractionResult } from "../../../packages/host-services/src/cognition-review/memory-review-extraction.js";
import type { MemoryReviewSynthesisResult } from "../../../packages/host-services/src/cognition-review/memory-review-synthesis.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const now = "2026-08-11T10:00:00.000Z";

function source(index: number, completedAt = now): EligibleLearningSource & { readonly body: { readonly userText: string; readonly assistantText: string } } {
  return {
    sourceReference: `thread:t/turn:${index}`,
    sourceKind: "ordinary_exchange",
    scope: "unscoped",
    threadId: "t",
    turnId: `turn-${index}`,
    completedAt,
    availability: "available",
    body: { userText: `User learning signal ${index}`, assistantText: `Assistant response ${index}` }
  };
}

function extractionResult(chunk: { readonly id: string; readonly sourceReferences: readonly string[] }, status: "no_signal" | "represented" = "no_signal"): MemoryReviewExtractionResult {
  return {
    schemaVersion: 1,
    chunkId: chunk.id,
    dispositions: chunk.sourceReferences.map((sourceReference) => ({ sourceReference, status, ...(status === "represented" ? { proposalIds: [`candidate-${sourceReference}`] } : {}) })),
    candidates: status === "represented" ? chunk.sourceReferences.map((sourceReference) => ({ id: `candidate-${sourceReference}`, sourceReferences: [sourceReference], title: "A bounded candidate", summary: "A bounded candidate" })) : [],
    completedAt: now
  };
}

function fakeBundle(input: MemoryReviewInput): ReviewBundle {
  return {
    id: "review-1",
    kind: "memory_review",
    status: "reviewing",
    proposals: input.proposals ?? [],
    decisions: [],
    coverage: {
      eligibleCount: input.coverageLedger.entries.length,
      noSignalCount: input.coverageLedger.entries.filter((entry) => entry.status === "no_signal").length,
      representedCount: input.coverageLedger.entries.filter((entry) => entry.status === "represented").length,
      carriedOverCount: input.coverageLedger.entries.filter((entry) => entry.status === "carried_over").length,
      pendingCount: input.coverageLedger.entries.filter((entry) => entry.status === "pending").length,
      processingCount: input.coverageLedger.entries.filter((entry) => entry.status === "processing").length,
      complete: true
    },
    dependencies: input.dependencies ?? [],
    createdAt: now,
    updatedAt: now
  };
}

function synthesisResult(proposals: MemoryReviewSynthesisResult["proposals"] = []): MemoryReviewSynthesisResult {
  return {
    schemaVersion: 1,
    proposals,
    metadata: {
      schemaVersion: 1,
      batchReference: "memory_review_batch",
      inputHash: "a".repeat(64),
      cutoff: now,
      summary: "",
      uncertainty: "",
      coverage: { eligibleCount: 0, noSignalCount: 0, representedCount: 0, carriedOverCount: 0, pendingCount: 0, processingCount: 0, complete: true },
      scopeCount: 0,
      sourceCount: 0,
      representedSourceCount: 0,
      noSignalSourceCount: 0,
      carriedOverSourceCount: 0,
      createdAt: now
    }
  };
}

function input(overrides: Partial<MemoryReviewPreparationInput> = {}): MemoryReviewPreparationInput {
  return {
    cutoff: now,
    sources: [source(1), source(2)],
    profileSnapshot: { id: "memory-profile", provider: "fixture", model: "fixture" },
    promptSnapshot: { revisionId: "prompt-1", hash: "b".repeat(64) },
    ...overrides
  };
}

function setup(options: {
  readonly extract?: MemoryReviewExtractionRunner;
  readonly synthesize?: MemoryReviewSynthesisRunner;
  readonly progress?: (progress: MemoryReviewProgress) => void;
  readonly resolveSource?: (source: EligibleLearningSource) => { readonly userText: string; readonly assistantText: string } | undefined;
  readonly root?: string;
} = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "vc-memory-review-"));
  const extract = options.extract ?? (async ({ chunk }) => extractionResult(chunk));
  const synthesize = options.synthesize ?? (async () => synthesisResult());
  const review = { prepare: vi.fn((reviewInput: MemoryReviewInput) => fakeBundle(reviewInput)) };
  const orchestrator = new MemoryReviewOrchestrator({
    persistence: new FileMemoryReviewRunStore(join(root, "runs")),
    reviewModule: review,
    extractChunk: extract,
    synthesize,
    now: () => new Date(now),
    resolveSource: options.resolveSource,
    onProgress: options.progress
  });
  return { root, orchestrator, review, extract, synthesize };
}

describe("Memory Review orchestration", () => {
  it("factory owns run persistence and composes extraction/synthesis behind one generator", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-memory-review-factory-"));
    const review = { prepare: vi.fn((reviewInput: MemoryReviewInput) => fakeBundle(reviewInput)) };
    const stages: string[] = [];
    const snapshots: Array<{ readonly id: string; readonly provider: string; readonly model: string; readonly thinkingLevel?: string; readonly contextWindow?: number; readonly maxOutputTokens?: number }> = [];
    try {
      const orchestrator = createMemoryReviewOrchestrator({
        root,
        reviewModule: review,
        now: () => new Date(now),
        generate: (prompt, context) => {
          stages.push(context.stage);
          snapshots.push(context.profileSnapshot);
          if (context.stage === "extraction") {
            const chunkId = /"chunkId":"([^"]+)"/u.exec(prompt)?.[1];
            if (chunkId === undefined) throw new Error("factory test could not identify extraction chunk");
            return JSON.stringify({ chunkId, dispositions: [{ sourceReference: "thread:t/turn:1", status: "no_signal" }], candidates: [], completedAt: now });
          }
          return JSON.stringify({ summary: "", uncertainty: "", proposals: [] });
        }
      });
      const prepared = await orchestrator.prepare(input({ batchId: "factory-batch", sources: [source(1)], profileSnapshot: { id: "memory-profile", provider: "fixture", model: "fixture", thinkingLevel: "high", contextWindow: 64_000, maxOutputTokens: 8_000 } }));
      expect(prepared.status).toBe("waiting_for_review");
      expect(stages).toEqual(["extraction", "synthesis"]);
      expect(snapshots).toEqual([
        { id: "memory-profile", provider: "fixture", model: "fixture", thinkingLevel: "high", contextWindow: 64_000, maxOutputTokens: 8_000 },
        { id: "memory-profile", provider: "fixture", model: "fixture", thinkingLevel: "high", contextWindow: 64_000, maxOutputTokens: 8_000 }
      ]);
      expect(orchestrator.listRuns()).toHaveLength(1);
      expect(orchestrator.completeReview(prepared.reviewId!)).toMatchObject({ status: "completed", reviewId: prepared.reviewId });
      expect(orchestrator.listRuns()[0]?.status).toBe("completed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the manual path through every bounded chunk and creates one review bundle without committing", async () => {
    const progress: MemoryReviewProgress[] = [];
    const { orchestrator, review, root } = setup({ progress: (item) => progress.push(item) });
    try {
      const result = await orchestrator.prepare(input({
        sources: Array.from({ length: 13 }, (_, index) => source(index + 1)),
        chunking: { contextWindowTokens: 2_600, reservedOutputTokens: 200 }
      }));

      expect(result.status).toBe("waiting_for_review");
      expect(result.reviewId).toBe("review-1");
      expect(review.prepare).toHaveBeenCalledTimes(1);
      expect(progress.some((item) => item.status === "preparing" && item.eligible === 13)).toBe(true);
      expect(progress.at(-1)).toMatchObject({ status: "waiting_for_review", eligible: 13, processed: 13, noSignal: 13, represented: 0, carriedOver: 0 });
      expect(progress.at(-1)).not.toHaveProperty("sources");
      expect(progress.at(-1)).not.toHaveProperty("rawOutput");
      expect(readFileSync(join(root, "runs", `${result.batchId}.json`), "utf8")).not.toContain("User learning signal");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries deleted source pointers over without asking the model to disposition missing content", async () => {
    const extract = vi.fn<MemoryReviewExtractionRunner>(async ({ chunk }) => extractionResult(chunk));
    const { orchestrator, review, root } = setup({ extract });
    try {
      const deleted = { ...source(1), availability: "deleted" as const, body: undefined };
      const result = await orchestrator.prepare(input({ sources: [deleted] }));

      expect(result.status).toBe("waiting_for_review");
      expect(extract).not.toHaveBeenCalled();
      expect(result.ledger.entries).toMatchObject([{
        sourceReference: deleted.sourceReference,
        availability: "deleted",
        status: "carried_over",
        dispositionReason: "source_deleted"
      }]);
      expect(review.prepare).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the same preparation path for admitted automatic work and does not call a runner before work is complete and idle", async () => {
    const extract = vi.fn<MemoryReviewExtractionRunner>(async ({ chunk }) => extractionResult(chunk));
    const { orchestrator, root } = setup({ extract });
    try {
      const notAdmitted = await orchestrator.prepareAutomatically({
        ...input(),
        policy: { enabled: true, profileId: "memory-profile", minEligibleExchangeCount: 1, maxIntervalDays: 7, maxInputTokensPerRun: 10_000 },
        profileAvailable: true,
        pendingEligibleExchangeCount: 2,
        phase: "startup"
      });
      expect(notAdmitted.decision.admitted).toBe(false);
      expect(extract).not.toHaveBeenCalled();

      const admitted = await orchestrator.prepareAutomatically({
        ...input(),
        batchId: "automatic-batch",
        policy: { enabled: true, profileId: "memory-profile", minEligibleExchangeCount: 1, maxIntervalDays: 7, maxInputTokensPerRun: 10_000 },
        profileAvailable: true,
        pendingEligibleExchangeCount: 2,
        phase: "post_user_work",
        userWorkCompletedInAppRun: true,
        executionIdle: true
      });
      expect(admitted.decision.admitted).toBe(true);
      expect(admitted.run?.status).toBe("waiting_for_review");
      expect(extract).toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists completed chunks and resumes after a transient chunk failure without re-running completed work", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-memory-review-restart-"));
    let attempts = 0;
    const first = setup({
      root,
      extract: async ({ chunk }) => {
        attempts += 1;
        if (attempts === 2) throw new Error("provider disconnected");
        return extractionResult(chunk);
      },
      resolveSource: (item) => ({ userText: `User learning signal ${item.turnId?.replace("turn-", "") ?? ""}`, assistantText: `Assistant response ${item.turnId?.replace("turn-", "") ?? ""}` })
    });
    try {
      const failed = await first.orchestrator.prepare(input({ batchId: "restart-batch", sources: Array.from({ length: 13 }, (_, index) => source(index + 1)), chunking: { contextWindowTokens: 2_600, reservedOutputTokens: 200 } }));
      expect(failed.status).toBe("failed");
      expect(failed.failureCode).toBe("MODEL_EXECUTION_FAILED");

      const resumedCalls: string[] = [];
      const second = setup({
        root,
        extract: async ({ chunk }) => { resumedCalls.push(chunk.id); return extractionResult(chunk); },
        resolveSource: (item) => ({ userText: `User learning signal ${item.turnId?.replace("turn-", "") ?? ""}`, assistantText: `Assistant response ${item.turnId?.replace("turn-", "") ?? ""}` })
      });
      const resumed = await second.orchestrator.resume("restart-batch", { retryFailed: true });
      expect(resumed.status).toBe("waiting_for_review");
      expect(resumedCalls.length).toBeGreaterThan(0);
      expect(resumedCalls).not.toContain(failed.chunks.find((chunk) => chunk.status === "completed")?.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors cancellation only at a safe chunk boundary and never invokes synthesis", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-memory-review-cancel-"));
    let release!: () => void;
    const extractionStarted = new Promise<void>((resolve) => { release = resolve; });
    const synthesize = vi.fn<MemoryReviewSynthesisRunner>(async () => synthesisResult());
    const blockingExtract = vi.fn<MemoryReviewExtractionRunner>(async ({ chunk }) => { await extractionStarted; return extractionResult(chunk); });
    const setupResult = setup({ root, synthesize, extract: blockingExtract });
    try {
      const runPromise = setupResult.orchestrator.prepare(input({ batchId: "cancel-batch" }));
      await vi.waitFor(() => expect(setupResult.extract).toHaveBeenCalled());
      setupResult.orchestrator.cancel("cancel-batch");
      release();
      const cancelled = await runPromise;
      expect(cancelled.status).toBe("cancelled");
      expect(synthesize).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects sources after the frozen cutoff before any model runner is called", async () => {
    const extract = vi.fn<MemoryReviewExtractionRunner>(async ({ chunk }) => extractionResult(chunk));
    const { orchestrator, root } = setup({ extract });
    try {
      await expect(orchestrator.prepare(input({ sources: [source(1, "2026-08-12T00:00:00.000Z")] }))).rejects.toThrow(/cutoff/iu);
      expect(extract).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists only allowlisted Profile/Prompt identities and rejects an automatic assignment mismatch", async () => {
    const extract = vi.fn<MemoryReviewExtractionRunner>(async ({ chunk }) => extractionResult(chunk));
    const { orchestrator, root } = setup({ extract });
    try {
      await expect(orchestrator.prepare(input({ profileSnapshot: { id: "secret", provider: "fixture", model: "fixture", apiKey: "do-not-persist" } as never }))).rejects.toThrow();
      const result = await orchestrator.prepareAutomatically({
        ...input({ batchId: "mismatch" }),
        policy: { enabled: true, profileId: "different-profile", minEligibleExchangeCount: 1, maxIntervalDays: 7, maxInputTokensPerRun: 10_000 },
        profileAvailable: true,
        pendingEligibleExchangeCount: 2,
        phase: "post_user_work",
        userWorkCompletedInAppRun: true,
        executionIdle: true
      });
      expect(result.decision.reason).toBe("missing_profile");
      expect(extract).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
