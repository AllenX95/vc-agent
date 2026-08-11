import { describe, expect, it } from "vitest";
import type { AutoMemoryReviewPolicy } from "@vc-agent/contracts";
import { evaluateAutomaticMemoryReview } from "../../../packages/host-services/src/cognition-review/automatic-review.js";

const now = "2026-08-11T10:00:00.000Z";

const policy = (overrides: Partial<AutoMemoryReviewPolicy> = {}): AutoMemoryReviewPolicy => ({
  enabled: true,
  profileId: "memory-profile",
  minEligibleExchangeCount: 20,
  maxIntervalDays: 7,
  maxInputTokensPerRun: 10_000,
  ...overrides
});

describe("automatic Memory Review policy", () => {
  it("does not become due when standing opt-in is disabled", () => {
    const decision = evaluateAutomaticMemoryReview({
      policy: policy({ enabled: false }),
      pendingEligibleExchangeCount: 100,
      explicitCandidate: true,
      phase: "post_user_work",
      userWorkCompletedInAppRun: true,
      executionIdle: true
    }, { now: () => new Date(now) });

    expect(decision).toMatchObject({
      due: false,
      admitted: false,
      reason: "disabled",
      nextAction: "enable_automatic_review"
    });
  });

  it("surfaces due state but does not admit work when the profile is missing", () => {
    const decision = evaluateAutomaticMemoryReview({
      policy: policy(),
      pendingEligibleExchangeCount: 20,
      phase: "post_user_work",
      userWorkCompletedInAppRun: true,
      executionIdle: true
    }, { now: () => new Date(now) });

    expect(decision).toMatchObject({
      due: true,
      admitted: false,
      reason: "missing_profile",
      nextAction: "configure_memory_review_profile",
      dueReason: "pending_threshold"
    });
  });

  it("admits threshold-triggered review after user work completes and execution is idle", () => {
    const decision = evaluateAutomaticMemoryReview({
      policy: policy(),
      profileAvailable: true,
      pendingEligibleExchangeCount: 20,
      phase: "post_user_work",
      userWorkCompletedInAppRun: true,
      executionIdle: true
    }, { now: () => new Date(now) });

    expect(decision).toMatchObject({
      due: true,
      admitted: true,
      reason: "admitted",
      nextAction: "start_memory_review",
      dueReason: "pending_threshold"
    });
  });

  it("admits an explicit candidate even below the pending-count threshold", () => {
    const decision = evaluateAutomaticMemoryReview({
      policy: policy(),
      profileAvailable: true,
      pendingEligibleExchangeCount: 1,
      explicitCandidate: true,
      phase: "post_user_work",
      userWorkCompletedInAppRun: true,
      executionIdle: true
    }, { now: () => new Date(now) });

    expect(decision).toMatchObject({
      due: true,
      admitted: true,
      reason: "admitted",
      nextAction: "start_memory_review",
      dueReason: "explicit_candidate"
    });
  });

  it("uses the maximum interval as a fallback due signal", () => {
    const decision = evaluateAutomaticMemoryReview({
      policy: policy(),
      profileAvailable: true,
      pendingEligibleExchangeCount: 0,
      lastReviewCompletedAt: "2026-08-03T09:59:59.000Z",
      phase: "post_user_work",
      userWorkCompletedInAppRun: true,
      executionIdle: true
    }, { now: () => new Date(now) });

    expect(decision).toMatchObject({
      due: true,
      admitted: true,
      reason: "admitted",
      nextAction: "start_memory_review",
      dueReason: "maximum_interval"
    });
  });

  it("reports startup due state without admitting a Provider run", () => {
    const decision = evaluateAutomaticMemoryReview({
      policy: policy(),
      profileAvailable: true,
      pendingEligibleExchangeCount: 0,
      lastReviewCompletedAt: "2026-08-03T09:59:59.000Z",
      phase: "startup",
      executionIdle: true
    }, { now: () => new Date(now) });

    expect(decision).toMatchObject({
      due: true,
      admitted: false,
      reason: "startup_wait",
      nextAction: "wait_for_user_work",
      dueReason: "maximum_interval"
    });
  });

  it("waits for idle execution capacity instead of preempting active work", () => {
    const decision = evaluateAutomaticMemoryReview({
      policy: policy(),
      profileAvailable: true,
      pendingEligibleExchangeCount: 20,
      phase: "post_user_work",
      userWorkCompletedInAppRun: true,
      executionIdle: false
    }, { now: () => new Date(now) });

    expect(decision).toMatchObject({
      due: true,
      admitted: false,
      reason: "execution_busy",
      nextAction: "wait_for_execution_idle",
      dueReason: "pending_threshold"
    });
  });

  it("does not admit a second run while a Memory Review batch is active", () => {
    const decision = evaluateAutomaticMemoryReview({
      policy: policy(),
      profileAvailable: true,
      pendingEligibleExchangeCount: 20,
      activeBatch: true,
      phase: "post_user_work",
      userWorkCompletedInAppRun: true,
      executionIdle: true
    }, { now: () => new Date(now) });

    expect(decision).toMatchObject({
      due: true,
      admitted: false,
      reason: "active_batch",
      nextAction: "wait_for_active_batch",
      dueReason: "pending_threshold"
    });
  });

  it("waits while any Cognition Review bundle is under review", () => {
    const decision = evaluateAutomaticMemoryReview({
      policy: policy(),
      profileAvailable: true,
      pendingEligibleExchangeCount: 20,
      bundleUnderReview: true,
      phase: "post_user_work",
      userWorkCompletedInAppRun: true,
      executionIdle: true
    }, { now: () => new Date(now) });

    expect(decision).toMatchObject({
      due: true,
      admitted: false,
      reason: "bundle_under_review",
      nextAction: "wait_for_bundle_review",
      dueReason: "pending_threshold"
    });
  });

  it("limits automatic admission to one start per local day", () => {
    const decision = evaluateAutomaticMemoryReview({
      policy: policy(),
      profileAvailable: true,
      pendingEligibleExchangeCount: 20,
      lastAutomaticStartAt: "2026-08-11T08:00:00.000Z",
      phase: "post_user_work",
      userWorkCompletedInAppRun: true,
      executionIdle: true
    }, { now: () => new Date(now) });

    expect(decision).toMatchObject({
      due: true,
      admitted: false,
      reason: "daily_limit_reached",
      nextAction: "wait_for_next_local_day",
      dueReason: "pending_threshold"
    });
  });

  it("uses the installation timezone for the daily limit", () => {
    const decision = evaluateAutomaticMemoryReview({
      policy: policy(),
      profileAvailable: true,
      pendingEligibleExchangeCount: 20,
      lastAutomaticStartAt: "2026-08-11T06:30:00.000Z", // Aug 10 23:30 in America/Los_Angeles
      phase: "post_user_work",
      userWorkCompletedInAppRun: true,
      executionIdle: true
    }, { now: () => new Date("2026-08-11T07:30:00.000Z"), timeZone: "America/Los_Angeles" }); // Aug 11 00:30 local

    expect(decision).toMatchObject({ admitted: true, reason: "admitted", nextAction: "start_memory_review" });
  });
});
