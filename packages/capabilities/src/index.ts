import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import type {
  AccessMode,
  ArtifactRecord,
  CapabilityActivationRejection,
  CapabilityCatalogEntry,
  CapabilityExecutionRequest,
  CapabilityMetadata,
  CapabilityExecutionResult
} from "@vc-agent/contracts";
export {
  createTurnCapabilitySurface,
  type CapabilityCatalogEntry,
  type CapabilityTier,
  type TurnCapabilityAvailability,
  type TurnCapabilityScope,
  type TurnCapabilitySurfaceInput,
  type TurnCapabilitySurfaceSnapshot,
  type TurnKind
} from "./turn-capability-surface.js";
import {
  CAPABILITY_INPUT_LIMITS,
  reflectionOutcomeProposalInputSchema,
  type ReflectionOutcomeProposalInput
} from "@vc-agent/contracts";

export interface CapabilityExecutionContext {
  readonly request: CapabilityExecutionRequest;
  readonly accessMode: AccessMode;
  readonly outputLocation?: string;
  readonly projectRoot?: string;
  readonly sensitiveActionApproved?: boolean;
}

export interface SensitiveAction {
  readonly action: string;
  readonly target: string;
  readonly reason: string;
  readonly expectedEffect: string;
  readonly preview?: string;
}

export {
  createProjectCommandCapability,
  createTextEditCapability,
  type ProjectCommandExecutor,
  type ProjectCommandResult
} from "./controlled-project-tools.js";
export {
  createAcademicResearchCapability,
  type AcademicResearchExecutor
} from "./academic-research.js";

export interface CapabilityDefinition<TInput extends Record<string, unknown> = Record<string, unknown>> {
  readonly metadata: CapabilityMetadata;
  readonly inputSchema: z.ZodType<TInput>;
  inspect(input: TInput, context: CapabilityExecutionContext): SensitiveAction | undefined;
  execute(input: TInput, context: CapabilityExecutionContext): Promise<CapabilityExecutionResult>;
}

export class CapabilityRegistry {
  readonly #definitions = new Map<string, CapabilityDefinition>();

  register(definition: CapabilityDefinition): void {
    if (this.#definitions.has(definition.metadata.id)) throw new Error(`Capability already registered: ${definition.metadata.id}`);
    this.#definitions.set(definition.metadata.id, definition);
  }

  get(id: string): CapabilityDefinition | undefined {
    return this.#definitions.get(id);
  }

  inventory(): CapabilityMetadata[] {
    return [...this.#definitions.values()].map((definition) => definition.metadata);
  }
}

export interface TurnCapabilityIntent {
  readonly scope: "unscoped" | "project";
  readonly materialRecall: boolean;
  readonly projectStateRecall: boolean;
  readonly memoryRecall: boolean;
  readonly webResearch: boolean;
  readonly outputWrite: boolean;
}

export function capabilitiesForTurn(intent: TurnCapabilityIntent): readonly string[] {
  return [
    ...(intent.materialRecall ? ["material_recall"] : []),
    ...(intent.scope === "project" && intent.projectStateRecall ? ["project_state_recall"] : []),
    ...(intent.memoryRecall ? ["memory_recall"] : []),
    ...(intent.webResearch ? ["web_search", "web_fetch"] : []),
    ...(intent.outputWrite ? ["output.write_text"] : [])
  ];
}

export class UnknownOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownOutcomeError";
  }
}

export class OutputCollisionError extends Error {
  readonly target: string;
  constructor(target: string) {
    super(`Output already exists: ${target}`);
    this.name = "OutputCollisionError";
    this.target = target;
  }
}

export class TextOutputStore {
  readonly #maxBytes: number;

  constructor(maxBytes = 5 * 1024 * 1024) {
    this.#maxBytes = maxBytes;
  }

  resolveTarget(outputLocation: string, relativePath: string): string {
    if (relativePath.trim().length === 0 || relativePath.includes("\0")) throw new Error("Output path is invalid");
    const root = resolve(outputLocation);
    const target = resolve(root, relativePath);
    if (!target.startsWith(`${root}${sep}`)) throw new Error("Output path escapes the authorized location");
    return target;
  }

  targetExists(outputLocation: string, relativePath: string): boolean {
    return existsSync(this.resolveTarget(outputLocation, relativePath));
  }

  commit(input: {
    readonly requestId: string;
    readonly outputLocation: string;
    readonly relativePath: string;
    readonly content: string;
    readonly mediaType: string;
    readonly producer: ArtifactRecord["producer"];
    readonly threadId: string;
    readonly turnId: string;
    readonly allowReplace: boolean;
  }): ArtifactRecord {
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes > this.#maxBytes) throw new Error(`Text Output exceeds ${this.#maxBytes} bytes`);
    const target = this.resolveTarget(input.outputLocation, input.relativePath);
    if (existsSync(target) && !input.allowReplace) throw new OutputCollisionError(target);
    mkdirSync(dirname(target), { recursive: true });
    const temporary = resolve(dirname(target), `.vc-agent-${input.requestId}.partial`);
    try {
      writeFileSync(temporary, input.content, { encoding: "utf8", flag: "wx" });
      const descriptor = openSync(temporary, "r+");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
    return {
      schemaVersion: 1,
      id: randomUUID(),
      mediaType: input.mediaType,
      producer: input.producer,
      destination: target,
      source: { threadId: input.threadId, turnId: input.turnId, capabilityRequestId: input.requestId },
      createdAt: new Date().toISOString()
    };
  }
}

const textOutputInputSchema = z.object({
  path: z.string().trim().min(1).max(500),
  content: z.string().max(5 * 1024 * 1024),
  mediaType: z.string().trim().min(1).max(200).default("text/plain; charset=utf-8"),
  replaceExisting: z.boolean().default(false),
  sourceReferences: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  warnings: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  skillId: z.string().trim().min(1).max(200).optional(),
  relatedArtifacts: z.array(z.object({ relation: z.enum(["render", "diff", "supporting"]), path: z.string().trim().min(1).max(500), mediaType: z.string().trim().min(1).max(200).optional() })).max(50).default([])
});

export function createTextOutputCapability(store: TextOutputStore): CapabilityDefinition<z.infer<typeof textOutputInputSchema>> {
  return {
    metadata: {
      id: "output.write_text",
      version: "1.1.0",
      label: "Write text output",
      description: "Create a new requested UTF-8 text or Markdown deliverable. Do not use this to edit an existing Output; use output.edit_text so the User can review a diff. Distinguish sourced facts, inference, uncertainty, and material disagreement, and supply stable Material references or public URLs used.",
      useWhen: "Use only when the User asks for a durable text or Markdown deliverable.",
      tier: "preconditioned",
      activationClass: "preconditioned_execution",
      sideEffectClass: "local_write",
      allowedScopes: ["unscoped", "project"],
      executor: "host",
      modelCallable: true,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          mediaType: { type: "string" },
          replaceExisting: { type: "boolean" },
          sourceReferences: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } },
          skillId: { type: "string" },
          relatedArtifacts: { type: "array", items: { type: "object" } }
        },
        required: ["path", "content"]
      },
      outputSchema: {
        type: "object",
        properties: { artifactId: { type: "string" }, destination: { type: "string" }, mediaType: { type: "string" } },
        required: ["artifactId", "destination", "mediaType"]
      }
    },
    inputSchema: textOutputInputSchema,
    inspect(input, context) {
      if (context.outputLocation === undefined) throw new Error("Output Location is not configured");
      assertUserOutputPath(input.path, context);
      const target = store.resolveTarget(context.outputLocation, input.path);
      if (!store.targetExists(context.outputLocation, input.path)) return undefined;
      return {
        action: "Replace existing Output",
        target,
        reason: "The requested destination already exists.",
        expectedEffect: "The existing file will be replaced atomically with the generated text Output."
      };
    },
    async execute(input, context) {
      if (context.outputLocation === undefined) throw new Error("Output Location is not configured");
      assertUserOutputPath(input.path, context);
      const artifact = store.commit({
        requestId: context.request.requestId,
        outputLocation: context.outputLocation,
        relativePath: input.path,
        content: input.content,
        mediaType: input.mediaType,
        producer: { type: context.request.actor.actorType === "sub_agent" ? "sub_agent" : "agent", id: context.request.actor.actorId },
        threadId: context.request.threadId,
        turnId: context.request.turnId,
        allowReplace: input.replaceExisting || context.accessMode === "full" || context.sensitiveActionApproved === true
      });
      return {
        schemaVersion: 1,
        requestId: context.request.requestId,
        status: "completed",
        content: `Created ${artifact.mediaType} Output at ${artifact.destination}`,
        artifact
      };
    }
  };
}

function assertUserOutputPath(path: string, context: CapabilityExecutionContext): void {
  if (context.request.scope.kind !== "project") return;
  const topLevel = path.replace(/\\/gu, "/").split("/")[0]?.toLocaleLowerCase();
  if (topLevel === "system" || topLevel === "parsed") throw new Error(`outputs/${topLevel} is reserved for system-managed artifacts.`);
}

const capabilityRequestInputSchema = z.union([
  z.object({
    mode: z.literal("catalog"),
    need: z.string().trim().min(1).max(1_000)
  }),
  z.object({
    mode: z.literal("activate"),
    need: z.string().trim().min(1).max(1_000),
    capabilityIds: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
    catalogRevision: z.string().regex(/^[a-f0-9]{64}$/)
  }),
  // Kept for one migration window so old persisted/faux Pi turns resolve
  // safely while the Provider learns the catalog/activate form.
  z.object({
    need: z.string().trim().min(1).max(1_000),
    capabilityId: z.string().trim().min(1).max(200).optional()
  })
]);

export type CapabilityBrokerResolution =
  | readonly string[]
  | { readonly kind: "catalog"; readonly catalogRevision: string; readonly entries: readonly CapabilityCatalogEntry[] }
  | {
      readonly kind: "activation";
      readonly catalogRevision: string;
      readonly activatedCapabilities: readonly string[];
      readonly alreadyVisible?: readonly string[];
      readonly rejected?: readonly CapabilityActivationRejection[];
    };

type StructuredCapabilityBrokerResolution = Exclude<CapabilityBrokerResolution, readonly string[]>;

function isStructuredCapabilityBrokerResolution(value: CapabilityBrokerResolution): value is StructuredCapabilityBrokerResolution {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "kind" in value;
}

export function createCapabilityBroker(
  resolve: (input: z.infer<typeof capabilityRequestInputSchema>, context: CapabilityExecutionContext) => CapabilityBrokerResolution
): CapabilityDefinition<z.infer<typeof capabilityRequestInputSchema>> {
  return {
    metadata: {
      id: "capability_request", version: "1.0.0", label: "Request capability",
      description: "Request an allowed task capability for the current Turn. This does not execute it or grant permission.",
      useWhen: "Use when a needed capability is not visible; catalog first, then activate approved IDs.",
      tier: "bootstrap",
      activationClass: "ordinary_task", sideEffectClass: "none", allowedScopes: ["unscoped", "project"], executor: "host", modelCallable: true,
      inputSchema: {
        type: "object",
        properties: {
          mode: { enum: ["catalog", "activate"] },
          need: { type: "string", maxLength: 1_000 },
          capabilityIds: { type: "array", items: { type: "string" }, maxItems: 8 },
          catalogRevision: { type: "string" },
          capabilityId: { type: "string" }
        },
        required: ["need"]
      },
      outputSchema: { type: "object", properties: { catalogRevision: { type: "string" }, entries: { type: "array" }, activatedCapabilities: { type: "array", items: { type: "string" } }, alreadyVisible: { type: "array", items: { type: "string" } }, rejected: { type: "array" } } }
    },
    inputSchema: capabilityRequestInputSchema,
    inspect: () => undefined,
    async execute(input, context) {
      const resolution = resolve(input, context);
      if (!isStructuredCapabilityBrokerResolution(resolution)) {
        const activatedCapabilities = [...resolution];
        return {
          schemaVersion: 1, requestId: context.request.requestId,
          status: activatedCapabilities.length === 0 ? "failed" : "completed",
          ...(activatedCapabilities.length === 0 ? { code: "CAPABILITY_UNAVAILABLE" } : {}),
          content: activatedCapabilities.length === 0
            ? "No allowed capability matches this request. No alternative capability, Provider, or permission was selected."
            : `Activated for this Turn: ${activatedCapabilities.join(", ")}`,
          activatedCapabilities
        };
      }
      if (resolution.kind === "catalog") {
        return {
          schemaVersion: 1,
          requestId: context.request.requestId,
          status: "completed",
          content: JSON.stringify({ catalogRevision: resolution.catalogRevision, entries: resolution.entries }),
          activatedCapabilities: []
        };
      }
      const activatedCapabilities = [...resolution.activatedCapabilities];
      const alreadyVisible = [...(resolution.alreadyVisible ?? [])];
      const rejected = [...(resolution.rejected ?? [])];
      const hasSuccessfulResult = activatedCapabilities.length > 0 || alreadyVisible.length > 0;
      return {
        schemaVersion: 1,
        requestId: context.request.requestId,
        status: hasSuccessfulResult ? "completed" : "failed",
        ...(hasSuccessfulResult ? {} : { code: rejected[0]?.code ?? "CAPABILITY_UNAVAILABLE" }),
        content: JSON.stringify({ catalogRevision: resolution.catalogRevision, activatedCapabilities, alreadyVisible, rejected }),
        activatedCapabilities,
        activation: { catalogRevision: resolution.catalogRevision, activatedCapabilities, alreadyVisible, rejected }
      };
    }
  };
}

const materialRecallInputSchema = z.object({
  disclosureLevel: z.enum(["cards", "outline", "excerpt", "full"]),
  materialId: z.string().uuid().optional(),
  blockIds: z.array(z.string().min(1)).max(24).optional(),
  query: z.string().max(500).optional(),
  maxItems: z.number().int().min(1).transform((value) => Math.min(value, CAPABILITY_INPUT_LIMITS.materialRecall.maxItems)).default(8),
  maxChars: z.number().int().min(500).transform((value) => Math.min(value, CAPABILITY_INPUT_LIMITS.materialRecall.maxChars)).default(8_000)
});

export function createMaterialRecallCapability(
  recall: (input: z.infer<typeof materialRecallInputSchema>, context: CapabilityExecutionContext) => Promise<{ body: string; retrieval: NonNullable<CapabilityExecutionResult["retrieval"]> }>
): CapabilityDefinition<z.infer<typeof materialRecallInputSchema>> {
  return {
    metadata: {
      id: "material_recall", version: "1.1.0", label: "List and read project materials",
      description: "List scoped Project files as Material cards, then inspect outlines or bounded source-referenced blocks from attachments, BP, technical-result, or financial materials. Expand progressively and respect omitted-content warnings.",
      useWhen: "Use when a factual claim depends on a project file, attachment, BP, technical result, or financial material.",
      tier: "common_read",
      activationClass: "ordinary_task", sideEffectClass: "local_read", allowedScopes: ["unscoped", "project"], executor: "host", modelCallable: true,
      inputSchema: { type: "object", properties: { disclosureLevel: { enum: ["cards", "outline", "excerpt", "full"] }, materialId: { type: "string" }, blockIds: { type: "array", items: { type: "string" }, maxItems: 24 }, query: { type: "string", maxLength: 500 }, maxItems: { type: "integer", minimum: 1, maximum: CAPABILITY_INPUT_LIMITS.materialRecall.maxItems }, maxChars: { type: "integer", minimum: 500, maximum: CAPABILITY_INPUT_LIMITS.materialRecall.maxChars } }, required: ["disclosureLevel"] },
      outputSchema: { type: "object", properties: { sourceClass: { const: "material" }, disclosureLevel: { type: "string" }, items: { type: "array" }, complete: { type: "boolean" }, omittedItems: { type: "integer" }, warnings: { type: "array" }, contextReference: { type: "object" } }, required: ["sourceClass", "disclosureLevel", "items", "complete", "omittedItems", "warnings", "contextReference"] }
    },
    inputSchema: materialRecallInputSchema,
    inspect: () => undefined,
    async execute(input, context) {
      const recalled = await recall(input, context);
      return { schemaVersion: 1, requestId: context.request.requestId, status: "completed", content: recalled.body, retrieval: recalled.retrieval };
    }
  };
}

const reflectionEvidenceDrilldownInputSchema = z.object({
  referenceId: z.string().min(1).max(500),
  maxChars: z.number().int().min(500).transform((value) => Math.min(value, CAPABILITY_INPUT_LIMITS.reflectionEvidenceDrilldown.maxChars)).default(4_000)
});

export function createReflectionEvidenceDrilldownCapability(
  recall: (input: z.infer<typeof reflectionEvidenceDrilldownInputSchema>, context: CapabilityExecutionContext) => Promise<{ body: string; retrieval: NonNullable<CapabilityExecutionResult["retrieval"]> }>
): CapabilityDefinition<z.infer<typeof reflectionEvidenceDrilldownInputSchema>> {
  return {
    metadata: {
      id: "reflection_evidence_drilldown", version: "1.0.0", label: "Verify Reflection evidence",
      description: "Resolve one exact stable evidence reference from the Independent Assessment under a bounded excerpt budget. This cannot browse Materials or choose a different source range.",
      useWhen: "Use only inside an active Reflection dialogue when verifying a frozen assessment reference.",
      tier: "protected_workflow",
      activationClass: "ordinary_task", sideEffectClass: "local_read", allowedScopes: ["project"], executor: "host", modelCallable: true,
      inputSchema: { type: "object", properties: { referenceId: { type: "string" }, maxChars: { type: "integer", minimum: 500, maximum: CAPABILITY_INPUT_LIMITS.reflectionEvidenceDrilldown.maxChars } }, required: ["referenceId"] },
      outputSchema: { type: "object", properties: { sourceClass: { const: "material" }, disclosureLevel: { const: "evidence_drilldown" }, items: { type: "array", maxItems: 1 }, complete: { type: "boolean" }, warnings: { type: "array" }, contextReference: { type: "object" } }, required: ["sourceClass", "disclosureLevel", "items", "complete", "warnings", "contextReference"] }
    },
    inputSchema: reflectionEvidenceDrilldownInputSchema,
    inspect: () => undefined,
    async execute(input, context) {
      const recalled = await recall(input, context);
      return { schemaVersion: 1, requestId: context.request.requestId, status: "completed", content: recalled.body, retrieval: recalled.retrieval };
    }
  };
}

const projectStateRecallInputSchema = z.object({
  source: z.literal("project_context").default("project_context"),
  sectionIds: z.array(z.string().trim().min(1).max(100)).max(6).optional(),
  query: z.string().trim().max(500).optional(),
  maxItems: z.number().int().min(1).transform((value) => Math.min(value, CAPABILITY_INPUT_LIMITS.projectStateRecall.maxItems)).default(6),
  maxChars: z.number().int().min(500).transform((value) => Math.min(value, CAPABILITY_INPUT_LIMITS.projectStateRecall.maxChars)).default(6_000)
});

export function createProjectStateRecallCapability(
  recall: (input: z.infer<typeof projectStateRecallInputSchema>, context: CapabilityExecutionContext) => Promise<{ body: string; retrieval: NonNullable<CapabilityExecutionResult["retrieval"]> }>
): CapabilityDefinition<z.infer<typeof projectStateRecallInputSchema>> {
  return {
    metadata: {
      id: "project_state_recall", version: "1.0.0", label: "Recall project state",
      description: "Recall bounded, separately labelled sections from Project Context without loading Materials, Project Memory, or other source classes. Use memory_recall for Project Memory.",
      useWhen: "Use when the task depends on Project Context such as thesis, risks, stage, or operating assumptions.",
      tier: "common_read",
      activationClass: "ordinary_task", sideEffectClass: "local_read", allowedScopes: ["project"], executor: "host", modelCallable: true,
      inputSchema: { type: "object", properties: { source: { const: "project_context" }, sectionIds: { type: "array", items: { type: "string" }, maxItems: CAPABILITY_INPUT_LIMITS.projectStateRecall.maxItems }, query: { type: "string", maxLength: 500 }, maxItems: { type: "integer", minimum: 1, maximum: CAPABILITY_INPUT_LIMITS.projectStateRecall.maxItems }, maxChars: { type: "integer", minimum: 500, maximum: CAPABILITY_INPUT_LIMITS.projectStateRecall.maxChars } } },
      outputSchema: { type: "object", properties: { sourceClass: { const: "project_state" }, disclosureLevel: { const: "sections" }, items: { type: "array" }, complete: { type: "boolean" }, omittedItems: { type: "integer" }, warnings: { type: "array" }, contextReference: { type: "object" } }, required: ["sourceClass", "items", "warnings", "contextReference"] }
    },
    inputSchema: projectStateRecallInputSchema,
    inspect: () => undefined,
    async execute(input, context) {
      const recalled = await recall(input, context);
      return { schemaVersion: 1, requestId: context.request.requestId, status: "completed", content: recalled.body, retrieval: recalled.retrieval };
    }
  };
}

const memoryRecallInputSchema = z.object({
  source: z.enum(["project_memory", "long_term_memory"]),
  disclosureLevel: z.enum(["cards", "full"]).default("cards"),
  entryIds: z.array(z.string().min(1).max(100)).max(8).optional(),
  query: z.string().trim().max(500).optional(),
  maxItems: z.number().int().min(1).transform((value) => Math.min(value, CAPABILITY_INPUT_LIMITS.memoryRecall.maxItems)).default(6),
  maxChars: z.number().int().min(500).transform((value) => Math.min(value, CAPABILITY_INPUT_LIMITS.memoryRecall.maxChars)).default(6_000)
});

export function createMemoryRecallCapability(
  recall: (input: z.infer<typeof memoryRecallInputSchema>, context: CapabilityExecutionContext) => Promise<{ body: string; retrieval: NonNullable<CapabilityExecutionResult["retrieval"]> }>
): CapabilityDefinition<z.infer<typeof memoryRecallInputSchema>> {
  return {
    metadata: {
      id: "memory_recall", version: "1.0.0", label: "Recall memory",
      description: "Recall bounded user-confirmed judgment cards and selectively expand relevant entries. Memory is not source evidence.",
      useWhen: "Use for prior user-confirmed judgment when the task is judgment-heavy or the User explicitly asks for Memory.",
      tier: "on_demand",
      activationClass: "ordinary_task", sideEffectClass: "local_read", allowedScopes: ["unscoped", "project"], executor: "host", modelCallable: true,
      inputSchema: { type: "object", properties: { source: { enum: ["project_memory", "long_term_memory"] }, disclosureLevel: { enum: ["cards", "full"] }, entryIds: { type: "array", items: { type: "string" }, maxItems: CAPABILITY_INPUT_LIMITS.memoryRecall.maxItems }, query: { type: "string", maxLength: 500 }, maxItems: { type: "integer", minimum: 1, maximum: CAPABILITY_INPUT_LIMITS.memoryRecall.maxItems }, maxChars: { type: "integer", minimum: 500, maximum: CAPABILITY_INPUT_LIMITS.memoryRecall.maxChars } }, required: ["source"] },
      outputSchema: { type: "object", properties: { sourceClass: { const: "memory" }, items: { type: "array" }, warnings: { type: "array" }, contextReference: { type: "object" } }, required: ["sourceClass", "items", "warnings", "contextReference"] }
    },
    inputSchema: memoryRecallInputSchema,
    inspect: () => undefined,
    async execute(input, context) {
      if (input.source === "project_memory" && context.request.scope.kind !== "project") return { schemaVersion: 1, requestId: context.request.requestId, status: "failed", code: "RECALL_SOURCE_UNAVAILABLE", content: "Project Memory is unavailable outside its Project scope; no Project state was loaded." };
      const recalled = await recall(input, context);
      return { schemaVersion: 1, requestId: context.request.requestId, status: "completed", content: recalled.body, retrieval: recalled.retrieval };
    }
  };
}

export function createReflectionOutcomeProposalCapability(
  propose: (input: ReflectionOutcomeProposalInput, context: CapabilityExecutionContext) => Promise<string>
): CapabilityDefinition<ReflectionOutcomeProposalInput> {
  return {
    metadata: {
      id: "reflection_outcome_propose", version: "1.0.0", label: "Propose Reflection outcomes",
      description: "Create non-authoritative Judgment Record and de-identified Long-term Learning drafts only after the User explicitly requests outcome preparation. Drafts require separate User confirmation before any Project or Memory write.",
      activationClass: "protected_workflow", sideEffectClass: "local_write", allowedScopes: ["unscoped", "project"], executor: "host", modelCallable: true,
      inputSchema: {
        type: "object",
        properties: {
          judgmentRecord: { type: "object" },
          learningProposals: { type: "array", maxItems: 3, items: { type: "object" } }
        }
      },
      outputSchema: {
        type: "object",
        properties: { status: { const: "drafted" }, judgmentCount: { type: "integer" }, learningProposalCount: { type: "integer" } },
        required: ["status", "judgmentCount", "learningProposalCount"]
      }
    },
    inputSchema: reflectionOutcomeProposalInputSchema,
    inspect: () => undefined,
    async execute(input, context) {
      const content = await propose(input, context);
      return { schemaVersion: 1, requestId: context.request.requestId, status: "completed", content };
    }
  };
}

const webSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  maxResults: z.number().int().min(1).transform((value) => Math.min(value, CAPABILITY_INPUT_LIMITS.webRecall.maxItems)).default(6),
  maxChars: z.number().int().min(500).transform((value) => Math.min(value, CAPABILITY_INPUT_LIMITS.webRecall.maxChars)).default(6_000)
});
const webFetchInputSchema = z.object({
  url: z.string().url().max(2_000).refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
    } catch { return false; }
  }, "Only unauthenticated public HTTP(S) URLs are allowed."),
  maxChars: z.number().int().min(500).transform((value) => Math.min(value, CAPABILITY_INPUT_LIMITS.webRecall.maxChars)).default(6_000)
});

type WebCapabilityResult = Promise<{ body: string; retrieval: NonNullable<CapabilityExecutionResult["retrieval"]> }>;

export function createWebSearchCapability(
  search: (input: z.infer<typeof webSearchInputSchema>, context: CapabilityExecutionContext) => WebCapabilityResult
): CapabilityDefinition<z.infer<typeof webSearchInputSchema>> {
  return {
    metadata: {
      id: "web_search", version: "1.0.0", label: "Search public web",
      description: "Search the current public web without login, browser state, writes, or durable snapshots.",
      useWhen: "Use when current external facts or public-source verification materially affect the answer.",
      tier: "common_read",
      activationClass: "ordinary_task", sideEffectClass: "network_read", allowedScopes: ["unscoped", "project"], executor: "host", modelCallable: true,
      inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 500 }, maxResults: { type: "integer", minimum: 1, maximum: CAPABILITY_INPUT_LIMITS.webRecall.maxItems }, maxChars: { type: "integer", minimum: 500, maximum: CAPABILITY_INPUT_LIMITS.webRecall.maxChars } }, required: ["query"] },
      outputSchema: webOutputSchema()
    },
    inputSchema: webSearchInputSchema,
    inspect: () => undefined,
    async execute(input, context) {
      const result = await search(input, context);
      return { schemaVersion: 1, requestId: context.request.requestId, status: "completed", content: result.body, retrieval: result.retrieval };
    }
  };
}

export function createWebFetchCapability(
  fetchPublic: (input: z.infer<typeof webFetchInputSchema>, context: CapabilityExecutionContext) => WebCapabilityResult
): CapabilityDefinition<z.infer<typeof webFetchInputSchema>> {
  return {
    metadata: {
      id: "web_fetch", version: "1.0.0", label: "Fetch public URL",
      description: "Fetch and extract a bounded public page or PDF without login, browser state, writes, or durable snapshots.",
      useWhen: "Use after search, or when the User supplies a public URL that must be verified.",
      tier: "common_read",
      activationClass: "ordinary_task", sideEffectClass: "network_read", allowedScopes: ["unscoped", "project"], executor: "host", modelCallable: true,
      inputSchema: { type: "object", properties: { url: { type: "string", maxLength: 2_000 }, maxChars: { type: "integer", minimum: 500, maximum: CAPABILITY_INPUT_LIMITS.webRecall.maxChars } }, required: ["url"] },
      outputSchema: webOutputSchema()
    },
    inputSchema: webFetchInputSchema,
    inspect: () => undefined,
    async execute(input, context) {
      const result = await fetchPublic(input, context);
      return { schemaVersion: 1, requestId: context.request.requestId, status: "completed", content: result.body, retrieval: result.retrieval };
    }
  };
}

function webOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: { sourceClass: { const: "web" }, items: { type: "array" }, complete: { type: "boolean" }, omittedItems: { type: "integer" }, warnings: { type: "array" }, contextReference: { type: "object" } },
    required: ["sourceClass", "items", "complete", "omittedItems", "warnings", "contextReference"]
  };
}
