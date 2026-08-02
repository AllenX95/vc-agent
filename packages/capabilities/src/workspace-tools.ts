import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { z } from "zod";
import type { ArtifactRecord } from "@vc-agent/contracts";
import type { CapabilityDefinition, CapabilityExecutionContext, SensitiveAction } from "./index.js";

export const MAX_WORKSPACE_WRITE_FILES = 100;
export const MAX_WORKSPACE_WRITE_BYTES = 25 * 1024 * 1024;

export interface WorkspaceWriteFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export class WorkspaceWriteStore {
  readonly #maxBytes: number;
  readonly #maxFiles: number;

  constructor(maxBytes = MAX_WORKSPACE_WRITE_BYTES, maxFiles = MAX_WORKSPACE_WRITE_FILES) {
    this.#maxBytes = maxBytes;
    this.#maxFiles = maxFiles;
  }

  resolveTarget(outputLocation: string, relativePath: string): string {
    if (relativePath.trim().length === 0 || relativePath.includes("\0") || isAbsolute(relativePath) || win32.isAbsolute(relativePath) || relativePath.startsWith("\\")) {
      throw new Error("Workspace path must be relative to the authorized Output Location.");
    }
    const root = resolve(outputLocation);
    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("Workspace path escapes the authorized Output Location");
    const rootAnchor = existingPath(root);
    const targetAnchor = existingPath(target);
    if (rootAnchor !== undefined && targetAnchor !== undefined && !isWithin(rootAnchor, targetAnchor)) {
      throw new Error("Workspace path crosses a symbolic link outside the authorized Output Location");
    }
    if (existsSync(target) && rootAnchor !== undefined && !isWithin(rootAnchor, realpathSync(target))) {
      throw new Error("Workspace target resolves outside the authorized Output Location");
    }
    return target;
  }

  targetExists(outputLocation: string, relativePath: string): boolean {
    return existsSync(this.resolveTarget(outputLocation, relativePath));
  }

  commitBatch(input: {
    readonly requestId: string;
    readonly outputLocation: string;
    readonly files: readonly WorkspaceWriteFile[];
    readonly producer: ArtifactRecord["producer"];
    readonly threadId: string;
    readonly turnId: string;
    readonly allowReplace: boolean;
  }): ArtifactRecord {
    if (input.files.length === 0 || input.files.length > this.#maxFiles) throw new Error(`Workspace write must contain 1-${this.#maxFiles} files.`);
    const prepared = input.files.map((file) => {
      if (file.bytes.byteLength === 0) throw new Error(`Workspace file is empty: ${file.relativePath}`);
      const target = this.resolveTarget(input.outputLocation, file.relativePath);
      return { file, target, temporary: resolve(dirname(target), `.vc-agent-${randomUUID()}.partial`) };
    });
    const totalBytes = prepared.reduce((total, item) => total + item.file.bytes.byteLength, 0);
    if (totalBytes > this.#maxBytes) throw new Error(`Workspace write exceeds ${this.#maxBytes} bytes.`);
    const targetKeys = new Set<string>();
    for (const item of prepared) {
      const key = process.platform === "win32" ? item.target.toLowerCase() : item.target;
      if (targetKeys.has(key)) throw new Error(`Workspace write contains duplicate target: ${item.target}`);
      targetKeys.add(key);
      if (existsSync(item.target) && !input.allowReplace) throw new Error(`Output already exists: ${item.target}`);
    }

    try {
      for (const item of prepared) {
        mkdirSync(dirname(item.target), { recursive: true });
        writeFileSync(item.temporary, Buffer.from(item.file.bytes), { flag: "wx" });
        const descriptor = openSync(item.temporary, "r+");
        try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      }
      for (const item of prepared) {
        if (existsSync(item.target)) {
          if (!input.allowReplace) throw new Error(`Output was created while the batch was being prepared: ${item.target}`);
          rmSync(item.target, { force: true });
        }
        renameSync(item.temporary, item.target);
      }
    } finally {
      for (const item of prepared) rmSync(item.temporary, { force: true });
    }

    const first = prepared[0];
    if (first === undefined) throw new Error("Workspace write produced no files.");
    return {
      schemaVersion: 1,
      id: randomUUID(),
      mediaType: first.file.mediaType,
      producer: input.producer,
      destination: first.target,
      source: { threadId: input.threadId, turnId: input.turnId, capabilityRequestId: input.requestId },
      createdAt: new Date().toISOString()
    };
  }
}

const workspaceWriteOperationSchema = z.object({
  path: z.string().trim().min(1).max(500),
  content: z.string().min(1).max(5 * 1024 * 1024),
  mediaType: z.string().trim().min(1).max(200).default("text/plain; charset=utf-8"),
  replaceExisting: z.boolean().default(false)
});

const workspaceWriteInputSchema = z.object({
  directory: z.string().trim().min(1).max(500).default("."),
  operations: z.array(workspaceWriteOperationSchema).min(1).max(MAX_WORKSPACE_WRITE_FILES),
  sourceReferences: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  warnings: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  skillId: z.string().trim().min(1).max(200).optional()
});

export function createWorkspaceWriteCapability(
  store: WorkspaceWriteStore
): CapabilityDefinition<z.infer<typeof workspaceWriteInputSchema>> {
  return {
    metadata: {
      id: "workspace.write_batch",
      version: "1.0.0",
      label: "Write files to Output",
      description: "Create or replace a bounded batch of text files below the current Thread's authorized Output Location. Standard Access shows the folder and file manifest and requires User confirmation.",
      useWhen: "Use when the User explicitly asks to save, archive, or update multiple local files inside the authorized Output Location.",
      tier: "preconditioned",
      activationClass: "preconditioned_execution",
      sideEffectClass: "local_write",
      allowedScopes: ["unscoped", "project"],
      executor: "host",
      modelCallable: true,
      inputSchema: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Relative directory inside the authorized Output Location" },
          operations: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, mediaType: { type: "string" }, replaceExisting: { type: "boolean" } }, required: ["path", "content"] } },
          sourceReferences: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } },
          skillId: { type: "string" }
        },
        required: ["operations"]
      },
      outputSchema: {
        type: "object",
        properties: { destination: { type: "string" }, fileCount: { type: "integer" }, totalBytes: { type: "integer" } },
        required: ["destination", "fileCount", "totalBytes"]
      }
    },
    inputSchema: workspaceWriteInputSchema,
    inspect(input, context): SensitiveAction {
      if (context.outputLocation === undefined) throw new Error("Output Location is not configured");
      const directory = store.resolveTarget(context.outputLocation, input.directory);
      const files = input.operations.map((operation) => {
        const relativePath = join(input.directory, operation.path);
        assertUserOutputPath(relativePath, context);
        const target = store.resolveTarget(context.outputLocation!, relativePath);
        return { operation, relativePath, target, exists: store.targetExists(context.outputLocation!, relativePath), bytes: Buffer.byteLength(operation.content, "utf8") };
      });
      const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
      if (totalBytes > MAX_WORKSPACE_WRITE_BYTES) throw new Error(`Workspace write exceeds ${MAX_WORKSPACE_WRITE_BYTES} bytes.`);
      return {
        decisionClass: "G3",
        action: "Write files to Output",
        target: directory,
        reason: "The User explicitly requested local files to be saved or updated in the authorized folder.",
        expectedEffect: `After approval, write ${files.length} file(s) (${totalBytes} bytes) atomically below the authorized Output Location.`,
        preview: files.map((file) => `${file.operation.replaceExisting || file.exists ? "replace" : "create"}: ${file.target} (${file.bytes} bytes)`).join("\n")
      };
    },
    async execute(input, context) {
      if (context.outputLocation === undefined) throw new Error("Output Location is not configured");
      const files = input.operations.map((operation) => {
        const relativePath = join(input.directory, operation.path);
        assertUserOutputPath(relativePath, context);
        return { relativePath, bytes: new TextEncoder().encode(operation.content), mediaType: operation.mediaType };
      });
      const artifact = store.commitBatch({
        requestId: context.request.requestId,
        outputLocation: context.outputLocation,
        files,
        producer: { type: context.request.actor.actorType === "sub_agent" ? "sub_agent" : "agent", id: context.request.actor.actorId },
        threadId: context.request.threadId,
        turnId: context.request.turnId,
        allowReplace: context.accessMode === "full" || context.sensitiveActionApproved === true
      });
      return {
        schemaVersion: 1,
        requestId: context.request.requestId,
        status: "completed",
        content: `Wrote ${files.length} file(s) to ${context.outputLocation}/${input.directory}.`,
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

function existingPath(path: string): string | undefined {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return realpathSync(current);
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
