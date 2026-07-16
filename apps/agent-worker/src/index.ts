import { IPC_SCHEMA_VERSION, workerCommandSchema, type TokenUsage, type WorkerEvent } from "@vc-agent/contracts";
import { createPiSession, sanitizeProviderFailure, type PiSessionHandle } from "@vc-agent/pi-adapter";

const parentPort = process.parentPort;
if (parentPort === undefined) throw new Error("Agent Worker requires an Electron Utility Process parent port");

let session: PiSessionHandle | null = null;
let sessionProfileKey: string | null = null;

function send(event: WorkerEvent): void {
  parentPort.postMessage(event);
}

parentPort.on("message", (messageEvent) => {
  const parsed = workerCommandSchema.safeParse(messageEvent.data);
  if (!parsed.success) return;
  void executeTurn(parsed.data);
});

async function executeTurn(command: ReturnType<typeof workerCommandSchema.parse>): Promise<void> {
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
              ...(event.responseId === undefined ? {} : { responseId: event.responseId })
            });
          } else {
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
    }
    send({ ...workerMetadata(command), event: "turn.started" });
    await session.submit(command.prompt);
  } catch (error) {
    if (!failureSent) {
      send({
        ...workerMetadata(command),
        event: "turn.failed",
        failure: sanitizeProviderFailure(error, command.profile)
      });
    }
  }
}

function workerMetadata(command: ReturnType<typeof workerCommandSchema.parse>) {
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
