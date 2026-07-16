import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";
import { createEmptyApplicationState } from "@vc-agent/core";
import type { BootstrapState } from "@vc-agent/contracts";

const STATE_SCHEMA_VERSION = 1;
const nodeRequire = createRequire(process.execPath);
const sqliteModuleName = ["node", "sqlite"].join(":");
const { DatabaseSync } = nodeRequire(sqliteModuleName) as typeof import("node:sqlite");

export class HostStateStore {
  readonly #database: DatabaseSyncInstance;
  readonly #storagePath: string;

  constructor(storagePath: string) {
    mkdirSync(dirname(storagePath), { recursive: true });
    this.#storagePath = storagePath;
    this.#database = new DatabaseSync(storagePath);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    this.#database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(STATE_SCHEMA_VERSION, new Date().toISOString());
  }

  getBootstrapState(applicationVersion: string, externalNetworkRequests: number): BootstrapState {
    const emptyState = createEmptyApplicationState();
    return {
      applicationVersion,
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      storagePath: this.#storagePath,
      entityCounts: emptyState,
      runtimeActivity: {
        agentWorkersStarted: 0,
        piSessionsStarted: 0,
        providerRequests: 0,
        externalNetworkRequests
      }
    };
  }

  close(): void {
    this.#database.close();
  }
}
