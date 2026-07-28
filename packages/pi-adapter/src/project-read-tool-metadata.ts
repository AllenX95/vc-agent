import type { CapabilityMetadata } from "@vc-agent/contracts";

export const PROJECT_READ_TOOL_NAMES = ["read", "ls", "find", "grep"] as const;
export type ProjectReadToolName = (typeof PROJECT_READ_TOOL_NAMES)[number];

const projectOnly: Pick<
  CapabilityMetadata,
  "version" | "tier" | "activationClass" | "sideEffectClass" | "allowedScopes" | "executor" | "modelCallable" | "outputSchema"
> = {
  version: "1.0.0",
  tier: "common_read",
  activationClass: "ordinary_task",
  sideEffectClass: "local_read",
  allowedScopes: ["project"],
  executor: "utility",
  modelCallable: true,
  outputSchema: { type: "object" }
};

export const PROJECT_READ_TOOL_METADATA: readonly CapabilityMetadata[] = Object.freeze([
  {
    ...projectOnly,
    id: "read",
    label: "Read Project file",
    description: "Read a text or image file inside the active Project folder. Use material_recall for indexed PDF or Office materials.",
    useWhen: "Use for a known plain-text, source-code, configuration, or image path inside the active Project.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
      required: ["path"]
    }
  },
  {
    ...projectOnly,
    id: "ls",
    label: "List Project directory",
    description: "List files and folders inside the active Project folder.",
    useWhen: "Use to inspect the active Project folder structure before choosing a file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "number" } }
    }
  },
  {
    ...projectOnly,
    id: "find",
    label: "Find Project files",
    description: "Find files by glob pattern inside the active Project folder.",
    useWhen: "Use when the relevant Project filename or subfolder is not yet known.",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" }, limit: { type: "number" } },
      required: ["pattern"]
    }
  },
  {
    ...projectOnly,
    id: "grep",
    label: "Search Project text",
    description: "Search text content inside the active Project folder.",
    useWhen: "Use to locate a word, phrase, symbol, or pattern across readable Project files.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        ignoreCase: { type: "boolean" },
        literal: { type: "boolean" },
        context: { type: "number" },
        limit: { type: "number" }
      },
      required: ["pattern"]
    }
  }
]);

export function isProjectReadToolName(value: string): value is ProjectReadToolName {
  return (PROJECT_READ_TOOL_NAMES as readonly string[]).includes(value);
}
