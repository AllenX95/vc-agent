import { utilityProcess, type UtilityProcess } from "electron";
import { workerEventSchema, type WorkerCommand, type WorkerEvent } from "@vc-agent/contracts";

type ExecuteCommand = Extract<WorkerCommand, { command: "turn.execute" }>;

interface SessionRecord {
  readonly sessionKey: string;
  activeCommand?: ExecuteCommand;
  sessionStarted: boolean;
  readonly lastWorkerSequenceByTurn: Map<string, number>;
}

interface WorkerRecord {
  readonly ownerKey: string;
  readonly workerRevision: string;
  readonly process: UtilityProcess;
  readonly spawned: Promise<void>;
  readonly sessions: Map<string, SessionRecord>;
}

export interface WorkerActivity {
  readonly agentWorkersStarted: number;
  readonly piSessionsStarted: number;
  readonly providerRequests: number;
  readonly projectWorkers: number;
  readonly unscopedWorkers: number;
  readonly activeSessions: number;
  readonly workerCrashes: number;
}

/**
 * Electron adapter for the Host-owned Project/Unscoped Worker runtime.
 * Worker identity is derived from stable scope identity; Thread ids only
 * select a session inside a Project Worker.
 */
export class AgentWorkerSupervisor {
  readonly #workerEntry: string;
  readonly #onEvent: (event: WorkerEvent) => void;
  readonly #workers = new Map<string, WorkerRecord>();
  #agentWorkersStarted = 0;
  #piSessionsStarted = 0;
  #providerRequests = 0;
  #workerCrashes = 0;

  constructor(workerEntry: string, onEvent: (event: WorkerEvent) => void) {
    this.#workerEntry = workerEntry;
    this.#onEvent = onEvent;
  }

  get activity(): WorkerActivity {
    const workers = [...this.#workers.values()];
    return {
      agentWorkersStarted: this.#agentWorkersStarted,
      piSessionsStarted: this.#piSessionsStarted,
      providerRequests: this.#providerRequests,
      projectWorkers: workers.filter((worker) => worker.ownerKey.startsWith("project:")).length,
      unscopedWorkers: workers.filter((worker) => worker.ownerKey.startsWith("unscoped:")).length,
      activeSessions: workers.reduce((count, worker) => count + [...worker.sessions.values()].filter((session) => session.activeCommand !== undefined).length, 0),
      workerCrashes: this.#workerCrashes
    };
  }

  async execute(command: ExecuteCommand): Promise<void> {
    const ownerKey = ownerKeyFor(command);
    const workerRevision = command.workerRevision ?? "runtime-default-v1";
    let record = this.#workers.get(ownerKey);
    if (record !== undefined && record.workerRevision !== workerRevision) {
      throw new Error("WORKER_REVISION_MISMATCH");
    }
    if (record === undefined) record = this.#startWorker(ownerKey, workerRevision);
    const sessionKey = command.sessionKey ?? `thread:${command.threadId}`;
    const session = record.sessions.get(command.threadId) ?? { sessionKey, sessionStarted: false, lastWorkerSequenceByTurn: new Map<string, number>() };
    if (session.activeCommand !== undefined) {
      throw new Error("THREAD_SESSION_ALREADY_ACTIVE");
    }
    session.activeCommand = command;
    record.sessions.set(command.threadId, session);
    await record.spawned;
    record.process.postMessage({ ...command, ownerKey, workerRevision, sessionKey });
  }

  stop(command: Extract<WorkerCommand, { command: "turn.stop" }>): void {
    const found = this.#findSession(command.threadId, command.turnId);
    if (found === undefined) return;
    void found.record.spawned.then(() => found.record.process.postMessage({ ...command, ownerKey: found.record.ownerKey, workerRevision: found.record.workerRevision, sessionKey: found.session.sessionKey })).catch(() => undefined);
  }

  acknowledge(command: Extract<WorkerCommand, { command: "trajectory.acknowledge" }>): void {
    const found = this.#findSession(command.threadId);
    if (found !== undefined) found.record.process.postMessage({ ...command, ownerKey: found.record.ownerKey, workerRevision: found.record.workerRevision, sessionKey: found.session.sessionKey });
  }

  resolveCapability(command: Extract<WorkerCommand, { command: "capability.execution.resolve" }>): void {
    const found = this.#findSession(command.threadId, command.turnId);
    if (found !== undefined) found.record.process.postMessage({ ...command, ownerKey: found.record.ownerKey, workerRevision: found.record.workerRevision, sessionKey: found.session.sessionKey });
  }

  retire(ownerKeyOrThreadId: string): void {
    const ownerKey = ownerKeyOrThreadId.includes(":") ? ownerKeyOrThreadId : `unscoped:${ownerKeyOrThreadId}`;
    const record = this.#workers.get(ownerKey);
    if (record === undefined || [...record.sessions.values()].some((session) => session.activeCommand !== undefined)) return;
    this.#workers.delete(ownerKey);
    record.process.kill();
  }

  closeAll(): void {
    for (const record of this.#workers.values()) record.process.kill();
    this.#workers.clear();
  }

  #startWorker(ownerKey: string, workerRevision: string): WorkerRecord {
    const child = utilityProcess.fork(this.#workerEntry, [], {
      serviceName: `vc-agent-${ownerKey.replace(/[^a-zA-Z0-9-]/gu, "-").slice(0, 180)}`,
      stdio: "ignore"
    });
    let resolveSpawn!: () => void;
    let rejectSpawn!: (error: Error) => void;
    const spawned = new Promise<void>((resolve, reject) => { resolveSpawn = resolve; rejectSpawn = reject; });
    const record: WorkerRecord = { ownerKey, workerRevision, process: child, spawned, sessions: new Map() };
    this.#workers.set(ownerKey, record);
    this.#agentWorkersStarted += 1;

    child.once("spawn", resolveSpawn);
    child.on("message", (rawEvent) => {
      const parsed = workerEventSchema.safeParse(rawEvent);
      if (!parsed.success) return;
      const event = parsed.data;
      const session = record.sessions.get(event.threadId);
      if (session === undefined) return;
      if (event.ownerKey !== undefined && event.ownerKey !== record.ownerKey) return;
      if (event.workerRevision !== undefined && event.workerRevision !== record.workerRevision) return;
      if (event.sessionKey !== undefined && event.sessionKey !== session.sessionKey) return;
      const lastWorkerSequence = session.lastWorkerSequenceByTurn.get(event.turnId) ?? 0;
      if (event.workerSequence <= lastWorkerSequence) return;
      session.lastWorkerSequenceByTurn.set(event.turnId, event.workerSequence);
      if (event.event === "turn.started") {
        if (!session.sessionStarted) { session.sessionStarted = true; this.#piSessionsStarted += 1; }
        this.#providerRequests += 1;
      }
      if (event.event === "thread.compaction.started") {
        if (!session.sessionStarted) { session.sessionStarted = true; this.#piSessionsStarted += 1; }
        this.#providerRequests += 1;
      }
      if (isTerminal(event, session.activeCommand)) delete session.activeCommand;
      this.#onEvent(event);
    });
    child.once("error", (error) => rejectSpawn(new Error(error)));
    child.on("exit", (code: number) => {
      if (this.#workers.get(ownerKey) !== record) return;
      const signal: string | null = null;
      this.#workers.delete(ownerKey);
      this.#workerCrashes += 1;
      for (const session of record.sessions.values()) {
        const active = session.activeCommand;
        if (active === undefined) continue;
        this.#onEvent({
          schemaVersion: 1,
          correlationId: active.correlationId,
          threadId: active.threadId,
          turnId: active.turnId,
          ownerKey,
          workerRevision,
          sessionKey: session.sessionKey,
          workerSequence: (session.lastWorkerSequenceByTurn.get(active.turnId) ?? 0) + 1,
          event: "turn.failed",
          failure: {
            kind: "worker",
            code: "AGENT_WORKER_CRASHED",
            message: `Agent Worker crashed before completion${code === null ? "" : ` (code ${code}${signal === null ? "" : `, ${signal}`})`}.`,
            provider: active.profile.provider,
            model: active.profile.model
          }
        });
      }
    });
    return record;
  }

  #findSession(threadId: string, turnId?: string): { record: WorkerRecord; session: SessionRecord } | undefined {
    for (const record of this.#workers.values()) {
      const session = record.sessions.get(threadId);
      if (session !== undefined && (turnId === undefined || session.activeCommand?.turnId === turnId)) return { record, session };
    }
    return undefined;
  }
}

function ownerKeyFor(command: ExecuteCommand): string {
  return command.executionScope.kind === "project" ? `project:${command.executionScope.projectId}` : `unscoped:${command.threadId}`;
}

function isTerminal(event: WorkerEvent, active: ExecuteCommand | undefined): boolean {
  return event.event === "turn.completed" || event.event === "turn.failed" || event.event === "turn.interrupted" || (active?.compactOnly === true && (event.event === "thread.compaction.completed" || event.event === "thread.compaction.failed"));
}
