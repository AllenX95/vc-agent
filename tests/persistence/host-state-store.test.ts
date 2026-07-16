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
      stateSchemaVersion: 2,
      entityCounts: { projects: 0, threads: 0, modelProfiles: 0, taskAssignments: 0 },
      runtimeActivity: idleActivity
    });
    store.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    database.close();
    expect(tables).toEqual(["model_profiles", "protected_credentials", "schema_migrations", "threads"]);
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

    expect(profile).not.toHaveProperty("apiKey");
    expect(store.getEncryptedCredential(profile.credentialRef)).toEqual(encryptedCredential);
    expect(selected.activeProfileId).toBe(profile.id);
    expect(store.getBootstrapState("0.1.0", idleActivity).entityCounts).toMatchObject({ threads: 1, modelProfiles: 1 });
    store.close();
  });
});
