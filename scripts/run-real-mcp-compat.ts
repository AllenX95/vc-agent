import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  McpIntegrationManager,
  PINNED_PI_MCP_ADAPTER_VERSION,
  type McpProxyExecutionRequest,
  type McpToolSchema
} from "../packages/host-services/src/index.ts";
import { createDesktopMcpAdapter } from "../apps/desktop/src/main/integration-adapters.ts";

/**
 * Runs a user-supplied stdio MCP server through the same pinned adapter and
 * Host policy used by Desktop. The command is deliberately external: this
 * script never starts a fixture server and never writes protocol payloads to
 * the evidence file.
 *
 * Required inputs are normally supplied through VC_AGENT_REAL_MCP_* env vars:
 *   VC_AGENT_REAL_MCP_COMMAND
 *   VC_AGENT_REAL_MCP_EVIDENCE
 *   VC_AGENT_REAL_MCP_READ_TOOL
 *   VC_AGENT_REAL_MCP_WRITE_TOOL
 *
 * Optional JSON inputs:
 *   VC_AGENT_REAL_MCP_ARGS
 *   VC_AGENT_REAL_MCP_READ_ARGUMENTS
 *   VC_AGENT_REAL_MCP_WRITE_ARGUMENTS
 *
 * Example:
 *   pnpm mcp:compat -- --command node --args '["C:\\mcp-server.mjs"]' \
 *     --read-tool search --write-tool update --evidence C:\\evidence\\mcp.json
 */

interface McpEvidence {
  readonly schemaVersion: 1;
  readonly sanitized: true;
  readonly kind: "mcp-compatibility";
  readonly adapterVersion: typeof PINNED_PI_MCP_ADAPTER_VERSION;
  readonly packageRevision: typeof PINNED_PI_MCP_ADAPTER_VERSION;
  readonly workflows: readonly ["lazy-read", "confirmed-write", "restart"];
}

interface Flags { readonly [key: string]: string | undefined }

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const command = resolveRequired(flags.command ?? process.env.VC_AGENT_REAL_MCP_COMMAND, "VC_AGENT_REAL_MCP_COMMAND");
  const evidencePath = resolveRequired(flags.evidence ?? process.env.VC_AGENT_REAL_MCP_EVIDENCE, "VC_AGENT_REAL_MCP_EVIDENCE");
  const readTool = resolveRequired(flags["read-tool"] ?? process.env.VC_AGENT_REAL_MCP_READ_TOOL, "VC_AGENT_REAL_MCP_READ_TOOL");
  const writeTool = resolveRequired(flags["write-tool"] ?? process.env.VC_AGENT_REAL_MCP_WRITE_TOOL, "VC_AGENT_REAL_MCP_WRITE_TOOL");
  assertExternalPath(evidencePath);
  const args = parseJsonStringArray(flags.args ?? process.env.VC_AGENT_REAL_MCP_ARGS, "VC_AGENT_REAL_MCP_ARGS");
  const readArguments = parseJsonObject(flags["read-arguments"] ?? process.env.VC_AGENT_REAL_MCP_READ_ARGUMENTS, "VC_AGENT_REAL_MCP_READ_ARGUMENTS");
  const writeArguments = parseJsonObject(flags["write-arguments"] ?? process.env.VC_AGENT_REAL_MCP_WRITE_ARGUMENTS, "VC_AGENT_REAL_MCP_WRITE_ARGUMENTS");
  const workRoot = mkdtempSync(join(tmpdir(), "vc-agent-real-mcp-"));
  try {
    const serverId = "real-mcp-compat-server";
    const manager = new McpIntegrationManager({ root: join(workRoot, "first"), adapter: createDesktopMcpAdapter() });
    const configured = manager.configure({ name: "External MCP compatibility server", serverId, transport: "stdio", command, args, enabled: true, allowedScopes: ["project"] });

    // Test Connection is the only operation in this script that may discover
    // and cache schemas. It is still explicit and the adapter is disconnected
    // again before the task-scoped activation below.
    await manager.testConnection(configured.serverId);
    const discovered = manager.getServer(serverId);
    if (discovered === undefined) throw new Error("MCP_SERVER_NOT_DISCOVERED");
    const readSchema = requireTool(discovered.cachedToolSchemas, readTool, "read");
    const writeSchema = requireTool(discovered.cachedToolSchemas, writeTool, "write");
    if (readSchema.actionClass !== "read") throw new Error(`MCP_READ_TOOL_NOT_READ:${readTool}`);
    if (writeSchema.actionClass !== "write") throw new Error(`MCP_WRITE_TOOL_NOT_WRITE:${writeTool}`);

    const readActivation = await manager.resolveActivation({ serverId, toolIds: [readTool], scope: "project", reason: "task_preactivation" });
    const readResult = await execute(manager, { activationId: readActivation.activationId, serverId, toolName: readTool, arguments: readArguments, threadId: "real-mcp-thread", turnId: "lazy-read", scope: "project", accessMode: "standard", expectedSchemaRevision: readActivation.schemaRevision });
    if (readResult.status !== "completed") throw new Error(`MCP_READ_FAILED:${readResult.code}`);

    const writeActivation = await manager.resolveActivation({ serverId, toolIds: [writeTool], scope: "project", reason: "capability_activation_request" });
    const writeResult = await execute(manager, { activationId: writeActivation.activationId, serverId, toolName: writeTool, arguments: writeArguments, threadId: "real-mcp-thread", turnId: "confirmed-write", scope: "project", accessMode: "standard", confirmed: true, expectedSchemaRevision: writeActivation.schemaRevision });
    if (writeResult.status !== "completed") throw new Error(`MCP_WRITE_FAILED:${writeResult.code}`);
    await manager.shutdown();

    const restarted = new McpIntegrationManager({ root: join(workRoot, "first"), adapter: createDesktopMcpAdapter() });
    const restartStatus = restarted.inventory().find((item) => item.serverId === serverId);
    if (restartStatus?.schemaState !== "cached" || restartStatus.connectionStatus !== "disconnected") throw new Error("MCP_RESTART_NOT_DORMANT");
    await restarted.testConnection(serverId);
    await restarted.shutdown();

    const evidence: McpEvidence = { schemaVersion: 1, sanitized: true, kind: "mcp-compatibility", adapterVersion: PINNED_PI_MCP_ADAPTER_VERSION, packageRevision: PINNED_PI_MCP_ADAPTER_VERSION, workflows: ["lazy-read", "confirmed-write", "restart"] };
    mkdirSync(resolve(evidencePath, ".."), { recursive: true });
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({ status: "pass", evidencePath: "external/mcp/compatibility.json", adapterVersion: PINNED_PI_MCP_ADAPTER_VERSION, workflows: evidence.workflows }, null, 2));
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

async function execute(manager: McpIntegrationManager, request: McpProxyExecutionRequest) {
  return await manager.execute(request);
}

function requireTool(schemas: readonly McpToolSchema[], name: string, expected: "read" | "write"): McpToolSchema {
  const schema = schemas.find((item) => item.name === name);
  if (schema === undefined) throw new Error(`MCP_${expected.toUpperCase()}_TOOL_NOT_FOUND:${name}`);
  return schema;
}

function parseFlags(values: readonly string[]): Flags {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined || !value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith("--")) { result[key] = next; index += 1; }
  }
  return result;
}

function parseJsonStringArray(value: string | undefined, name: string): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error();
    return parsed;
  } catch { throw new Error(`BLOCKED: ${name} must be a JSON string array.`); }
}

function parseJsonObject(value: string | undefined, name: string): Readonly<Record<string, unknown>> {
  if (value === undefined || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new Error(`BLOCKED: ${name} must be a JSON object.`); }
}

function resolveRequired(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") throw new Error(`BLOCKED: ${name} is required.`);
  return value.trim();
}

function assertExternalPath(path: string): void {
  const root = resolve(process.cwd());
  const candidate = resolve(path);
  const relativePath = relative(root, candidate);
  if (relativePath === "" || (!relativePath.startsWith("..") && !/^[A-Za-z]:/u.test(relativePath))) throw new Error("MCP_EVIDENCE_MUST_BE_EXTERNAL");
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "real MCP compatibility failed"); process.exitCode = 1; });
