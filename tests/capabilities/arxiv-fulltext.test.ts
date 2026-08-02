import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityExecutionRequest } from "@vc-agent/contracts";
import { CapabilityGateway } from "@vc-agent/host-services";
import { CapabilityRegistry, WorkspaceWriteStore, createArxivFulltextCapability, type ArxivFulltextClient } from "@vc-agent/capabilities";

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
    capabilityId: "arxiv.fulltext",
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
    activeCapabilityIds: ["arxiv.fulltext"],
    outputIntent: true,
    outputLocation
  };
}

describe("arxiv.fulltext capability", () => {
  it("asks for approval before materializing the HTML-first bundle", async () => {
    const outputLocation = mkdtempSync(join(tmpdir(), "vc-agent-arxiv-fulltext-"));
    temporaryDirectories.push(outputLocation);
    const client: ArxivFulltextClient = {
      archive: async () => ({
        paperId: "2605.13779",
        source: "html",
        sourceUrl: "https://arxiv.org/html/2605.13779",
        warnings: [],
        files: [
          { path: "paper.html", body: new TextEncoder().encode("<article>paper</article>"), mediaType: "text/html" },
          { path: "paper.md", body: new TextEncoder().encode("# paper\n"), mediaType: "text/markdown" },
          { path: "metadata.json", body: new TextEncoder().encode("{\"source\":\"html\"}\n"), mediaType: "application/json" }
        ]
      })
    };
    const registry = new CapabilityRegistry();
    registry.register(createArxivFulltextCapability(new WorkspaceWriteStore(), client));
    const gateway = new CapabilityGateway(registry);
    const executionRequest = request({ identifier: "2605.13779", path: "papers" });

    const decision = await gateway.request(executionRequest, authorization(outputLocation));
    expect(decision).toMatchObject({ type: "confirmation_required", proposal: { decisionClass: "G3", action: "Archive ArXiv full-text bundle" } });
    expect(readdirSync(outputLocation)).toEqual([]);

    const result = await gateway.resolve(executionRequest.requestId, true, authorization(outputLocation));
    expect(result).toMatchObject({ status: "completed", artifact: { mediaType: "application/json" }, content: expect.stringContaining("https://arxiv.org/html/2605.13779") });
    expect(readFileSync(join(outputLocation, "papers/2605.13779/paper.html"), "utf8")).toContain("paper");
    expect(readFileSync(join(outputLocation, "papers/2605.13779/metadata.json"), "utf8")).toContain("html");
  });
});
