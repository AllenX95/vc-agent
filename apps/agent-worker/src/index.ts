import {
  IPC_SCHEMA_VERSION,
  workerCommandSchema,
  type CapabilityExecutionResult,
  type TokenUsage,
  type WorkerCommand,
  type WorkerEvent
} from "@vc-agent/contracts";
import { createPiSession, sanitizeProviderFailure, type PiSessionEvent, type PiSessionHandle } from "@vc-agent/pi-adapter";
import { createFauxPiSession } from "@vc-agent/pi-adapter/testing";
import { dogfoodFixtureResponses, dreamSynthesisFixtureResponses, explicitLongTermMemoryFixtureResponses, learningGateRecallFixtureResponses, longTermMemoryFixtureResponses, memoryAwareReflectionContinuationFixtureResponses, memoryAwareReflectionFixtureResponses, reflectionFixtureResponses, unscopedMemoryAwareReflectionContinuationFixtureResponses, unscopedMemoryAwareReflectionFixtureResponses, unscopedReflectionFixtureResponses } from "./dogfood-fixture.js";

const parentPort = process.parentPort;
if (parentPort === undefined) throw new Error("Agent Worker requires an Electron Utility Process parent port");

type ExecuteCommand = Extract<WorkerCommand, { command: "turn.execute" }>;

let session: PiSessionHandle | null = null;
let sessionProfileKey: string | null = null;
let activeCommand: ExecuteCommand | null = null;
let stopRequested = false;
let interruptionSent = false;
let retrievalUsed = false;
let compactionUsed = false;
let retireSessionBeforeNextTurn = false;
let retirementRequiresRebuild = false;
const sequenceByTurn = new Map<string, number>();
const capabilityResolvers = new Map<string, (result: CapabilityExecutionResult) => void>();

type WorkerEventWithoutSequence = WorkerEvent extends infer T
  ? T extends WorkerEvent
    ? Omit<T, "workerSequence">
    : never
  : never;

function send(event: WorkerEventWithoutSequence): void {
  const workerSequence = (sequenceByTurn.get(event.turnId) ?? 0) + 1;
  sequenceByTurn.set(event.turnId, workerSequence);
  parentPort.postMessage({ ...event, workerSequence });
}

parentPort.on("message", (messageEvent) => {
  const parsed = workerCommandSchema.safeParse(messageEvent.data);
  if (!parsed.success) return;
  if (parsed.data.command === "turn.execute") void executeTurn(parsed.data);
  else if (parsed.data.command === "turn.stop") void stopTurn(parsed.data);
  else if (parsed.data.command === "trajectory.acknowledge") acknowledgeTrajectory(parsed.data);
  else resolveCapabilityExecution(parsed.data);
});

async function executeTurn(command: ExecuteCommand): Promise<void> {
  if (activeCommand !== null) {
    send({
      ...workerMetadata(command),
      event: "turn.failed",
      failure: {
        kind: "worker",
        code: "THREAD_TURN_ALREADY_ACTIVE",
        message: "This Thread already has an active Turn.",
        provider: command.profile.provider,
        model: command.profile.model
      }
    });
    return;
  }
  if (retireSessionBeforeNextTurn && session !== null) {
    session.dispose();
    session = null;
    sessionProfileKey = null;
    retireSessionBeforeNextTurn = false;
    retirementRequiresRebuild = false;
  }
  activeCommand = command;
  stopRequested = false;
  interruptionSent = false;
  retrievalUsed = false;
  compactionUsed = false;
  let failureSent = false;
  try {
    if (process.env.NODE_ENV === "test" && command.profile.provider === "vc-agent-reflection-provider-failure-faux") {
      throw new Error(JSON.stringify({ error: { code: "FIXTURE_PROVIDER_REJECTED", message: `Provider rejected credential ${command.profile.apiKey}`, request_id: "req-reflection-fixture" } }));
    }
    const profileKey = `${command.profile.provider}\u0000${command.profile.model}`;
    if (session !== null && sessionProfileKey !== profileKey) {
      session.dispose();
      session = null;
    }
    if (session === null) {
      const sessionConfig = {
          cwd: command.cwd,
          threadDirectory: command.threadDirectory,
          ...(command.previousSessionFile === undefined ? {} : { previousSessionFile: command.previousSessionFile }),
          ...(command.hostHighWater === undefined ? {} : { hostHighWater: command.hostHighWater }),
          contextHistory: command.contextHistory,
          resources: command.resources,
          extensions: command.extensions,
          capabilityProxy: requestCapability
      };
      const onSessionEvent = (event: PiSessionEvent) => {
          if (event.type === "text_delta") {
            send({ ...workerMetadata(command), event: "message.delta", delta: event.delta });
          } else if (event.type === "completed") {
            send({
              ...workerMetadata(command),
              event: "turn.completed",
              message: event.message,
              usage: mapUsage(event.usage),
              ...(event.responseId === undefined ? {} : { responseId: event.responseId }),
              ...(event.piEntryId === undefined ? {} : { piEntryId: event.piEntryId })
            });
          } else if (event.type === "compaction_started") {
            send({ ...workerMetadata(command), event: "thread.compaction.started", reason: event.reason });
          } else if (event.type === "compaction_completed") {
            compactionUsed = true;
            send({
              ...workerMetadata(command),
              event: "thread.compaction.completed",
              reason: event.reason,
              tokensBefore: event.tokensBefore,
              ...(event.estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter: event.estimatedTokensAfter })
            });
          } else if (event.type === "compaction_failed") {
            send({
              ...workerMetadata(command),
              event: "thread.compaction.failed",
              reason: event.reason,
              failure: sanitizeProviderFailure(new Error(event.message), command.profile)
            });
          } else if (!stopRequested) {
            failureSent = true;
            send({
              ...workerMetadata(command),
              event: "turn.failed",
              failure: sanitizeProviderFailure(event.error, command.profile)
            });
          }
      };
      session = (["vc-agent-faux", "vc-agent-memory-faux", "vc-agent-explicit-memory-faux", "vc-agent-learning-recall-faux", "vc-agent-reflection-faux", "vc-agent-reflection-memory-faux", "vc-agent-unscoped-evidence-faux", "vc-agent-unscoped-memory-faux", "vc-agent-dream-synthesis-faux"].includes(command.profile.provider)) && process.env.NODE_ENV === "test"
        ? await createFauxPiSession({ config: sessionConfig, responses: command.profile.provider === "vc-agent-memory-faux" ? longTermMemoryFixtureResponses() : command.profile.provider === "vc-agent-explicit-memory-faux" ? explicitLongTermMemoryFixtureResponses() : command.profile.provider === "vc-agent-learning-recall-faux" ? learningGateRecallFixtureResponses() : command.profile.provider === "vc-agent-reflection-faux" ? reflectionFixtureResponses() : command.profile.provider === "vc-agent-reflection-memory-faux" ? command.contextHistory.length > 0 ? memoryAwareReflectionContinuationFixtureResponses() : memoryAwareReflectionFixtureResponses() : command.profile.provider === "vc-agent-unscoped-evidence-faux" ? unscopedReflectionFixtureResponses() : command.profile.provider === "vc-agent-unscoped-memory-faux" ? command.contextHistory.length > 0 ? unscopedMemoryAwareReflectionContinuationFixtureResponses() : unscopedMemoryAwareReflectionFixtureResponses() : command.profile.provider === "vc-agent-dream-synthesis-faux" ? dreamSynthesisFixtureResponses(command.prompt) : dogfoodFixtureResponses(), onEvent: onSessionEvent })
        : await createPiSession({ ...sessionConfig, profile: command.profile }, onSessionEvent);
      sessionProfileKey = profileKey;
      send({
        ...workerMetadata(command),
        event: "physical_context.ready",
        sessionFile: session.sessionFile,
        reconciliation: session.reconciliation,
        retainedTurnCount: session.retainedTurnCount
      });
    }
    if (stopRequested) {
      sendInterrupted(command, "user_stop");
      return;
    }
    if (command.compactOnly === true) {
      await session.compact("manual");
      return;
    }
    const usableContextTokens = Math.max(0, session.contextWindow - session.maxOutputTokens - 2_048);
    if (command.currentInputTokens > usableContextTokens) {
      failureSent = true;
      send({
        ...workerMetadata(command),
        event: "turn.failed",
        failure: {
          kind: "worker",
          code: "CURRENT_INPUT_EXCEEDS_CONTEXT_BUDGET",
          message: "The current explicit input exceeds this Model Profile's usable context. Narrow the requested material range or choose a larger-context Profile.",
          provider: command.profile.provider,
          model: command.profile.model
        }
      });
      return;
    }
    if (command.estimatedInputTokens > usableContextTokens && command.contextHistory.length > 0) {
      await session.compact("threshold");
    }
    send({ ...workerMetadata(command), event: "turn.started" });
    await session.submit(command.prompt, { activeCapabilities: command.activeCapabilities });
    if (stopRequested) sendInterrupted(command, "user_stop");
  } catch (error) {
    if (stopRequested) sendInterrupted(command, "user_stop");
    else if (!failureSent) {
      send({
        ...workerMetadata(command),
        event: "turn.failed",
        failure: sanitizeProviderFailure(error, command.profile)
      });
    }
  } finally {
    if (retrievalUsed || compactionUsed) {
      retireSessionBeforeNextTurn = true;
      retirementRequiresRebuild = retrievalUsed;
    }
    activeCommand = null;
    stopRequested = false;
  }
}

async function stopTurn(command: Extract<WorkerCommand, { command: "turn.stop" }>): Promise<void> {
  if (activeCommand?.turnId !== command.turnId) return;
  stopRequested = true;
  if (session === null) return;
  await session.abort();
  sendInterrupted(activeCommand, "user_stop");
}

function sendInterrupted(command: ExecuteCommand, reason: "user_stop" | "provider_interrupted"): void {
  if (interruptionSent) return;
  interruptionSent = true;
  send({ ...workerMetadata(command), event: "turn.interrupted", reason });
}

function acknowledgeTrajectory(command: Extract<WorkerCommand, { command: "trajectory.acknowledge" }>): void {
  if (session === null) return;
  if (retirementRequiresRebuild) return;
  session.acknowledge(command.eventId, command.sequence);
  send({ ...workerMetadata(command), event: "trajectory.acknowledged", eventId: command.eventId, sequence: command.sequence });
}

function resolveCapabilityExecution(command: Extract<WorkerCommand, { command: "capability.execution.resolve" }>): void {
  const resolve = capabilityResolvers.get(command.result.requestId);
  if (resolve === undefined) return;
  capabilityResolvers.delete(command.result.requestId);
  resolve(command.result);
}

function requestCapability(
  toolCallId: string,
  capabilityId: string,
  arguments_: Record<string, unknown>,
  signal?: AbortSignal
): Promise<CapabilityExecutionResult> {
  const command = activeCommand;
  if (command === null) {
    return Promise.resolve({ schemaVersion: 1, requestId: crypto.randomUUID(), status: "rejected", code: "TURN_NOT_ACTIVE", content: "The Turn is no longer active." });
  }
  const requestId = crypto.randomUUID();
  const request = {
    schemaVersion: 1 as const,
    requestId,
    correlationId: command.correlationId,
    threadId: command.threadId,
    turnId: command.turnId,
    toolCallId,
    capabilityId,
    scope: command.executionScope,
    arguments: arguments_,
    expectedStateVersion: command.expectedStateVersion,
    actor: { actorType: "agent" as const, actorId: "primary-agent" },
    provenance: { producerType: "agent" as const, producerId: "primary-agent" }
  };
  send({ ...workerMetadata(command), event: "capability.execution.requested", request });
  return new Promise((resolve) => {
    const finish = (result: CapabilityExecutionResult) => {
      if (result.retrieval !== undefined) retrievalUsed = true;
      resolve(result);
    };
    capabilityResolvers.set(requestId, finish);
    const abort = () => {
      if (!capabilityResolvers.delete(requestId)) return;
      finish({ schemaVersion: 1, requestId, status: "rejected", code: "TURN_INTERRUPTED", content: "Capability execution was interrupted." });
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function workerMetadata(command: { correlationId: string; threadId: string; turnId: string }) {
  return {
    schemaVersion: IPC_SCHEMA_VERSION,
    correlationId: command.correlationId,
    threadId: command.threadId,
    turnId: command.turnId
  } as const;
}

function mapUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}): TokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens
  };
}

process.on("disconnect", () => {
  session?.dispose();
  process.exit(0);
});
