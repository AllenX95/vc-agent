import { describe, expect, it } from "vitest";
import {
  RuntimeCapabilityAssembler,
  RuntimeCapabilityAssemblyError,
  providerToolNameForMcp
} from "@vc-agent/pi-adapter";
import type { CapabilitySurfaceSnapshot, ExtensionInventorySnapshot, FrozenMcpActivation } from "@vc-agent/contracts";

const extensions: ExtensionInventorySnapshot = {
  schemaVersion: 1,
  revisionId: "extensions-v1",
  enabled: []
};

function surface(scope: "project" | "unscoped", visibleCapabilityIds: readonly string[]): CapabilitySurfaceSnapshot {
  return {
    schemaVersion: 1,
    revision: `surface-${scope}`,
    kind: "ordinary",
    scope,
    visibleCapabilityIds: [...visibleCapabilityIds],
    executableCapabilityIds: [...visibleCapabilityIds],
    requestableCatalog: [],
    initialToolSchemaEstimatedTokens: 0
  };
}

function mcpActivation(scope: "project" | "unscoped"): FrozenMcpActivation {
  return {
    schemaVersion: 1,
    activationId: "00000000-0000-4000-8000-000000000001",
    serverId: "00000000-0000-4000-8000-000000000002",
    schemaRevision: "mcp-schema-v1",
    scope,
    reason: "task_preactivation",
    toolSchemas: [{
      name: "lookup",
      description: "Look up one bounded record.",
      actionClass: "read",
      allowedScopes: [scope],
      inputBytes: 512,
      outputBytes: 4_096,
      schemaHash: "lookup-schema-v1",
      inputSchema: { type: "object", properties: { id: { type: "string" } } }
    }]
  };
}

describe("RuntimeCapabilityAssembler", () => {
  it("fails closed when two admitted sources claim the same Provider tool name", () => {
    const assembler = new RuntimeCapabilityAssembler();

    expect(() => assembler.assemble({
      hostSurface: surface("project", ["web_search"]),
      extensionRevision: extensions,
      skills: undefined,
      hostToolNames: ["web_search"],
      extensionTools: [{
        name: "web_search",
        source: "bundled_extension",
        sourceId: "pi-web-access",
        sourceRevision: "0.17.0"
      }]
    })).toThrowError(expect.objectContaining<Partial<RuntimeCapabilityAssemblyError>>({
      code: "RUNTIME_CAPABILITY_COLLISION",
      toolName: "web_search"
    }));
  });

  it("only exposes the scoped Pi project-read tools for a Project Turn", () => {
    const assembler = new RuntimeCapabilityAssembler();

    const project = assembler.assemble({
      hostSurface: surface("project", ["capability_request"]),
      extensionRevision: extensions,
      projectReadRoot: "C:/project",
      skills: undefined,
      hostToolNames: ["capability_request"]
    });
    expect(project.tools.filter((tool) => tool.source === "pi_builtin").map((tool) => tool.name)).toEqual(["find", "grep", "ls", "read"]);
    expect(project.initialActiveToolNames).toEqual(["capability_request", "read", "ls", "find", "grep"]);

    const unscoped = assembler.assemble({
      hostSurface: surface("unscoped", ["capability_request"]),
      extensionRevision: extensions,
      projectReadRoot: "C:/project",
      skills: undefined,
      hostToolNames: ["capability_request"]
    });
    expect(unscoped.tools.some((tool) => tool.source === "pi_builtin")).toBe(false);
  });

  it("projects only the frozen MCP activation into the matching scope", () => {
    const assembler = new RuntimeCapabilityAssembler();
    const activation = mcpActivation("project");
    const providerName = providerToolNameForMcp(activation.serverId, "lookup");

    const project = assembler.assemble({
      hostSurface: surface("project", ["capability_request"]),
      extensionRevision: extensions,
      mcpActivation: activation,
      skills: undefined,
      hostToolNames: ["capability_request"]
    });
    expect(project.tools.find((tool) => tool.name === providerName)).toMatchObject({ source: "mcp", capabilityId: "mcp:00000000-0000-4000-8000-000000000002:lookup", sideEffectClass: "network_read" });
    expect(project.initialActiveToolNames).toContain(providerName);

    const unscoped = assembler.assemble({
      hostSurface: surface("unscoped", ["capability_request"]),
      extensionRevision: extensions,
      mcpActivation: activation,
      skills: undefined,
      hostToolNames: ["capability_request"]
    });
    expect(unscoped.initialActiveToolNames).not.toContain(providerName);
  });
});
