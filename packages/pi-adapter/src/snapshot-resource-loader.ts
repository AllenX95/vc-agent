import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  createEventBus,
  createSyntheticSourceInfo,
  createExtensionRuntime,
  discoverAndLoadExtensions,
  type Extension,
  type ExtensionAPI,
  type ExtensionFactory,
  type ExtensionRuntime,
  type ExecOptions,
  type ExecResult,
  type LoadExtensionsResult,
  type ResourceLoader,
  type Skill
} from "@earendil-works/pi-coding-agent";
import type { ExtensionInventorySnapshot, RuntimeResourceSnapshot } from "@vc-agent/contracts";
import type { RuntimeExtensionToolInput } from "./runtime-capability-assembler.js";

const PI_WEB_ACCESS_VERSION = "0.17.0";
const PI_WEB_ACCESS_CONFIG_FILE = "web-search.json";

type PiWebAccessConfig = Record<string, unknown>;

export type { ExtensionInventorySnapshot, RuntimeResourceSnapshot } from "@vc-agent/contracts";

type RuntimeSkillSnapshot = NonNullable<RuntimeResourceSnapshot["skills"]>;
type FrozenRuntimeSkillDecision = Omit<RuntimeSkillSnapshot["decisions"][number], "resources" | "capabilities"> & { readonly resources: readonly string[]; readonly capabilities: readonly string[] };
type FrozenRuntimeSkillSnapshot = Omit<RuntimeSkillSnapshot, "decisions" | "instructions" | "resources"> & {
  readonly decisions: readonly FrozenRuntimeSkillDecision[];
  readonly instructions: readonly Readonly<RuntimeSkillSnapshot["instructions"][number]>[];
  readonly resources: readonly Readonly<RuntimeSkillSnapshot["resources"][number]>[];
};
type FrozenRuntimeResourceSnapshot = Omit<RuntimeResourceSnapshot, "appendSystemPrompt" | "skills"> & {
  readonly appendSystemPrompt: readonly string[];
  readonly skills?: FrozenRuntimeSkillSnapshot | undefined;
};
type FrozenExtensionInventorySnapshot = Readonly<
  Omit<ExtensionInventorySnapshot, "enabled"> & {
    enabled: readonly Readonly<ExtensionInventorySnapshot["enabled"][number]>[];
  }
>;

export interface SnapshotResourceLoaderInput {
  readonly cwd: string;
  readonly resources: FrozenRuntimeResourceSnapshot;
  readonly extensions: FrozenExtensionInventorySnapshot;
  /** Load the reviewed, app-bundled Pi web extension for a real Agent session. */
  readonly loadBundledExtensions?: boolean;
}

export interface ExtensionLoadPreflight {
  readonly revisionId: string;
  readonly accepted: readonly Readonly<ExtensionInventorySnapshot["enabled"][number]>[];
  readonly rejected: readonly { readonly id: string; readonly code: string; readonly message: string }[];
}

export function freezeRuntimeSnapshots(input: SnapshotResourceLoaderInput): SnapshotResourceLoaderInput {
  const skills = input.resources.skills === undefined ? undefined : Object.freeze({
    ...input.resources.skills,
    decisions: Object.freeze(input.resources.skills.decisions.map((decision) => Object.freeze({ ...decision, resources: Object.freeze([...decision.resources]), capabilities: Object.freeze([...decision.capabilities]) }))),
    instructions: Object.freeze(input.resources.skills.instructions.map((instruction) => Object.freeze({ ...instruction }))),
    resources: Object.freeze(input.resources.skills.resources.map((resource) => Object.freeze({ ...resource })))
  });
  const resources = Object.freeze({
    ...input.resources,
    appendSystemPrompt: Object.freeze([...input.resources.appendSystemPrompt]),
    ...(skills === undefined ? {} : { skills })
  });
  const enabled = input.extensions.enabled.map((entry) => Object.freeze({ ...entry }));
  const extensions = Object.freeze({ ...input.extensions, enabled: Object.freeze(enabled) });
  return Object.freeze({
    cwd: input.cwd,
    resources,
    extensions,
    ...(input.loadBundledExtensions === undefined ? {} : { loadBundledExtensions: input.loadBundledExtensions })
  });
}

export class SnapshotResourceLoader implements ResourceLoader {
  readonly #input: SnapshotResourceLoaderInput;
  #extensions: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime()
  };

  constructor(input: SnapshotResourceLoaderInput) {
    this.#input = freezeRuntimeSnapshots(input);
    const preflight = this.inspect();
    if (preflight.rejected.length > 0) {
      throw new Error(`EXTENSION_LOAD_PREFLIGHT_FAILED: ${preflight.rejected.map((item) => item.id).join(", ")}`);
    }
  }

  get snapshot(): SnapshotResourceLoaderInput {
    return this.#input;
  }

  getExtensions(): LoadExtensionsResult {
    return this.#extensions;
  }

  inspect(): ExtensionLoadPreflight {
    const accepted: Readonly<ExtensionInventorySnapshot["enabled"][number]>[] = [];
    const rejected: { id: string; code: string; message: string }[] = [];
    for (const entry of this.#input.extensions.enabled) {
      const rejection = inspectExtensionEntry(entry);
      if (rejection === undefined) accepted.push(entry);
      else rejected.push({ id: entry.id, ...rejection });
    }
    return { revisionId: this.#input.extensions.revisionId, accepted, rejected };
  }

  getSkills() {
    const skills: Skill[] = (this.#input.resources.skills?.instructions ?? []).flatMap((instruction) => {
      if (!isSafeSkillPath(instruction.filePath, instruction.baseDir)) return [];
      return [{
        // Package ids are stable command identifiers; display names may contain whitespace.
        name: instruction.packageId,
        description: instruction.description,
        filePath: instruction.filePath,
        baseDir: instruction.baseDir,
        sourceInfo: createSyntheticSourceInfo(instruction.filePath, { source: "vc-agent-skills", scope: "user", baseDir: instruction.baseDir }),
        disableModelInvocation: false
      }];
    });
    return { skills, diagnostics: [] };
  }

  getPrompts() { return { prompts: [], diagnostics: [] }; }
  getThemes() { return { themes: [], diagnostics: [] }; }
  getAgentsFiles() { return { agentsFiles: [] }; }
  getSystemPrompt(): string { return this.#input.resources.systemPrompt; }

  getAppendSystemPrompt(): string[] {
    // Pi's own Skill resource path is the progressive-disclosure seam. It
    // puts bounded metadata in the system prompt and reads SKILL.md only when
    // /skill:<name> is invoked. Never append the complete body here.
    return [...this.#input.resources.appendSystemPrompt];
  }

  extendResources(_paths: Parameters<ResourceLoader["extendResources"]>[0]): void {
    throw new Error("Runtime Resource Snapshot is immutable");
  }

  async reload(): Promise<void> {
    const preflight = this.inspect();
    if (preflight.rejected.length > 0) {
      throw new Error(`EXTENSION_LOAD_PREFLIGHT_FAILED: ${preflight.rejected.map((item) => item.id).join(", ")}`);
    }
    const loaderRoot = mkdtempSync(join(tmpdir(), "vc-agent-extension-loader-"));
    const agentDir = join(loaderRoot, "agent");
    mkdirSync(agentDir, { recursive: true });
    const approvedPaths = preflight.accepted
      .filter((entry) => !(entry.id === "pi-web-access" && entry.entryPath === `pi-web-access@${PI_WEB_ACCESS_VERSION}`))
      .map((entry) => resolve(this.#input.cwd, entry.entryPath));
    const approved = approvedPaths.length === 0
      ? undefined
      : await discoverAndLoadExtensions(approvedPaths, loaderRoot, agentDir);
    const runtime = approved?.runtime ?? createExtensionRuntime();
    const extensions: Extension[] = [...(approved?.extensions ?? [])];
    const errors = [...(approved?.errors ?? [])];
    if (errors.length > 0) {
      throw new Error(`EXTENSION_LOAD_FAILED: ${errors.map((error) => `${error.path}: ${error.error}`).join("; ")}`);
    }

    if (this.#input.loadBundledExtensions === true) {
      preparePiWebAccessConfig();
      // The SDK's public root currently omits loadExtensionFromFactory even
      // though AgentSession consumes the public ExtensionAPI/Runtime types.
      // Keep this small adapter on that public contract so the bundled module
      // remains usable in the bundled Worker, where it has no file path.
      const { default: piWebAccess } = await import("pi-web-access");
      extensions.push(await loadInlineExtension(
        piWebAccess,
        this.#input.cwd,
        createEventBus(),
        runtime,
        `pi-web-access@${PI_WEB_ACCESS_VERSION}`
      ));
    }
    this.#extensions = { extensions, errors, runtime };
  }
}

/** Project the loaded Pi Extension registration into the common source-aware seam. */
export function runtimeExtensionTools(
  loader: SnapshotResourceLoader,
  revision?: ExtensionInventorySnapshot
): RuntimeExtensionToolInput[] {
  const effectiveRevision = revision ?? {
    schemaVersion: 1 as const,
    revisionId: loader.snapshot.extensions.revisionId,
    enabled: loader.snapshot.extensions.enabled.map((entry) => ({ ...entry }))
  };
  const entries = new Map(effectiveRevision.enabled.map((entry) => [resolve(entry.entryPath), entry]));
  const result: RuntimeExtensionToolInput[] = [];
  for (const extension of loader.getExtensions().extensions) {
    const isBundled = extension.path === `pi-web-access@${PI_WEB_ACCESS_VERSION}`;
    const entry = entries.get(resolve(extension.path));
    const sourceRevision = isBundled ? PI_WEB_ACCESS_VERSION : entry?.version ?? effectiveRevision.revisionId;
    for (const name of extension.tools.keys()) {
      result.push({
        name,
        source: isBundled ? "bundled_extension" : "approved_extension",
        sourceId: isBundled ? "pi-web-access" : entry?.id ?? extension.path,
        sourceRevision
      });
    }
  }
  return result.sort((left, right) => `${left.name}:${left.sourceId}`.localeCompare(`${right.name}:${right.sourceId}`));
}

/**
 * The Pi root package intentionally keeps this factory loader out of its
 * public exports in 0.80.x. This adapter only registers through the official
 * ExtensionAPI and shares the official ExtensionRuntime used by AgentSession.
 */
async function loadInlineExtension(
  factory: ExtensionFactory,
  cwd: string,
  eventBus: ReturnType<typeof createEventBus>,
  runtime: ExtensionRuntime,
  extensionPath: string
): Promise<Extension> {
  const extension = {
    path: extensionPath,
    resolvedPath: extensionPath,
    sourceInfo: createSyntheticSourceInfo(extensionPath, { source: "vc-agent-bundled", scope: "user", baseDir: cwd }),
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map()
  } as Extension;
  const api = {
    on(event: string, handler: (...args: unknown[]) => unknown): void {
      runtime.assertActive();
      const handlers = extension.handlers.get(event) ?? [];
      handlers.push(handler as never);
      extension.handlers.set(event, handlers);
    },
    registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]): void {
      runtime.assertActive();
      extension.tools.set(tool.name, { definition: tool, sourceInfo: extension.sourceInfo });
      runtime.refreshTools();
    },
    registerCommand(name: string, options: Record<string, unknown>): void {
      runtime.assertActive();
      extension.commands.set(name, { name, sourceInfo: extension.sourceInfo, ...options } as never);
    },
    registerShortcut(shortcut: string, options: Record<string, unknown>): void {
      runtime.assertActive();
      extension.shortcuts.set(shortcut as never, { shortcut, extensionPath, ...options } as never);
    },
    registerFlag(name: string, options: Record<string, unknown>): void {
      runtime.assertActive();
      extension.flags.set(name, { name, extensionPath, ...options } as never);
      if (options.default !== undefined && !runtime.flagValues.has(name)) runtime.flagValues.set(name, options.default as boolean | string);
    },
    getFlag(name: string): boolean | string | undefined {
      runtime.assertActive();
      return extension.flags.has(name) ? runtime.flagValues.get(name) : undefined;
    },
    registerMessageRenderer(customType: string, renderer: unknown): void {
      runtime.assertActive();
      extension.messageRenderers.set(customType, renderer as never);
    },
    registerEntryRenderer(customType: string, renderer: unknown): void {
      runtime.assertActive();
      extension.entryRenderers?.set(customType, renderer as never);
    },
    sendMessage: (...args: Parameters<ExtensionRuntime["sendMessage"]>) => runtime.sendMessage(...args),
    sendUserMessage: (...args: Parameters<ExtensionRuntime["sendUserMessage"]>) => runtime.sendUserMessage(...args),
    appendEntry: (...args: Parameters<ExtensionRuntime["appendEntry"]>) => runtime.appendEntry(...args),
    setSessionName: (...args: Parameters<ExtensionRuntime["setSessionName"]>) => runtime.setSessionName(...args),
    getSessionName: (...args: Parameters<ExtensionRuntime["getSessionName"]>) => runtime.getSessionName(...args),
    setLabel: (...args: Parameters<ExtensionRuntime["setLabel"]>) => runtime.setLabel(...args),
    exec: (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => runExtensionCommand(command, args, options?.cwd ?? cwd, options),
    getActiveTools: (...args: Parameters<ExtensionRuntime["getActiveTools"]>) => runtime.getActiveTools(...args),
    getAllTools: (...args: Parameters<ExtensionRuntime["getAllTools"]>) => runtime.getAllTools(...args),
    setActiveTools: (...args: Parameters<ExtensionRuntime["setActiveTools"]>) => runtime.setActiveTools(...args),
    getCommands: (...args: Parameters<ExtensionRuntime["getCommands"]>) => runtime.getCommands(...args),
    setModel: (...args: Parameters<ExtensionRuntime["setModel"]>) => runtime.setModel(...args),
    getThinkingLevel: (...args: Parameters<ExtensionRuntime["getThinkingLevel"]>) => runtime.getThinkingLevel(...args),
    registerProvider: (name: string, config: Parameters<ExtensionRuntime["registerProvider"]>[1]): void => runtime.registerProvider(name, config, extensionPath),
    unregisterProvider: (name: string): void => runtime.unregisterProvider(name, extensionPath),
    events: eventBus
  } as unknown as ExtensionAPI;
  await factory(api);
  return extension;
}

function runExtensionCommand(command: string, args: string[], cwd: string, options?: ExecOptions): Promise<ExecResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      child.kill();
    };
    const onAbort = (): void => kill();
    if (options?.signal !== undefined) {
      if (options.signal.aborted) kill();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (options?.timeout !== undefined && options.timeout > 0) timeout = setTimeout(kill, options.timeout);
    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.on("close", (code) => {
      if (timeout !== undefined) clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", onAbort);
      resolveResult({ stdout, stderr, code: code ?? 0, killed });
    });
    child.on("error", (error) => { stderr += error.message; });
  });
}

function inspectExtensionEntry(entry: ExtensionInventorySnapshot["enabled"][number]): { readonly code: string; readonly message: string } | undefined {
  if (entry.version.length === 0 || entry.integrity.length === 0) return { code: "EXTENSION_ENTRY_NOT_APPROVED", message: "An enabled Extension is missing its immutable version or integrity identity." };
  if (entry.trust !== "bundled-reviewed" && entry.trust !== "approved-trusted") return { code: "EXTENSION_ENTRY_NOT_APPROVED", message: "Only reviewed bundled or separately approved Extension revisions may load." };
  if (entry.id === "pi-web-access" && entry.entryPath === `pi-web-access@${PI_WEB_ACCESS_VERSION}`) return undefined;
  const candidate = resolve(entry.entryPath);
  if (candidate.toLowerCase().split(sep).includes("staged")) return { code: "EXTENSION_ENTRY_NOT_APPROVED", message: "Staged Extension paths are never executable." };
  try {
    const realEntry = realpathSync(candidate);
    if (resolve(realEntry).toLowerCase() !== resolve(candidate).toLowerCase()) return { code: "EXTENSION_ENTRY_NOT_APPROVED", message: "The exact Extension entry path resolves through a symlink and is not executable." };
    if (!statSync(realEntry).isFile()) return { code: "EXTENSION_ENTRY_NOT_APPROVED", message: "The exact Extension entry path is not a file." };
    const root = findArtifactRoot(realEntry);
    const actualDirectoryHash = hashDirectory(root);
    const actualEntryHash = createHash("sha256").update(readFileSync(realEntry)).digest("hex");
    if (entry.integrity !== actualDirectoryHash && entry.integrity !== actualEntryHash && entry.integrity !== `sha256-${actualEntryHash}`) {
      return { code: "EXTENSION_ARTIFACT_CHANGED", message: "The exact Extension entry no longer matches its approved integrity identity." };
    }
  } catch {
    return { code: "EXTENSION_ENTRY_NOT_APPROVED", message: "The exact approved Extension entry path is unavailable." };
  }
  return undefined;
}

function findArtifactRoot(entryPath: string): string {
  let current = dirname(entryPath);
  for (let index = 0; index < 32; index += 1) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirname(entryPath);
}

function hashDirectory(root: string): string {
  const files: string[] = [];
  visit(root);
  const inventory = files.sort().map((file) => {
    const path = join(root, file);
    const stat = statSync(path);
    const bytes = readFileSync(path);
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    return `${file}\u0000${stat.size}\u0000${stat.mode & 0o777}\u0000${fileHash}`;
  }).join("\n");
  return createHash("sha256").update(inventory, "utf8").digest("hex");

  function visit(directory: string): void {
    for (const entry of readdirSync(directory)) {
      const child = join(directory, entry);
      const stat = statSync(child);
      if (stat.isDirectory()) visit(child);
      else if (stat.isFile()) files.push(normalizeRelative(root, child));
    }
  }
}

function normalizeRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function isSafeSkillPath(filePath: string, baseDir: string): boolean {
  try {
    const realFile = realpathSync(filePath);
    const realBase = realpathSync(baseDir);
    const relativePath = relative(realBase, realFile);
    return statSync(realFile).isFile() && (relativePath === "" || (!relativePath.startsWith(".." + sep) && relativePath !== ".."));
  } catch {
    return false;
  }
}

/**
 * pi-web-access reads its config path during module evaluation. The app pins
 * only the required public names and disables browser/curator workflows while
 * preserving unrelated valid settings.
 */
function preparePiWebAccessConfig(): void {
  const configuredRoot = process.env.VC_AGENT_USER_DATA_DIR?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const appDataRoot = configuredRoot || (localAppData === undefined || localAppData.length === 0
    ? join(tmpdir(), "vc-agent")
    : join(localAppData, "vc-agent"));
  const configDirectory = join(appDataRoot, "integrations", "pi-web-access");
  const configPath = join(configDirectory, PI_WEB_ACCESS_CONFIG_FILE);
  mkdirSync(configDirectory, { recursive: true });

  let config: PiWebAccessConfig = {};
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) config = { ...(parsed as PiWebAccessConfig) };
    } catch {
      // A malformed app-owned config is replaced with safe defaults below.
    }
  }

  const configuredToolNames = config.toolNames !== null && typeof config.toolNames === "object" && !Array.isArray(config.toolNames)
    ? { ...(config.toolNames as PiWebAccessConfig) }
    : {};
  const nextConfig: PiWebAccessConfig = {
    ...config,
    workflow: "none",
    autoOpenBrowser: false,
    allowBrowserCookies: false,
    toolNames: {
      ...configuredToolNames,
      webSearch: "web_search",
      sourceCheck: "source_check",
      fetchContent: "web_fetch",
      getSearchContent: "web_fetch_content"
    }
  };
  const serialized = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (!existsSync(configPath) || readFileSync(configPath, "utf8") !== serialized) {
    if (existsSync(configPath) && !existsSync(configPath + ".bak")) copyFileSync(configPath, configPath + ".bak");
    writeFileSync(configPath, serialized, "utf8");
  }
  process.env.PI_CODING_AGENT_DIR = configDirectory;
}
