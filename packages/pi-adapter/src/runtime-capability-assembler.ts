import { createHash } from "node:crypto";
import type {
  CapabilityMetadata,
  FrozenMcpActivation,
  ExtensionInventorySnapshot,
  RuntimeCapabilityDiagnostic,
  RuntimeResourceSnapshot,
  RuntimeSkillSnapshot,
  RuntimeMcpToolSchema
} from "@vc-agent/contracts";
import type { CapabilitySurfaceSnapshot } from "@vc-agent/contracts";

export type RuntimeToolSource = "host" | "pi_builtin" | "bundled_extension" | "approved_extension" | "mcp";
export type RuntimeToolScope = "project" | "unscoped";
export type RuntimeToolActivationClass = "bootstrap" | "common_read" | "on_demand" | "preconditioned" | "protected";

export interface RuntimeToolDescriptor {
  readonly name: string;
  readonly source: RuntimeToolSource;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly capabilityId?: string;
  readonly allowedScopes: readonly RuntimeToolScope[];
  readonly activationClass: RuntimeToolActivationClass;
  readonly sideEffectClass: CapabilityMetadata["sideEffectClass"];
  readonly hostMediated: boolean;
}

export interface RuntimeSkillDescriptor {
  readonly packageId: string;
  readonly revisionId: string;
  readonly name: string;
  readonly description: string;
  readonly activationReason: "task_match" | "explicit";
}

export interface RuntimeExtensionToolInput {
  readonly name: string;
  readonly source: "bundled_extension" | "approved_extension";
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly allowedScopes?: readonly RuntimeToolScope[];
  readonly capabilityId?: string;
}

export interface RuntimeCapabilityAssemblyInput {
  readonly hostSurface: CapabilitySurfaceSnapshot;
  readonly extensionRevision: ExtensionInventorySnapshot;
  readonly mcpActivation?: FrozenMcpActivation;
  readonly projectReadRoot?: string;
  readonly skills: RuntimeSkillSnapshot | undefined;
  /** Names of the Host custom tools that were actually registered for this session. */
  readonly hostToolNames?: readonly string[];
  /** Tool inventory produced by the reviewed Extension loader. */
  readonly extensionTools?: readonly RuntimeExtensionToolInput[];
}

export interface RuntimeCapabilityAssembly {
  readonly revision: string;
  readonly tools: readonly RuntimeToolDescriptor[];
  readonly initialActiveToolNames: readonly string[];
  readonly skills: readonly RuntimeSkillDescriptor[];
  readonly diagnostics: readonly RuntimeCapabilityDiagnostic[];
}

export class RuntimeCapabilityAssemblyError extends Error {
  readonly code: "RUNTIME_CAPABILITY_COLLISION" | "RUNTIME_CAPABILITY_REVISION_MISMATCH";
  readonly toolName: string;

  constructor(code: RuntimeCapabilityAssemblyError["code"], toolName: string, message: string) {
    super(message);
    this.name = "RuntimeCapabilityAssemblyError";
    this.code = code;
    this.toolName = toolName;
  }
}

const PROVIDER_TOOL_NAME_BY_CAPABILITY_ID: Readonly<Record<string, string>> = Object.freeze({
  "output.write_text": "output_write_text",
  "output.edit_text": "output_edit_text",
  "workspace.write_batch": "workspace_write_batch",
  "arxiv.fulltext": "arxiv_fulltext"
});

export function providerToolNameForCapability(capabilityId: string): string {
  return PROVIDER_TOOL_NAME_BY_CAPABILITY_ID[capabilityId] ?? capabilityId;
}

export function mcpCapabilityId(serverId: string, toolName: string): string {
  return `mcp:${serverId}:${toolName}`;
}

export function providerToolNameForMcp(serverId: string, toolName: string): string {
  return `mcp__${safeToolNamePart(serverId)}__${safeToolNamePart(toolName)}`;
}

/**
 * The sole source-aware runtime assembly seam. It only projects admitted
 * sources into descriptors and names; it never approves, connects, executes,
 * or commits anything.
 */
export class RuntimeCapabilityAssembler {
  assemble(input: RuntimeCapabilityAssemblyInput): RuntimeCapabilityAssembly {
    const diagnostics: RuntimeCapabilityDiagnostic[] = [];
    const tools: RuntimeToolDescriptor[] = [];
    const extensionTools = input.extensionTools ?? [];
    const extensionByName = new Map(extensionTools.map((tool) => [tool.name, tool]));
    const explicitHostToolNames = input.hostToolNames !== undefined;
    const hostToolNames = new Set(input.hostToolNames ?? []);

    for (const name of [...hostToolNames].sort()) {
      const policy = hostToolPolicy(name);
      tools.push({
        name,
        source: "host",
        sourceId: name,
        sourceRevision: input.hostSurface.revision,
        capabilityId: capabilityIdForProviderName(name, input.hostSurface.visibleCapabilityIds),
        allowedScopes: policy.allowedScopes,
        activationClass: policy.activationClass,
        sideEffectClass: policy.sideEffectClass,
        hostMediated: true
      });
    }

    if (input.projectReadRoot !== undefined && input.hostSurface.scope === "project") {
      for (const name of ["read", "ls", "find", "grep"] as const) {
        tools.push({
          name,
          source: "pi_builtin",
          sourceId: `pi-builtin:${name}`,
          sourceRevision: "@earendil-works/pi-coding-agent@0.80.8",
          allowedScopes: ["project"],
          activationClass: "common_read",
          sideEffectClass: "local_read",
          hostMediated: true
        });
      }
    }

    for (const extension of extensionTools) {
      tools.push({
        name: extension.name,
        source: extension.source,
        sourceId: extension.sourceId,
        sourceRevision: extension.sourceRevision,
        ...(extension.capabilityId === undefined ? {} : { capabilityId: extension.capabilityId }),
        allowedScopes: extension.allowedScopes ?? ["project", "unscoped"],
        activationClass: extension.name === "source_check" ? "on_demand" : "common_read",
        sideEffectClass: extension.name.startsWith("web_") || extension.name === "source_check" ? "network_read" : "none",
        hostMediated: false
      });
    }

    if (input.mcpActivation !== undefined) {
      if (input.mcpActivation.schemaRevision.length === 0) {
        throw new RuntimeCapabilityAssemblyError("RUNTIME_CAPABILITY_REVISION_MISMATCH", "mcp", "MCP activation is missing its frozen schema revision.");
      }
      for (const schema of input.mcpActivation.toolSchemas) tools.push(mcpDescriptor(input.mcpActivation, schema));
    }

    const uniqueTools = new Map<string, RuntimeToolDescriptor>();
    for (const tool of tools) {
      const prior = uniqueTools.get(tool.name);
      if (prior !== undefined && !sameRuntimeSource(prior, tool)) {
        throw new RuntimeCapabilityAssemblyError(
          "RUNTIME_CAPABILITY_COLLISION",
          tool.name,
          `Runtime tool name '${tool.name}' is provided by ${prior.sourceId}@${prior.sourceRevision} and ${tool.sourceId}@${tool.sourceRevision}.`
        );
      }
      uniqueTools.set(tool.name, prior ?? tool);
    }

    const resolvedTools = [...uniqueTools.values()].sort((left, right) => left.name.localeCompare(right.name));
    const active = new Set<string>();
    const activeOrder: string[] = [];
    const addActive = (name: string): void => {
      if (!uniqueTools.has(name) || active.has(name)) return;
      active.add(name);
      activeOrder.push(name);
    };
    for (const capabilityId of input.hostSurface.visibleCapabilityIds) {
      const providerName = providerToolNameForCapability(capabilityId);
      if (uniqueTools.has(providerName)) addActive(providerName);
      else if (extensionByName.has(capabilityId)) addActive(capabilityId);
      else if (explicitHostToolNames) diagnostics.push({
        code: capabilityId.startsWith("web_") ? "WEB_EXTENSION_UNAVAILABLE" : "RUNTIME_CAPABILITY_SOURCE_UNAVAILABLE",
        message: `No admitted runtime source is available for capability '${capabilityId}'.`,
        toolName: capabilityId,
        sourceRevision: input.extensionRevision.revisionId
      });
    }

    // The web extension stores long results and exposes a bounded companion
    // reader. It is part of the same task activation, not a second Host fetch.
    if (active.has("web_search") || active.has("web_fetch")) {
      addActive("web_fetch_content");
    }
    if (input.projectReadRoot !== undefined && input.hostSurface.scope === "project") {
      for (const name of ["read", "ls", "find", "grep"]) addActive(name);
    }
    if (input.mcpActivation !== undefined && input.mcpActivation.scope === input.hostSurface.scope) {
      for (const schema of input.mcpActivation.toolSchemas) addActive(providerToolNameForMcp(input.mcpActivation.serverId, schema.name));
    }

    const skills = (input.skills?.decisions ?? []).map((decision) => {
      const instruction = input.skills?.instructions.find((item) => item.packageId === decision.packageId && item.revisionId === decision.revisionId);
      return {
        packageId: decision.packageId,
        revisionId: decision.revisionId,
        name: instruction?.name ?? decision.packageId,
        description: instruction?.description ?? "Task-selected Skill",
        activationReason: decision.reason
      } satisfies RuntimeSkillDescriptor;
    }).sort((left, right) => `${left.packageId}:${left.revisionId}`.localeCompare(`${right.packageId}:${right.revisionId}`));

    const revision = createHash("sha256").update(JSON.stringify({
      hostSurface: input.hostSurface.revision,
      extensionRevision: input.extensionRevision.revisionId,
      mcpActivation: input.mcpActivation === undefined ? null : {
        activationId: input.mcpActivation.activationId,
        serverId: input.mcpActivation.serverId,
        schemaRevision: input.mcpActivation.schemaRevision,
        toolSchemas: input.mcpActivation.toolSchemas.map((schema) => [schema.name, schema.schemaHash])
      },
      projectReadRoot: input.projectReadRoot === undefined ? null : input.projectReadRoot,
      tools: resolvedTools,
      active: [...active].sort(),
      skills
    })).digest("hex");

    return {
      revision,
      tools: Object.freeze(resolvedTools),
      initialActiveToolNames: Object.freeze(activeOrder),
      skills: Object.freeze(skills),
      diagnostics: Object.freeze(diagnostics)
    };
  }

  activate(assembly: RuntimeCapabilityAssembly, capabilityIds: readonly string[]): readonly string[] {
    const active = new Set(assembly.initialActiveToolNames);
    for (const capabilityId of capabilityIds) {
      const providerName = providerToolNameForCapability(capabilityId);
      const descriptor = assembly.tools.find((tool) => tool.capabilityId === capabilityId || tool.name === providerName || tool.name === capabilityId);
      if (descriptor !== undefined) active.add(descriptor.name);
      if (capabilityId === "web_search" || capabilityId === "web_fetch") {
        if (assembly.tools.some((tool) => tool.name === "web_fetch_content")) active.add("web_fetch_content");
      }
    }
    return Object.freeze([...active]);
  }
}

function mcpDescriptor(activation: FrozenMcpActivation, schema: RuntimeMcpToolSchema): RuntimeToolDescriptor {
  return {
    name: providerToolNameForMcp(activation.serverId, schema.name),
    source: "mcp",
    sourceId: `${activation.serverId}:${schema.name}`,
    sourceRevision: activation.schemaRevision,
    capabilityId: mcpCapabilityId(activation.serverId, schema.name),
    allowedScopes: schema.allowedScopes,
    activationClass: "preconditioned",
    sideEffectClass: mcpSideEffectClass(schema),
    hostMediated: true
  };
}

function mcpSideEffectClass(schema: RuntimeMcpToolSchema): CapabilityMetadata["sideEffectClass"] {
  return schema.actionClass === "read" ? "network_read" : schema.actionClass === "local_file_upload" ? "local_write" : "external_write";
}

function capabilityIdForProviderName(name: string, visibleCapabilityIds: readonly string[]): string | undefined {
  return visibleCapabilityIds.find((id) => providerToolNameForCapability(id) === name);
}

function hostToolPolicy(name: string): Pick<RuntimeToolDescriptor, "allowedScopes" | "activationClass" | "sideEffectClass"> {
  if (name === "capability_request") return { allowedScopes: ["project", "unscoped"], activationClass: "bootstrap", sideEffectClass: "none" };
  if (["material_recall", "project_state_recall", "reflection_evidence_drilldown"].includes(name)) return { allowedScopes: ["project"], activationClass: "common_read", sideEffectClass: "local_read" };
  if (["memory_recall"].includes(name)) return { allowedScopes: ["project", "unscoped"], activationClass: "common_read", sideEffectClass: "local_read" };
  if (["academic_research", "web_search", "web_fetch"].includes(name)) return { allowedScopes: ["project", "unscoped"], activationClass: "on_demand", sideEffectClass: "network_read" };
  if (["output_write_text", "output_edit_text", "workspace_write_batch", "file_download", "arxiv_fulltext", "reflection_outcome_propose"].includes(name)) return { allowedScopes: ["project"], activationClass: "protected", sideEffectClass: "local_write" };
  return { allowedScopes: ["project", "unscoped"], activationClass: "on_demand", sideEffectClass: "none" };
}

function sameRuntimeSource(left: RuntimeToolDescriptor, right: RuntimeToolDescriptor): boolean {
  return left.source === right.source && left.sourceId === right.sourceId && left.sourceRevision === right.sourceRevision;
}

function safeToolNamePart(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return normalized.length > 0 ? normalized.slice(0, 80) : createHash("sha256").update(value).digest("hex").slice(0, 16);
}
