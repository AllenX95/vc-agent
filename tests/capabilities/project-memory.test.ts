import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapabilityExecutionRequest } from "@vc-agent/contracts";
import { CapabilityRegistry, createMemoryRecallCapability } from "@vc-agent/capabilities";
import { CapabilityGateway, MemoryCandidateStore, PROJECT_MEMORY_HEADER, ProjectMemoryRecallSource, ProjectMemoryStore, detectMemoryCandidateSignal } from "@vc-agent/host-services";

const projectId = "c7c2cc65-7215-42f0-9c5b-ad33c74ffea0";
const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vc-agent-memory-")); temporaryDirectories.push(root);
  return { project: join(root, "project"), store: new ProjectMemoryStore(join(root, "app-data", "memory", "project-index")) };
}

describe("Project Memory", () => {
  it("appends only a structured user-confirmed draft against the active version", () => {
    const { project, store } = fixture();
    const initial = store.load(projectId, project, true)!;
    expect(initial.content).toBe(PROJECT_MEMORY_HEADER);
    const document = store.append(projectId, project, { title: "Scalability is the main risk", tags: ["risk", "diligence"], body: "Production repeatability is the key uncertainty.", threadId: "thread-1" }, initial.sourceHash);
    expect(document.entries).toMatchObject([{ title: "Scalability is the main risk", source: "user-confirmed", maturity: "user_confirmed", provenanceStatus: "traceable", relatedThread: "thread-1" }]);
    expect(readFileSync(store.indexPath(projectId), "utf8")).toContain("user_confirmed");
    expect(() => store.append(projectId, project, { title: "Stale", tags: [], body: "Must not write" }, initial.sourceHash)).toThrow("STALE_PROJECT_MEMORY_WRITE");
  });

  it("keeps manual malformed text authoritative while excluding unsafe entries from recall index", () => {
    const { project, store } = fixture();
    const path = store.markdownPath(project);
    mkdirSync(join(project, "outputs", "system"), { recursive: true });
    const content = "# Project Memory\n\n## malformed heading\nKeep this user text\n\n## 2026-07-17 - Valid view\nTags: thesis\nSource: user-authored\nScope: project\n\n用户认为渠道质量比数量重要。\n\nRelated:\n- Thread:\n- Output:\n";
    writeFileSync(path, content, "utf8");
    const document = store.rebuild(projectId, project);
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(document.warnings).toMatchObject([{ code: "MALFORMED_ENTRY" }]);
    expect(document.entries).toMatchObject([{ title: "Valid view", provenanceStatus: "user_authored_no_evidence" }]);
  });

  it("recalls bounded Chinese and English cards before full user-confirmed judgment", async () => {
    const { project, store } = fixture();
    const initial = store.load(projectId, project, true)!;
    const document = store.append(projectId, project, { title: "Channel quality", tags: ["go-to-market"], body: "用户认为渠道质量比数量重要。Retention matters more than lead volume." }, initial.sourceHash);
    const source = new ProjectMemoryRecallSource(() => store.load(projectId, project, false));
    const context = { turnId: "turn-1", maxItems: 4, maxChars: 2_000, retrievedAt: "2026-07-17T00:00:00.000Z" };
    const cards = await source.recall({ disclosureLevel: "cards", query: "渠道" }, context);
    expect(cards.items).toMatchObject([{ maturity: "user_confirmed", scope: "project", matchReason: "matched query: 渠道" }]);
    expect(cards.contextReference).toMatchObject({ label: "Project Memory (user-confirmed judgment)", contentVersion: document.sourceHash });
    const full = await source.recall({ disclosureLevel: "full", entryIds: [document.entries[0]!.id] }, context);
    expect(full.items[0]?.body).toContain("Retention matters");
  });

  it("returns an empty bounded result when Project Memory does not exist", async () => {
    const source = new ProjectMemoryRecallSource(() => undefined);
    const result = await source.recall(
      { disclosureLevel: "cards", query: "risk" },
      { turnId: "turn-1", maxItems: 4, maxChars: 2_000, retrievedAt: "2026-07-17T00:00:00.000Z" }
    );
    expect(result).toMatchObject({
      items: [],
      complete: true,
      warnings: ["Project Memory is unavailable."],
      contextReference: { status: "source_unavailable" }
    });
  });

  it("captures deterministic user signals into a separate review queue without writing Memory", () => {
    const { project, store } = fixture();
    const initial = store.load(projectId, project, true)!;
    const candidates = new MemoryCandidateStore(join(project, "app-data", "memory", "candidates.jsonl"));
    expect(detectMemoryCandidateSignal("请记住这个判断：渠道质量更重要")).toBe("explicit_remember");
    expect(detectMemoryCandidateSignal("我认为生产稳定性是核心风险")).toBe("strong_user_judgment");
    expect(detectMemoryCandidateSignal("总结这份材料")).toBeUndefined();
    const reflectionCandidate = candidates.capture({ scope: "unscoped", threadId: "reflection-thread", turnId: "reflection-turn", sourceSnippet: "I adopt this view.", sourceKind: "reflection_dialogue", signal: "reflection_adoption" });
    expect(reflectionCandidate).toMatchObject({ sourceKind: "reflection_dialogue", signal: "reflection_adoption", status: "active" });
    const candidate = candidates.capture({ scope: "project", projectId, threadId: "thread-1", turnId: "turn-1", sourceSnippet: "我认为生产稳定性是核心风险", signal: "strong_user_judgment" });
    expect(candidates.list().find((item) => item.id === candidate.id)).toMatchObject({ status: "active", sourceKind: "ordinary_user_signal" });
    expect(store.load(projectId, project, false)?.sourceHash).toBe(initial.sourceHash);
    expect(candidates.resolve(candidate.id, "dismissed")).toMatchObject({ status: "dismissed" });
    expect(candidates.resolve(candidate.id, "promoted")).toBeUndefined();
  });

  it("does not let an Unscoped Thread use Project Memory through the core recall surface", async () => {
    const recall = vi.fn();
    const registry = new CapabilityRegistry();
    registry.register(createMemoryRecallCapability(recall));
    const gateway = new CapabilityGateway(registry);
    const request: CapabilityExecutionRequest = {
      schemaVersion: 1, requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), threadId: "thread-1", turnId: "turn-1", toolCallId: "tool-1",
      capabilityId: "memory_recall", scope: { kind: "unscoped", threadId: "thread-1" }, arguments: { source: "project_memory", disclosureLevel: "cards", query: "risk" }, expectedStateVersion: 1,
      actor: { actorType: "agent", actorId: "primary-agent" }, provenance: { producerType: "agent", producerId: "primary-agent" }
    };
    const decision = await gateway.request(request, { accessMode: "standard", scope: "unscoped", stateVersion: 1, activeCapabilityIds: ["memory_recall"], outputIntent: false });
    expect(decision).toMatchObject({ type: "result", result: { status: "failed", code: "RECALL_SOURCE_UNAVAILABLE" } });
    expect(recall).not.toHaveBeenCalled();
  });

  it("makes manual deletion authoritative and removes the derived index", () => {
    const { project, store } = fixture();
    store.load(projectId, project, true);
    expect(existsSync(store.indexPath(projectId))).toBe(true);
    rmSync(store.markdownPath(project));
    expect(store.rebuildIfExists(projectId, project)).toBeUndefined();
    expect(existsSync(store.indexPath(projectId))).toBe(false);
  });
});
