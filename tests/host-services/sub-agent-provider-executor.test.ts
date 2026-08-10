import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { type WorkerCommand, type WorkerEvent } from "@vc-agent/contracts";
import { type SubAgentProviderExecutionInput } from "@vc-agent/host-services";
import { DesktopSubAgentProviderExecutor, providerCapabilityIds } from "../../apps/desktop/src/main/sub-agent-provider-executor.js";

class FakeSupervisor {
  command: Extract<WorkerCommand, { command: "turn.execute" }> | undefined;
  retired: string[] = [];
  resolved: Array<{ result: unknown }> = [];
  async execute(command: Extract<WorkerCommand, { command: "turn.execute" }>): Promise<void> { this.command = command; }
  stop(): void { /* the event is delivered by the test */ }
  resolveCapability(command: { result: unknown }): void { this.resolved.push({ result: command.result }); }
  retire(ownerKey: string): void { this.retired.push(ownerKey); }
}

function input(root: string): SubAgentProviderExecutionInput {
  return {
    attemptId: "33333333-3333-4333-8333-333333333333",
    runId: "11111111-1111-4111-8111-111111111111",
    taskId: "22222222-2222-4222-8222-222222222222",
    parentThreadId: "parent-thread",
    parentTurnId: "parent-turn",
    profile: { profileId: "profile-1", name: "Primary", provider: "fixture", model: "fixture-v1", thinkingLevel: "low" },
    prompt: "isolated prompt",
    contextBoundary: { scope: "unscoped", sourceReferenceIds: ["material:1"], maxChars: 1_000, outputRoot: root },
    capabilitySet: ["read_context", "write_output"],
    outputTarget: join(root, "result.md"),
    signal: new AbortController().signal
  };
}

describe("DesktopSubAgentProviderExecutor", () => {
  it("derives only the allowed Worker tool ids from logical Sub-Agent capabilities", () => {
    expect(providerCapabilityIds(["read_context", "read_materials", "web_research", "write_output"], "project")).toEqual([
      "project_state_recall", "material_recall", "web_search", "web_fetch", "output.write_text"
    ]);
    expect(providerCapabilityIds(["read_context", "write_output"], "unscoped")).toEqual(["output.write_text"]);
  });

  it("dispatches an isolated Worker command and stages bounded output before handoff review", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-provider-executor-"));
    const supervisor = new FakeSupervisor();
    const executor = new DesktopSubAgentProviderExecutor({
      supervisor: supervisor as never,
      root,
      resolveCredential: (profileId) => profileId === "profile-1" ? "secret" : undefined,
      resources: () => ({ schemaVersion: 1, revisionId: "prompt-1", systemPrompt: "VC system", appendSystemPrompt: [] }),
      piResources: () => ({ agentDir: join(root, "pi-agent"), skillsRoot: join(root, "pi-agent", "skills"), mcpConfigPath: join(root, "pi-agent", "mcp.json") })
    });
    const pending = executor.execute(input(root));
    await Promise.resolve();
    expect(supervisor.command?.threadId).toContain("sub-agent-");
    expect(supervisor.command?.contextHistory).toHaveLength(0);
    expect(supervisor.command?.profile.apiKey).toBe("secret");
    const command = supervisor.command!;
    const event: WorkerEvent = {
      schemaVersion: 1,
      correlationId: command.correlationId,
      threadId: command.threadId,
      turnId: command.turnId,
      ownerKey: `unscoped:${command.threadId}`,
      sessionKey: command.threadId,
      workerSequence: 1,
      event: "turn.completed",
      message: "Generated output",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }
    };
    expect(executor.handleEvent(event)).toBe(true);
    const result = await pending;
    expect(result.handoff?.adoptedByParent).toBe(false);
    expect(result.handoff?.outputPath).toBe(join(root, "result.md"));
    expect(existsSync(join(root, "result.md"))).toBe(true);
    expect(readFileSync(join(root, "result.md"), "utf8")).toBe("Generated output");
    expect(supervisor.retired).toEqual([`unscoped:${command.threadId}`]);
  });

  it("preserves only the sanitized Provider failure classification and message", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-provider-executor-failure-"));
    const supervisor = new FakeSupervisor();
    const executor = new DesktopSubAgentProviderExecutor({
      supervisor: supervisor as never,
      root,
      resolveCredential: () => "secret",
      resources: () => ({ schemaVersion: 1, revisionId: "prompt-1", systemPrompt: "VC system", appendSystemPrompt: [] }),
      piResources: () => ({ agentDir: join(root, "pi-agent"), skillsRoot: join(root, "pi-agent", "skills"), mcpConfigPath: join(root, "pi-agent", "mcp.json") })
    });
    const pending = executor.execute(input(root));
    await Promise.resolve();
    const command = supervisor.command!;
    expect(executor.handleEvent({
      schemaVersion: 1,
      correlationId: command.correlationId,
      threadId: command.threadId,
      turnId: command.turnId,
      ownerKey: `unscoped:${command.threadId}`,
      sessionKey: command.threadId,
      workerSequence: 1,
      event: "turn.failed",
      failure: { kind: "provider", code: "MODEL_NOT_FOUND", message: "Configured model is unavailable.", provider: "xiaomi", model: "mimo-v2.5" }
    })).toBe(true);
    await expect(pending).rejects.toThrow("MODEL_NOT_FOUND: Configured model is unavailable.");
  });

  it("routes an authorized Worker capability request through the injected Host broker", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-provider-executor-capability-"));
    const supervisor = new FakeSupervisor();
    let brokerContext: { taskId: string; parentThreadId: string; capability: string } | undefined;
    const executor = new DesktopSubAgentProviderExecutor({
      supervisor: supervisor as never,
      root,
      resolveCredential: () => "secret",
      resources: () => ({ schemaVersion: 1, revisionId: "prompt-1", systemPrompt: "VC system", appendSystemPrompt: [] }),
      piResources: () => ({ agentDir: join(root, "pi-agent"), skillsRoot: join(root, "pi-agent", "skills"), mcpConfigPath: join(root, "pi-agent", "mcp.json") }),
      resolveCapability: async (context) => {
        brokerContext = { taskId: context.taskId, parentThreadId: context.parentThreadId, capability: context.request.capabilityId };
        return {
          schemaVersion: 1,
          requestId: context.request.requestId,
          status: "completed",
          content: "Capability completed.",
          artifact: {
            schemaVersion: 1,
            id: "artifact-1",
            mediaType: "text/plain; charset=utf-8",
            producer: { type: "sub_agent", id: context.taskId },
            destination: join(root, "result.md"),
            source: { threadId: context.request.threadId, turnId: context.request.turnId, capabilityRequestId: context.request.requestId },
            createdAt: new Date().toISOString()
          }
        };
      }
    });
    const pending = executor.execute({ ...input(root), capabilitySet: ["write_output"] });
    await Promise.resolve();
    const command = supervisor.command!;
    expect(command.activeCapabilities).toEqual(["output.write_text"]);
    const request = {
      schemaVersion: 1 as const,
      requestId: "request-1",
      correlationId: command.correlationId,
      threadId: command.threadId,
      turnId: command.turnId,
      toolCallId: "tool-1",
      capabilityId: "output.write_text",
      scope: { kind: "unscoped" as const, threadId: command.threadId },
      arguments: { path: "result.md", content: "result" },
      expectedStateVersion: 1,
      actor: { actorType: "agent" as const, actorId: "primary-agent" },
      provenance: { producerType: "agent" as const, producerId: "primary-agent" }
    };
    expect(executor.handleEvent({
      schemaVersion: 1,
      correlationId: command.correlationId,
      threadId: command.threadId,
      turnId: command.turnId,
      ownerKey: `unscoped:${command.threadId}`,
      sessionKey: command.threadId,
      workerSequence: 1,
      event: "capability.execution.requested",
      request
    })).toBe(true);
    await Promise.resolve();
    expect(brokerContext).toEqual({ taskId: "22222222-2222-4222-8222-222222222222", parentThreadId: "parent-thread", capability: "output.write_text" });
    expect(supervisor.resolved[0]?.result).toMatchObject({ requestId: "request-1", status: "completed" });
    expect(executor.handleEvent({
      schemaVersion: 1,
      correlationId: command.correlationId,
      threadId: command.threadId,
      turnId: command.turnId,
      ownerKey: `unscoped:${command.threadId}`,
      sessionKey: command.threadId,
      workerSequence: 2,
      event: "turn.completed",
      message: "Done",
      usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 }
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({ toolEvents: [{ capability: "output.write_text", status: "completed" }] });
  });
});
