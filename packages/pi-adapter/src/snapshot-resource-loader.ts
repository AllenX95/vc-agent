import {
  createExtensionRuntime,
  type LoadExtensionsResult,
  type ResourceLoader
} from "@earendil-works/pi-coding-agent";
import type { ExtensionInventorySnapshot, RuntimeResourceSnapshot } from "@vc-agent/contracts";

export type { ExtensionInventorySnapshot, RuntimeResourceSnapshot } from "@vc-agent/contracts";

type FrozenRuntimeResourceSnapshot = Readonly<
  Omit<RuntimeResourceSnapshot, "appendSystemPrompt"> & { appendSystemPrompt: readonly string[] }
>;
type FrozenExtensionInventorySnapshot = Readonly<
  Omit<ExtensionInventorySnapshot, "enabled"> & {
    enabled: readonly Readonly<ExtensionInventorySnapshot["enabled"][number]>[];
  }
>;

export interface SnapshotResourceLoaderInput {
  readonly cwd: string;
  readonly resources: FrozenRuntimeResourceSnapshot;
  readonly extensions: FrozenExtensionInventorySnapshot;
}

export function freezeRuntimeSnapshots(input: SnapshotResourceLoaderInput): SnapshotResourceLoaderInput {
  const resources = Object.freeze({
    ...input.resources,
    appendSystemPrompt: Object.freeze([...input.resources.appendSystemPrompt])
  });
  const enabled = input.extensions.enabled.map((entry) => Object.freeze({ ...entry }));
  const extensions = Object.freeze({ ...input.extensions, enabled: Object.freeze(enabled) });
  return Object.freeze({ cwd: input.cwd, resources, extensions });
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
    return { skills: [], diagnostics: [] };
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
    return [...this.#input.resources.appendSystemPrompt];
  }

  extendResources(_paths: Parameters<ResourceLoader["extendResources"]>[0]): void {
    throw new Error("Runtime Resource Snapshot is immutable");
  }

  async reload(): Promise<void> {
    this.#extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  }
}
