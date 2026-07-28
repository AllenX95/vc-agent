import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityExecutionRequest } from "@vc-agent/contracts";
import {
  CapabilityRegistry,
  TextOutputStore,
  UnknownOutcomeError,
  createTextOutputCapability
} from "@vc-agent/capabilities";
import { CapabilityGateway, detectOutputIntent, detectProjectCommandIntent, detectTextEditIntent } from "@vc-agent/host-services";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function outputDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "vc-agent-output-"));
  temporaryDirectories.push(directory);
  return directory;
}

function request(overrides: Partial<CapabilityExecutionRequest> = {}): CapabilityExecutionRequest {
  return {
    schemaVersion: 1,
    requestId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    threadId: "thread-1",
    turnId: "turn-1",
    toolCallId: "tool-1",
    capabilityId: "output.write_text",
    scope: { kind: "unscoped", threadId: "thread-1" },
    arguments: { path: "memo.txt", content: "Investment view", mediaType: "text/plain; charset=utf-8" },
    expectedStateVersion: 2,
    actor: { actorType: "agent", actorId: "primary-agent" },
    provenance: { producerType: "agent", producerId: "primary-agent" },
    ...overrides
  };
}

function authorization(outputLocation: string, overrides: Partial<Parameters<CapabilityGateway["request"]>[1]> = {}) {
  return {
    accessMode: "standard" as const,
    scope: "unscoped" as const,
    stateVersion: 2,
    activeCapabilityIds: ["output.write_text"],
    outputIntent: true,
    outputLocation,
    ...overrides
  };
}

function createGatewayFixture() {
  const registry = new CapabilityRegistry();
  const definition = createTextOutputCapability(new TextOutputStore());
  registry.register(definition);
  return { registry, definition, gateway: new CapabilityGateway(registry) };
}

describe("Capability Gateway", () => {
  it("publishes typed metadata without hard-coding dispatch branches", () => {
    const { registry } = createGatewayFixture();
    expect(registry.inventory()).toMatchObject([{
      id: "output.write_text",
      activationClass: "preconditioned_execution",
      sideEffectClass: "local_write",
      allowedScopes: ["unscoped", "project"],
      executor: "host",
      modelCallable: true
    }]);
  });

  it("detects explicit English and Chinese Output Intent without treating ordinary discussion as a write", () => {
    expect(detectOutputIntent("Create a memo file for this analysis")).toBe(true);
    expect(detectOutputIntent("请生成一份投资报告文档")).toBe(true);
    expect(detectOutputIntent("请生成一个投资 memo")).toBe(true);
    expect(detectOutputIntent("Analyze the company and discuss the risks")).toBe(false);
    expect(detectTextEditIntent("请修改已有的投资报告文件")).toBe(true);
    expect(detectTextEditIntent("Revise the existing memo document")).toBe(true);
    expect(detectProjectCommandIntent("运行 git diff 查看项目变化")).toBe(true);
    expect(detectProjectCommandIntent("Run pdfinfo to inspect PDF metadata")).toBe(true);
  });

  it.each([
    ["CAPABILITY_INACTIVE", { activeCapabilityIds: [] }],
    ["OUTPUT_INTENT_REQUIRED", { outputIntent: false }],
    ["STALE_CAPABILITY_STATE", { stateVersion: 3 }],
    ["SCOPE_REJECTED", { scope: "project" as const }]
  ])("rejects %s before side effects", async (code, override) => {
    const directory = outputDirectory();
    const { gateway } = createGatewayFixture();
    const decision = await gateway.request(request(), authorization(directory, override));
    expect(decision).toMatchObject({ type: "result", result: { status: "failed", code } });
    expect(readdirSync(directory)).toEqual([]);
  });

  it("creates a format-neutral Artifact atomically after authorized Output Intent", async () => {
    const directory = outputDirectory();
    const { gateway } = createGatewayFixture();
    const decision = await gateway.request(request(), authorization(directory));
    expect(decision).toMatchObject({
      type: "result",
      result: {
        status: "completed",
        artifact: { mediaType: "text/plain; charset=utf-8", producer: { type: "agent" } }
      }
    });
    expect(readFileSync(join(directory, "memo.txt"), "utf8")).toBe("Investment view");
    expect(readdirSync(directory).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });

  it("writes a source-referenced Project Output under the determined project outputs directory", async () => {
    const project = outputDirectory();
    const outputLocation = join(project, "outputs");
    const { gateway } = createGatewayFixture();
    const executionRequest = request({
      scope: { kind: "project", projectId: crypto.randomUUID() },
      arguments: { path: "investment-memo.md", content: "# View\n\nFact [material:block-1]\n\nInference: execution risk remains.", mediaType: "text/markdown", sourceReferences: ["material:one/block:block-1@hash", "https://example.com/source"], warnings: ["One inference remains uncertain."] }
    });
    const decision = await gateway.request(executionRequest, authorization(outputLocation, { scope: "project", outputLocation }));
    expect(decision).toMatchObject({ type: "result", result: { status: "completed", artifact: { destination: join(outputLocation, "investment-memo.md"), mediaType: "text/markdown" } } });
    expect(readFileSync(join(outputLocation, "investment-memo.md"), "utf8")).toContain("Inference:");
    expect(JSON.stringify(decision)).not.toMatch(/draft|final/iu);
  });

  it("does not let an ordinary Project Output overwrite reserved system or parsed state", async () => {
    const outputLocation = outputDirectory();
    const { gateway } = createGatewayFixture();
    const executionRequest = request({ scope: { kind: "project", projectId: crypto.randomUUID() }, arguments: { path: "system/project-memory.md", content: "Must not write" } });
    const decision = await gateway.request(executionRequest, authorization(outputLocation, { scope: "project" }));
    expect(decision).toMatchObject({ type: "result", result: { status: "failed", code: "CAPABILITY_PRECONDITION_FAILED" } });
    expect(existsSync(join(outputLocation, "system", "project-memory.md"))).toBe(false);
  });

  it("requires one scoped Standard Access confirmation for replacement", async () => {
    const directory = outputDirectory();
    writeFileSync(join(directory, "memo.txt"), "Old content");
    const { gateway } = createGatewayFixture();
    const executionRequest = request();
    const decision = await gateway.request(executionRequest, authorization(directory));
    expect(decision).toMatchObject({ type: "confirmation_required", proposal: { target: join(directory, "memo.txt") } });
    expect(readFileSync(join(directory, "memo.txt"), "utf8")).toBe("Old content");

    const result = await gateway.resolve(executionRequest.requestId, true, authorization(directory));
    expect(result.status).toBe("completed");
    expect(readFileSync(join(directory, "memo.txt"), "utf8")).toBe("Investment view");
  });

  it("suppresses replacement confirmation in Full Access without hiding the result", async () => {
    const directory = outputDirectory();
    writeFileSync(join(directory, "memo.txt"), "Old content");
    const { gateway } = createGatewayFixture();
    const decision = await gateway.request(request(), authorization(directory, { accessMode: "full" }));
    expect(decision).toMatchObject({ type: "result", result: { status: "completed", artifact: { destination: join(directory, "memo.txt") } } });
    expect(readFileSync(join(directory, "memo.txt"), "utf8")).toBe("Investment view");
  });

  it("marks an unconfirmed non-stageable write Unknown Outcome and invokes it only once", async () => {
    const directory = outputDirectory();
    const { registry, definition } = createGatewayFixture();
    let attempts = 0;
    registry.register({
      ...definition,
      metadata: { ...definition.metadata, id: "external.submit", sideEffectClass: "external_write" },
      inspect: () => ({
        action: "Submit external record",
        target: "external-service",
        reason: "The request writes outside the local Output Location.",
        expectedEffect: "A remote record may be created."
      }),
      execute: async () => {
        attempts += 1;
        throw new UnknownOutcomeError("Submission was dispatched without a confirmed response.");
      }
    });
    const subject = new CapabilityGateway(registry);
    const executionRequest = request({ capabilityId: "external.submit" });
    const auth = authorization(directory, { activeCapabilityIds: ["external.submit"] });
    const decision = await subject.request(
      executionRequest,
      auth
    );
    expect(decision).toMatchObject({ type: "confirmation_required" });
    const result = await subject.resolve(executionRequest.requestId, true, auth);
    expect(result).toMatchObject({ status: "unknown_outcome", code: "UNKNOWN_TOOL_OUTCOME" });
    expect(attempts).toBe(1);
  });

  it("rejects paths outside the selected Output Location", () => {
    const directory = outputDirectory();
    const store = new TextOutputStore();
    expect(() => store.resolveTarget(directory, "../outside.txt")).toThrow("escapes");
    expect(existsSync(join(directory, "outside.txt"))).toBe(false);
  });
});
