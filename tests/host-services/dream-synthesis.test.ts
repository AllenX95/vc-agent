import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DreamProfileSnapshot, DreamScopeSummary, DreamTrajectoryInput, SystemPromptRevision } from "@vc-agent/contracts";
import { buildDreamSynthesisInput, DreamReviewStore, LongTermMemoryStore, parseDreamGlobalSynthesis } from "@vc-agent/host-services";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const projectId = "11111111-1111-4111-8111-111111111111";
const profile: DreamProfileSnapshot = { id: "dream-profile", name: "Dream", provider: "fixture", model: "dream", thinkingLevel: "medium" };
const prompt: SystemPromptRevision = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", content: "Prompt", hash: "a".repeat(64), diff: "Initial", source: "shipped_default", createdAt: "2026-07-01T00:00:00.000Z" };

describe("Global Dream Synthesis isolation", () => {
  it("uses only opaque scope references, approved summaries, and Long-term cards", () => {
    const { batch, memory } = reviewedBatch();
    const input = buildDreamSynthesisInput(batch, memory.readCurrent());
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain(projectId);
    expect(serialized).not.toContain("Secret Project Name");
    expect(serialized).not.toContain("raw-user-project");
    expect(input.scopes.map((scope) => scope.scopeReference)).toEqual([expect.stringMatching(/^scope_ref_[a-f0-9]{24}$/), expect.stringMatching(/^scope_ref_[a-f0-9]{24}$/)]);
    expect(input.scopes.map((scope) => scope.summary)).toEqual(["De-identified project lesson", "De-identified unscoped lesson"]);
  });

  it("rejects ambiguous Project Memory, silent revision, deal specificity, and outside references", () => {
    const { batch, memory } = reviewedBatch();
    const input = buildDreamSynthesisInput(batch, memory.readCurrent());
    const projectScope = input.scopes.find((scope) => scope.scopeKind === "project")!;
    const unscopedScope = input.scopes.find((scope) => scope.scopeKind === "unscoped")!;
    const base = proposal(projectScope.scopeReference, projectScope.sourceReferences[0]!);
    expect(() => parseDreamGlobalSynthesis(JSON.stringify({ summary: "S", uncertainty: "U", proposals: [{ ...base, sourceScopeReferences: [unscopedScope.scopeReference], destination: "project_memory", memoryAction: undefined }] }), batch, input, [])).toThrow("DREAM_PROJECT_MEMORY_SCOPE_AMBIGUOUS");
    expect(() => parseDreamGlobalSynthesis(JSON.stringify({ summary: "S", uncertainty: "U", proposals: [{ ...base, destination: "long_term_memory", memoryAction: "revise", targetEntryIds: ["ltm-existing"] }] }), batch, input, [])).toThrow("DREAM_REVISION_REQUIRES_USER_RESOLUTION_SIGNAL");
    expect(() => parseDreamGlobalSynthesis(JSON.stringify({ summary: "S", uncertainty: "U", proposals: [{ ...base, destination: "long_term_memory", memoryAction: "add", learning: { ...base.learning, content: "Secret Project Name has a $20m Series A" } }] }), batch, input, ["Secret Project Name"])).toThrow("DREAM_LONG_TERM_LEARNING_NOT_DEIDENTIFIED");
    expect(() => parseDreamGlobalSynthesis(JSON.stringify({ summary: "S", uncertainty: "U", proposals: [{ ...base, sourceReferences: ["thread:outside/turn:x"] }] }), batch, input, [])).toThrow("DREAM_PROPOSAL_SOURCE_OUTSIDE_SYNTHESIS");
  });

  it("changes the synthesis dependency hash after an external Long-term Memory edit", () => {
    const { batch, memory } = reviewedBatch();
    const before = buildDreamSynthesisInput(batch, memory.readCurrent());
    writeFileSync(memory.markdownPath, `${memory.readCurrent().content.trimEnd()}\n\n## 2026-07-19 - External learning\nID: ltm-external-learning\nVersion: 1\nStatus: current\nTags: diligence\nScope: global\nApplies To: early-stage investments\nMaturity: user-confirmed\nRecall: automatic\nConflict: none\nLimitations: Validate by sector.\nSource References: \n\nStage diligence around explicit uncertainty.\n`, "utf8");
    const after = buildDreamSynthesisInput(batch, memory.rebuild());
    expect(after.longTermMemoryHash).not.toBe(before.longTermMemoryHash);
    expect(after).not.toEqual(before);
  });
});

function reviewedBatch() {
  const root = mkdtempSync(join(tmpdir(), "vc-agent-dream-synthesis-"));
  directories.push(root);
  const reviews = new DreamReviewStore(join(root, "dream"), { now: () => new Date("2026-07-19T00:00:00.000Z") });
  let batch = reviews.createBatch({ promptRevision: prompt, profile, trajectory: [trajectory("project", "project-thread", "raw-user-project"), trajectory("unscoped", "unscoped-thread", "raw-user-unscoped")], candidates: [], projectMemoryHashes: { [projectId]: "1".repeat(64) } });
  for (const scope of batch.extractionScopes) {
    reviews.startScope(batch.id, scope.id, scope.kind === "project" ? "1".repeat(64) : undefined);
    reviews.completeScope(batch.id, scope.id, summary(scope.kind, scope.sourceReferences[0]!));
    reviews.reviewScope(batch.id, scope.id, "approve");
  }
  batch = reviews.load().batches[0]!;
  const memory = new LongTermMemoryStore(join(root, "memory", "long-term"));
  memory.load(true);
  return { batch, memory, reviews, root };
}

function trajectory(scope: "project" | "unscoped", threadId: string, userText: string): DreamTrajectoryInput {
  return { sourceKind: "ordinary_dialogue", scope, ...(scope === "project" ? { projectId } : {}), threadId, turnId: `turn-${threadId}`, completedAt: "2026-07-18T00:00:00.000Z", sourceReference: `thread:${threadId}/turn:turn-${threadId}`, userText, assistantText: "raw-assistant" };
}
function summary(scopeKind: "project" | "unscoped", sourceReference: string): DreamScopeSummary {
  return { schemaVersion: 1, scopeKind, deidentified: true, summary: scopeKind === "project" ? "De-identified project lesson" : "De-identified unscoped lesson", uncertainty: "Medium", sourceReferences: [sourceReference], candidates: [{ candidateId: `candidate-${scopeKind}`, origin: "recovered", sourceKind: "ordinary_user_signal", attributableSignal: "strong_user_judgment", sourceReferences: [sourceReference], uncertainty: "Medium", summary: "Prefer staged diligence", proposedDestination: scopeKind === "project" ? "project_memory" : "long_term_memory" }] };
}
function proposal(scopeReference: string, sourceReference: string) {
  return { id: "proposal-one", sourceScopeReferences: [scopeReference], sourceReferences: [sourceReference], candidateOrigins: ["recovered"], destination: "project_memory", targetEntryIds: [], learning: { title: "Stage diligence", date: "2026-07-19", tags: ["diligence"], applicability: ["early-stage investments"], maturity: "user-confirmed", recallPolicy: "automatic", limitations: "Validate by sector.", content: "Stage diligence against explicit uncertainty." }, uncertainty: "Medium", comparisonSummary: "No equivalent active Memory.", rationale: "User signal." };
}
