import {
  IPC_SCHEMA_VERSION,
  normalizeCapabilityExecutionResult,
  workerCommandSchema,
  type CapabilityExecutionResult,
  type TokenUsage,
  type WorkerCommand,
  type WorkerEvent
} from "@vc-agent/contracts";
import {
  sanitizeProviderFailure,
  type PiSessionConfig,
  type PiSessionEvent,
  type PiSessionHandle
} from "@vc-agent/pi-adapter";

const parentPort = process.parentPort;
if (parentPort === undefined) throw new Error("Agent Worker requires an Electron Utility Process parent port");

export type ExecuteCommand = Extract<WorkerCommand, { command: "turn.execute" }>;

export interface AgentWorkerSessionAdapter {
  createSession(input: {
    readonly config: Omit<PiSessionConfig, "profile">;
    readonly command: ExecuteCommand;
    readonly onEvent: (event: PiSessionEvent) => void;
  }): Promise<PiSessionHandle>;
  beforeTurn?(command: ExecuteCommand): Promise<void> | void;
  beforeSubmit?(command: ExecuteCommand): Promise<void> | void;
}

interface WorkerSession {
  session: PiSessionHandle | null;
  sessionProfileKey: string | null;
  activeCommand: ExecuteCommand | null;
  stopRequested: boolean;
  interruptionSent: boolean;
  retrievalUsed: boolean;
  compactionUsed: boolean;
  retireSessionBeforeNextTurn: boolean;
  retirementRequiresRebuild: boolean;
  sequenceByTurn: Map<string, number>;
  capabilityResolvers: Map<string, (result: CapabilityExecutionResult) => void>;
}

const sessions = new Map<string, WorkerSession>();
let sessionAdapter: AgentWorkerSessionAdapter | undefined;

function emptySession(): WorkerSession {
  return {
    session: null,
    sessionProfileKey: null,
    activeCommand: null,
    stopRequested: false,
    interruptionSent: false,
    retrievalUsed: false,
    compactionUsed: false,
    retireSessionBeforeNextTurn: false,
    retirementRequiresRebuild: false,
    sequenceByTurn: new Map(),
    capabilityResolvers: new Map()
  };
}

type WorkerEventWithoutSequence = WorkerEvent extends infer T
  ? T extends WorkerEvent ? Omit<T, "workerSequence"> : never
  : never;

function send(runtime: WorkerSession, event: WorkerEventWithoutSequence): void {
  const workerSequence = (runtime.sequenceByTurn.get(event.turnId) ?? 0) + 1;
  runtime.sequenceByTurn.set(event.turnId, workerSequence);
  parentPort.postMessage({ ...event, workerSequence });
}

export function startAgentWorker(adapter: AgentWorkerSessionAdapter): void {
  if (sessionAdapter !== undefined) throw new Error("Agent Worker already started");
  sessionAdapter = adapter;
  parentPort.on("message", (messageEvent) => {
    const parsed = workerCommandSchema.safeParse(messageEvent.data);
    if (!parsed.success) {
      resolveInvalidCapabilityExecution(messageEvent.data);
      return;
    }
    if (parsed.data.command === "turn.execute") void executeTurn(parsed.data);
    else if (parsed.data.command === "turn.stop") void stopTurn(parsed.data);
    else if (parsed.data.command === "trajectory.acknowledge") acknowledgeTrajectory(parsed.data);
    else resolveCapabilityExecution(parsed.data);
  });
  parentPort.postMessage({ schemaVersion: IPC_SCHEMA_VERSION, event: "worker.ready" });
}

async function executeTurn(command: ExecuteCommand): Promise<void> {
  const runtime = sessions.get(command.threadId) ?? emptySession();
  sessions.set(command.threadId, runtime);
  if (runtime.activeCommand !== null) {
    send(runtime, {
      ...workerMetadata(command),
      event: "turn.failed",
      failure: {
        kind: "worker",
        code: "THREAD_SESSION_ALREADY_ACTIVE",
        message: "This Thread already has an active Turn.",
        provider: command.profile.provider,
        model: command.profile.model
      }
    });
    return;
  }
  if (runtime.retireSessionBeforeNextTurn && runtime.session !== null) {
    runtime.session.dispose();
    runtime.session = null;
    runtime.sessionProfileKey = null;
    runtime.retireSessionBeforeNextTurn = false;
    runtime.retirementRequiresRebuild = false;
  }
  runtime.activeCommand = command;
  runtime.stopRequested = false;
  runtime.interruptionSent = false;
  runtime.retrievalUsed = false;
  runtime.compactionUsed = false;
  let failureSent = false;
  try {
    await sessionAdapter!.beforeTurn?.(command);
    const profileKey = [
      command.profile.provider,
      command.profile.model,
      command.profile.thinkingLevel,
      command.profile.contextWindow ?? "catalog",
      command.profile.maxOutputTokens ?? "catalog"
    ].join("\u0000");
    if (runtime.session !== null && runtime.sessionProfileKey !== profileKey) {
      runtime.session.dispose();
      runtime.session = null;
    }
    if (runtime.session === null) {
      const sessionConfig = {
        cwd: command.cwd,
        threadDirectory: command.threadDirectory,
        ...(command.previousSessionFile === undefined ? {} : { previousSessionFile: command.previousSessionFile }),
        ...(command.hostHighWater === undefined ? {} : { hostHighWater: command.hostHighWater }),
        contextHistory: command.contextHistory,
        resources: command.resources,
        extensions: command.extensions,
        capabilityProxy: (toolCallId: string, capabilityId: string, arguments_: Record<string, unknown>, signal?: AbortSignal) => requestCapability(runtime, toolCallId, capabilityId, arguments_, signal)
      };
      const onSessionEvent = (event: PiSessionEvent) => {
        // A Pi session may be reused for multiple turns. Resolve the command
        // at event time so the callback cannot keep tagging later events with
        // the first turn that created the session.
        const activeCommand = runtime.activeCommand;
        if (activeCommand === null) return;
        if (event.type === "text_delta") {
          send(runtime, { ...workerMetadata(activeCommand), event: "message.delta", delta: event.delta });
        } else if (event.type === "thinking_delta") {
          send(runtime, { ...workerMetadata(activeCommand), event: "thinking.delta", delta: event.delta });
        } else if (event.type === "completed") {
          send(runtime, {
            ...workerMetadata(activeCommand), event: "turn.completed", message: event.message, usage: mapUsage(event.usage),
            ...(event.contextUsage === undefined ? {} : { contextUsage: event.contextUsage }),
            ...(event.responseId === undefined ? {} : { responseId: event.responseId }),
            ...(event.piEntryId === undefined ? {} : { piEntryId: event.piEntryId })
          });
        } else if (event.type === "compaction_started") {
          send(runtime, { ...workerMetadata(activeCommand), event: "thread.compaction.started", reason: event.reason });
        } else if (event.type === "compaction_completed") {
          runtime.compactionUsed = true;
          send(runtime, {
            ...workerMetadata(activeCommand), event: "thread.compaction.completed", reason: event.reason, tokensBefore: event.tokensBefore,
            ...(event.estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter: event.estimatedTokensAfter })
          });
        } else if (event.type === "compaction_failed") {
          send(runtime, { ...workerMetadata(activeCommand), event: "thread.compaction.failed", reason: event.reason, failure: sanitizeProviderFailure(new Error(event.message), activeCommand.profile) });
        } else if (!runtime.stopRequested) {
          failureSent = true;
          send(runtime, { ...workerMetadata(activeCommand), event: "turn.failed", failure: sanitizeProviderFailure(event.error, activeCommand.profile) });
        }
      };
      runtime.session = await sessionAdapter!.createSession({ config: sessionConfig, command, onEvent: onSessionEvent });
      runtime.sessionProfileKey = profileKey;
      const contextUsage = runtime.session.getContextUsage();
      send(runtime, {
        ...workerMetadata(command), event: "physical_context.ready", sessionFile: runtime.session.sessionFile,
        reconciliation: runtime.session.reconciliation, retainedTurnCount: runtime.session.retainedTurnCount,
        ...(contextUsage === undefined ? {} : { contextUsage })
      });
    }
    if (runtime.stopRequested) { sendInterrupted(runtime, command, "user_stop"); return; }
    if (command.compactOnly === true) { await runtime.session!.compact("manual"); return; }
    const usableContextTokens = Math.max(0, runtime.session!.contextWindow - runtime.session!.maxOutputTokens - 2_048);
    if (command.currentInputTokens > usableContextTokens) {
      failureSent = true;
      send(runtime, {
        ...workerMetadata(command), event: "turn.failed",
        failure: {
          kind: "worker", code: "CURRENT_INPUT_EXCEEDS_CONTEXT_BUDGET",
          message: "The current explicit input exceeds this Model Profile's usable context. Narrow the requested material range or choose a larger-context Profile.",
          provider: command.profile.provider, model: command.profile.model
        }
      });
      return;
    }
    if (command.estimatedInputTokens > usableContextTokens && command.contextHistory.length > 0) await runtime.session!.compact("threshold");
    send(runtime, { ...workerMetadata(command), event: "turn.started" });
    await sessionAdapter!.beforeSubmit?.(command);
    if (runtime.stopRequested) { sendInterrupted(runtime, command, "user_stop"); return; }
    await runtime.session!.submit(command.prompt, {
      ...(command.capabilitySurface === undefined ? {} : { capabilitySurface: command.capabilitySurface }),
      activeCapabilities: command.activeCapabilities
    });
    if (runtime.stopRequested) sendInterrupted(runtime, command, "user_stop");
  } catch (error) {
    if (runtime.stopRequested) sendInterrupted(runtime, command, "user_stop");
    else if (!failureSent) send(runtime, { ...workerMetadata(command), event: "turn.failed", failure: sanitizeProviderFailure(error, command.profile) });
  } finally {
    if (runtime.retrievalUsed || runtime.compactionUsed) {
      runtime.retireSessionBeforeNextTurn = true;
      runtime.retirementRequiresRebuild = runtime.retrievalUsed;
    }
    runtime.activeCommand = null;
    runtime.stopRequested = false;
  }
}

async function stopTurn(command: Extract<WorkerCommand, { command: "turn.stop" }>): Promise<void> {
  const runtime = sessions.get(command.threadId);
  if (runtime?.activeCommand?.turnId !== command.turnId) return;
  runtime.stopRequested = true;
  if (runtime.session === null) return;
  await runtime.session.abort();
  sendInterrupted(runtime, runtime.activeCommand, "user_stop");
}

function sendInterrupted(runtime: WorkerSession, command: ExecuteCommand, reason: "user_stop" | "provider_interrupted"): void {
  if (runtime.interruptionSent) return;
  runtime.interruptionSent = true;
  send(runtime, { ...workerMetadata(command), event: "turn.interrupted", reason });
}

function acknowledgeTrajectory(command: Extract<WorkerCommand, { command: "trajectory.acknowledge" }>): void {
  const runtime = sessions.get(command.threadId);
  if (runtime?.session === null || runtime === undefined || runtime.retirementRequiresRebuild) return;
  runtime.session.acknowledge(command.eventId, command.sequence);
  send(runtime, { ...workerMetadata(command), event: "trajectory.acknowledged", eventId: command.eventId, sequence: command.sequence });
}

function resolveCapabilityExecution(command: Extract<WorkerCommand, { command: "capability.execution.resolve" }>): void {
  const runtime = sessions.get(command.threadId);
  const resolve = runtime?.capabilityResolvers.get(command.result.requestId);
  if (resolve === undefined || runtime === undefined) return;
  runtime.capabilityResolvers.delete(command.result.requestId);
  resolve(command.result);
}

function resolveInvalidCapabilityExecution(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const candidate = value as Record<string, unknown>;
  if (candidate.command !== "capability.execution.resolve" || typeof candidate.threadId !== "string") return;
  const result = normalizeCapabilityExecutionResult(candidate.result);
  const runtime = sessions.get(candidate.threadId);
  const resolve = runtime?.capabilityResolvers.get(result.requestId);
  if (resolve === undefined || runtime === undefined) return;
  runtime.capabilityResolvers.delete(result.requestId);
  resolve(result);
}

function requestCapability(runtime: WorkerSession, toolCallId: string, capabilityId: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityExecutionResult> {
  const command = runtime.activeCommand;
  if (command === null) return Promise.resolve({ schemaVersion: 1, requestId: crypto.randomUUID(), status: "rejected", code: "TURN_NOT_ACTIVE", content: "The Turn is no longer active." });
  const requestId = crypto.randomUUID();
  const request = {
    schemaVersion: 1 as const, requestId, correlationId: command.correlationId, threadId: command.threadId, turnId: command.turnId,
    toolCallId, capabilityId, scope: command.executionScope, arguments: arguments_, expectedStateVersion: command.expectedStateVersion,
    actor: { actorType: "agent" as const, actorId: "primary-agent" }, provenance: { producerType: "agent" as const, producerId: "primary-agent" }
  };
  send(runtime, { ...workerMetadata(command), event: "capability.execution.requested", request });
  return new Promise((resolve) => {
    const finish = (result: CapabilityExecutionResult) => { if (result.retrieval !== undefined) runtime.retrievalUsed = true; resolve(result); };
    runtime.capabilityResolvers.set(requestId, finish);
    const abort = () => {
      if (!runtime.capabilityResolvers.delete(requestId)) return;
      finish({ schemaVersion: 1, requestId, status: "rejected", code: "TURN_INTERRUPTED", content: "Capability execution was interrupted." });
    };
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}

function workerMetadata(command: { correlationId: string; threadId: string; turnId: string; ownerKey?: string | undefined; workerRevision?: string | undefined; sessionKey?: string | undefined }) {
  return {
    schemaVersion: IPC_SCHEMA_VERSION, correlationId: command.correlationId, threadId: command.threadId, turnId: command.turnId,
    ...(command.ownerKey === undefined ? {} : { ownerKey: command.ownerKey }),
    ...(command.workerRevision === undefined ? {} : { workerRevision: command.workerRevision }),
    ...(command.sessionKey === undefined ? {} : { sessionKey: command.sessionKey })
  } as const;
}

function mapUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; totalTokens: number }): TokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    totalTokens: usage.totalTokens
  };
}

process.on("disconnect", () => {
  for (const runtime of sessions.values()) runtime.session?.dispose();
  process.exit(0);
});
