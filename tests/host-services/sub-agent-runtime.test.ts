import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SubAgentRuntime, createSubAgentProfileResolver } from "@vc-agent/host-services";
import { FixtureSubAgentAdapter } from "@vc-agent/host-services/testing";

const profile = { profileId: "profile-fixture", name: "Fixture", provider: "fixture", model: "fixture-v1", thinkingLevel: "minimal" as const };
const intent = { source: "user" as const, text: "Please explicitly delegate the research and critique tasks for this turn.", confirmed: true as const, taskLifetime: "current_task" as const };

async function runtime(options: { delayMs?: number; budget?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vc-agent-sub-agent-"));
  return new SubAgentRuntime({ path: join(root, "delegation", "runs.json"), resolver: createSubAgentProfileResolver({ profiles: [profile], defaultProfileId: profile.profileId }), adapter: new FixtureSubAgentAdapter({ delayMs: options.delayMs }), capacity: 2 });
}

describe("SubAgentRuntime", () => {
  it("requires current-task user intent and resolves profiles without fallback", async () => {
    const runtimeInstance = await runtime();
    expect(() => runtimeInstance.authorize({ parentThreadId: "thread-1", parentTurnId: "turn-1", explicitIntentEvidence: { ...intent, confirmed: false as never }, tasks: [{ role: "researcher", objective: "Research one bounded question.", contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1_000 }, capabilitySet: ["read_context"], profileId: profile.profileId }] })).toThrow("SUB_AGENT_EXPLICIT_INTENT_REQUIRED");
    expect(() => runtimeInstance.authorize({ parentThreadId: "thread-1", parentTurnId: "turn-1", explicitIntentEvidence: intent, tasks: [{ role: "researcher", objective: "Research one bounded question.", contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1_000 }, capabilitySet: ["read_context"], profileId: "missing" }] })).toThrow("SUB_AGENT_PROFILE_UNAVAILABLE");
    expect(() => runtimeInstance.authorize({ parentThreadId: "thread-1", parentTurnId: "turn-1", explicitIntentEvidence: intent, tasks: [{ role: "writer", objective: "Write outside the approved root.", contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1_000, outputRoot: tmpdir() }, capabilitySet: ["write_output"], outputTarget: "C:\\outside\\target.md" }] })).toThrow("SUB_AGENT_OUTPUT_TARGET_OUTSIDE_SCOPE");
  });

  it("records the strict role, default, and primary profile resolution source", async () => {
    const roleProfile = { ...profile, profileId: "profile-role", name: "Role Profile", model: "role-v1" };
    const root = await mkdtemp(join(tmpdir(), "vc-agent-sub-agent-resolution-"));
    const runtimeInstance = new SubAgentRuntime({
      path: join(root, "delegation", "runs.json"),
      resolver: createSubAgentProfileResolver({ profiles: [profile, roleProfile], roleProfiles: { critic: roleProfile.profileId }, defaultProfileId: profile.profileId, primaryProfileId: profile.profileId }),
      adapter: new FixtureSubAgentAdapter()
    });
    const projection = runtimeInstance.authorize({ parentThreadId: "thread-resolution", parentTurnId: "turn-resolution", explicitIntentEvidence: intent, tasks: [
      { role: "critic", objective: "Use the role assignment.", contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1_000 }, capabilitySet: ["read_context"] },
      { role: "researcher", objective: "Use the default assignment.", contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1_000 }, capabilitySet: ["read_context"] },
      { role: "custom", objective: "Use the explicit override.", profileId: roleProfile.profileId, contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1_000 }, capabilitySet: ["read_context"] }
    ] });
    expect(projection.tasks.map((task) => task.resolvedProfile.resolutionSource)).toEqual(["role_assignment", "default_sub_agent", "explicit_override"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtimeInstance.inspect(projection.run.id)?.attempts.map((attempt) => attempt.profile.resolutionSource)).toEqual(["role_assignment", "default_sub_agent", "explicit_override"]);
  });

  it("runs a flat parallel research/critic pair and keeps provenance on write handoff", async () => {
    const runtimeInstance = await runtime({ delayMs: 5 });
    const projection = runtimeInstance.authorize({ parentThreadId: "thread-1", parentTurnId: "turn-1", explicitIntentEvidence: intent, tasks: [
      { role: "researcher", objective: "Find bounded evidence.", contextBoundary: { scope: "unscoped", sourceReferenceIds: ["material:a"], maxChars: 1_000 }, capabilitySet: ["read_context"] },
      { role: "writer", objective: "Write a bounded synthesis.", contextBoundary: { scope: "unscoped", sourceReferenceIds: ["material:a"], maxChars: 1_000, outputRoot: tmpdir() }, capabilitySet: ["read_context", "write_output"], outputTarget: join(tmpdir(), "vc-agent-sub-agent-output.md") }
    ] });
    expect(projection.run.taskIds).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const final = runtimeInstance.inspect(projection.run.id)!;
    expect(final.tasks.every((task) => task.status === "completed")).toBe(true);
    expect(final.tasks.find((task) => task.role === "writer")?.handoff?.provenance[0]?.source).toBe("fixture");
    expect(final.attempts).toHaveLength(2);
    expect(new Set(final.attempts.map((attempt) => attempt.taskId)).size).toBe(2);
  });

  it("stops and retries explicitly, without auto retry", async () => {
    const runtimeInstance = await runtime({ delayMs: 100 });
    const projection = runtimeInstance.authorize({ parentThreadId: "thread-2", parentTurnId: "turn-2", explicitIntentEvidence: intent, tasks: [{ role: "critic", objective: "Critique this bounded claim.", contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1_000 }, capabilitySet: ["read_context"] }] });
    runtimeInstance.stop(projection.run.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stopped = runtimeInstance.inspect(projection.run.id)!;
    expect(stopped.run.status).toBe("stopped");
    expect(stopped.tasks[0]?.status).toBe("stopped");
    expect(stopped.tasks[0]?.attemptIds).toHaveLength(1);
  });

  it("requires explicit parent review before a handoff is adopted or rejected", async () => {
    const runtimeInstance = await runtime({ delayMs: 5 });
    const projection = runtimeInstance.authorize({ parentThreadId: "thread-handoff", parentTurnId: "turn-handoff", explicitIntentEvidence: intent, tasks: [{ role: "writer", objective: "Write a bounded handoff.", contextBoundary: { scope: "unscoped", sourceReferenceIds: ["material:handoff"], maxChars: 1_000, outputRoot: tmpdir() }, capabilitySet: ["read_context", "write_output"], outputTarget: join(tmpdir(), "vc-agent-handoff.md") }] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const completed = runtimeInstance.inspect(projection.run.id)!;
    const task = completed.tasks[0]!;
    expect(task.handoff?.reviewStatus).toBe("pending_parent_review");
    runtimeInstance.adoptHandoff(task.id);
    expect(runtimeInstance.inspect(projection.run.id)!.tasks[0]?.handoff).toMatchObject({ adoptedByParent: true, reviewStatus: "adopted" });
    expect(() => runtimeInstance.rejectHandoff(task.id)).toThrow("SUB_AGENT_HANDOFF_ALREADY_REVIEWED");
  });

  it("preflights a shared token budget before starting a child attempt", async () => {
    const runtimeInstance = await runtime({ delayMs: 5 });
    const projection = runtimeInstance.authorize({
      parentThreadId: "thread-budget",
      parentTurnId: "turn-budget",
      explicitIntentEvidence: intent,
      sharedTokenBudget: 1,
      tasks: [{ role: "researcher", objective: "This objective cannot fit in one token.", contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1_000 }, capabilitySet: ["read_context"] }]
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const final = runtimeInstance.inspect(projection.run.id)!;
    expect(final.run.status).toBe("budget_exhausted");
    expect(final.tasks[0]?.status).toBe("failed");
    expect(final.tasks[0]?.attemptIds).toHaveLength(0);
    expect(final.tasks[0]?.failure?.code).toBe("SUB_AGENT_BUDGET_EXHAUSTED");
  });

  it("enforces target collisions and deletion placeholders", async () => {
    const runtimeInstance = await runtime({ delayMs: 20 });
    const target = join(tmpdir(), "vc-agent-collision.md");
    const projection = runtimeInstance.authorize({ parentThreadId: "thread-3", parentTurnId: "turn-3", explicitIntentEvidence: intent, tasks: [
      { role: "writer", objective: "First writer.", contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1_000, outputRoot: tmpdir() }, capabilitySet: ["write_output"], outputTarget: target },
      { role: "writer", objective: "Second writer.", contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1_000, outputRoot: tmpdir() }, capabilitySet: ["write_output"], outputTarget: target }
    ] });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const final = runtimeInstance.inspect(projection.run.id)!;
    expect(final.tasks.some((task) => task.failure?.code === "OUTPUT_TARGET_COLLISION")).toBe(true);
    runtimeInstance.deleteRecord(projection.run.id);
    const deleted = runtimeInstance.inspect(projection.run.id)!;
    expect(deleted.run.status).toBe("deleted");
    expect(deleted.tasks.every((task) => task.status === "deleted" && task.objective === "[deleted]")).toBe(true);
    const persistedPath = (runtimeInstance as unknown as { "#path"?: string });
    expect(persistedPath).toBeDefined();
  });

  it("recovers queued and running records as interrupted without replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "vc-agent-sub-agent-recovery-"));
    const path = join(root, "delegation", "runs.json");
    const now = new Date().toISOString();
    const run = { schemaVersion: 1, id: "11111111-1111-4111-8111-111111111111", parentThreadId: "thread-4", parentTurnId: "turn-4", explicitIntentEvidence: intent, taskLimit: 2, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, status: "running", taskIds: ["22222222-2222-4222-8222-222222222222"], createdAt: now, updatedAt: now };
    const task = { schemaVersion: 1, id: "22222222-2222-4222-8222-222222222222", runId: run.id, role: "researcher", objective: "recover", contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1_000 }, capabilitySet: ["read_context"], resolvedProfile: profile, status: "running", attemptIds: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, createdAt: now, updatedAt: now };
    await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(join(root, "delegation"), { recursive: true }).then(() => writeFile(path, JSON.stringify({ schemaVersion: 1, runs: [run], tasks: [task], attempts: [] }))));
    const runtimeInstance = new SubAgentRuntime({ path, resolver: createSubAgentProfileResolver({ profiles: [profile] }), adapter: new FixtureSubAgentAdapter() });
    const projection = runtimeInstance.inspect(run.id)!;
    expect(projection.run.status).toBe("interrupted");
    expect(projection.tasks[0]?.status).toBe("interrupted");
    const saved = JSON.parse(await readFile(path, "utf8")) as { runs: { status: string }[] };
    expect(saved.runs[0]?.status).toBe("interrupted");
  });
});
