import { utilityProcess, type UtilityProcess } from "electron";
import { utilityJobEventSchema, type UtilityJobCommand, type UtilityJobEvent } from "@vc-agent/contracts";
import { terminateProcessTree, waitForProcessExit } from "./process-tree.js";

interface PendingJob {
  readonly command: UtilityJobCommand;
  readonly resolve: (event: UtilityJobEvent) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type MaterialParseCommand = Extract<UtilityJobCommand, { command: "material.parse" }>;
type OcrCommand = Extract<UtilityJobCommand, { command: "page_recovery.ocr" }>;
type OfficeCommand = Extract<UtilityJobCommand, { command: "office.skill" }>;
type MaterialParseEvent = Extract<UtilityJobEvent, { event: "material.parse.completed" | "material.parse.failed" }>;
type OcrEvent = Extract<UtilityJobEvent, { event: "page_recovery.ocr.completed" | "page_recovery.ocr.failed" }>;
type OfficeEvent = Extract<UtilityJobEvent, { event: "office.skill.completed" | "office.skill.failed" }>;

export class UtilityJobRunner {
  readonly #entryPath: string;
  #process: UtilityProcess | null = null;
  #spawned: Promise<void> | null = null;
  #pending = new Map<string, PendingJob>();
  #currentJobId: string | null = null;
  #cancelledJobIds = new Set<string>();
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #shutdownPromise: Promise<void> | null = null;

  constructor(entryPath: string) { this.#entryPath = entryPath; }

  run(command: MaterialParseCommand): Promise<MaterialParseEvent>;
  run(command: OcrCommand): Promise<OcrEvent>;
  run(command: OfficeCommand): Promise<OfficeEvent>;
  run(command: UtilityJobCommand): Promise<UtilityJobEvent> {
    if (this.#closed) return Promise.resolve(failure(command, "UTILITY_WORKER_CLOSED", "Utility Worker is closed."));
    const result = this.#tail.then(() => this.#execute(command));
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  close(): void { void this.shutdown(0); }

  /**
   * Interrupts the utility process that owns a bounded job. The worker is
   * deliberately disposable: a killed worker cannot acknowledge stale output
   * from a third-party Office runner, and the next request starts a fresh
   * process with the same allowlisted environment.
   */
  async terminate(jobId?: string): Promise<void> {
    if (jobId !== undefined && this.#currentJobId !== jobId) {
      this.#cancelledJobIds.add(jobId);
      return;
    }
    const process = this.#process;
    if (process === null) return;
    const exited = waitForProcessExit((callback) => process.once("exit", callback), 2_000);
    terminateProcessTree(process.pid, () => process.kill());
    await exited;
    if (this.#process === process) {
      this.#process = null;
      this.#spawned = null;
    }
  }

  async shutdown(deadlineMs = 5_000): Promise<void> {
    if (this.#shutdownPromise !== null) return this.#shutdownPromise;
    this.#shutdownPromise = this.#shutdown(deadlineMs);
    return this.#shutdownPromise;
  }

  async #shutdown(deadlineMs: number): Promise<void> {
    this.#closed = true;
    const process = this.#process;
    if (process !== null) {
      const exited = waitForProcessExit((callback) => process.once("exit", callback), deadlineMs);
      terminateProcessTree(process.pid, () => process.kill());
      await exited;
    }
    this.#process = null;
    this.#spawned = null;
    this.#currentJobId = null;
    this.#cancelledJobIds.clear();
    for (const [jobId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve(failure(pending.command, "UTILITY_WORKER_EXITED", "Utility Worker closed before the job completed."));
    }
    this.#pending.clear();
  }

  async #execute(command: UtilityJobCommand): Promise<UtilityJobEvent> {
    if (this.#closed) return failure(command, "UTILITY_WORKER_CLOSED", "Utility Worker is closed.");
    if (this.#cancelledJobIds.delete(command.jobId)) return failure(command, "UTILITY_JOB_CANCELLED", "Utility job was cancelled before it started.");
    this.#currentJobId = command.jobId;
    try {
      this.#ensureWorker();
      try {
        await this.#spawned;
      } catch (error) {
        this.#process = null;
        this.#spawned = null;
        return failure(command, "UTILITY_WORKER_UNAVAILABLE", error instanceof Error ? error.message : "Utility Worker could not start.");
      }
      // Await the pending response before leaving this try/finally. Without
      // the await, the async function would run finally immediately after
      // posting the message and clear #currentJobId while the worker was
      // still running. A cancellation would then be misclassified as a
      // queued-job cancellation and leave the active process tree alive.
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.#pending.delete(command.jobId);
          if (this.#process !== null) terminateProcessTree(this.#process.pid, () => this.#process?.kill());
          this.#process = null;
          this.#spawned = null;
          resolve(failure(command, "UTILITY_JOB_TIMEOUT", "Utility job exceeded its declared timeout."));
        }, command.timeoutMs + 1_000);
        this.#pending.set(command.jobId, { command, resolve, timer });
        this.#process!.postMessage(command);
      });
    } finally {
      if (this.#currentJobId === command.jobId) this.#currentJobId = null;
    }
  }

  #ensureWorker(): void {
    if (this.#process !== null) return;
    const child = utilityProcess.fork(this.#entryPath, [], { serviceName: "vc-agent-utility-worker", stdio: "ignore", env: utilityEnvironment() });
    this.#process = child;
    this.#spawned = new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.on("message", (raw) => {
      const event = utilityJobEventSchema.safeParse(raw);
      if (!event.success) return;
      const pending = this.#pending.get(event.data.jobId);
      if (pending === undefined) return;
      this.#pending.delete(event.data.jobId);
      clearTimeout(pending.timer);
      pending.resolve(event.data);
    });
    child.once("exit", () => {
      if (this.#process !== child) return;
      this.#process = null;
      this.#spawned = null;
      for (const [jobId, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.resolve(failure(pending.command, "UTILITY_WORKER_EXITED", "Utility Worker exited before the job completed."));
      }
      this.#pending.clear();
    });
  }
}

function utilityEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? process.env.Path ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    TEMP: process.env.TEMP ?? "",
    TMP: process.env.TMP ?? "",
    PYTHONUTF8: "1",
    ...(process.env.VC_AGENT_PYTHON === undefined ? {} : { VC_AGENT_PYTHON: process.env.VC_AGENT_PYTHON }),
    ...(process.env.VC_AGENT_OCR_RUNTIME_ROOT === undefined ? {} : { VC_AGENT_OCR_RUNTIME_ROOT: process.env.VC_AGENT_OCR_RUNTIME_ROOT }),
    ...(process.env.VC_AGENT_OCR_PYTHON === undefined ? {} : { VC_AGENT_OCR_PYTHON: process.env.VC_AGENT_OCR_PYTHON }),
    ...(process.env.VC_AGENT_OCR_MODELS_ROOT === undefined ? {} : { VC_AGENT_OCR_MODELS_ROOT: process.env.VC_AGENT_OCR_MODELS_ROOT })
  };
}

function failure(command: UtilityJobCommand, code: string, message: string): UtilityJobEvent {
  if (command.command === "material.parse") return { schemaVersion: 1, jobId: command.jobId, event: "material.parse.failed", code, message, stderr: "" };
  if (command.command === "page_recovery.ocr") return { schemaVersion: 1, jobId: command.jobId, event: "page_recovery.ocr.failed", stage: command.stage, code, message, stderr: "" };
  return { schemaVersion: 1, jobId: command.jobId, event: "office.skill.failed", code, message, stderr: "" };
}
