import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CapabilityExecutionResult } from "@vc-agent/contracts";

export const PINNED_PI_MCP_ADAPTER_VERSION = "pi-mcp-adapter@1.5.1";

export type McpTransport = "stdio" | "http" | "fixture";
export type McpActionClass = "read" | "write" | "external_submission" | "sampling" | "elicitation" | "local_file_upload";

export interface McpToolSchema {
  readonly name: string;
  readonly description?: string;
  readonly actionClass: McpActionClass;
  readonly allowedScopes: readonly ("project" | "unscoped")[];
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly schemaHash: string;
}

export interface McpServerConfigurationRequest {
  readonly serverId?: string;
  readonly name: string;
  readonly transport: McpTransport;
  readonly endpoint?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly credentialRef?: string;
  readonly enabled: boolean;
  readonly allowedScopes: readonly ("project" | "unscoped")[];
  readonly enabledToolIds?: readonly string[];
  readonly toolSchemas?: readonly McpToolSchema[];
}

export interface McpServerRecord {
  readonly schemaVersion: 1;
  readonly serverId: string;
  readonly name: string;
  readonly transport: McpTransport;
  readonly endpoint?: string;
  readonly command?: string;
  readonly args: readonly string[];
  readonly credentialRef?: string;
  readonly enabled: boolean;
  readonly allowedScopes: readonly ("project" | "unscoped")[];
  readonly enabledToolIds: readonly string[];
  readonly adapterVersion: string;
  readonly schemaRevision: string;
  readonly cachedToolSchemas: readonly McpToolSchema[];
  readonly connectionStatus: "disconnected" | "testing" | "connecting" | "connected" | "unavailable" | "failed";
  readonly schemaState: "unknown" | "cached" | "current_for_connection" | "mismatched";
  readonly lastStatusMessage?: string;
  readonly lastConnectedAt?: string;
  readonly failureCount: number;
}

export interface McpServerStatus {
  readonly serverId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly adapterVersion: string;
  readonly credentialReferencePresent: boolean;
  readonly connectionStatus: McpServerRecord["connectionStatus"];
  readonly schemaState: McpServerRecord["schemaState"];
  readonly schemaRevision: string;
  readonly enabledToolIds: readonly string[];
  readonly lastStatusMessage?: string;
  readonly failureCount: number;
}

export interface McpActivationRequest {
  readonly serverId: string;
  readonly toolIds: readonly string[];
  readonly scope: "project" | "unscoped";
  readonly reason: "task_preactivation" | "capability_activation_request" | "test_connection";
  readonly connect?: boolean;
}

export interface McpActivationDecision {
  readonly activationId: string;
  readonly serverId: string;
  readonly toolSchemas: readonly McpToolSchema[];
  readonly schemaRevision: string;
  readonly connectionRequired: boolean;
  readonly reason: McpActivationRequest["reason"];
}

export interface McpProxyExecutionRequest {
  readonly requestId?: string;
  readonly activationId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly threadId: string;
  readonly turnId: string;
  readonly scope: "project" | "unscoped";
  readonly accessMode: "standard" | "full";
  readonly confirmed?: boolean;
  readonly expectedSchemaRevision: string;
}

export interface McpAdapterConnection {
  listTools(): Promise<readonly McpToolSchema[]>;
  call(toolName: string, arguments_: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void> | void;
}

export interface PinnedPiMcpAdapter {
  readonly version: string;
  connect(config: McpServerRecord, credentialValue: string | undefined, signal?: AbortSignal): Promise<McpAdapterConnection>;
}

export interface McpCredentialResolver {
  resolve(reference: string): Promise<string | undefined> | string | undefined;
}

export interface McpResultEnvelope {
  readonly serverId: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly contentType: "application/json" | "text/plain";
  readonly content: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly contextReference: string;
  readonly retireAfterTurn: string;
  readonly provenance: { readonly adapterVersion: string; readonly schemaRevision: string; readonly activationReason: McpActivationRequest["reason"] };
}

interface StoredMcpState {
  readonly schemaVersion: 1;
  readonly servers: McpServerRecord[];
}

interface ActiveConnection {
  readonly connection: McpAdapterConnection;
  readonly activation: McpActivationDecision;
  readonly connectedAt: string;
}

export class McpIntegrationError extends Error {
  readonly code: "MCP_ADAPTER_UNAVAILABLE" | "MCP_SERVER_CONFIGURATION_INVALID" | "MCP_CREDENTIAL_UNAVAILABLE" | "MCP_CONNECTION_FAILED" | "MCP_TIMEOUT" | "MCP_DISCONNECTED" | "MCP_SCHEMA_MISMATCH" | "MCP_TOOL_INACTIVE" | "MCP_SCOPE_REJECTED" | "MCP_ACTION_REJECTED" | "MCP_RESULT_TOO_LARGE" | "UNKNOWN_TOOL_OUTCOME";

  constructor(code: McpIntegrationError["code"], message: string = code) {
    super(message);
    this.name = "McpIntegrationError";
    this.code = code;
  }
}

export class McpIntegrationManager {
  readonly #root: string;
  readonly #adapter: PinnedPiMcpAdapter;
  readonly #credentials: McpCredentialResolver | undefined;
  readonly #maxResultBytes: number;
  readonly #now: () => string;
  readonly #servers = new Map<string, McpServerRecord>();
  readonly #connections = new Map<string, ActiveConnection>();
  readonly #retiredPayloads = new Set<string>();
  #failureCount = 0;

  constructor(input: { root: string; adapter: PinnedPiMcpAdapter; credentials?: McpCredentialResolver; maxResultBytes?: number; now?: () => string }) {
    this.#root = resolve(input.root);
    this.#adapter = input.adapter;
    this.#credentials = input.credentials;
    this.#maxResultBytes = input.maxResultBytes ?? 20_000;
    this.#now = input.now ?? (() => new Date().toISOString());
    if (this.#adapter.version !== PINNED_PI_MCP_ADAPTER_VERSION) throw new McpIntegrationError("MCP_ADAPTER_UNAVAILABLE", "The bundled pi-mcp-adapter revision is not the pinned version.");
    this.load();
    for (const [serverId, record] of this.#servers) this.#servers.set(serverId, { ...record, connectionStatus: "disconnected" });
  }

  configure(request: McpServerConfigurationRequest): McpServerRecord {
    validateConfig(request);
    const serverId = request.serverId ?? randomUUID();
    const prior = this.#servers.get(serverId);
    if (prior !== undefined) void this.disconnect(serverId);
    const schemas = [...(request.toolSchemas ?? prior?.cachedToolSchemas ?? [])];
    const schemaRevision = hashSchemas(schemas);
    const record: McpServerRecord = {
      schemaVersion: 1, serverId, name: request.name.trim(), transport: request.transport,
      ...(request.endpoint === undefined ? {} : { endpoint: request.endpoint }),
      ...(request.command === undefined ? {} : { command: request.command }),
      args: [...(request.args ?? [])],
      ...(request.credentialRef === undefined ? {} : { credentialRef: request.credentialRef }),
      enabled: request.enabled, allowedScopes: [...request.allowedScopes], enabledToolIds: [...(request.enabledToolIds ?? schemas.map((schema) => schema.name))],
      adapterVersion: PINNED_PI_MCP_ADAPTER_VERSION, schemaRevision, cachedToolSchemas: schemas,
      connectionStatus: "disconnected", schemaState: schemas.length === 0 ? "unknown" : "cached", failureCount: prior?.failureCount ?? 0
    };
    this.#servers.set(serverId, record);
    this.save();
    return cloneRecord(record);
  }

  inventory(): McpServerStatus[] {
    return [...this.#servers.values()].map((record) => ({
      serverId: record.serverId, name: record.name, enabled: record.enabled, adapterVersion: record.adapterVersion,
      credentialReferencePresent: record.credentialRef !== undefined, connectionStatus: record.connectionStatus,
      schemaState: record.schemaState, schemaRevision: record.schemaRevision, enabledToolIds: [...record.enabledToolIds],
      ...(record.lastStatusMessage === undefined ? {} : { lastStatusMessage: record.lastStatusMessage }), failureCount: record.failureCount
    }));
  }

  getServer(serverId: string): McpServerRecord | undefined {
    const server = this.#servers.get(serverId);
    return server === undefined ? undefined : cloneRecord(server);
  }

  async testConnection(serverId: string): Promise<McpServerStatus> {
    const record = this.#servers.get(serverId);
    if (record === undefined) throw new McpIntegrationError("MCP_TOOL_INACTIVE", "MCP server is not configured.");
    const scope = record.allowedScopes[0];
    if (scope === undefined) throw new McpIntegrationError("MCP_SCOPE_REJECTED", "MCP server has no configured scope.");
    const activation = await this.resolveActivation({ serverId, toolIds: [], scope, reason: "test_connection", connect: true });
    await this.disconnect(serverId);
    return this.inventory().find((status) => status.serverId === activation.serverId)!;
  }

  async resolveActivation(request: McpActivationRequest): Promise<McpActivationDecision> {
    const record = this.#servers.get(request.serverId);
    if (record === undefined || !record.enabled) throw new McpIntegrationError("MCP_TOOL_INACTIVE", "MCP server is not configured or enabled.");
    if (!record.allowedScopes.includes(request.scope)) throw new McpIntegrationError("MCP_SCOPE_REJECTED", "MCP server is not enabled for this scope.");
    const requested = request.toolIds.length === 0 ? record.enabledToolIds : request.toolIds;
    const schemas = record.cachedToolSchemas.filter((schema) => requested.includes(schema.name) && record.enabledToolIds.includes(schema.name) && schema.allowedScopes.includes(request.scope));
    if (request.reason !== "test_connection" && schemas.length !== requested.length) throw new McpIntegrationError("MCP_TOOL_INACTIVE", "Requested MCP tools are not active for this task.");
    let activation: McpActivationDecision = { activationId: randomUUID(), serverId: record.serverId, toolSchemas: schemas, schemaRevision: record.schemaRevision, connectionRequired: request.connect !== false, reason: request.reason };
    if (request.connect !== false) {
      const existing = this.#connections.get(record.serverId);
      if (existing !== undefined && record.schemaState === "current_for_connection" && existing.activation.schemaRevision === record.schemaRevision) {
        this.#connections.set(record.serverId, { ...existing, activation });
      } else {
        await this.connect(record, activation);
        // A first Test Connection may discover the schema cache. Refresh the
        // activation and the active connection with the reviewed result so a
        // server configured without a pre-populated cache can be used on the
        // next explicit task activation.
        const refreshedRecord = this.#servers.get(record.serverId);
        if (refreshedRecord !== undefined && refreshedRecord.schemaRevision !== activation.schemaRevision) {
          const refreshedRequested = request.toolIds.length === 0 ? refreshedRecord.enabledToolIds : request.toolIds;
          const refreshedSchemas = refreshedRecord.cachedToolSchemas.filter((schema) => refreshedRequested.includes(schema.name) && refreshedRecord.enabledToolIds.includes(schema.name) && schema.allowedScopes.includes(request.scope));
          activation = { ...activation, toolSchemas: refreshedSchemas, schemaRevision: refreshedRecord.schemaRevision };
          const connected = this.#connections.get(record.serverId);
          if (connected !== undefined) this.#connections.set(record.serverId, { ...connected, activation });
        }
      }
    }
    return activation;
  }

  async execute(request: McpProxyExecutionRequest, signal?: AbortSignal): Promise<CapabilityExecutionResult> {
    const record = this.#servers.get(request.serverId);
    const active = this.#connections.get(request.serverId);
    const requestId = request.requestId ?? randomUUID();
    if (record === undefined || active === undefined || active.activation.activationId !== request.activationId) return failure(requestId, "MCP_TOOL_INACTIVE", "MCP activation is not active.");
    if (record.schemaRevision !== request.expectedSchemaRevision || active.activation.schemaRevision !== request.expectedSchemaRevision || record.schemaState === "mismatched") return failure(requestId, "MCP_SCHEMA_MISMATCH", "MCP tool schema changed; refresh and review activation.");
    if (!record.allowedScopes.includes(request.scope)) return failure(requestId, "MCP_SCOPE_REJECTED", "MCP server is outside the configured scope.");
    const schema = active.activation.toolSchemas.find((item) => item.name === request.toolName);
    if (schema === undefined) return failure(requestId, "MCP_TOOL_INACTIVE", "MCP tool is not active for this Turn.");
    if (schema.actionClass !== "read" && request.accessMode === "standard" && request.confirmed !== true) return failure(requestId, "MCP_ACTION_REJECTED", "Scoped confirmation is required for this MCP action.", "rejected");
    if (Buffer.byteLength(JSON.stringify(request.arguments), "utf8") > schema.inputBytes) return failure(requestId, "MCP_RESULT_TOO_LARGE", "MCP input exceeds the declared bound.");
    if (signal?.aborted === true) return failure(requestId, "MCP_TIMEOUT", "MCP execution was cancelled before dispatch.");
    try {
      const raw = await abortable(active.connection.call(request.toolName, request.arguments, signal), signal);
      const serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
      const bytes = Buffer.byteLength(serialized, "utf8");
      const truncated = bytes > Math.min(this.#maxResultBytes, schema.outputBytes);
      const content = truncated ? truncateUtf8(serialized, Math.min(this.#maxResultBytes, schema.outputBytes)) : serialized;
      const contextReference = "mcp:" + randomUUID();
      const envelope: McpResultEnvelope = {
        serverId: record.serverId, serverName: record.name, toolName: request.toolName, contentType: typeof raw === "string" ? "text/plain" : "application/json",
        content, bytes: Buffer.byteLength(content, "utf8"), truncated, contextReference, retireAfterTurn: request.turnId,
        provenance: { adapterVersion: PINNED_PI_MCP_ADAPTER_VERSION, schemaRevision: request.expectedSchemaRevision, activationReason: active.activation.reason }
      };
      return { schemaVersion: 1, requestId, status: "completed", content: JSON.stringify(envelope), code: truncated ? "MCP_RESULT_TRUNCATED" : "MCP_READ_COMPLETED" };
    } catch (error) {
      this.#failureCount += 1;
      return failure(requestId, signal?.aborted ? "MCP_TIMEOUT" : "MCP_CONNECTION_FAILED", "MCP execution failed without automatic fallback.");
    }
  }

  retireTurn(turnId: string): void { this.#retiredPayloads.add(turnId); }
  payloadIsRetired(turnId: string): boolean { return this.#retiredPayloads.has(turnId); }

  async disconnect(serverId: string): Promise<void> {
    const active = this.#connections.get(serverId);
    if (active !== undefined) await active.connection.close();
    this.#connections.delete(serverId);
    const record = this.#servers.get(serverId);
    if (record !== undefined) { this.#servers.set(serverId, { ...record, connectionStatus: "disconnected", schemaState: record.cachedToolSchemas.length === 0 ? "unknown" : "cached" }); this.save(); }
  }

  async shutdown(): Promise<void> { await Promise.all([...this.#connections.keys()].map((serverId) => this.disconnect(serverId))); }
  telemetry(): { readonly adapterVersion: string; readonly connectedServers: number; readonly activeTools: number; readonly failureCount: number; readonly retiredTurns: number } {
    return { adapterVersion: PINNED_PI_MCP_ADAPTER_VERSION, connectedServers: this.#connections.size, activeTools: [...this.#connections.values()].reduce((count, active) => count + active.activation.toolSchemas.length, 0), failureCount: this.#failureCount, retiredTurns: this.#retiredPayloads.size };
  }

  async connect(server: McpServerRecord, activation: McpActivationDecision): Promise<void> {
    try {
      const credentialValue = server.credentialRef === undefined ? undefined : await this.#credentials?.resolve(server.credentialRef);
      if (server.credentialRef !== undefined && credentialValue === undefined) throw new McpIntegrationError("MCP_CREDENTIAL_UNAVAILABLE", "The configured credential reference is unavailable.");
      const connection = await this.#adapter.connect(server, credentialValue);
      const currentSchemas = await connection.listTools();
      const currentRevision = hashSchemas(currentSchemas);
      if (server.cachedToolSchemas.length > 0 && currentRevision !== server.schemaRevision) {
        await connection.close();
        this.#servers.set(server.serverId, { ...server, connectionStatus: "failed", schemaState: "mismatched", lastStatusMessage: "Connected server schema differs from the reviewed cache.", failureCount: server.failureCount + 1 });
        this.#failureCount += 1;
        this.save();
        throw new McpIntegrationError("MCP_SCHEMA_MISMATCH", "MCP schema revision changed.");
      }
      const discovered = server.cachedToolSchemas.length === 0;
      const cachedToolSchemas = discovered ? [...currentSchemas] : [...server.cachedToolSchemas];
      const enabledToolIds = server.enabledToolIds.length === 0 ? currentSchemas.map((schema) => schema.name) : [...server.enabledToolIds];
      const schemaRevision = discovered ? currentRevision : server.schemaRevision;
      const connectedRecord: McpServerRecord = {
        ...server,
        enabledToolIds,
        cachedToolSchemas,
        schemaRevision,
        connectionStatus: "connected",
        schemaState: "current_for_connection",
        lastConnectedAt: this.#now()
      };
      this.#connections.set(server.serverId, { connection, activation, connectedAt: this.#now() });
      this.#servers.set(server.serverId, connectedRecord);
      this.save();
    } catch (error) {
      const failure = error instanceof McpIntegrationError ? error : new McpIntegrationError("MCP_CONNECTION_FAILED", "MCP connection failed without fallback.");
      if (failure.code !== "MCP_SCHEMA_MISMATCH") {
        this.#failureCount += 1;
        this.#servers.set(server.serverId, {
          ...server,
          connectionStatus: "unavailable",
          lastStatusMessage: failure.code === "MCP_CREDENTIAL_UNAVAILABLE" ? "MCP credential reference is unavailable." : "MCP connection failed without fallback.",
          failureCount: server.failureCount + 1
        });
        this.save();
      }
      throw failure;
    }
  }

  private load(): void {
    const path = join(this.#root, "mcp-servers.json");
    if (!existsSync(path)) return;
    try {
      const state = JSON.parse(readFileSync(path, "utf8")) as StoredMcpState;
      if (state.schemaVersion === 1 && Array.isArray(state.servers)) for (const server of state.servers) this.#servers.set(server.serverId, server);
    } catch {
      // Corrupt integration state remains unavailable; it is never auto-repaired by connecting.
    }
  }

  private save(): void {
    mkdirSync(this.#root, { recursive: true });
    const path = join(this.#root, "mcp-servers.json");
    const partial = path + ".partial";
    writeFileSync(partial, JSON.stringify({ schemaVersion: 1, servers: [...this.#servers.values()] }, null, 2) + "\n", "utf8");
    renameSync(partial, path);
  }
}

function validateConfig(request: McpServerConfigurationRequest): void {
  if (request.name.trim() === "" || request.allowedScopes.length === 0) throw new McpIntegrationError("MCP_SERVER_CONFIGURATION_INVALID", "MCP server name and scope are required.");
  if (request.transport === "http" && request.endpoint === undefined) throw new McpIntegrationError("MCP_SERVER_CONFIGURATION_INVALID", "HTTP MCP servers require an endpoint.");
  if (request.transport === "stdio" && request.command === undefined) throw new McpIntegrationError("MCP_SERVER_CONFIGURATION_INVALID", "stdio MCP servers require a command.");
  if ([request.endpoint, request.command, ...(request.args ?? [])].some((value) => value !== undefined && /(api[_-]?key|token|secret|password)=/iu.test(value))) throw new McpIntegrationError("MCP_SERVER_CONFIGURATION_INVALID", "Protected credential values must be references, not configuration text.");
}

function hashSchemas(schemas: readonly McpToolSchema[]): string {
  const canonical = schemas
    .map((schema) => ({
      name: schema.name,
      description: schema.description ?? null,
      actionClass: schema.actionClass,
      allowedScopes: [...schema.allowedScopes].sort(),
      inputBytes: schema.inputBytes,
      outputBytes: schema.outputBytes,
      schemaHash: schema.schemaHash
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return "schema-" + createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex").slice(0, 32);
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, Math.max(0, result.length - 256));
  return result;
}

function cloneRecord(record: McpServerRecord): McpServerRecord {
  return { ...record, args: [...record.args], allowedScopes: [...record.allowedScopes], enabledToolIds: [...record.enabledToolIds], cachedToolSchemas: record.cachedToolSchemas.map((schema) => ({ ...schema, allowedScopes: [...schema.allowedScopes] })) };
}

function failure(requestId: string, code: string, content: string, status: "failed" | "rejected" = "failed"): CapabilityExecutionResult {
  return { schemaVersion: 1, requestId, status, code, content: content.slice(0, 20_000) };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) throw new McpIntegrationError("MCP_TIMEOUT", "MCP execution was cancelled.");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new McpIntegrationError("MCP_TIMEOUT", "MCP execution was cancelled."));
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
