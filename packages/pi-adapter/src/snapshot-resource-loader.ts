import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEventBus,
  createSyntheticSourceInfo,
  createExtensionRuntime,
  type Extension,
  type ExtensionAPI,
  type ExtensionFactory,
  type ExtensionRuntime,
  type LoadExtensionsResult,
  type ResourceLoader,
  type Skill
} from "@earendil-works/pi-coding-agent";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { ExtensionInventorySnapshot, RuntimeResourceSnapshot } from "@vc-agent/contracts";

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
    for (const entry of this.#input.extensions.enabled) {
      if (entry.trust !== "bundled-reviewed" || entry.version.length === 0 || entry.integrity.length === 0) {
        throw new Error(`Extension inventory rejected entry: ${entry.id}`);
      }
    }
    if (this.#input.extensions.enabled.length > 0) {
      throw new Error("Bundled Extension loading is not enabled before the Integration Build");
    }
  }

  get snapshot(): SnapshotResourceLoaderInput {
    return this.#input;
  }

  getExtensions(): LoadExtensionsResult {
    return this.#extensions;
  }

  getSkills() {
    const skills: Skill[] = (this.#input.resources.skills?.instructions ?? []).map((instruction) => ({
      // Pi parses the command name up to the first space. Package ids are
      // normalized, stable command identifiers; metadata names are display
      // labels and may contain whitespace.
      name: instruction.packageId,
      description: instruction.description,
      filePath: instruction.filePath,
      baseDir: instruction.baseDir,
      sourceInfo: createSyntheticSourceInfo(instruction.filePath, { source: "vc-agent-skills", scope: "user", baseDir: instruction.baseDir }),
      disableModelInvocation: false
    }));
    return { skills, diagnostics: [] };
  }

  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }

  getThemes() {
    return { themes: [], diagnostics: [] };
  }

  getAgentsFiles() {
    return { agentsFiles: [] };
  }

  getSystemPrompt(): string {
    return this.#input.resources.systemPrompt;
  }

  getAppendSystemPrompt(): string[] {
    const skillInstructions = this.#input.resources.skills?.instructions ?? [];
    const skillText = skillInstructions.length === 0 ? undefined : skillInstructions.map((instruction) => {
      const body = stripFrontmatter(instruction.content).trim();
      return `<skill name="${escapeXml(instruction.name)}" location="${escapeXml(instruction.filePath)}">\nReferences are relative to ${instruction.baseDir}.\n\n${body}\n</skill>`;
    }).join("\n\n");
    return [...this.#input.resources.appendSystemPrompt, ...(skillText === undefined ? [] : [skillText])];
  }

  extendResources(_paths: Parameters<ResourceLoader["extendResources"]>[0]): void {
    throw new Error("Runtime Resource Snapshot is immutable");
  }

  async reload(): Promise<void> {
    const runtime = createExtensionRuntime();
    if (this.#input.loadBundledExtensions !== true) {
      this.#extensions = { extensions: [], errors: [], runtime };
      return;
    }

    preparePiWebAccessConfig();
    const { default: piWebAccess } = await import("pi-web-access");
    const extension = await loadInlineExtension(
      piWebAccess,
      this.#input.cwd,
      createEventBus(),
      runtime,
      `pi-web-access@${PI_WEB_ACCESS_VERSION}`
    );
    this.#extensions = { extensions: [extension], errors: [], runtime };
  }
}

/**
 * The Pi 0.80.8 root package does not export loadExtensionFromFactory even
 * though its public ExtensionAPI and ExtensionRunner consume this shape. Keep
 * the small registration bridge local so the app does not depend on an
 * unexported package path; runtime actions remain delegated to Pi's shared
 * ExtensionRuntime and are bound by the normal AgentSession runner.
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
    setThinkingLevel: (...args: Parameters<ExtensionRuntime["setThinkingLevel"]>) => runtime.setThinkingLevel(...args),
    registerProvider: (name: string, config: Parameters<ExtensionRuntime["registerProvider"]>[1]): void => runtime.registerProvider(name, config, extensionPath),
    unregisterProvider: (name: string): void => runtime.unregisterProvider(name, extensionPath),
    events: eventBus
  } as unknown as ExtensionAPI;

  await factory(api);
  return extension;
}

function runExtensionCommand(command: string, args: string[], cwd: string, options?: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
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
      resolve({ stdout, stderr, code: code ?? 0, killed });
    });
    child.on("error", (error) => {
      stderr += error.message;
    });
  });
}

/**
 * pi-web-access reads its config path during module evaluation. Prepare an
 * app-owned config before the dynamic import so the Worker gets deterministic
 * tool names and never starts the interactive browser curator.
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
      // A malformed app-owned config should not prevent the bundled extension
      // from loading; replace it with the safe defaults below.
    }
  }

  const configuredToolNames = config.toolNames !== null && typeof config.toolNames === "object" && !Array.isArray(config.toolNames)
    ? { ...(config.toolNames as PiWebAccessConfig) }
    : {};
  const nextConfig: PiWebAccessConfig = {
    ...config,
    workflow: "none",
    autoOpenBrowser: false,
    toolNames: {
      ...configuredToolNames,
      webSearch: "web_search",
      sourceCheck: "source_check",
      fetchContent: "web_fetch",
      getSearchContent: "web_fetch_content"
    }
  };
  const serialized = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (!existsSync(configPath) || readFileSync(configPath, "utf8") !== serialized) writeFileSync(configPath, serialized, "utf8");
  process.env.PI_CODING_AGENT_DIR = configDirectory;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  return end < 0 ? content : content.slice(end + "\n---".length);
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
