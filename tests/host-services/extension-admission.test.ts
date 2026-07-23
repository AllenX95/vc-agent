import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { BoundedExecutionScheduler, ExtensionAdmissionError, ExtensionAdmissionManager, GlobalExtensionRevisionManager, type ExtensionAuditAdapter, type ExtensionAuditResult, type ExtensionAuditInput, type ExecutionSchedulerStore } from "@vc-agent/host-services";

function schedulerStore(): ExecutionSchedulerStore {
  const leases = new Map<string, { id: string; scopeKey: string; kind: "extension_audit"; acquiredAt: string }>();
  return {
    listExecutionLeases: () => [...leases.values()],
    acquireExecutionLease: (input) => { const lease = { ...input, acquiredAt: new Date().toISOString() } as { id: string; scopeKey: string; kind: "extension_audit"; acquiredAt: string }; leases.set(lease.id, lease); return lease; },
    releaseExecutionLease: (id) => leases.delete(id),
    listExecutionQueue: () => []
  };
}

function fixture(root: string, name = "fixture-extension") {
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js", scripts: { preinstall: "node marker.js" }, permissions: ["network"], license: "MIT" }), "utf8");
  writeFileSync(join(source, "package-lock.json"), JSON.stringify({ name, lockfileVersion: 3, packages: {} }), "utf8");
  writeFileSync(join(source, "index.js"), "module.exports = { fixture: true };", "utf8");
  writeFileSync(join(source, "marker.js"), "throw new Error('must never execute');", "utf8");
  return source;
}

describe("Extension admission and global revision", () => {
  it("stages without executing, inspects deterministically, audits in isolation, and keeps approval separate from enablement", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-extension-"));
    try {
      const scheduler = new BoundedExecutionScheduler({ capacity: 1, store: schedulerStore() });
      let auditInput: ExtensionAuditInput | undefined;
      const auditAdapter: ExtensionAuditAdapter = { review: async (input) => { auditInput = input; return { summary: "reviewed", findings: [], residualRisk: ["direct process authority"], limitations: ["transitive source was not model reviewed"] }; } };
      const admission = new ExtensionAdmissionManager({ root: join(root, "admission"), scheduler, auditAdapter });
      const staged = await admission.stage({ sourcePath: fixture(root) });
      expect(readFileSync(join(staged.stagedPath, "marker.js"), "utf8")).toContain("must never execute");
      const report = await admission.inspect(staged.stagedRevisionId);
      expect(report.status).toBe("reviewable");
      expect(report.lifecycleScripts).toEqual(["preinstall"]);
      expect(report.artifactHash).toMatch(/^[a-f0-9]{64}$/u);
      const audit = await admission.startAudit({ stagedRevisionId: staged.stagedRevisionId, profileId: "audit-profile" });
      expect(audit.status).toBe("audit_complete");
      expect(auditInput?.deterministicReport.reportId).toBe(report.reportId);
      expect(auditInput?.stagedArtifactPath).toBe(staged.stagedPath);
      const approved = await admission.approve({ stagedRevisionId: staged.stagedRevisionId, reportId: report.reportId, expectedArtifactHash: report.artifactHash, acceptedFindingIds: ["lifecycle-scripts", "requested-permissions"], userConfirmed: true });
      expect(approved.enabled).toBe(false);
      const global = new GlobalExtensionRevisionManager({ root: join(root, "global"), admission });
      const pending = await global.propose({ action: "enable", extensionId: approved.extensionId, approvedRevisionId: approved.approvedRevisionId });
      expect(global.snapshot().effectiveExtensions).toEqual([]);
      await global.activateWhenIdle(pending.revisionId);
      expect(global.snapshot().effectiveExtensions[0]?.approvedRevisionId).toBe(approved.approvedRevisionId);
      expect(global.runtimeSnapshot().enabled[0]?.trust).toBe("approved-trusted");
      expect(global.runtimeSnapshot().revisionId).toBe(pending.revisionId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks incomplete identity/closure, preserves audit failure, and invalidates changed approved bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-extension-"));
    try {
      const source = join(root, "blocked");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "package.json"), JSON.stringify({ name: "blocked-extension", version: "1.0.0", main: "index.js" }), "utf8");
      writeFileSync(join(source, "index.js"), "module.exports = true;", "utf8");
      const admission = new ExtensionAdmissionManager({ root: join(root, "admission"), auditAdapter: { review: async (): Promise<ExtensionAuditResult> => { throw new Error("provider unavailable"); } } });
      const staged = await admission.stage({ sourcePath: source });
      const report = await admission.inspect(staged.stagedRevisionId);
      expect(report.blockers).toContain("EXTENSION_DEPENDENCY_UNRESOLVED");
      const audit = await admission.startAudit({ stagedRevisionId: staged.stagedRevisionId, profileId: "audit-profile" });
      expect(audit.status).toBe("audit_failed");
      expect(admission.getReport(report.reportId)?.blockers).toContain("EXTENSION_DEPENDENCY_UNRESOLVED");
      await expect(admission.approve({ stagedRevisionId: staged.stagedRevisionId, reportId: report.reportId, expectedArtifactHash: report.artifactHash, userConfirmed: true })).rejects.toMatchObject({ code: "EXTENSION_ADMISSION_BLOCKED" });

      const goodSource = fixture(root, "good-extension");
      const good = await admission.stage({ sourcePath: goodSource });
      const goodReport = await admission.inspect(good.stagedRevisionId);
      const approved = await admission.approve({ stagedRevisionId: good.stagedRevisionId, reportId: goodReport.reportId, expectedArtifactHash: goodReport.artifactHash, acceptedFindingIds: ["lifecycle-scripts", "requested-permissions"], userConfirmed: true });
      writeFileSync(join(approved.approvedPath, "index.js"), "module.exports = false;", "utf8");
      expect(admission.invalidateChanged()).toContain(approved.approvedRevisionId);
      expect(() => admission.assertApprovedRuntimeIdentity(approved.approvedRevisionId)).toThrowError(new ExtensionAdmissionError("EXTENSION_NOT_APPROVED", "The Extension revision is not approved for runtime loading."));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds one pending global revision at idle, interrupts immediately without replay, and rolls back retained bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-extension-"));
    try {
      const admission = new ExtensionAdmissionManager({ root: join(root, "admission") });
      const source = fixture(root, "rollback-extension");
      const first = await admission.stage({ sourcePath: source });
      const firstReport = await admission.inspect(first.stagedRevisionId);
      const approvedFirst = await admission.approve({ stagedRevisionId: first.stagedRevisionId, reportId: firstReport.reportId, expectedArtifactHash: firstReport.artifactHash, acceptedFindingIds: ["lifecycle-scripts", "requested-permissions"], userConfirmed: true });
      let idle = false;
      let interrupted = 0;
      let terminated = 0;
      const global = new GlobalExtensionRevisionManager({ root: join(root, "global"), admission, isGloballyIdle: () => idle, interruptAndCheckpoint: () => { interrupted += 1; }, terminateWorkers: () => { terminated += 1; } });
      const pending = await global.propose({ action: "enable", extensionId: approvedFirst.extensionId, approvedRevisionId: approvedFirst.approvedRevisionId });
      await global.activateWhenIdle(pending.revisionId);
      expect(global.snapshot().pending?.status).toBe("waiting_for_global_idle");
      idle = true;
      await global.activateWhenIdle(pending.revisionId);
      expect(terminated).toBe(1);
      const disable = await global.propose({ action: "disable", extensionId: approvedFirst.extensionId });
      await global.activateImmediately(disable.revisionId);
      expect(interrupted).toBe(1);
      expect(terminated).toBe(2);
      expect(global.snapshot().effectiveExtensions).toEqual([]);
      const rollback = await global.rollback(approvedFirst.approvedRevisionId);
      await global.activateWhenIdle(rollback.revisionId);
      expect(global.snapshot().effectiveExtensions[0]?.approvedRevisionId).toBe(approvedFirst.approvedRevisionId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
