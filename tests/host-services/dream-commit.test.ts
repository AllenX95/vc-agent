import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DreamGlobalSynthesis, DreamProfileSnapshot, DreamScopeSummary, DreamTrajectoryInput, SystemPromptRevision } from "@vc-agent/contracts";
import { DreamCommitStore, DreamReviewStore, LongTermMemoryStore, MemoryCandidateStore, MemoryEvolutionStore, ProjectMemoryStore, opaqueScopeReference } from "@vc-agent/host-services";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const projectId = "11111111-1111-4111-8111-111111111111";
const profile: DreamProfileSnapshot = { id: "dream-profile", name: "Dream", provider: "fixture", model: "dream", thinkingLevel: "medium" };
const prompt: SystemPromptRevision = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", content: "Prompt", hash: "a".repeat(64), diff: "Initial", source: "shipped_default", createdAt: "2026-07-01T00:00:00.000Z" };

describe("Dream reviewed patch commit", () => {
  it("previews Project and Long-term Markdown separately from approval, then commits all state atomically", () => {
    const fixture = setup();
    const patch = fixture.commits.prepare(fixture.batchId, fixture.projects);
    expect(patch).toMatchObject({ status: "prepared", confirmationRequired: true, partialCoverageScopeReferences: [expect.stringMatching(/^scope_ref_/)] });
    expect(patch.files.filter((file) => file.changed).map((file) => file.kind)).toContain("project_memory");
    expect(patch.files.filter((file) => file.changed).map((file) => file.kind)).toContain("long_term_memory");
    expect(existsSync(fixture.projectMemory.markdownPath(fixture.projectPath))).toBe(false);
    expect(fixture.memory.readCurrent().entries).toHaveLength(0);
    expect(fixture.reviews.load().batches[0]).toMatchObject({ status: "patch_pending", preparedPatch: { status: "prepared" } });

    const completed = fixture.commits.commit(fixture.batchId, patch.id);
    expect(completed).toMatchObject({ status: "completed", currentStage: "completed", partialCoverageScopeIds: [expect.stringContaining("skipped-thread")], preparedPatch: { status: "committed", partialCoverageScopeReferences: [expect.stringMatching(/^scope_ref_/)] } });
    expect(readFileSync(fixture.projectMemory.markdownPath(fixture.projectPath), "utf8")).toContain("Project-specific diligence lesson");
    expect(fixture.memory.readCurrent().entries).toMatchObject([{ title: "Reusable diligence lesson", maturity: "user-confirmed" }]);
    expect(fixture.reviews.load().schedule.lastCommittedCutoff).toBe("2026-07-18T00:00:00.000Z");
  });

  it("rolls back Memory, Project, and Dream state together after an injected activation failure", () => {
    const fixture = setup(2);
    const patch = fixture.commits.prepare(fixture.batchId, fixture.projects);
    const dreamBefore = readFileSync(join(fixture.root, "dream", "review-state.json"), "utf8");
    const memoryBefore = readFileSync(fixture.memory.markdownPath, "utf8");
    expect(() => fixture.commits.commit(fixture.batchId, patch.id)).toThrow("INJECTED_MEMORY_TRANSACTION_FAILURE");
    expect(readFileSync(join(fixture.root, "dream", "review-state.json"), "utf8")).toBe(dreamBefore);
    expect(readFileSync(fixture.memory.markdownPath, "utf8")).toBe(memoryBefore);
    expect(existsSync(fixture.projectMemory.markdownPath(fixture.projectPath))).toBe(false);
  });

  it("blocks a prepared patch after a target Project Memory file changes", () => {
    const fixture = setup();
    const patch = fixture.commits.prepare(fixture.batchId, fixture.projects);
    const projectMemoryPath = fixture.projectMemory.markdownPath(fixture.projectPath);
    rmSync(fixture.projectPath, { recursive: true, force: true });
    mkdirSync(join(fixture.projectPath, "outputs", "system"), { recursive: true });
    writeFileSync(projectMemoryPath, "# Project Memory\n\nManual external edit.\n", "utf8");
    expect(() => fixture.commits.commit(fixture.batchId, patch.id)).toThrow("STALE_MEMORY_PATCH");
    expect(fixture.memory.readCurrent().entries).toHaveLength(0);
    expect(fixture.reviews.load().batches[0]).toMatchObject({ status: "patch_pending", preparedPatch: { status: "prepared" } });
  });
});

function setup(failAfterTargetActivation?: number) {
  const root = mkdtempSync(join(tmpdir(), "vc-agent-dream-commit-"));
  directories.push(root);
  const reviews = new DreamReviewStore(join(root, "dream"), { now: () => new Date("2026-07-19T00:00:00.000Z") });
  const trajectory = [input("project", "project-thread"), input("unscoped", "unscoped-thread"), input("unscoped", "skipped-thread")];
  let batch = reviews.createBatch({ promptRevision: prompt, profile, trajectory, candidates: [], projectMemoryHashes: { [projectId]: undefined } });
  for (const scope of batch.extractionScopes) {
    reviews.startScope(batch.id, scope.id);
    reviews.completeScope(batch.id, scope.id, scopeSummary(scope.kind, scope.sourceReferences[0]!));
    reviews.reviewScope(batch.id, scope.id, scope.threadId === "skipped-thread" ? "skip" : "approve");
  }
  batch = reviews.beginSynthesis(batch.id);
  const scopes = batch.extractionScopes;
  const projectScope = scopes.find((scope) => scope.kind === "project")!;
  const unscopedScope = scopes.find((scope) => scope.threadId === "unscoped-thread")!;
  const skippedScope = scopes.find((scope) => scope.threadId === "skipped-thread")!;
  const synthesis: DreamGlobalSynthesis = {
    schemaVersion: 1, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "review_pending", inputHash: "3".repeat(64), longTermMemoryHash: "4".repeat(64), summary: "Reviewed synthesis", uncertainty: "Medium", partialCoverageScopeReferences: [opaqueScopeReference(batch.id, skippedScope.id)],
    scopeMap: [{ scopeReference: opaqueScopeReference(batch.id, projectScope.id), scopeId: projectScope.id }, { scopeReference: opaqueScopeReference(batch.id, unscopedScope.id), scopeId: unscopedScope.id }],
    proposals: [
      proposal("proposal-project", opaqueScopeReference(batch.id, projectScope.id), projectScope.sourceReferences[0]!, "project_memory", "Project-specific diligence lesson"),
      proposal("proposal-global", opaqueScopeReference(batch.id, unscopedScope.id), unscopedScope.sourceReferences[0]!, "long_term_memory", "Reusable diligence lesson")
    ], createdAt: "2026-07-19T00:00:00.000Z"
  };
  reviews.completeSynthesis(batch.id, synthesis);
  reviews.reviewSynthesisProposals(batch.id, synthesis.proposals.map((proposal) => ({ proposalId: proposal.id, decision: "approve" as const })));

  const memory = new LongTermMemoryStore(join(root, "memory", "long-term"));
  memory.load(true);
  const evolution = new MemoryEvolutionStore(memory, { ...(failAfterTargetActivation === undefined ? {} : { failAfterTargetActivation }) });
  const projectMemory = new ProjectMemoryStore(join(root, "memory", "project-index"));
  const candidates = new MemoryCandidateStore(join(root, "memory", "candidates.jsonl"));
  const commits = new DreamCommitStore(join(root, "dream"), { reviews, evolution, memory, projectMemory, candidates }, () => new Date("2026-07-19T00:00:00.000Z"));
  const projectPath = join(root, "Secret Project Name");
  const projects = new Map([[projectId, { id: projectId, path: projectPath }]]);
  return { root, reviews, memory, projectMemory, commits, batchId: batch.id, projectPath, projects };
}

function input(scope: "project" | "unscoped", threadId: string): DreamTrajectoryInput {
  return { sourceKind: "ordinary_dialogue", scope, ...(scope === "project" ? { projectId } : {}), threadId, turnId: `turn-${threadId}`, completedAt: "2026-07-18T00:00:00.000Z", sourceReference: `thread:${threadId}/turn:turn-${threadId}`, userText: "User judgment", assistantText: "Assistant response" };
}
function scopeSummary(scopeKind: "project" | "unscoped", sourceReference: string): DreamScopeSummary {
  return { schemaVersion: 1, scopeKind, deidentified: true, summary: `${scopeKind} summary`, uncertainty: "Medium", sourceReferences: [sourceReference], candidates: [{ candidateId: `candidate-${scopeKind}`, origin: "recovered", sourceKind: "ordinary_user_signal", attributableSignal: "strong_user_judgment", sourceReferences: [sourceReference], uncertainty: "Medium", summary: "Diligence lesson", proposedDestination: scopeKind === "project" ? "project_memory" : "long_term_memory" }] };
}
function proposal(id: string, scopeReference: string, sourceReference: string, destination: "project_memory" | "long_term_memory", title: string) {
  return { id, sourceScopeReferences: [scopeReference], sourceReferences: [sourceReference], candidateOrigins: ["recovered" as const], destination, ...(destination === "long_term_memory" ? { memoryAction: "add" as const } : {}), targetEntryIds: [], learning: { title, date: "2026-07-19", tags: ["diligence"], applicability: ["early-stage investments"], maturity: "user-confirmed" as const, recallPolicy: "automatic" as const, limitations: "Validate by sector.", content: "Stage diligence against explicit uncertainty." }, uncertainty: "Medium", comparisonSummary: "No equivalent active Memory.", rationale: "Reviewed User signal.", status: "pending" as const };
}
