import { describe, expect, it } from "vitest";
import {
  REFLECTION_LEGACY_STATE_MAP,
  REFLECTION_LEGACY_STATUSES,
  projectReflectionWorkflow,
  reflectionCompletionTransition,
  reflectionLaunchTransition
} from "@vc-agent/contracts";

describe("Reflection workflow projection", () => {
  it("maps every legacy status to an orthogonal stage and execution state", () => {
    expect(REFLECTION_LEGACY_STATUSES).toHaveLength(12);
    for (const status of REFLECTION_LEGACY_STATUSES) {
      const mapped = REFLECTION_LEGACY_STATE_MAP[status];
      expect(mapped.stage).toBeTruthy();
      expect(mapped.executionState).toBeTruthy();
      expect(projectReflectionWorkflow({ status, assessmentAvailable: status === "independent_completed" || status === "dialogue_active" }).stage).toBe(mapped.stage);
    }
  });

  it("keeps failure and interruption recovery visible without activating dialogue", () => {
    const failed = projectReflectionWorkflow({ status: "independent_failed", assessmentAvailable: false, failureCode: "PROVIDER_REJECTED" });
    expect(failed).toMatchObject({ stage: "independent_evidence", executionState: "failed", recoveryAction: "retry_evidence" });
    expect(failed.label).toContain("PROVIDER_REJECTED");

    const interrupted = projectReflectionWorkflow({ status: "memory_aware_interrupted", assessmentAvailable: true, pauseReason: "application_restart" });
    expect(interrupted).toMatchObject({ stage: "critical_dialogue", executionState: "paused", pauseReason: "application_restart", recoveryAction: "resume_dialogue" });
    expect(interrupted.actions).not.toContain("prepare_outcomes");
  });

  it("authorizes one isolated evidence launch only when a Reflection Profile is frozen", () => {
    expect(reflectionLaunchTransition({ profileId: "reflection-profile" })).toEqual({
      action: "start_independent",
      profileId: "reflection-profile",
      isolated: true
    });
    expect(reflectionLaunchTransition({})).toEqual({ action: "idle", reason: "profile_missing" });
    expect(projectReflectionWorkflow({ status: "awaiting_profile", assessmentAvailable: false }).actions).toEqual(["configure"]);
  });

  it("hands only the bounded assessment and frozen brief to the next isolated stage", () => {
    expect(reflectionCompletionTransition({
      status: "independent_completed",
      independentProfileId: "reflection-profile",
      assessmentAvailable: true,
      frozenBriefAvailable: true,
      frozenPromptSnapshotAvailable: true
    })).toEqual({
      action: "start_memory_aware",
      profileId: "reflection-profile",
      isolated: true,
      handoff: {
        source: "bounded_independent_assessment",
        brief: "frozen",
        promptSnapshot: "frozen",
        inheritIndependentContext: false
      }
    });
    expect(reflectionCompletionTransition({
      status: "independent_failed",
      independentProfileId: "reflection-profile",
      assessmentAvailable: true,
      frozenBriefAvailable: true,
      frozenPromptSnapshotAvailable: true
    })).toEqual({ action: "none", reason: "failed" });
    expect(reflectionCompletionTransition({
      status: "independent_interrupted",
      independentProfileId: "reflection-profile",
      assessmentAvailable: true,
      frozenBriefAvailable: true,
      frozenPromptSnapshotAvailable: true
    })).toEqual({ action: "none", reason: "interrupted" });
    expect(reflectionCompletionTransition({
      status: "independent_completed",
      assessmentAvailable: true,
      frozenBriefAvailable: true,
      frozenPromptSnapshotAvailable: true
    })).toEqual({ action: "idle", reason: "profile_missing" });
  });

  it("keeps a completed assessment locally resumable until second-stage admission is proven", () => {
    const projection = projectReflectionWorkflow({ status: "independent_completed", assessmentAvailable: true });
    expect(projection).toMatchObject({ stage: "critical_dialogue", executionState: "idle" });
    expect(projection.actions).toContain("start_dialogue");
  });
});
