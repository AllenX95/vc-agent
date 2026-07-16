import { utilityProcess, type UtilityProcess } from "electron";
import { utilityJobEventSchema, type UtilityJobCommand, type UtilityJobEvent } from "@vc-agent/contracts";

interface PendingJob {
  readonly resolve: (event: UtilityJobEvent) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class UtilityJobRunner {
  readonly #entryPath: string;
  #process: UtilityProcess | null = null;
  #spawned: Promise<void> | null = null;
  #pending = new Map<string, PendingJob>();
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(entryPath: string) { this.#entryPath = entryPath; }

  run(command: UtilityJobCommand): Promise<UtilityJobEvent> {
    if (this.#closed) return Promise.resolve(failure(command.jobId, "UTILITY_WORKER_CLOSED", "Utility Worker is closed."));
    const result = this.#tail.then(() => this.#execute(command));
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  close(): void {
    this.#closed = true;
    this.#process?.kill();
    this.#process = null;
    this.#spawned = null;
    for (const [jobId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve(failure(jobId, "UTILITY_WORKER_EXITED", "Utility Worker closed before the job completed."));
    }
    this.#pending.clear();
  }

  async #execute(command: UtilityJobCommand): Promise<UtilityJobEvent> {
    if (this.#closed) return failure(command.jobId, "UTILITY_WORKER_CLOSED", "Utility Worker is closed.");
    this.#ensureWorker();
    try {
      await this.#spawned;
    } catch (error) {
      this.#process = null;
      this.#spawned = null;
      return failure(command.jobId, "UTILITY_WORKER_UNAVAILABLE", error instanceof Error ? error.message : "Utility Worker could not start.");
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(command.jobId);
        this.#process?.kill();
        this.#process = null;
        this.#spawned = null;
        resolve(failure(command.jobId, "UTILITY_JOB_TIMEOUT", "Utility job exceeded its timeout."));
      }, command.timeoutMs + 1_000);
      this.#pending.set(command.jobId, { resolve, timer });
      this.#process!.postMessage(command);
    });
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
        pending.resolve(failure(jobId, "UTILITY_WORKER_EXITED", "Utility Worker exited before the job completed."));
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
    ...(process.env.VC_AGENT_PYTHON === undefined ? {} : { VC_AGENT_PYTHON: process.env.VC_AGENT_PYTHON })
  };
}

function failure(jobId: string, code: string, message: string): UtilityJobEvent {
  return { schemaVersion: 1, jobId, event: "material.parse.failed", code, message, stderr: "" };
}
