import { utilityProcess, type UtilityProcess } from "electron";
import { workerEventSchema, type WorkerCommand, type WorkerEvent } from "@vc-agent/contracts";

interface WorkerRecord {
  readonly process: UtilityProcess;
  readonly spawned: Promise<void>;
  sessionStarted: boolean;
  activeCommand?: Extract<WorkerCommand, { command: "turn.execute" }>;
  lastWorkerSequence: number;
}

export interface WorkerActivity {
  readonly agentWorkersStarted: number;
  readonly piSessionsStarted: number;
  readonly providerRequests: number;
}

export class AgentWorkerSupervisor {
  readonly #workerEntry: string;
  readonly #onEvent: (event: WorkerEvent) => void;
  readonly #workers = new Map<string, WorkerRecord>();
  #agentWorkersStarted = 0;
  #piSessionsStarted = 0;
  #providerRequests = 0;

  constructor(workerEntry: string, onEvent: (event: WorkerEvent) => void) {
    this.#workerEntry = workerEntry;
    this.#onEvent = onEvent;
  }

  get activity(): WorkerActivity {
    return {
      agentWorkersStarted: this.#agentWorkersStarted,
      piSessionsStarted: this.#piSessionsStarted,
      providerRequests: this.#providerRequests
    };
  }

  async execute(command: Extract<WorkerCommand, { command: "turn.execute" }>): Promise<void> {
    const record = this.#workers.get(command.threadId) ?? this.#startWorker(command.threadId);
    record.activeCommand = command;
    await record.spawned;
    record.process.postMessage(command);
  }

  stop(command: Extract<WorkerCommand, { command: "turn.stop" }>): void {
    this.#workers.get(command.threadId)?.process.postMessage(command);
  }

  acknowledge(command: Extract<WorkerCommand, { command: "trajectory.acknowledge" }>): void {
    this.#workers.get(command.threadId)?.process.postMessage(command);
  }

  resolveCapability(command: Extract<WorkerCommand, { command: "capability.execution.resolve" }>): void {
    this.#workers.get(command.threadId)?.process.postMessage(command);
  }

  #startWorker(threadId: string): WorkerRecord {
    const child = utilityProcess.fork(this.#workerEntry, [], {
      serviceName: `vc-agent-unscoped-${threadId}`,
      stdio: "ignore"
    });
    let resolveSpawn!: () => void;
    let rejectSpawn!: (error: Error) => void;
    const spawned = new Promise<void>((resolve, reject) => {
      resolveSpawn = resolve;
      rejectSpawn = reject;
    });
    const record: WorkerRecord = { process: child, spawned, sessionStarted: false, lastWorkerSequence: 0 };
    this.#workers.set(threadId, record);
    this.#agentWorkersStarted += 1;

    child.once("spawn", resolveSpawn);
    child.on("message", (rawEvent) => {
      const parsed = workerEventSchema.safeParse(rawEvent);
      if (!parsed.success) return;
      record.lastWorkerSequence = Math.max(record.lastWorkerSequence, parsed.data.workerSequence);
      if (parsed.data.event === "turn.started") {
        if (!record.sessionStarted) {
          record.sessionStarted = true;
          this.#piSessionsStarted += 1;
        }
        this.#providerRequests += 1;
      }
      if (parsed.data.event === "turn.completed" || parsed.data.event === "turn.failed" || parsed.data.event === "turn.interrupted") {
        delete record.activeCommand;
      }
      this.#onEvent(parsed.data);
    });
    child.once("error", (error) => rejectSpawn(new Error(error)));
    child.once("exit", (code) => {
      this.#workers.delete(threadId);
      const active = record.activeCommand;
      if (active !== undefined) {
        this.#onEvent({
          schemaVersion: 1,
          correlationId: active.correlationId,
          threadId: active.threadId,
          turnId: active.turnId,
          workerSequence: record.lastWorkerSequence + 1,
          event: "turn.failed",
          failure: {
            kind: "worker",
            code: "WORKER_EXITED",
            message: `Agent Worker exited before completion${code === null ? "" : ` (code ${code})`}.`,
            provider: active.profile.provider,
            model: active.profile.model
          }
        });
      }
    });
    return record;
  }

  closeAll(): void {
    for (const record of this.#workers.values()) record.process.kill();
    this.#workers.clear();
  }
}
