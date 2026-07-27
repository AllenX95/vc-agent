import { utilityProcess, type UtilityProcess } from "electron";
import { workerEventSchema, type WorkerCommand, type WorkerEvent } from "@vc-agent/contracts";
import { terminateProcessTree, waitForProcessExit } from "./process-tree.js";

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
  readonly bootSettled: Promise<void>;
  settleBoot(): void;
  bootState: "starting" | "ready" | "failed";
  bootTimeout?: NodeJS.Timeout;
  stderrTail: string;
  readonly sessions: Map<string, SessionRecord>;
}

const WORKER_READY_TIMEOUT_MS = 5_000;
const WORKER_STDERR_LIMIT = 8_192;

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
    await record.bootSettled;
    if (record.bootState !== "ready" || this.#workers.get(ownerKey) !== record) return;
    record.process.postMessage({ ...command, ownerKey, workerRevision, sessionKey });
  }

  stop(command: Extract<WorkerCommand, { command: "turn.stop" }>): void {
    const found = this.#findSession(command.threadId, command.turnId);
    if (found === undefined) return;
    void found.record.bootSettled.then(() => {
      if (found.record.bootState !== "ready") return;
      found.record.process.postMessage({ ...command, ownerKey: found.record.ownerKey, workerRevision: found.record.workerRevision, sessionKey: found.session.sessionKey });
    });
  }

  acknowledge(command: Extract<WorkerCommand, { command: "trajectory.acknowledge" }>): void {
    const found = this.#findSession(command.threadId);
    if (found !== undefined && found.record.bootState === "ready") {
      found.record.process.postMessage({ ...command, ownerKey: found.record.ownerKey, workerRevision: found.record.workerRevision, sessionKey: found.session.sessionKey });
    }
  }

  resolveCapability(command: Extract<WorkerCommand, { command: "capability.execution.resolve" }>): void {
    const found = this.#findSession(command.threadId, command.turnId);
    if (found !== undefined && found.record.bootState === "ready") {
      found.record.process.postMessage({ ...command, ownerKey: found.record.ownerKey, workerRevision: found.record.workerRevision, sessionKey: found.session.sessionKey });
    }
  }

  retire(ownerKeyOrThreadId: string): void {
    const ownerKey = ownerKeyOrThreadId.includes(":") ? ownerKeyOrThreadId : `unscoped:${ownerKeyOrThreadId}`;
    const record = this.#workers.get(ownerKey);
    if (record === undefined || [...record.sessions.values()].some((session) => session.activeCommand !== undefined)) return;
    this.#workers.delete(ownerKey);
    record.process.kill();
  }

  closeAll(): void {
    for (const record of this.#workers.values()) terminateProcessTree(record.process.pid, () => record.process.kill());
    this.#workers.clear();
  }

  async shutdown(deadlineMs = 5_000): Promise<void> {
    const workers = [...this.#workers.values()];
    this.#workers.clear();
    await Promise.all(workers.map(async (record) => {
      const exited = waitForProcessExit((callback) => record.process.once("exit", callback), deadlineMs);
      terminateProcessTree(record.process.pid, () => record.process.kill());
      await exited;
    }));
  }

  #startWorker(ownerKey: string, workerRevision: string): WorkerRecord {
    const child = utilityProcess.fork(this.#workerEntry, [], {
      serviceName: `vc-agent-${ownerKey.replace(/[^a-zA-Z0-9-]/gu, "-").slice(0, 180)}`,
      stdio: "pipe"
    });
    let settleBoot!: () => void;
    const bootSettled = new Promise<void>((resolve) => { settleBoot = resolve; });
    const record: WorkerRecord = {
      ownerKey,
      workerRevision,
      process: child,
      bootSettled,
      settleBoot,
      bootState: "starting",
      stderrTail: "",
      sessions: new Map()
    };
    this.#workers.set(ownerKey, record);
    this.#agentWorkersStarted += 1;

    child.stderr?.on("data", (chunk) => {
      record.stderrTail = `${record.stderrTail}${String(chunk)}`.slice(-WORKER_STDERR_LIMIT);
    });
    child.once("spawn", () => {
      record.bootTimeout = setTimeout(() => {
        this.#failWorker(record, null, "Agent Worker readiness timed out.");
        child.kill();
      }, WORKER_READY_TIMEOUT_MS);
    });
    child.on("message", (rawEvent) => {
      if (isWorkerReady(rawEvent)) {
        if (record.bootState !== "starting") return;
        record.bootState = "ready";
        if (record.bootTimeout !== undefined) clearTimeout(record.bootTimeout);
        record.settleBoot();
        return;
      }
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
    child.once("error", (error) => {
      this.#failWorker(record, null, String(error));
      child.kill();
    });
    child.on("exit", (code: number) => this.#failWorker(record, code));
    return record;
  }

  #failWorker(record: WorkerRecord, code: number | null, fallbackDetail?: string): void {
    if (this.#workers.get(record.ownerKey) !== record) return;
    this.#workers.delete(record.ownerKey);
    const bootFailure = record.bootState === "starting";
    record.bootState = "failed";
    if (record.bootTimeout !== undefined) clearTimeout(record.bootTimeout);
    record.settleBoot();
    this.#workerCrashes += 1;
    const detail = sanitizeWorkerDiagnostic(record.stderrTail || fallbackDetail || "");
    for (const session of record.sessions.values()) {
      const active = session.activeCommand;
      if (active === undefined) continue;
      this.#onEvent({
        schemaVersion: 1,
        correlationId: active.correlationId,
        threadId: active.threadId,
        turnId: active.turnId,
        ownerKey: record.ownerKey,
        workerRevision: record.workerRevision,
        sessionKey: session.sessionKey,
        workerSequence: (session.lastWorkerSequenceByTurn.get(active.turnId) ?? 0) + 1,
        event: "turn.failed",
        failure: {
          kind: "worker",
          code: bootFailure ? "AGENT_WORKER_BOOT_FAILED" : "AGENT_WORKER_CRASHED",
          message: [
            bootFailure ? "Agent Worker failed to initialize" : "Agent Worker crashed before completion",
            code === null ? "." : ` (code ${code}).`,
            detail === "" ? "" : ` ${detail}`
          ].join(""),
          provider: active.profile.provider,
          model: active.profile.model
        }
      });
    }
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

function isWorkerReady(value: unknown): value is { readonly schemaVersion: 1; readonly event: "worker.ready" } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { schemaVersion?: unknown; event?: unknown };
  return candidate.schemaVersion === 1 && candidate.event === "worker.ready";
}

function sanitizeWorkerDiagnostic(value: string): string {
  return value
    .replace(/(?:api[_-]?key|authorization|bearer|password|token)\s*[:=]\s*\S+/giu, "<redacted-field>")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "<redacted-key>")
    .replace(/file:\/\/\/[A-Za-z]:\/[^\s)]+/gu, "<local-path>")
    .replace(/[A-Za-z]:\\[^\r\n)]+/gu, "<local-path>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-1_500);
}
