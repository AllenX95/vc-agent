import { describe, expect, it } from "vitest";
import {
  ProviderSubAgentAdapter,
  type SubAgentProviderExecutionInput,
  type SubAgentProviderExecutionResult
} from "@vc-agent/host-services";

describe("ProviderSubAgentAdapter", () => {
  it("executes an isolated task with bounded scope and returns a parent-review handoff", async () => {
    let received: SubAgentProviderExecutionInput | undefined;
    const executor = {
      execute: async (input: SubAgentProviderExecutionInput): Promise<SubAgentProviderExecutionResult> => {
        received = input;
        return {
          assistantMessage: "Bounded provider result.",
          usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 }
        };
      }
    };
    const adapter = new ProviderSubAgentAdapter(executor);
    const result = await adapter.execute({
      run: {
        schemaVersion: 1,
        id: "11111111-1111-4111-8111-111111111111",
        parentThreadId: "parent-thread",
        parentTurnId: "parent-turn",
        explicitIntentEvidence: { source: "user", text: "Delegate this task.", confirmed: true, taskLifetime: "current_task" },
        taskLimit: 1,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        status: "running",
        taskIds: [],
        createdAt: "2026-07-26T00:00:00.000Z",
        updatedAt: "2026-07-26T00:00:00.000Z"
      },
      task: {
        schemaVersion: 1,
        id: "22222222-2222-4222-8222-222222222222",
        runId: "11111111-1111-4111-8111-111111111111",
        role: "researcher",
        objective: "Research only the bounded question.",
        contextBoundary: { scope: "unscoped", sourceReferenceIds: ["material:1"], maxChars: 1_000 },
        capabilitySet: ["read_context"],
        resolvedProfile: { profileId: "profile-1", name: "Primary", provider: "anthropic", model: "claude-test", thinkingLevel: "low" },
        status: "running",
        attemptIds: ["33333333-3333-4333-8333-333333333333"],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        createdAt: "2026-07-26T00:00:00.000Z",
        updatedAt: "2026-07-26T00:00:00.000Z"
      },
      attempt: {
        schemaVersion: 1,
        id: "33333333-3333-4333-8333-333333333333",
        taskId: "22222222-2222-4222-8222-222222222222",
        instructionRevision: 1,
        profile: { profileId: "profile-1", name: "Primary", provider: "anthropic", model: "claude-test", thinkingLevel: "low" },
        status: "running",
        messages: [{ role: "user", content: "Research only the bounded question." }],
        toolEvents: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        createdAt: "2026-07-26T00:00:00.000Z",
        updatedAt: "2026-07-26T00:00:00.000Z"
      },
      signal: new AbortController().signal
    });

    expect(adapter.kind).toBe("provider");
    expect(received?.attemptId).toBe("33333333-3333-4333-8333-333333333333");
    expect(received?.profile.provider).toBe("anthropic");
    expect(received?.prompt).toContain("Research only the bounded question.");
    expect(received?.prompt).toContain("material:1");
    expect(received?.prompt).not.toContain("parent-turn-body");
    expect(result.assistantMessage).toBe("Bounded provider result.");
    expect(result.usage.totalTokens).toBe(19);
    expect(result.handoff?.adoptedByParent).toBe(false);
    expect(result.handoff?.provenance[0]?.referenceId).toBe("material:1");
  });
});
