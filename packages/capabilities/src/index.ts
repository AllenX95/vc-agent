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
  CapabilityExecutionRequest,
  CapabilityMetadata,
  CapabilityExecutionResult
} from "@vc-agent/contracts";

export interface CapabilityExecutionContext {
  readonly request: CapabilityExecutionRequest;
  readonly accessMode: AccessMode;
  readonly outputLocation?: string;
  readonly sensitiveActionApproved?: boolean;
}

export interface SensitiveAction {
  readonly action: string;
  readonly target: string;
  readonly reason: string;
  readonly expectedEffect: string;
}

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

export function coreCapabilitiesForScope(scope: "unscoped" | "project"): readonly string[] {
  return scope === "project"
    ? ["capability_request", "material_recall", "project_state_recall", "memory_recall"]
    : ["capability_request", "material_recall", "memory_recall"];
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
  replaceExisting: z.boolean().default(false)
});

export function createTextOutputCapability(store: TextOutputStore): CapabilityDefinition<z.infer<typeof textOutputInputSchema>> {
  return {
    metadata: {
      id: "output.write_text",
      version: "1.0.0",
      label: "Write text output",
      description: "Create a UTF-8 text deliverable in the Thread's authorized Output Location.",
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
          replaceExisting: { type: "boolean" }
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

const capabilityRequestInputSchema = z.object({
  need: z.string().trim().min(1).max(1_000),
  capabilityId: z.string().trim().min(1).max(200).optional()
});

export function createCapabilityBroker(
  resolve: (input: z.infer<typeof capabilityRequestInputSchema>, context: CapabilityExecutionContext) => readonly string[]
): CapabilityDefinition<z.infer<typeof capabilityRequestInputSchema>> {
  return {
    metadata: {
      id: "capability_request", version: "1.0.0", label: "Request capability",
      description: "Request an allowed task capability for the current Turn. This does not execute it or grant permission.",
      activationClass: "ordinary_task", sideEffectClass: "none", allowedScopes: ["unscoped", "project"], executor: "host", modelCallable: true,
      inputSchema: { type: "object", properties: { need: { type: "string" }, capabilityId: { type: "string" } }, required: ["need"] },
      outputSchema: { type: "object", properties: { activatedCapabilities: { type: "array", items: { type: "string" } } }, required: ["activatedCapabilities"] }
    },
    inputSchema: capabilityRequestInputSchema,
    inspect: () => undefined,
    async execute(input, context) {
      const activatedCapabilities = [...resolve(input, context)];
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
  };
}

const materialRecallInputSchema = z.object({
  disclosureLevel: z.enum(["cards", "outline", "excerpt", "full"]),
  materialId: z.string().uuid().optional(),
  blockIds: z.array(z.string().min(1)).max(24).optional(),
  query: z.string().max(500).optional(),
  maxItems: z.number().int().min(1).max(12).default(8),
  maxChars: z.number().int().min(500).max(12_000).default(8_000)
});

export function createMaterialRecallCapability(
  recall: (input: z.infer<typeof materialRecallInputSchema>, context: CapabilityExecutionContext) => Promise<{ body: string; retrieval: NonNullable<CapabilityExecutionResult["retrieval"]> }>
): CapabilityDefinition<z.infer<typeof materialRecallInputSchema>> {
  return {
    metadata: {
      id: "material_recall", version: "1.0.0", label: "Recall material",
      description: "Inspect scoped Material cards, outlines, or bounded source-referenced blocks. Expand progressively and respect omitted-content warnings.",
      activationClass: "ordinary_task", sideEffectClass: "local_read", allowedScopes: ["unscoped", "project"], executor: "host", modelCallable: true,
      inputSchema: { type: "object", properties: { disclosureLevel: { enum: ["cards", "outline", "excerpt", "full"] }, materialId: { type: "string" }, blockIds: { type: "array", items: { type: "string" } }, query: { type: "string" }, maxItems: { type: "integer" }, maxChars: { type: "integer" } }, required: ["disclosureLevel"] },
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

const projectStateRecallInputSchema = z.object({
  source: z.enum(["project_context", "project_memory"]).default("project_context"),
  sectionIds: z.array(z.string().trim().min(1).max(100)).max(6).optional(),
  query: z.string().trim().max(500).optional(),
  maxItems: z.number().int().min(1).max(6).default(6),
  maxChars: z.number().int().min(500).max(8_000).default(6_000)
});

export function createProjectStateRecallCapability(
  recall: (input: z.infer<typeof projectStateRecallInputSchema>, context: CapabilityExecutionContext) => Promise<{ body: string; retrieval: NonNullable<CapabilityExecutionResult["retrieval"]> }>
): CapabilityDefinition<z.infer<typeof projectStateRecallInputSchema>> {
  return {
    metadata: {
      id: "project_state_recall", version: "1.0.0", label: "Recall project state",
      description: "Recall bounded, separately labelled sections from Project Context or Project Memory without loading Materials or other source classes.",
      activationClass: "ordinary_task", sideEffectClass: "local_read", allowedScopes: ["project"], executor: "host", modelCallable: true,
      inputSchema: { type: "object", properties: { source: { enum: ["project_context", "project_memory"] }, sectionIds: { type: "array", items: { type: "string" } }, query: { type: "string" }, maxItems: { type: "integer" }, maxChars: { type: "integer" } } },
      outputSchema: { type: "object", properties: { sourceClass: { const: "project_state" }, disclosureLevel: { const: "sections" }, items: { type: "array" }, complete: { type: "boolean" }, omittedItems: { type: "integer" }, warnings: { type: "array" }, contextReference: { type: "object" } }, required: ["sourceClass", "items", "warnings", "contextReference"] }
    },
    inputSchema: projectStateRecallInputSchema,
    inspect: () => undefined,
    async execute(input, context) {
      if (input.source === "project_memory") {
        return { schemaVersion: 1, requestId: context.request.requestId, status: "failed", code: "RECALL_SOURCE_UNAVAILABLE", content: "Project Memory is not implemented yet; no data was loaded." };
      }
      const recalled = await recall(input, context);
      return { schemaVersion: 1, requestId: context.request.requestId, status: "completed", content: recalled.body, retrieval: recalled.retrieval };
    }
  };
}

export function createUnavailableCoreRecallCapability(id: "project_state_recall" | "memory_recall", allowedScopes: Array<"unscoped" | "project">): CapabilityDefinition {
  return {
    metadata: {
      id, version: "1.0.0", label: id === "memory_recall" ? "Recall memory" : "Recall project state",
      description: `${id} is a fixed core surface whose source implementation is not available in this slice.`,
      activationClass: "ordinary_task", sideEffectClass: "local_read", allowedScopes, executor: "host", modelCallable: true,
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      outputSchema: { type: "object", properties: { status: { const: "unavailable" } }, required: ["status"] }
    },
    inputSchema: z.object({ query: z.string().max(500).optional() }),
    inspect: () => undefined,
    async execute(_input, context) {
      return { schemaVersion: 1, requestId: context.request.requestId, status: "failed", code: "RECALL_SOURCE_UNAVAILABLE", content: `${id} is not implemented yet; no data was loaded.` };
    }
  };
}

const webSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  maxResults: z.number().int().min(1).max(6).default(6),
  maxChars: z.number().int().min(500).max(8_000).default(6_000)
});
const webFetchInputSchema = z.object({
  url: z.string().url().max(2_000).refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
    } catch { return false; }
  }, "Only unauthenticated public HTTP(S) URLs are allowed."),
  maxChars: z.number().int().min(500).max(8_000).default(6_000)
});

type WebCapabilityResult = Promise<{ body: string; retrieval: NonNullable<CapabilityExecutionResult["retrieval"]> }>;

export function createWebSearchCapability(
  search: (input: z.infer<typeof webSearchInputSchema>, context: CapabilityExecutionContext) => WebCapabilityResult
): CapabilityDefinition<z.infer<typeof webSearchInputSchema>> {
  return {
    metadata: {
      id: "web_search", version: "1.0.0", label: "Search public web",
      description: "Search the current public web without login, browser state, writes, or durable snapshots.",
      activationClass: "ordinary_task", sideEffectClass: "network_read", allowedScopes: ["unscoped", "project"], executor: "host", modelCallable: true,
      inputSchema: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "integer" }, maxChars: { type: "integer" } }, required: ["query"] },
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
      activationClass: "ordinary_task", sideEffectClass: "network_read", allowedScopes: ["unscoped", "project"], executor: "host", modelCallable: true,
      inputSchema: { type: "object", properties: { url: { type: "string" }, maxChars: { type: "integer" } }, required: ["url"] },
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
