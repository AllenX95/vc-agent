import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";
import type { AccessMode, ArtifactRecord, BootstrapState, ModelProfile, ThinkingLevel, UnscopedThread } from "@vc-agent/contracts";
export { ThreadTrajectoryStore } from "./thread-trajectory-store.js";

const STATE_SCHEMA_VERSION = 4;
const nodeRequire = createRequire(process.execPath);
const sqliteModuleName = ["node", "sqlite"].join(":");
const { DatabaseSync } = nodeRequire(sqliteModuleName) as typeof import("node:sqlite");

interface ProfileRow {
  id: string;
  name: string;
  provider: string;
  model: string;
  credential_ref: string;
  thinking_level: string;
  created_at: string;
  updated_at: string;
}

interface ThreadRow {
  id: string;
  title: string;
  active_profile_id: string | null;
  output_location: string | null;
  state_version: number;
  created_at: string;
}

export interface CreateModelProfileInput {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly encryptedCredential: Uint8Array;
}

export interface RuntimeActivitySnapshot {
  readonly agentWorkersStarted: number;
  readonly piSessionsStarted: number;
  readonly providerRequests: number;
  readonly externalNetworkRequests: number;
}

export interface PhysicalContextState {
  readonly threadId: string;
  readonly sessionFile: string;
  readonly highWaterEventId?: string;
  readonly highWaterSequence?: number;
}

export class HostStateStore {
  readonly #database: DatabaseSyncInstance;
  readonly #storagePath: string;

  constructor(storagePath: string) {
    mkdirSync(dirname(storagePath), { recursive: true });
    this.#storagePath = storagePath;
    this.#database = new DatabaseSync(storagePath);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#migrate();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    this.#database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)")
      .run(new Date().toISOString());

    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS protected_credentials (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        encrypted_value BLOB NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS model_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        credential_ref TEXT NOT NULL UNIQUE REFERENCES protected_credentials(id),
        thinking_level TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope = 'unscoped'),
        active_profile_id TEXT REFERENCES model_profiles(id),
        output_location TEXT,
        state_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS physical_contexts (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        session_file TEXT NOT NULL,
        high_water_event_id TEXT,
        high_water_sequence INTEGER,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS application_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        producer_type TEXT NOT NULL,
        producer_id TEXT NOT NULL,
        destination TEXT NOT NULL,
        source_thread_id TEXT NOT NULL REFERENCES threads(id),
        source_turn_id TEXT NOT NULL,
        capability_request_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    if (!this.#columnExists("threads", "output_location")) this.#database.exec("ALTER TABLE threads ADD COLUMN output_location TEXT");
    if (!this.#columnExists("threads", "state_version")) this.#database.exec("ALTER TABLE threads ADD COLUMN state_version INTEGER NOT NULL DEFAULT 1");
    this.#database.prepare("INSERT OR IGNORE INTO application_settings(key, value, updated_at) VALUES ('access_mode', 'standard', ?)").run(new Date().toISOString());
    this.#database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)")
      .run(new Date().toISOString());
    this.#database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)")
      .run(new Date().toISOString());
    this.#database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, ?)")
      .run(new Date().toISOString());
  }

  #columnExists(table: string, column: string): boolean {
    const rows = this.#database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  }

  getBootstrapState(applicationVersion: string, activity: RuntimeActivitySnapshot): BootstrapState {
    return {
      applicationVersion,
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      storagePath: this.#storagePath,
      accessMode: this.getAccessMode(),
      entityCounts: {
        projects: 0,
        threads: this.#count("threads"),
        modelProfiles: this.#count("model_profiles"),
        taskAssignments: 0
      },
      runtimeActivity: activity
    };
  }

  #count(table: "threads" | "model_profiles"): number {
    const row = this.#database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return Number(row.count);
  }

  createModelProfile(input: CreateModelProfileInput): ModelProfile {
    const id = randomUUID();
    const credentialRef = randomUUID();
    const now = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          "INSERT INTO protected_credentials(id, provider, encrypted_value, created_at) VALUES (?, ?, ?, ?)"
        )
        .run(credentialRef, input.provider, input.encryptedCredential, now);
      this.#database
        .prepare(
          `INSERT INTO model_profiles(
            id, name, provider, model, credential_ref, thinking_level, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.name, input.provider, input.model, credentialRef, input.thinkingLevel, now, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return { id, name: input.name, provider: input.provider, model: input.model, credentialRef, thinkingLevel: input.thinkingLevel, createdAt: now, updatedAt: now };
  }

  listModelProfiles(): ModelProfile[] {
    const rows = this.#database
      .prepare("SELECT * FROM model_profiles ORDER BY created_at ASC")
      .all() as unknown as ProfileRow[];
    return rows.map(mapProfile);
  }

  getModelProfile(id: string): ModelProfile | undefined {
    const row = this.#database.prepare("SELECT * FROM model_profiles WHERE id = ?").get(id) as
      | ProfileRow
      | undefined;
    return row === undefined ? undefined : mapProfile(row);
  }

  getEncryptedCredential(credentialRef: string): Uint8Array | undefined {
    const row = this.#database
      .prepare("SELECT encrypted_value FROM protected_credentials WHERE id = ?")
      .get(credentialRef) as { encrypted_value: Uint8Array } | undefined;
    return row?.encrypted_value;
  }

  createUnscopedThread(title: string): UnscopedThread {
    const thread: UnscopedThread = {
      id: randomUUID(),
      title,
      scope: "unscoped",
      stateVersion: 1,
      createdAt: new Date().toISOString()
    };
    this.#database
      .prepare("INSERT INTO threads(id, title, scope, created_at) VALUES (?, ?, 'unscoped', ?)")
      .run(thread.id, thread.title, thread.createdAt);
    return thread;
  }

  listUnscopedThreads(): UnscopedThread[] {
    const rows = this.#database.prepare("SELECT * FROM threads ORDER BY created_at ASC").all() as unknown as ThreadRow[];
    return rows.map(mapThread);
  }

  getUnscopedThread(id: string): UnscopedThread | undefined {
    const row = this.#database.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
    return row === undefined ? undefined : mapThread(row);
  }

  selectThreadProfile(threadId: string, profileId: string): UnscopedThread {
    const result = this.#database
      .prepare("UPDATE threads SET active_profile_id = ? WHERE id = ?")
      .run(profileId, threadId);
    if (result.changes !== 1) throw new Error("Thread not found");
    const thread = this.getUnscopedThread(threadId);
    if (thread === undefined) throw new Error("Thread not found");
    return thread;
  }

  getAccessMode(): AccessMode {
    const row = this.#database.prepare("SELECT value FROM application_settings WHERE key = 'access_mode'").get() as { value: string };
    if (row.value !== "standard" && row.value !== "full") throw new Error("Invalid persisted Access Mode");
    return row.value;
  }

  setAccessMode(mode: AccessMode): void {
    this.#database.prepare("UPDATE application_settings SET value = ?, updated_at = ? WHERE key = 'access_mode'").run(mode, new Date().toISOString());
  }

  setThreadOutputLocation(threadId: string, outputLocation: string): UnscopedThread {
    const result = this.#database.prepare(`
      UPDATE threads SET output_location = ?, state_version = state_version + 1 WHERE id = ?
    `).run(outputLocation, threadId);
    if (result.changes !== 1) throw new Error("Thread not found");
    return this.getUnscopedThread(threadId)!;
  }

  recordArtifact(artifact: ArtifactRecord): void {
    this.#database.prepare(`
      INSERT INTO artifacts(
        id, media_type, producer_type, producer_id, destination, source_thread_id,
        source_turn_id, capability_request_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.id,
      artifact.mediaType,
      artifact.producer.type,
      artifact.producer.id,
      artifact.destination,
      artifact.source.threadId,
      artifact.source.turnId,
      artifact.source.capabilityRequestId,
      artifact.createdAt
    );
  }

  listArtifacts(threadId: string): ArtifactRecord[] {
    const rows = this.#database.prepare("SELECT * FROM artifacts WHERE source_thread_id = ? ORDER BY created_at").all(threadId) as unknown as Array<{
      id: string; media_type: string; producer_type: ArtifactRecord["producer"]["type"]; producer_id: string;
      destination: string; source_thread_id: string; source_turn_id: string; capability_request_id: string; created_at: string;
    }>;
    return rows.map((row) => ({
      schemaVersion: 1,
      id: row.id,
      mediaType: row.media_type,
      producer: { type: row.producer_type, id: row.producer_id },
      destination: row.destination,
      source: { threadId: row.source_thread_id, turnId: row.source_turn_id, capabilityRequestId: row.capability_request_id },
      createdAt: row.created_at
    }));
  }

  getPhysicalContext(threadId: string): PhysicalContextState | undefined {
    const row = this.#database.prepare("SELECT * FROM physical_contexts WHERE thread_id = ?").get(threadId) as
      | { thread_id: string; session_file: string; high_water_event_id: string | null; high_water_sequence: number | null }
      | undefined;
    if (row === undefined) return undefined;
    return {
      threadId: row.thread_id,
      sessionFile: row.session_file,
      ...(row.high_water_event_id === null ? {} : { highWaterEventId: row.high_water_event_id }),
      ...(row.high_water_sequence === null ? {} : { highWaterSequence: row.high_water_sequence })
    };
  }

  setPhysicalContextSession(threadId: string, sessionFile: string): void {
    this.#database.prepare(`
      INSERT INTO physical_contexts(thread_id, session_file, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET session_file = excluded.session_file, updated_at = excluded.updated_at
    `).run(threadId, sessionFile, new Date().toISOString());
  }

  acknowledgePhysicalContext(threadId: string, eventId: string, sequence: number): void {
    const result = this.#database.prepare(`
      UPDATE physical_contexts
      SET high_water_event_id = ?, high_water_sequence = ?, updated_at = ?
      WHERE thread_id = ?
    `).run(eventId, sequence, new Date().toISOString(), threadId);
    if (result.changes !== 1) throw new Error("Physical context is not registered");
  }

  close(): void {
    this.#database.close();
  }
}

function mapProfile(row: ProfileRow): ModelProfile {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    credentialRef: row.credential_ref,
    thinkingLevel: row.thinking_level as ThinkingLevel,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapThread(row: ThreadRow): UnscopedThread {
  return {
    id: row.id,
    title: row.title,
    scope: "unscoped",
    ...(row.active_profile_id === null ? {} : { activeProfileId: row.active_profile_id }),
    ...(row.output_location === null ? {} : { outputLocation: row.output_location }),
    stateVersion: row.state_version,
    createdAt: row.created_at
  };
}
