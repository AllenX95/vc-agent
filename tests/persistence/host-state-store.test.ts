import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { exportRawStateBundle, HostStateStore, listRollbackFiles } from "@vc-agent/persistence";

const temporaryDirectories: string[] = [];
const idleActivity = { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0, externalNetworkRequests: 0 };

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "vc-agent-state-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "state.db");
  return { store: new HostStateStore(databasePath), databasePath };
}

describe("HostStateStore", () => {
  it("bootstraps the Host schema with no product entities", () => {
    const { store, databasePath } = createStore();
    expect(store.getBootstrapState("0.1.0", idleActivity)).toMatchObject({
      stateSchemaVersion: 10,
      accessMode: "standard",
      entityCounts: { projects: 0, threads: 0, modelProfiles: 0, taskAssignments: 0 },
      runtimeActivity: idleActivity
    });
    store.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    database.close();
    expect(tables).toEqual(["application_settings", "artifacts", "materials", "model_profiles", "parse_refresh_requests", "parsed_material_versions", "physical_contexts", "project_provider_authorizations", "projects", "protected_credentials", "reflection_runs", "schema_migrations", "system_prompt_revisions", "task_model_assignments", "threads"]);
    expect(() => readFileSync(databasePath)).not.toThrow();
  });

  it("validates an older schema in staging before atomically activating it", () => {
    const { store, databasePath } = createStore();
    store.close();
    const old = new DatabaseSync(databasePath);
    old.prepare("DELETE FROM schema_migrations WHERE version = 10").run();
    old.close();

    const migrated = new HostStateStore(databasePath);
    expect(migrated.statePreparation).toMatchObject({ status: "migrated", mode: "read_write", storedVersion: 10, rollbackAvailable: true });
    expect(migrated.getBootstrapState("0.1.0", idleActivity).stateSchemaVersion).toBe(10);
    migrated.setAccessMode("full");
    migrated.close();
    expect(listRollbackFiles(databasePath)).toContain("state.db");
    const verified = new DatabaseSync(databasePath, { readOnly: true });
    expect(verified.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toMatchObject({ version: 10 });
    verified.close();
  });

  it("leaves the prior database bytes active when staging fails before activation", () => {
    const { store, databasePath } = createStore();
    store.close();
    const old = new DatabaseSync(databasePath);
    old.prepare("DELETE FROM schema_migrations WHERE version = 10").run();
    old.close();
    const before = sqliteBundle(databasePath);

    const recovery = new HostStateStore(databasePath, { failAfterStageValidation: true });
    expect(recovery.statePreparation).toMatchObject({ status: "migration_failed", mode: "read_only_recovery", storedVersion: 9, rollbackAvailable: true });
    expect(recovery.getBootstrapState("0.1.0", idleActivity).stateSchemaVersion).toBe(9);
    expect(() => recovery.setAccessMode("full")).toThrow();
    recovery.close();
    expect(sqliteBundle(databasePath)).toEqual(before);
    const writable = new DatabaseSync(databasePath);
    expect(() => writable.exec("BEGIN IMMEDIATE; ROLLBACK")).not.toThrow();
    writable.close();
  });

  it("opens newer state read-only without changing its database bundle", () => {
    const { store, databasePath } = createStore();
    store.close();
    const newer = new DatabaseSync(databasePath);
    newer.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (99, ?)").run(new Date().toISOString());
    newer.close();
    const before = sqliteBundle(databasePath);

    const recovery = new HostStateStore(databasePath);
    expect(recovery.statePreparation).toMatchObject({ status: "newer_state", mode: "read_only_recovery", storedVersion: 99, supportedVersion: 10 });
    expect(recovery.listThreads()).toEqual([]);
    expect(() => recovery.createUnscopedThread("Blocked")).toThrow();
    recovery.close();
    expect(sqliteBundle(databasePath)).toEqual(before);
    const destination = join(databasePath, "..", "raw-export");
    expect(exportRawStateBundle(databasePath, destination, { storedVersion: 99, supportedVersion: 10 })).toContain("manifest.json");
    expect(readFileSync(join(destination, "state.db")).toString("base64")).toBe(before[""]);
    const manifest = readFileSync(join(destination, "manifest.json"), "utf8");
    expect(manifest).toContain('"storedSchemaVersion": 99');
    expect(manifest).not.toContain(databasePath);
  });

  it("stores only credential references in Profiles and keeps Unscoped Thread metadata separate", () => {
    const { store } = createStore();
    const encryptedCredential = Uint8Array.from([9, 4, 2, 8]);
    const profile = store.createModelProfile({
      name: "Research",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "off",
      encryptedCredential
    });
    const thread = store.createUnscopedThread("Thread 1");
    const selected = store.selectThreadProfile(thread.id, profile.id);
    const withOutput = store.setThreadOutputLocation(thread.id, "C:\\outputs");
    store.setPhysicalContextSession(thread.id, "C:\\app\\threads\\thread-1\\pi\\session.jsonl");
    store.acknowledgePhysicalContext(thread.id, "event-7", 7);

    expect(profile).not.toHaveProperty("apiKey");
    expect(store.getEncryptedCredential(profile.credentialRef)).toEqual(encryptedCredential);
    expect(selected.activeProfileId).toBe(profile.id);
    expect(withOutput).toMatchObject({ outputLocation: "C:\\outputs", stateVersion: 2 });
    store.setAccessMode("full");
    expect(store.getAccessMode()).toBe("full");
    store.recordArtifact({
      schemaVersion: 1,
      id: "artifact-1",
      mediaType: "text/plain; charset=utf-8",
      producer: { type: "agent", id: "primary-agent" },
      destination: "C:\\outputs\\memo.txt",
      source: { threadId: thread.id, turnId: "turn-1", capabilityRequestId: "request-1" },
      createdAt: new Date().toISOString()
    });
    expect(store.listArtifacts(thread.id)).toMatchObject([{ id: "artifact-1", mediaType: "text/plain; charset=utf-8", source: { turnId: "turn-1" } }]);
    expect(store.getPhysicalContext(thread.id)).toMatchObject({ highWaterEventId: "event-7", highWaterSequence: 7 });
    expect(store.getBootstrapState("0.1.0", idleActivity).entityCounts).toMatchObject({ threads: 1, modelProfiles: 1 });
    store.close();
  });

  it("registers stable Projects, authorizes explicit Profiles, and isolates Project Threads", () => {
    const { store } = createStore();
    const createdAt = new Date().toISOString();
    const project = store.registerProject({
      id: crypto.randomUUID(), displayName: "Acme", path: "C:\\deals\\Acme", createdAt
    });
    const profile = store.createModelProfile({
      name: "Research", provider: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "off", encryptedCredential: new Uint8Array([1])
    });
    const first = store.createProjectThread(project.id, "Thesis");
    const second = store.createProjectThread(project.id, "Diligence");
    store.selectThreadProfile(first.id, profile.id);
    store.authorizeProjectProfile(project.id, profile.id, profile.provider);
    store.setPhysicalContextSession(first.id, "C:\\sessions\\first.jsonl");
    store.setPhysicalContextSession(second.id, "C:\\sessions\\second.jsonl");

    expect(store.listProjects()).toEqual([project]);
    expect(store.listProjectThreads(project.id)).toMatchObject([
      { id: first.id, scope: "project", projectId: project.id, activeProfileId: profile.id },
      { id: second.id, scope: "project", projectId: project.id }
    ]);
    expect(store.isProjectProfileAuthorized(project.id, profile.id)).toBe(true);
    expect(store.getPhysicalContext(first.id)?.sessionFile).not.toBe(store.getPhysicalContext(second.id)?.sessionFile);
    expect(store.getBootstrapState("0.1.0", idleActivity).entityCounts).toMatchObject({ projects: 1, threads: 2 });
    store.close();
  });

  it("persists Task Model Assignments and resumable Reflection run state without default configuration", () => {
    const { store, databasePath } = createStore();
    const project = store.registerProject({ id: crypto.randomUUID(), displayName: "Reflection Project", path: "C:\\deals\\reflection", createdAt: new Date().toISOString() });
    const prompt = store.ensureDefaultSystemPrompt("Minimal VC prompt");
    const brief = {
      schemaVersion: 1 as const,
      projectId: project.id,
      sourceVersion: "a".repeat(64),
      createdAt: "2026-07-19T08:00:00.000Z",
      contextFields: [{ id: "industry", label: "Industry", value: "Industrial software" }],
      materialCards: [{ materialId: crypto.randomUUID(), displayName: "memo.pdf", mediaType: "application/pdf", size: 42, modifiedAt: "2026-07-18T08:00:00.000Z", parseStatus: "unparsed" as const }],
      recordReferences: []
    };
    expect(store.listTaskModelAssignments()).toEqual([]);
    const waiting = store.createReflectionRun({ projectId: project.id, framing: "reflection", objective: "Review this Project", brief, promptRevision: prompt });
    expect(waiting).toMatchObject({ status: "awaiting_profile", promptSnapshot: { revisionId: prompt.id, hash: prompt.hash }, brief: { sourceVersion: "a".repeat(64) } });
    expect(store.getThread(waiting.threadId)).toMatchObject({ title: "Investment Reflection", scope: "project", projectId: project.id });

    const profile = store.createModelProfile({ name: "Independent evidence", provider: "fixture", model: "evidence-model", thinkingLevel: "off", encryptedCredential: new Uint8Array([1]) });
    expect(store.setTaskModelAssignment("independent_evidence", profile.id)).toMatchObject({ taskType: "independent_evidence", profileId: profile.id });
    expect(store.getBootstrapState("0.1.0", idleActivity).entityCounts.taskAssignments).toBe(1);
    let run = store.selectReflectionProfile(waiting.id, profile.id, false);
    expect(run).toMatchObject({ status: "ready", independentProfileId: profile.id });
    run = store.markReflectionRunning(run.id);
    run = store.setReflectionSession(run.id, "C:\\app\\reflection\\session.jsonl");
    run = store.completeIndependentAssessment(run.id, {
      schemaVersion: 1,
      conclusion: "The current case remains uncertain.",
      rationale: ["Evidence supports demand but not repeatability."],
      uncertainties: ["Retention is unverified."],
      counterarguments: ["Early cohorts may understate expansion."],
      evidenceReferences: [{ referenceId: "material-1#page=4", claim: "Demand is concentrated.", support: "mixed" }],
      decisionChangingQuestions: ["Do later cohorts retain?"],
      createdAt: "2026-07-19T09:00:00.000Z"
    });
    expect(run).toMatchObject({ status: "independent_completed", sessionFile: "C:\\app\\reflection\\session.jsonl", assessment: { conclusion: "The current case remains uncertain." } });
    store.createSystemPromptRevision("Changed prompt after run creation", "Must not alter snapshot");
    expect(store.getReflectionRun(run.id)?.promptSnapshot).toEqual({ revisionId: prompt.id, hash: prompt.hash });
    expect(store.clearTaskModelAssignment("independent_evidence")).toBe(true);
    store.close();

    const reopened = new HostStateStore(databasePath);
    expect(reopened.getReflectionRun(run.id)).toMatchObject({ status: "independent_completed", assessment: { decisionChangingQuestions: ["Do later cohorts retain?"] } });
    expect(reopened.listTaskModelAssignments()).toEqual([]);
    expect(reopened.getBootstrapState("0.1.0", idleActivity).runtimeActivity).toEqual(idleActivity);
    reopened.close();
  });

  it("persists a sanitized Independent Evidence failure for explicit retry", () => {
    const { store } = createStore();
    const project = store.registerProject({ id: crypto.randomUUID(), displayName: "Failed Reflection", path: "C:\\deals\\failed", createdAt: new Date().toISOString() });
    const prompt = store.ensureDefaultSystemPrompt("Minimal VC prompt");
    const profile = store.createModelProfile({ name: "Failed evidence", provider: "fixture", model: "failed-model", thinkingLevel: "off", encryptedCredential: new Uint8Array([1]) });
    const run = store.createReflectionRun({
      projectId: project.id, framing: "retrospective", objective: "Review whether the earlier judgment held", focus: "Later customer outcomes", promptRevision: prompt, independentProfileId: profile.id,
      brief: { schemaVersion: 1, projectId: project.id, sourceVersion: "b".repeat(64), createdAt: new Date().toISOString(), contextFields: [], materialCards: [], recordReferences: [] }
    });
    store.markReflectionRunning(run.id);
    expect(store.failIndependentAssessment(run.id, { kind: "provider", code: "PROVIDER_REJECTED", message: "Sanitized provider failure", provider: "fixture", model: "failed-model" })).toMatchObject({
      framing: "retrospective", status: "independent_failed", failure: { code: "PROVIDER_REJECTED", message: "Sanitized provider failure" }
    });
    expect(() => store.completeIndependentAssessment(run.id, { schemaVersion: 1, conclusion: "Invalid late result", rationale: [], uncertainties: [], counterarguments: [], evidenceReferences: [], decisionChangingQuestions: [], createdAt: new Date().toISOString() })).toThrow("Reflection run is not active");
    store.close();
  });

  it("recovers unfinished Independent Evidence as interrupted without model work", () => {
    const { store } = createStore();
    const project = store.registerProject({ id: crypto.randomUUID(), displayName: "Interrupted Reflection", path: "C:\\deals\\interrupted", createdAt: new Date().toISOString() });
    const prompt = store.ensureDefaultSystemPrompt("Minimal VC prompt");
    const profile = store.createModelProfile({ name: "Evidence", provider: "fixture", model: "evidence-model", thinkingLevel: "off", encryptedCredential: new Uint8Array([1]) });
    const run = store.createReflectionRun({ projectId: project.id, framing: "reflection", objective: "Review this Project", promptRevision: prompt, independentProfileId: profile.id, brief: { schemaVersion: 1, projectId: project.id, sourceVersion: "c".repeat(64), createdAt: new Date().toISOString(), contextFields: [], materialCards: [], recordReferences: [] } });
    store.markReflectionRunning(run.id);
    expect(store.recoverInterruptedReflections()).toMatchObject([{ id: run.id, status: "independent_interrupted" }]);
    expect(store.recoverInterruptedReflections()).toEqual([]);
    expect(store.getBootstrapState("0.1.0", idleActivity).runtimeActivity).toEqual(idleActivity);
    store.close();
  });

  it("persists the isolated Memory-Aware Profile and explicit dialogue lifecycle", () => {
    const { store } = createStore();
    const project = store.registerProject({ id: crypto.randomUUID(), displayName: "Memory Reflection", path: "C:\\deals\\memory-reflection", createdAt: new Date().toISOString() });
    const prompt = store.ensureDefaultSystemPrompt("Frozen VC prompt");
    const evidenceProfile = store.createModelProfile({ name: "Evidence", provider: "fixture-a", model: "evidence", thinkingLevel: "off", encryptedCredential: new Uint8Array([1]) });
    const dialogueProfile = store.createModelProfile({ name: "Dialogue", provider: "fixture-b", model: "dialogue", thinkingLevel: "medium", encryptedCredential: new Uint8Array([2]) });
    let run = store.createReflectionRun({ projectId: project.id, framing: "reflection", objective: "Review this Project", promptRevision: prompt, independentProfileId: evidenceProfile.id, brief: { schemaVersion: 1, projectId: project.id, sourceVersion: "e".repeat(64), createdAt: new Date().toISOString(), contextFields: [], materialCards: [], recordReferences: [] } });
    store.markReflectionRunning(run.id);
    run = store.completeIndependentAssessment(run.id, { schemaVersion: 1, conclusion: "Uncertain", rationale: [], uncertainties: ["Retention"], counterarguments: [], evidenceReferences: [], decisionChangingQuestions: ["Month six?"], createdAt: new Date().toISOString() });
    run = store.startMemoryAwareReflection(run.id, dialogueProfile.id, "memory-turn-1");
    expect(run).toMatchObject({ status: "memory_aware_running", memoryAwareProfileId: dialogueProfile.id, memoryInitialTurnId: "memory-turn-1" });
    expect(store.getThread(run.threadId)).toMatchObject({ activeProfileId: dialogueProfile.id, stateVersion: 2 });
    run = store.failMemoryAwareReflection(run.id, { kind: "provider", code: "REJECTED", message: "Sanitized", provider: "fixture-b", model: "dialogue" });
    expect(run.status).toBe("memory_aware_failed");
    run = store.startMemoryAwareReflection(run.id, dialogueProfile.id, "memory-turn-2");
    run = store.activateReflectionDialogue(run.id);
    expect(run).toMatchObject({ status: "dialogue_active", memoryInitialTurnId: "memory-turn-2" });
    expect(store.discardReflection(run.id).status).toBe("discarded");
    store.close();
  });

  it("migrates an existing Unscoped Thread into the Project-capable schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "vc-agent-state-v4-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "state.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope = 'unscoped'),
        active_profile_id TEXT,
        output_location TEXT,
        state_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO threads(id, title, scope, created_at) VALUES ('legacy-thread', 'Legacy', 'unscoped', '${new Date().toISOString()}');
    `);
    database.close();

    const store = new HostStateStore(databasePath);
    expect(store.getThread("legacy-thread")).toMatchObject({ id: "legacy-thread", title: "Legacy", scope: "unscoped" });
    expect(store.createProjectThread(store.registerProject({ id: crypto.randomUUID(), displayName: "New", path: "C:\\new", createdAt: new Date().toISOString() }).id, "Project thread")).toMatchObject({ scope: "project" });
    store.close();
  });

  it("stores reviewable System Prompt revisions and activates or restores them explicitly", () => {
    const { store } = createStore();
    const initial = store.ensureDefaultSystemPrompt("1. Default responsibility");
    const edited = store.createSystemPromptRevision("1. Revised responsibility", "Test a stricter posture");
    expect(store.getActiveSystemPromptRevision()?.id).toBe(initial.id);
    expect(edited).toMatchObject({ sourceRevisionId: initial.id, changeNote: "Test a stricter posture", source: "user_edit" });
    expect(edited.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(edited.diff).toContain("-1. Default responsibility");
    expect(edited.diff).toContain("+1. Revised responsibility");
    store.activateSystemPromptRevision(edited.id);
    expect(store.getActiveSystemPromptRevision()?.id).toBe(edited.id);
    const restored = store.restoreDefaultSystemPrompt("1. Default responsibility", "Restore");
    expect(store.getActiveSystemPromptRevision()?.id).toBe(restored.id);
    expect(store.listSystemPromptRevisions()).toHaveLength(3);
    store.close();
  });

  it("marks changed parsed Materials stale and preserves the prior parse after replacement failure", () => {
    const { store } = createStore();
    const project = store.registerProject({ id: crypto.randomUUID(), displayName: "Deal", path: "C:\\deal", createdAt: new Date().toISOString() });
    const firstHash = "a".repeat(64);
    const secondHash = "b".repeat(64);
    let result = store.refreshMaterialInventory(project.id, [{ relativePath: "memo.md", extension: ".md", mediaType: "text/markdown", size: 10, modifiedAt: new Date(1).toISOString(), sourceHash: firstHash }]);
    const materialId = result.materials[0]!.id;
    const parseId = store.recordParsedMaterialVersion(materialId, "markdown@1", "outputs/parsed/memo/parsed.json");
    expect(store.getMaterial(materialId)?.parseStatus).toBe("available");

    result = store.refreshMaterialInventory(project.id, [{ relativePath: "memo.md", extension: ".md", mediaType: "text/markdown", size: 20, modifiedAt: new Date(2).toISOString(), sourceHash: secondHash }]);
    expect(result.changedMaterialIds).toEqual([materialId]);
    expect(store.getMaterial(materialId)).toMatchObject({ parseStatus: "stale", parsedVersionCount: 1, sourceHash: secondHash });
    expect(store.getStaleMaterialRefreshContext(materialId)).toMatchObject({ previousSourceHash: firstHash, parserId: "markdown@1" });
    const refresh = store.resolveParseRefreshChoice(materialId, "replace_previous");
    store.failParseRefreshRequest(refresh.requestId, "Parser failed validation");
    expect(store.getMaterial(materialId)).toMatchObject({ parseStatus: "stale", parsedVersionCount: 1 });
    const database = new DatabaseSync(databasePathFor(store), { readOnly: true });
    const prior = database.prepare("SELECT status FROM parsed_material_versions WHERE id = ?").get(parseId) as { status: string };
    database.close();
    expect(prior.status).toBe("active");
    store.close();
  });
});

function sqliteBundle(databasePath: string): Record<string, string> {
  return Object.fromEntries([databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .filter((path) => existsSync(path))
    .map((path) => [path.slice(databasePath.length), readFileSync(path).toString("base64")]));
}

function databasePathFor(store: HostStateStore): string {
  return store.getBootstrapState("0.1.0", idleActivity).storagePath;
}
