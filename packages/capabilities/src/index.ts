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
