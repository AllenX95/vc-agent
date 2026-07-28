import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
type ProjectToolDefinition = ToolDefinition<any, any, any>;

/**
 * Reuses Pi's mature read-only tools while owning the security boundary here.
 * Every invocation is checked after resolving junctions/symlinks, so an
 * absolute path or an in-Project link cannot escape the active Project root.
 */
export function createProjectReadToolDefinitions(projectRoot: string): ProjectToolDefinition[] {
  const definitions = [
    createReadToolDefinition(projectRoot),
    createLsToolDefinition(projectRoot),
    createFindToolDefinition(projectRoot),
    createGrepToolDefinition(projectRoot)
  ];
  return definitions.map((definition) => scopeDefinition(definition, projectRoot));
}

function scopeDefinition(definition: ProjectToolDefinition, projectRoot: string): ProjectToolDefinition {
  const execute = definition.execute.bind(definition);
  return {
    ...definition,
    description: `${definition.description} Paths are restricted to the active Project folder. For indexed PDF or Office materials, use material_recall.`,
    promptGuidelines: [
      ...(definition.promptGuidelines ?? []),
      "All read, list, find, and grep paths must remain inside the active Project folder.",
      "Use material_recall for indexed PDF or Office materials; do not treat public web search as a substitute for Project files."
    ],
    execute: async (toolCallId, params, signal, onUpdate, context) => {
      const candidate = pathFromParameters(params);
      await assertInsideProject(projectRoot, candidate);
      return execute(toolCallId, params, signal, onUpdate, context);
    }
  };
}

function pathFromParameters(params: unknown): string {
  if (typeof params !== "object" || params === null) return ".";
  const path = (params as { path?: unknown }).path;
  return typeof path === "string" && path.trim().length > 0 ? path : ".";
}

async function assertInsideProject(projectRoot: string, requestedPath: string): Promise<void> {
  const [root, candidate] = await Promise.all([
    realpath(resolve(projectRoot)),
    realpath(resolve(projectRoot, requestedPath))
  ]);
  const relativePath = relative(root, candidate);
  if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\") || isAbsolute(relativePath)) {
    throw new Error("The requested path resolves outside the active Project folder.");
  }
}
