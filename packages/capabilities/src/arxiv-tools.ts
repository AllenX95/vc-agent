import { join } from "node:path";
import { z } from "zod";
import type { CapabilityDefinition, CapabilityExecutionContext, SensitiveAction } from "./index.js";
import { WorkspaceWriteStore, type WorkspaceWriteFile } from "./workspace-tools.js";

export const ARXIV_BUNDLE_FILES = ["paper.html", "paper.pdf", "paper.md", "metadata.json"] as const;
export const MAX_ARXIV_BUNDLE_BYTES = 125 * 1024 * 1024;

export interface ArxivFulltextArchiveFile {
  readonly path: (typeof ARXIV_BUNDLE_FILES)[number];
  readonly body: Uint8Array;
  readonly mediaType: string;
}

export interface ArxivFulltextArchiveResult {
  readonly paperId: string;
  readonly source: "html" | "ar5iv_html" | "pdf";
  readonly sourceUrl: string;
  readonly warnings: readonly string[];
  readonly files: readonly ArxivFulltextArchiveFile[];
}

export interface ArxivFulltextClient {
  archive(input: { readonly identifier: string; readonly allowAr5iv: boolean; readonly force: boolean }): Promise<ArxivFulltextArchiveResult>;
}

const arxivFulltextInputSchema = z.object({
  identifier: z.string().trim().min(1).max(500),
  path: z.string().trim().min(1).max(500).default("papers"),
  allowAr5iv: z.boolean().default(false),
  force: z.boolean().default(false),
  sourceReferences: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  warnings: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  skillId: z.string().trim().min(1).max(200).optional()
});

export function createArxivFulltextCapability(
  store: WorkspaceWriteStore,
  client: ArxivFulltextClient
): CapabilityDefinition<z.infer<typeof arxivFulltextInputSchema>> {
  return {
    metadata: {
      id: "arxiv.fulltext",
      version: "1.0.0",
      label: "Archive ArXiv full text",
      description: "Use the Host-owned ArXiv HTML-first workflow to retain paper.html or paper.pdf, readable paper.md, and metadata.json below the authorized Output Location. Standard Access requires one scoped approval before the network and writes.",
      useWhen: "Use when the User explicitly asks to download, archive, or retain an ArXiv paper locally, especially the complete HTML/PDF/text bundle.",
      tier: "preconditioned",
      activationClass: "preconditioned_execution",
      sideEffectClass: "local_write",
      allowedScopes: ["unscoped", "project"],
      executor: "host",
      modelCallable: true,
      inputSchema: {
        type: "object",
        properties: {
          identifier: { type: "string", description: "ArXiv ID or arxiv.org URL; preserve an explicit version" },
          path: { type: "string", description: "Relative directory inside the authorized Output Location" },
          allowAr5iv: { type: "boolean" },
          force: { type: "boolean", description: "Explicitly replace an existing bundle" },
          sourceReferences: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } },
          skillId: { type: "string" }
        },
        required: ["identifier"]
      },
      outputSchema: {
        type: "object",
        properties: { destination: { type: "string" }, source: { type: "string" }, files: { type: "array", items: { type: "string" } } },
        required: ["destination", "source", "files"]
      }
    },
    inputSchema: arxivFulltextInputSchema,
    inspect(input, context): SensitiveAction {
      if (context.outputLocation === undefined) throw new Error("Output Location is not configured");
      assertUserOutputPath(input.path, context);
      const bundleDirectory = join(input.path, safeArxivDirectoryName(input.identifier));
      const target = store.resolveTarget(context.outputLocation, bundleDirectory);
      const existing = ARXIV_BUNDLE_FILES.filter((file) => store.targetExists(context.outputLocation!, join(bundleDirectory, file)));
      if (existing.length > 0 && !input.force) throw new Error(`ArXiv bundle already exists (${existing.join(", ")}); set force=true only when replacement is intended.`);
      return {
        decisionClass: "G3",
        action: existing.length > 0 ? "Replace ArXiv full-text bundle" : "Archive ArXiv full-text bundle",
        target,
        reason: existing.length > 0 ? "The User explicitly requested replacement of an existing ArXiv archive." : "The User explicitly requested a local ArXiv archive.",
        expectedEffect: "After approval, use the Host-owned HTML-first workflow, retain the original HTML or PDF, derive bounded readable text, and write metadata atomically below the authorized folder.",
        preview: `Identifier: ${input.identifier}\nDestination: ${target}\nExpected files: ${ARXIV_BUNDLE_FILES.join(", ")}\nExisting files: ${existing.length === 0 ? "none" : existing.join(", ")}\nAr5iv fallback: ${input.allowAr5iv ? "enabled" : "disabled"}`
      };
    },
    async execute(input, context) {
      if (context.outputLocation === undefined) throw new Error("Output Location is not configured");
      assertUserOutputPath(input.path, context);
      const archived = await client.archive({ identifier: input.identifier, allowAr5iv: input.allowAr5iv, force: input.force });
      const files = normalizeArchiveFiles(archived.files, join(input.path, safeArxivDirectoryName(archived.paperId)));
      const totalBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
      if (totalBytes > MAX_ARXIV_BUNDLE_BYTES) {
        throw new Error(`ArXiv archive exceeds the bounded write limit of ${MAX_ARXIV_BUNDLE_BYTES} bytes.`);
      }
      const artifact = store.commitBatch({
        requestId: context.request.requestId,
        outputLocation: context.outputLocation,
        files,
        producer: { type: context.request.actor.actorType === "sub_agent" ? "sub_agent" : "agent", id: context.request.actor.actorId },
        threadId: context.request.threadId,
        turnId: context.request.turnId,
        allowReplace: context.accessMode === "full" || context.sensitiveActionApproved === true
      });
      const warningText = archived.warnings.length === 0 ? "" : ` Warnings: ${archived.warnings.join("; ")}`;
      return {
        schemaVersion: 1,
        requestId: context.request.requestId,
        status: "completed",
        content: `Archived ArXiv ${archived.paperId} via ${archived.source} from ${archived.sourceUrl} to ${context.outputLocation}/${input.path}: ${files.map((file) => file.relativePath).join(", ")}.${warningText}`,
        artifact
      };
    }
  };
}

function normalizeArchiveFiles(files: readonly ArxivFulltextArchiveFile[], directory: string): WorkspaceWriteFile[] {
  if (files.length === 0) throw new Error("ArXiv archive produced no files.");
  const seen = new Set<string>();
  const normalized = [...files].sort((left, right) => Number(right.path === "metadata.json") - Number(left.path === "metadata.json")).map((file) => {
    if (!ARXIV_BUNDLE_FILES.includes(file.path) || seen.has(file.path)) throw new Error(`ArXiv archive returned an invalid or duplicate file: ${file.path}`);
    seen.add(file.path);
    if (file.body.byteLength === 0) throw new Error(`ArXiv archive returned an empty file: ${file.path}`);
    return { relativePath: join(directory, file.path), bytes: file.body, mediaType: file.mediaType };
  });
  if (!seen.has("metadata.json")) throw new Error("ArXiv archive did not produce metadata.json.");
  return normalized;
}

function safeArxivDirectoryName(value: string): string {
  let normalized = value.trim().replace(/^arxiv:/iu, "");
  normalized = normalized.replace(/^https?:\/\/[^/]+\/(?:abs|pdf|html)\//iu, "");
  normalized = normalized.replace(/\.pdf$/iu, "").replace(/^\/+|\/+$/gu, "");
  const safe = normalized.replace(/\//gu, "-").replace(/[^A-Za-z0-9._-]/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "");
  if (safe.length === 0) throw new Error("The ArXiv identifier cannot produce a safe output directory.");
  return safe;
}

function assertUserOutputPath(path: string, context: CapabilityExecutionContext): void {
  if (context.request.scope.kind !== "project") return;
  const topLevel = path.replace(/\\/gu, "/").split("/")[0]?.toLocaleLowerCase();
  if (topLevel === "system" || topLevel === "parsed") throw new Error(`outputs/${topLevel} is reserved for system-managed artifacts.`);
}
