import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityExecutionRequest } from "@vc-agent/contracts";
import {
  CapabilityRegistry,
  TextOutputStore,
  createTextEditCapability
} from "@vc-agent/capabilities";
import { CapabilityGateway } from "@vc-agent/host-services";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function projectFixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "vc-agent-controlled-tools-"));
  temporaryDirectories.push(projectRoot);
  const outputLocation = join(projectRoot, "outputs");
  mkdirSync(outputLocation);
  return { projectRoot, outputLocation };
}

function request(capabilityId: string, arguments_: Record<string, unknown>): CapabilityExecutionRequest {
  return {
    schemaVersion: 1,
    requestId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    threadId: "thread-1",
    turnId: "turn-1",
    toolCallId: crypto.randomUUID(),
    capabilityId,
    scope: { kind: "project", projectId: crypto.randomUUID() },
    arguments: arguments_,
    expectedStateVersion: 3,
    actor: { actorType: "agent", actorId: "primary-agent" },
    provenance: { producerType: "agent", producerId: "primary-agent" }
  };
}

function authorization(projectRoot: string, outputLocation: string, activeCapabilityIds: string[]) {
  return {
    accessMode: "standard" as const,
    scope: "project" as const,
    stateVersion: 3,
    activeCapabilityIds,
    outputIntent: true,
    projectRoot,
    outputLocation
  };
}

describe("controlled Project tools", () => {
  it("previews an exact text edit, waits for confirmation, then registers the replacement Artifact", async () => {
    const { projectRoot, outputLocation } = projectFixture();
    writeFileSync(join(outputLocation, "memo.md"), "# Memo\n\nOld risk.\n");
    const registry = new CapabilityRegistry();
    registry.register(createTextEditCapability(new TextOutputStore()));
    const gateway = new CapabilityGateway(registry);
    const executionRequest = request("output.edit_text", {
      path: "memo.md",
      operations: [{ oldText: "Old risk.", newText: "Updated execution risk.", reason: "Reflect the latest judgment." }],
      mediaType: "text/markdown"
    });
    const auth = authorization(projectRoot, outputLocation, ["output.edit_text"]);

    const decision = await gateway.request(executionRequest, auth);
    expect(decision).toMatchObject({
      type: "confirmation_required",
      proposal: {
        action: "Apply text Output edit",
        target: join(outputLocation, "memo.md"),
        preview: expect.stringContaining("-Old risk.")
      }
    });
    expect(readFileSync(join(outputLocation, "memo.md"), "utf8")).toContain("Old risk.");

    const result = await gateway.resolve(executionRequest.requestId, true, auth);
    expect(result).toMatchObject({ status: "completed", artifact: { destination: join(outputLocation, "memo.md") } });
    expect(readFileSync(join(outputLocation, "memo.md"), "utf8")).toContain("Updated execution risk.");
  });

  it("rejects an approved edit if the Output changed after the preview", async () => {
    const { projectRoot, outputLocation } = projectFixture();
    const target = join(outputLocation, "memo.md");
    writeFileSync(target, "Original text");
    const registry = new CapabilityRegistry();
    registry.register(createTextEditCapability(new TextOutputStore()));
    const gateway = new CapabilityGateway(registry);
    const executionRequest = request("output.edit_text", {
      path: "memo.md",
      operations: [{ oldText: "Original", newText: "Proposed", reason: "Update" }]
    });
    const auth = authorization(projectRoot, outputLocation, ["output.edit_text"]);

    expect(await gateway.request(executionRequest, auth)).toMatchObject({ type: "confirmation_required" });
    writeFileSync(target, "User changed this file");
    const result = await gateway.resolve(executionRequest.requestId, true, auth);

    expect(result).toMatchObject({ status: "failed", code: "CAPABILITY_EXECUTION_FAILED" });
    expect(result.content).toMatch(/changed after the edit preview/i);
    expect(readFileSync(target, "utf8")).toBe("User changed this file");
  });

});
