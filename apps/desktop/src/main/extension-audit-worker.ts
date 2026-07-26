import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ThinkingLevel, WorkerCommand, WorkerEvent } from "@vc-agent/contracts";

type ExecuteCommand = Extract<WorkerCommand, { command: "turn.execute" }>;

interface ExtensionAuditWorkerSupervisor {
  execute(command: ExecuteCommand): Promise<void>;
  stop(command: Extract<WorkerCommand, { command: "turn.stop" }>): void;
  resolveCapability(command: Extract<WorkerCommand, { command: "capability.execution.resolve" }>): void;
  retire(ownerKeyOrThreadId: string): void;
}

export interface ExtensionAuditWorkerRequest {
  readonly auditRunId: string;
  readonly instructionsRevision: string;
  readonly profile: {
    readonly provider: string;
    readonly model: string;
    readonly apiKey: string;
    readonly thinkingLevel: ThinkingLevel;
  };
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
}

interface PendingAudit {
  readonly threadId: string;
  readonly turnId: string;
  readonly correlationId: string;
  readonly resolve: (message: string) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal;
  readonly abort: () => void;
  settled: boolean;
}

/**
 * Owns isolated Extension Audit Agent Worker sessions.
 *
 * Audit sessions use a synthetic Unscoped owner, a dedicated session
 * directory, no ordinary Thread history, no Skills, no Extensions, and no
 * capabilities. Their events are consumed here before the ordinary Turn
 * dispatcher can observe them.
 */
export class ExtensionAuditWorkerExecutor {
  readonly #supervisor: ExtensionAuditWorkerSupervisor;
  readonly #root: string;
  readonly #pending = new Map<string, PendingAudit>();

  constructor(input: { readonly supervisor: ExtensionAuditWorkerSupervisor; readonly root: string }) {
    this.#supervisor = input.supervisor;
    this.#root = resolve(input.root);
  }

  async execute(input: ExtensionAuditWorkerRequest): Promise<string> {
    if (input.signal.aborted) throw new Error("EXTENSION_AUDIT_ABORTED");
    const threadId = `extension-audit-${input.auditRunId}`;
    const turnId = randomUUID();
    const correlationId = randomUUID();
    const threadDirectory = join(this.#root, input.auditRunId);
    mkdirSync(threadDirectory, { recursive: true });

    const result = new Promise<string>((resolvePromise, rejectPromise) => {
      const pending: PendingAudit = {
        threadId,
        turnId,
        correlationId,
        resolve: resolvePromise,
        reject: rejectPromise,
        signal: input.signal,
        abort: () => {
          const current = this.#pending.get(turnId);
          if (current === undefined || current.settled) return;
          current.settled = true;
          current.reject(new Error("EXTENSION_AUDIT_ABORTED"));
          this.#supervisor.stop({ schemaVersion: 1, command: "turn.stop", commandId: randomUUID(), correlationId, threadId, turnId });
        },
        settled: false
      };
      this.#pending.set(turnId, pending);
      input.signal.addEventListener("abort", pending.abort, { once: true });
    });

    const command: ExecuteCommand = {
      schemaVersion: 1,
      command: "turn.execute",
      commandId: randomUUID(),
      correlationId,
      threadId,
      turnId,
      workerRevision: "extension-audit-worker-v1",
      sessionKey: `extension-audit:${input.auditRunId}`,
      cwd: threadDirectory,
      threadDirectory,
      contextHistory: [],
      estimatedInputTokens: estimateTokens(input.systemPrompt) + estimateTokens(input.prompt),
      currentInputTokens: estimateTokens(input.prompt),
      activeCapabilities: [],
      expectedStateVersion: 1,
      executionScope: { kind: "unscoped", threadId },
      prompt: input.prompt,
      profile: input.profile,
      resources: {
        schemaVersion: 1,
        revisionId: input.instructionsRevision,
        systemPrompt: input.systemPrompt,
        appendSystemPrompt: []
      },
      extensions: { schemaVersion: 1, revisionId: "extension-audit-empty-v1", enabled: [] }
    };

    try {
      await this.#supervisor.execute(command);
    } catch (error) {
      this.#finish(turnId, error instanceof Error ? error : new Error("EXTENSION_AUDIT_WORKER_FAILED"));
    }
    return result;
  }

  handleEvent(event: WorkerEvent): boolean {
    const pending = this.#pending.get(event.turnId);
    if (pending === undefined) return false;
    if (event.event === "capability.execution.requested") {
      this.#supervisor.resolveCapability({
        schemaVersion: 1,
        command: "capability.execution.resolve",
        commandId: randomUUID(),
        correlationId: pending.correlationId,
        threadId: pending.threadId,
        turnId: pending.turnId,
        result: {
          schemaVersion: 1,
          requestId: event.request.requestId,
          status: "rejected",
          code: "EXTENSION_AUDIT_CAPABILITY_NOT_ALLOWED",
          content: "Extension Audit receives one bounded snapshot and cannot invoke tools."
        }
      });
      return true;
    }
    if (event.event === "turn.completed") {
      this.#finish(event.turnId, undefined, event.message);
      return true;
    }
    if (event.event === "turn.failed") {
      this.#finish(event.turnId, new Error(event.failure.code));
      return true;
    }
    if (event.event === "turn.interrupted") {
      this.#finish(event.turnId, new Error("EXTENSION_AUDIT_INTERRUPTED"));
      return true;
    }
    return true;
  }

  #finish(turnId: string, error?: Error, message?: string): void {
    const pending = this.#pending.get(turnId);
    if (pending === undefined) return;
    this.#pending.delete(turnId);
    pending.signal.removeEventListener("abort", pending.abort);
    if (!pending.settled) {
      pending.settled = true;
      if (error !== undefined) pending.reject(error);
      else pending.resolve(message ?? "");
    }
    this.#supervisor.retire(pending.threadId);
  }
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}
