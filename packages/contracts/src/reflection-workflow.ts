export const REFLECTION_LEGACY_STATUSES = [
  "awaiting_profile",
  "ready",
  "independent_running",
  "independent_completed",
  "independent_failed",
  "independent_interrupted",
  "memory_aware_running",
  "dialogue_active",
  "memory_aware_failed",
  "memory_aware_interrupted",
  "discarded"
] as const;

export type ReflectionLegacyStatus = typeof REFLECTION_LEGACY_STATUSES[number];
export type ReflectionStage = "configuration" | "independent_evidence" | "critical_dialogue" | "completed" | "discarded";
export type ReflectionExecutionState = "idle" | "running" | "paused" | "failed";
export type ReflectionPauseReason = "user_stop" | "application_restart" | "configuration";

export interface ReflectionWorkflowState {
  readonly stage: ReflectionStage;
  readonly executionState: ReflectionExecutionState;
  readonly pauseReason?: ReflectionPauseReason;
}

export interface ReflectionWorkflowProjection extends ReflectionWorkflowState {
  readonly label: string;
  readonly actions: readonly ("configure" | "start_evidence" | "retry_evidence" | "stop_evidence" | "resume_evidence" | "start_dialogue" | "retry_dialogue" | "resume_dialogue" | "prepare_outcomes" | "discard")[];
  readonly evidenceAvailable: boolean;
  readonly recoveryAction?: "configure" | "retry_evidence" | "retry_dialogue" | "resume_evidence" | "resume_dialogue";
}

export interface ReflectionWorkflowInput {
  readonly status: ReflectionLegacyStatus;
  readonly assessmentAvailable: boolean;
  readonly failureCode?: string;
  readonly pauseReason?: ReflectionPauseReason;
}

export const REFLECTION_LEGACY_STATE_MAP: Readonly<Record<ReflectionLegacyStatus, ReflectionWorkflowState>> = Object.freeze({
  awaiting_profile: { stage: "configuration", executionState: "paused", pauseReason: "configuration" },
  ready: { stage: "independent_evidence", executionState: "idle" },
  independent_running: { stage: "independent_evidence", executionState: "running" },
  independent_completed: { stage: "critical_dialogue", executionState: "idle" },
  independent_failed: { stage: "independent_evidence", executionState: "failed" },
  independent_interrupted: { stage: "independent_evidence", executionState: "paused", pauseReason: "user_stop" },
  memory_aware_running: { stage: "critical_dialogue", executionState: "running" },
  dialogue_active: { stage: "critical_dialogue", executionState: "idle" },
  memory_aware_failed: { stage: "critical_dialogue", executionState: "failed" },
  memory_aware_interrupted: { stage: "critical_dialogue", executionState: "paused", pauseReason: "user_stop" },
  discarded: { stage: "discarded", executionState: "idle" }
});

export function reflectionWorkflowState(input: Pick<ReflectionWorkflowInput, "status" | "pauseReason">): ReflectionWorkflowState {
  const base = REFLECTION_LEGACY_STATE_MAP[input.status];
  if (base.executionState !== "paused" || input.pauseReason === undefined) return base;
  return { ...base, pauseReason: input.pauseReason };
}

export function projectReflectionWorkflow(input: ReflectionWorkflowInput): ReflectionWorkflowProjection {
  const state = reflectionWorkflowState(input);
  const actions: Array<ReflectionWorkflowProjection["actions"][number]> = [];
  let recoveryAction: ReflectionWorkflowProjection["recoveryAction"];
  if (state.stage === "configuration") {
    // Profile configuration is the visible gate, but once a profile is
    // selected the next authorized action is still the independent pass.
    actions.push("configure", "start_evidence");
    recoveryAction = "configure";
  } else if (state.stage === "independent_evidence") {
    if (state.executionState === "running") actions.push("stop_evidence");
    else if (state.executionState === "failed") { actions.push("retry_evidence", "discard"); recoveryAction = "retry_evidence"; }
    else if (state.executionState === "paused") { actions.push("resume_evidence", "discard"); recoveryAction = "resume_evidence"; }
    else actions.push("start_evidence");
  } else if (state.stage === "critical_dialogue") {
    if (state.executionState === "running") actions.push("stop_evidence");
    else if (state.executionState === "failed") { actions.push("retry_dialogue", "discard"); recoveryAction = "retry_dialogue"; }
    else if (state.executionState === "paused") { actions.push("resume_dialogue", "discard"); recoveryAction = "resume_dialogue"; }
    else if (input.status === "dialogue_active") actions.push("prepare_outcomes", "discard");
    else actions.push("start_dialogue", "discard");
  }
  const label = reflectionWorkflowLabel(input, state);
  return {
    ...state,
    label,
    actions,
    evidenceAvailable: input.assessmentAvailable,
    ...(recoveryAction === undefined ? {} : { recoveryAction })
  };
}

function reflectionWorkflowLabel(input: ReflectionWorkflowInput, state: ReflectionWorkflowState): string {
  if (input.status === "awaiting_profile") return "Awaiting profile";
  if (input.status === "ready") return "Ready for evidence";
  if (input.status === "independent_running") return "Analyzing evidence";
  if (input.status === "independent_completed") return "Evidence pass complete";
  if (input.status === "independent_failed") return `Evidence pass failed${input.failureCode === undefined ? "" : ` · ${input.failureCode}`}`;
  if (input.status === "independent_interrupted") return state.pauseReason === "application_restart" ? "Evidence pass paused after restart" : "Evidence pass paused";
  if (input.status === "memory_aware_running") return "Starting critical dialogue";
  if (input.status === "dialogue_active") return "Reflection dialogue";
  if (input.status === "memory_aware_failed") return `Dialogue start failed${input.failureCode === undefined ? "" : ` · ${input.failureCode}`}`;
  if (input.status === "memory_aware_interrupted") return state.pauseReason === "application_restart" ? "Dialogue paused after restart" : "Dialogue paused";
  return "Discarded";
}
