import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LongTermMemoryStore, MemoryEvolutionStore, type MemoryLearningDraft, type MemoryPatchRequest } from "@vc-agent/host-services";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(failAfterTargetActivation?: number, now = "2026-07-19T08:00:00.000Z") {
  const directory = mkdtempSync(join(tmpdir(), "vc-agent-evolution-"));
  temporaryDirectories.push(directory);
  const memory = new LongTermMemoryStore(join(directory, "memory", "long-term"));
  memory.load(true);
  writeFileSync(memory.markdownPath, initialMemory, "utf8");
  memory.rebuild();
  let next = 0;
  const evolution = new MemoryEvolutionStore(memory, {
    now: () => new Date(now),
    createId: () => `patch-0000000${++next}`,
    ...(failAfterTargetActivation === undefined ? {} : { failAfterTargetActivation })
  });
  return { directory, memory, evolution };
}

const initialMemory = `# Long-term Memory

Schema-Version: 1

## 2026-07-18 - Conservative TAM framing
ID: ltm-tam-framing
Version: 1
Status: current
Tags: memo, market sizing
Scope: global
Applies To: early-stage hard tech, IC memo
Maturity: user-confirmed
Recall: automatic
Conflict: none
Limitations: Less useful after repeatable sales.
Source References: src_ref_alpha

Use conservative serviceable-market assumptions in early-stage investment memos.

## 2026-07-18 - Validate founder references
ID: ltm-founder-reference
Version: 1
Status: current
Tags: founder, diligence
Scope: global
Applies To: seed financing
Maturity: user-confirmed
Recall: automatic
Conflict: none
Limitations: References may be unavailable.
Source References:

Triangulate unusually polished founder references.
`;

const draft: MemoryLearningDraft = {
  title: "Conservative TAM framing",
  date: "2026-07-19",
  tags: ["memo", "market sizing"],
  applicability: ["pre-revenue hard tech", "IC memo"],
  maturity: "evidence-backed",
  recallPolicy: "automatic",
  limitations: "Apply less weight after repeatable sales.",
  content: "Use conservative bottom-up serviceable-market assumptions before repeatable sales.",
  sourceReferenceIds: ["src_ref_beta"]
};

describe("MemoryEvolutionStore", () => {
  it("previews and commits Add across active Memory, provenance, and recall index", () => {
    const { memory, evolution } = fixture();
    const proposed = { ...draft, id: "ltm-new-market-rule", title: "Bottom-up market rule" };
    const patch = evolution.prepare({ action: "add", targetEntryIds: [], proposed, rationale: "Confirmed in Reflection.", provenanceRecords: [provenance("src_ref_beta")] });
    expect(patch.confirmationRequired).toBe(true);
    expect(patch.files).toHaveLength(5);
    expect(patch.files.every((file) => file.baseHash === "missing" || /^[a-f0-9]{64}$/u.test(file.baseHash))).toBe(true);
    expect(readFileSync(memory.markdownPath, "utf8")).not.toContain("Bottom-up market rule");

    const document = evolution.commit(patch.id);
    expect(document.entries.map((entry) => entry.id)).toContain("ltm-new-market-rule");
    expect(readFileSync(evolution.provenancePath, "utf8")).toContain("src_ref_beta");
    expect(JSON.parse(readFileSync(memory.indexPath, "utf8"))).toMatchObject({ sourceHash: document.sourceHash });
    expect(evolution.loadPrepared(patch.id)).toBeUndefined();
  });

  it("reinforces provenance or maturity without duplicating meaning", () => {
    const { memory, evolution } = fixture();
    const before = memory.rebuild().entries.find((entry) => entry.id === "ltm-tam-framing")!;
    const patch = evolution.prepare({ action: "reinforce", targetEntryIds: [before.id], proposed: { ...draft, content: "Ignored replacement wording." }, rationale: "A second approved source supports it.", provenanceRecords: [provenance("src_ref_beta")] });
    const after = evolution.commit(patch.id).entries.find((entry) => entry.id === before.id)!;
    expect(after.version).toBe(1);
    expect(after.content).toBe(before.content);
    expect(after.maturity).toBe("evidence-backed");
    expect(after.sourceReferenceIds).toEqual(["src_ref_alpha", "src_ref_beta"]);
  });

  it("rejects an empty Reinforce action", () => {
    const { evolution } = fixture();
    expect(() => evolution.prepare({ action: "reinforce", targetEntryIds: ["ltm-founder-reference"], rationale: "No actual change." })).toThrow("MEMORY_PATCH_NO_CHANGES");
  });

  it.each(["narrow", "revise"] as const)("creates a new version for %s and preserves prior wording and rationale", (action) => {
    const { memory, evolution } = fixture();
    const patch = evolution.prepare({
      action,
      targetEntryIds: ["ltm-tam-framing"],
      proposed: draft,
      rationale: `${action} after approved discussion.`,
      resolutionSignal: { type: action === "revise" ? "approved_reflection" : "user_correction", referenceId: "judgment-record-01" },
      provenanceRecords: [provenance("src_ref_beta")]
    });
    const after = evolution.commit(patch.id).entries.find((entry) => entry.id === "ltm-tam-framing")!;
    expect(after.version).toBe(2);
    expect(after.sourceReferenceIds).toEqual(["src_ref_alpha", "src_ref_beta"]);
    const history = readFileSync(memory.historyPath, "utf8");
    expect(history).toContain("Use conservative serviceable-market assumptions");
    expect(history).toContain(`${action} after approved discussion.`);
    expect(history).toContain("judgment-record-01");
  });

  it("rejects Revise without an attributable resolution signal", () => {
    const { evolution } = fixture();
    expect(() => evolution.prepare({ action: "revise", targetEntryIds: ["ltm-tam-framing"], proposed: draft, rationale: "The new text sounds more confident." })).toThrow("MEMORY_PATCH_RESOLUTION_SIGNAL_REQUIRED");
  });

  it("rejects evidence maturity without traceable local provenance", () => {
    const { evolution } = fixture();
    expect(() => evolution.prepare({ action: "add", targetEntryIds: [], proposed: { ...draft, id: "ltm-unmapped-evidence", sourceReferenceIds: ["src_ref_unmapped"] }, rationale: "Unsupported maturity claim." })).toThrow("MEMORY_PATCH_MATURITY_PROVENANCE_REQUIRED");
  });

  it("preserves both views as an unresolved conflict", () => {
    const { memory, evolution } = fixture();
    const opposing = { ...draft, id: "ltm-speed-over-efficiency", title: "Speed can dominate efficiency", content: "In winner-take-most markets, speed may justify unusually high burn." };
    const patch = evolution.prepare({ action: "contradict", targetEntryIds: ["ltm-tam-framing"], proposed: opposing, rationale: "Evidence conflicts but does not resolve the scope.", provenanceRecords: [provenance("src_ref_beta")] });
    const entries = evolution.commit(patch.id).entries.filter((entry) => entry.conflictState.startsWith("unresolved:"));
    expect(entries.map((entry) => entry.id).sort()).toEqual(["ltm-speed-over-efficiency", "ltm-tam-framing"]);
    expect(new Set(entries.map((entry) => entry.conflictState)).size).toBe(1);
    expect(readFileSync(memory.historyPath, "utf8")).toContain("Contradict");
  });

  it("archives merge-only redundancy without writing cognitive evolution", () => {
    const { memory, evolution } = fixture();
    const historyBefore = readFileSync(memory.historyPath, "utf8");
    const patch = evolution.prepare({ action: "merge_condense", targetEntryIds: ["ltm-tam-framing", "ltm-founder-reference"], proposed: { ...draft, id: "ltm-combined-diligence", title: "Bound claims with triangulation" }, rationale: "Remove redundant wording only.", provenanceRecords: [provenance("src_ref_beta")] });
    const document = evolution.commit(patch.id);
    expect(document.entries.map((entry) => entry.id)).toEqual(["ltm-combined-diligence"]);
    expect(readFileSync(memory.archivePath, "utf8")).toContain("Remove redundant wording only.");
    expect(readFileSync(memory.historyPath, "utf8")).toBe(historyBefore);
  });

  it("marks a prepared patch stale after any target file changes", () => {
    const { memory, evolution } = fixture();
    const patch = evolution.prepare(addRequest());
    writeFileSync(memory.archivePath, `${readFileSync(memory.archivePath, "utf8")}\nManual archive note.\n`, "utf8");
    expect(() => evolution.commit(patch.id)).toThrow("STALE_MEMORY_PATCH");
    expect(readFileSync(memory.markdownPath, "utf8")).not.toContain("Bottom-up market rule");
  });

  it("distinguishes a missing target from an externally created empty file", () => {
    const { evolution } = fixture();
    const request = addRequest();
    const patch = evolution.prepare({ ...request, proposed: { ...request.proposed!, maturity: "user-confirmed", sourceReferenceIds: [] }, provenanceRecords: [] });
    expect(patch.files.find((file) => file.kind === "local_provenance")).toMatchObject({ baseHash: "missing", resultHash: "missing", changed: false });
    writeFileSync(evolution.provenancePath, "", "utf8");
    expect(() => evolution.commit(patch.id)).toThrow("STALE_MEMORY_PATCH");
  });

  it("preserves untouched comments and malformed manual text byte-for-byte around targeted entries", () => {
    const { memory, evolution } = fixture();
    const manual = readFileSync(memory.markdownPath, "utf8").replace("Schema-Version: 1", "Schema-Version: 1\n\nUser note: preserve this text").concat("\n## Broken manual section\nScope: global\n\n");
    writeFileSync(memory.markdownPath, manual, "utf8");
    memory.rebuild();
    const patch = evolution.prepare(addRequest());
    evolution.commit(patch.id);
    const result = readFileSync(memory.markdownPath, "utf8");
    expect(result).toContain("User note: preserve this text");
    expect(result).toContain("## Broken manual section\nScope: global\n\n");
  });

  it("rejects a proposed entry that cannot be safely indexed", () => {
    const { evolution } = fixture();
    const unsafe = { ...addRequest(), proposed: { ...addRequest().proposed!, title: "Acme Corp deal lesson", content: "Company: Acme Corp\nValuation: $50m" } };
    expect(() => evolution.prepare(unsafe)).toThrow("INVALID_MEMORY_PATCH_RESULT");
  });

  it("rolls back every target when activation fails partway", () => {
    const { memory, evolution } = fixture(3);
    const before = [memory.markdownPath, memory.archivePath, memory.historyPath, evolution.provenancePath, memory.indexPath].map((path) => existsSync(path) ? readFileSync(path, "utf8") : undefined);
    const patch = evolution.prepare(addRequest());
    expect(() => evolution.commit(patch.id)).toThrow("INJECTED_MEMORY_TRANSACTION_FAILURE");
    expect([memory.markdownPath, memory.archivePath, memory.historyPath, evolution.provenancePath, memory.indexPath].map((path) => existsSync(path) ? readFileSync(path, "utf8") : undefined)).toEqual(before);
  });

  it("recovers an interrupted prepared transaction before Memory is read again", () => {
    const { directory, memory } = fixture();
    const original = readFileSync(memory.markdownPath, "utf8");
    const transactionRoot = join(directory, "memory", "transactions", "crashed-patch");
    mkdirSync(transactionRoot, { recursive: true });
    const backupPath = join(transactionRoot, "0.backup");
    const stagedPath = join(transactionRoot, "0.staged");
    renameSync(memory.markdownPath, backupPath);
    writeFileSync(memory.markdownPath, "partially activated content", "utf8");
    writeFileSync(stagedPath, "unused staged content", "utf8");
    writeFileSync(join(transactionRoot, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "crashed-patch", phase: "prepared", targets: [{ targetPath: memory.markdownPath, stagedPath, backupPath, existed: true }] }), "utf8");

    new MemoryEvolutionStore(memory);
    expect(readFileSync(memory.markdownPath, "utf8")).toBe(original);
    expect(existsSync(transactionRoot)).toBe(false);
  });

  it("does not infer history, archive, or provenance from a direct manual edit", () => {
    const { memory, evolution } = fixture();
    const history = readFileSync(memory.historyPath, "utf8");
    const archive = readFileSync(memory.archivePath, "utf8");
    writeFileSync(memory.markdownPath, initialMemory.replace("Conservative TAM framing", "User-edited TAM framing"), "utf8");
    memory.rebuild();
    expect(readFileSync(memory.historyPath, "utf8")).toBe(history);
    expect(readFileSync(memory.archivePath, "utf8")).toBe(archive);
    expect(existsSync(evolution.provenancePath)).toBe(false);
  });

  it("defaults archive cleanup to 90 days with automatic deletion disabled", () => {
    const { evolution } = fixture();
    expect(evolution.loadMaintenance()).toMatchObject({ schemaVersion: 1, retention: 90, automaticDeletion: false, archiveItems: [] });
  });

  it("marks expired condensation entries, supports Keep, and never changes cognitive history", () => {
    const created = fixture();
    const patch = created.evolution.prepare({ action: "merge_condense", targetEntryIds: ["ltm-tam-framing", "ltm-founder-reference"], proposed: { ...draft, id: "ltm-combined-diligence", title: "Bound claims with triangulation" }, rationale: "Condense redundant wording.", provenanceRecords: [provenance("src_ref_beta")] });
    created.evolution.commit(patch.id);
    const historyBefore = readFileSync(created.memory.historyPath, "utf8");

    const later = new MemoryEvolutionStore(created.memory, { now: () => new Date("2026-09-01T08:00:00.000Z") });
    let maintenance = later.saveMaintenanceSettings(30, false);
    expect(maintenance.archiveItems[0]).toMatchObject({ archiveId: patch.id, eligibleForCleanup: true, kept: false });
    expect(later.cleanupArchive().archiveItems).toHaveLength(1);
    maintenance = later.updateArchiveItem(patch.id, "keep");
    expect(maintenance.archiveItems[0]).toMatchObject({ kept: true, eligibleForCleanup: false });
    expect(later.cleanupArchive([patch.id]).archiveItems).toHaveLength(1);
    expect(readFileSync(created.memory.historyPath, "utf8")).toBe(historyBefore);
  });

  it("deletes only explicitly reviewed eligible archive entries and records cleanup", () => {
    const created = fixture();
    const patch = created.evolution.prepare({ action: "merge_condense", targetEntryIds: ["ltm-tam-framing", "ltm-founder-reference"], proposed: { ...draft, id: "ltm-combined-diligence", title: "Bound claims with triangulation" }, rationale: "Condense redundant wording.", provenanceRecords: [provenance("src_ref_beta")] });
    created.evolution.commit(patch.id);
    const later = new MemoryEvolutionStore(created.memory, { now: () => new Date("2026-09-01T08:00:00.000Z") });
    later.saveMaintenanceSettings(30, false);
    expect(later.cleanupArchive([patch.id]).archiveItems).toEqual([]);
    expect(readFileSync(join(created.directory, "memory", "condensation-cleanup.jsonl"), "utf8")).toContain(patch.id);
  });

  it("cleans eligible archive entries without item selection only after automatic deletion is enabled", () => {
    const created = fixture();
    const patch = created.evolution.prepare({ action: "merge_condense", targetEntryIds: ["ltm-tam-framing", "ltm-founder-reference"], proposed: { ...draft, id: "ltm-combined-auto", title: "Bound claims with triangulation" }, rationale: "Condense redundant wording.", provenanceRecords: [provenance("src_ref_beta")] });
    created.evolution.commit(patch.id);
    const later = new MemoryEvolutionStore(created.memory, { now: () => new Date("2026-09-01T08:00:00.000Z") });
    later.saveMaintenanceSettings(30, true);
    expect(later.cleanupArchive().archiveItems).toEqual([]);
    expect(readFileSync(created.memory.historyPath, "utf8")).toBe("# Cognitive Evolution History\n\nSchema-Version: 1\n");
  });

  it("returns local provenance only for its source Project and shows missing sources as unavailable", () => {
    const { evolution } = fixture();
    const patch = evolution.prepare(addRequest());
    evolution.commit(patch.id);
    expect(evolution.inspectProvenance("src_ref_beta", "11111111-1111-4111-8111-111111111111")).toMatchObject({ status: "available", record: { workflowRunId: "reflection-run-01" } });
    expect(evolution.inspectProvenance("src_ref_beta", "22222222-2222-4222-8222-222222222222")).toEqual({ sourceReferenceId: "src_ref_beta", status: "source_unavailable" });
    expect(evolution.inspectProvenance("src_ref_missing", "11111111-1111-4111-8111-111111111111")).toEqual({ sourceReferenceId: "src_ref_missing", status: "source_unavailable" });
  });

  it("never silently rebinds an opaque source reference", () => {
    const { evolution } = fixture();
    const first = evolution.prepare(addRequest());
    evolution.commit(first.id);
    const conflicting = { ...provenance("src_ref_beta"), projectId: "22222222-2222-4222-8222-222222222222" };
    expect(() => evolution.prepare({ action: "add", targetEntryIds: [], proposed: { ...draft, id: "ltm-conflicting-source", title: "Conflicting source fixture" }, rationale: "Must reject source rebinding.", provenanceRecords: [conflicting] })).toThrow("CONFLICTING_LOCAL_MEMORY_PROVENANCE");
  });
});

function addRequest(): MemoryPatchRequest {
  return { action: "add", targetEntryIds: [], proposed: { ...draft, id: "ltm-new-market-rule", title: "Bottom-up market rule" }, rationale: "Confirmed in Reflection.", provenanceRecords: [provenance("src_ref_beta")] };
}

function provenance(sourceReferenceId: string) {
  return {
    schemaVersion: 1 as const,
    sourceReferenceId,
    projectId: "11111111-1111-4111-8111-111111111111",
    workflowType: "reflection" as const,
    workflowRunId: "reflection-run-01",
    judgmentRecordId: "judgment-record-01",
    threadId: "thread-01",
    turnId: "turn-01",
    evidenceReferences: ["material-01#page=4"],
    availability: "active" as const,
    createdAt: "2026-07-19T08:00:00.000Z"
  };
}
