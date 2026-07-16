import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";
import type { AccessMode, ArtifactRecord, BootstrapState, MaterialInventoryItem, ModelProfile, Project, ProjectThread, SystemPromptRevision, ThinkingLevel, Thread, UnscopedThread } from "@vc-agent/contracts";
export { ThreadTrajectoryStore } from "./thread-trajectory-store.js";

const STATE_SCHEMA_VERSION = 7;
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
  scope: "unscoped" | "project";
  project_id: string | null;
  created_at: string;
}

interface ProjectRow {
  id: string;
  display_name: string;
  path: string;
  identity_status: "stable" | "path_bound";
  created_at: string;
  updated_at: string;
}

interface PromptRevisionRow {
  id: string;
  content: string;
  hash: string;
  source_revision_id: string | null;
  change_note: string | null;
  diff: string;
  source: SystemPromptRevision["source"];
  created_at: string;
}

interface MaterialRow {
  id: string; project_id: string; relative_path: string; extension: string; media_type: string;
  size: number; modified_at: string; source_hash: string; availability: "active" | "deleted";
}

interface ParsedMaterialRow {
  id: string; material_id: string; source_hash: string; parser_id: string; artifact_path: string;
  status: "active" | "source_unavailable"; created_at: string;
}

export interface RefreshInventoryRecord {
  readonly relativePath: string;
  readonly extension: string;
  readonly mediaType: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly sourceHash: string;
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
  readonly promptRevisionId?: string;
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

      CREATE TABLE IF NOT EXISTS system_prompt_revisions (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        hash TEXT NOT NULL,
        source_revision_id TEXT REFERENCES system_prompt_revisions(id),
        change_note TEXT,
        diff TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('shipped_default', 'user_edit', 'restore_default')),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS materials (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        extension TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        availability TEXT NOT NULL CHECK(availability IN ('active', 'deleted')),
        last_seen_at TEXT NOT NULL,
        UNIQUE(project_id, relative_path)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS parsed_material_versions (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        source_hash TEXT NOT NULL,
        parser_id TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'source_unavailable')),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS parse_refresh_requests (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        prior_parse_id TEXT NOT NULL REFERENCES parsed_material_versions(id),
        choice TEXT NOT NULL CHECK(choice IN ('create_new_version', 'replace_previous', 'cancel')),
        status TEXT NOT NULL CHECK(status IN ('pending_parse', 'cancelled', 'failed', 'completed')),
        created_at TEXT NOT NULL,
        failure TEXT
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
    if (!this.#columnExists("threads", "project_id")) this.#migrateProjects();
    if (!this.#columnExists("physical_contexts", "prompt_revision_id")) this.#database.exec("ALTER TABLE physical_contexts ADD COLUMN prompt_revision_id TEXT");
    this.#database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (5, ?)")
      .run(new Date().toISOString());
    this.#database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (6, ?)")
      .run(new Date().toISOString());
    this.#database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (7, ?)")
      .run(new Date().toISOString());
  }

  #migrateProjects(): void {
    this.#database.exec("PRAGMA foreign_keys = OFF");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          identity_status TEXT NOT NULL CHECK(identity_status IN ('stable', 'path_bound')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE threads_v5 (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          scope TEXT NOT NULL CHECK(scope IN ('unscoped', 'project')),
          project_id TEXT REFERENCES projects(id),
          active_profile_id TEXT REFERENCES model_profiles(id),
          output_location TEXT,
          state_version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          CHECK((scope = 'unscoped' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
        ) STRICT;
        INSERT INTO threads_v5(id, title, scope, project_id, active_profile_id, output_location, state_version, created_at)
          SELECT id, title, 'unscoped', NULL, active_profile_id, output_location, state_version, created_at FROM threads;
        DROP TABLE threads;
        ALTER TABLE threads_v5 RENAME TO threads;
        CREATE TABLE project_provider_authorizations (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL REFERENCES model_profiles(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          authorized_at TEXT NOT NULL,
          PRIMARY KEY(project_id, profile_id)
        ) STRICT;
      `);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON");
    }
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
        projects: this.#count("projects"),
        threads: this.#count("threads"),
        modelProfiles: this.#count("model_profiles"),
        taskAssignments: 0
      },
      runtimeActivity: activity
    };
  }

  #count(table: "projects" | "threads" | "model_profiles"): number {
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

  registerProject(input: { id: string; displayName: string; path: string; createdAt: string; identityStatus?: "stable" | "path_bound" }): Project {
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO projects(id, display_name, path, identity_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.id, input.displayName, input.path, input.identityStatus ?? "stable", input.createdAt, now);
    return this.getProject(input.id)!;
  }

  listProjects(): Project[] {
    return (this.#database.prepare("SELECT * FROM projects ORDER BY created_at").all() as unknown as ProjectRow[]).map(mapProject);
  }

  getProject(id: string): Project | undefined {
    const row = this.#database.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row === undefined ? undefined : mapProject(row);
  }

  getProjectByPath(path: string): Project | undefined {
    const row = this.#database.prepare("SELECT * FROM projects WHERE path = ?").get(path) as ProjectRow | undefined;
    return row === undefined ? undefined : mapProject(row);
  }

  moveProject(id: string, displayName: string, path: string): Project {
    const result = this.#database.prepare("UPDATE projects SET display_name = ?, path = ?, updated_at = ? WHERE id = ?")
      .run(displayName, path, new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error("Project not found");
    return this.getProject(id)!;
  }

  createProjectThread(projectId: string, title: string): ProjectThread {
    if (this.getProject(projectId) === undefined) throw new Error("Project not found");
    const thread: ProjectThread = {
      id: randomUUID(), title, scope: "project", projectId, stateVersion: 1, createdAt: new Date().toISOString()
    };
    this.#database.prepare("INSERT INTO threads(id, title, scope, project_id, created_at) VALUES (?, ?, 'project', ?, ?)")
      .run(thread.id, thread.title, projectId, thread.createdAt);
    return thread;
  }

  refreshMaterialInventory(projectId: string, records: readonly RefreshInventoryRecord[]): { materials: MaterialInventoryItem[]; changedMaterialIds: string[] } {
    if (this.getProject(projectId) === undefined) throw new Error("Project not found");
    const previous = new Map((this.#database.prepare("SELECT * FROM materials WHERE project_id = ?").all(projectId) as unknown as MaterialRow[]).map((row) => [row.relative_path, row]));
    const changed = new Set<string>();
    const now = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare("UPDATE materials SET availability = 'deleted' WHERE project_id = ?").run(projectId);
      const insert = this.#database.prepare(`
        INSERT INTO materials(id, project_id, relative_path, extension, media_type, size, modified_at, source_hash, availability, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
        ON CONFLICT(project_id, relative_path) DO UPDATE SET
          extension = excluded.extension, media_type = excluded.media_type, size = excluded.size,
          modified_at = excluded.modified_at, source_hash = excluded.source_hash,
          availability = 'active', last_seen_at = excluded.last_seen_at
      `);
      for (const record of records) {
        const prior = previous.get(record.relativePath);
        const id = prior?.id ?? randomUUID();
        if (prior === undefined || prior.source_hash !== record.sourceHash || prior.availability !== "active") changed.add(id);
        insert.run(id, projectId, record.relativePath, record.extension, record.mediaType, record.size, record.modifiedAt, record.sourceHash, now);
        previous.delete(record.relativePath);
      }
      for (const prior of previous.values()) if (prior.availability === "active") changed.add(prior.id);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return { materials: this.listMaterials(projectId), changedMaterialIds: [...changed] };
  }

  listMaterials(projectId: string): MaterialInventoryItem[] {
    const rows = this.#database.prepare("SELECT * FROM materials WHERE project_id = ? ORDER BY relative_path").all(projectId) as unknown as MaterialRow[];
    return rows.map((row) => this.#mapMaterial(row));
  }

  getMaterial(id: string): MaterialInventoryItem | undefined {
    const row = this.#database.prepare("SELECT * FROM materials WHERE id = ?").get(id) as MaterialRow | undefined;
    return row === undefined ? undefined : this.#mapMaterial(row);
  }

  recordParsedMaterialVersion(materialId: string, parserId: string, artifactPath: string, parseId: string = randomUUID()): string {
    const material = this.getMaterial(materialId);
    if (material === undefined) throw new Error("Material not found");
    this.#database.prepare(`
      INSERT INTO parsed_material_versions(id, material_id, source_hash, parser_id, artifact_path, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?)
    `).run(parseId, materialId, material.sourceHash, parserId, artifactPath, new Date().toISOString());
    return parseId;
  }

  getReusableParsedMaterial(materialId: string, parserId: string): ParsedMaterialRow | undefined {
    const material = this.getMaterial(materialId);
    if (material === undefined) return undefined;
    return this.#database.prepare(`
      SELECT * FROM parsed_material_versions
      WHERE material_id = ? AND source_hash = ? AND parser_id = ? AND status = 'active'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(materialId, material.sourceHash, parserId) as ParsedMaterialRow | undefined;
  }

  completeParseRefresh(requestId: string, parseId: string, parserId: string, artifactPath: string): { parseId: string; replacedArtifactPath?: string } {
    const request = this.#database.prepare(`
      SELECT id, material_id, prior_parse_id, choice FROM parse_refresh_requests WHERE id = ? AND status = 'pending_parse'
    `).get(requestId) as { id: string; material_id: string; prior_parse_id: string; choice: "create_new_version" | "replace_previous" } | undefined;
    if (request === undefined) throw new Error("Pending Parse Refresh Request not found");
    const material = this.getMaterial(request.material_id);
    if (material === undefined) throw new Error("Material not found");
    const prior = this.#database.prepare("SELECT artifact_path FROM parsed_material_versions WHERE id = ? AND status = 'active'").get(request.prior_parse_id) as { artifact_path: string } | undefined;
    if (prior === undefined) throw new Error("Prior Parse is no longer active");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`INSERT INTO parsed_material_versions(id, material_id, source_hash, parser_id, artifact_path, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)`)
        .run(parseId, material.id, material.sourceHash, parserId, artifactPath, new Date().toISOString());
      if (request.choice === "replace_previous") this.#database.prepare("UPDATE parsed_material_versions SET status = 'source_unavailable' WHERE id = ?").run(request.prior_parse_id);
      this.#database.prepare("UPDATE parse_refresh_requests SET status = 'completed' WHERE id = ?").run(requestId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return { parseId, ...(request.choice === "replace_previous" ? { replacedArtifactPath: prior.artifact_path } : {}) };
  }

  getStaleMaterialRefreshContext(materialId: string): { material: MaterialInventoryItem; previousSourceHash: string; parserId: string; priorReferences: number } | undefined {
    const material = this.getMaterial(materialId);
    if (material?.parseStatus !== "stale") return undefined;
    const prior = this.#database.prepare(`
      SELECT source_hash, parser_id FROM parsed_material_versions
      WHERE material_id = ? AND status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(materialId) as { source_hash: string; parser_id: string } | undefined;
    return prior === undefined ? undefined : { material, previousSourceHash: prior.source_hash, parserId: prior.parser_id, priorReferences: 0 };
  }

  resolveParseRefreshChoice(materialId: string, choice: "create_new_version" | "replace_previous" | "cancel"): { requestId: string; status: "pending_parse" | "cancelled" } {
    const context = this.getStaleMaterialRefreshContext(materialId);
    if (context === undefined) throw new Error("Material does not require Parse Refresh Choice");
    const prior = this.#database.prepare(`SELECT id FROM parsed_material_versions WHERE material_id = ? AND status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(materialId) as { id: string };
    const requestId = randomUUID();
    const status = choice === "cancel" ? "cancelled" as const : "pending_parse" as const;
    this.#database.prepare(`INSERT INTO parse_refresh_requests(id, material_id, prior_parse_id, choice, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(requestId, materialId, prior.id, choice, status, new Date().toISOString());
    return { requestId, status };
  }

  failParseRefreshRequest(requestId: string, failure: string): void {
    const result = this.#database.prepare("UPDATE parse_refresh_requests SET status = 'failed', failure = ? WHERE id = ? AND status = 'pending_parse'").run(failure, requestId);
    if (result.changes !== 1) throw new Error("Pending Parse Refresh Request not found");
  }

  #mapMaterial(row: MaterialRow): MaterialInventoryItem {
    const versions = this.#database.prepare("SELECT source_hash FROM parsed_material_versions WHERE material_id = ? AND status = 'active'").all(row.id) as Array<{ source_hash: string }>;
    return {
      id: row.id,
      projectId: row.project_id,
      relativePath: row.relative_path,
      extension: row.extension,
      mediaType: row.media_type,
      size: row.size,
      modifiedAt: row.modified_at,
      sourceHash: row.source_hash,
      parseStatus: versions.length === 0 ? "unparsed" : versions.some((version) => version.source_hash === row.source_hash) ? "available" : "stale",
      parsedVersionCount: versions.length,
      availability: row.availability
    };
  }

  listThreads(): Thread[] {
    return (this.#database.prepare("SELECT * FROM threads ORDER BY created_at ASC").all() as unknown as ThreadRow[]).map(mapThread);
  }

  listProjectThreads(projectId: string): ProjectThread[] {
    return (this.#database.prepare("SELECT * FROM threads WHERE scope = 'project' AND project_id = ? ORDER BY created_at").all(projectId) as unknown as ThreadRow[])
      .map(mapThread) as ProjectThread[];
  }

  getThread(id: string): Thread | undefined {
    const row = this.#database.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
    return row === undefined ? undefined : mapThread(row);
  }

  listUnscopedThreads(): UnscopedThread[] {
    const rows = this.#database.prepare("SELECT * FROM threads WHERE scope = 'unscoped' ORDER BY created_at ASC").all() as unknown as ThreadRow[];
    return rows.map(mapThread) as UnscopedThread[];
  }

  getUnscopedThread(id: string): UnscopedThread | undefined {
    const thread = this.getThread(id);
    return thread?.scope === "unscoped" ? thread : undefined;
  }

  selectThreadProfile(threadId: string, profileId: string): Thread {
    const result = this.#database
      .prepare("UPDATE threads SET active_profile_id = ? WHERE id = ?")
      .run(profileId, threadId);
    if (result.changes !== 1) throw new Error("Thread not found");
    const thread = this.getThread(threadId);
    if (thread === undefined) throw new Error("Thread not found");
    return thread;
  }

  authorizeProjectProfile(projectId: string, profileId: string, provider: string): void {
    this.#database.prepare(`
      INSERT INTO project_provider_authorizations(project_id, profile_id, provider, authorized_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, profile_id) DO UPDATE SET provider = excluded.provider, authorized_at = excluded.authorized_at
    `).run(projectId, profileId, provider, new Date().toISOString());
  }

  isProjectProfileAuthorized(projectId: string, profileId: string): boolean {
    return this.#database.prepare("SELECT 1 FROM project_provider_authorizations WHERE project_id = ? AND profile_id = ?").get(projectId, profileId) !== undefined;
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

  ensureDefaultSystemPrompt(content: string): SystemPromptRevision {
    const active = this.getActiveSystemPromptRevision();
    if (active !== undefined) return active;
    const revision = this.#createSystemPromptRevision({ content, source: "shipped_default" });
    this.#database.prepare("INSERT OR REPLACE INTO application_settings(key, value, updated_at) VALUES ('active_prompt_revision_id', ?, ?)")
      .run(revision.id, new Date().toISOString());
    return revision;
  }

  createSystemPromptRevision(content: string, changeNote?: string): SystemPromptRevision {
    const active = this.getActiveSystemPromptRevision();
    if (active === undefined) throw new Error("System Prompt is not initialized");
    return this.#createSystemPromptRevision({ content, source: "user_edit", sourceRevision: active, ...(changeNote === undefined ? {} : { changeNote }) });
  }

  restoreDefaultSystemPrompt(content: string, changeNote?: string): SystemPromptRevision {
    const active = this.getActiveSystemPromptRevision();
    if (active === undefined) throw new Error("System Prompt is not initialized");
    const revision = this.#createSystemPromptRevision({ content, source: "restore_default", sourceRevision: active, ...(changeNote === undefined ? {} : { changeNote }) });
    this.activateSystemPromptRevision(revision.id);
    return revision;
  }

  listSystemPromptRevisions(): SystemPromptRevision[] {
    const rows = this.#database.prepare("SELECT * FROM system_prompt_revisions ORDER BY created_at DESC, rowid DESC").all() as unknown as PromptRevisionRow[];
    return rows.map(mapPromptRevision);
  }

  getSystemPromptRevision(id: string): SystemPromptRevision | undefined {
    const row = this.#database.prepare("SELECT * FROM system_prompt_revisions WHERE id = ?").get(id) as PromptRevisionRow | undefined;
    return row === undefined ? undefined : mapPromptRevision(row);
  }

  getActiveSystemPromptRevision(): SystemPromptRevision | undefined {
    const setting = this.#database.prepare("SELECT value FROM application_settings WHERE key = 'active_prompt_revision_id'").get() as { value: string } | undefined;
    return setting === undefined ? undefined : this.getSystemPromptRevision(setting.value);
  }

  activateSystemPromptRevision(id: string): SystemPromptRevision {
    const revision = this.getSystemPromptRevision(id);
    if (revision === undefined) throw new Error("System Prompt Revision not found");
    this.#database.prepare("INSERT OR REPLACE INTO application_settings(key, value, updated_at) VALUES ('active_prompt_revision_id', ?, ?)")
      .run(id, new Date().toISOString());
    return revision;
  }

  #createSystemPromptRevision(input: {
    content: string;
    source: SystemPromptRevision["source"];
    sourceRevision?: SystemPromptRevision;
    changeNote?: string;
  }): SystemPromptRevision {
    const revision: SystemPromptRevision = {
      id: randomUUID(),
      content: input.content,
      hash: createHash("sha256").update(input.content, "utf8").digest("hex"),
      ...(input.sourceRevision === undefined ? {} : { sourceRevisionId: input.sourceRevision.id }),
      ...(input.changeNote?.trim() ? { changeNote: input.changeNote.trim() } : {}),
      diff: lineDiff(input.sourceRevision?.content ?? "", input.content),
      source: input.source,
      createdAt: new Date().toISOString()
    };
    this.#database.prepare(`
      INSERT INTO system_prompt_revisions(id, content, hash, source_revision_id, change_note, diff, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(revision.id, revision.content, revision.hash, revision.sourceRevisionId ?? null, revision.changeNote ?? null, revision.diff, revision.source, revision.createdAt);
    return revision;
  }

  getPhysicalContext(threadId: string): PhysicalContextState | undefined {
    const row = this.#database.prepare("SELECT * FROM physical_contexts WHERE thread_id = ?").get(threadId) as
      | { thread_id: string; session_file: string; high_water_event_id: string | null; high_water_sequence: number | null; prompt_revision_id: string | null }
      | undefined;
    if (row === undefined) return undefined;
    return {
      threadId: row.thread_id,
      sessionFile: row.session_file,
      ...(row.high_water_event_id === null ? {} : { highWaterEventId: row.high_water_event_id }),
      ...(row.high_water_sequence === null ? {} : { highWaterSequence: row.high_water_sequence }),
      ...(row.prompt_revision_id === null ? {} : { promptRevisionId: row.prompt_revision_id })
    };
  }

  setPhysicalContextSession(threadId: string, sessionFile: string, promptRevisionId?: string): void {
    this.#database.prepare(`
      INSERT INTO physical_contexts(thread_id, session_file, prompt_revision_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET session_file = excluded.session_file, prompt_revision_id = excluded.prompt_revision_id, updated_at = excluded.updated_at
    `).run(threadId, sessionFile, promptRevisionId ?? null, new Date().toISOString());
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

function mapThread(row: ThreadRow): Thread {
  const common = {
    id: row.id,
    title: row.title,
    ...(row.active_profile_id === null ? {} : { activeProfileId: row.active_profile_id }),
    stateVersion: row.state_version,
    createdAt: row.created_at
  };
  if (row.scope === "project") {
    if (row.project_id === null) throw new Error("Project Thread has no Project");
    return { ...common, scope: "project", projectId: row.project_id };
  }
  return { ...common, scope: "unscoped", ...(row.output_location === null ? {} : { outputLocation: row.output_location }) };
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    displayName: row.display_name,
    path: row.path,
    identityStatus: row.identity_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPromptRevision(row: PromptRevisionRow): SystemPromptRevision {
  return {
    id: row.id,
    content: row.content,
    hash: row.hash,
    ...(row.source_revision_id === null ? {} : { sourceRevisionId: row.source_revision_id }),
    ...(row.change_note === null ? {} : { changeNote: row.change_note }),
    diff: row.diff,
    source: row.source,
    createdAt: row.created_at
  };
}

function lineDiff(previous: string, next: string): string {
  if (previous === next) return "No content changes.";
  const before = previous.split("\n");
  const after = next.split("\n");
  const lines = ["--- source", "+++ revision"];
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    if (before[index] === after[index]) {
      if (before[index] !== undefined) lines.push(` ${before[index]}`);
      continue;
    }
    if (before[index] !== undefined) lines.push(`-${before[index]}`);
    if (after[index] !== undefined) lines.push(`+${after[index]}`);
  }
  return lines.join("\n");
}
