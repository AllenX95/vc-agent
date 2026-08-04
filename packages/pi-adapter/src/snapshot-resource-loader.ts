import { mkdirSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  createSyntheticSourceInfo,
  createExtensionRuntime,
  discoverAndLoadExtensions,
  type LoadExtensionsResult,
  type ResourceLoader,
  type Skill
} from "@earendil-works/pi-coding-agent";
import type { ExtensionInventorySnapshot, RuntimeResourceSnapshot } from "@vc-agent/contracts";
import { bundledPiWebAccessEntry, inspectExtensionEntries, preparePiWebAccessConfig, type ExtensionLoadPreflight } from "./extension-preflight.js";
import type { RuntimeExtensionToolInput } from "./runtime-capability-assembler.js";

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
    enabled: readonly Readonly<Omit<ExtensionInventorySnapshot["enabled"][number], "toolNames"> & { readonly toolNames?: readonly string[] }>[];
  }
>;
export interface SnapshotResourceLoaderInput {
  readonly cwd: string;
  readonly resources: FrozenRuntimeResourceSnapshot;
  readonly extensions: FrozenExtensionInventorySnapshot;
  /** Load the reviewed, app-bundled Pi web extension for a real Agent session. */
  readonly loadBundledExtensions?: boolean;
}

export type { ExtensionLoadPreflight } from "./extension-preflight.js";

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
  const enabledEntries = input.extensions.enabled.map((entry) => ({ ...entry, ...(entry.toolNames === undefined ? {} : { toolNames: Object.freeze([...entry.toolNames]) }) }));
  if (input.loadBundledExtensions === true && !enabledEntries.some((entry) => entry.id === "pi-web-access")) enabledEntries.push(bundledPiWebAccessEntry());
  const enabled = enabledEntries.map((entry) => Object.freeze(entry));
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
    return inspectExtensionEntries(this.#input.extensions.revisionId, this.#input.extensions.enabled, this.#input.loadBundledExtensions === true);
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
    if (this.#input.loadBundledExtensions === true) preparePiWebAccessConfig(true);
    const admittedPaths = preflight.accepted.map((entry) => resolve(this.#input.cwd, entry.entryPath));
    const loaded = admittedPaths.length === 0
      ? undefined
      : await discoverAndLoadExtensions(admittedPaths, loaderRoot, agentDir);
    const runtime = loaded?.runtime ?? createExtensionRuntime();
    const extensions = [...(loaded?.extensions ?? [])];
    const errors = [...(loaded?.errors ?? [])];
    if (errors.length > 0) {
      throw new Error(`EXTENSION_LOAD_FAILED: ${errors.map((error) => `${error.path}: ${error.error}`).join("; ")}`);
    }

    const entryByPath = new Map(preflight.accepted.map((entry) => [resolve(entry.entryPath), entry]));
    for (const extension of extensions) {
      const entry = entryByPath.get(resolve(extension.path));
      if (entry === undefined) throw new Error(`EXTENSION_LOAD_FAILED: unadmitted runtime path ${extension.path}`);
      const undeclared = [...extension.tools.keys()].filter((name) => !(entry.toolNames ?? []).includes(name));
      if (undeclared.length > 0) throw new Error(`EXTENSION_TOOL_UNMAPPED: ${entry.id}: ${undeclared.join(", ")}`);
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
  const entries = new Map(loader.snapshot.extensions.enabled.map((entry) => [resolve(entry.entryPath), entry]));
  const result: RuntimeExtensionToolInput[] = [];
  for (const extension of loader.getExtensions().extensions) {
    const entry = entries.get(resolve(extension.path));
    const isBundled = entry?.trust === "bundled-reviewed";
    const sourceRevision = entry?.version ?? effectiveRevision.revisionId;
    for (const name of extension.tools.keys()) {
      result.push({
        name,
        source: isBundled ? "bundled_extension" : "approved_extension",
        sourceId: entry?.id ?? extension.path,
        sourceRevision
      });
    }
  }
  return result.sort((left, right) => `${left.name}:${left.sourceId}`.localeCompare(`${right.name}:${right.sourceId}`));
}

/** Source-aware inventory derived only from approved metadata; executes no Extension code. */
export function preflightExtensionTools(loader: SnapshotResourceLoader): RuntimeExtensionToolInput[] {
  return loader.inspect().accepted.flatMap((entry) => (entry.toolNames ?? []).map((name) => ({
    name,
    source: entry.trust === "bundled-reviewed" ? "bundled_extension" as const : "approved_extension" as const,
    sourceId: entry.id,
    sourceRevision: entry.version
  }))).sort((left, right) => `${left.name}:${left.sourceId}`.localeCompare(`${right.name}:${right.sourceId}`));
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
