import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
  type Extension,
  type LoadExtensionsResult,
  type ResourceCollision,
  type ResourceDiagnostic,
  type ResourceLoader,
  type Skill
} from "@earendil-works/pi-coding-agent";
import { piSkillId } from "@vc-agent/contracts";

/**
 * Configuration for the one Pi resource loading seam used by VC Agent.
 *
 * `agentDir` and `skillsRoot` are deliberately explicit.  They must point at
 * the application-owned Pi directory and must not be the user's ordinary Pi,
 * Codex, or Claude Code directories. Disabled Skill ids are filtered at the
 * same native `skillsOverride` seam so Pi never exposes them to a session.
 */
export interface PiResourceRuntimeOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly skillsRoot?: string;
  /** Explicit extension sources in addition to agentDir/extensions/settings. */
  readonly extensionPaths?: readonly string[];
  /** Alias kept for callers that use Pi's native option name. */
  readonly additionalExtensionPaths?: readonly string[];
  /** Optional path to the pinned pi-mcp-adapter entry point. */
  readonly mcpAdapterPath?: string;
  /** App-owned mcp.json passed to the adapter's supported extension flag. */
  readonly mcpConfigPath?: string;
  /** Optional Host-owned system prompt override for the Pi session. */
  readonly systemPrompt?: string;
  /** Optional Host-owned prompt suffixes for the Pi session. */
  readonly appendSystemPrompt?: readonly string[];
  readonly noPromptTemplates?: boolean;
  readonly noThemes?: boolean;
  readonly noContextFiles?: boolean;
  /** Optional caller-owned settings manager, primarily useful for tests. */
  readonly settingsManager?: SettingsManager;
  /** One coarse project-resource trust decision; false by default. */
  readonly projectResourcesTrusted?: boolean;
  /** Skill ids explicitly disabled from the dedicated source. */
  readonly disabledSkillIds?: readonly string[];
  /** Additional extension flag values (for example, adapter-specific flags). */
  readonly extensionFlagValues?: ReadonlyMap<string, boolean | string>;
}

export interface PiResourceDiagnostic {
  readonly type: "info" | "warning" | "error" | "collision";
  readonly source: "extension" | "skill" | "mcp" | "runtime";
  readonly message: string;
  readonly path?: string;
  readonly blocking?: boolean;
  readonly collision?: ResourceCollision;
}

export interface PiResourceRuntimeSnapshot {
  readonly generation: number;
  readonly extensions: LoadExtensionsResult;
  readonly skills: readonly Skill[];
  readonly systemPrompt: string | undefined;
  readonly appendSystemPrompt: readonly string[];
  readonly diagnostics: readonly PiResourceDiagnostic[];
  /** True when the resource set is ambiguous or otherwise unsafe to start. */
  readonly hasBlockingDiagnostics: boolean;
  /** True when a requested reload was deferred until the active Turn ended. */
  readonly reloadDeferred: boolean;
}

export interface PiResourceTurnLease {
  readonly close: () => Promise<PiResourceRuntimeSnapshot | undefined>;
}

/**
 * Adapter around Pi's DefaultResourceLoader.
 *
 * The loader is intentionally constructed without reloading.  Constructing a
 * runtime therefore does not import Extension code, connect MCP servers, or
 * invoke a Skill.  `reload()` is the explicit lifecycle operation used at a
 * session boundary.
 */
export class PiResourceRuntime {
  readonly #cwd: string;
  readonly #agentDir: string;
  readonly #skillsRoot: string;
  readonly #settingsManager: SettingsManager;
  readonly #resourceLoader: ResourceLoader;
  readonly #extensionFlagValues: ReadonlyMap<string, boolean | string>;
  readonly #disabledSkillIds: ReadonlySet<string>;
  #snapshot: PiResourceRuntimeSnapshot;
  #activeTurns = 0;
  #reloadQueued = false;
  #closeQueued = false;
  #closed = false;

  constructor(options: PiResourceRuntimeOptions) {
    this.#cwd = resolve(options.cwd);
    this.#agentDir = resolve(options.agentDir);
    this.#skillsRoot = resolve(options.skillsRoot ?? `${this.#agentDir}${sep}skills`);
    this.#disabledSkillIds = new Set(options.disabledSkillIds ?? []);
    this.#settingsManager = options.settingsManager ?? SettingsManager.create(
      this.#cwd,
      this.#agentDir,
      { projectTrusted: options.projectResourcesTrusted ?? false }
    );

    const mcpAdapterUnavailable = options.mcpConfigPath !== undefined && (
      options.mcpAdapterPath === undefined || !existsSync(resolve(options.mcpAdapterPath))
    );
    const extensionPaths = dedupePaths([
      ...(options.extensionPaths ?? []),
      ...(options.additionalExtensionPaths ?? []),
      ...(options.mcpAdapterPath === undefined || mcpAdapterUnavailable ? [] : [options.mcpAdapterPath])
    ]);
    const flagValues = new Map(options.extensionFlagValues ?? []);
    this.#mcpAdapterUnavailable = mcpAdapterUnavailable;
    if (options.mcpConfigPath !== undefined && !this.#mcpAdapterUnavailable) {
      flagValues.set("mcp-config", resolve(options.mcpConfigPath));
    }
    this.#extensionFlagValues = flagValues;
    if (this.#mcpAdapterUnavailable) {
      this.#pendingFlagDiagnostics = [{
        type: "error",
        source: "mcp",
        message: "MCP_ADAPTER_UNAVAILABLE: pi-mcp-adapter asset is unavailable; MCP configuration cannot be loaded.",
        blocking: true
      }];
    }

    const nativeLoader = new DefaultResourceLoader({
      cwd: this.#cwd,
      agentDir: this.#agentDir,
      settingsManager: this.#settingsManager,
      additionalExtensionPaths: extensionPaths,
      // This is the sole Skill source supplied to Pi.  Pi's ambient global and
      // project discovery remains disabled, including ~/.agents/skills.
      noSkills: true,
      additionalSkillPaths: [this.#skillsRoot],
      ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      ...(options.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: [...options.appendSystemPrompt] }),
      ...(options.noPromptTemplates === undefined ? {} : { noPromptTemplates: options.noPromptTemplates }),
      ...(options.noThemes === undefined ? {} : { noThemes: options.noThemes }),
      ...(options.noContextFiles === undefined ? {} : { noContextFiles: options.noContextFiles }),
      skillsOverride: (result) => filterContainedSkills(result, this.#skillsRoot, this.#disabledSkillIds)
    });
    // Extensions may advertise additional Skills through resources_discover.
    // Keep the Pi lifecycle intact while filtering those paths at the same
    // ResourceLoader Seam; only canonical paths under the dedicated root are
    // admitted.
    this.#resourceLoader = createSkillIsolatedResourceLoader(nativeLoader, this.#skillsRoot, this.#disabledSkillIds);

    this.#snapshot = this.#makeSnapshot(0, false, []);
  }

  get cwd(): string {
    return this.#cwd;
  }

  get agentDir(): string {
    return this.#agentDir;
  }

  get skillsRoot(): string {
    return this.#skillsRoot;
  }

  get settingsManager(): SettingsManager {
    return this.#settingsManager;
  }

  /** The native loader supplied to createAgentSession(). */
  get resourceLoader(): ResourceLoader {
    return this.#resourceLoader;
  }

  get snapshot(): PiResourceRuntimeSnapshot {
    return this.#snapshot;
  }

  get diagnostics(): readonly PiResourceDiagnostic[] {
    return this.#snapshot.diagnostics;
  }

  /** Provider-facing Extension tool names, sorted deterministically. */
  getToolNames(): readonly string[] {
    const names = new Set<string>();
    for (const extension of this.#resourceLoader.getExtensions().extensions) {
      for (const name of extension.tools.keys()) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Start a Turn lease.  Reloads requested while a lease is active are queued
   * and applied only after the final lease is closed.
   */
  beginTurn(): PiResourceTurnLease {
    this.assertOpen();
    this.#activeTurns += 1;
    let closed = false;
    return {
      close: async () => {
        if (closed) return undefined;
        closed = true;
        return this.endTurn();
      }
    };
  }

  /** Compatibility-friendly explicit counterpart to beginTurn(). */
  async endTurn(): Promise<PiResourceRuntimeSnapshot | undefined> {
    if (this.#activeTurns === 0) return undefined;
    this.#activeTurns -= 1;
    if (this.#activeTurns > 0) return undefined;
    if (this.#closeQueued) {
      this.#closeQueued = false;
      this.#closed = true;
      this.#resourceLoader.getExtensions().runtime.invalidate("Pi resource runtime closed");
      return undefined;
    }
    if (!this.#reloadQueued) return undefined;
    this.#reloadQueued = false;
    return this.#reloadNow();
  }

  /**
   * Reload the native Pi resources.  During an Active Turn this method only
   * records the request and returns the unchanged snapshot.
   */
  async reload(): Promise<PiResourceRuntimeSnapshot> {
    this.assertOpen();
    if (this.#activeTurns > 0) {
      this.#reloadQueued = true;
      this.#snapshot = this.#makeSnapshot(this.#snapshot.generation, true, this.#snapshot.diagnostics);
      return this.#snapshot;
    }
    return this.#reloadNow();
  }

  /**
   * Mark this resource runtime closed after the active Turn, if any.  Pi's
   * AgentSession remains responsible for emitting extension shutdown events;
   * this method never executes code merely to close a dormant loader.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#activeTurns > 0) {
      this.#closeQueued = true;
      this.#reloadQueued = false;
      return;
    }
    this.#closed = true;
    this.#resourceLoader.getExtensions().runtime.invalidate("Pi resource runtime closed");
  }

  async #reloadNow(): Promise<PiResourceRuntimeSnapshot> {
    this.assertOpen();
    const nextGeneration = this.#snapshot.generation + 1;
    try {
      await this.#resourceLoader.reload();
      this.#applyExtensionFlagValues();
      this.#snapshot = this.#makeSnapshot(nextGeneration, false, []);
      return this.#snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic: PiResourceDiagnostic = {
        type: "error",
        source: "runtime",
        message: `Pi resource reload failed: ${message}`,
        blocking: true
      };
      this.#snapshot = this.#makeSnapshot(this.#snapshot.generation, false, [diagnostic]);
      return this.#snapshot;
    }
  }

  #applyExtensionFlagValues(): void {
    if (this.#mcpAdapterUnavailable) return;
    if (this.#extensionFlagValues.size === 0) return;
    const result = this.#resourceLoader.getExtensions();
    const registered = new Map<string, "boolean" | "string">();
    for (const extension of result.extensions) {
      for (const [name, flag] of extension.flags) registered.set(name, flag.type);
    }
    const diagnostics: PiResourceDiagnostic[] = [];
    for (const [name, value] of this.#extensionFlagValues) {
      const type = registered.get(name);
      if (type === undefined) {
        diagnostics.push({ type: "error", source: "mcp", message: `Unknown Extension flag --${name}`, blocking: true });
        continue;
      }
      if (type === "boolean") {
        if (typeof value !== "boolean") {
          diagnostics.push({ type: "error", source: "runtime", message: `Extension flag --${name} expects a boolean`, blocking: true });
        } else {
          result.runtime.flagValues.set(name, value);
        }
        continue;
      }
      if (typeof value !== "string") {
        diagnostics.push({ type: "error", source: "runtime", message: `Extension flag --${name} expects a string`, blocking: true });
      } else {
        result.runtime.flagValues.set(name, value);
      }
    }
    this.#pendingFlagDiagnostics = diagnostics;
  }

  #pendingFlagDiagnostics: PiResourceDiagnostic[] = [];
  #mcpAdapterUnavailable = false;

  #makeSnapshot(
    generation: number,
    reloadDeferred: boolean,
    extraDiagnostics: readonly PiResourceDiagnostic[]
  ): PiResourceRuntimeSnapshot {
    const extensions = this.#resourceLoader.getExtensions();
    const skillsResult = this.#resourceLoader.getSkills();
    const diagnostics = [
      ...extraDiagnostics,
      ...extensions.errors.map((entry) => extensionErrorDiagnostic(entry.path, entry.error)),
      ...extensionCollisionDiagnostics(extensions),
      ...skillsResult.diagnostics.map((entry) => skillDiagnostic(entry)),
      ...this.#pendingFlagDiagnostics
    ];
    const deduped = dedupeDiagnostics(diagnostics);
    return {
      generation,
      extensions,
      skills: skillsResult.skills,
      systemPrompt: this.#resourceLoader.getSystemPrompt(),
      appendSystemPrompt: this.#resourceLoader.getAppendSystemPrompt(),
      diagnostics: deduped,
      hasBlockingDiagnostics: deduped.some((entry) => entry.blocking === true),
      reloadDeferred
    };
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("PiResourceRuntime is closed");
  }
}

/**
 * Resolve the pinned adapter without importing or executing it.
 *
 * Production Worker bundles carry a deterministic standalone extension asset
 * beside the bundle. Source/test execution keeps the package-resolution
 * fallback for workspace compatibility.
 */
export function resolveBundledPiMcpAdapterPath(moduleUrl = import.meta.url): string | undefined {
  const bundledAsset = filePathFromUrl(new URL("./pi-mcp-adapter.js", moduleUrl));
  if (bundledAsset !== undefined && existsSync(bundledAsset)) return bundledAsset;
  try {
    return createRequire(moduleUrl).resolve("pi-mcp-adapter/index.ts");
  } catch {
    return undefined;
  }
}

function filePathFromUrl(url: URL): string | undefined {
  if (url.protocol !== "file:") return undefined;
  try {
    return realpathSync(url);
  } catch {
    return url.pathname;
  }
}

/** Resolve the pinned Web Extension without importing or executing it. */
export function resolveBundledPiWebAccessPath(): string | undefined {
  try {
    const packagePath = createRequire(import.meta.url).resolve("pi-web-access/package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { pi?: { extensions?: unknown } };
    const extension = Array.isArray(packageJson.pi?.extensions)
      ? packageJson.pi.extensions.find((value): value is string => typeof value === "string")
      : undefined;
    return extension === undefined ? undefined : resolve(dirname(packagePath), extension);
  } catch {
    return undefined;
  }
}

function extensionErrorDiagnostic(path: string, message: string): PiResourceDiagnostic {
  return {
    type: "error",
    source: "extension",
    path,
    message,
    blocking: true
  };
}

function extensionCollisionDiagnostics(result: LoadExtensionsResult): PiResourceDiagnostic[] {
  const owners = new Map<string, Extension>();
  const diagnostics: PiResourceDiagnostic[] = [];
  for (const extension of result.extensions) {
    for (const name of extension.tools.keys()) {
      const previous = owners.get(name);
      if (previous === undefined) {
        owners.set(name, extension);
        continue;
      }
      const collision: ResourceCollision = {
        resourceType: "extension",
        name,
        winnerPath: previous.resolvedPath,
        loserPath: extension.resolvedPath,
        winnerSource: previous.path,
        loserSource: extension.path
      };
      diagnostics.push({
        type: "collision",
        source: "extension",
        path: extension.path,
        message: `Extension tool name collision: "${name}"`,
        blocking: true,
        collision
      });
    }
  }
  return diagnostics;
}

function skillDiagnostic(diagnostic: ResourceDiagnostic): PiResourceDiagnostic {
  return {
    type: diagnostic.type === "collision" ? "collision" : diagnostic.type,
    source: "skill",
    path: diagnostic.path,
    message: diagnostic.message,
    // A malformed Skill is isolated and does not prevent unrelated Skills from
    // loading; collisions are blocking because invocation would be ambiguous.
    blocking: diagnostic.type === "collision",
    collision: diagnostic.collision
  };
}

function dedupeDiagnostics(diagnostics: readonly PiResourceDiagnostic[]): PiResourceDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.type}\u0000${diagnostic.source}\u0000${diagnostic.path ?? ""}\u0000${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const resolved = resolve(path);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function createSkillIsolatedResourceLoader(base: ResourceLoader, skillsRoot: string, disabledSkillIds: ReadonlySet<string>): ResourceLoader {
  const rejected: string[] = [];
  const root = canonicalPath(skillsRoot);
  return {
    getExtensions: () => base.getExtensions(),
    getSkills: () => {
      const result = filterContainedSkills(base.getSkills(), skillsRoot, disabledSkillIds);
      return {
        skills: result.skills,
        diagnostics: [
          ...result.diagnostics,
          ...rejected.splice(0).map((path) => ({
            type: "error" as const,
            message: "Extension-contributed Skill path is outside the dedicated VC Agent Skills Directory",
            path
          }))
        ]
      };
    },
    getPrompts: () => base.getPrompts(),
    getThemes: () => base.getThemes(),
    getAgentsFiles: () => base.getAgentsFiles(),
    getSystemPrompt: () => base.getSystemPrompt(),
    getAppendSystemPrompt: () => base.getAppendSystemPrompt(),
    extendResources: (paths) => {
      const skillPaths = (paths.skillPaths ?? []).filter((entry) => {
        const canonical = canonicalPath(entry.path);
        const accepted = root !== undefined && canonical !== undefined && isContained(root, canonical);
        if (!accepted) rejected.push(entry.path);
        return accepted;
      });
      base.extendResources({ ...paths, skillPaths });
    },
    reload: (options) => base.reload(options)
  };
}

function filterContainedSkills(
  result: { readonly skills: Skill[]; readonly diagnostics: ResourceDiagnostic[] },
  skillsRoot: string,
  disabledSkillIds: ReadonlySet<string> = new Set()
): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  const root = canonicalPath(skillsRoot);
  if (root === undefined) {
    return {
      skills: [],
      diagnostics: [
        ...result.diagnostics,
        { type: "error", message: "Dedicated VC Agent Skills Directory is not accessible", path: skillsRoot }
      ]
    };
  }
  const diagnostics = [...result.diagnostics];
  const skills = result.skills.filter((skill) => {
    const base = canonicalPath(skill.baseDir);
    const file = canonicalPath(skill.filePath);
    const contained = base !== undefined && file !== undefined && isContained(root, base) && isContained(root, file);
    const treeEscapes = contained ? findEscapingSymlink(skill.baseDir, root) : skill.filePath;
    const referencedEscape = contained && treeEscapes === undefined
      ? findEscapingSkillReference(skill.filePath, root)
      : undefined;
    if (!contained || treeEscapes !== undefined || referencedEscape !== undefined) {
      diagnostics.push({
        type: "error",
        message: referencedEscape === undefined
          ? "Skill path escapes the dedicated VC Agent Skills Directory"
          : "Skill resource reference escapes the dedicated VC Agent Skills Directory",
        path: treeEscapes ?? referencedEscape ?? skill.filePath
      });
      return false;
    }
    const id = skillIdForPath(skill.filePath, root);
    // The persisted contract uses path ids. Accepting the frontmatter name as
    // a compatibility alias keeps older settings from silently re-enabling a
    // Skill after the id contract was introduced.
    if ((id !== undefined && hasSkillId(disabledSkillIds, id)) || hasSkillId(disabledSkillIds, skill.name)) return false;
    return true;
  });
  return { skills, diagnostics };
}

function skillIdForPath(filePath: string, canonicalRoot: string): string | undefined {
  const canonicalFile = canonicalPath(filePath);
  if (canonicalFile === undefined || !isContained(canonicalRoot, canonicalFile)) return undefined;
  const relativePath = relative(canonicalRoot, canonicalFile).replace(/\\/gu, "/");
  return piSkillId(relativePath);
}

function hasSkillId(disabledSkillIds: ReadonlySet<string>, id: string): boolean {
  if (disabledSkillIds.has(id)) return true;
  // Persisted ids are path based.  Windows paths are case-insensitive, so
  // accept a casing-only difference without weakening containment checks.
  if (process.platform !== "win32") return false;
  const normalized = id.toLowerCase();
  for (const candidate of disabledSkillIds) if (candidate.toLowerCase() === normalized) return true;
  return false;
}

/**
 * Validate Markdown resources referenced by SKILL.md. Links and images are
 * treated as local resources when they are relative or file-system absolute;
 * network/data/fragment references remain ordinary external Markdown and are
 * not resolved by Pi's Skill loader. Every local target must resolve under
 * the dedicated root, including multi-hop symbolic links.
 */
function findEscapingSkillReference(skillFile: string, root: string): string | undefined {
  let markdown: string;
  try {
    markdown = readFileSync(skillFile, "utf8");
  } catch {
    return skillFile;
  }
  const references = new Set<string>();
  const markdownPattern = /!?(?:\[[^\]]*\])\(\s*(?:<([^>]+)>|([^\s)]+))/gu;
  for (const match of markdown.matchAll(markdownPattern)) {
    const value = match[1] ?? match[2];
    if (value !== undefined) references.add(value);
  }
  const htmlPattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/giu;
  for (const match of markdown.matchAll(htmlPattern)) {
    if (match[1] !== undefined) references.add(match[1]);
  }
  const baseDir = resolve(skillFile, "..");
  for (const reference of references) {
    const target = localSkillReferencePath(reference, baseDir);
    if (target === undefined) continue;
    const canonical = canonicalPath(target);
    if (canonical === undefined || !isContained(root, canonical)) return target;
  }
  return undefined;
}

function localSkillReferencePath(reference: string, baseDir: string): string | undefined {
  const trimmed = reference.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("//")) return undefined;
  if (/^(?:https?|mailto|data|javascript):/iu.test(trimmed)) return undefined;
  // Strip URL query/fragment portions before resolving a local filename.
  const withoutFragment = trimmed.split(/[?#]/u, 1)[0]?.trim();
  if (withoutFragment === undefined || withoutFragment.length === 0) return undefined;
  let decoded = withoutFragment;
  try { decoded = decodeURIComponent(withoutFragment); } catch { /* retain raw path */ }
  if (/^file:/iu.test(decoded)) {
    try {
      const url = new URL(decoded);
      decoded = url.pathname;
      if (process.platform === "win32" && /^\/[A-Za-z]:/u.test(decoded)) decoded = decoded.slice(1);
    } catch {
      return decoded;
    }
  }
  return resolve(baseDir, decoded);
}

function canonicalPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isContained(root: string, target: string): boolean {
  // Windows paths can differ only by case; compare normalized paths there so
  // a casing change cannot turn an in-root path into an apparent escape.
  const comparisonRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const comparisonTarget = process.platform === "win32" ? target.toLowerCase() : target;
  const rel = relative(comparisonRoot, comparisonTarget);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../") && !rel.startsWith("..\\"));
}

/** Reject a symlink/junction anywhere in a Skill package that points outside root. */
function findEscapingSymlink(start: string, root: string): string | undefined {
  const startCanonical = canonicalPath(start);
  if (startCanonical === undefined || !isContained(root, startCanonical)) return start;
  const visited = new Set<string>();
  const visit = (directory: string): string | undefined => {
    const canonicalDirectory = canonicalPath(directory);
    if (canonicalDirectory === undefined || !isContained(root, canonicalDirectory)) return directory;
    if (visited.has(canonicalDirectory)) return undefined;
    visited.add(canonicalDirectory);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const child = resolve(directory, entry.name);
      let stats;
      try {
        stats = lstatSync(child);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) {
        const target = canonicalPath(child);
        if (target === undefined || !isContained(root, target)) return child;
        try {
          if (statSync(child).isDirectory()) {
            const escape = visit(child);
            if (escape !== undefined) return escape;
          }
        } catch {
          return child;
        }
        continue;
      }
      if (stats.isDirectory()) {
        const escape = visit(child);
        if (escape !== undefined) return escape;
      }
    }
    return undefined;
  };
  return visit(start);
}
