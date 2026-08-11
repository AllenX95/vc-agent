import type { AutoMemoryReviewPolicy } from "@vc-agent/contracts";

/** Conservative opt-in defaults. A Profile and token budget are installation-specific. */
export const DEFAULT_AUTO_MEMORY_REVIEW_THRESHOLDS = {
  enabled: false,
  minEligibleExchangeCount: 20,
  maxIntervalDays: 7
} as const;

export interface AutomaticMemoryReviewInput {
  readonly policy: AutoMemoryReviewPolicy;
  readonly profileAvailable?: boolean;
  readonly activeBatch?: boolean;
  readonly bundleUnderReview?: boolean;
  readonly lastAutomaticStartAt?: string | Date;
  readonly pendingEligibleExchangeCount?: number;
  readonly explicitCandidate?: boolean;
  readonly lastReviewCompletedAt?: string | Date;
  readonly phase?: "startup" | "post_user_work";
  readonly userWorkCompletedInAppRun?: boolean;
  readonly executionIdle?: boolean;
}

export interface AutomaticMemoryReviewEvaluationOptions {
  readonly now: () => Date;
  /** IANA installation timezone used to enforce the local-day start limit. */
  readonly timeZone?: string;
}

export type AutomaticMemoryReviewDueReason = "explicit_candidate" | "pending_threshold" | "maximum_interval";
export type AutomaticMemoryReviewReason = "disabled" | "not_due" | "missing_profile" | "active_batch" | "bundle_under_review" | "daily_limit_reached" | "startup_wait" | "user_work_required" | "execution_busy" | "admitted";
export type AutomaticMemoryReviewNextAction = "enable_automatic_review" | "wait_for_due_signal" | "configure_memory_review_profile" | "wait_for_active_batch" | "wait_for_bundle_review" | "wait_for_next_local_day" | "wait_for_user_work" | "wait_for_execution_idle" | "start_memory_review";

export interface AutomaticMemoryReviewDecision {
  readonly due: boolean;
  readonly admitted: boolean;
  readonly reason: AutomaticMemoryReviewReason;
  readonly nextAction: AutomaticMemoryReviewNextAction;
  readonly dueReason?: AutomaticMemoryReviewDueReason;
}

export function evaluateAutomaticMemoryReview(
  input: AutomaticMemoryReviewInput,
  _options: AutomaticMemoryReviewEvaluationOptions
): AutomaticMemoryReviewDecision {
  if (!input.policy.enabled) {
    return { due: false, admitted: false, reason: "disabled", nextAction: "enable_automatic_review" };
  }
  const pendingCount = input.pendingEligibleExchangeCount ?? 0;
  const currentTime = _options.now();
  const dueReason: AutomaticMemoryReviewDueReason | undefined = input.explicitCandidate === true
    ? "explicit_candidate"
    : pendingCount >= input.policy.minEligibleExchangeCount
      ? "pending_threshold"
      : intervalElapsed(input.lastReviewCompletedAt, currentTime, input.policy.maxIntervalDays)
        ? "maximum_interval"
        : undefined;
  if (dueReason !== undefined) {
    if (input.profileAvailable !== true) {
      return { due: true, admitted: false, reason: "missing_profile", nextAction: "configure_memory_review_profile", dueReason };
    }
    if (input.activeBatch === true) {
      return { due: true, admitted: false, reason: "active_batch", nextAction: "wait_for_active_batch", dueReason };
    }
    if (input.bundleUnderReview === true) {
      return { due: true, admitted: false, reason: "bundle_under_review", nextAction: "wait_for_bundle_review", dueReason };
    }
    if (sameLocalDay(input.lastAutomaticStartAt, currentTime, _options.timeZone)) {
      return { due: true, admitted: false, reason: "daily_limit_reached", nextAction: "wait_for_next_local_day", dueReason };
    }
    if (input.phase !== "post_user_work") {
      return { due: true, admitted: false, reason: "startup_wait", nextAction: "wait_for_user_work", dueReason };
    }
    const userWorkCompleted = input.userWorkCompletedInAppRun ?? input.phase === "post_user_work";
    if (!userWorkCompleted) {
      return { due: true, admitted: false, reason: "user_work_required", nextAction: "wait_for_user_work", dueReason };
    }
    if (input.executionIdle !== true) {
      return { due: true, admitted: false, reason: "execution_busy", nextAction: "wait_for_execution_idle", dueReason };
    }
    return { due: true, admitted: true, reason: "admitted", nextAction: "start_memory_review", dueReason };
  }
  return { due: false, admitted: false, reason: "not_due", nextAction: "wait_for_due_signal" };
}

function sameLocalDay(previousStart: string | Date | undefined, now: Date, timeZone?: string): boolean {
  if (previousStart === undefined) return false;
  const previous = previousStart instanceof Date ? previousStart : new Date(previousStart);
  if (!Number.isFinite(previous.valueOf()) || !Number.isFinite(now.valueOf())) return false;
  const previousDay = localDayParts(previous, timeZone);
  const currentDay = localDayParts(now, timeZone);
  return previousDay.year === currentDay.year && previousDay.month === currentDay.month && previousDay.day === currentDay.day;
}

function localDayParts(value: Date, timeZone?: string): { readonly year: number; readonly month: number; readonly day: number } {
  if (timeZone === undefined) return { year: value.getFullYear(), month: value.getMonth(), day: value.getDate() };
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
    const year = Number(parts.find((part) => part.type === "year")?.value);
    const month = Number(parts.find((part) => part.type === "month")?.value);
    const day = Number(parts.find((part) => part.type === "day")?.value);
    if ([year, month, day].every(Number.isFinite)) return { year, month, day };
  } catch {
    // An invalid timezone should not make a model-free due check crash. The
    // installation's local timezone remains the safe deterministic fallback.
  }
  return { year: value.getFullYear(), month: value.getMonth(), day: value.getDate() };
}

function intervalElapsed(lastReviewCompletedAt: string | Date | undefined, now: Date, maxIntervalDays: number): boolean {
  if (lastReviewCompletedAt === undefined) return false;
  const baseline = lastReviewCompletedAt instanceof Date ? lastReviewCompletedAt : new Date(lastReviewCompletedAt);
  const baselineMs = baseline.valueOf();
  const nowMs = now.valueOf();
  if (!Number.isFinite(baselineMs) || !Number.isFinite(nowMs)) return false;
  return nowMs >= baselineMs + maxIntervalDays * 24 * 60 * 60 * 1_000;
}
