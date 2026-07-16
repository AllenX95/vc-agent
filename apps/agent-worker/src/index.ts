import {
  IPC_SCHEMA_VERSION,
  workerCommandSchema,
  type TokenUsage,
  type WorkerCommand,
  type WorkerEvent
} from "@vc-agent/contracts";
import { createPiSession, sanitizeProviderFailure, type PiSessionHandle } from "@vc-agent/pi-adapter";

const parentPort = process.parentPort;
if (parentPort === undefined) throw new Error("Agent Worker requires an Electron Utility Process parent port");

type ExecuteCommand = Extract<WorkerCommand, { command: "turn.execute" }>;

let session: PiSessionHandle | null = null;
let sessionProfileKey: string | null = null;
let activeCommand: ExecuteCommand | null = null;
let stopRequested = false;
let interruptionSent = false;
const sequenceByTurn = new Map<string, number>();

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
  else acknowledgeTrajectory(parsed.data);
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
  activeCommand = command;
  stopRequested = false;
  interruptionSent = false;
  let failureSent = false;
  try {
    const profileKey = `${command.profile.provider}\u0000${command.profile.model}`;
    if (session !== null && sessionProfileKey !== profileKey) {
      session.dispose();
      session = null;
    }
    if (session === null) {
      session = await createPiSession(
        {
          cwd: command.cwd,
          threadDirectory: command.threadDirectory,
          ...(command.previousSessionFile === undefined ? {} : { previousSessionFile: command.previousSessionFile }),
          ...(command.hostHighWater === undefined ? {} : { hostHighWater: command.hostHighWater }),
          contextHistory: command.contextHistory,
          profile: command.profile,
          resources: command.resources,
          extensions: command.extensions
        },
        (event) => {
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
          } else if (!stopRequested) {
            failureSent = true;
            send({
              ...workerMetadata(command),
              event: "turn.failed",
              failure: sanitizeProviderFailure(event.error, command.profile)
            });
          }
        }
      );
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
    send({ ...workerMetadata(command), event: "turn.started" });
    await session.submit(command.prompt);
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
  session.acknowledge(command.eventId, command.sequence);
  send({ ...workerMetadata(command), event: "trajectory.acknowledged", eventId: command.eventId, sequence: command.sequence });
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
