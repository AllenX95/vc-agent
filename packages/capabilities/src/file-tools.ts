import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import type { ArtifactRecord } from "@vc-agent/contracts";
import type { CapabilityDefinition, CapabilityExecutionContext, SensitiveAction } from "./index.js";

export const MAX_FILE_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export interface FileDownloadResponse {
  readonly body: Uint8Array;
  readonly sourceUrl: string;
  readonly mediaType?: string;
}

export interface FileDownloadClient {
  download(input: { readonly url: string; readonly maxBytes: number }): Promise<FileDownloadResponse>;
}

/**
 * Public, unauthenticated HTTP(S) transport used by the Host-mediated file
 * download capability. The capability still owns the destination and the
 * Gateway owns the confirmation boundary.
 */
export class FetchFileDownloadClient implements FileDownloadClient {
  async download(input: { readonly url: string; readonly maxBytes: number }): Promise<FileDownloadResponse> {
    let current = parsePublicHttpUrl(input.url);
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      await assertPublicHttpUrl(current);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      try {
        const response = await fetch(current, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          signal: controller.signal,
          headers: { "user-agent": "vc-agent/0.1 file-download" }
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (location === null) throw new Error(`DOWNLOAD_REDIRECT_MISSING:${response.status}`);
          current = parsePublicHttpUrl(new URL(location, current).toString());
          continue;
        }
        if (!response.ok) throw new Error(`DOWNLOAD_HTTP_${response.status}`);
        const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
        if (Number.isFinite(contentLength) && contentLength > input.maxBytes) throw new Error("DOWNLOAD_SIZE_LIMIT_EXCEEDED");

        const body = await readBoundedResponse(response, input.maxBytes);
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
        return {
          body,
          sourceUrl: current.toString(),
          ...(contentType === undefined || contentType.length === 0 ? {} : { mediaType: contentType })
        };
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error("DOWNLOAD_REDIRECT_LIMIT");
  }
}

export class BinaryOutputStore {
  readonly #maxBytes: number;

  constructor(maxBytes = MAX_FILE_DOWNLOAD_BYTES) {
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
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly producer: ArtifactRecord["producer"];
    readonly threadId: string;
    readonly turnId: string;
    readonly allowReplace: boolean;
  }): ArtifactRecord {
    if (input.bytes.byteLength > this.#maxBytes) throw new Error(`File exceeds ${this.#maxBytes} bytes`);
    const target = this.resolveTarget(input.outputLocation, input.relativePath);
    if (existsSync(target) && !input.allowReplace) throw new Error(`Output already exists: ${target}`);
    mkdirSync(dirname(target), { recursive: true });
    const temporary = resolve(dirname(target), `.vc-agent-${randomUUID()}.partial`);
    try {
      writeFileSync(temporary, Buffer.from(input.bytes), { flag: "wx" });
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

const fileDownloadInputSchema = z.object({
  url: z.string().trim().min(1).max(2_000).refine(isPublicHttpUrl, "Only unauthenticated public HTTP(S) URLs are allowed."),
  path: z.string().trim().min(1).max(500),
  mediaType: z.string().trim().min(1).max(200).optional(),
  replaceExisting: z.boolean().default(false),
  sourceReferences: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  warnings: z.array(z.string().trim().min(1).max(500)).max(50).default([])
});

export function createFileDownloadCapability(
  store: BinaryOutputStore,
  client: FileDownloadClient = new FetchFileDownloadClient()
): CapabilityDefinition<z.infer<typeof fileDownloadInputSchema>> {
  return {
    metadata: {
      id: "file_download",
      version: "1.0.0",
      label: "Download file",
      description: "Download one public HTTP(S) file into the current Thread's authorized Output Location. The Host shows the source and destination and requires User confirmation in Standard Access.",
      useWhen: "Use when the User explicitly asks to download or save a public file, PDF, or document locally.",
      tier: "preconditioned",
      activationClass: "preconditioned_execution",
      sideEffectClass: "local_write",
      allowedScopes: ["unscoped", "project"],
      executor: "host",
      modelCallable: true,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri", description: "Unauthenticated public HTTP(S) URL" },
          path: { type: "string", description: "Relative path inside the authorized Output Location" },
          mediaType: { type: "string" },
          replaceExisting: { type: "boolean" },
          sourceReferences: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } }
        },
        required: ["url", "path"]
      },
      outputSchema: {
        type: "object",
        properties: { artifactId: { type: "string" }, destination: { type: "string" }, mediaType: { type: "string" }, bytes: { type: "integer" } },
        required: ["artifactId", "destination", "mediaType", "bytes"]
      }
    },
    inputSchema: fileDownloadInputSchema,
    inspect(input, context): SensitiveAction {
      if (context.outputLocation === undefined) throw new Error("Output Location is not configured");
      assertUserOutputPath(input.path, context);
      const target = store.resolveTarget(context.outputLocation, input.path);
      const replacing = store.targetExists(context.outputLocation, input.path);
      return {
        decisionClass: "G3",
        action: replacing ? "Replace downloaded file" : "Download file to Output",
        target,
        reason: replacing ? "The requested download destination already exists." : "The User explicitly requested a local copy of a public file.",
        expectedEffect: `After approval, download at most ${MAX_FILE_DOWNLOAD_BYTES} bytes and write the file atomically to the authorized Output Location.`,
        preview: `Source URL: ${input.url}\nDestination: ${target}\nExisting file: ${replacing ? "yes (will be replaced)" : "no"}`
      };
    },
    async execute(input, context) {
      if (context.outputLocation === undefined) throw new Error("Output Location is not configured");
      assertUserOutputPath(input.path, context);
      const downloaded = await client.download({ url: input.url, maxBytes: MAX_FILE_DOWNLOAD_BYTES });
      const mediaType = input.mediaType ?? downloaded.mediaType ?? "application/octet-stream";
      const artifact = store.commit({
        requestId: context.request.requestId,
        outputLocation: context.outputLocation,
        relativePath: input.path,
        bytes: downloaded.body,
        mediaType,
        producer: { type: context.request.actor.actorType === "sub_agent" ? "sub_agent" : "agent", id: context.request.actor.actorId },
        threadId: context.request.threadId,
        turnId: context.request.turnId,
        allowReplace: input.replaceExisting || context.accessMode === "full" || context.sensitiveActionApproved === true
      });
      return {
        schemaVersion: 1,
        requestId: context.request.requestId,
        status: "completed",
        content: `Downloaded ${mediaType} to ${artifact.destination} (${downloaded.body.byteLength} bytes)`,
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

function isPublicHttpUrl(value: string): boolean {
  try {
    parsePublicHttpUrl(value);
    return true;
  } catch {
    return false;
  }
}

function parsePublicHttpUrl(value: string): URL {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw new Error("Only unauthenticated public HTTP(S) URLs are allowed.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (hostname === "localhost" || (isIP(hostname) !== 0 && !isPublicAddress(hostname))) {
    throw new Error("The URL must resolve to a public network address.");
  }
  return url;
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw new Error("Only unauthenticated public HTTP(S) URLs are allowed.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const addresses = isIP(hostname) === 0
    ? (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address)
    : [hostname];
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error("The URL must resolve to a public network address.");
  }
}

function isPublicAddress(address: string): boolean {
  if (address.includes(".")) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b, c] = parts as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168)) || (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  const normalized = address.toLowerCase();
  return normalized !== "::" && normalized !== "::1" && !normalized.startsWith("fc") && !normalized.startsWith("fd") && !/^fe[89ab]/u.test(normalized) && !normalized.startsWith("ff") && !normalized.startsWith("2001:db8:");
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxBytes) throw new Error("DOWNLOAD_SIZE_LIMIT_EXCEEDED");
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("DOWNLOAD_SIZE_LIMIT_EXCEEDED");
      }
      chunks.push(new Uint8Array(chunk));
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* the stream may already be closed */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
