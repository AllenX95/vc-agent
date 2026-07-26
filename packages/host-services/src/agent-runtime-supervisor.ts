import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";

export type WorkerOwner =
  | { readonly kind: "project"; readonly projectId: string; readonly projectPath: string }
  | { readonly kind: "unscoped"; readonly threadId: string; readonly workPath: string }
  | { readonly kind: "isolated"; readonly executionId: string; readonly workPath: string };

export function workerOwnerKey(owner: WorkerOwner): string {
  if (owner.kind === "project") return `project:${owner.projectId}`;
  if (owner.kind === "unscoped") return `unscoped:${owner.threadId}`;
  return `isolated:${owner.executionId}`;
}

export function projectWorkerOwner(projectId: string, projectPath: string, identityStatus: "stable" | "collision" = "stable"): WorkerOwner {
  if (identityStatus !== "stable") throw new Error("PROJECT_IDENTITY_COLLISION");
  if (projectId.trim() === "" || projectPath.trim() === "") throw new Error("WORKER_OWNER_UNRESOLVED");
  return { kind: "project", projectId, projectPath };
}

export interface AgentExecutionRequest {
  readonly owner: WorkerOwner;
  readonly threadId: string;
  readonly turnId: string;
  readonly correlationId: string;
  readonly command?: unknown;
  readonly workerRevision?: string;
  readonly resourceSnapshotRevision?: string;
}

export interface AgentRuntimeEvent {
  readonly ownerKey: string;
  readonly workerRevision: string;
  readonly sessionKey: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface AgentWorkerProcess {
  readonly pid?: number;
  send(message: unknown): void;
  terminate(): Promise<void> | void;
  onEvent(listener: (event: AgentRuntimeEvent) => void): void;
  onExit(listener: (details: { readonly code?: number; readonly signal?: string }) => void): void;
}

export interface AgentWorkerProcessFactory {
  start(input: {
    readonly owner: WorkerOwner;
    readonly ownerKey: string;
    readonly workerRevision: string;
    readonly onEvent: (event: AgentRuntimeEvent) => void;
    readonly onExit: (details: { readonly code?: number; readonly signal?: string }) => void;
  }): Promise<AgentWorkerProcess> | AgentWorkerProcess;
}

interface SessionRecord {
  readonly threadId: string;
  readonly sessionKey: string;
  activeTurnId: string | undefined;
  readonly lastSequenceByTurn: Map<string, number>;
}

interface WorkerRecord {
  readonly owner: WorkerOwner;
  readonly ownerKey: string;
  readonly workerRevision: string;
  readonly process: AgentWorkerProcess;
  readonly sessions: Map<string, SessionRecord>;
  state: "starting" | "ready" | "retiring" | "crashed" | "terminated";
  crashCount: number;
  startedAt: number;
}

export interface RuntimeOwnershipSnapshot {
  readonly accepting: boolean;
  readonly workers: readonly {
    readonly ownerKey: string;
    readonly kind: WorkerOwner["kind"];
    readonly workerRevision: string;
    readonly state: WorkerRecord["state"];
    readonly pid?: number;
    readonly activeThreadIds: readonly string[];
    readonly crashCount: number;
  }[];
  readonly rejectedStaleEvents: number;
  readonly crashCount: number;
}

export interface RuntimeShutdownReport {
  readonly terminatedWorkers: number;
  readonly unresolvedTurns: readonly { readonly ownerKey: string; readonly threadId: string; readonly turnId: string }[];
  readonly timedOut: boolean;
}

export class RuntimeSupervisorError extends Error {
  readonly code: "WORKER_OWNER_UNRESOLVED" | "PROJECT_IDENTITY_COLLISION" | "WORKER_REVISION_MISMATCH" | "THREAD_SESSION_ALREADY_ACTIVE" | "RUNTIME_SHUTDOWN_INCOMPLETE";

  constructor(code: RuntimeSupervisorError["code"], message: string = code) {
    super(message);
    this.name = "RuntimeSupervisorError";
    this.code = code;
  }
}

/**
 * Host-owned worker lifecycle and per-Thread session registry. The process
 * factory is intentionally injected so tests and non-Electron hosts cannot
 * accidentally spawn a process outside the runtime boundary.
 */
export class AgentRuntimeSupervisor {
  readonly #factory: AgentWorkerProcessFactory;
  readonly #now: () => number;
  readonly #workers = new Map<string, WorkerRecord>();
  readonly #startingWorkers = new Map<string, Promise<WorkerRecord>>();
  readonly #onEvent: (event: AgentRuntimeEvent) => void;
  readonly #onTurnInterrupted: ((input: { ownerKey: string; threadId: string; turnId: string; reason: "worker_crash" | "shutdown" }) => void) | undefined;
  #accepting = true;
  #rejectedStaleEvents = 0;
  #crashCount = 0;

  constructor(input: {
    factory: AgentWorkerProcessFactory;
    onEvent?: (event: AgentRuntimeEvent) => void;
    onTurnInterrupted?: (input: { ownerKey: string; threadId: string; turnId: string; reason: "worker_crash" | "shutdown" }) => void;
    now?: () => number;
  }) {
    this.#factory = input.factory;
    this.#onEvent = input.onEvent ?? (() => undefined);
    this.#onTurnInterrupted = input.onTurnInterrupted;
    this.#now = input.now ?? Date.now;
  }

  async execute(request: AgentExecutionRequest): Promise<void> {
    if (!this.#accepting) throw new RuntimeSupervisorError("RUNTIME_SHUTDOWN_INCOMPLETE", "Runtime admission is closed.");
    const ownerKey = workerOwnerKey(request.owner);
    const workerRevision = request.workerRevision ?? "runtime-default-v1";
    let worker = this.#workers.get(ownerKey);
    if (worker !== undefined && worker.workerRevision !== workerRevision) {
      throw new RuntimeSupervisorError("WORKER_REVISION_MISMATCH", `Worker ${ownerKey} is frozen at revision ${worker.workerRevision}.`);
    }
    if (worker === undefined) {
      let starting = this.#startingWorkers.get(ownerKey);
      if (starting === undefined) {
        starting = this.#startWorker(request.owner, ownerKey, workerRevision);
        this.#startingWorkers.set(ownerKey, starting);
      }
      try { worker = await starting; }
      finally { if (this.#startingWorkers.get(ownerKey) === starting) this.#startingWorkers.delete(ownerKey); }
    }
    if (worker.state !== "ready") throw new RuntimeSupervisorError("RUNTIME_SHUTDOWN_INCOMPLETE", `Worker ${ownerKey} is not accepting work.`);
    const session = worker.sessions.get(request.threadId) ?? { threadId: request.threadId, sessionKey: "thread:" + request.threadId, activeTurnId: undefined, lastSequenceByTurn: new Map<string, number>() };
    if (session.activeTurnId !== undefined) throw new RuntimeSupervisorError("THREAD_SESSION_ALREADY_ACTIVE", `Thread ${request.threadId} already has an active Turn.`);
    session.activeTurnId = request.turnId;
    worker.sessions.set(request.threadId, session);
    worker.process.send({
      ...(request.command === undefined ? {} : request.command as Record<string, unknown>),
      ownerKey,
      workerRevision,
      sessionKey: session.sessionKey,
      threadId: request.threadId,
      turnId: request.turnId,
      correlationId: request.correlationId
    });
  }

  async #startWorker(owner: WorkerOwner, ownerKey: string, workerRevision: string): Promise<WorkerRecord> {
    const process = await this.#factory.start({
      owner,
      ownerKey,
      workerRevision,
      onEvent: (event) => this.#receiveEvent(event),
      onExit: (details) => this.#receiveExit(ownerKey, details)
    });
    if (!this.#accepting) {
      await process.terminate();
      throw new RuntimeSupervisorError("RUNTIME_SHUTDOWN_INCOMPLETE", "Runtime admission closed while the Worker was starting.");
    }
    const worker: WorkerRecord = {
      owner,
      ownerKey,
      workerRevision,
      process,
      sessions: new Map(),
      state: "ready",
      crashCount: 0,
      startedAt: this.#now()
    };
    this.#workers.set(ownerKey, worker);
    return worker;
  }

  stop(request: { readonly threadId: string; readonly turnId: string }): void {
    for (const worker of this.#workers.values()) {
      const session = worker.sessions.get(request.threadId);
      if (session?.activeTurnId !== request.turnId) continue;
      worker.process.send({
        command: "turn.stop",
        ownerKey: worker.ownerKey,
        workerRevision: worker.workerRevision,
        sessionKey: session.sessionKey,
        threadId: request.threadId,
        turnId: request.turnId
      });
      return;
    }
  }

  async retire(owner: WorkerOwner): Promise<void> {
    const key = workerOwnerKey(owner);
    const worker = this.#workers.get(key);
    if (worker === undefined) return;
    if ([...worker.sessions.values()].some((session) => session.activeTurnId !== undefined)) return;
    worker.state = "retiring";
    await worker.process.terminate();
    worker.state = "terminated";
    this.#workers.delete(key);
  }

  async shutdown(deadlineMs: number): Promise<RuntimeShutdownReport> {
    this.#accepting = false;
    const workers = [...this.#workers.values()];
    const unresolvedTurns = workers.flatMap((worker) => [...worker.sessions.values()].flatMap((session) => session.activeTurnId === undefined ? [] : [{ ownerKey: worker.ownerKey, threadId: session.threadId, turnId: session.activeTurnId }]));
    for (const worker of workers) {
      worker.state = "retiring";
      for (const session of worker.sessions.values()) {
        if (session.activeTurnId !== undefined) {
          worker.process.send({ command: "turn.stop", ownerKey: worker.ownerKey, workerRevision: worker.workerRevision, sessionKey: session.sessionKey, threadId: session.threadId, turnId: session.activeTurnId });
          this.#onTurnInterrupted?.({ ownerKey: worker.ownerKey, threadId: session.threadId, turnId: session.activeTurnId, reason: "shutdown" });
        }
      }
    }
    const deadline = this.#now() + Math.max(0, deadlineMs);
    let timedOut = false;
    for (const worker of workers) {
      const remaining = Math.max(0, deadline - this.#now());
      this.#workers.delete(worker.ownerKey);
      const termination = Promise.resolve().then(() => worker.process.terminate());
      const terminated = remaining === 0 ? (void termination.catch(() => undefined), false) : await settleWithin(termination, remaining);
      if (!terminated) timedOut = true;
      worker.state = "terminated";
    }
    return { terminatedWorkers: workers.length, unresolvedTurns, timedOut };
  }

  snapshot(): RuntimeOwnershipSnapshot {
    return {
      accepting: this.#accepting,
      workers: [...this.#workers.values()].map((worker) => ({
        ownerKey: worker.ownerKey,
        kind: worker.owner.kind,
        workerRevision: worker.workerRevision,
        state: worker.state,
        ...(worker.process.pid === undefined ? {} : { pid: worker.process.pid }),
        activeThreadIds: [...worker.sessions.values()].filter((session) => session.activeTurnId !== undefined).map((session) => session.threadId),
        crashCount: worker.crashCount
      })),
      rejectedStaleEvents: this.#rejectedStaleEvents,
      crashCount: this.#crashCount
    };
  }

  #receiveEvent(event: AgentRuntimeEvent): void {
    const worker = this.#workers.get(event.ownerKey);
    const session = worker?.sessions.get(event.threadId);
    const lastSequence = session?.lastSequenceByTurn.get(event.turnId) ?? 0;
    if (worker === undefined || session === undefined || worker.workerRevision !== event.workerRevision || session.sessionKey !== event.sessionKey || event.sequence <= lastSequence) {
      this.#rejectedStaleEvents += 1;
      return;
    }
    session.lastSequenceByTurn.set(event.turnId, event.sequence);
    if (["turn.completed", "turn.failed", "turn.interrupted"].includes(event.event) && session.activeTurnId === event.turnId) session.activeTurnId = undefined;
    this.#onEvent(event);
  }

  #receiveExit(ownerKey: string, _details: { readonly code?: number; readonly signal?: string }): void {
    const worker = this.#workers.get(ownerKey);
    if (worker === undefined) return;
    worker.state = "crashed";
    worker.crashCount += 1;
    this.#crashCount += 1;
    for (const session of worker.sessions.values()) {
      if (session.activeTurnId === undefined) continue;
      this.#onTurnInterrupted?.({ ownerKey, threadId: session.threadId, turnId: session.activeTurnId, reason: "worker_crash" });
      session.activeTurnId = undefined;
    }
    this.#workers.delete(ownerKey);
  }
}

export interface LocalJobManifest {
  readonly jobId: string;
  readonly kind: "utility" | "isolated";
  readonly stagingDirectory: string;
  readonly inputPaths: readonly string[];
  readonly outputPaths: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly cancellationToken?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface LocalJobResult {
  readonly jobId: string;
  readonly status: "completed" | "failed" | "cancelled" | "timed_out";
  readonly outputPaths: readonly string[];
  readonly outputBytes: number;
  readonly warnings: readonly string[];
  readonly code?: string;
}

export interface LocalJobAdapter {
  run(manifest: LocalJobManifest, signal: AbortSignal): Promise<{ readonly outputPaths?: readonly string[]; readonly outputBytes?: number; readonly warnings?: readonly string[] }>;
  terminate?(jobId: string): Promise<void> | void;
}

export interface LocalJobRuntimeSnapshot {
  readonly accepting: boolean;
  readonly running: readonly { readonly jobId: string; readonly kind: LocalJobManifest["kind"]; readonly startedAt: string }[];
  readonly queued: readonly string[];
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly timedOut: number;
}

interface PendingLocalJob {
  readonly manifest: LocalJobManifest;
  readonly resolve: (result: LocalJobResult) => void;
  readonly enqueuedAt: number;
}

/** Bounded Host-owned admission for Utility Worker and Isolated Job adapters. */
export class LocalJobSupervisor {
  readonly #capacity: number;
  readonly #adapter: LocalJobAdapter;
  readonly #now: () => number;
  readonly #running = new Map<string, { manifest: LocalJobManifest; startedAt: number; controller: AbortController; timeout: ReturnType<typeof setTimeout>; resolve: (result: LocalJobResult) => void; settled: boolean }>();
  readonly #queued: PendingLocalJob[] = [];
  #accepting = true;
  #completed = 0;
  #failed = 0;
  #cancelled = 0;
  #timedOut = 0;

  constructor(input: { capacity?: number; adapter: LocalJobAdapter; now?: () => number }) {
    this.#capacity = input.capacity ?? 1;
    if (!Number.isInteger(this.#capacity) || this.#capacity < 1) throw new Error("Local job capacity must be a positive integer.");
    this.#adapter = input.adapter;
    this.#now = input.now ?? Date.now;
  }

  submit(manifest: LocalJobManifest): Promise<LocalJobResult> {
    validateManifest(manifest);
    if (!this.#accepting) return Promise.resolve({ jobId: manifest.jobId, status: "failed", outputPaths: [], outputBytes: 0, warnings: [], code: "LOCAL_JOB_SUPERVISOR_CLOSED" });
    return new Promise((resolve) => {
      this.#queued.push({ manifest, resolve, enqueuedAt: this.#now() });
      this.#drain();
    });
  }

  async cancel(jobId: string): Promise<{ jobId: string; status: "cancelled" | "not_found" }> {
    const queuedIndex = this.#queued.findIndex((item) => item.manifest.jobId === jobId);
    if (queuedIndex >= 0) {
      const [item] = this.#queued.splice(queuedIndex, 1);
      item?.resolve({ jobId, status: "cancelled", outputPaths: [], outputBytes: 0, warnings: [], code: "JOB_CANCELLED" });
      this.#cancelled += 1;
      return { jobId, status: "cancelled" };
    }
    const running = this.#running.get(jobId);
    if (running === undefined) return { jobId, status: "not_found" };
    await this.#cancelRunning(jobId, 2_000);
    return { jobId, status: "cancelled" };
  }

  async shutdown(deadlineMs: number): Promise<{ readonly terminated: number; readonly unresolved: readonly string[] }> {
    this.#accepting = false;
    for (const item of this.#queued.splice(0)) {
      item.resolve({ jobId: item.manifest.jobId, status: "cancelled", outputPaths: [], outputBytes: 0, warnings: [], code: "APPLICATION_SHUTDOWN" });
      this.#cancelled += 1;
    }
    const ids = [...this.#running.keys()];
    const deadline = this.#now() + Math.max(0, deadlineMs);
    const terminationResults = await Promise.all(ids.map(async (id) => this.#cancelRunning(id, Math.max(0, deadline - this.#now()))));
    const unresolved = ids.filter((_id, index) => terminationResults[index] === false);
    return { terminated: ids.length - unresolved.length, unresolved };
  }

  snapshot(): LocalJobRuntimeSnapshot {
    return {
      accepting: this.#accepting,
      running: [...this.#running.values()].map((item) => ({ jobId: item.manifest.jobId, kind: item.manifest.kind, startedAt: new Date(item.startedAt).toISOString() })),
      queued: this.#queued.map((item) => item.manifest.jobId),
      completed: this.#completed,
      failed: this.#failed,
      cancelled: this.#cancelled,
      timedOut: this.#timedOut
    };
  }

  #drain(): void {
    while (this.#running.size < this.#capacity && this.#queued.length > 0) {
      const pending = this.#queued.shift()!;
      const controller = new AbortController();
      const startedAt = this.#now();
      const timeout = setTimeout(() => {
        const running = this.#running.get(pending.manifest.jobId);
        if (running === undefined) return;
        running.controller.abort();
        void Promise.resolve(this.#adapter.terminate?.(pending.manifest.jobId)).catch(() => undefined);
        this.settleRunning(pending.manifest.jobId, "timed_out", "JOB_TIMEOUT");
      }, pending.manifest.timeoutMs);
      this.#running.set(pending.manifest.jobId, { manifest: pending.manifest, startedAt, controller, timeout, resolve: pending.resolve, settled: false });
      void this.#run(pending, controller).catch(() => undefined);
    }
  }

  async #run(pending: PendingLocalJob, controller: AbortController): Promise<void> {
    let result: LocalJobResult;
    try {
      const output = await this.#adapter.run(pending.manifest, controller.signal);
      const running = this.#running.get(pending.manifest.jobId);
      if (running === undefined || running.settled) return;
      const timedOut = controller.signal.aborted;
      const outputPaths = output.outputPaths ?? [];
      const outputBytes = output.outputBytes ?? 0;
      if (outputPaths.some((path) => !pending.manifest.outputPaths.includes(path)) || outputBytes > pending.manifest.maxOutputBytes) {
        result = { jobId: pending.manifest.jobId, status: "failed", outputPaths: [], outputBytes: 0, warnings: output.warnings ?? [], code: "LOCAL_JOB_RESULT_INVALID" };
        this.#failed += 1;
      } else if (timedOut) {
        result = { jobId: pending.manifest.jobId, status: "timed_out", outputPaths: [], outputBytes: 0, warnings: output.warnings ?? [], code: "JOB_TIMEOUT" };
      } else {
        result = { jobId: pending.manifest.jobId, status: "completed", outputPaths, outputBytes, warnings: output.warnings ?? [] };
        this.#completed += 1;
      }
    } catch (error) {
      if (!this.#running.has(pending.manifest.jobId)) return;
      const declaredCode = error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : "LOCAL_JOB_CRASHED";
      result = { jobId: pending.manifest.jobId, status: controller.signal.aborted ? "cancelled" : "failed", outputPaths: [], outputBytes: 0, warnings: [], code: controller.signal.aborted ? "JOB_CANCELLED" : declaredCode };
      if (controller.signal.aborted) this.#cancelled += 1; else this.#failed += 1;
    } finally {
      const running = this.#running.get(pending.manifest.jobId);
      if (running !== undefined) { clearTimeout(running.timeout); this.#running.delete(pending.manifest.jobId); }
      this.#drain();
    }
    pending.resolve(result);
  }

  private settleRunning(jobId: string, status: "cancelled" | "timed_out", code: string): void {
    const running = this.#running.get(jobId);
    if (running === undefined || running.settled) return;
    running.settled = true;
    clearTimeout(running.timeout);
    this.#running.delete(jobId);
    if (status === "cancelled") this.#cancelled += 1; else this.#timedOut += 1;
    running.resolve({ jobId, status, outputPaths: [], outputBytes: 0, warnings: [], code });
    this.#drain();
  }

  async #cancelRunning(jobId: string, timeoutMs: number): Promise<boolean> {
    const running = this.#running.get(jobId);
    if (running === undefined) return true;
    running.controller.abort();
    const terminated = await settleWithin(Promise.resolve().then(() => this.#adapter.terminate?.(jobId)), timeoutMs);
    this.settleRunning(jobId, "cancelled", terminated ? "JOB_CANCELLED" : "JOB_CANCEL_INCOMPLETE");
    return terminated;
  }
}

function validateManifest(manifest: LocalJobManifest): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(manifest.jobId) || manifest.jobId.length > 128) throw new Error("Invalid local job id.");
  if (!Number.isInteger(manifest.timeoutMs) || manifest.timeoutMs < 1 || manifest.timeoutMs > 30 * 60_000) throw new Error("Invalid local job timeout.");
  if (!Number.isInteger(manifest.maxOutputBytes) || manifest.maxOutputBytes < 1 || manifest.maxOutputBytes > 100_000_000) throw new Error("Invalid local job output bound.");
  if (manifest.stagingDirectory.trim() === "" || manifest.outputPaths.some((path) => path.trim() === "")) throw new Error("Local job paths are required.");
  const stagingRoot = resolve(manifest.stagingDirectory);
  for (const path of manifest.outputPaths) {
    const candidate = resolve(path);
    const relativePath = relative(stagingRoot, candidate);
    if (candidate !== stagingRoot && (relativePath === ".." || relativePath.startsWith(".." + sep) || /^[A-Za-z]:/u.test(relativePath))) throw new Error("LOCAL_JOB_PATH_OUTSIDE_STAGING");
  }
  if (manifest.inputPaths.length > 1_000 || manifest.outputPaths.length > 1_000) throw new Error("Local job path count exceeds the bound.");
}

async function settleWithin(task: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const completed = task.then(() => true, () => false);
  const result = await Promise.race([completed, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

export function createIsolatedExecutionRequest(owner: WorkerOwner, threadId: string, turnId: string, correlationId: string, command?: unknown): AgentExecutionRequest {
  return { owner, threadId, turnId, correlationId, ...(command === undefined ? {} : { command }), workerRevision: `runtime-${randomUUID()}` };
}
