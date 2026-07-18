import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const STATE_SCHEMA_VERSION = 9;

export type StatePreparation =
  | { readonly status: "fresh" | "ready" | "migrated"; readonly mode: "read_write"; readonly storedVersion: number; readonly supportedVersion: number; readonly rollbackAvailable: boolean }
  | { readonly status: "newer_state" | "migration_failed"; readonly mode: "read_only_recovery"; readonly storedVersion: number; readonly supportedVersion: number; readonly rollbackAvailable: boolean; readonly diagnosticCode: string; readonly diagnosticMessage: string };

export interface StateMigrationTestOptions {
  readonly failAfterStageValidation?: boolean;
}

const nodeRequire = createRequire(process.execPath);
const sqliteModuleName = ["node", "sqlite"].join(":");
const { DatabaseSync } = nodeRequire(sqliteModuleName) as typeof import("node:sqlite");

export function prepareStateStorage(
  storagePath: string,
  migrate: (path: string) => void,
  options: StateMigrationTestOptions = {}
): StatePreparation {
  if (!existsSync(storagePath) || statSync(storagePath).size === 0) {
    return { status: "fresh", mode: "read_write", storedVersion: STATE_SCHEMA_VERSION, supportedVersion: STATE_SCHEMA_VERSION, rollbackAvailable: false };
  }
  const storedVersion = inspectStateVersion(storagePath);
  if (storedVersion > STATE_SCHEMA_VERSION) {
    return {
      status: "newer_state", mode: "read_only_recovery", storedVersion, supportedVersion: STATE_SCHEMA_VERSION, rollbackAvailable: false,
      diagnosticCode: "STATE_SCHEMA_NEWER_THAN_APPLICATION",
      diagnosticMessage: `Stored state schema ${storedVersion} is newer than supported schema ${STATE_SCHEMA_VERSION}.`
    };
  }
  if (storedVersion === STATE_SCHEMA_VERSION) {
    return { status: "ready", mode: "read_write", storedVersion, supportedVersion: STATE_SCHEMA_VERSION, rollbackAvailable: false };
  }

  const migrationRoot = join(dirname(storagePath), "migration");
  const stageDirectory = join(migrationRoot, "stage");
  const rollbackDirectory = join(migrationRoot, "rollback");
  rmSync(stageDirectory, { recursive: true, force: true });
  rmSync(rollbackDirectory, { recursive: true, force: true });
  mkdirSync(stageDirectory, { recursive: true });
  mkdirSync(rollbackDirectory, { recursive: true });
  const stagedPath = join(stageDirectory, basename(storagePath));
  copySqliteBundle(storagePath, stagedPath);
  copySqliteBundle(storagePath, join(rollbackDirectory, basename(storagePath)));
  let activationAttempted = false;
  try {
    migrate(stagedPath);
    validateCurrentState(stagedPath);
    if (options.failAfterStageValidation === true) throw new Error("Injected migration failure");
    activationAttempted = true;
    migrate(storagePath);
    validateCurrentState(storagePath);
    rmSync(stageDirectory, { recursive: true, force: true });
    return { status: "migrated", mode: "read_write", storedVersion: STATE_SCHEMA_VERSION, supportedVersion: STATE_SCHEMA_VERSION, rollbackAvailable: true };
  } catch {
    if (activationAttempted) restoreSqliteBundle(join(rollbackDirectory, basename(storagePath)), storagePath);
    rmSync(stageDirectory, { recursive: true, force: true });
    return {
      status: "migration_failed", mode: "read_only_recovery", storedVersion, supportedVersion: STATE_SCHEMA_VERSION, rollbackAvailable: true,
      diagnosticCode: "STATE_SCHEMA_MIGRATION_FAILED",
      diagnosticMessage: `State schema ${storedVersion} could not be migrated to schema ${STATE_SCHEMA_VERSION}; prior state remains active.`
    };
  }
}

export function inspectStateVersion(storagePath: string): number {
  const database = new DatabaseSync(immutableDatabaseUrl(storagePath), { readOnly: true });
  try {
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (table === undefined) return 0;
    const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };
    return Number(row.version);
  } finally {
    database.close();
  }
}

function validateCurrentState(storagePath: string): void {
  const database = new DatabaseSync(immutableDatabaseUrl(storagePath), { readOnly: true });
  try {
    const version = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };
    if (Number(version.version) !== STATE_SCHEMA_VERSION) throw new Error("Migration did not reach the supported schema");
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") throw new Error("Migrated database failed integrity validation");
    const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyFailures.length > 0) throw new Error("Migrated database failed foreign-key validation");
  } finally {
    database.close();
  }
}

export function immutableDatabaseUrl(storagePath: string): string {
  return `${pathToFileURL(storagePath).href}?immutable=1`;
}

function sqliteBundlePaths(path: string): string[] { return [path, `${path}-wal`, `${path}-shm`]; }

function copySqliteBundle(sourcePath: string, destinationPath: string): void {
  mkdirSync(dirname(destinationPath), { recursive: true });
  const sources = sqliteBundlePaths(sourcePath);
  const destinations = sqliteBundlePaths(destinationPath);
  sources.forEach((source, index) => { if (existsSync(source)) copyFileSync(source, destinations[index]!); });
}

function restoreSqliteBundle(sourcePath: string, destinationPath: string): void {
  for (const path of sqliteBundlePaths(destinationPath)) rmSync(path, { force: true });
  copySqliteBundle(sourcePath, destinationPath);
}

export function listRollbackFiles(storagePath: string): string[] {
  const directory = join(dirname(storagePath), "migration", "rollback");
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

export function exportRawStateBundle(
  storagePath: string,
  destination: string,
  versions: { readonly storedVersion: number; readonly supportedVersion: number }
): string[] {
  mkdirSync(destination, { recursive: false });
  const files = ["", "-wal", "-shm"].flatMap((suffix) => {
    const source = `${storagePath}${suffix}`;
    if (!existsSync(source)) return [];
    const file = `${basename(storagePath)}${suffix}`;
    copyFileSync(source, join(destination, file));
    return [file];
  });
  writeFileSync(join(destination, "manifest.json"), JSON.stringify({
    format: "vc-agent-raw-state",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    storedSchemaVersion: versions.storedVersion,
    supportedSchemaVersion: versions.supportedVersion,
    files
  }, null, 2), "utf8");
  return [...files, "manifest.json"];
}
