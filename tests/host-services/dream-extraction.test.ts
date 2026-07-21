import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DreamProfileSnapshot, DreamScopeSummary, DreamTrajectoryInput, SystemPromptRevision } from "@vc-agent/contracts";
import { buildDreamScopeExtractionContext, DreamReviewStore, parseDreamScopeSummary, type ProjectMemoryDocument } from "@vc-agent/host-services";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const profile: DreamProfileSnapshot = { id: "dream-profile", name: "Dream", provider: "fixture", model: "dream-model", thinkingLevel: "medium" };
const prompt: SystemPromptRevision = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", content: "Prompt", hash: "a".repeat(64), diff: "Initial", source: "shipped_default", createdAt: "2026-07-01T00:00:00.000Z" };
const projectA = "11111111-1111-4111-8111-111111111111";
const projectB = "22222222-2222-4222-8222-222222222222";

describe("isolated Dream extraction", () => {
  it("creates one Project scope and one scope per Unscoped Thread and never mixes their raw context", () => {
    const store = fixture();
    const batch = store.createBatch({
      promptRevision: prompt,
      profile,
      trajectory: [projectInput(projectA, "project-a-thread", "A-private"), projectInput(projectB, "project-b-thread", "B-private"), unscopedInput("unscoped-1", "U1-private"), unscopedInput("unscoped-2", "U2-private")],
      candidates: [],
      projectMemoryHashes: { [projectA]: "1".repeat(64), [projectB]: "2".repeat(64) }
    });

    expect(batch.extractionScopes.map((scope) => scope.id)).toEqual([
      `project:${projectA}`, `project:${projectB}`, "unscoped:unscoped-1", "unscoped:unscoped-2"
    ]);
    const scopeA = batch.extractionScopes[0]!;
    const contextA = buildDreamScopeExtractionContext(batch, scopeA, projectMemory(projectA, "A-memory"));
    const serializedA = JSON.stringify(contextA);
    expect(serializedA).toContain("A-private");
    expect(serializedA).toContain("A-memory");
    expect(serializedA).not.toContain("B-private");
    expect(serializedA).not.toContain("U1-private");

    const unscoped = batch.extractionScopes.find((scope) => scope.id === "unscoped:unscoped-1")!;
    const unscopedContext = buildDreamScopeExtractionContext(batch, unscoped, projectMemory(projectA, "must-not-leak"));
    expect(unscopedContext).not.toHaveProperty("projectMemory");
    expect(JSON.stringify(unscopedContext)).toContain("U1-private");
    expect(JSON.stringify(unscopedContext)).not.toContain("U2-private");
  });

  it("accepts only bounded de-identified attributed results from scope-local references", () => {
    const store = fixture();
    const batch = store.createBatch({ promptRevision: prompt, profile, trajectory: [unscopedInput("thread-1", "My explicit judgment")], candidates: [] });
    const scope = batch.extractionScopes[0]!;
    const result = parseDreamScopeSummary(JSON.stringify(summary("unscoped", scope.sourceReferences[0]!, "long_term_memory")), scope);
    expect(result).toMatchObject({ scopeKind: "unscoped", deidentified: true });

    expect(() => parseDreamScopeSummary(JSON.stringify(summary("unscoped", "thread:another/turn:x", "long_term_memory")), scope)).toThrow("outside its isolated scope");
    expect(() => parseDreamScopeSummary(JSON.stringify(summary("unscoped", scope.sourceReferences[0]!, "project_memory")), scope)).toThrow("Unscoped Dream extraction cannot propose Project Memory");
    expect(() => parseDreamScopeSummary(JSON.stringify({ ...summary("unscoped", scope.sourceReferences[0]!, "long_term_memory"), deidentified: false }), scope)).toThrow();
  });

  it("persists review decisions, blocks failed and Keep Pending scopes, and exposes explicit partial coverage", () => {
    const store = fixture();
    let batch = store.createBatch({ promptRevision: prompt, profile, trajectory: [projectInput(projectA, "p", "P"), unscopedInput("u", "U")], candidates: [], projectMemoryHashes: { [projectA]: "1".repeat(64) } });
    const projectScope = batch.extractionScopes.find((scope) => scope.kind === "project")!;
    const unscopedScope = batch.extractionScopes.find((scope) => scope.kind === "unscoped")!;

    store.startScope(batch.id, projectScope.id, "1".repeat(64));
    store.completeScope(batch.id, projectScope.id, summary("project", projectScope.sourceReferences[0]!, "project_memory"));
    store.reviewScope(batch.id, projectScope.id, "approve");
    store.startScope(batch.id, unscopedScope.id);
    store.failScope(batch.id, unscopedScope.id, { kind: "provider", code: "RATE_LIMITED", message: "token=secret should not persist", provider: "fixture", model: "dream" });

    expect(store.synthesisReadiness(batch.id)).toEqual({ ready: false, partialCoverageScopeIds: [], blockingScopeIds: [unscopedScope.id] });
    expect(store.load().batches[0]!.extractionScopes.find((scope) => scope.id === unscopedScope.id)?.failure?.message).not.toContain("secret");
    store.reviewScope(batch.id, unscopedScope.id, "skip");

    expect(store.synthesisReadiness(batch.id)).toEqual({ ready: true, partialCoverageScopeIds: [unscopedScope.id], blockingScopeIds: [] });
    expect(store.load().carryover).toMatchObject([{ reason: "skipped", scope: "unscoped", threadId: "u", sourceReference: unscopedScope.sourceReferences[0] }]);
    expect(store.load().carryover[0]?.sourceText).toContain("U");
    expect(new DreamReviewStore(rootOf(store)).load().batches[0]).toMatchObject({ status: "synthesis_pending", currentStage: "global_synthesis" });
  });

  it("retains completed scopes and marks only a changed Project Memory scope stale", () => {
    const store = fixture();
    const batch = store.createBatch({ promptRevision: prompt, profile, trajectory: [projectInput(projectA, "p", "P"), unscopedInput("u", "U")], candidates: [], projectMemoryHashes: { [projectA]: "1".repeat(64) } });
    const projectScope = batch.extractionScopes.find((scope) => scope.kind === "project")!;
    const unscopedScope = batch.extractionScopes.find((scope) => scope.kind === "unscoped")!;
    store.startScope(batch.id, unscopedScope.id);
    store.completeScope(batch.id, unscopedScope.id, summary("unscoped", unscopedScope.sourceReferences[0]!, "long_term_memory"));
    store.reviewScope(batch.id, unscopedScope.id, "approve");

    store.startScope(batch.id, projectScope.id, "1".repeat(64));
    store.completeScope(batch.id, projectScope.id, summary("project", projectScope.sourceReferences[0]!, "project_memory"));
    store.reviewScope(batch.id, projectScope.id, "approve");
    store.revalidateProjectMemory({ [projectA]: "2".repeat(64) });
    const restarted = new DreamReviewStore(rootOf(store));
    const scopes = restarted.load().batches[0]!.extractionScopes;
    expect(scopes.find((scope) => scope.id === projectScope.id)?.status).toBe("stale");
    expect(scopes.find((scope) => scope.id === unscopedScope.id)?.status).toBe("approved");
  });
});

const roots = new WeakMap<DreamReviewStore, string>();
function fixture(): DreamReviewStore {
  const root = mkdtempSync(join(tmpdir(), "vc-agent-dream-extraction-"));
  directories.push(root);
  const store = new DreamReviewStore(root, { now: () => new Date("2026-07-19T00:00:00.000Z") });
  roots.set(store, root);
  return store;
}
function rootOf(store: DreamReviewStore): string { return roots.get(store)!; }

function projectInput(projectId: string, threadId: string, text: string): DreamTrajectoryInput {
  return { sourceKind: "ordinary_dialogue", scope: "project", projectId, threadId, turnId: `turn-${threadId}`, completedAt: "2026-07-18T00:00:00.000Z", sourceReference: `thread:${threadId}/turn:turn-${threadId}`, userText: text, assistantText: `Assistant response to ${text}` };
}
function unscopedInput(threadId: string, text: string): DreamTrajectoryInput {
  return { sourceKind: "ordinary_dialogue", scope: "unscoped", threadId, turnId: `turn-${threadId}`, completedAt: "2026-07-18T00:00:00.000Z", sourceReference: `thread:${threadId}/turn:turn-${threadId}`, userText: text, assistantText: `Assistant response to ${text}` };
}
function projectMemory(projectId: string, body: string): ProjectMemoryDocument {
  return { schemaVersion: 1, projectId, markdownPath: "outputs/system/project-memory.md", content: body, sourceHash: "1".repeat(64), updatedAt: "2026-07-18T00:00:00.000Z", warnings: [], entries: [{ id: "memory-1", title: "Prior view", date: "2026-07-01", tags: ["risk"], source: "user-confirmed", scope: "project", body, maturity: "user_confirmed", provenanceStatus: "traceable", relatedThread: "thread" }] };
}
function summary(scopeKind: "project" | "unscoped", sourceReference: string, destination: "project_memory" | "long_term_memory"): DreamScopeSummary {
  return { schemaVersion: 1, scopeKind, deidentified: true, summary: "Reusable bounded summary", uncertainty: "Needs review", sourceReferences: [sourceReference], candidates: [{ candidateId: "candidate-1", origin: "recovered", sourceKind: "ordinary_user_signal", attributableSignal: "strong_user_judgment", sourceReferences: [sourceReference], uncertainty: "Medium", summary: "The user explicitly emphasized a diligence risk.", proposedDestination: destination }] };
}
