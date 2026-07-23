import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctorIsActivationFree, inspectEnvironmentDoctor, writeIntegrationGateReport } from "@vc-agent/host-services";

describe("Integration Gate report", () => {
  it("writes sanitized JSON/Markdown evidence and keeps unavailable Personal Build work blocked", () => {
    const outputRoot = join(process.cwd(), "test-results", "integration-gate-test");
    rmSync(outputRoot, { recursive: true, force: true });
    const doctor = inspectEnvironmentDoctor({
      piAdapter: { status: "ready", message: "Bundled adapter available." },
      profiles: { status: "attention", message: "No Profile is configured." },
      credentialReferences: { status: "ready", message: "Protected credential references are configured." },
      storage: { status: "ready", message: "Local storage is writable." },
      migration: { status: "ready", message: "Schema is supported." },
      scheduler: { status: "ready", message: "Bounded capacity is available." },
      agentRuntime: { status: "ready", message: "Worker supervisor is available." },
      utilityRuntime: { status: "ready", message: "Utility runtime is available." },
      isolatedRuntime: { status: "ready", message: "Isolated job runtime is available." },
      skills: { status: "ready", message: "Skills inventory is local and disabled by default." },
      office: { status: "unavailable", message: "No real User-supplied Office Skill was configured." },
      ocr: { status: "attention", message: "Optional local OCR dependencies are not installed." },
      mcp: { status: "ready", message: "Pinned adapter is available; no server was connected." },
      extensionRevision: { status: "ready", message: "Global Extension revision is empty and dormant." },
      backup: { status: "ready", message: "Backup status is inspectable." }
    });
    expect(doctorIsActivationFree(doctor)).toBe(true);
    const artifacts = writeIntegrationGateReport(outputRoot, {
      buildIdentity: { applicationVersion: "0.1.0", stateSchemaVersion: 1 },
      environmentDoctor: doctor,
      scenarios: [
        { testId: "G3-T-001", scenario: "Project and Unscoped runtime fixture", status: "pass", durationMs: 4, evidencePath: join(outputRoot, "evidence", "runtime.json") },
        { testId: "G3-T-003", scenario: "Skill Creator staged handoff", status: "pass", durationMs: 3, evidencePath: join(outputRoot, "evidence", "creator.json") },
        { testId: "G3-T-004", scenario: "Mixed PDF page recovery", status: "pass", durationMs: 2 },
        { testId: "G3-T-005", scenario: "Lazy MCP read/write/failure fixture", status: "pass", durationMs: 2 },
        { testId: "G3-T-006", scenario: "Extension admission and revision fixture", status: "pass", durationMs: 3 },
        { testId: "G3-T-011", scenario: "Personal Build real Office Skill", status: "blocked", durationMs: 0, warning: "Requires an explicit User-supplied package and dependency run." }
      ],
      migrationVersions: [1],
      unavailableDependencies: ["Personal Build Office Skill package"],
      deferredScope: ["Delegation and Hardening remain unavailable."],
      evidenceRoot: outputRoot,
      secretScanInputs: ["sanitized credential reference only"]
    });
    expect(artifacts.report.decision).toBe("blocked");
    expect(artifacts.report.zeroSecretScan.passed).toBe(true);
    expect(readFileSync(artifacts.jsonPath, "utf8")).not.toContain("secret-value");
    expect(readFileSync(artifacts.jsonPath, "utf8")).not.toContain(outputRoot);
    expect(existsSync(artifacts.markdownPath)).toBe(true);
  });
});
