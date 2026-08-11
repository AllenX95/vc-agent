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
      stateSchemaVersion: 18,
      accessMode: "standard",
      entityCounts: { projects: 0, threads: 0, modelProfiles: 0, taskAssignments: 0 },
      runtimeActivity: idleActivity
    });
    store.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    const cutover = database.prepare("SELECT value FROM application_settings WHERE key = 'cognition_cutover_status'").get();
    database.close();
    expect(tables).toEqual(["application_settings", "artifacts", "execution_leases", "execution_queue", "materials", "model_profiles", "parse_refresh_requests", "parsed_material_versions", "physical_contexts", "project_provider_authorizations", "projects", "protected_credentials", "schema_migrations", "system_prompt_revisions", "task_model_assignments", "threads"]);
    expect(tables).not.toContain("reflection_runs");
    expect(cutover).toMatchObject({ value: "pending_reset" });
    expect(() => readFileSync(databasePath)).not.toThrow();
  });

  it("validates an older schema in staging before atomically activating it", () => {
    const { store, databasePath } = createStore();
    store.close();
    const old = new DatabaseSync(databasePath);
    old.prepare("DELETE FROM schema_migrations WHERE version IN (17, 18)").run();
    old.exec(`
      ALTER TABLE execution_leases RENAME TO execution_leases_v16;
      CREATE TABLE execution_leases (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('ordinary_turn', 'compaction', 'independent_evidence', 'memory_aware_reflection', 'dream_scope', 'dream_synthesis', 'extension_audit', 'internal_model_stage')),
        acquired_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO execution_leases(id, scope_key, kind, acquired_at)
        SELECT id, scope_key, kind, acquired_at FROM execution_leases_v16;
      DROP TABLE execution_leases_v16;
    `);
    old.prepare("INSERT INTO execution_leases(id, scope_key, kind, acquired_at) VALUES (?, ?, ?, ?)").run("extension-audit", "global", "extension_audit", new Date().toISOString());
    old.prepare("INSERT INTO execution_leases(id, scope_key, kind, acquired_at) VALUES (?, ?, ?, ?)").run("ordinary-lease", "global", "ordinary_turn", new Date().toISOString());
    old.prepare("DELETE FROM schema_migrations WHERE version = 16").run();
    old.exec("ALTER TABLE model_profiles DROP COLUMN max_output_tokens");
    old.exec("ALTER TABLE model_profiles DROP COLUMN context_window");
    old.prepare("DELETE FROM schema_migrations WHERE version = 15").run();
    old.exec("ALTER TABLE threads DROP COLUMN deleted_at");
    old.close();

    const migrated = new HostStateStore(databasePath);
    expect(migrated.statePreparation).toMatchObject({ status: "migrated", mode: "read_write", storedVersion: 18, rollbackAvailable: true });
    expect(migrated.getBootstrapState("0.1.0", idleActivity).stateSchemaVersion).toBe(18);
    expect(migrated.listExecutionLeases()).toEqual([expect.objectContaining({ id: "ordinary-lease", kind: "ordinary_turn" })]);
    migrated.setAccessMode("full");
    migrated.close();
    expect(listRollbackFiles(databasePath)).toContain("state.db");
    const verified = new DatabaseSync(databasePath, { readOnly: true });
    expect(verified.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toMatchObject({ version: 18 });
    expect((verified.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_leases'").get() as { sql: string }).sql).not.toContain("extension_audit");
    expect(verified.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reflection_runs'").get()).toBeUndefined();
    verified.close();
  });

  it("leaves the prior database bytes active when staging fails before activation", () => {
    const { store, databasePath } = createStore();
    store.close();
    const old = new DatabaseSync(databasePath);
    old.prepare("DELETE FROM schema_migrations WHERE version IN (10, 11, 12, 13, 14, 15, 16, 17, 18)").run();
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
    expect(recovery.statePreparation).toMatchObject({ status: "newer_state", mode: "read_only_recovery", storedVersion: 99, supportedVersion: 18 });
    expect(recovery.listThreads()).toEqual([]);
    expect(() => recovery.createUnscopedThread("Blocked")).toThrow();
    recovery.close();
    expect(sqliteBundle(databasePath)).toEqual(before);
    const destination = join(databasePath, "..", "raw-export");
    expect(exportRawStateBundle(databasePath, destination, { storedVersion: 99, supportedVersion: 17 })).toContain("manifest.json");
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

  it("stores academic source credentials as protected values and exposes status only", () => {
    const { store, databasePath } = createStore();
    expect(store.listAcademicCredentialStatuses()).toEqual([
      { source: "openalex", configured: false },
      { source: "github", configured: false },
      { source: "huggingface", configured: false }
    ]);

    const first = Uint8Array.from([7, 1, 9, 4]);
    expect(store.setAcademicCredential("openalex", first)).toContainEqual({ source: "openalex", configured: true });
    expect(store.getAcademicCredential("openalex")).toEqual(first);

    const replacement = Uint8Array.from([8, 2, 6]);
    store.setAcademicCredential("openalex", replacement);
    expect(store.getAcademicCredential("openalex")).toEqual(replacement);
    expect(store.clearAcademicCredential("openalex")).toContainEqual({ source: "openalex", configured: false });
    expect(store.getAcademicCredential("openalex")).toBeUndefined();
    store.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM protected_credentials WHERE id LIKE 'academic-source:%'").get()).toMatchObject({ count: 0 });
    database.close();
  });

  it("updates a saved Model Profile while preserving its protected credential", () => {
    const { store } = createStore();
    const encryptedCredential = Uint8Array.from([4, 2, 4, 2]);
    const original = store.createModelProfile({
      name: "Original",
      provider: "provider-before",
      model: "model-before",
      thinkingLevel: "off",
      encryptedCredential
    });

    const updated = store.updateModelProfile(original.id, {
      name: "Updated",
      provider: "provider-after",
      model: "model-after",
      thinkingLevel: "high",
      contextWindow: 200_000,
      maxOutputTokens: 32_000
    });

    expect(updated).toMatchObject({
      id: original.id,
      name: "Updated",
      provider: "provider-after",
      model: "model-after",
      thinkingLevel: "high",
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      credentialRef: original.credentialRef,
      createdAt: original.createdAt
    });
    expect(updated.updatedAt >= original.updatedAt).toBe(true);
    expect(store.getEncryptedCredential(original.credentialRef)).toEqual(encryptedCredential);
    store.close();
  });

  it("persists editable per-Thread execution queue drafts without automatically admitting them after restart", () => {
    const { store } = createStore();
    const profile = store.createModelProfile({ name: "Queue", provider: "fixture", model: "fixture", thinkingLevel: "off", encryptedCredential: new Uint8Array([1]) });
    const firstThread = store.createUnscopedThread("First");
    const secondThread = store.createUnscopedThread("Second");
    store.selectThreadProfile(firstThread.id, profile.id);
    const first = store.enqueueOrdinaryTurn({ threadId: firstThread.id, text: "First follow-up", reason: "thread_active", requestedProfileId: profile.id });
    const second = store.enqueueOrdinaryTurn({ threadId: secondThread.id, text: "Capacity follow-up", reason: "capacity" });
    const third = store.enqueueOrdinaryTurn({ threadId: firstThread.id, text: "Second follow-up", reason: "thread_active", retryOfTurnId: "turn-old", requestedProfileId: profile.id });

    expect(store.listExecutionQueue().map((item) => item.id)).toEqual([first.id, second.id, third.id]);
    expect(store.updateExecutionQueueItem(first.id, "Edited follow-up")).toMatchObject({ text: "Edited follow-up", requestedProfileId: profile.id });
    expect(store.reorderExecutionQueueItem(third.id, first.id).position).toBeLessThan(store.getExecutionQueueItem(first.id)!.position);
    expect(store.listExecutionQueue().filter((item) => item.threadId === firstThread.id).map((item) => item.id)).toEqual([third.id, first.id]);
    expect(store.recoverQueuedExecutionAsDrafts().every((item) => item.status === "draft")).toBe(true);
    expect(store.reactivateExecutionQueueItem(first.id).status).toBe("queued");
    expect(store.acquireExecutionLease({ id: "turn-running", scopeKey: firstThread.id, kind: "ordinary_turn" })).toMatchObject({ id: "turn-running", kind: "ordinary_turn" });
    expect(store.listExecutionLeases()).toHaveLength(1);
    expect(store.clearStaleExecutionLeases()).toBe(1);
    expect(store.listExecutionLeases()).toEqual([]);
    expect(store.cancelExecutionQueueItem(second.id)).toBe(true);
    expect(store.listExecutionQueue()).toMatchObject([
      { id: third.id, status: "draft", retryOfTurnId: "turn-old" },
      { id: first.id, status: "queued", text: "Edited follow-up" }
    ]);
    store.close();
  });

  it("exports and atomically replaces only allowlisted Personal Cognition state", () => {
    const { store } = createStore();
    const shipped = store.ensureDefaultSystemPrompt("Default VC prompt");
    const edited = store.createSystemPromptRevision("Edited VC prompt", "Personal revision");
    store.activateSystemPromptRevision(edited.id);
    const profile = store.createModelProfile({ name: "Memory Review", provider: "anthropic", model: "model-a", thinkingLevel: "low", encryptedCredential: new Uint8Array([7, 8, 9]) });
    store.setTaskModelAssignment("memory_review", profile.id);
    store.setAccessMode("full");
    const snapshot = store.exportPersonalCognitionState();
    expect(snapshot).toMatchObject({ schemaVersion: 1, accessMode: "full", activePromptRevisionId: edited.id });
    expect(snapshot.profiles[0]).not.toHaveProperty("credentialRef");
    expect(JSON.stringify(snapshot)).not.toContain("7,8,9");

    store.restoreDefaultSystemPrompt("Default VC prompt", "Changed after backup");
    store.replacePersonalCognitionState(snapshot);
    expect(store.getActiveSystemPromptRevision()?.id).toBe(edited.id);
    expect(store.getSystemPromptRevision(shipped.id)?.content).toBe("Default VC prompt");
    expect(store.listTaskModelAssignments()).toMatchObject([{ taskType: "memory_review", profileId: profile.id }]);
    const restoredProfile = store.getModelProfile(profile.id)!;
    expect(restoredProfile.credentialRef).toMatch(/^setup-required-/u);
    expect(store.getEncryptedCredential(restoredProfile.credentialRef)).toBeUndefined();
    const configured = store.setModelProfileCredential(restoredProfile.id, new Uint8Array([4, 5, 6]));
    expect(configured.credentialRef).not.toBe(restoredProfile.credentialRef);
    expect(store.getEncryptedCredential(configured.credentialRef)).toEqual(new Uint8Array([4, 5, 6]));
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
    store.enqueueOrdinaryTurn({ threadId: first.id, text: "Queued work", reason: "capacity" });
    store.recordArtifact({
      schemaVersion: 1,
      id: "project-thread-artifact",
      mediaType: "text/markdown",
      producer: { type: "agent", id: "primary-agent" },
      destination: "C:\\deals\\project\\outputs\\memo.md",
      source: { threadId: first.id, turnId: "turn-1", capabilityRequestId: "project-thread-request" },
      createdAt: new Date().toISOString()
    });

    expect(store.listProjects()).toEqual([project]);
    expect(store.listProjectThreads(project.id)).toMatchObject([
      { id: first.id, scope: "project", projectId: project.id, activeProfileId: profile.id },
      { id: second.id, scope: "project", projectId: project.id }
    ]);
    expect(store.isProjectProfileAuthorized(project.id, profile.id)).toBe(true);
    expect(store.getPhysicalContext(first.id)?.sessionFile).not.toBe(store.getPhysicalContext(second.id)?.sessionFile);
    expect(store.renameThread(first.id, "Investment Thesis")).toMatchObject({ id: first.id, title: "Investment Thesis", stateVersion: 2 });
    expect(store.getThread(first.id)?.title).toBe("Investment Thesis");
    expect(store.setThreadArchived(first.id, true)).toMatchObject({ id: first.id, archivedAt: expect.any(String) });
    expect(store.listThreads().find((thread) => thread.id === first.id)?.archivedAt).toEqual(expect.any(String));
    expect(store.setThreadArchived(first.id, false)).not.toHaveProperty("archivedAt");
    expect(store.deleteThread(first.id)).toBe(true);
    expect(store.getThread(first.id)).toBeUndefined();
    expect(store.listProjectThreads(project.id).map((thread) => thread.id)).toEqual([second.id]);
    expect(store.getPhysicalContext(first.id)).toBeUndefined();
    expect(store.listExecutionQueue().some((item) => item.threadId === first.id)).toBe(false);
    expect(store.listArtifacts(first.id)).toMatchObject([{ id: "project-thread-artifact" }]);
    expect(() => store.setThreadArchived(first.id, true)).toThrow("Thread not found");
    expect(() => store.renameThread(first.id, "Deleted")).toThrow("Thread not found");
    expect(store.getBootstrapState("0.1.0", idleActivity).entityCounts).toMatchObject({ projects: 1, threads: 1 });
    store.close();
  });

  it("round-trips the intent-level Reflection and Memory Review assignments", () => {
    const { store, databasePath } = createStore();
    const reflectionProfile = store.createModelProfile({ name: "Reflection", provider: "fixture", model: "reflection-model", thinkingLevel: "off", encryptedCredential: new Uint8Array([1]) });
    const memoryReviewProfile = store.createModelProfile({ name: "Memory Review", provider: "fixture", model: "memory-review-model", thinkingLevel: "low", encryptedCredential: new Uint8Array([2]) });

    expect(store.setTaskModelAssignment("reflection", reflectionProfile.id)).toMatchObject({ taskType: "reflection", profileId: reflectionProfile.id });
    expect(store.setTaskModelAssignment("memory_review", memoryReviewProfile.id)).toMatchObject({ taskType: "memory_review", profileId: memoryReviewProfile.id });
    expect(store.listTaskModelAssignments()).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskType: "reflection", profileId: reflectionProfile.id }),
      expect.objectContaining({ taskType: "memory_review", profileId: memoryReviewProfile.id })
    ]));
    store.close();

    const reopened = new HostStateStore(databasePath);
    expect(reopened.getTaskModelAssignment("reflection")).toMatchObject({ taskType: "reflection", profileId: reflectionProfile.id });
    expect(reopened.getTaskModelAssignment("memory_review")).toMatchObject({ taskType: "memory_review", profileId: memoryReviewProfile.id });
    reopened.close();
  });

  it("persists the automatic Memory Review policy against the configured assignment", () => {
    const { store, databasePath } = createStore();
    const profile = store.createModelProfile({ name: "Memory Review", provider: "fixture", model: "memory-review-model", thinkingLevel: "low", encryptedCredential: new Uint8Array([2]) });
    store.setTaskModelAssignment("memory_review", profile.id);
    const policy = {
      enabled: true,
      profileId: profile.id,
      minEligibleExchangeCount: 20,
      maxIntervalDays: 7,
      maxInputTokensPerRun: 32_000
    } as const;

    expect(store.getAutoMemoryReviewPolicy()).toBeUndefined();
    expect(store.setAutoMemoryReviewPolicy(policy)).toEqual(policy);
    store.ensureDefaultSystemPrompt("Prompt");
    expect(store.exportPersonalCognitionState()).toMatchObject({ autoMemoryReviewPolicy: policy });
    store.close();

    const reopened = new HostStateStore(databasePath);
    expect(reopened.getAutoMemoryReviewPolicy()).toEqual(policy);
    expect(() => reopened.setAutoMemoryReviewPolicy({ ...policy, profileId: "different-profile" })).toThrow("Memory Review Profile");
    reopened.close();
  });

  it("revokes automatic Memory Review consent when its assignment changes or is cleared", () => {
    const { store } = createStore();
    const first = store.createModelProfile({ name: "Memory Review A", provider: "fixture", model: "memory-review-a", thinkingLevel: "off", encryptedCredential: new Uint8Array([1]) });
    const second = store.createModelProfile({ name: "Memory Review B", provider: "fixture", model: "memory-review-b", thinkingLevel: "off", encryptedCredential: new Uint8Array([2]) });
    const policy = { enabled: true, profileId: first.id, minEligibleExchangeCount: 1, maxIntervalDays: 7, maxInputTokensPerRun: 10_000 } as const;

    store.setTaskModelAssignment("memory_review", first.id);
    store.setAutoMemoryReviewPolicy(policy);
    expect(store.setTaskModelAssignment("memory_review", second.id)).toMatchObject({ profileId: second.id });
    expect(store.getAutoMemoryReviewPolicy()).toBeUndefined();

    store.setAutoMemoryReviewPolicy({ ...policy, profileId: second.id });
    expect(store.clearTaskModelAssignment("memory_review")).toBe(true);
    expect(store.getAutoMemoryReviewPolicy()).toBeUndefined();
    expect(store.clearAutoMemoryReviewPolicy()).toBe(false);
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

  it("upgrades an untouched shipped System Prompt without overriding a user revision", () => {
    const { store } = createStore();
    const initial = store.ensureDefaultSystemPrompt("1. Original shipped responsibility");
    const upgraded = store.ensureDefaultSystemPrompt("1. Improved shipped responsibility");
    expect(upgraded).toMatchObject({
      source: "shipped_default",
      sourceRevisionId: initial.id,
      changeNote: "Updated shipped default"
    });
    expect(upgraded.id).not.toBe(initial.id);
    expect(store.getActiveSystemPromptRevision()?.id).toBe(upgraded.id);

    const userRevision = store.createSystemPromptRevision("1. Personal responsibility", "Keep my preference");
    store.activateSystemPromptRevision(userRevision.id);
    expect(store.ensureDefaultSystemPrompt("1. Later shipped responsibility").id).toBe(userRevision.id);
    expect(store.getActiveSystemPromptRevision()?.id).toBe(userRevision.id);
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
