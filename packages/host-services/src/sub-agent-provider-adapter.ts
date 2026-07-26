import type {
  SubAgentAdapter,
  SubAgentExecutionInput,
  SubAgentExecutionResult,
  SubAgentProviderExecutionInput,
  SubAgentProviderExecutionResult
} from "./sub-agent-runtime.js";
import { SubAgentContextCompiler, type SubAgentContextBundle } from "./sub-agent-context.js";

/**
 * The desktop layer owns the concrete Worker/Provider transport.  This small
 * interface is the seam consumed by the Host-owned Sub-Agent adapter, keeping
 * credentials, Electron and Pi SDK types out of persisted delegation logic.
 */
export interface SubAgentProviderExecutor {
  execute(input: SubAgentProviderExecutionInput): Promise<SubAgentProviderExecutionResult>;
  terminate?(attemptId: string): Promise<void> | void;
}

export class ProviderSubAgentAdapter implements SubAgentAdapter {
  readonly kind = "provider" as const;
  readonly #executor: SubAgentProviderExecutor;
  readonly #contextCompiler: SubAgentContextCompiler | undefined;

  constructor(executor: SubAgentProviderExecutor, options: { readonly contextCompiler?: SubAgentContextCompiler } = {}) {
    this.#executor = executor;
    this.#contextCompiler = options.contextCompiler;
  }

  async execute(input: SubAgentExecutionInput): Promise<SubAgentExecutionResult> {
    const contextBundle = this.#contextCompiler === undefined ? undefined : await this.#contextCompiler.compile(input.task.contextBoundary);
    const result = await this.#executor.execute({
      attemptId: input.attempt.id,
      runId: input.run.id,
      taskId: input.task.id,
      parentThreadId: input.run.parentThreadId,
      parentTurnId: input.run.parentTurnId,
      profile: input.task.resolvedProfile,
      prompt: buildIsolatedPrompt(input, contextBundle),
      contextBoundary: input.task.contextBoundary,
      capabilitySet: input.task.capabilitySet,
      ...(contextBundle === undefined ? {} : { contextBundle }),
      ...(input.task.outputTarget === undefined ? {} : { outputTarget: input.task.outputTarget }),
      signal: input.signal
    });
    const handoff = result.handoff ?? {
      summary: result.assistantMessage.slice(0, 20_000),
      provenance: input.task.contextBoundary.sourceReferenceIds.map((referenceId) => ({ referenceId, source: "provider" })),
      adoptedByParent: false,
      reviewStatus: "pending_parent_review" as const
    };
    return { ...result, handoff, ...(contextBundle === undefined ? {} : { contextHash: contextBundle.hash }) };
  }

  terminate(attemptId: string): Promise<void> | void {
    return this.#executor.terminate?.(attemptId);
  }
}

function buildIsolatedPrompt(input: SubAgentExecutionInput, contextBundle?: SubAgentContextBundle): string {
  const { task } = input;
  const scope = task.contextBoundary.scope === "project"
    ? `Project scope (${task.contextBoundary.projectId ?? "unavailable"})`
    : "Unscoped Thread scope";
  const references = task.contextBoundary.sourceReferenceIds.length === 0
    ? "(none; do not infer additional sources)"
    : task.contextBoundary.sourceReferenceIds.join(", ");
  const context = contextBundle === undefined || contextBundle.entries.length === 0
    ? "No source body was resolved; do not infer unlisted source content."
    : contextBundle.entries.map((entry) => `[${entry.referenceId} · ${entry.source}]\n${entry.content}`).join("\n\n");
  return [
    "You are an isolated VC Desktop Agent Sub-Agent.",
    "Do not access parent conversation history, sibling tasks, Cognitive Memory, credentials, Skills, or unlisted tools.",
    `Role: ${task.role}`,
    `Scope: ${scope}`,
    `Authorized source references: ${references}`,
    `Context character limit: ${task.contextBoundary.maxChars}`,
    `Authorized capabilities: ${task.capabilitySet.join(", ")}`,
    ...(task.outputTarget === undefined ? [] : [`Authorized output target: ${outputFileName(task.outputTarget)}; use output.write_text only when the objective requires a file.`]),
    `Context bundle: ${contextBundle?.hash ?? "reference-only"}`,
    "",
    "Bounded authorized context:",
    context,
    "",
    "Complete only this bounded objective:",
    task.objective
  ].join("\n");
}

function outputFileName(target: string): string {
  return target.split(/[\\/]/u).at(-1)?.slice(0, 200) ?? "authorized-output";
}
