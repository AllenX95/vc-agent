import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { HostStateStore } from "@vc-agent/persistence";

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
      stateSchemaVersion: 5,
      accessMode: "standard",
      entityCounts: { projects: 0, threads: 0, modelProfiles: 0, taskAssignments: 0 },
      runtimeActivity: idleActivity
    });
    store.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    database.close();
    expect(tables).toEqual(["application_settings", "artifacts", "model_profiles", "physical_contexts", "project_provider_authorizations", "projects", "protected_credentials", "schema_migrations", "threads"]);
    expect(() => readFileSync(databasePath)).not.toThrow();
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
});
