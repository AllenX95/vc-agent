import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerCommand, WorkerEvent } from "@vc-agent/contracts";
import { ExtensionAuditWorkerExecutor } from "../../apps/desktop/src/main/extension-audit-worker";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Extension Audit Agent Worker", () => {
  it("runs one isolated capability-free session and consumes its events outside ordinary Turns", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-extension-audit-worker-"));
    roots.push(root);
    let command: Extract<WorkerCommand, { command: "turn.execute" }> | undefined;
    const retired: string[] = [];
    const supervisor = {
      async execute(input: Extract<WorkerCommand, { command: "turn.execute" }>) { command = input; },
      stop() {},
      resolveCapability() {},
      retire(owner: string) { retired.push(owner); }
    };
    const executor = new ExtensionAuditWorkerExecutor({ supervisor, root });
    const controller = new AbortController();
    const pending = executor.execute({
      auditRunId: "audit-run-1",
      instructionsRevision: "extension-audit-v1",
      profile: { provider: "fixture", model: "audit-model", apiKey: "credential-value", thinkingLevel: "off" },
      systemPrompt: "Review only the supplied Extension snapshot.",
      prompt: "{\"bounded\":true}",
      signal: controller.signal
    });
    await Promise.resolve();

    expect(command).toMatchObject({
      executionScope: { kind: "unscoped" },
      contextHistory: [],
      activeCapabilities: [],
      resources: { systemPrompt: "Review only the supplied Extension snapshot.", appendSystemPrompt: [] },
      extensions: { enabled: [] }
    });
    expect(command?.resources.skills).toBeUndefined();
    const completed: WorkerEvent = {
      schemaVersion: 1,
      correlationId: command!.correlationId,
      threadId: command!.threadId,
      turnId: command!.turnId,
      workerSequence: 1,
      event: "turn.completed",
      message: "{\"summary\":\"safe\"}",
      usage: { input: 10, output: 5 }
    };
    expect(executor.handleEvent(completed)).toBe(true);
    await expect(pending).resolves.toBe("{\"summary\":\"safe\"}");
    expect(retired).toEqual([command!.threadId]);
  });

  it("fails closed when an audit session requests a capability", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-extension-audit-worker-"));
    roots.push(root);
    let command: Extract<WorkerCommand, { command: "turn.execute" }> | undefined;
    const resolutions: Array<Extract<WorkerCommand, { command: "capability.execution.resolve" }>> = [];
    const supervisor = {
      async execute(input: Extract<WorkerCommand, { command: "turn.execute" }>) { command = input; },
      stop() {},
      resolveCapability(input: Extract<WorkerCommand, { command: "capability.execution.resolve" }>) { resolutions.push(input); },
      retire() {}
    };
    const executor = new ExtensionAuditWorkerExecutor({ supervisor, root });
    const pending = executor.execute({
      auditRunId: "audit-run-2",
      instructionsRevision: "extension-audit-v1",
      profile: { provider: "fixture", model: "audit-model", apiKey: "credential-value", thinkingLevel: "off" },
      systemPrompt: "Review only.",
      prompt: "{}",
      signal: new AbortController().signal
    });
    await Promise.resolve();
    expect(executor.handleEvent({
      schemaVersion: 1,
      correlationId: command!.correlationId,
      threadId: command!.threadId,
      turnId: command!.turnId,
      workerSequence: 1,
      event: "capability.execution.requested",
      request: { schemaVersion: 1, requestId: "request-1", capabilityId: "public_web.search", scope: { kind: "unscoped", threadId: command!.threadId }, input: {}, reason: "audit tried a tool" }
    })).toBe(true);
    expect(resolutions[0]?.result).toMatchObject({ status: "rejected", code: "EXTENSION_AUDIT_CAPABILITY_NOT_ALLOWED" });
    executor.handleEvent({
      schemaVersion: 1,
      correlationId: command!.correlationId,
      threadId: command!.threadId,
      turnId: command!.turnId,
      workerSequence: 2,
      event: "turn.failed",
      failure: { kind: "provider", code: "PROVIDER_FAILED", message: "failed", provider: "fixture", model: "audit-model" }
    });
    await expect(pending).rejects.toThrow("PROVIDER_FAILED");
  });
});
