import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityExecutionRequest } from "@vc-agent/contracts";
import { CapabilityRegistry, WorkspaceWriteStore, createWorkspaceWriteCapability } from "@vc-agent/capabilities";
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
    capabilityId: "workspace.write_batch",
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
    activeCapabilityIds: ["workspace.write_batch"],
    outputIntent: true,
    outputLocation
  };
}

describe("workspace.write_batch capability", () => {
  it("requires one scoped approval before committing multiple files", async () => {
    const outputLocation = mkdtempSync(join(tmpdir(), "vc-agent-workspace-write-"));
    temporaryDirectories.push(outputLocation);
    const registry = new CapabilityRegistry();
    registry.register(createWorkspaceWriteCapability(new WorkspaceWriteStore()));
    const gateway = new CapabilityGateway(registry);
    const executionRequest = request({
      directory: "papers/2605.13779",
      operations: [
        { path: "paper.md", content: "# ArXiv paper\n", mediaType: "text/markdown" },
        { path: "metadata.json", content: "{\"status\":\"completed\"}\n", mediaType: "application/json" }
      ]
    });

    const decision = await gateway.request(executionRequest, authorization(outputLocation));
    expect(decision).toMatchObject({
      type: "confirmation_required",
      proposal: {
        capabilityId: "workspace.write_batch",
        decisionClass: "G3",
        action: "Write files to Output",
        preview: expect.stringContaining("paper.md")
      }
    });
    expect(readdirSync(outputLocation)).toEqual([]);

    const result = await gateway.resolve(executionRequest.requestId, true, authorization(outputLocation));
    expect(result).toMatchObject({ status: "completed", artifact: { mediaType: "text/markdown" } });
    expect(readFileSync(join(outputLocation, "papers/2605.13779/paper.md"), "utf8")).toBe("# ArXiv paper\n");
    expect(readFileSync(join(outputLocation, "papers/2605.13779/metadata.json"), "utf8")).toContain("completed");
  });
});
