import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectRealDependencyEvidence } from "@vc-agent/host-services";

function evidenceRoot(): string { return mkdtempSync(join(tmpdir(), "vc-agent-evidence-test-")); }

describe("real dependency evidence", () => {
  it("accepts complete sanitized OCR CPU/CUDA evidence", () => {
    const root = evidenceRoot();
    try {
      const path = join(root, "ocr.json");
      const result = (device: "cpu" | "cuda", iteration: number) => ({ device, iteration, durationMs: 10, textChars: 4, warnings: [] });
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, kind: "ocr-compatibility", sanitized: true, runtimeRevision: "local", validatedDevices: ["cpu", "cuda"], paddle: { results: [result("cpu", 1), result("cpu", 2), result("cuda", 1), result("cuda", 2)] }, ovis: { results: [result("cpu", 1), result("cpu", 2), result("cuda", 1), result("cuda", 2)] } }));
      expect(inspectRealDependencyEvidence({ kind: "ocr", path, repositoryRoot: process.cwd() })).toMatchObject({ valid: true, evidencePath: "external/ocr/compatibility.json" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("accepts only complete sanitized Office runner evidence", () => {
    const root = evidenceRoot();
    try {
      const path = join(root, "office.json");
      writeFileSync(path, JSON.stringify({
        schemaVersion: 1,
        kind: "office-compatibility",
        sanitized: true,
        sourceRevision: "fa0fa64bdc967915dc8399e803be67759e1e62b8",
        packageIds: ["docx"],
        formats: ["docx"],
        runner: { mode: "external-stdin-manifest", status: "ready" },
        provider: { schemaVersion: 1, kind: "microsoft-office", application: "word", version: "16.0" },
        workflows: ["create", "edit", "replace"],
        results: [{ workflow: "create", status: "validated" }, { workflow: "edit", status: "validated" }, { workflow: "replace", status: "replaced" }]
      }));
      expect(inspectRealDependencyEvidence({ kind: "office", path, repositoryRoot: process.cwd() })).toMatchObject({ valid: true, evidencePath: "external/office/compatibility.json" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("accepts complete sanitized MCP compatibility evidence", () => {
    const root = evidenceRoot();
    try {
      const path = join(root, "mcp.json");
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, kind: "mcp-compatibility", sanitized: true, adapterVersion: "pi-mcp-adapter@1.5.1", packageRevision: "pi-mcp-adapter@1.5.1", workflows: ["lazy-read", "confirmed-write", "restart"] }));
      expect(inspectRealDependencyEvidence({ kind: "mcp", path, repositoryRoot: process.cwd() })).toMatchObject({ valid: true, evidencePath: "external/mcp/compatibility.json" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects Office evidence that does not prove the Microsoft Word provider", () => {
    const root = evidenceRoot();
    try {
      const path = join(root, "office.json");
      writeFileSync(path, JSON.stringify({
        schemaVersion: 1,
        kind: "office-compatibility",
        sanitized: true,
        sourceRevision: "fa0fa64bdc967915dc8399e803be67759e1e62b8",
        packageIds: ["docx"],
        formats: ["docx"],
        runner: { mode: "external-stdin-manifest", status: "ready" },
        workflows: ["create", "edit", "replace"],
        results: [{ workflow: "create", status: "validated" }, { workflow: "edit", status: "validated" }, { workflow: "replace", status: "replaced" }]
      }));
      expect(inspectRealDependencyEvidence({ kind: "office", path, repositoryRoot: process.cwd() }).valid).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects missing sanitization and secret-shaped values", () => {
    const root = evidenceRoot();
    try {
      const path = join(root, "mcp.json");
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, kind: "mcp-compatibility", sanitized: false, adapterVersion: "x", packageRevision: "y", workflows: ["lazy-read", "confirmed-write", "restart"], token: "secret-value" }));
      expect(inspectRealDependencyEvidence({ kind: "mcp", path, repositoryRoot: process.cwd() }).valid).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
