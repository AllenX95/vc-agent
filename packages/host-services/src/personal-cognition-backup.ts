import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export interface PersonalCognitionStateAdapter<State = unknown> {
  exportPersonalCognitionState(): State;
  replacePersonalCognitionState(state: State): void;
}

export interface PersonalCognitionBackupOptions<State = unknown> {
  readonly state: PersonalCognitionStateAdapter<State>;
  readonly memoryFiles: Readonly<Record<string, string>>;
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
  readonly formatVersion: 1;
  readonly stateSchemaVersion: 1;
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
const SKILLS_PREFIX = "domains/skills/";
const EXCLUDED_DOMAINS = [
  "projects", "project-memory", "project-provenance", "materials", "outputs", "parses", "threads", "workflow-state",
  "pending-candidates", "credentials", "physical-model-context", "caches", "logs"
] as const;

export class PersonalCognitionBackupService<State = unknown> {
  readonly #state: PersonalCognitionStateAdapter<State>;
  readonly #memoryFiles: Readonly<Record<string, string>>;
  readonly #skillsRoot: string | undefined;
  readonly #now: () => Date;

  constructor(options: PersonalCognitionBackupOptions<State>) {
    this.#state = options.state;
    this.#memoryFiles = options.memoryFiles;
    this.#skillsRoot = options.skillsRoot;
    this.#now = options.now ?? (() => new Date());
  }

  create(destination: string): PersonalCognitionManifest {
    if (existsSync(destination)) throw new Error("Backup destination already exists");
    const staging = `${destination}.staging-${randomUUID()}`;
    mkdirSync(join(staging, "domains"), { recursive: true });
    try {
      writeJson(join(staging, STATE_PATH), this.#state.exportPersonalCognitionState());
      for (const [name, source] of Object.entries(this.#memoryFiles)) {
        if (!existsSync(source)) continue;
        const target = join(staging, MEMORY_PREFIX, safeLeaf(name));
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
      if (this.#skillsRoot !== undefined && existsSync(this.#skillsRoot)) copyDirectory(this.#skillsRoot, join(staging, "domains", "skills"));
      const files = listFiles(join(staging, "domains")).map((path) => manifestFile(staging, path));
      const domains = ["long-term-memory", "cognitive-evolution-history", "condensation-archive", "system-prompt-revisions", "model-profiles", "task-model-assignments", "non-secret-settings"];
      if (files.some((file) => file.path.startsWith(SKILLS_PREFIX))) domains.push("vc-agent-skills");
      const manifest: PersonalCognitionManifest = {
        format: "vc-agent-personal-cognition",
        formatVersion: 1,
        stateSchemaVersion: 1,
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
    for (const file of manifest.files) {
      const source = inside(bundlePath, file.path);
      if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Backup file is missing: ${file.path}`);
      const content = readFileSync(source);
      if (content.byteLength !== file.size || sha256(content) !== file.sha256) throw new Error(`Backup checksum mismatch: ${file.path}`);
    }
    if (!manifest.files.some((file) => file.path === STATE_PATH)) throw new Error("Personal Cognition state domain is missing");
    const state = readJson(join(bundlePath, STATE_PATH)) as { profiles?: unknown[] };
    return { manifest, bundlePath, requiresCredentialSetup: (state.profiles?.length ?? 0) > 0 };
  }

  restore(bundlePath: string, confirmedWholeDomainReplacement: boolean): PersonalCognitionRestorePreview {
    if (!confirmedWholeDomainReplacement) throw new Error("Whole-domain replacement confirmation is required");
    const preview = this.inspect(bundlePath);
    const previousState = this.#state.exportPersonalCognitionState();
    const previousMemory = Object.fromEntries(Object.entries(this.#memoryFiles).map(([name, path]) => [name, existsSync(path) ? readFileSync(path) : undefined]));
    const previousSkills = this.#skillsRoot === undefined ? undefined : snapshotDirectory(this.#skillsRoot);
    try {
      this.#state.replacePersonalCognitionState(readJson(join(bundlePath, STATE_PATH)) as State);
      const bundleMemory = new Map(preview.manifest.files.filter((file) => file.path.startsWith(MEMORY_PREFIX)).map((file) => [basename(file.path), file]));
      for (const [name, target] of Object.entries(this.#memoryFiles)) {
        const source = bundleMemory.get(safeLeaf(name));
        if (source === undefined) rmSync(target, { force: true });
        else atomicCopy(join(bundlePath, source.path), target);
      }
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
      if (this.#skillsRoot !== undefined && previousSkills !== undefined) restoreDirectorySnapshot(this.#skillsRoot, previousSkills);
      throw error;
    }
  }
}

function parseManifest(value: unknown): PersonalCognitionManifest {
  if (typeof value !== "object" || value === null) throw new Error("Invalid Personal Cognition manifest");
  const manifest = value as Partial<PersonalCognitionManifest>;
  if (manifest.format !== "vc-agent-personal-cognition" || manifest.formatVersion !== 1 || manifest.stateSchemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error("Unsupported Personal Cognition manifest");
  for (const file of manifest.files) {
    if (typeof file?.path !== "string" || (!file.path.startsWith("domains/") || file.path.includes("..") || file.path.includes("\\")) || typeof file.size !== "number" || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error("Invalid Personal Cognition manifest file entry");
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
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listFiles(path) : entry.isFile() ? [path] : [];
  }).sort();
}

function copyDirectory(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) copyFileSync(sourcePath, destinationPath);
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
function safeLeaf(value: string): string { if (basename(value) !== value || value === "." || value === "..") throw new Error("Invalid backup domain name"); return value; }
function inside(root: string, child: string): string { const target = resolve(root, child); const boundary = `${resolve(root)}${sep}`; if (!target.startsWith(boundary)) throw new Error("Backup path escapes its bundle"); return target; }
