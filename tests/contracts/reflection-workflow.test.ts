import { describe, expect, it } from "vitest";
import { REFLECTION_LEGACY_STATE_MAP, REFLECTION_LEGACY_STATUSES, projectReflectionWorkflow } from "@vc-agent/contracts";

describe("Reflection workflow projection", () => {
  it("maps every legacy status to an orthogonal stage and execution state", () => {
    expect(REFLECTION_LEGACY_STATUSES).toHaveLength(11);
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
});
