import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityExecutionRequest } from "@vc-agent/contracts";
import { CapabilityRegistry, createProjectStateRecallCapability } from "@vc-agent/capabilities";
import { CapabilityGateway, PROJECT_CONTEXT_TEMPLATE, ProjectContextRecallSource, ProjectContextStore } from "@vc-agent/host-services";

const projectId = "c7c2cc65-7215-42f0-9c5b-ad33c74ffea0";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function projectDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "vc-agent-context-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Project Context", () => {
  it("creates the transparent Markdown and mirror only on first explicit load", () => {
    const directory = projectDirectory();
    const store = new ProjectContextStore();
    const paths = store.paths(directory);
    expect(store.load(projectId, directory, false)).toBeUndefined();
    expect(existsSync(paths.markdown)).toBe(false);
    expect(existsSync(paths.mirror)).toBe(false);

    const document = store.load(projectId, directory, true)!;
    expect(document.content).toBe(PROJECT_CONTEXT_TEMPLATE);
    expect(document.sections).toHaveLength(6);
    expect(document.warnings).toEqual([]);
    expect(readFileSync(paths.markdown, "utf8")).toBe(PROJECT_CONTEXT_TEMPLATE);
    const mirror = JSON.parse(readFileSync(paths.mirror, "utf8")) as Record<string, unknown>;
    expect(mirror).not.toHaveProperty("content");
    expect(mirror).toMatchObject({ schemaVersion: 1, projectId, sourceHash: document.sourceHash });
  });

  it("rejects stale editor saves instead of overwriting external content", () => {
    const directory = projectDirectory();
    const store = new ProjectContextStore();
    const document = store.load(projectId, directory, true)!;
    writeFileSync(store.paths(directory).markdown, "# Project Context\n\n## Project Snapshot\nExternal edit\n", "utf8");
    expect(() => store.save(projectId, directory, "User draft", document.sourceHash)).toThrow("STALE_PROJECT_CONTEXT_WRITE");
    expect(readFileSync(store.paths(directory).markdown, "utf8")).toContain("External edit");
  });

  it("preserves malformed Markdown while rebuilding only valid fixed sections with warnings", () => {
    const directory = projectDirectory();
    const store = new ProjectContextStore();
    const malformed = "# Different Title\n\n## Project Snapshot\nCompany: Acme\n\n## Unknown Notes\nKeep this text\n\n## Project Snapshot\nDuplicate text\n";
    mkdirSync(join(directory, "outputs", "system"), { recursive: true });
    writeFileSync(store.paths(directory).markdown, malformed, { encoding: "utf8", flag: "wx" });
    const document = store.rebuild(projectId, directory);
    expect(document.sections).toMatchObject([{ id: "project-snapshot", content: "Company: Acme" }]);
    expect(document.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["MISSING_TITLE", "UNKNOWN_SECTION", "DUPLICATE_SECTION", "MISSING_SECTION"]));
    expect(readFileSync(store.paths(directory).markdown, "utf8")).toBe(malformed);
    expect(readFileSync(store.paths(directory).mirror, "utf8")).toContain("Unknown section 'Unknown Notes'");
  });

  it("recalls only matching fixed sections with source provenance and explicit bounds", async () => {
    const directory = projectDirectory();
    const store = new ProjectContextStore();
    const initial = store.load(projectId, directory, true)!;
    const content = initial.content
      .replace("- Company:", "- Company: Acme")
      .replace("- Current Questions:", "- Current Questions: retention risk")
      .replace("- Always Include:", "- Always Include: source uncertainty");
    const document = store.save(projectId, directory, content, initial.sourceHash);
    const source = new ProjectContextRecallSource({ load: () => store.load(projectId, directory, false) });
    const result = await source.recall(
      { query: "retention" },
      { turnId: "turn-1", maxItems: 2, maxChars: 2_000, retrievedAt: "2026-07-17T00:01:00.000Z" }
    );
    expect(result.items).toMatchObject([{ sectionId: "current-working-state", title: "Current Working State" }]);
    expect(result.items[0]?.sourceRefs).toEqual([`project-context:current-working-state@${document.sourceHash}`]);
    expect(result.contextReference).toMatchObject({ sourceClass: "project_state", sourceId: "project-context", sourceRange: "current-working-state", contentVersion: document.sourceHash, originatingTool: "project_state_recall" });

    const bounded = await source.recall(
      { sectionIds: ["project-snapshot", "current-working-state"] },
      { turnId: "turn-1", maxItems: 1, maxChars: 2_000, retrievedAt: "2026-07-17T00:01:00.000Z" }
    );
    expect(bounded.items).toHaveLength(1);
    expect(bounded.omittedItems).toBe(1);
    expect(bounded.complete).toBe(false);
  });

  it("rejects Project Context recall from an Unscoped Thread", async () => {
    const registry = new CapabilityRegistry();
    registry.register(createProjectStateRecallCapability(async () => { throw new Error("must not execute"); }));
    const gateway = new CapabilityGateway(registry);
    const request: CapabilityExecutionRequest = {
      schemaVersion: 1,
      requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), threadId: "thread-1", turnId: "turn-1", toolCallId: "tool-1",
      capabilityId: "project_state_recall", scope: { kind: "unscoped", threadId: "thread-1" }, arguments: { source: "project_context", query: "company" }, expectedStateVersion: 1,
      actor: { actorType: "agent", actorId: "primary-agent" }, provenance: { producerType: "agent", producerId: "primary-agent" }
    };
    const decision = await gateway.request(request, { accessMode: "standard", scope: "unscoped", stateVersion: 1, activeCapabilityIds: ["project_state_recall"], outputIntent: false });
    expect(decision).toMatchObject({ type: "result", result: { status: "failed", code: "SCOPE_REJECTED" } });
  });
});
