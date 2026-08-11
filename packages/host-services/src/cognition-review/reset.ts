import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The reset is deliberately a Host-only operation.  The state adapter is a
 * small structural seam so this module does not need to know about Electron,
 * Pi sessions, Providers, or the renderer.  A HostStateStore satisfies this
 * interface after the persistence migration has been staged and validated.
 */
export interface LearningEpochResetStateAdapter {
  readonly statePreparation?: {
    readonly status?: string;
    readonly mode?: string;
    readonly storedVersion?: number;
    readonly supportedVersion?: number;
  };
  getCognitionCutoverStatus?: () => LearningEpochCutoverStatus;
  setCognitionCutoverStatus?: (status: LearningEpochCutoverStatus) => void;
}

export type LearningEpochCutoverStatus = "pending_reset" | "active" | "failed_reset";

export interface LearningEpochResetMigrationResult {
  readonly status?: string;
  readonly mode?: string;
  readonly storedVersion?: number;
  readonly supportedVersion?: number;
}

export interface LearningEpochResetFaultInjection {
  /** Fail before the first target is activated, during target activation, or while publishing the epoch. */
  readonly phase: "before_activation" | "activation" | "epoch";
  /** One-based target number for activation failures. `0` fails before activation. */
  readonly after?: number;
  /** Leave the durable reset manifest for restart recovery instead of rolling back immediately. */
  readonly mode?: "throw" | "crash";
}

export interface LearningEpochResetOptions {
  /** Explicit app-data root. It is the only implicit deletion boundary. */
  readonly appDataRoot: string;
  /** Existing Host state database used by the migration seam. */
  readonly databasePath?: string;
  /** Optional adapter (normally HostStateStore) for the v18 cutover marker. */
  readonly stateStore?: LearningEpochResetStateAdapter;
  /** Optional staged migration seam. The default assumes the caller already opened v18. */
  readonly migrateState?: () => LearningEpochResetMigrationResult;
  /** Restore the migration rollback bundle if file activation fails. */
  readonly rollbackState?: () => boolean;
  /** Explicit Project roots recorded by persistence. */
  readonly projectRoots?: readonly string[];
  /** Explicit Unscoped Output locations recorded by persistence. */
  readonly unscopedOutputRoots?: readonly string[];
  /** Additional exact cognition paths used by fixtures or a Host inventory. */
  readonly legacyTargets?: readonly string[];
  /** Fault injection is test-only and never inferred from environment state. */
  readonly faultInjection?: LearningEpochResetFaultInjection;
  readonly now?: () => Date | string;
}

export interface LearningEpochResetTarget {
  readonly path: string;
  readonly kind: "file" | "directory" | "missing";
  readonly scope: "app_data" | "project" | "unscoped_output" | "explicit";
}

export interface LearningEpochResetInspection {
  readonly schemaVersion: 1;
  readonly status: "ready" | "already_active" | "blocked" | "failed_reset";
  readonly manifestPath: string;
  readonly cognitionRoot: string;
  readonly targets: readonly LearningEpochResetTarget[];
  readonly diagnostics: readonly LearningEpochResetDiagnostic[];
}

export interface LearningEpochResetDiagnostic {
  readonly code:
    | "RESET_PATH_NOT_ABSOLUTE"
    | "RESET_PATH_OUTSIDE_ALLOWED_ROOT"
    | "RESET_PATH_SYMLINK"
    | "RESET_PATH_UNSUPPORTED_TYPE"
    | "RESET_TARGET_DUPLICATE"
    | "RESET_MANIFEST_INVALID"
    | "RESET_ACTIVE_EPOCH_INVALID"
    | "RESET_STATE_NOT_V18";
  readonly message: string;
  readonly path?: string;
}

export type LearningEpochResetResult =
  | {
      readonly schemaVersion: 1;
      readonly status: "reset" | "already_active";
      readonly mode: "read_write";
      readonly manifestPath: string;
      readonly cognitionRoot: string;
      readonly learningEpochStartedAt: string;
      readonly targets: readonly LearningEpochResetTarget[];
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "blocked" | "failed_reset";
      readonly mode: "read_only_recovery";
      readonly manifestPath: string;
      readonly cognitionRoot: string;
      readonly targets: readonly LearningEpochResetTarget[];
      readonly diagnostics: readonly LearningEpochResetDiagnostic[];
      readonly recoverable: boolean;
    };

interface NormalizedResetInput {
  readonly appDataRoot: string;
  readonly databasePath?: string;
  readonly stateStore: LearningEpochResetStateAdapter | undefined;
  readonly migrateState: (() => LearningEpochResetMigrationResult) | undefined;
  readonly rollbackState: (() => boolean) | undefined;
  readonly projectRoots: readonly string[];
  readonly unscopedOutputRoots: readonly string[];
  readonly legacyTargets: readonly string[];
  readonly faultInjection: LearningEpochResetFaultInjection | undefined;
  readonly now: () => Date | string;
}

interface ResetManifestTarget extends LearningEpochResetTarget {
  readonly backupPath: string;
  readonly existed: boolean;
  readonly beforeHash: string;
  activated: boolean;
}

interface ResetManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly appDataRoot: string;
  readonly cognitionRoot: string;
  readonly manifestPath: string;
  readonly backupRoot: string;
  readonly createdAt: string;
  readonly targets: ResetManifestTarget[];
  phase: "prepared" | "activating" | "committed";
  readonly epochStartedAt: string;
}

class LearningEpochResetFailure extends Error {
  readonly leaveJournal: boolean;

  constructor(message: string, leaveJournal = false) {
    super(message);
    this.name = "LearningEpochResetFailure";
    this.leaveJournal = leaveJournal;
  }
}

/**
 * One-shot Learning Epoch reset for the cognition-v2 cutover.
 *
 * Every target is resolved and canonical-checked before the first mutation.
 * Existing targets are renamed to a sibling backup, making rollback possible
 * even when a Project root lives on a different volume from app-data.  The
 * durable manifest records activation progress so a fresh instance can finish
 * or roll back after a process crash.
 */
export class LearningEpochReset {
  readonly #input: NormalizedResetInput;
  readonly #cognitionRoot: string;
  readonly #manifestPath: string;

  constructor(options: LearningEpochResetOptions) {
    this.#input = normalizeInput(options);
    this.#cognitionRoot = join(this.#input.appDataRoot, "cognition-v2");
    this.#manifestPath = join(this.#input.appDataRoot, ".cognition-reset", "manifest.json");
    // Recovery is intentionally local and deterministic. A prepared or
    // activating journal is rolled back; a committed journal is finalized.
    this.recover();
  }

  get manifestPath(): string { return this.#manifestPath; }
  get cognitionRoot(): string { return this.#cognitionRoot; }

  inspect(): LearningEpochResetInspection {
    const existing = readManifest(this.#manifestPath);
    const marker = this.#input.stateStore?.getCognitionCutoverStatus?.();
    const epoch = readEpoch(this.#cognitionRoot);
    // The committed manifest is cleaned up after activation.  On subsequent
    // launches the durable State marker plus the active epoch file is the
    // authoritative steady-state signal; do not reset newly-created v2 data.
    if (epoch !== undefined && (existing?.phase === "committed" || marker === "active")) {
      return {
        schemaVersion: 1,
        status: "already_active",
        manifestPath: this.#manifestPath,
        cognitionRoot: this.#cognitionRoot,
        targets: existing?.targets.map(stripManifestTarget) ?? [],
        diagnostics: []
      };
    }

    const diagnostics: LearningEpochResetDiagnostic[] = [];
    const targets = this.#resolveTargets(diagnostics);
    this.#validateStateVersion(diagnostics);
    if (marker === "active" && epoch === undefined) diagnostics.push({ code: "RESET_ACTIVE_EPOCH_INVALID", message: "The active cognition epoch marker has no valid epoch file; automatic reset is unsafe." });
    if (marker === "failed_reset") diagnostics.push({ code: "RESET_MANIFEST_INVALID", message: "The previous cognition cutover is in failed recovery state." });
    return {
      schemaVersion: 1,
      status: diagnostics.length === 0 ? "ready" : "blocked",
      manifestPath: this.#manifestPath,
      cognitionRoot: this.#cognitionRoot,
      targets,
      diagnostics
    };
  }

  /** Execute the reset and return a read-only recovery result on failure. */
  reset(): LearningEpochResetResult {
    const inspection = this.inspect();
    if (inspection.status === "already_active") {
      const epoch = readEpoch(this.#cognitionRoot);
      if (epoch !== undefined) return { schemaVersion: 1, status: "already_active", mode: "read_write", manifestPath: this.#manifestPath, cognitionRoot: this.#cognitionRoot, learningEpochStartedAt: epoch, targets: inspection.targets };
    }
    if (inspection.status === "blocked") {
      this.#markFailedReset();
      return { schemaVersion: 1, status: "blocked", mode: "read_only_recovery", manifestPath: this.#manifestPath, cognitionRoot: this.#cognitionRoot, targets: inspection.targets, diagnostics: inspection.diagnostics, recoverable: true };
    }

    let migrated = false;
    let manifest: ResetManifest | undefined;
    try {
      const migration = this.#input.migrateState?.();
      if (migration !== undefined) {
        migrated = migration.status === "migrated";
        if (migration.mode === "read_only_recovery" || (migration.supportedVersion !== undefined && migration.supportedVersion < 18)) {
          throw new LearningEpochResetFailure("State migration did not produce writable schema 18.");
        }
      }
      this.#setCutoverStatus("pending_reset");
      manifest = this.#prepareManifest(inspection.targets);
      this.#activate(manifest);
      this.#finalize(manifest);
      this.#setCutoverStatus("active");
      return { schemaVersion: 1, status: "reset", mode: "read_write", manifestPath: this.#manifestPath, cognitionRoot: this.#cognitionRoot, learningEpochStartedAt: manifest.epochStartedAt, targets: inspection.targets };
    } catch (error) {
      const leaveJournal = error instanceof LearningEpochResetFailure && error.leaveJournal;
      if (!leaveJournal && manifest !== undefined) {
        try { rollbackManifest(manifest); } catch { /* Recovery result remains read-only. */ }
        cleanupManifest(manifest);
      }
      // Host startup opens State v18 before invoking this reset.  In that
      // trajectory there is no `migrateState` callback to mark `migrated`,
      // yet a staged rollback bundle still must be restored if file
      // activation fails.  The adapter is idempotent and returns false when
      // no bundle exists, so invoking it whenever supplied is safe for both
      // the staged and already-open paths.
      if (migrated || this.#input.rollbackState !== undefined) {
        try { this.#input.rollbackState?.(); } catch { /* Preserve the failure diagnostic. */ }
      }
      this.#markFailedReset();
      const diagnostic: LearningEpochResetDiagnostic = { code: "RESET_MANIFEST_INVALID", message: error instanceof Error ? error.message : "Cognition reset failed." };
      return { schemaVersion: 1, status: "failed_reset", mode: "read_only_recovery", manifestPath: this.#manifestPath, cognitionRoot: this.#cognitionRoot, targets: inspection.targets, diagnostics: [diagnostic], recoverable: true };
    }
  }

  /** Alias used by Host cutover callers. */
  /** Recover a durable journal after application restart. */
  recover(): void {
    const manifest = readManifest(this.#manifestPath);
    if (manifest === undefined) return;
    if (manifest.schemaVersion !== 1 || manifest.appDataRoot !== this.#input.appDataRoot || manifest.cognitionRoot !== this.#cognitionRoot) {
      throw new Error("RESET_MANIFEST_INVALID");
    }
    if (manifest.phase === "committed") {
      this.#finalize(manifest);
      this.#setCutoverStatus("active");
      return;
    }
    rollbackManifest(manifest);
    cleanupManifest(manifest);
    this.#setCutoverStatus("pending_reset");
  }

  #validateStateVersion(diagnostics: LearningEpochResetDiagnostic[]): void {
    const state = this.#input.stateStore?.statePreparation;
    if (state?.mode === "read_only_recovery") diagnostics.push({ code: "RESET_STATE_NOT_V18", message: "State is already in read-only recovery mode." });
    if (state?.supportedVersion !== undefined && state.supportedVersion < 18) diagnostics.push({ code: "RESET_STATE_NOT_V18", message: "Cognition reset requires persistence schema 18." });
    if (state?.storedVersion !== undefined && state.storedVersion > 18) diagnostics.push({ code: "RESET_STATE_NOT_V18", message: "Stored state schema is newer than the cognition reset implementation." });
  }

  #resolveTargets(diagnostics: LearningEpochResetDiagnostic[]): LearningEpochResetTarget[] {
    const allowedRoots = [this.#input.appDataRoot, ...this.#input.projectRoots, ...this.#input.unscopedOutputRoots];
    const seen = new Set<string>();
    const targets: LearningEpochResetTarget[] = [];
    const add = (path: string, scope: LearningEpochResetTarget["scope"], allowedRoot: string): void => {
      const normalized = resolve(path);
      const key = pathKey(normalized);
      if (seen.has(key)) {
        diagnostics.push({ code: "RESET_TARGET_DUPLICATE", message: "Cognition reset target is listed more than once.", path: normalized });
        return;
      }
      seen.add(key);
      if (!isAbsolute(path)) {
        diagnostics.push({ code: "RESET_PATH_NOT_ABSOLUTE", message: "Cognition reset target must be absolute.", path });
        return;
      }
      if (!isContained(normalized, allowedRoot)) {
        diagnostics.push({ code: "RESET_PATH_OUTSIDE_ALLOWED_ROOT", message: "Cognition reset target escapes its explicit allowed root.", path: normalized });
        return;
      }
      const symlinkError = validateCanonicalContainment(normalized, allowedRoots);
      if (symlinkError !== undefined) {
        diagnostics.push({ ...symlinkError, path: normalized });
        return;
      }
      const kind = targetKind(normalized);
      if (kind === "unsupported") {
        diagnostics.push({ code: "RESET_PATH_UNSUPPORTED_TYPE", message: "Cognition reset target is not a regular file or directory.", path: normalized });
        return;
      }
      targets.push({ path: normalized, kind, scope });
    };

    const memoryRoot = join(this.#input.appDataRoot, "memory");
    const appTargets: readonly string[] = [
      this.#cognitionRoot,
      join(memoryRoot, "long-term"),
      join(memoryRoot, "long-term-index"),
      join(memoryRoot, "project-index"),
      join(memoryRoot, "candidates.jsonl"),
      join(memoryRoot, "pending-candidates.jsonl"),
      join(memoryRoot, "long-term-maintenance.json"),
      join(memoryRoot, "condensation-cleanup.jsonl"),
      join(memoryRoot, "local-memory-provenance.jsonl"),
      join(memoryRoot, "patches"),
      join(memoryRoot, "transactions"),
      join(memoryRoot, "dream"),
      join(memoryRoot, "reflection"),
      join(this.#input.appDataRoot, "reflection"),
      join(this.#input.appDataRoot, "dream"),
      join(this.#input.appDataRoot, "judgment-records"),
      join(this.#input.appDataRoot, "pending-candidates")
    ];
    for (const path of appTargets) add(path, "app_data", this.#input.appDataRoot);
    for (const path of this.#input.projectRoots) {
      add(join(path, "outputs", "system", "project-memory.md"), "project", path);
      add(join(path, "outputs", "system", "judgment-records"), "project", path);
      add(join(path, "outputs", "system", "reflection"), "project", path);
      add(join(path, "outputs", systemName("dream")), "project", path);
    }
    for (const path of this.#input.unscopedOutputRoots) {
      add(join(path, "judgment-records"), "unscoped_output", path);
      add(join(path, "reflection"), "unscoped_output", path);
      add(join(path, "dream"), "unscoped_output", path);
    }
    for (const path of this.#input.legacyTargets) {
      const explicitRoot = allowedRoots.find((root) => isContained(resolve(path), root)) ?? this.#input.appDataRoot;
      add(path, "explicit", explicitRoot);
    }
    return targets.sort((left, right) => left.path.localeCompare(right.path));
  }

  #prepareManifest(targets: readonly LearningEpochResetTarget[]): ResetManifest {
    const id = `reset-${randomUUID()}`;
    const manifestRoot = join(this.#input.appDataRoot, ".cognition-reset");
    const backupRoot = join(manifestRoot, id, "backups");
    mkdirSync(backupRoot, { recursive: true });
    const epochStartedAt = toIso(this.#input.now());
    const manifest: ResetManifest = {
      schemaVersion: 1,
      id,
      appDataRoot: this.#input.appDataRoot,
      cognitionRoot: this.#cognitionRoot,
      manifestPath: this.#manifestPath,
      backupRoot,
      createdAt: epochStartedAt,
      epochStartedAt,
      phase: "prepared",
      targets: targets.map((target, index) => ({
        ...target,
        // Project roots can live on another volume. Keep those rollback images
        // beside their target so activation remains a same-volume rename.
        backupPath: target.scope === "app_data" ? join(backupRoot, String(index)) : `${target.path}.cognition-reset-${id}-${index}.before`,
        existed: target.kind !== "missing",
        beforeHash: target.kind === "missing" ? "missing" : hashPath(target.path),
        activated: false
      }))
    };
    writeManifest(manifest);
    return manifest;
  }

  #activate(manifest: ResetManifest): void {
    manifest.phase = "activating";
    writeManifest(manifest);
    const fault = normalizeFault(this.#input.faultInjection);
    if (fault?.phase === "before_activation" || (fault?.phase === "activation" && fault.after === 0)) throw new LearningEpochResetFailure("Injected cognition reset activation failure.", fault.mode === "crash");
    for (let index = 0; index < manifest.targets.length; index += 1) {
      const target = manifest.targets[index]!;
      if (target.existed) renameSync(target.path, target.backupPath);
      target.activated = true;
      writeManifest(manifest);
      if (fault?.phase === "activation" && fault.after === index + 1) throw new LearningEpochResetFailure("Injected cognition reset activation failure.", fault.mode === "crash");
    }
    manifest.phase = "committed";
    writeManifest(manifest);
  }

  #finalize(manifest: ResetManifest): void {
    const fault = normalizeFault(this.#input.faultInjection);
    if (fault?.phase === "epoch") throw new LearningEpochResetFailure("Injected cognition reset epoch failure.", fault.mode === "crash");
    mkdirSync(this.#cognitionRoot, { recursive: true });
    for (const directory of ["reviews", "reflections", "batches", "patches", "work"]) mkdirSync(join(this.#cognitionRoot, directory), { recursive: true });
    atomicWrite(join(this.#cognitionRoot, "source-index.jsonl"), "");
    atomicWrite(join(this.#cognitionRoot, "epoch.json"), `${JSON.stringify({ schemaVersion: 1, learningEpochStartedAt: manifest.epochStartedAt, status: "active" })}\n`);
    for (const target of manifest.targets) if (existsSync(target.backupPath)) rmSync(target.backupPath, { recursive: true, force: true });
    cleanupManifest(manifest);
  }

  #setCutoverStatus(status: LearningEpochCutoverStatus): void {
    try { this.#input.stateStore?.setCognitionCutoverStatus?.(status); }
    catch { /* A read-only adapter is surfaced by the caller's result. */ }
  }

  #markFailedReset(): void { this.#setCutoverStatus("failed_reset"); }
}


function normalizeInput(options: LearningEpochResetOptions): NormalizedResetInput {
  if (!isAbsolute(options.appDataRoot)) throw new Error("RESET_APP_DATA_ROOT_NOT_ABSOLUTE");
  const appDataRoot = resolve(options.appDataRoot);
  assertRootIsCanonical(appDataRoot);
  const projectRoots = uniquePaths(options.projectRoots ?? []);
  const unscopedOutputRoots = uniquePaths(options.unscopedOutputRoots ?? []);
  for (const path of [...projectRoots, ...unscopedOutputRoots]) {
    if (!isAbsolute(path)) throw new Error("RESET_PATH_NOT_ABSOLUTE");
    assertRootIsCanonical(resolve(path));
  }
  const databasePath = options.databasePath;
  if (databasePath !== undefined && !isAbsolute(databasePath)) throw new Error("RESET_PATH_NOT_ABSOLUTE");
  return {
    appDataRoot,
    ...(databasePath === undefined ? {} : { databasePath: resolve(databasePath) }),
    stateStore: options.stateStore,
    migrateState: options.migrateState,
    rollbackState: options.rollbackState,
    projectRoots: projectRoots.map((path) => resolve(path)),
    unscopedOutputRoots: unscopedOutputRoots.map((path) => resolve(path)),
    legacyTargets: [...(options.legacyTargets ?? [])],
    faultInjection: options.faultInjection,
    now: options.now ?? (() => new Date())
  };
}

function normalizeFault(fault: LearningEpochResetFaultInjection | undefined): LearningEpochResetFaultInjection | undefined {
  if (fault === undefined) return undefined;
  const after = fault.after ?? (fault.phase === "activation" ? 1 : 0);
  if (!Number.isInteger(after) || after < 0) throw new Error("RESET_FAULT_AFTER_INVALID");
  return { ...fault, after };
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.map((path) => resolve(path)).filter((path) => {
    const key = pathKey(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pathKey(path: string): string { return process.platform === "win32" ? path.toLowerCase() : path; }

function isContained(path: string, root: string): boolean {
  const child = resolve(path);
  const boundary = `${resolve(root)}${sep}`;
  return pathKey(child) === pathKey(resolve(root)) || pathKey(child).startsWith(pathKey(boundary));
}

function validateCanonicalContainment(path: string, allowedRoots: readonly string[]): LearningEpochResetDiagnostic | undefined {
  const root = allowedRoots.find((candidate) => isContained(path, candidate));
  if (root === undefined) return { code: "RESET_PATH_OUTSIDE_ALLOWED_ROOT", message: "Cognition reset target escapes its explicit allowed root." };
  const rootPath = resolve(root);
  let current = rootPath;
  const suffix = relative(rootPath, resolve(path));
  for (const part of suffix === "" ? [] : suffix.split(sep)) {
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) return { code: "RESET_PATH_SYMLINK", message: "Cognition reset refuses symlink/junction targets." };
      if (info.isDirectory() || info.isFile()) {
        const canonical = realpathSync(current);
        if (!isContained(canonical, rootPath)) return { code: "RESET_PATH_SYMLINK", message: "Cognition reset canonical target escapes its explicit allowed root." };
      }
    } catch (error) {
      // A missing path is safe to plan, but a dangling symlink still has an
      // lstat entry and must not be treated as missing. ENOENT is the only
      // expected absence; all other failures remain a containment error.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      return { code: "RESET_PATH_SYMLINK", message: "Cognition reset could not validate target canonical path." };
    }
  }
  return undefined;
}

function assertRootIsCanonical(root: string): void {
  let info;
  try { info = lstatSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (info.isSymbolicLink()) throw new Error("RESET_PATH_SYMLINK");
  if (!info.isDirectory()) throw new Error("RESET_PATH_UNSUPPORTED_TYPE");
  if (pathKey(realpathSync(root)) !== pathKey(resolve(root))) throw new Error("RESET_PATH_SYMLINK");
}

function targetKind(path: string): LearningEpochResetTarget["kind"] | "unsupported" {
  let info;
  try { info = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
  if (info.isSymbolicLink()) return "unsupported";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "unsupported";
}

function hashPath(path: string): string {
  const info = lstatSync(path);
  const hash = createHash("sha256");
  if (info.isFile()) return hash.update(readFileSync(path)).digest("hex");
  if (info.isDirectory()) {
    for (const child of readdirSync(path).sort()) {
      const childPath = join(path, child);
      const childInfo = lstatSync(childPath);
      if (childInfo.isSymbolicLink()) throw new Error("RESET_PATH_SYMLINK");
      hash.update(child).update(childInfo.isDirectory() ? hashPath(childPath) : readFileSync(childPath));
    }
    return hash.digest("hex");
  }
  throw new Error("RESET_PATH_UNSUPPORTED_TYPE");
}

function stripManifestTarget(target: ResetManifestTarget): LearningEpochResetTarget { return { path: target.path, kind: target.kind, scope: target.scope }; }

function writeManifest(manifest: ResetManifest): void { atomicWrite(manifest.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`); }

function readManifest(path: string): ResetManifest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ResetManifest>;
    if (parsed.schemaVersion !== 1 || typeof parsed.id !== "string" || typeof parsed.appDataRoot !== "string" || typeof parsed.cognitionRoot !== "string" || typeof parsed.backupRoot !== "string" || !Array.isArray(parsed.targets) || !["prepared", "activating", "committed"].includes(parsed.phase ?? "")) return undefined;
    return parsed as ResetManifest;
  } catch { return undefined; }
}

function rollbackManifest(manifest: ResetManifest): void {
  for (const target of [...manifest.targets].reverse()) {
    if (!target.activated || !target.existed || !existsSync(target.backupPath)) continue;
    if (existsSync(target.path)) rmSync(target.path, { recursive: true, force: true });
    renameSync(target.backupPath, target.path);
    target.activated = false;
  }
}

function cleanupManifest(manifest: ResetManifest): void {
  rmSync(join(manifest.backupRoot, ".."), { recursive: true, force: true });
  rmSync(manifest.manifestPath, { force: true });
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, "utf8");
  try { renameSync(temporary, path); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}

function toIso(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.valueOf())) throw new Error("RESET_EPOCH_TIMESTAMP_INVALID");
  return date.toISOString();
}

function readEpoch(root: string): string | undefined {
  const path = join(root, "epoch.json");
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown; status?: unknown; learningEpochStartedAt?: unknown };
    return value.schemaVersion === 1 && value.status === "active" && typeof value.learningEpochStartedAt === "string" ? value.learningEpochStartedAt : undefined;
  } catch { return undefined; }
}

function systemName(name: string): string { return join("outputs", "system", name); }
