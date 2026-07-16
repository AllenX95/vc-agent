import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { HostStateStore } from "@vc-agent/persistence";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("HostStateStore", () => {
  it("bootstraps only the Host schema and reports empty product state", () => {
    const directory = mkdtempSync(join(tmpdir(), "vc-agent-state-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "state.db");
    const store = new HostStateStore(databasePath);

    expect(store.getBootstrapState("0.1.0", 0)).toMatchObject({
      stateSchemaVersion: 1,
      entityCounts: { projects: 0, threads: 0, modelProfiles: 0, taskAssignments: 0 },
      runtimeActivity: {
        agentWorkersStarted: 0,
        piSessionsStarted: 0,
        providerRequests: 0,
        externalNetworkRequests: 0
      }
    });
    store.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    database.close();
    expect(tables).toEqual(["schema_migrations"]);
    expect(() => readFileSync(databasePath)).not.toThrow();
  });
});
