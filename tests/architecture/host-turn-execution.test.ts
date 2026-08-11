import type { WorkerCommand } from "@vc-agent/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  HostTurnExecutionModule,
  type ReflectionExecutionContext,
  type TurnContext
} from "../../apps/desktop/src/main/turn-execution";

type ExecuteCommand = Extract<WorkerCommand, { command: "turn.execute" }>;

function command(turnId: string, threadId: string, correlationId = "correlation-1"): ExecuteCommand {
  return {
    schemaVersion: 1,
    command: "turn.execute",
    commandId: `command-${turnId}`,
    correlationId,
    threadId,
    turnId
  } as ExecuteCommand;
}

function turn(turnId: string, threadId: string, correlationId = "correlation-1"): TurnContext {
  return { turnId, threadId, correlationId } as TurnContext;
}

function reflection(turnId: string, threadId: string, runId = "run-1"): ReflectionExecutionContext {
  return { turnId, threadId, runId, correlationId: "correlation-1" } as ReflectionExecutionContext;
}

describe("HostTurnExecutionModule", () => {
  it("owns ordinary Turn admission and releases the thread when the Turn finishes", async () => {
    const execute = vi.fn(async () => undefined);
    const module = new HostTurnExecutionModule(execute);
    const first = turn("turn-1", "thread-1");

    module.start({ kind: "turn", context: first }, command(first.turnId, first.threadId), vi.fn());

    expect(module.isThreadActive("thread-1")).toBe(true);
    expect(module.route("turn-1")).toEqual({ kind: "turn", context: first });
    expect(() => module.start({ kind: "turn", context: turn("turn-2", "thread-1") }, command("turn-2", "thread-1"), vi.fn()))
      .toThrow("already has an active Turn");

    expect(module.finish({ kind: "turn", context: first })).toBe(true);
    expect(module.isThreadActive("thread-1")).toBe(false);
    module.start({ kind: "turn", context: turn("turn-2", "thread-1") }, command("turn-2", "thread-1"), vi.fn());

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  });

  it("routes every Host execution kind through one registry", () => {
    const module = new HostTurnExecutionModule(async () => undefined);
    const ordinary = turn("turn-1", "thread-1");
    const independent = reflection("turn-2", "thread-2");

    module.start({ kind: "turn", context: ordinary }, command(ordinary.turnId, ordinary.threadId), vi.fn());
    module.start({ kind: "reflection", context: independent }, command(independent.turnId, independent.threadId), vi.fn());

    expect(module.activeExecutions().map((execution) => execution.kind)).toEqual([
      "turn",
      "reflection"
    ]);
    expect(module.findReflection("run-1")).toBe(independent);
  });

  it("permits the next isolated Reflection stage only after the prior execution is released", async () => {
    const execute = vi.fn(async () => undefined);
    const module = new HostTurnExecutionModule(execute);
    const independent = reflection("turn-independent", "reflection-thread", "run-1");
    const dialogue = turn("turn-dialogue", "reflection-thread");

    module.start({ kind: "reflection", context: independent }, command(independent.turnId, independent.threadId), vi.fn());
    expect(module.findReflection("run-1")).toBe(independent);
    expect(module.finish({ kind: "reflection", context: independent })).toBe(true);

    module.start({ kind: "turn", context: dialogue }, command(dialogue.turnId, dialogue.threadId), vi.fn());
    expect(module.findReflection("run-1")).toBeUndefined();
    expect(module.route(dialogue.turnId)).toEqual({ kind: "turn", context: dialogue });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  });

  it("rejects a Worker command whose identity differs from its Host context", () => {
    const execute = vi.fn(async () => undefined);
    const module = new HostTurnExecutionModule(execute);
    const context = turn("turn-1", "thread-1");

    expect(() => module.start({ kind: "turn", context }, command("wrong-turn", context.threadId), vi.fn()))
      .toThrow("command identity does not match");
    expect(module.activeExecutions()).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports only active dispatch failures and ignores failures that arrive after cleanup", async () => {
    const dispatches: Array<{ reject(error: unknown): void }> = [];
    const execute = vi.fn(() => new Promise<void>((_resolve, reject) => dispatches.push({ reject })));
    const module = new HostTurnExecutionModule(execute);
    const staleFailure = vi.fn();
    const activeFailure = vi.fn();
    const first = turn("turn-1", "thread-1");
    const second = turn("turn-2", "thread-2");

    module.start({ kind: "turn", context: first }, command(first.turnId, first.threadId), staleFailure);
    module.start({ kind: "turn", context: second }, command(second.turnId, second.threadId), activeFailure);
    await vi.waitFor(() => expect(dispatches).toHaveLength(2));
    module.finish({ kind: "turn", context: first });

    dispatches[0]!.reject(new Error("late failure"));
    dispatches[1]!.reject(new Error("active failure"));

    await vi.waitFor(() => expect(activeFailure).toHaveBeenCalledOnce());
    expect(staleFailure).not.toHaveBeenCalled();
  });
});
