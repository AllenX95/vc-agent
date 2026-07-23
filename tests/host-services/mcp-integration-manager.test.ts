import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { McpIntegrationManager, PINNED_PI_MCP_ADAPTER_VERSION, type McpAdapterConnection, type McpServerRecord, type McpToolSchema } from "@vc-agent/host-services";

const readTool: McpToolSchema = { name: "search", actionClass: "read", allowedScopes: ["project", "unscoped"], inputBytes: 1_000, outputBytes: 64, schemaHash: "search-v1" };
const writeTool: McpToolSchema = { name: "update", actionClass: "write", allowedScopes: ["project"], inputBytes: 1_000, outputBytes: 1_000, schemaHash: "update-v1" };

function fixtureAdapter(input: { mismatch?: boolean } = {}) {
  let connects = 0;
  let calls = 0;
  const adapter = {
    version: PINNED_PI_MCP_ADAPTER_VERSION,
    connect: async (_config: McpServerRecord, credentialValue: string | undefined): Promise<McpAdapterConnection> => {
      connects += 1;
      expect(credentialValue).toBe("secret-value");
      return {
        listTools: async () => input.mismatch === true ? [{ ...readTool, schemaHash: "changed" }] : [readTool, writeTool],
        call: async (toolName: string) => { calls += 1; return toolName === "search" ? { result: "x".repeat(200) } : { updated: true }; },
        close: async () => undefined
      };
    }
  };
  return { adapter, counts: () => ({ connects, calls }) };
}

describe("MCP Integration Manager", () => {
  it("configures lazily, activates a bounded read, and retires large payloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-mcp-"));
    try {
      const fixture = fixtureAdapter();
      const manager = new McpIntegrationManager({ root, adapter: fixture.adapter, credentials: { resolve: () => "secret-value" }, maxResultBytes: 64 });
      const server = manager.configure({ name: "Fixture", transport: "fixture", credentialRef: "credential-ref", enabled: true, allowedScopes: ["project", "unscoped"], enabledToolIds: ["search", "update"], toolSchemas: [readTool, writeTool] });
      expect(fixture.counts().connects).toBe(0);
      expect(manager.inventory()[0]).toMatchObject({ connectionStatus: "disconnected", credentialReferencePresent: true });
      const activation = await manager.resolveActivation({ serverId: server.serverId, toolIds: ["search"], scope: "unscoped", reason: "task_preactivation" });
      expect(fixture.counts().connects).toBe(1);
      const result = await manager.execute({ activationId: activation.activationId, serverId: server.serverId, toolName: "search", arguments: {}, threadId: "thread", turnId: "turn", scope: "unscoped", accessMode: "standard", expectedSchemaRevision: activation.schemaRevision });
      expect(result.status).toBe("completed");
      expect(result.content).toContain('"truncated":true');
      manager.retireTurn("turn");
      expect(manager.payloadIsRetired("turn")).toBe(true);
      expect(JSON.parse(readFileSync(join(root, "mcp-servers.json"), "utf8"))).not.toMatchObject({ credential: "secret-value" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gates writes, isolates scopes, and never falls back on schema mismatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-mcp-"));
    try {
      const fixture = fixtureAdapter();
      const manager = new McpIntegrationManager({ root, adapter: fixture.adapter, credentials: { resolve: () => "secret-value" } });
      const server = manager.configure({ name: "Fixture", transport: "fixture", credentialRef: "credential-ref", enabled: true, allowedScopes: ["project"], enabledToolIds: ["search", "update"], toolSchemas: [readTool, writeTool] });
      const activation = await manager.resolveActivation({ serverId: server.serverId, toolIds: ["update"], scope: "project", reason: "capability_activation_request" });
      const denied = await manager.execute({ activationId: activation.activationId, serverId: server.serverId, toolName: "update", arguments: { value: 1 }, threadId: "thread", turnId: "turn", scope: "project", accessMode: "standard", expectedSchemaRevision: activation.schemaRevision });
      expect(denied).toMatchObject({ status: "rejected", code: "MCP_ACTION_REJECTED" });
      const approved = await manager.execute({ activationId: activation.activationId, serverId: server.serverId, toolName: "update", arguments: { value: 1 }, threadId: "thread", turnId: "turn", scope: "project", accessMode: "full", expectedSchemaRevision: activation.schemaRevision });
      expect(approved.status).toBe("completed");
      await expect(manager.resolveActivation({ serverId: server.serverId, toolIds: ["search"], scope: "unscoped", reason: "task_preactivation" })).rejects.toMatchObject({ code: "MCP_SCOPE_REJECTED" });

      const mismatchFixture = fixtureAdapter({ mismatch: true });
      const mismatch = new McpIntegrationManager({ root: join(root, "mismatch"), adapter: mismatchFixture.adapter, credentials: { resolve: () => "secret-value" } });
      const mismatchServer = mismatch.configure({ name: "Mismatch", transport: "fixture", credentialRef: "credential-ref", enabled: true, allowedScopes: ["project"], enabledToolIds: ["search"], toolSchemas: [readTool] });
      await expect(mismatch.resolveActivation({ serverId: mismatchServer.serverId, toolIds: ["search"], scope: "project", reason: "task_preactivation" })).rejects.toMatchObject({ code: "MCP_SCHEMA_MISMATCH" });

      const restarted = new McpIntegrationManager({ root, adapter: fixture.adapter });
      expect(restarted.inventory()[0]).toMatchObject({ connectionStatus: "disconnected" });
      expect(fixture.counts().connects).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
