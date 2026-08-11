import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export interface PersonalCognitionStateAdapter<State = unknown> {
  exportPersonalCognitionState(): State;
  replacePersonalCognitionState(state: State): void;
}

export interface PersonalCognitionBackupOptions<State = unknown> {
  readonly state: PersonalCognitionStateAdapter<State>;
  readonly memoryFiles: Readonly<Record<string, string>>;
  /** App-data cognition-v2 root. It must contain an active epoch marker. */
  readonly cognitionRoot?: string;
  readonly skillsRoot?: string;
  readonly now?: () => Date;
}

export interface PersonalCognitionManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PersonalCognitionManifest {
  readonly format: "vc-agent-personal-cognition";
  readonly formatVersion: 2;
  /** Backup boundary version; the Host state payload remains schemaVersion=1. */
  readonly stateSchemaVersion: 2;
  readonly cognitionEpochStartedAt: string;
  readonly createdAt: string;
  readonly domains: readonly string[];
  readonly files: readonly PersonalCognitionManifestFile[];
  readonly credentialsIncluded: false;
  readonly trajectoriesIncluded: false;
  readonly securityWarning: string;
  readonly excludedDomains: readonly string[];
}

export interface PersonalCognitionRestorePreview {
  readonly manifest: PersonalCognitionManifest;
  readonly bundlePath: string;
  readonly requiresCredentialSetup: boolean;
}

const STATE_PATH = "domains/personal-state.json";
const MEMORY_PREFIX = "domains/long-term-memory/";
const COGNITION_PREFIX = "domains/cognition-v2/";
const SKILLS_PREFIX = "domains/skills/";
const EXCLUDED_DOMAINS = [
  "projects", "project-memory", "project-provenance", "materials", "outputs", "parses", "threads", "workflow-state",
  "pending-candidates", "credentials", "physical-model-context", "caches", "logs"
] as const;
const LEGACY_COGNITION_TASK_TYPES = new Set(["dream", "independent_evidence", "memory_aware_reflection"]);

export class PersonalCognitionBackupService<State = unknown> {
  readonly #state: PersonalCognitionStateAdapter<State>;
  readonly #memoryFiles: Readonly<Record<string, string>>;
  readonly #cognitionRoot: string;
  readonly #skillsRoot: string | undefined;
  readonly #now: () => Date;

  constructor(options: PersonalCognitionBackupOptions<State>) {
    this.#state = options.state;
    this.#memoryFiles = options.memoryFiles;
    this.#cognitionRoot = resolve(options.cognitionRoot ?? inferCognitionRoot(options.memoryFiles));
    this.#skillsRoot = options.skillsRoot;
    this.#now = options.now ?? (() => new Date());
  }

  create(destination: string): PersonalCognitionManifest {
    if (existsSync(destination)) throw new Error("Backup destination already exists");
    const epoch = readActiveEpoch(this.#cognitionRoot);
    const state = this.#state.exportPersonalCognitionState();
    validateV2State(state);
    const staging = `${destination}.staging-${randomUUID()}`;
    mkdirSync(join(staging, "domains"), { recursive: true });
    try {
      writeJson(join(staging, STATE_PATH), state);
      for (const [name, source] of Object.entries(this.#memoryFiles)) {
        if (!existsSync(source)) continue;
        assertNoSymlinkPath(source);
        const target = join(staging, MEMORY_PREFIX, safeLeaf(name));
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
      copyDirectory(this.#cognitionRoot, join(staging, "domains", "cognition-v2"));
      if (this.#skillsRoot !== undefined && existsSync(this.#skillsRoot)) copyDirectory(this.#skillsRoot, join(staging, "domains", "skills"));
      const files = listFiles(join(staging, "domains")).map((path) => manifestFile(staging, path));
      const domains = ["cognition-v2", "long-term-memory", "cognitive-evolution-history", "condensation-archive", "system-prompt-revisions", "model-profiles", "task-model-assignments", "non-secret-settings"];
      if (files.some((file) => file.path.startsWith(SKILLS_PREFIX))) domains.push("vc-agent-skills");
      const manifest: PersonalCognitionManifest = {
        format: "vc-agent-personal-cognition",
        formatVersion: 2,
        stateSchemaVersion: 2,
        cognitionEpochStartedAt: epoch,
        createdAt: this.#now().toISOString(),
        domains,
        files,
        credentialsIncluded: false,
        trajectoriesIncluded: false,
        securityWarning: "This transparent bundle contains durable personal cognition. Protect its destination. Provider credentials and Project data are excluded.",
        excludedDomains: EXCLUDED_DOMAINS
      };
      writeJson(join(staging, "manifest.json"), manifest);
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(staging, destination);
      return manifest;
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  inspect(bundlePath: string): PersonalCognitionRestorePreview {
    const manifestPath = join(bundlePath, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error("Personal Cognition manifest is missing");
    const manifest = parseManifest(readJson(manifestPath));
    const expectedPaths = [...new Set(manifest.files.map((file) => file.path))].sort();
    if (expectedPaths.length !== manifest.files.length) throw new Error("Duplicate Personal Cognition manifest file entry");
    const actualPaths = listFiles(join(bundlePath, "domains")).map((path) => relative(bundlePath, path).split(sep).join("/")).sort();
    if (actualPaths.length !== expectedPaths.length || actualPaths.some((path, index) => path !== expectedPaths[index])) throw new Error("Personal Cognition manifest file set does not match bundle contents");
    for (const file of manifest.files) {
      const source = inside(bundlePath, file.path);
      if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Backup file is missing: ${file.path}`);
      const content = readFileSync(source);
      if (content.byteLength !== file.size || sha256(content) !== file.sha256) throw new Error(`Backup checksum mismatch: ${file.path}`);
    }
    if (!manifest.files.some((file) => file.path === STATE_PATH)) throw new Error("Personal Cognition state domain is missing");
    if (!manifest.files.some((file) => file.path === `${COGNITION_PREFIX}epoch.json`)) throw new Error("Cognition v2 epoch is missing");
    const state = readJson(join(bundlePath, STATE_PATH)) as { profiles?: unknown[] };
    validateV2State(state);
    const epoch = readActiveEpoch(join(bundlePath, "domains", "cognition-v2"));
    if (epoch !== manifest.cognitionEpochStartedAt) throw new Error("Cognition v2 epoch does not match the manifest");
    return { manifest, bundlePath, requiresCredentialSetup: (state.profiles?.length ?? 0) > 0 };
  }

  restore(bundlePath: string, confirmedWholeDomainReplacement: boolean): PersonalCognitionRestorePreview {
    if (!confirmedWholeDomainReplacement) throw new Error("Whole-domain replacement confirmation is required");
    const preview = this.inspect(bundlePath);
    const previousState = this.#state.exportPersonalCognitionState();
    const previousMemory = Object.fromEntries(Object.entries(this.#memoryFiles).map(([name, path]) => {
      if (!existsSync(path)) return [name, undefined];
      assertNoSymlinkPath(path);
      return [name, readFileSync(path)];
    }));
    assertNoSymlinkPath(this.#cognitionRoot);
    const previousCognition = existsSync(this.#cognitionRoot) ? snapshotDirectory(this.#cognitionRoot) : undefined;
    const previousSkills = this.#skillsRoot === undefined ? undefined : snapshotDirectory(this.#skillsRoot);
    try {
      this.#state.replacePersonalCognitionState(readJson(join(bundlePath, STATE_PATH)) as State);
      const bundleMemory = new Map(preview.manifest.files.filter((file) => file.path.startsWith(MEMORY_PREFIX)).map((file) => [basename(file.path), file]));
      for (const [name, target] of Object.entries(this.#memoryFiles)) {
        const source = bundleMemory.get(safeLeaf(name));
        if (source === undefined) rmSync(target, { force: true });
        else atomicCopy(join(bundlePath, source.path), target);
      }
      rmSync(this.#cognitionRoot, { recursive: true, force: true });
      copyDirectory(join(bundlePath, "domains", "cognition-v2"), this.#cognitionRoot);
      if (this.#skillsRoot !== undefined) {
        rmSync(this.#skillsRoot, { recursive: true, force: true });
        const bundledSkills = join(bundlePath, "domains", "skills");
        if (existsSync(bundledSkills)) copyDirectory(bundledSkills, this.#skillsRoot);
      }
      return preview;
    } catch (error) {
      this.#state.replacePersonalCognitionState(previousState);
      for (const [name, target] of Object.entries(this.#memoryFiles)) {
        const content = previousMemory[name];
        if (content === undefined) rmSync(target, { force: true });
        else atomicWrite(target, content);
      }
      if (previousCognition === undefined) rmSync(this.#cognitionRoot, { recursive: true, force: true });
      else restoreDirectorySnapshot(this.#cognitionRoot, previousCognition);
      if (this.#skillsRoot !== undefined) {
        if (previousSkills === undefined) rmSync(this.#skillsRoot, { recursive: true, force: true });
        else restoreDirectorySnapshot(this.#skillsRoot, previousSkills);
      }
      throw error;
    }
  }
}

function parseManifest(value: unknown): PersonalCognitionManifest {
  if (typeof value !== "object" || value === null) throw new Error("Invalid Personal Cognition manifest");
  const manifest = value as Partial<PersonalCognitionManifest>;
  if (manifest.format !== "vc-agent-personal-cognition" || manifest.formatVersion !== 2 || manifest.stateSchemaVersion !== 2 || !Array.isArray(manifest.files)) throw new Error("Unsupported Personal Cognition v2 manifest; legacy cognition cannot be imported");
  if (typeof manifest.cognitionEpochStartedAt !== "string" || Number.isNaN(new Date(manifest.cognitionEpochStartedAt).valueOf())) throw new Error("Cognition v2 epoch is missing from the manifest");
  if (typeof manifest.createdAt !== "string" || Number.isNaN(new Date(manifest.createdAt).valueOf()) || !Array.isArray(manifest.domains) || !manifest.domains.every((domain) => typeof domain === "string") || !manifest.domains.includes("cognition-v2") || !Array.isArray(manifest.excludedDomains) || !manifest.excludedDomains.every((domain) => typeof domain === "string") || typeof manifest.securityWarning !== "string") {
    throw new Error("Invalid Personal Cognition v2 manifest metadata");
  }
  for (const file of manifest.files) {
    if (typeof file?.path !== "string" || (!file.path.startsWith("domains/") || file.path.includes("..") || file.path.includes("\\")) || typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error("Invalid Personal Cognition manifest file entry");
    if (![STATE_PATH, MEMORY_PREFIX, COGNITION_PREFIX, SKILLS_PREFIX].some((prefix) => file.path === prefix || file.path.startsWith(prefix))) throw new Error("Unsupported Personal Cognition domain in v2 manifest");
  }
  if (manifest.credentialsIncluded !== false || manifest.trajectoriesIncluded !== false) throw new Error("Unsupported sensitive domains in Personal Cognition bundle");
  return manifest as PersonalCognitionManifest;
}

function manifestFile(root: string, path: string): PersonalCognitionManifestFile {
  const content = readFileSync(path);
  return { path: relative(root, path).split(sep).join("/"), size: content.byteLength, sha256: sha256(content) };
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  assertNoSymlinkPath(root);
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Backup source contains a symlink");
    if (entry.isDirectory()) return listFiles(path);
    if (entry.isFile()) return [path];
    throw new Error("Backup source contains an unsupported file type");
  }).sort();
}

function copyDirectory(source: string, destination: string): void {
  assertNoSymlinkPath(source);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Backup source contains a symlink");
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) copyFileSync(sourcePath, destinationPath);
    else throw new Error("Backup source contains an unsupported file type");
  }
}

function snapshotDirectory(root: string): Map<string, Buffer> {
  return new Map(listFiles(root).map((path) => [relative(root, path), readFileSync(path)]));
}

function restoreDirectorySnapshot(root: string, snapshot: Map<string, Buffer>): void {
  rmSync(root, { recursive: true, force: true });
  for (const [path, content] of snapshot) atomicWrite(join(root, path), content);
}

function atomicCopy(source: string, destination: string): void { atomicWrite(destination, readFileSync(source)); }

function atomicWrite(destination: string, content: string | Uint8Array): void {
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${randomUUID()}`;
  writeFileSync(temporary, content);
  renameSync(temporary, destination);
}

function writeJson(path: string, value: unknown): void { atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`); }
function readJson(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")); }
function sha256(content: Uint8Array): string { return createHash("sha256").update(content).digest("hex"); }
function safeLeaf(value: string): string { if (basename(value) !== value || value.includes("/") || value.includes("\\") || value === "." || value === "..") throw new Error("Invalid backup domain name"); return value; }
function inside(root: string, child: string): string {
  const rootPath = resolve(root);
  const target = resolve(rootPath, child);
  const boundary = `${rootPath}${sep}`;
  const sameOrInside = (candidate: string) => {
    const left = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    const right = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
    const prefix = process.platform === "win32" ? boundary.toLowerCase() : boundary;
    return left === right || left.startsWith(prefix);
  };
  if (!sameOrInside(target)) throw new Error("Backup path escapes its bundle");
  assertNoSymlinkPath(target, rootPath);
  return target;
}

function assertNoSymlinkPath(path: string, boundaryRoot?: string): void {
  const target = resolve(path);
  const root = resolve(boundaryRoot ?? target);
  let rootInfo;
  try { rootInfo = lstatSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (rootInfo.isSymbolicLink()) throw new Error("Backup path contains a symlink");
  const suffix = boundaryRoot === undefined ? "" : relative(root, target);
  let current = root;
  const parts = suffix === "" ? [] : suffix.split(sep);
  for (const part of parts) {
    current = join(current, part);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error("Backup path contains a symlink");
  }
  if (existsSync(target)) {
    const info = lstatSync(target);
    if (info.isSymbolicLink()) throw new Error("Backup path contains a symlink");
    const canonical = realpathSync(target);
    const canonicalRoot = realpathSync(root);
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    const targetKey = process.platform === "win32" ? target.toLowerCase() : target;
    if (boundaryRoot === undefined && key !== targetKey) throw new Error("Backup path contains a symlink");
    const boundary = process.platform === "win32" ? `${canonicalRoot}${sep}`.toLowerCase() : `${canonicalRoot}${sep}`;
    if (key !== (process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot) && !key.startsWith(boundary)) throw new Error("Backup path escapes its bundle");
  }
}

function validateV2State(value: unknown): void {
  if (typeof value !== "object" || value === null) throw new Error("Invalid Personal Cognition state");
  const state = value as { schemaVersion?: unknown; taskAssignments?: unknown };
  // HostStateStore's portable state payload remains schemaVersion=1; the
  // backup boundary itself is versioned independently at manifest v2.
  if (state.schemaVersion !== 1) throw new Error("Unsupported Personal Cognition state schema for cognition-v2");
  if (state.taskAssignments !== undefined) {
    if (!Array.isArray(state.taskAssignments)) throw new Error("Invalid Personal Cognition task assignments");
    for (const assignment of state.taskAssignments) {
      const taskType = (assignment as { taskType?: unknown })?.taskType;
      if (typeof taskType !== "string" || LEGACY_COGNITION_TASK_TYPES.has(taskType)) throw new Error("Legacy cognition task assignment cannot be imported into cognition-v2");
    }
  }
}

function readActiveEpoch(root: string): string {
  assertNoSymlinkPath(root);
  const epochPath = join(root, "epoch.json");
  assertNoSymlinkPath(epochPath, root);
  if (!existsSync(epochPath) || !statSync(epochPath).isFile()) throw new Error("Cognition v2 epoch is missing");
  const value = readJson(epochPath) as { schemaVersion?: unknown; learningEpochStartedAt?: unknown; status?: unknown };
  if (value.schemaVersion !== 1 || value.status !== "active" || typeof value.learningEpochStartedAt !== "string") throw new Error("Cognition v2 epoch is not active");
  const date = new Date(value.learningEpochStartedAt);
  if (Number.isNaN(date.valueOf())) throw new Error("Cognition v2 epoch timestamp is invalid");
  return date.toISOString();
}

function inferCognitionRoot(memoryFiles: Readonly<Record<string, string>>): string {
  const first = Object.values(memoryFiles)[0];
  if (first === undefined) throw new Error("Cognition v2 root is required");
  const absolute = resolve(first);
  const parts = absolute.split(/[\\/]/u);
  const memoryIndex = parts.findIndex((part) => part.toLowerCase() === "memory");
  const appDataRoot = memoryIndex > 0 ? parts.slice(0, memoryIndex).join(sep) || sep : dirname(dirname(absolute));
  return join(appDataRoot, "cognition-v2");
}
