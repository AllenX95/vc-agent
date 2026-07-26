import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { inspectSubAgentCompatibilityEvidence } from "@vc-agent/host-services";

describe("inspectSubAgentCompatibilityEvidence", () => {
  it("accepts the bounded sanitized Provider workflow contract", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-sub-agent-evidence-"));
    const path = join(root, "compatibility.json");
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1, sanitized: true, kind: "sub-agent-compatibility", provider: "mimo", model: "mimo-v2.5", adapter: "desktop-agent-worker-provider-v1", taskCount: 2, attemptCount: 2,
      workflows: { parallelReadOnly: true, writeOutput: true, parentAdoption: true, outputCapability: true, stopCancel: true, budgetExhaustion: true, providerFailure: true },
      usage: [{ status: "completed", totalTokens: 10 }, { status: "completed", totalTokens: 20 }], secretScan: { passed: true }
    }), "utf8");
    expect(inspectSubAgentCompatibilityEvidence({ path, repositoryRoot: join(root, "repo") }).valid).toBe(true);
  });

  it("rejects missing required workflow evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-sub-agent-evidence-invalid-"));
    const path = join(root, "compatibility.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, sanitized: true, kind: "sub-agent-compatibility", provider: "mimo", model: "mimo-v2.5", adapter: "desktop-agent-worker-provider-v1", taskCount: 2, attemptCount: 2, workflows: { parallelReadOnly: true }, usage: [], secretScan: { passed: true } }), "utf8");
    expect(inspectSubAgentCompatibilityEvidence({ path, repositoryRoot: join(root, "repo") })).toMatchObject({ valid: false });
  });
});
