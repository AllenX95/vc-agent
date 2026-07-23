import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writePersonalBuildGateReport } from "@vc-agent/host-services";

describe("personal build gate report", () => {
  it("writes the five execution modes, matrix and sanitized evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "vc-agent-personal-build-report-"));
    const artifacts = writePersonalBuildGateReport(root, {
      buildIdentity: { applicationVersion: "0.1.0", stateSchemaVersion: 14 }, migrationVersions: [1, 14], evidenceRoot: root,
      dependencyInventory: [{ name: "fixture", status: "ready", version: "v1" }],
      environmentDoctor: { storage: { status: "ready", message: "Credential references only." } },
      scenarios: [
        { testId: "H1-S-001", suite: "Clean", mode: "deterministic", status: "pass", durationMs: 1 },
        { testId: "H1-S-004", suite: "Real", mode: "real_dependency", status: "blocked", durationMs: 1, warning: "BLOCKED: external evidence missing" }
      ],
      executionModes: {
        deterministic: { status: "pass", scenarioIds: ["H1-S-001"] }, real_dependency: { status: "blocked", scenarioIds: ["H1-S-004"] }, unavailable: { status: "pass", scenarioIds: [] }, migration_recovery: { status: "pass", scenarioIds: [] }, crash_cancellation: { status: "pass", scenarioIds: [] }
      },
      acceptanceMatrix: [{ criterionId: "H1-REQ-013", requirement: "Secret boundary", status: "pass", evidence: ["H1-S-001"] }],
      secretScanInputs: ["credentialRef: local-reference-only"]
    });
    expect(artifacts.report.decision).toBe("blocked");
    expect(artifacts.report.zeroSecretScan.passed).toBe(true);
    const json = await readFile(artifacts.jsonPath, "utf8");
    expect(json).not.toContain(root);
    expect(json).toContain("crash_cancellation");
    expect(json).toContain("H1-REQ-013");
  });
});
