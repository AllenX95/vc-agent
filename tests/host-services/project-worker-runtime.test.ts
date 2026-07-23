import { describe, expect, it, vi } from "vitest";
import {
  AgentRuntimeSupervisor,
  LocalJobSupervisor,
  RuntimeSupervisorError,
  type AgentRuntimeEvent,
  type AgentWorkerProcess,
  type LocalJobManifest
} from "@vc-agent/host-services";

class FakeProcess implements AgentWorkerProcess {
  readonly messages: unknown[] = [];
  readonly sentEvents: Array<(event: AgentRuntimeEvent) => void> = [];
  readonly exits: Array<(details: { code?: number; signal?: string }) => void> = [];
  readonly pid = 100;
  terminated = false;

  send(message: unknown): void { this.messages.push(message); }
  terminate(): void { this.terminated = true; }
  onEvent(listener: (event: AgentRuntimeEvent) => void): void { this.sentEvents.push(listener); }
  onExit(listener: (details: { code?: number; signal?: string }) => void): void { this.exits.push(listener); }

  emit(event: AgentRuntimeEvent): void { for (const listener of this.sentEvents) listener(event); }
  crash(): void { for (const listener of this.exits) listener({ code: 1 }); }
}

function factoryFor(processes: FakeProcess[]) {
  return {
    start: (input: { onEvent: (event: AgentRuntimeEvent) => void; onExit: (details: { code?: number; signal?: string }) => void }) => {
      const process = new FakeProcess();
      process.onEvent(input.onEvent);
      process.onExit(input.onExit);
      processes.push(process);
      return process;
    }
  };
}

function command(owner: { kind: "project"; projectId: string; projectPath: string } | { kind: "unscoped"; threadId: string; workPath: string }, threadId: string, turnId: string) {
  return { owner, threadId, turnId, correlationId: "corr-" + turnId, command: { command: "turn.execute", threadId, turnId } };
}

function event(ownerKey: string, threadId: string, turnId: string, sessionKey: string, sequence: number, name: string): AgentRuntimeEvent {
  return { ownerKey, workerRevision: "runtime-default-v1", sessionKey, threadId, turnId, sequence, event: name };
}

describe("Project Worker runtime", () => {
  it("shares one Project Worker while keeping Thread sessions independent", async () => {
    const processes: FakeProcess[] = [];
    const supervisor = new AgentRuntimeSupervisor({ factory: factoryFor(processes) });
    const owner = { kind: "project" as const, projectId: "project-1", projectPath: "C:/project" };
    await supervisor.execute(command(owner, "thread-a", "turn-a"));
    await supervisor.execute(command(owner, "thread-b", "turn-b"));

    expect(processes).toHaveLength(1);
    expect(processes[0]!.messages).toEqual([
      expect.objectContaining({ threadId: "thread-a", ownerKey: "project:project-1", sessionKey: "thread:thread-a" }),
      expect.objectContaining({ threadId: "thread-b", ownerKey: "project:project-1", sessionKey: "thread:thread-b" })
    ]);
    expect(supervisor.snapshot().workers[0]).toMatchObject({ ownerKey: "project:project-1", activeThreadIds: ["thread-a", "thread-b"] });
  });

  it("rejects a second Turn for one Thread and targets stop precisely", async () => {
    const process = new FakeProcess();
    const supervisor = new AgentRuntimeSupervisor({ factory: { start: (input) => { process.onEvent(input.onEvent); process.onExit(input.onExit); return process; } } });
    const owner = { kind: "project" as const, projectId: "project-1", projectPath: "C:/project" };
    await supervisor.execute(command(owner, "thread-a", "turn-a"));
    await expect(supervisor.execute(command(owner, "thread-a", "turn-b"))).rejects.toMatchObject({ code: "THREAD_SESSION_ALREADY_ACTIVE" } satisfies Partial<RuntimeSupervisorError>);
    supervisor.stop({ threadId: "thread-a", turnId: "turn-a" });
    expect(process.messages.at(-1)).toMatchObject({ command: "turn.stop", threadId: "thread-a", turnId: "turn-a" });
    process.emit(event("project:project-1", "thread-a", "turn-a", "thread:thread-a", 1, "turn.completed"));
    expect(supervisor.snapshot().workers[0]!.activeThreadIds).toEqual([]);
  });

  it("rejects stale session events and fans out worker crashes", async () => {
    const process = new FakeProcess();
    const interrupted = vi.fn();
    const events: AgentRuntimeEvent[] = [];
    const supervisor = new AgentRuntimeSupervisor({ factory: { start: (input) => { process.onEvent(input.onEvent); process.onExit(input.onExit); return process; } }, onEvent: (value) => events.push(value), onTurnInterrupted: interrupted });
    const owner = { kind: "project" as const, projectId: "project-1", projectPath: "C:/project" };
    await supervisor.execute(command(owner, "thread-a", "turn-a"));
    await supervisor.execute(command(owner, "thread-b", "turn-b"));
    process.emit(event("project:project-1", "thread-a", "turn-a", "thread:thread-a", 1, "turn.started"));
    process.emit(event("project:project-1", "thread-a", "turn-a", "thread:thread-a", 1, "turn.completed"));
    expect(events).toHaveLength(1);
    process.crash();
    expect(interrupted).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot().workers).toEqual([]);
    expect(supervisor.snapshot().crashCount).toBe(1);
  });

  it("isolates Unscoped Workers and drains bounded local jobs", async () => {
    const processes: FakeProcess[] = [];
    const supervisor = new AgentRuntimeSupervisor({ factory: factoryFor(processes) });
    await supervisor.execute(command({ kind: "unscoped", threadId: "thread-a", workPath: "C:/a" }, "thread-a", "turn-a"));
    await supervisor.execute(command({ kind: "unscoped", threadId: "thread-b", workPath: "C:/b" }, "thread-b", "turn-b"));
    expect(processes).toHaveLength(2);

    const manifests: LocalJobManifest[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const jobs = new LocalJobSupervisor({
      capacity: 1,
      adapter: { run: async (manifest) => { manifests.push(manifest); if (manifest.jobId === "job-a") await first; return { outputPaths: manifest.outputPaths, outputBytes: 1 }; } }
    });
    const one = jobs.submit({ jobId: "job-a", kind: "utility", stagingDirectory: "stage/a", inputPaths: [], outputPaths: ["stage/a/out"], timeoutMs: 1000, maxOutputBytes: 100 });
    const two = jobs.submit({ jobId: "job-b", kind: "isolated", stagingDirectory: "stage/b", inputPaths: [], outputPaths: ["stage/b/out"], timeoutMs: 1000, maxOutputBytes: 100 });
    expect(jobs.snapshot().queued).toEqual(["job-b"]);
    release();
    await expect(one).resolves.toMatchObject({ status: "completed" });
    await expect(two).resolves.toMatchObject({ status: "completed" });
    expect(manifests.map((item) => item.jobId)).toEqual(["job-a", "job-b"]);
  });
});
