import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { McpIntegrationManager } from "@vc-agent/host-services";
import { createDesktopMcpAdapter } from "../../apps/desktop/src/main/integration-adapters.js";

const fixtureServer = resolve(import.meta.dirname, "../fixtures/mcp-stdio-server.mjs");

describe("pinned pi-mcp-adapter compatibility", () => {
  it("connects lazily to a real stdio fixture, discovers schemas, gates writes, and stays dormant after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-mcp-real-"));
    const counterPath = join(root, "starts.log");
    const callLogPath = join(root, "calls.log");
    try {
      const manager = new McpIntegrationManager({ root, adapter: createDesktopMcpAdapter() });
      const configured = manager.configure({
        name: "Local fixture MCP",
        transport: "stdio",
        command: process.execPath,
        args: [fixtureServer, counterPath, callLogPath],
        enabled: true,
        allowedScopes: ["project"]
      });

      expect(existsSync(counterPath)).toBe(false);
      expect(manager.inventory()[0]).toMatchObject({ connectionStatus: "disconnected", schemaState: "unknown" });

      const tested = await manager.testConnection(configured.serverId);
      expect(tested).toMatchObject({ connectionStatus: "disconnected", schemaState: "cached" });
      expect(readFileSync(counterPath, "utf8").trim().split(/\r?\n/u)).toHaveLength(1);

      const discovered = manager.getServer(configured.serverId);
      expect(discovered?.cachedToolSchemas.map((schema) => schema.name)).toEqual(["fixture.search", "fixture.write"]);

      const activation = await manager.resolveActivation({
        serverId: configured.serverId,
        toolIds: ["fixture.search"],
        scope: "project",
        reason: "task_preactivation"
      });
      const read = await manager.execute({
        activationId: activation.activationId,
        serverId: configured.serverId,
        toolName: "fixture.search",
        arguments: { query: "demo" },
        threadId: "thread",
        turnId: "turn-read",
        scope: "project",
        accessMode: "standard",
        expectedSchemaRevision: activation.schemaRevision
      });
      expect(read).toMatchObject({ status: "completed", code: "MCP_READ_COMPLETED" });
      expect(read.content).toContain("vc-agent-fixture-mcp");
      expect(readFileSync(callLogPath, "utf8").trim().split(/\r?\n/u)).toEqual(["fixture.search"]);

      const writeActivation = await manager.resolveActivation({
        serverId: configured.serverId,
        toolIds: ["fixture.write"],
        scope: "project",
        reason: "capability_activation_request"
      });
      const denied = await manager.execute({
        activationId: writeActivation.activationId,
        serverId: configured.serverId,
        toolName: "fixture.write",
        arguments: { value: 1 },
        threadId: "thread",
        turnId: "turn-write-denied",
        scope: "project",
        accessMode: "standard",
        expectedSchemaRevision: writeActivation.schemaRevision
      });
      expect(denied).toMatchObject({ status: "rejected", code: "MCP_ACTION_REJECTED" });
      expect(readFileSync(callLogPath, "utf8").trim().split(/\r?\n/u)).toEqual(["fixture.search"]);

      const approved = await manager.execute({
        activationId: writeActivation.activationId,
        serverId: configured.serverId,
        toolName: "fixture.write",
        arguments: { value: 1 },
        threadId: "thread",
        turnId: "turn-write-approved",
        scope: "project",
        accessMode: "full",
        expectedSchemaRevision: writeActivation.schemaRevision
      });
      expect(approved).toMatchObject({ status: "completed", code: "MCP_READ_COMPLETED" });
      expect(readFileSync(callLogPath, "utf8").trim().split(/\r?\n/u)).toEqual(["fixture.search", "fixture.write"]);

      await manager.shutdown();
      const restarted = new McpIntegrationManager({ root, adapter: createDesktopMcpAdapter() });
      expect(restarted.inventory()[0]).toMatchObject({ connectionStatus: "disconnected", schemaState: "cached" });
      expect(readFileSync(counterPath, "utf8").trim().split(/\r?\n/u)).toHaveLength(2);
      await restarted.shutdown();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
