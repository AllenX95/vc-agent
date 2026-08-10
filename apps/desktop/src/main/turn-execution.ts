import type { TurnCapabilitySurfaceSnapshot } from "@vc-agent/capabilities";
import type {
  DreamExtractionScope,
  ModelProfile,
  SystemPromptRevision,
  WorkerCommand
} from "@vc-agent/contracts";
import type { CitationRegistry, DreamSynthesisInput } from "@vc-agent/host-services";

type ExecuteCommand = Extract<WorkerCommand, { command: "turn.execute" }>;
type StartFailureHandler = (error: unknown) => void;

export interface TurnContext {
  readonly correlationId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly text: string;
  readonly profile: ModelProfile;
  readonly outputIntent: boolean;
  readonly memoryRecallMode: "none" | "automatic" | "explicit";
  readonly longTermMemoryCardIds: Set<string>;
  readonly activeCapabilities: string[];
  readonly executableCapabilityIds: string[];
  readonly capabilitySurface: TurnCapabilitySurfaceSnapshot;
  readonly citations: CitationRegistry;
  readonly expectedStateVersion: number;
  readonly promptRevision: SystemPromptRevision;
  readonly retryOfTurnId?: string;
  readonly compactionOnly?: true;
  readonly reflectionRunId?: string;
  readonly reflectionOutcomeIntent: boolean;
  readonly appendSystemPrompt?: readonly string[];
  readonly submittedAtMs: number;
  recalledStateEstimatedTokens: number;
  recallBodyBytes: number;
  capabilityActivationCount: number;
}

export interface ReflectionExecutionContext {
  readonly correlationId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly scope: "project" | "unscoped";
  readonly projectId?: string;
  readonly activeCapabilities: readonly string[];
  readonly outputLocation?: string;
  readonly profile: ModelProfile;
  readonly expectedStateVersion: number;
  readonly promptRevision: SystemPromptRevision;
}

export interface DreamExecutionContext {
  readonly correlationId: string;
  readonly batchId: string;
  readonly scope: DreamExtractionScope;
  readonly executionThreadId: string;
  readonly turnId: string;
  readonly profile: ModelProfile;
  readonly allowedSourceReferences: readonly string[];
}

export interface DreamSynthesisExecutionContext {
  readonly correlationId: string;
  readonly batchId: string;
  readonly executionThreadId: string;
  readonly turnId: string;
  readonly profile: ModelProfile;
  readonly input: DreamSynthesisInput;
  readonly forbiddenTerms: readonly string[];
}

export type TurnExecution =
  | { readonly kind: "turn"; readonly context: TurnContext }
  | { readonly kind: "reflection"; readonly context: ReflectionExecutionContext }
  | { readonly kind: "dream"; readonly context: DreamExecutionContext }
  | { readonly kind: "dream_synthesis"; readonly context: DreamSynthesisExecutionContext };

/**
 * Owns Host-side execution identity, admission invariants, Worker dispatch, event
 * routing, and lifecycle cleanup. Callers keep domain-specific event handling.
 */
export class HostTurnExecutionModule {
  readonly #executions = new Map<string, TurnExecution>();
  readonly #activeTurnByThread = new Map<string, string>();

  constructor(
    private readonly execute: (command: ExecuteCommand) => Promise<void>
  ) {}

  start(execution: TurnExecution, command: ExecuteCommand, onFailure: StartFailureHandler): void {
    const executionThreadId = execution.kind === "dream" || execution.kind === "dream_synthesis"
      ? execution.context.executionThreadId
      : execution.context.threadId;
    if (
      command.turnId !== execution.context.turnId
      || command.threadId !== executionThreadId
      || command.correlationId !== execution.context.correlationId
    ) {
      throw new Error("Turn execution command identity does not match its Host context.");
    }
    if (this.#executions.has(execution.context.turnId)) {
      throw new Error(`Turn execution ${execution.context.turnId} is already active.`);
    }
    if (execution.kind === "turn" && this.#activeTurnByThread.has(execution.context.threadId)) {
      throw new Error(`Thread ${execution.context.threadId} already has an active Turn.`);
    }

    this.#executions.set(execution.context.turnId, execution);
    if (execution.kind === "turn") this.#activeTurnByThread.set(execution.context.threadId, execution.context.turnId);

    void Promise.resolve()
      .then(() => this.execute(command))
      .catch((error: unknown) => {
        if (this.#executions.get(execution.context.turnId) === execution) onFailure(error);
      });
  }

  route(turnId: string): TurnExecution | undefined {
    return this.#executions.get(turnId);
  }

  getTurn(turnId: string): TurnContext | undefined {
    const execution = this.#executions.get(turnId);
    return execution?.kind === "turn" ? execution.context : undefined;
  }

  findReflection(runId: string): ReflectionExecutionContext | undefined {
    for (const execution of this.#executions.values()) {
      if (execution.kind === "reflection" && execution.context.runId === runId) return execution.context;
    }
    return undefined;
  }

  isThreadActive(threadId: string): boolean {
    return this.#activeTurnByThread.has(threadId);
  }

  isActive(execution: TurnExecution): boolean {
    const active = this.#executions.get(execution.context.turnId);
    return active?.kind === execution.kind && active.context === execution.context;
  }

  finish(execution: TurnExecution): boolean {
    if (!this.isActive(execution)) return false;
    this.#executions.delete(execution.context.turnId);
    if (
      execution.kind === "turn"
      && this.#activeTurnByThread.get(execution.context.threadId) === execution.context.turnId
    ) {
      this.#activeTurnByThread.delete(execution.context.threadId);
    }
    return true;
  }

  activeExecutions(): readonly TurnExecution[] {
    return [...this.#executions.values()];
  }

}
