import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("Learning Build architecture gate", () => {
  it("keeps migration and Personal Cognition Backup mechanical and model-free", () => {
    const migration = read("packages/persistence/src/state-migration.ts");
    const backup = read("packages/host-services/src/personal-cognition-backup.ts");
    expect(migration).toContain("PRAGMA integrity_check");
    expect(backup).toContain("credentialsIncluded: false");
    expect(backup).toContain("confirmedWholeDomainReplacement");
    expect(`${migration}\n${backup}`).not.toMatch(/pi-adapter|pi-coding-agent|provider request|modelProfile.*execute|memory_recall/iu);
  });

  it("keeps Learning runners and stores independent from Integration and Delegation code", () => {
    const sources = [
      "packages/host-services/src/long-term-memory.ts",
      "packages/host-services/src/memory-evolution.ts",
      "packages/host-services/src/investment-reflection.ts",
      "packages/host-services/src/dream-review.ts",
      "packages/host-services/src/dream-commit.ts",
      "packages/host-services/src/personal-cognition-backup.ts"
    ].map(read).join("\n");
    expect(sources).not.toMatch(/office|paddleocr|ovisocr|mcp-adapter|extension audit|sub-agent|execution queue/iu);
  });

  it("exposes local prompt, recall, token, latency, coverage, and failure telemetry without remote content telemetry", () => {
    const contracts = read("packages/contracts/src/ipc.ts");
    const host = read("apps/desktop/src/main/main.ts");
    const renderer = read("apps/desktop/src/renderer/App.tsx");
    expect(contracts).toMatch(/promptEstimatedTokens[\s\S]*toolSchemaEstimatedTokens[\s\S]*contextEstimatedTokens[\s\S]*recalledStateEstimatedTokens[\s\S]*outputReserveEstimatedTokens/u);
    expect(host).toContain("latencyMs");
    expect(renderer).toContain("Partial Dream Coverage");
    expect(renderer).toContain("failure");
    expect(renderer).toContain("outputReserveEstimatedTokens");
    expect(read("packages/pi-adapter/src/pi-session.ts")).toContain("enableInstallTelemetry: false");
  });

  it("does not expose Integration or Delegation controls before their stages", () => {
    const renderer = read("apps/desktop/src/renderer/App.tsx");
    expect(renderer).not.toMatch(/>Office<|>OCR<|>MCP<|>Extension Audit<|>Sub-Agent</u);
  });
});

function read(path: string): string { return readFileSync(join(root, path), "utf8"); }
