import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import {
  projectCommandInvocationSchema,
  type ArtifactRecord,
  type ProjectCommandInvocation
} from "@vc-agent/contracts";
import type { CapabilityDefinition, CapabilityExecutionContext, SensitiveAction } from "./index.js";

interface TextOutputCommitStore {
  resolveTarget(outputLocation: string, relativePath: string): string;
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
  }): ArtifactRecord;
}

const editOperationSchema = z.object({
  oldText: z.string().min(1).max(1_000_000),
  newText: z.string().max(1_000_000),
  reason: z.string().trim().min(1).max(500)
});

const textEditInputSchema = z.object({
  path: z.string().trim().min(1).max(500),
  operations: z.array(editOperationSchema).min(1).max(50),
  mediaType: z.string().trim().min(1).max(200).default("text/plain; charset=utf-8"),
  sourceReferences: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  warnings: z.array(z.string().trim().min(1).max(500)).max(50).default([])
});

interface PendingTextEdit {
  readonly target: string;
  readonly contentHash: string;
  readonly proposedContent: string;
  readonly preview: string;
  readonly createdAtMs: number;
}

export function createTextEditCapability(
  store: TextOutputCommitStore
): CapabilityDefinition<z.infer<typeof textEditInputSchema>> {
  const pending = new Map<string, PendingTextEdit>();
  return {
    metadata: {
      id: "output.edit_text",
      version: "1.0.0",
      label: "Edit text Output",
      description: "Propose exact replacements in an existing text or Markdown Output. The Host shows a bounded diff and applies it only after confirmation.",
      useWhen: "Use only when the User asks to modify an existing text or Markdown Output.",
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
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                oldText: { type: "string" },
                newText: { type: "string" },
                reason: { type: "string" }
              },
              required: ["oldText", "newText", "reason"]
            }
          },
          mediaType: { type: "string" },
          sourceReferences: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } }
        },
        required: ["path", "operations"]
      },
      outputSchema: {
        type: "object",
        properties: { artifactId: { type: "string" }, destination: { type: "string" }, mediaType: { type: "string" } },
        required: ["artifactId", "destination", "mediaType"]
      }
    },
    inputSchema: textEditInputSchema,
    inspect(input, context): SensitiveAction {
      const proposal = prepareTextEdit(store, input, context);
      prunePendingEdits(pending);
      pending.set(context.request.requestId, proposal);
      return {
        action: "Apply text Output edit",
        target: proposal.target,
        reason: input.operations.map((operation) => operation.reason).join("; ").slice(0, 2_000),
        expectedEffect: "The approved replacements will be applied atomically only if the file still matches this preview.",
        preview: proposal.preview
      };
    },
    async execute(input, context) {
      const proposal = pending.get(context.request.requestId) ?? prepareTextEdit(store, input, context);
      pending.delete(context.request.requestId);
      const current = readBoundedText(proposal.target);
      if (contentHash(current) !== proposal.contentHash) {
        throw new Error("The Output changed after the edit preview. Review the current file and create a new edit proposal.");
      }
      const artifact = store.commit({
        requestId: context.request.requestId,
        outputLocation: requireOutputLocation(context),
        relativePath: input.path,
        content: proposal.proposedContent,
        mediaType: input.mediaType,
        producer: {
          type: context.request.actor.actorType === "sub_agent" ? "sub_agent" : "agent",
          id: context.request.actor.actorId
        },
        threadId: context.request.threadId,
        turnId: context.request.turnId,
        allowReplace: true
      });
      return {
        schemaVersion: 1,
        requestId: context.request.requestId,
        status: "completed",
        content: `Edited ${artifact.mediaType} Output at ${artifact.destination}`,
        artifact
      };
    }
  };
}

function prepareTextEdit(
  store: TextOutputCommitStore,
  input: z.infer<typeof textEditInputSchema>,
  context: CapabilityExecutionContext
): PendingTextEdit {
  const target = store.resolveTarget(requireOutputLocation(context), input.path);
  const original = readBoundedText(target);
  let proposed = original;
  const previewParts: string[] = [];
  for (const operation of input.operations) {
    const matches = proposed.split(operation.oldText).length - 1;
    if (matches !== 1) {
      throw new Error(`Each edit oldText must match exactly once; found ${matches} matches.`);
    }
    proposed = proposed.replace(operation.oldText, operation.newText);
    previewParts.push(
      `@@ ${operation.reason} @@`,
      ...operation.oldText.split(/\r?\n/u).map((line) => `-${line}`),
      ...operation.newText.split(/\r?\n/u).map((line) => `+${line}`)
    );
  }
  return {
    target,
    contentHash: contentHash(original),
    proposedContent: proposed,
    preview: previewParts.join("\n").slice(0, 20_000),
    createdAtMs: Date.now()
  };
}

function prunePendingEdits(pending: Map<string, PendingTextEdit>): void {
  const cutoff = Date.now() - 30 * 60 * 1_000;
  for (const [requestId, proposal] of pending) {
    if (proposal.createdAtMs < cutoff) pending.delete(requestId);
  }
}

function readBoundedText(path: string): string {
  if (statSync(path).size > 5 * 1024 * 1024) throw new Error("Text Output exceeds the editable size limit.");
  const content = readFileSync(path, "utf8");
  if (content.includes("\0")) throw new Error("The selected Output is not a UTF-8 text file.");
  return content;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function requireOutputLocation(context: CapabilityExecutionContext): string {
  if (context.outputLocation === undefined) throw new Error("Output Location is not configured");
  return context.outputLocation;
}

export interface ProjectCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProjectCommandExecutor {
  run(input: {
    readonly projectRoot: string;
    readonly invocation: ProjectCommandInvocation;
  }): Promise<ProjectCommandResult>;
}

export function createProjectCommandCapability(
  executor: ProjectCommandExecutor
): CapabilityDefinition<ProjectCommandInvocation> {
  return {
    metadata: {
      id: "project.command",
      version: "1.0.0",
      label: "Run read-only Project command",
      description: "Run one structured, allowlisted, read-only command inside the active Project. This cannot invoke a shell or replace OCR, PDF, or Office integrations.",
      useWhen: "Use for bounded text search, read-only Git inspection, or PDF metadata when the dedicated Project and material tools are insufficient.",
      tier: "on_demand",
      activationClass: "ordinary_task",
      sideEffectClass: "local_read",
      allowedScopes: ["project"],
      executor: "utility",
      modelCallable: true,
      inputSchema: {
        oneOf: [
          { type: "object", properties: { program: { const: "rg" }, query: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, ignoreCase: { type: "boolean" } }, required: ["program", "query"] },
          { type: "object", properties: { program: { const: "git" }, operation: { enum: ["status", "diff", "log"] }, path: { type: "string" }, maxCount: { type: "number" } }, required: ["program", "operation"] },
          { type: "object", properties: { program: { const: "pdfinfo" }, path: { type: "string" } }, required: ["program", "path"] }
        ]
      },
      outputSchema: {
        type: "object",
        properties: { exitCode: { type: "number" }, stdout: { type: "string" }, stderr: { type: "string" } },
        required: ["exitCode", "stdout", "stderr"]
      }
    },
    inputSchema: projectCommandInvocationSchema,
    inspect: () => undefined,
    async execute(input, context) {
      if (context.projectRoot === undefined || context.request.scope.kind !== "project") {
        throw new Error("A Project root is required for command execution.");
      }
      const result = await executor.run({ projectRoot: context.projectRoot, invocation: input });
      const successful = result.exitCode === 0 || (input.program === "rg" && result.exitCode === 1);
      return {
        schemaVersion: 1,
        requestId: context.request.requestId,
        status: successful ? "completed" : "failed",
        ...(successful ? {} : { code: "PROJECT_COMMAND_FAILED" }),
        content: JSON.stringify(result).slice(0, 20_000)
      };
    }
  };
}
