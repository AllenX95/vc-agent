import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * The only Skill source admitted by VC Agent.
 *
 * This Module deliberately has no package, activation, revision, or body
 * snapshot state. A valid Skill directory is available while it is present
 * below `root`; removing it makes the Skill unavailable at the next Pi
 * session boundary.
 */

export type VcSkillDiagnosticSeverity = "info" | "warning" | "error";

export type VcSkillDiagnosticCode =
  | "SKILL_DIRECTORY_MISSING"
  | "SKILL_DIRECTORY_UNREADABLE"
  | "SKILL_PATH_ESCAPE"
  | "SKILL_SYMLINK_BROKEN"
  | "SKILL_SYMLINK_CYCLE"
  | "SKILL_SPECIAL_FILE"
  | "SKILL_METADATA_INVALID"
  | "SKILL_NAME_INVALID"
  | "SKILL_DESCRIPTION_MISSING"
  | "SKILL_REFERENCE_MISSING"
  | "SKILL_REFERENCE_ESCAPE"
  | "SKILL_COLLISION"
  | "SKILL_IMPORT_FAILED"
  | "SKILL_IMPORT_DESTINATION_EXISTS"
  | "SKILL_RESOURCE_LIMIT_EXCEEDED";

export interface VcSkillDiagnostic {
  readonly code: VcSkillDiagnosticCode;
  readonly severity: VcSkillDiagnosticSeverity;
  readonly message: string;
  readonly path?: string;
}

export interface VcSkillMetadata {
  /** Name exposed by Pi in the available-skills metadata. */
  readonly name: string;
  readonly description: string;
  /** Lexical path to the Skill's SKILL.md under the dedicated root. */
  readonly filePath: string;
  /** Lexical Skill directory used to resolve relative resources. */
  readonly baseDir: string;
  /** POSIX relative path from the dedicated root to SKILL.md. */
  readonly relativePath: string;
}

export interface VcSkillsDirectorySnapshot {
  readonly root: string;
  readonly canonicalRoot: string;
  readonly skills: readonly VcSkillMetadata[];
  readonly diagnostics: readonly VcSkillDiagnostic[];
}

export interface VcSkillImportRequest {
  readonly sourceDirectory: string;
  /** Optional one-segment destination directory name. Defaults to source basename. */
  readonly destinationName?: string;
}

export interface VcSkillImportResult {
  readonly destinationPath: string;
  readonly files: readonly string[];
  readonly skills: readonly VcSkillMetadata[];
  readonly diagnostics: readonly VcSkillDiagnostic[];
}

export interface VcSkillDirectoryLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxFileBytes: number;
}

export interface VcSkillsDirectoryAdapterOptions {
  readonly root: string;
  readonly limits?: Partial<VcSkillDirectoryLimits>;
}

const DEFAULT_LIMITS: VcSkillDirectoryLimits = {
  maxFiles: 2_000,
  maxBytes: 50_000_000,
  maxFileBytes: 10_000_000
};

/**
 * A narrow Adapter around the one VC Agent Skills Directory.
 *
 * It intentionally does not inspect Pi, Codex, Claude, project, package, or
 * Extension roots. Callers can pass `root` to Pi's `additionalSkillPaths` and
 * use `filterLoadedSkills` as a defensive `skillsOverride`.
 */
export class VcSkillsDirectoryAdapter {
  readonly #root: string;
  readonly #limits: VcSkillDirectoryLimits;

  constructor(input: VcSkillsDirectoryAdapterOptions) {
    if (input.root.trim() === "") throw new Error("SKILL_DIRECTORY_MISSING");
    this.#root = resolve(input.root);
    this.#limits = {
      ...DEFAULT_LIMITS,
      ...(input.limits ?? {})
    };
    validateLimits(this.#limits);
  }

  /** The configured, lexical dedicated directory. */
  get root(): string {
    return this.#root;
  }

  /**
   * Return the only path that should be supplied to Pi's resource loader.
   * This method makes it harder for callers to accidentally add ambient roots.
   */
  additionalSkillPaths(): readonly [string] {
    return [this.#root];
  }

  /** Create the directory when an explicit import needs it. */
  ensureRoot(): string {
    mkdirSync(this.#root, { recursive: true });
    return this.#root;
  }

  /**
   * Enumerate valid Skill metadata and deterministic diagnostics.
   * No activation/revision state is consulted or written.
   */
  discover(): VcSkillsDirectorySnapshot {
    const diagnostics: VcSkillDiagnostic[] = [];
    const skills: VcSkillMetadata[] = [];
    const canonicalRoot = canonicalPath(this.#root) ?? this.#root;

    if (!existsSync(this.#root)) {
      diagnostics.push({
        code: "SKILL_DIRECTORY_MISSING",
        severity: "warning",
        message: "The dedicated VC Agent Skills Directory does not exist yet.",
        path: this.#root
      });
      return { root: this.#root, canonicalRoot, skills, diagnostics };
    }

    let rootStats: ReturnType<typeof statSync>;
    try {
      rootStats = statSync(this.#root);
    } catch {
      diagnostics.push({
        code: "SKILL_DIRECTORY_UNREADABLE",
        severity: "error",
        message: "The dedicated VC Agent Skills Directory cannot be read.",
        path: this.#root
      });
      return { root: this.#root, canonicalRoot, skills, diagnostics };
    }
    if (!rootStats.isDirectory()) {
      diagnostics.push({
        code: "SKILL_DIRECTORY_UNREADABLE",
        severity: "error",
        message: "The dedicated VC Agent Skills path is not a directory.",
        path: this.#root
      });
      return { root: this.#root, canonicalRoot, skills, diagnostics };
    }

    const visitedDirectories = new Set<string>();
    this.#walk(this.#root, canonicalRoot, visitedDirectories, skills, diagnostics);

    skills.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const names = new Map<string, VcSkillMetadata>();
    for (const skill of skills) {
      const existing = names.get(skill.name);
      if (existing === undefined) {
        names.set(skill.name, skill);
        continue;
      }
      diagnostics.push({
        code: "SKILL_COLLISION",
        severity: "error",
        message: `Skill name "${skill.name}" collides with another dedicated Skill.`,
        path: skill.filePath
      });
      // Keep both metadata entries for diagnostics and let Pi's collision
      // handling decide the provider-facing winner in its normal loader.
      void existing;
    }

    diagnostics.sort((left, right) => {
      const pathOrder = (left.path ?? "").localeCompare(right.path ?? "");
      if (pathOrder !== 0) return pathOrder;
      return left.code.localeCompare(right.code);
    });
    return { root: this.#root, canonicalRoot, skills, diagnostics };
  }

  /**
   * Check a path after resolving every symlink/junction hop. Missing paths are
   * rejected by default; callers can opt into an existing-parent check while
   * preparing a new destination.
   */
  isContained(path: string, options: { allowMissing?: boolean } = {}): boolean {
    const canonicalRoot = canonicalPath(this.#root) ?? resolve(this.#root);
    const canonical = canonicalPath(path);
    if (canonical !== undefined) return isWithin(canonicalRoot, canonical);
    if (!options.allowMissing) return false;
    const existingParent = nearestExistingParent(path);
    if (existingParent === undefined) return false;
    const canonicalParent = canonicalPath(existingParent);
    return canonicalParent !== undefined && isWithin(canonicalRoot, canonicalParent) && isWithin(canonicalRoot, resolve(path));
  }

  /**
   * Defensive filter suitable for Pi's `skillsOverride`. The input is kept
   * structural so this package does not depend on a particular Pi fork.
   */
  filterLoadedSkills<T extends { readonly filePath: string; readonly baseDir: string }>(skills: readonly T[]): T[] {
    return skills.filter((skill) => this.isContained(skill.filePath) && this.isContained(skill.baseDir));
  }

  /**
   * Copy a complete Skill directory into the dedicated directory. Symlinks and
   * junctions are dereferenced only when every hop remains inside the source;
   * no link is retained in the destination.
   */
  importSkill(request: VcSkillImportRequest): VcSkillImportResult {
    const sourceRoot = resolve(request.sourceDirectory);
    const destinationName = request.destinationName ?? basename(sourceRoot);
    if (!isSafeDirectoryName(destinationName)) throw new Error("SKILL_IMPORT_FAILED");

    let sourceStats: ReturnType<typeof statSync>;
    try {
      sourceStats = statSync(sourceRoot);
    } catch {
      throw new Error("SKILL_IMPORT_FAILED");
    }
    if (!sourceStats.isDirectory()) throw new Error("SKILL_IMPORT_FAILED");

    const sourceCanonicalRoot = canonicalPath(sourceRoot);
    if (sourceCanonicalRoot === undefined) throw new Error("SKILL_IMPORT_FAILED");
    this.ensureRoot();
    const destinationPath = join(this.#root, destinationName);
    if (!this.isContained(destinationPath, { allowMissing: true })) throw new Error("SKILL_PATH_ESCAPE");
    if (existsSync(destinationPath)) throw new Error("SKILL_IMPORT_DESTINATION_EXISTS");

    const counters = { files: 0, bytes: 0 };
    const visitedDirectories = new Set<string>();
    try {
      mkdirSync(destinationPath, { recursive: true });
      this.#copyTree(sourceRoot, sourceCanonicalRoot, destinationPath, visitedDirectories, counters);

      const imported = this.discover();
      const prefix = `${resolve(destinationPath)}${sep}`;
      const skills = imported.skills.filter((skill) => skill.filePath === resolve(destinationPath) || skill.filePath.startsWith(prefix));
      const files = listRegularFiles(destinationPath);
      if (skills.length === 0) throw new Error("SKILL_METADATA_INVALID");
      return {
        destinationPath: resolve(destinationPath),
        files,
        skills,
        diagnostics: imported.diagnostics.filter((diagnostic) => diagnostic.path === undefined || diagnostic.path.startsWith(prefix))
      };
    } catch (error) {
      rmSync(destinationPath, { recursive: true, force: true });
      if (error instanceof Error && error.message.startsWith("SKILL_")) throw error;
      throw new Error("SKILL_IMPORT_FAILED");
    }
  }

  /**
   * Atomically replace an existing dedicated Skill directory.
   *
   * This is intentionally an Adapter operation rather than a workflow concern:
   * the candidate copy, backup, canonical containment checks, rollback, and
   * final metadata projection all stay local to the one source Module. A
   * failed replacement leaves the prior directory available for retry.
   */
  replaceSkill(request: VcSkillImportRequest): VcSkillImportResult {
    const destinationName = request.destinationName ?? basename(resolve(request.sourceDirectory));
    if (!isSafeDirectoryName(destinationName)) throw new Error("SKILL_IMPORT_FAILED");
    this.ensureRoot();
    const destinationPath = join(this.#root, destinationName);
    if (!this.isContained(destinationPath, { allowMissing: true })) throw new Error("SKILL_PATH_ESCAPE");
    if (!existsSync(destinationPath)) return this.importSkill(request);

    const suffix = randomUUID();
    const candidateName = `${destinationName}.candidate-${suffix}`;
    const backupName = `${destinationName}.backup-${suffix}`;
    const candidatePath = join(this.#root, candidateName);
    const backupPath = join(this.#root, backupName);
    if (!this.isContained(candidatePath, { allowMissing: true }) || !this.isContained(backupPath, { allowMissing: true })) throw new Error("SKILL_PATH_ESCAPE");

    // importSkill performs all source-side validation and leaves no links in
    // the candidate. It also cleans the candidate if validation fails.
    this.importSkill({ sourceDirectory: request.sourceDirectory, destinationName: candidateName });
    let oldMoved = false;
    try {
      renameSync(destinationPath, backupPath);
      oldMoved = true;
      renameSync(candidatePath, destinationPath);
      rmSync(backupPath, { recursive: true, force: true });
    } catch (error) {
      // Best-effort rollback. Never remove the old destination until the
      // candidate has been moved successfully.
      try {
        if (existsSync(destinationPath) && oldMoved) rmSync(destinationPath, { recursive: true, force: true });
        if (oldMoved && existsSync(backupPath)) renameSync(backupPath, destinationPath);
        if (existsSync(candidatePath)) rmSync(candidatePath, { recursive: true, force: true });
      } catch {
        // Preserve the original failure; diagnostics can surface any unusual
        // filesystem state and the backup remains if rollback was interrupted.
      }
      if (error instanceof Error && error.message.startsWith("SKILL_")) throw error;
      throw new Error("SKILL_IMPORT_FAILED");
    }

    const discovered = this.discover();
    const prefix = `${resolve(destinationPath)}${sep}`;
    const skills = discovered.skills.filter((skill) => skill.filePath === resolve(destinationPath) || skill.filePath.startsWith(prefix));
    if (skills.length === 0) throw new Error("SKILL_METADATA_INVALID");
    return {
      destinationPath: resolve(destinationPath),
      files: listRegularFiles(destinationPath),
      skills,
      diagnostics: discovered.diagnostics.filter((diagnostic) => diagnostic.path === undefined || diagnostic.path.startsWith(prefix))
    };
  }

  #walk(
    directory: string,
    canonicalRoot: string,
    visitedDirectories: Set<string>,
    skills: VcSkillMetadata[],
    diagnostics: VcSkillDiagnostic[]
  ): void {
    const canonicalDirectory = canonicalPath(directory);
    if (canonicalDirectory === undefined) {
      diagnostics.push({ code: "SKILL_SYMLINK_BROKEN", severity: "error", message: "Skill directory target cannot be resolved.", path: directory });
      return;
    }
    if (!isWithin(canonicalRoot, canonicalDirectory)) {
      diagnostics.push({ code: "SKILL_PATH_ESCAPE", severity: "error", message: "Skill path escapes the dedicated directory.", path: directory });
      return;
    }
    if (visitedDirectories.has(canonicalDirectory)) {
      diagnostics.push({ code: "SKILL_SYMLINK_CYCLE", severity: "error", message: "Skill directory contains a symlink or junction cycle.", path: directory });
      return;
    }
    visitedDirectories.add(canonicalDirectory);
    try {
      let entries: Dirent<string>[];
      try {
        entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
      } catch {
        diagnostics.push({ code: "SKILL_DIRECTORY_UNREADABLE", severity: "error", message: "Skill directory cannot be read.", path: directory });
        return;
      }

      const skillFiles = entries.filter((entry) => entry.name.toLowerCase() === "skill.md");
      for (const entry of skillFiles) {
        const filePath = join(directory, entry.name);
        if (!this.#validateEntryPath(filePath, canonicalRoot, diagnostics)) continue;
        const metadata = this.#readMetadata(filePath, diagnostics);
        if (metadata !== undefined) skills.push(metadata);
        // Pi treats a directory with SKILL.md as a Skill root and does not scan
        // nested resources as independent Skills.
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const child = join(directory, entry.name);
        if (!this.#validateEntryPath(child, canonicalRoot, diagnostics)) continue;
        let childStats: ReturnType<typeof statSync>;
        try {
          childStats = statSync(child);
        } catch {
          diagnostics.push({ code: "SKILL_SYMLINK_BROKEN", severity: "error", message: "Skill path target cannot be resolved.", path: child });
          continue;
        }
        if (childStats.isDirectory()) {
          this.#walk(child, canonicalRoot, visitedDirectories, skills, diagnostics);
        } else if (childStats.isFile() && entry.name.toLowerCase().endsWith(".md") && directory === this.#root) {
          const metadata = this.#readMetadata(child, diagnostics);
          if (metadata !== undefined) skills.push(metadata);
        } else if (!childStats.isFile()) {
          diagnostics.push({ code: "SKILL_SPECIAL_FILE", severity: "error", message: "Special filesystem entries are not allowed in Skills.", path: child });
        }
      }
    } finally {
      visitedDirectories.delete(canonicalDirectory);
    }
  }

  #validateEntryPath(path: string, canonicalRoot: string, diagnostics: VcSkillDiagnostic[]): boolean {
    const canonical = canonicalPath(path);
    if (canonical === undefined) {
      diagnostics.push({ code: "SKILL_SYMLINK_BROKEN", severity: "error", message: "Skill path target cannot be resolved.", path });
      return false;
    }
    if (!isWithin(canonicalRoot, canonical)) {
      diagnostics.push({ code: "SKILL_PATH_ESCAPE", severity: "error", message: "Skill path escapes the dedicated directory.", path });
      return false;
    }
    return true;
  }

  #readMetadata(filePath: string, diagnostics: VcSkillDiagnostic[]): VcSkillMetadata | undefined {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      diagnostics.push({ code: "SKILL_METADATA_INVALID", severity: "error", message: "SKILL.md cannot be read.", path: filePath });
      return undefined;
    }
    const frontmatter = parseFrontmatter(content);
    if (frontmatter === undefined) {
      diagnostics.push({ code: "SKILL_METADATA_INVALID", severity: "error", message: "SKILL.md frontmatter is malformed.", path: filePath });
      return undefined;
    }
    const name = frontmatter.name ?? basename(dirname(filePath));
    const description = frontmatter.description ?? "";
    let valid = true;
    if (!isValidSkillName(name)) {
      valid = false;
      diagnostics.push({ code: "SKILL_NAME_INVALID", severity: "warning", message: "Skill name must use lowercase letters, digits, and hyphens.", path: filePath });
    }
    if (description.trim() === "") {
      valid = false;
      diagnostics.push({ code: "SKILL_DESCRIPTION_MISSING", severity: "error", message: "Skill description is required.", path: filePath });
    }
    const referenceDiagnostics = this.#validateReferences(filePath, content);
    diagnostics.push(...referenceDiagnostics);
    if (referenceDiagnostics.some((diagnostic) => diagnostic.code === "SKILL_REFERENCE_ESCAPE" || diagnostic.code === "SKILL_PATH_ESCAPE")) valid = false;
    if (!valid) return undefined;
    const root = canonicalPath(this.#root) ?? this.#root;
    return {
      name,
      description,
      filePath: resolve(filePath),
      baseDir: resolve(dirname(filePath)),
      relativePath: toPosix(relative(root, filePath))
    };
  }

  #validateReferences(filePath: string, content: string): VcSkillDiagnostic[] {
    const diagnostics: VcSkillDiagnostic[] = [];
    const baseDir = dirname(filePath);
    const references = new Set<string>();
    const markdownLinks = /\[[^\]]*\]\(([^)]+)\)/gu;
    for (const match of content.matchAll(markdownLinks)) {
      const reference = match[1]?.trim();
      if (reference !== undefined) references.add(reference);
    }
    for (const reference of references) {
      if (reference === "" || /^https?:\/\//iu.test(reference) || /^mailto:/iu.test(reference) || reference.startsWith("#")) continue;
      if (/^[A-Za-z]:[\\/]/u.test(reference) || reference.startsWith("/") || reference.startsWith("\\\\") || reference.includes("..")) {
        const candidate = resolve(baseDir, reference);
        if (!this.isContained(candidate, { allowMissing: true })) {
          diagnostics.push({ code: "SKILL_REFERENCE_ESCAPE", severity: "error", message: "Skill reference escapes the dedicated directory.", path: filePath });
          continue;
        }
      }
      const candidate = resolve(baseDir, reference);
      if (existsSync(candidate) && !this.isContained(candidate)) {
        diagnostics.push({ code: "SKILL_REFERENCE_ESCAPE", severity: "error", message: "Skill reference target escapes the dedicated directory.", path: candidate });
      } else if (!existsSync(candidate) && !reference.startsWith("#")) {
        diagnostics.push({ code: "SKILL_REFERENCE_MISSING", severity: "warning", message: "Skill reference target is missing.", path: candidate });
      }
    }
    return diagnostics;
  }

  #copyTree(
    sourceDirectory: string,
    sourceCanonicalRoot: string,
    destinationDirectory: string,
    visitedDirectories: Set<string>,
    counters: { files: number; bytes: number }
  ): void {
    const canonicalDirectory = canonicalPath(sourceDirectory);
    if (canonicalDirectory === undefined || !isWithin(sourceCanonicalRoot, canonicalDirectory)) throw new Error("SKILL_PATH_ESCAPE");
    if (visitedDirectories.has(canonicalDirectory)) throw new Error("SKILL_SYMLINK_CYCLE");
    visitedDirectories.add(canonicalDirectory);
    try {
      mkdirSync(destinationDirectory, { recursive: true });
      for (const entry of readdirSync(sourceDirectory, { withFileTypes: true, encoding: "utf8" })) {
        const sourcePath = join(sourceDirectory, entry.name);
        const destinationPath = join(destinationDirectory, entry.name);
        const canonical = canonicalPath(sourcePath);
        if (canonical === undefined || !isWithin(sourceCanonicalRoot, canonical)) throw new Error("SKILL_PATH_ESCAPE");
        const stats = statSync(sourcePath);
        if (stats.isDirectory()) {
          this.#copyTree(sourcePath, sourceCanonicalRoot, destinationPath, visitedDirectories, counters);
          continue;
        }
        if (!stats.isFile()) throw new Error("SKILL_SPECIAL_FILE");
        const size = stats.size;
        counters.files += 1;
        counters.bytes += size;
        if (counters.files > this.#limits.maxFiles || counters.bytes > this.#limits.maxBytes || size > this.#limits.maxFileBytes) throw new Error("SKILL_RESOURCE_LIMIT_EXCEEDED");
        mkdirSync(dirname(destinationPath), { recursive: true });
        copyFileSync(sourcePath, destinationPath);
      }
    } finally {
      visitedDirectories.delete(canonicalDirectory);
    }
  }
}

/** Alias kept explicit for callers that prefer the domain name. */
export { VcSkillsDirectoryAdapter as VcAgentSkillsDirectory };

function validateLimits(limits: VcSkillDirectoryLimits): void {
  if (![limits.maxFiles, limits.maxBytes, limits.maxFileBytes].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("SKILL_RESOURCE_LIMIT_EXCEEDED");
}

function canonicalPath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  }
}

function nearestExistingParent(path: string): string | undefined {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return current;
}

function isWithin(root: string, target: string): boolean {
  const normalizedRoot = normalizeForComparison(root);
  const normalizedTarget = normalizeForComparison(target);
  if (normalizedRoot === normalizedTarget) return true;
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return normalizedTarget.startsWith(prefix);
}

function normalizeForComparison(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSafeDirectoryName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && basename(name) === name && !name.includes("/") && !name.includes("\\") && !/^[A-Za-z]:/u.test(name);
}

function isValidSkillName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && /^[a-z0-9-]+$/u.test(name) && !name.startsWith("-") && !name.endsWith("-") && !name.includes("--");
}

function parseFrontmatter(content: string): { readonly name?: string; readonly description?: string } | undefined {
  const normalized = content.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").replace(/^\uFEFF/u, "");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return undefined;
  const values: { name?: string; description?: string } = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key !== "name" && key !== "description") continue;
    const unquoted = value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2").trim();
    if (key === "name") values.name = unquoted;
    else values.description = unquoted;
  }
  return values;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function listRegularFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true, encoding: "utf8" })) {
      const path = join(directory, entry.name);
      const stats = statSync(path);
      if (stats.isDirectory()) visit(path);
      else if (stats.isFile()) files.push(toPosix(relative(root, path)));
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}
