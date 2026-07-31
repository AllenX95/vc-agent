import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

export type SkillSourceKind = "local_directory" | "creator_draft" | "bundled_reviewed";
export type SkillPackageState = "copying" | "copied" | "inspecting" | "compatible" | "incompatible" | "blocked" | "awaiting_activation" | "active" | "disabled" | "invalidated" | "failed";
export type SkillFindingSeverity = "info" | "warning" | "block";

export interface LocalSkillImport {
  readonly sourceDirectory: string;
  readonly packageId?: string;
  readonly sourceKind?: SkillSourceKind;
}

export interface SkillCompatibilityFinding {
  readonly code: "SKILL_REFERENCE_MISSING" | "SKILL_METADATA_INVALID" | "SKILL_DIRECTIVE_UNSUPPORTED" | "SKILL_DEPENDENCY_UNDECLARED" | "SKILL_PATH_ESCAPE" | "SKILL_COPY_FAILED" | "SKILL_RESOURCE_LIMIT_EXCEEDED" | "SKILL_HASH_MISMATCH";
  readonly severity: SkillFindingSeverity;
  readonly path?: string;
  readonly message: string;
}

export interface SkillInventoryItem {
  readonly schemaVersion: 1;
  readonly packageId: string;
  readonly revisionId: string;
  readonly importId: string;
  readonly sourceKind: SkillSourceKind;
  readonly importedAt: string;
  readonly contentHash: string;
  readonly overlayHash?: string;
  readonly compatibility: "unknown" | "compatible" | "incompatible" | "blocked";
  readonly declaredDependencies: readonly string[];
  readonly overlayRevision?: string;
  readonly enabled: boolean;
  readonly licensePresent: boolean;
  readonly state: SkillPackageState;
  readonly files: readonly string[];
  readonly activeHash?: string;
  readonly failureCode?: string;
  readonly findings: readonly SkillCompatibilityFinding[];
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SkillImportResult {
  readonly package: SkillInventoryItem;
  readonly stagedPath: string;
}

export interface SkillCompatibilityReport {
  readonly package: SkillInventoryItem;
  readonly status: "compatible" | "incompatible" | "blocked";
  readonly files: readonly string[];
  readonly missingReferences: readonly string[];
  readonly unsupportedDirectives: readonly string[];
  readonly undeclaredExecutables: readonly string[];
  readonly overlayRevision?: string;
  readonly exactHash: string;
  readonly findings: readonly SkillCompatibilityFinding[];
}

export interface SkillActivationDecision {
  readonly packageId: string;
  readonly revisionId: string;
  readonly reason: "task_match" | "explicit";
  readonly resources: readonly string[];
  readonly capabilities: readonly string[];
}

export interface RuntimeSkillSnapshot {
  readonly schemaVersion: 1;
  readonly revisionId: string;
  readonly decisions: readonly SkillActivationDecision[];
  readonly instructions: readonly {
    readonly packageId: string;
    readonly revisionId: string;
    readonly name: string;
    readonly description: string;
    readonly filePath: string;
    readonly baseDir: string;
    readonly content: string;
  }[];
  readonly resources: readonly { readonly packageId: string; readonly relativePath: string; readonly content: string }[];
}

export interface SkillDirectoryLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxResourceBytes: number;
}

interface StoredSkillState {
  readonly schemaVersion: 1;
  readonly packages: SkillInventoryItem[];
}

const DEFAULT_LIMITS: SkillDirectoryLimits = { maxFiles: 2_000, maxBytes: 50_000_000, maxResourceBytes: 2_000_000 };
const INVENTORY_FILE = "inventory.json";
const SUPPORTED_METADATA = new Set(["name", "description", "license", "dependencies", "executables", "entrypoint", "tools", "keywords"]);
const EXECUTABLE_EXTENSIONS = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".ps1", ".bat", ".cmd", ".exe"]);

/** App-owned, copy-on-import Skill inventory and activation boundary. */
export class SkillPackageManager {
  readonly #root: string;
  readonly #limits: SkillDirectoryLimits;
  readonly #now: () => string;
  #readOnly = false;

  constructor(input: { root: string; limits?: Partial<SkillDirectoryLimits>; now?: () => string }) {
    this.#root = resolve(input.root);
    this.#limits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };
    this.#now = input.now ?? (() => new Date().toISOString());
    this.#readOnly = this.#loadState().readOnly;
  }

  get root(): string { return this.#root; }
  get isReadOnly(): boolean { return this.#readOnly; }

  open(): void {
    if (this.#readOnly) throw new Error("SKILL_DIRECTORY_READ_ONLY");
    for (const directory of [this.#root, this.importsRoot(), this.overlaysRoot(), this.activeRoot(), this.jobsRoot()]) mkdirSync(directory, { recursive: true });
  }

  inventory(): SkillInventoryItem[] {
    return this.#loadState().state.packages.map((item) => clonePackage(item));
  }

  async importLocalDirectory(request: LocalSkillImport): Promise<SkillImportResult> {
    if (this.#readOnly) throw new Error("SKILL_DIRECTORY_READ_ONLY");
    this.open();
    const sourceRoot = resolve(request.sourceDirectory);
    if (!existsSync(sourceRoot) || !lstatSync(sourceRoot).isDirectory()) throw new Error("SKILL_COPY_FAILED");
    const importId = randomUUID();
    const packageId = normalizePackageId(request.packageId ?? basename(sourceRoot));
    const jobRoot = join(this.jobsRoot(), importId);
    const stagedPath = join(jobRoot, "source");
    mkdirSync(stagedPath, { recursive: true });
    try {
      copySkillTree(sourceRoot, stagedPath, this.#limits);
      const files = listFiles(stagedPath);
      if (!files.some((path) => basename(path).toLowerCase() === "skill.md")) throw new Error("SKILL_METADATA_INVALID");
      const contentHash = hashDirectory(stagedPath);
      const existing = this.inventory().find((item) => item.packageId === packageId && item.contentHash === contentHash);
      if (existing !== undefined) {
        rmSync(jobRoot, { recursive: true, force: true });
        return { package: clonePackage(existing), stagedPath: this.sourcePath(existing) };
      }
      const revisionId = randomUUID();
      const importPath = join(this.importsRoot(), importId);
      mkdirSync(dirnameFor(importPath), { recursive: true });
      renameSync(jobRoot, importPath);
      const record: SkillInventoryItem = {
        schemaVersion: 1,
        packageId,
        revisionId,
        importId,
        sourceKind: request.sourceKind ?? "local_directory",
        importedAt: this.#now(),
        contentHash,
        compatibility: "unknown",
        declaredDependencies: [],
        enabled: false,
        licensePresent: files.some((path) => basename(path).toLowerCase().startsWith("license")),
        state: "copied",
        files,
        findings: [],
        metadata: {}
      };
      this.#saveState({ packages: [...this.inventory(), record] });
      return { package: clonePackage(record), stagedPath: join(importPath, "source") };
    } catch (error) {
      rmSync(jobRoot, { recursive: true, force: true });
      const code = error instanceof Error && error.message.startsWith("SKILL_") ? error.message : "SKILL_COPY_FAILED";
      throw new Error(code);
    }
  }

  async inspect(packageRevisionId: string): Promise<SkillCompatibilityReport> {
    const record = this.find(packageRevisionId);
    if (record === undefined) throw new Error("SKILL_REFERENCE_MISSING");
    if (this.#readOnly) return this.report(record, "blocked", [{ code: "SKILL_METADATA_INVALID", severity: "block", message: "Skills inventory is in read-only recovery." }]);
    const sourcePath = this.sourcePath(record);
    if (!existsSync(sourcePath)) return this.report(this.update(record, { state: "failed", compatibility: "blocked", failureCode: "SKILL_COPY_FAILED" }), "blocked", [{ code: "SKILL_COPY_FAILED", severity: "block", message: "The copied Skill source is unavailable." }]);
    const actualHash = hashDirectory(sourcePath);
    const overlayRoot = record.overlayRevision === undefined ? undefined : join(this.overlaysRoot(), record.packageId, record.overlayRevision);
    const effectiveFiles = effectiveFileList(sourcePath, overlayRoot);
    const effectiveHash = hashEffectivePackage(sourcePath, overlayRoot, effectiveFiles);
    const findings: SkillCompatibilityFinding[] = [];
    const files = effectiveFiles;
    if (actualHash !== record.contentHash) findings.push({ code: "SKILL_HASH_MISMATCH", severity: "block", message: "The copied Skill bytes changed after import." });
    const skillPath = files.find((path) => basename(path).toLowerCase() === "skill.md");
    if (skillPath === undefined) findings.push({ code: "SKILL_METADATA_INVALID", severity: "block", message: "SKILL.md is missing." });
    const readEffective = (path: string): string => overlayRoot !== undefined && existsSync(join(overlayRoot, path)) ? readFileSync(join(overlayRoot, path), "utf8") : readFileSync(join(sourcePath, path), "utf8");
    const metadata = skillPath === undefined ? { values: {}, dependencies: [] as string[], executables: [] as string[], keywords: [] as string[], malformed: true, unsupported: [] as string[] } : parseSkillMetadata(readEffective(skillPath));
    if (metadata.malformed) findings.push({ code: "SKILL_METADATA_INVALID", severity: "block", ...(skillPath === undefined ? {} : { path: skillPath }), message: "Skill metadata front matter is malformed." });
    for (const directive of metadata.unsupported) findings.push({ code: "SKILL_DIRECTIVE_UNSUPPORTED", severity: "block", ...(skillPath === undefined ? {} : { path: skillPath }), message: "Unsupported Skill directive: " + directive });
    const references = skillPath === undefined ? [] : referencedPaths(readEffective(skillPath));
    const fileSet = new Set(files.map((path) => toPosix(path)));
    const missingReferences: string[] = [];
    for (const reference of references) {
      if (reference.startsWith("http://") || reference.startsWith("https://") || reference.startsWith("/") || reference.includes("..")) {
        findings.push({ code: "SKILL_PATH_ESCAPE", severity: "block", ...(skillPath === undefined ? {} : { path: skillPath }), message: "Skill reference escapes the copied package: " + reference });
        continue;
      }
      const normalized = (reference.startsWith("./") ? reference.slice(2) : reference).replaceAll("\\\\", "/");
      if (!fileSet.has(normalized)) {
        missingReferences.push(normalized);
        findings.push({ code: "SKILL_REFERENCE_MISSING", severity: "block", path: normalized, message: "Referenced Skill file is missing." });
      }
    }
    const executableFiles = files.filter((path) => EXECUTABLE_EXTENSIONS.has(extname(path).toLowerCase())).map((path) => toPosix(path));
    const declaredExecutables = new Set([...metadata.executables, ...metadata.dependencies].map((value) => value.toLowerCase()));
    const undeclaredExecutables = executableFiles.filter((path) => !declaredExecutables.has(path.toLowerCase()) && !declaredExecutables.has(basename(path).toLowerCase()) && !declaredExecutables.has(extname(path).slice(1).toLowerCase()));
    for (const executable of undeclaredExecutables) findings.push({ code: "SKILL_DEPENDENCY_UNDECLARED", severity: "block", path: executable, message: "Executable dependency is not declared by the Skill." });
    if (metadata.values.entrypoint !== undefined && !fileSet.has(toPosix(metadata.values.entrypoint))) findings.push({ code: "SKILL_REFERENCE_MISSING", path: metadata.values.entrypoint, severity: "block", message: "Declared Skill entrypoint is missing." });
    const status = findings.some((finding) => finding.severity === "block") ? "incompatible" : "compatible";
    const updated = this.update(record, {
      contentHash: record.contentHash,
      ...(record.overlayRevision === undefined ? {} : { overlayHash: overlayRoot === undefined ? record.overlayHash : hashDirectory(overlayRoot) }),
      compatibility: status,
      declaredDependencies: [...new Set([...metadata.dependencies, ...metadata.executables])].sort(),
      state: status === "compatible" ? "awaiting_activation" : "incompatible",
      findings,
      metadata: metadata.values
    });
    this.#saveState({ packages: this.inventory().map((item) => item.packageId === updated.packageId && item.revisionId === updated.revisionId ? updated : item) });
    return { ...this.report(updated, status, findings, missingReferences, undeclaredExecutables), exactHash: effectiveHash };
  }

  async activate(packageRevisionId: string): Promise<SkillActivationDecision> {
    const record = this.find(packageRevisionId);
    if (record === undefined) throw new Error("SKILL_REFERENCE_MISSING");
    if (record.compatibility !== "compatible" || !["awaiting_activation", "disabled", "invalidated"].includes(record.state)) throw new Error("SKILL_ACTIVATION_INVALIDATED");
    const sourcePath = this.sourcePath(record);
    if (hashDirectory(sourcePath) !== record.contentHash) {
      const invalidated = this.update(record, { state: "invalidated", enabled: false, compatibility: "incompatible" });
      this.#saveState({ packages: this.inventory().map((item) => item.revisionId === record.revisionId ? invalidated : item) });
      throw new Error("SKILL_HASH_MISMATCH");
    }
    const activePath = join(this.activeRoot(), record.packageId, record.revisionId);
    const partialPath = activePath + ".partial";
    rmSync(partialPath, { recursive: true, force: true });
    mkdirSync(partialPath, { recursive: true });
    copySkillTree(sourcePath, partialPath, this.#limits);
    const overlay = record.overlayRevision === undefined ? undefined : join(this.overlaysRoot(), record.packageId, record.overlayRevision);
    if (overlay !== undefined && record.overlayHash !== undefined && hashDirectory(overlay) !== record.overlayHash) {
      const invalidated = this.update(record, { state: "invalidated", enabled: false, compatibility: "incompatible" });
      this.#saveState({ packages: this.inventory().map((item) => item.revisionId === record.revisionId ? invalidated : item) });
      throw new Error("SKILL_HASH_MISMATCH");
    }
    if (overlay !== undefined && existsSync(overlay)) copySkillTree(overlay, partialPath, this.#limits);
    rmSync(activePath, { recursive: true, force: true });
    renameSync(partialPath, activePath);
    const activeHash = hashDirectory(activePath);
    const updated = this.update(record, { state: "active", enabled: true, activeHash });
    this.#saveState({ packages: this.inventory().map((item) => {
      if (item.revisionId === record.revisionId) return updated;
      if (item.packageId === record.packageId && item.enabled) return this.update(item, { enabled: false, state: "disabled" });
      return item;
    }) });
    return { packageId: record.packageId, revisionId: record.revisionId, reason: "explicit", resources: record.files, capabilities: [] };
  }

  async disable(packageId: string): Promise<SkillInventoryItem> {
    const record = this.inventory().find((item) => item.packageId === packageId && item.enabled);
    if (record === undefined) throw new Error("SKILL_REFERENCE_MISSING");
    const updated = this.update(record, { enabled: false, state: "disabled" });
    this.#saveState({ packages: this.inventory().map((item) => item.revisionId === record.revisionId ? updated : item) });
    return clonePackage(updated);
  }

  async setOverlay(packageRevisionId: string, files: Readonly<Record<string, string>>): Promise<SkillInventoryItem> {
    const record = this.find(packageRevisionId);
    if (record === undefined) throw new Error("SKILL_REFERENCE_MISSING");
    const revision = randomUUID();
    const overlayRoot = join(this.overlaysRoot(), record.packageId, revision);
    mkdirSync(overlayRoot, { recursive: true });
    for (const [relativePath, content] of Object.entries(files)) {
      if (!safeRelativePath(relativePath)) throw new Error("SKILL_PATH_ESCAPE");
      const target = join(overlayRoot, relativePath);
      mkdirSync(dirnameFor(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    const updated = this.update(record, { overlayRevision: revision, overlayHash: hashDirectory(overlayRoot), state: "invalidated", enabled: false, compatibility: "unknown" });
    this.#saveState({ packages: this.inventory().map((item) => item.revisionId === record.revisionId ? updated : item) });
    return clonePackage(updated);
  }

  async invalidateChanged(): Promise<SkillInventoryItem[]> {
    const current = this.inventory();
    const changed = current.map((record) => {
      if (!record.enabled) return record;
      const activePath = join(this.activeRoot(), record.packageId, record.revisionId);
      const overlay = record.overlayRevision === undefined ? undefined : join(this.overlaysRoot(), record.packageId, record.overlayRevision);
      const sourceExists = existsSync(this.sourcePath(record));
      const expectedActiveHash = sourceExists ? hashEffectivePackage(this.sourcePath(record), overlay, effectiveFileList(this.sourcePath(record), overlay)) : undefined;
      return sourceExists && expectedActiveHash !== undefined && existsSync(activePath) && record.activeHash === hashDirectory(activePath) && record.activeHash === expectedActiveHash ? record : this.update(record, { enabled: false, state: "invalidated" });
    });
    if (changed.some((item, index) => item !== current[index])) this.#saveState({ packages: changed });
    return changed.map(clonePackage);
  }

  snapshotForBackup(): { readonly schemaVersion: 1; readonly packages: readonly { readonly packageId: string; readonly revisionId: string; readonly activeHash?: string; readonly files: readonly string[] }[]; readonly overlays: readonly string[] } {
    const packages = this.inventory().filter((item) => item.enabled).map((item) => ({ packageId: item.packageId, revisionId: item.revisionId, ...(item.activeHash === undefined ? {} : { activeHash: item.activeHash }), files: item.files }));
    const overlays = existsSync(this.overlaysRoot()) ? listFiles(this.overlaysRoot()).map((path) => toPosix(relative(this.overlaysRoot(), path))) : [];
    return { schemaVersion: 1, packages, overlays };
  }

  getRevision(packageRevisionId: string): SkillInventoryItem | undefined {
    const found = this.find(packageRevisionId);
    return found === undefined ? undefined : clonePackage(found);
  }

  sourcePath(record: SkillInventoryItem): string { return join(this.importsRoot(), record.importId, "source"); }
  activePath(record: SkillInventoryItem): string { return join(this.activeRoot(), record.packageId, record.revisionId); }

  private find(packageRevisionId: string): SkillInventoryItem | undefined {
    return this.inventory().find((item) => item.revisionId === packageRevisionId || item.packageId === packageRevisionId);
  }

  private report(record: SkillInventoryItem, status: SkillCompatibilityReport["status"], findings: readonly SkillCompatibilityFinding[], missingReferences: readonly string[] = [], undeclaredExecutables: readonly string[] = []): SkillCompatibilityReport {
    return {
      package: clonePackage(record),
      status,
      files: record.files,
      missingReferences,
      unsupportedDirectives: findings.filter((finding) => finding.code === "SKILL_DIRECTIVE_UNSUPPORTED").map((finding) => finding.message),
      undeclaredExecutables,
      ...(record.overlayRevision === undefined ? {} : { overlayRevision: record.overlayRevision }),
      exactHash: record.contentHash,
      findings: findings.map((finding) => ({ ...finding }))
    };
  }

  private update(record: SkillInventoryItem, patch: Partial<SkillInventoryItem>): SkillInventoryItem { return { ...record, ...patch, schemaVersion: 1 }; }
  private statePath(): string { return join(this.#root, INVENTORY_FILE); }
  private importsRoot(): string { return join(this.#root, "imports"); }
  private overlaysRoot(): string { return join(this.#root, "overlays"); }
  private activeRoot(): string { return join(this.#root, "active"); }
  private jobsRoot(): string { return join(this.#root, "jobs"); }

  #loadState(): { readonly state: StoredSkillState; readonly readOnly: boolean } {
    if (!existsSync(this.statePath())) return { state: { schemaVersion: 1, packages: [] }, readOnly: false };
    try {
      const raw = JSON.parse(readFileSync(this.statePath(), "utf8")) as StoredSkillState;
      if (raw.schemaVersion !== 1) return { state: { schemaVersion: 1, packages: [] }, readOnly: true };
      return { state: { schemaVersion: 1, packages: Array.isArray(raw.packages) ? raw.packages : [] }, readOnly: false };
    } catch {
      return { state: { schemaVersion: 1, packages: [] }, readOnly: true };
    }
  }

  #saveState(input: { packages: readonly SkillInventoryItem[] }): void {
    this.open();
    const partial = this.statePath() + ".partial";
    writeFileSync(partial, JSON.stringify({ schemaVersion: 1, packages: input.packages }, null, 2) + "\n", "utf8");
    renameSync(partial, this.statePath());
  }
}

export class SkillResourceProjector {
  readonly #manager: SkillPackageManager;
  readonly #maxInstructionChars: number;
  readonly #maxResourceBytes: number;

  constructor(input: { manager: SkillPackageManager; maxInstructionChars?: number; maxResourceBytes?: number }) {
    this.#manager = input.manager;
    this.#maxInstructionChars = input.maxInstructionChars ?? 20_000;
    this.#maxResourceBytes = input.maxResourceBytes ?? DEFAULT_LIMITS.maxResourceBytes;
  }

  resolve(request: { task: string; scope: "project" | "unscoped"; enabledSkillIds?: readonly string[] }): SkillActivationDecision[] {
    const task = request.task.toLowerCase();
    const explicit = new Set(request.enabledSkillIds ?? []);
    return this.#manager.inventory().filter((item) => item.enabled && item.state === "active").flatMap((item) => {
      const keywords = (item.metadata.keywords ?? "").split(/[\s,;|]+/u).map((term) => term.trim().toLowerCase()).filter((term) => term.length >= 3);
      const descriptionTriggers = skillDescriptionTriggers(item.metadata.description ?? "");
      const name = (item.metadata.name ?? item.packageId).toLowerCase();
      const relevant = explicit.has(item.packageId) || explicit.has(item.revisionId) || task.includes(item.packageId.toLowerCase()) || task.includes(name) || keywords.some((term) => task.includes(term)) || descriptionTriggers.some((term) => task.includes(term));
      if (!relevant) return [];
      return [{ packageId: item.packageId, revisionId: item.revisionId, reason: explicit.has(item.packageId) || explicit.has(item.revisionId) ? "explicit" as const : "task_match" as const, resources: item.files, capabilities: [] }];
    });
  }

  project(decisions: readonly SkillActivationDecision[]): RuntimeSkillSnapshot {
    const instructions: RuntimeSkillSnapshot["instructions"][number][] = [];
    const resources: { packageId: string; relativePath: string; content: string }[] = [];
    for (const decision of decisions) {
      const record = this.#manager.getRevision(decision.revisionId);
      if (record === undefined || !record.enabled || record.state !== "active") continue;
      const root = this.#manager.activePath(record);
      const skillFile = listFiles(root).find((path) => basename(path).toLowerCase() === "skill.md");
      if (skillFile !== undefined) {
        const filePath = join(root, skillFile);
        const content = readFileSync(filePath, "utf8").slice(0, this.#maxInstructionChars);
        instructions.push({
          packageId: record.packageId,
          revisionId: record.revisionId,
          name: record.metadata.name ?? record.packageId,
          description: record.metadata.description ?? `Imported Skill: ${record.packageId}`,
          filePath,
          baseDir: dirname(filePath),
          content
        });
      }
      for (const file of listFiles(root)) {
        const relativePath = toPosix(file);
        const absoluteFile = join(root, file);
        if (basename(file).toLowerCase() === "skill.md" || !isTextResource(file)) continue;
        const content = readFileSync(absoluteFile, "utf8");
        if (Buffer.byteLength(content, "utf8") <= this.#maxResourceBytes) resources.push({ packageId: record.packageId, relativePath, content });
      }
    }
    const revisionId = createHash("sha256").update(JSON.stringify({ decisions, instructions, resources }), "utf8").digest("hex");
    return { schemaVersion: 1, revisionId, decisions: decisions.map((decision) => ({ ...decision, resources: [...decision.resources], capabilities: [] })), instructions, resources };
  }
}

function skillDescriptionTriggers(description: string): string[] {
  const marker = /(?:triggers?|触发词)\s*[:：]\s*(.+)$/iu.exec(description);
  if (marker?.[1] === undefined) return [];
  return marker[1].split(/[|,，;；]+/u).map((term) => term.trim().toLowerCase()).filter((term) => term.length >= 3);
}

function normalizePackageId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (normalized === "") throw new Error("SKILL_METADATA_INVALID");
  return normalized.slice(0, 96);
}

function dirnameFor(path: string): string {
  return dirname(path);
}

function safeRelativePath(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !path.startsWith("\\\\") && !path.includes("..") && !/^[A-Za-z]:/u.test(path);
}

function copySkillTree(sourceRoot: string, destinationRoot: string, limits: SkillDirectoryLimits): void {
  let fileCount = 0;
  let byteCount = 0;
  const activeRealPaths = new Set<string>();
  const source = resolve(sourceRoot);
  visit(source, destinationRoot);

  function visit(current: string, destination: string): void {
    const real = resolve(current);
    if (activeRealPaths.has(real)) throw new Error("SKILL_PATH_ESCAPE");
    activeRealPaths.add(real);
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = join(current, entry.name);
      const targetPath = join(destination, entry.name);
      if (!safeRelativePath(relative(source, sourcePath))) throw new Error("SKILL_PATH_ESCAPE");
      const information = lstatSync(sourcePath);
      if (information.isSymbolicLink()) {
        const linkTarget = resolve(current, readlinkSync(sourcePath));
        if (!isWithin(source, linkTarget)) throw new Error("SKILL_PATH_ESCAPE");
        const targetInformation = statSync(linkTarget);
        if (targetInformation.isDirectory()) { mkdirSync(targetPath, { recursive: true }); visit(linkTarget, targetPath); }
        else if (targetInformation.isFile()) copyFile(linkTarget, targetPath, targetInformation.size);
        else throw new Error("SKILL_PATH_ESCAPE");
      } else if (information.isDirectory()) {
        mkdirSync(targetPath, { recursive: true });
        visit(sourcePath, targetPath);
      } else if (information.isFile()) {
        copyFile(sourcePath, targetPath, information.size);
      } else {
        throw new Error("SKILL_PATH_ESCAPE");
      }
    }
    activeRealPaths.delete(real);
  }

  function copyFile(sourcePath: string, targetPath: string, size: number): void {
    fileCount += 1;
    byteCount += size;
    if (fileCount > limits.maxFiles || byteCount > limits.maxBytes) throw new Error("SKILL_RESOURCE_LIMIT_EXCEEDED");
    mkdirSync(dirnameFor(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  visit(root);
  return files.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(toPosix(relative(root, path)));
    }
  }
}

function hashDirectory(root: string): string {
  const hash = createHash("sha256");
  for (const path of listFiles(root)) {
    hash.update(path, "utf8");
    hash.update(readFileSync(join(root, path)));
  }
  return hash.digest("hex");
}

function effectiveFileList(sourceRoot: string, overlayRoot: string | undefined): string[] {
  const files = new Set(listFiles(sourceRoot));
  if (overlayRoot !== undefined && existsSync(overlayRoot)) for (const file of listFiles(overlayRoot)) files.add(file);
  return [...files].sort((left, right) => left.localeCompare(right));
}

function hashEffectivePackage(sourceRoot: string, overlayRoot: string | undefined, files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of files) {
    const effectivePath = overlayRoot !== undefined && existsSync(join(overlayRoot, path)) ? join(overlayRoot, path) : join(sourceRoot, path);
    hash.update(path, "utf8");
    hash.update(readFileSync(effectivePath));
  }
  return hash.digest("hex");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith(".." + sep) && !/^[A-Za-z]:/u.test(relativePath));
}

function parseSkillMetadata(content: string): { readonly values: Record<string, string>; readonly dependencies: readonly string[]; readonly executables: readonly string[]; readonly keywords: readonly string[]; readonly malformed: boolean; readonly unsupported: readonly string[] } {
  const values: Record<string, string> = {};
  const dependencies: string[] = [];
  const executables: string[] = [];
  const keywords: string[] = [];
  const unsupported: string[] = [];
  let malformed = false;
  if (!content.startsWith("---")) return { values, dependencies, executables, keywords, malformed: false, unsupported };
  const end = content.indexOf("\n---", 3);
  if (end < 0) return { values, dependencies, executables, keywords, malformed: true, unsupported };
  const frontMatter = content.slice(3, end).split(/\r?\n/u);
  for (const line of frontMatter) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/u.exec(line);
    if (match === null) { if (line.trim() !== "") malformed = true; continue; }
    const key = match[1]!.toLowerCase();
    const raw = match[2]!;
    if (!SUPPORTED_METADATA.has(key)) { unsupported.push(key); continue; }
    if (key === "dependencies" || key === "executables" || key === "keywords") {
      const valuesList = raw.replace(/^\[/u, "").replace(/\]$/u, "").split(",").map((item) => item.trim().replace(/^['"]|['"]$/gu, "")).filter(Boolean);
      if (key === "dependencies") dependencies.push(...valuesList);
      else if (key === "executables") executables.push(...valuesList);
      else keywords.push(...valuesList);
    } else {
      values[key] = raw.replace(/^['"]|['"]$/gu, "");
    }
  }
  if (dependencies.length > 0) values.dependencies = dependencies.join(",");
  if (executables.length > 0) values.executables = executables.join(",");
  if (keywords.length > 0) values.keywords = keywords.join(",");
  return { values, dependencies, executables, keywords, malformed, unsupported };
}

function referencedPaths(content: string): string[] {
  const references = new Set<string>();
  const markdown = /\]\(([^)#?]+)(?:[#?][^)]*)?\)/gu;
  for (const match of content.matchAll(markdown)) if (match[1] !== undefined) references.add(match[1]);
  const direct = /(?:^|[\s\x60])(scripts|resources|references|assets)\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/gu;
  for (const match of content.matchAll(direct)) if (match[1] !== undefined && match[2] !== undefined) references.add(match[1] + "/" + match[2]);
  return [...references].map((reference) => reference.replace(/[.,;:!?]+$/gu, ""));
}

function isTextResource(path: string): boolean {
  return new Set([".md", ".txt", ".json", ".yaml", ".yml", ".xml", ".csv", ".py", ".js", ".mjs", ".ts", ".sh", ".ps1"]).has(extname(path).toLowerCase());
}

function clonePackage(item: SkillInventoryItem): SkillInventoryItem {
  return { ...item, declaredDependencies: [...item.declaredDependencies], files: [...item.files], findings: item.findings.map((finding) => ({ ...finding })), metadata: { ...item.metadata } };
}
