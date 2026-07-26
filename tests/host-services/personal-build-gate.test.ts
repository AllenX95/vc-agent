import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectPackagedLifecycleEvidence, writePersonalBuildGateReport } from "@vc-agent/host-services";

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

  it("accepts only complete external packaged lifecycle metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "vc-agent-packaged-evidence-"));
    try {
      const path = join(root, "h1.json");
      await writeFile(path, JSON.stringify({
        schemaVersion: 1,
        sanitized: true,
        kind: "h1-packaged-compatibility",
        buildIdentity: { applicationVersion: "0.1.0", stateSchemaVersion: 14 },
        runner: { mode: "playwright-electron", status: "ready" },
        workflows: ["process-tree", "external-edit", "backup-restore", "single-instance"],
        results: ["process-tree", "external-edit", "backup-restore", "single-instance"].map((workflow) => ({ workflow, status: "passed" })),
        testCount: 4
      }));
      expect(inspectPackagedLifecycleEvidence({ path, repositoryRoot: process.cwd() })).toMatchObject({ valid: true, evidencePath: "external/h1/packaged-lifecycle.json" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
