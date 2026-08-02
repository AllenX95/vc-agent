import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityExecutionRequest } from "@vc-agent/contracts";
import {
  BinaryOutputStore,
  CapabilityRegistry,
  createFileDownloadCapability,
  type FileDownloadClient
} from "@vc-agent/capabilities";
import { CapabilityGateway } from "@vc-agent/host-services";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function request(arguments_: Record<string, unknown>): CapabilityExecutionRequest {
  return {
    schemaVersion: 1,
    requestId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    threadId: "thread-1",
    turnId: "turn-1",
    toolCallId: "tool-1",
    capabilityId: "file_download",
    scope: { kind: "unscoped", threadId: "thread-1" },
    arguments: arguments_,
    expectedStateVersion: 1,
    actor: { actorType: "agent", actorId: "primary-agent" },
    provenance: { producerType: "agent", producerId: "primary-agent" }
  };
}

function authorization(outputLocation: string) {
  return {
    accessMode: "standard" as const,
    scope: "unscoped" as const,
    stateVersion: 1,
    activeCapabilityIds: ["file_download"],
    outputIntent: true,
    outputLocation
  };
}

describe("file_download capability", () => {
  it("waits for scoped User approval before fetching or writing a file", async () => {
    const outputLocation = mkdtempSync(join(tmpdir(), "vc-agent-download-"));
    temporaryDirectories.push(outputLocation);
    const calls: string[] = [];
    const client: FileDownloadClient = {
      download: async ({ url }) => {
        calls.push(url);
        return { body: new TextEncoder().encode("PDF bytes"), sourceUrl: url, mediaType: "application/pdf" };
      }
    };
    const registry = new CapabilityRegistry();
    registry.register(createFileDownloadCapability(new BinaryOutputStore(), client));
    const gateway = new CapabilityGateway(registry);
    const executionRequest = request({ url: "https://arxiv.org/pdf/2605.13779", path: "papers/2605.13779.pdf" });

    const decision = await gateway.request(executionRequest, authorization(outputLocation));
    expect(decision).toMatchObject({
      type: "confirmation_required",
      proposal: {
        capabilityId: "file_download",
        decisionClass: "G3",
        target: join(outputLocation, "papers/2605.13779.pdf"),
        preview: expect.stringContaining("https://arxiv.org/pdf/2605.13779")
      }
    });
    expect(calls).toEqual([]);
    expect(readdirSync(outputLocation)).toEqual([]);

    const result = await gateway.resolve(executionRequest.requestId, true, authorization(outputLocation));
    expect(result).toMatchObject({ status: "completed", artifact: { mediaType: "application/pdf", destination: join(outputLocation, "papers/2605.13779.pdf") } });
    expect(calls).toEqual(["https://arxiv.org/pdf/2605.13779"]);
    expect(readFileSync(join(outputLocation, "papers/2605.13779.pdf"), "utf8")).toBe("PDF bytes");
    expect(readdirSync(join(outputLocation, "papers")).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });

  it("rejects non-public URLs and paths outside the authorized Output Location", async () => {
    const outputLocation = mkdtempSync(join(tmpdir(), "vc-agent-download-validation-"));
    temporaryDirectories.push(outputLocation);
    let calls = 0;
    const registry = new CapabilityRegistry();
    registry.register(createFileDownloadCapability(new BinaryOutputStore(), {
      download: async () => {
        calls += 1;
        return { body: new Uint8Array([1]), sourceUrl: "https://example.com/file.bin" };
      }
    }));
    const gateway = new CapabilityGateway(registry);

    const invalidUrl = await gateway.request(request({ url: "file:///secret.txt", path: "secret.txt" }), authorization(outputLocation));
    expect(invalidUrl).toMatchObject({ type: "result", result: { status: "failed", code: "INVALID_CAPABILITY_ARGUMENTS" } });
    const privateUrl = await gateway.request(request({ url: "http://127.0.0.1:8080/secret", path: "secret.txt" }), authorization(outputLocation));
    expect(privateUrl).toMatchObject({ type: "result", result: { status: "failed", code: "INVALID_CAPABILITY_ARGUMENTS" } });
    const invalidPathRequest = request({ url: "https://example.com/file.bin", path: "../outside.bin" });
    const invalidPath = await gateway.request(invalidPathRequest, authorization(outputLocation));
    expect(invalidPath).toMatchObject({ type: "result", result: { status: "failed", code: "CAPABILITY_PRECONDITION_FAILED" } });
    expect(calls).toBe(0);
  });

  it("keeps the existing Output collision policy under Standard Access", async () => {
    const outputLocation = mkdtempSync(join(tmpdir(), "vc-agent-download-collision-"));
    temporaryDirectories.push(outputLocation);
    writeFileSync(join(outputLocation, "paper.pdf"), "old", "utf8");
    const registry = new CapabilityRegistry();
    registry.register(createFileDownloadCapability(new BinaryOutputStore(), {
      download: async () => ({ body: new TextEncoder().encode("new"), sourceUrl: "https://example.com/paper.pdf", mediaType: "application/pdf" })
    }));
    const gateway = new CapabilityGateway(registry);
    const executionRequest = request({ url: "https://example.com/paper.pdf", path: "paper.pdf" });

    expect(await gateway.request(executionRequest, authorization(outputLocation))).toMatchObject({ type: "confirmation_required", proposal: { action: "Replace downloaded file" } });
    expect(readFileSync(join(outputLocation, "paper.pdf"), "utf8")).toBe("old");
    expect(await gateway.resolve(executionRequest.requestId, false, authorization(outputLocation))).toMatchObject({ status: "rejected", code: "USER_REJECTED" });
    expect(readFileSync(join(outputLocation, "paper.pdf"), "utf8")).toBe("old");
  });
});
