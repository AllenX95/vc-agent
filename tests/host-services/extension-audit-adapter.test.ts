import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopExtensionAuditAdapter } from "../../apps/desktop/src/main/integration-adapters";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Desktop Extension Audit adapter", () => {
  it("uses the isolated Agent Worker executor with a bounded snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-extension-audit-adapter-"));
    roots.push(root);
    writeFileSync(join(root, "index.js"), "module.exports = {};", "utf8");
    let execution: Parameters<NonNullable<Parameters<typeof createDesktopExtensionAuditAdapter>[0]["executeAudit"]>>[0] | undefined;
    const adapter = createDesktopExtensionAuditAdapter({
      fixtureMode: false,
      resolveProfile: () => ({ provider: "fixture", model: "audit-model", apiKey: "credential-value", thinkingLevel: "off" }),
      executeAudit: async (input) => {
        execution = input;
        return JSON.stringify({
          summary: "Bounded review complete.",
          findings: [{ severity: "low", message: "No material issue found in the bounded snapshot." }],
          residualRisk: ["Runtime behavior remains trusted worker code."],
          limitations: ["Only supplied files were reviewed."]
        });
      }
    });
    const result = await adapter.review({
      auditRunId: "audit-1",
      stagedRevisionId: "staged-1",
      profileId: "profile-1",
      stagedArtifactPath: root,
      instructionsRevision: "extension-audit-v1",
      deterministicReport: {
        schemaVersion: 1,
        reportId: "report-1",
        stagedRevisionId: "staged-1",
        artifactHash: "a".repeat(64),
        dependencyClosureHash: "b".repeat(64),
        identity: { extensionId: "fixture-extension", name: "Fixture Extension", version: "1.0.0" },
        files: [],
        entryPoints: ["index.js"],
        lifecycleScripts: [],
        nativeBinaries: [],
        requestedPermissions: [],
        licenses: ["MIT"],
        vulnerabilities: [],
        findings: [],
        blockers: [],
        gaps: [],
        status: "reviewable",
        generatedAt: new Date().toISOString()
      }
    }, new AbortController().signal);

    expect(result.summary).toBe("Bounded review complete.");
    expect(execution?.profile).toMatchObject({ provider: "fixture", model: "audit-model", thinkingLevel: "off" });
    expect(execution?.systemPrompt).toContain("Do not assume access to Projects");
    expect(execution?.prompt).toContain("\"extensionSnapshot\"");
    expect(execution?.prompt).toContain("module.exports");
    expect(execution?.prompt).not.toContain("credential-value");
  });
});
