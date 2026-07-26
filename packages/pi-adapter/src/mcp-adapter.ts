/// <reference path="./pi-mcp-compat.d.ts" />

import { McpServerManager } from "pi-mcp-adapter/server-manager.js";
import type { McpTool, ServerDefinition } from "pi-mcp-adapter/types.js";

/**
 * This is the only vc-agent seam that talks to the reviewed pi-mcp-adapter
 * package. Host policy, scope, confirmation, and result bounding stay above
 * this module; this module only owns protocol transport and process lifecycle.
 */
export const PI_MCP_ADAPTER_VERSION = "1.5.1";

export interface PiMcpServerConfig {
  readonly serverKey: string;
  readonly transport: "stdio" | "http";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly endpoint?: string;
  readonly credentialValue?: string;
}

export interface PiMcpConnection {
  listTools(): Promise<readonly McpTool[]>;
  call(toolName: string, arguments_: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface PiMcpAdapter {
  readonly version: string;
  connect(config: PiMcpServerConfig, signal?: AbortSignal): Promise<PiMcpConnection>;
  shutdown(): Promise<void>;
}

interface PiMcpServerConnection {
  readonly client: {
    callTool(
      request: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> },
      options?: unknown
    ): Promise<unknown>;
  };
  readonly tools: readonly McpTool[];
  readonly status: string;
}

/**
 * Build a lazy adapter instance. The manager is deliberately created without
 * sampling, elicitation, OAuth, or keep-alive hooks so no server connection is
 * opened during construction or Settings/Doctor inspection.
 */
export function createPiMcpAdapter(): PiMcpAdapter {
  const manager = new McpServerManager();

  return {
    version: PI_MCP_ADAPTER_VERSION,
    async connect(config, signal) {
      const definition = toServerDefinition(config);
      if (signal?.aborted === true) throw new Error("MCP_TIMEOUT");
      const connection = await manager.connect(config.serverKey, definition) as unknown as PiMcpServerConnection;
      return {
        async listTools() {
          if (connection.status !== "connected") throw new Error("MCP_DISCONNECTED");
          return [...connection.tools];
        },
        async call(toolName, arguments_, callSignal) {
          if (connection.status !== "connected") throw new Error("MCP_DISCONNECTED");
          return await connection.client.callTool(
            { name: toolName, arguments: arguments_ },
            callSignal === undefined ? undefined : { signal: callSignal }
          );
        },
        close: async () => {
          await manager.close(config.serverKey);
        }
      } satisfies PiMcpConnection;
    },
    async shutdown() {
      await manager.closeAll();
    }
  } satisfies PiMcpAdapter;
}

function toServerDefinition(config: PiMcpServerConfig): ServerDefinition {
  if (config.transport === "stdio") {
    if (config.command === undefined || config.command.trim() === "") throw new Error("MCP_SERVER_CONFIGURATION_INVALID");
    return {
      command: config.command,
      args: [...(config.args ?? [])],
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      // pi-mcp-adapter starts from process.env internally. Override common
      // secret-bearing names so a configured stdio server cannot inherit
      // credential material from the Desktop process by accident.
      env: sanitizedStdioEnvironment(),
      lifecycle: "ephemeral"
    };
  }
  if (config.endpoint === undefined || config.endpoint.trim() === "") throw new Error("MCP_SERVER_CONFIGURATION_INVALID");
  return {
    url: config.endpoint,
    // OAuth and automatic auth expansion are intentionally disabled. A
    // protected HTTP server may receive an already-resolved bearer value only
    // for the duration of this in-memory connection.
    ...(config.credentialValue === undefined ? {} : { auth: "bearer" as const }),
    ...(config.credentialValue === undefined ? {} : { bearerToken: config.credentialValue }),
    lifecycle: "ephemeral"
  };
}

function sanitizedStdioEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    environment[name] = /(?:api[_-]?key|token|secret|password|credential|private[_-]?key|authorization)/iu.test(name) ? "" : value;
  }
  return environment;
}
