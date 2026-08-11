import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Hash used by a transaction target that did not exist when it was prepared. */
export const JOURNALED_TRANSACTION_MISSING_HASH = "missing";

export type JournaledFileTransactionFaultPhase = "activation" | "commit-point" | "publication";

/**
 * Test-only fault injection.  `after` is the one-based target count for the
 * activation/publication phases.  A commit-point fault is injected after the
 * durable commit marker is written unless `beforeCommitPoint` is true.
 * `mode: "crash"` leaves the journal on disk so a fresh adapter can recover it.
 */
export interface JournaledFileTransactionFaultInjection {
  readonly phase: JournaledFileTransactionFaultPhase;
  readonly after?: number;
  readonly beforeCommitPoint?: boolean;
  readonly mode?: "throw" | "crash";
}

export interface JournaledFileTransactionTarget {
  readonly path: string;
  readonly baseHash: string;
  readonly afterContent: string;
}

export interface JournaledFileTransactionCommitInput {
  readonly id: string;
  readonly targets: readonly JournaledFileTransactionTarget[];
}

export interface JournaledFileTransactionTargetResult {
  readonly path: string;
  readonly hash: string;
}

export interface JournaledFileTransactionCommitResult {
  readonly id: string;
  readonly targets: readonly JournaledFileTransactionTargetResult[];
}

export interface JournaledFileTransactionAdapterOptions {
  /** Absolute directory in which durable transaction journals are kept. */
  readonly transactionRoot: string;
  /** Explicit caller-approved roots.  Target paths must be inside one root. */
  readonly allowedRoots: readonly string[] | (() => readonly string[]);
  readonly faultInjection?: JournaledFileTransactionFaultInjection;
}

export interface FileTransactionAdapter {
  /**
   * The caller holds an exclusive cognition read/write lease from the durable
   * commit point through publication, and invokes recover() before readers
   * are admitted after restart. The adapter does not coordinate readers.
   */
  commit(input: JournaledFileTransactionCommitInput): JournaledFileTransactionCommitResult;
  recover(): void;
}

type TransactionPhase = "prepared" | "committed";
type CommitPoint = "not_reached" | "durable";
type PublicationState = "pending" | "published";

interface TransactionManifestTarget {
  readonly path: string;
  readonly baseHash: string;
  readonly afterHash: string;
  readonly beforeHash: string;
  readonly beforeExisted: boolean;
  readonly beforeMode: number | null;
  readonly beforeImagePath: string;
  readonly afterImagePath: string;
  readonly stagedPath: string;
  readonly backupPath: string;
  activation: "pending" | "activated";
  publication: PublicationState;
}

interface TransactionManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  phase: TransactionPhase;
  commitPoint: CommitPoint;
  publication: "pending" | "complete";
  imagesReady: boolean;
  targets: TransactionManifestTarget[];
}

class InjectedTransactionFailure extends Error {
  readonly phase: JournaledFileTransactionFaultPhase;
  readonly leaveJournal: boolean;

  constructor(phase: JournaledFileTransactionFaultPhase, leaveJournal: boolean) {
    super(`JOURNALED_TRANSACTION_${phase === "commit-point" ? "COMMIT_POINT" : phase.toUpperCase()}_FAILURE`);
    this.name = "InjectedTransactionFailure";
    this.phase = phase;
    this.leaveJournal = leaveJournal;
  }
}

/**
 * Internal logical file transaction adapter used by Cognition Review.
 *
 * The adapter deliberately accepts only UTF-8 text after-images. It does not
 * infer path ownership: callers provide explicit allowed roots, while each
 * target is still required to be absolute and unique. A durable commit point
 * is recorded before any target publication; callers hold their cognition
 * read/write lease until publication finishes.
 */
export class JournaledFileTransactionAdapter implements FileTransactionAdapter {
  readonly #transactionRoot: string;
  readonly #allowedRoots: readonly string[] | (() => readonly string[]);
  readonly #faultInjection: JournaledFileTransactionFaultInjection | undefined;

  constructor(options: JournaledFileTransactionAdapterOptions) {
    if (!isAbsolute(options.transactionRoot)) throw new Error("JOURNALED_TRANSACTION_ROOT_NOT_ABSOLUTE");
    const configuredRoots = typeof options.allowedRoots === "function" ? options.allowedRoots() : options.allowedRoots;
    if (configuredRoots.length === 0) throw new Error("JOURNALED_TRANSACTION_ALLOWED_ROOTS_REQUIRED");
    this.#transactionRoot = resolve(options.transactionRoot);
    this.#allowedRoots = options.allowedRoots;
    this.#faultInjection = options.faultInjection;
    validateFaultInjection(this.#faultInjection);
    this.recover();
  }

  commit(input: JournaledFileTransactionCommitInput): JournaledFileTransactionCommitResult {
    this.recover();
    const targets = this.#validateInput(input);
    const transactionDirectory = join(this.#transactionRoot, input.id);
    if (existsSync(transactionDirectory)) throw new Error("JOURNALED_TRANSACTION_ID_IN_USE");
    mkdirSync(this.#transactionRoot, { recursive: true });
    mkdirSync(transactionDirectory, { recursive: true });

    let manifest: TransactionManifest | undefined;
    try {
      manifest = this.#createManifest(input.id, targets, transactionDirectory);
      // The intent is durable before any target is touched.  imagesReady keeps
      // recovery safe if an application exits while images are being written.
      writeManifest(transactionDirectory, manifest);
      this.#writeImages(manifest, targets);
      manifest.imagesReady = true;
      writeManifest(transactionDirectory, manifest);
      this.#assertBaseState(manifest);

      if (this.#faultInjection?.phase === "commit-point" && this.#faultInjection.beforeCommitPoint === true) {
        this.#inject("commit-point");
      }
      manifest.phase = "committed";
      manifest.commitPoint = "durable";
      writeManifest(transactionDirectory, manifest);
      if (this.#shouldInject("commit-point", 1)) this.#inject("commit-point");

      // Publication is intentionally after the durable commit point. Any
      // crash/failure from here onward is completed by restart recovery.
      if (this.#faultInjection?.phase === "activation" && (this.#faultInjection.after ?? 1) === 0) {
        this.#inject("activation");
      }
      for (let index = 0; index < manifest.targets.length; index += 1) {
        const target = manifest.targets[index]!;
        activateTarget(target);
        target.activation = "activated";
        writeManifest(transactionDirectory, manifest);
        if (this.#shouldInject("activation", index + 1)) this.#inject("activation");
      }

      this.#publish(manifest, transactionDirectory);
      return {
        id: input.id,
        targets: manifest.targets.map((target) => ({ path: target.path, hash: target.afterHash }))
      };
    } catch (error) {
      const current = manifest === undefined ? undefined : readManifest(transactionDirectory) ?? manifest;
      if (current?.phase === "committed") {
        // A durable commit point is authoritative.  Publication can safely be
        // resumed by startup recovery, so never roll it back here.
        throw error;
      }
      if (error instanceof InjectedTransactionFailure && error.leaveJournal) throw error;
      try {
        if (current !== undefined) rollbackPrepared(current);
      } finally {
        rmSync(transactionDirectory, { recursive: true, force: true });
        cleanupManifestArtifacts(current);
      }
      throw error;
    }
  }

  /** Recover every durable journal before cognition state is read or written. */
  recover(): void {
    if (!existsSync(this.#transactionRoot)) return;
    for (const name of readdirSync(this.#transactionRoot)) {
      const transactionDirectory = join(this.#transactionRoot, name);
      const manifestPath = join(transactionDirectory, "manifest.json");
      if (!existsSync(manifestPath)) {
        rmSync(transactionDirectory, { recursive: true, force: true });
        continue;
      }
      const manifest = readManifest(transactionDirectory);
      if (manifest === undefined) throw new Error("JOURNALED_TRANSACTION_MANIFEST_INVALID");
      this.#validateManifest(manifest, transactionDirectory);
      if (manifest.phase === "prepared") {
        rollbackPrepared(manifest);
        rmSync(transactionDirectory, { recursive: true, force: true });
        cleanupManifestArtifacts(manifest);
      } else {
        this.#publish(manifest, transactionDirectory, false);
      }
    }
  }

  #validateInput(input: JournaledFileTransactionCommitInput): PreparedTarget[] {
    if (!isValidTransactionId(input.id)) throw new Error("JOURNALED_TRANSACTION_ID_INVALID");
    if (input.targets.length === 0) throw new Error("JOURNALED_TRANSACTION_TARGETS_REQUIRED");
    const seen = new Set<string>();
    return input.targets.map((inputTarget) => {
      if (!isAbsolute(inputTarget.path)) throw new Error("JOURNALED_TRANSACTION_TARGET_NOT_ABSOLUTE");
      if (typeof inputTarget.afterContent !== "string") throw new Error("JOURNALED_TRANSACTION_AFTER_CONTENT_MUST_BE_UTF8_TEXT");
      const path = resolve(inputTarget.path);
      const key = process.platform === "win32" ? path.toLowerCase() : path;
      if (seen.has(key)) throw new Error("JOURNALED_TRANSACTION_DUPLICATE_TARGET");
      seen.add(key);
      this.#validateTargetPath(path);
      const baseHash = normalizeHash(inputTarget.baseHash);
      const state = fileState(path);
      if (state.hash !== baseHash) throw new Error("JOURNALED_TRANSACTION_BASE_HASH_MISMATCH");
      return {
        path,
        baseHash,
        afterContent: inputTarget.afterContent,
        beforeExisted: state.existed,
        beforeMode: state.mode
      };
    });
  }

  #createManifest(id: string, targets: readonly PreparedTarget[], transactionDirectory: string): TransactionManifest {
    return {
      schemaVersion: 1,
      id,
      phase: "prepared",
      commitPoint: "not_reached",
      publication: "pending",
      imagesReady: false,
      targets: targets.map((target, index) => {
        const token = `.vc-agent-${id}-${index}`;
        return {
          path: target.path,
          baseHash: target.baseHash,
          afterHash: hashText(target.afterContent),
          beforeHash: target.beforeExisted ? target.baseHash : JOURNALED_TRANSACTION_MISSING_HASH,
          beforeExisted: target.beforeExisted,
          beforeMode: target.beforeMode,
          beforeImagePath: join(transactionDirectory, `${index}.before`),
          afterImagePath: join(transactionDirectory, `${index}.after`),
          stagedPath: join(dirname(target.path), `${token}.after`),
          backupPath: join(dirname(target.path), `${token}.before`),
          activation: "pending",
          publication: "pending"
        };
      })
    };
  }

  #writeImages(manifest: TransactionManifest, preparedTargets: readonly PreparedTarget[]): void {
    for (const [index, target] of manifest.targets.entries()) {
      const prepared = preparedTargets[index]!;
      if (!existsSync(dirname(target.path))) throw new Error("JOURNALED_TRANSACTION_TARGET_PARENT_MISSING");
      writeDurableText(target.afterImagePath, prepared.afterContent);
      writeDurableText(target.stagedPath, prepared.afterContent);
      if (target.beforeExisted) {
        writeDurableBytes(target.beforeImagePath, readFileSync(target.path));
        if (target.beforeMode !== null) chmodSync(target.stagedPath, target.beforeMode);
      }
    }
  }

  #assertBaseState(manifest: TransactionManifest): void {
    for (const target of manifest.targets) {
      if (fileState(target.path).hash !== target.baseHash) throw new Error("JOURNALED_TRANSACTION_BASE_HASH_MISMATCH");
    }
  }

  #validateTargetPath(path: string): void {
    const allowedRoots = this.#resolveAllowedRoots();
    if (!allowedRoots.some((root) => containedByCanonical(path, root))) {
      throw new Error("JOURNALED_TRANSACTION_TARGET_OUTSIDE_ALLOWED_ROOT");
    }
    if (pathExists(path)) ensureRegularFile(path);
    const parent = dirname(path);
    if (!pathExists(parent)) throw new Error("JOURNALED_TRANSACTION_TARGET_PARENT_MISSING");
    if (!allowedRoots.some((root) => containedByCanonical(parent, root))) {
      throw new Error("JOURNALED_TRANSACTION_TARGET_OUTSIDE_ALLOWED_ROOT");
    }
  }

  #resolveAllowedRoots(): readonly string[] {
    const configured = typeof this.#allowedRoots === "function" ? this.#allowedRoots() : this.#allowedRoots;
    if (configured.length === 0) throw new Error("JOURNALED_TRANSACTION_ALLOWED_ROOTS_REQUIRED");
    return uniquePaths(configured.map((root) => {
      if (!isAbsolute(root)) throw new Error("JOURNALED_TRANSACTION_ALLOWED_ROOT_NOT_ABSOLUTE");
      return resolve(root);
    }));
  }

  #validateManifest(manifest: TransactionManifest, transactionDirectory: string): void {
    if (manifest.id !== basename(transactionDirectory) || (manifest.phase === "committed" && !manifest.imagesReady)) {
      throw new Error("JOURNALED_TRANSACTION_MANIFEST_INVALID");
    }
    const seen = new Set<string>();
    for (const [index, target] of manifest.targets.entries()) {
      if (!isAbsolute(target.path)) throw new Error("JOURNALED_TRANSACTION_MANIFEST_INVALID");
      const path = resolve(target.path);
      const key = process.platform === "win32" ? path.toLowerCase() : path;
      if (seen.has(key)) throw new Error("JOURNALED_TRANSACTION_MANIFEST_INVALID");
      seen.add(key);
      this.#validateTargetPath(path);
      if (resolve(target.beforeImagePath) !== resolve(transactionDirectory, `${index}.before`) || resolve(target.afterImagePath) !== resolve(transactionDirectory, `${index}.after`)) {
        throw new Error("JOURNALED_TRANSACTION_MANIFEST_INVALID");
      }
      const token = `.vc-agent-${manifest.id}-${index}`;
      if (resolve(target.stagedPath) !== resolve(dirname(path), `${token}.after`) || resolve(target.backupPath) !== resolve(dirname(path), `${token}.before`)) {
        throw new Error("JOURNALED_TRANSACTION_MANIFEST_INVALID");
      }
    }
  }

  #shouldInject(phase: JournaledFileTransactionFaultPhase, count: number): boolean {
    const fault = this.#faultInjection;
    if (fault === undefined || fault.phase !== phase) return false;
    return count >= (fault.after ?? 1);
  }

  #inject(phase: JournaledFileTransactionFaultPhase): never {
    throw new InjectedTransactionFailure(phase, this.#faultInjection?.mode === "crash");
  }

  #publish(manifest: TransactionManifest, transactionDirectory: string, injectFailures = true): void {
    let published = manifest.targets.filter((target) => target.publication === "published").length;
    for (const target of manifest.targets) {
      if (target.publication === "published") continue;
      publishTarget(target);
      target.publication = "published";
      published += 1;
      writeManifest(transactionDirectory, manifest);
      if (injectFailures && this.#shouldInject("publication", published)) this.#inject("publication");
    }
    manifest.publication = "complete";
    writeManifest(transactionDirectory, manifest);
    rmSync(transactionDirectory, { recursive: true, force: true });
    cleanupManifestArtifacts(manifest);
  }
}

interface PreparedTarget {
  readonly path: string;
  readonly baseHash: string;
  readonly afterContent: string;
  readonly beforeExisted: boolean;
  readonly beforeMode: number | null;
}

function activateTarget(target: TransactionManifestTarget): void {
  if (target.beforeExisted) {
    if (existsSync(target.backupPath)) throw new Error("JOURNALED_TRANSACTION_BACKUP_ALREADY_EXISTS");
    renameSync(target.path, target.backupPath);
  }
  renameSync(target.stagedPath, target.path);
}

function publishTarget(target: TransactionManifestTarget): void {
  const current = fileState(target.path);
  if (current.hash !== target.afterHash) {
    if (!existsSync(target.afterImagePath)) throw new Error("JOURNALED_TRANSACTION_AFTER_IMAGE_MISSING");
    writeDurableBytes(target.stagedPath, readFileSync(target.afterImagePath));
    if (existsSync(target.path)) {
      ensureRegularFile(target.path);
      rmSync(target.backupPath, { force: true });
      renameSync(target.path, target.backupPath);
    }
    renameSync(target.stagedPath, target.path);
  }
  if (target.beforeMode !== null) chmodSync(target.path, target.beforeMode);
  rmSync(target.backupPath, { force: true });
  rmSync(target.stagedPath, { force: true });
}

function rollbackPrepared(manifest: TransactionManifest): void {
  if (!manifest.imagesReady) {
    for (const target of manifest.targets) {
      rmSync(target.backupPath, { force: true });
      rmSync(target.stagedPath, { force: true });
    }
    return;
  }
  for (const target of [...manifest.targets].reverse()) {
    if (target.beforeExisted) {
      if (!existsSync(target.beforeImagePath)) throw new Error("JOURNALED_TRANSACTION_BEFORE_IMAGE_MISSING");
      ensureRegularOrMissing(target.path);
      const restorePath = `${target.stagedPath}.rollback`;
      writeDurableBytes(restorePath, readFileSync(target.beforeImagePath));
      rmSync(target.path, { force: true });
      renameSync(restorePath, target.path);
      if (target.beforeMode !== null) chmodSync(target.path, target.beforeMode);
    } else {
      ensureRegularOrMissing(target.path);
      rmSync(target.path, { force: true });
    }
    rmSync(target.backupPath, { force: true });
    rmSync(target.stagedPath, { force: true });
  }
}

function cleanupManifestArtifacts(manifest: TransactionManifest | undefined): void {
  if (manifest === undefined) return;
  for (const target of manifest.targets) {
    rmSync(target.stagedPath, { force: true });
    rmSync(target.backupPath, { force: true });
    rmSync(`${target.stagedPath}.rollback`, { force: true });
  }
}

function readManifest(transactionDirectory: string): TransactionManifest | undefined {
  const path = join(transactionDirectory, "manifest.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as TransactionManifest;
    if (parsed.schemaVersion !== 1 || !isValidTransactionId(parsed.id) || !Array.isArray(parsed.targets) || !["prepared", "committed"].includes(parsed.phase)) {
      throw new Error("invalid");
    }
    return parsed;
  } catch {
    throw new Error("JOURNALED_TRANSACTION_MANIFEST_INVALID");
  }
}

function writeManifest(transactionDirectory: string, manifest: TransactionManifest): void {
  atomicWrite(join(transactionDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function validateFaultInjection(fault: JournaledFileTransactionFaultInjection | undefined): void {
  if (fault === undefined) return;
  if (fault.after !== undefined && (!Number.isInteger(fault.after) || fault.after < 0)) throw new Error("JOURNALED_TRANSACTION_FAULT_COUNT_INVALID");
}

function fileState(path: string): { readonly existed: boolean; readonly hash: string; readonly mode: number | null } {
  if (!pathExists(path)) return { existed: false, hash: JOURNALED_TRANSACTION_MISSING_HASH, mode: null };
  ensureRegularFile(path);
  const stat = lstatSync(path);
  const content = readFileSync(path);
  return { existed: true, hash: hashBytes(content), mode: stat.mode & 0o777 };
}

function ensureRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error("JOURNALED_TRANSACTION_TARGET_NOT_REGULAR_FILE");
}

function ensureRegularOrMissing(path: string): void {
  if (existsSync(path)) ensureRegularFile(path);
}

function normalizeHash(value: string): string {
  if (value === JOURNALED_TRANSACTION_MISSING_HASH) return value;
  if (!/^[a-f0-9]{64}$/iu.test(value)) throw new Error("JOURNALED_TRANSACTION_BASE_HASH_INVALID");
  return value.toLowerCase();
}

function hashText(content: string): string { return hashBytes(Buffer.from(content, "utf8")); }
function hashBytes(content: Uint8Array): string { return createHash("sha256").update(content).digest("hex"); }

function writeDurableText(path: string, content: string): void { writeDurableBytes(path, Buffer.from(content, "utf8")); }

function writeDurableBytes(path: string, content: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "w", 0o600);
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeDurableText(temporary, content);
  renameSync(temporary, path);
}

function isValidTransactionId(id: string): boolean { return /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(id); }

function containedBy(path: string, root: string): boolean {
  const normalizedPath = process.platform === "win32" ? path.toLowerCase() : path;
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const remainder = relative(normalizedRoot, normalizedPath);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function containedByCanonical(path: string, root: string): boolean {
  try {
    return containedBy(canonicalPath(path), canonicalPath(root));
  } catch {
    return false;
  }
}

function canonicalPath(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  while (!pathExists(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync(current), ...missing);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
