import {
  createSyntheticSourceInfo,
  createExtensionRuntime,
  type LoadExtensionsResult,
  type ResourceLoader,
  type Skill
} from "@earendil-works/pi-coding-agent";
import type { ExtensionInventorySnapshot, RuntimeResourceSnapshot } from "@vc-agent/contracts";

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
    const skills: Skill[] = (this.#input.resources.skills?.instructions ?? []).map((instruction) => ({
      name: instruction.name,
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
    this.#extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  }
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  return end < 0 ? content : content.slice(end + "\n---".length);
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
