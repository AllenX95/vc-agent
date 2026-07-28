import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  SubAgentAdapter,
  SubAgentExecutionInput,
  SubAgentExecutionResult
} from "./sub-agent-runtime.js";

/** Deterministic adapter used by local tests and acceptance gates; it never calls a Provider. */
export class FixtureSubAgentAdapter implements SubAgentAdapter {
  readonly kind = "fixture" as const;
  readonly #delayMs: number;

  constructor(input: { delayMs?: number } = {}) {
    this.#delayMs = input.delayMs ?? 0;
  }

  async execute(input: SubAgentExecutionInput): Promise<SubAgentExecutionResult> {
    if (this.#delayMs > 0) {
      await new Promise<void>((resolvePromise, reject) => {
        const timer = setTimeout(resolvePromise, this.#delayMs);
        input.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("SUB_AGENT_STOPPED"));
        }, { once: true });
      });
    }
    if (input.signal.aborted) throw new Error("SUB_AGENT_STOPPED");
    const digest = createHash("sha256").update(`${input.task.role}:${input.task.objective}`).digest("hex").slice(0, 12);
    const outputPath = input.task.outputTarget;
    if (outputPath !== undefined) {
      mkdirSync(dirname(outputPath), { recursive: true });
      const partial = `${outputPath}.partial`;
      writeFileSync(partial, `# Fixture Sub-Agent Output\n\n${sanitizeText(input.task.objective, 2_000)}\n`, "utf8");
      renameSync(partial, outputPath);
    }
    return {
      assistantMessage: `Fixture ${input.task.role} result ${digest}: ${input.task.objective.slice(0, 500)}`,
      usage: {
        inputTokens: Math.max(1, Math.ceil(input.task.objective.length / 4)),
        outputTokens: 48,
        totalTokens: Math.max(1, Math.ceil(input.task.objective.length / 4)) + 48
      },
      ...(outputPath === undefined ? {} : {
        handoff: {
          summary: `Fixture output for ${input.task.role}.`,
          provenance: [{ referenceId: `sub-agent:${input.attempt.id}`, source: "fixture" }],
          outputPath,
          adoptedByParent: false,
          reviewStatus: "pending_parent_review" as const
        }
      }),
      toolEvents: input.task.capabilitySet.map((capability) => ({
        capability,
        status: "completed" as const,
        summary: "Fixture capability completed without external I/O."
      }))
    };
  }
}

function sanitizeText(value: string, max: number): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/giu, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/(?:[A-Za-z]:\\|\\\\|\/Users\/|\/home\/)[^\s"']+/gu, "[path redacted]")
    .slice(0, max);
}
