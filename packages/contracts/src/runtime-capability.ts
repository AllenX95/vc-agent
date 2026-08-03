import { z } from "zod";

/** The bounded schema projection that a Host has explicitly admitted for one MCP activation. */
export const runtimeMcpToolSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  actionClass: z.enum(["read", "write", "external_submission", "sampling", "elicitation", "local_file_upload"]),
  allowedScopes: z.array(z.enum(["project", "unscoped"])).min(1),
  inputBytes: z.number().int().positive(),
  outputBytes: z.number().int().positive(),
  schemaHash: z.string().min(1).max(200),
  /** Optional JSON-schema projection. The Host remains authoritative for execution validation. */
  inputSchema: z.record(z.string(), z.unknown()).optional()
});
export type RuntimeMcpToolSchema = z.infer<typeof runtimeMcpToolSchema>;

export const frozenMcpActivationSchema = z.object({
  schemaVersion: z.literal(1),
  activationId: z.string().min(1),
  serverId: z.string().min(1),
  schemaRevision: z.string().min(1),
  scope: z.enum(["project", "unscoped"]),
  reason: z.enum(["task_preactivation", "capability_activation_request", "test_connection"]),
  toolSchemas: z.array(runtimeMcpToolSchema)
});
export type FrozenMcpActivation = z.infer<typeof frozenMcpActivationSchema>;

export const runtimeCapabilityDiagnosticSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1).max(1_000),
  toolName: z.string().min(1).optional(),
  sourceId: z.string().min(1).optional(),
  sourceRevision: z.string().min(1).optional()
});
export type RuntimeCapabilityDiagnostic = z.infer<typeof runtimeCapabilityDiagnosticSchema>;
