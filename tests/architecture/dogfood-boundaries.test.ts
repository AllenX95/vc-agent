import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityRegistry, TextOutputStore, createTextOutputCapability } from "@vc-agent/capabilities";
import { BASELINE_PARSER_ADAPTERS, ProjectOutputRegistry, getParserAdapter } from "@vc-agent/host-services";
import { SnapshotResourceLoader } from "@vc-agent/pi-adapter";

const temporaryDirectories: string[] = [];
const root = resolve(import.meta.dirname, "../..");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Dogfood adapter boundaries", () => {
  it("runs fixture resources, capabilities, parsers, and outputs through their public interfaces", async () => {
    const project = mkdtempSync(join(tmpdir(), "vc-agent-g1-boundaries-"));
    temporaryDirectories.push(project);
    const loader = new SnapshotResourceLoader({
      cwd: project,
      resources: { schemaVersion: 1, revisionId: "fixture-resources", systemPrompt: "Fixture VC prompt", appendSystemPrompt: [] },
      extensions: { schemaVersion: 1, revisionId: "bundled-empty-v1", enabled: [] }
    });
    await loader.reload();
    expect(loader.snapshot.resources.systemPrompt).toBe("Fixture VC prompt");
    expect(loader.snapshot.extensions.enabled).toEqual([]);

    const capabilities = new CapabilityRegistry();
    capabilities.register(createTextOutputCapability(new TextOutputStore()));
    expect(capabilities.get("output.write_text")?.metadata.executor).toBe("host");
    expect(getParserAdapter(".md")).toMatchObject({ id: "text", version: "1.0.0" });
    expect(BASELINE_PARSER_ADAPTERS.some((adapter) => adapter.id === "pymupdf")).toBe(true);

    const output = new TextOutputStore().commit({
      requestId: "fixture-request", outputLocation: join(project, "outputs"), relativePath: "fixture.md", content: "# Fixture", mediaType: "text/markdown",
      producer: { type: "agent", id: "fixture-agent" }, threadId: "fixture-thread", turnId: "fixture-turn", allowReplace: false
    });
    const registry = new ProjectOutputRegistry();
    const projectId = randomUUID();
    registry.record({
      projectId, projectPath: project, artifact: output,
      profile: { id: "fixture-profile", provider: "fixture-provider", model: "fixture-model" }, capabilityId: "output.write_text",
      sourceReferences: ["fixture-source"], warnings: [], relatedArtifacts: []
    });
    expect(registry.list(projectId, project)).toMatchObject([{ relativePath: "fixture.md", sourceReferences: ["fixture-source"] }]);
  });

  it("keeps Worker supervision and telemetry local without later-stage imports", () => {
    const supervisor = readFileSync(join(root, "apps/desktop/src/main/agent-worker-supervisor.ts"), "utf8");
    expect(supervisor).toContain("export class AgentWorkerSupervisor");
    expect(supervisor).toContain("workerEventSchema.safeParse");
    const adapter = readFileSync(join(root, "packages/pi-adapter/src/pi-session.ts"), "utf8");
    expect(adapter).toContain("enableAnalytics: false");
    expect(adapter).toContain("enableInstallTelemetry: false");
    // The composition root is expected to import later-stage workflows. The
    // reusable Worker supervisor and Pi adapter themselves must remain free of
    // those feature dependencies.
    const dogfoodSources = [supervisor, adapter].join("\n");
    expect(dogfoodSources).not.toMatch(/from ["'][^"']*(dream|reflection|long-term-memory|sub-agent|office|ocr|mcp|extension-audit)/iu);
  });

  it("keeps state migration deterministic and independent from model execution", () => {
    const migration = readFileSync(join(root, "packages/persistence/src/state-migration.ts"), "utf8");
    expect(migration).toContain("export function prepareStateStorage");
    expect(migration).toContain("PRAGMA integrity_check");
    expect(migration).not.toMatch(/@vc-agent\/(?:pi-adapter|capabilities)|pi-coding-agent|provider|modelProfile|memory_recall/iu);
  });

  it("keeps Long-term Memory parsing and retrieval independent from Pi and Project sources", () => {
    const source = readFileSync(join(root, "packages/host-services/src/long-term-memory.ts"), "utf8");
    expect(source).toContain("export class LongTermMemoryStore");
    expect(source).toContain("export class LongTermMemoryRecallSource");
    expect(source).not.toMatch(/@vc-agent\/(?:pi-adapter|persistence)|ProjectMemoryStore|ProjectContextStore|MaterialRecallSource|provider|pi-coding-agent/iu);
  });
});
