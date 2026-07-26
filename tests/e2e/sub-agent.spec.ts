import { _electron as electron, expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { testEnvironment } from "./test-environment";

test("creates only an explicit flat bounded Sub-Agent run and restores its task tree", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-sub-agent-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  const application = await electron.launch({ args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`], cwd: root, env: testEnvironment({ VC_AGENT_USER_DATA_DIR: userDataDirectory, VC_AGENT_TEST_SUB_AGENT_FIXTURE: "1" }) });
  try {
    const window = await application.firstWindow();
    await expect(window.getByTestId("empty-workspace")).toBeVisible();
    expect(existsSync(join(userDataDirectory, "delegation", "runs.json"))).toBe(false);
    const profile = await invoke(window, "profile.create", { name: "Fixture", provider: "fixture", model: "fixture-v1", thinkingLevel: "minimal", apiKey: "fixture-secret" });
    expect(profile.event).toBe("profile.created");
    const thread = await invoke(window, "thread.create.unscoped", { title: "Delegation Parent" });
    const parentThreadId = (thread.payload as { thread: { id: string } }).thread.id;
    const profileId = (profile.payload as { profile: { id: string } }).profile.id;
    const selected = await invoke(window, "thread.profile.select", { threadId: parentThreadId, profileId });
    expect(selected.event).toBe("thread.profile.selected");
    const outputPath = join(userDataDirectory, "delegation-output.md");
    const authorized = await invoke(window, "sub_agent.run.authorize", {
      parentThreadId, parentTurnId: "turn-explicit",
      explicitIntentEvidence: { source: "user", text: "I explicitly authorize parallel research, critique and synthesis for this current task.", confirmed: true, taskLifetime: "current_task" },
      taskLimit: 4, sharedTokenBudget: 8_000,
      tasks: [
        { role: "researcher", objective: "Research bounded evidence.", contextBoundary: { scope: "unscoped", sourceReferenceIds: ["evidence:research"], maxChars: 2_000 }, capabilitySet: ["read_context"] },
        { role: "critic", objective: "Critique the bounded evidence.", contextBoundary: { scope: "unscoped", sourceReferenceIds: ["evidence:research"], maxChars: 2_000 }, capabilitySet: ["read_context"] },
        { role: "synthesizer", objective: "Synthesize the two bounded passes.", contextBoundary: { scope: "unscoped", sourceReferenceIds: ["evidence:research"], maxChars: 2_000 }, capabilitySet: ["read_context"] },
        { role: "writer", objective: "Write a source-referenced handoff.", contextBoundary: { scope: "unscoped", sourceReferenceIds: ["evidence:research"], maxChars: 2_000, outputRoot: userDataDirectory }, capabilitySet: ["read_context", "write_output"], outputTarget: outputPath }
      ]
    });
    expect(authorized.event).toBe("sub_agent.run.authorized");
    await window.getByRole("button", { name: "Settings" }).click();
    await expect(window.getByTestId("delegation-settings")).toBeVisible();
    await expect(window.getByText("Sub-Agent Delegation", { exact: true })).toBeVisible();
    await expect.poll(async () => (await invoke(window, "sub_agent.run.inspect", { runId: (authorized.payload as { projection: { run: { id: string } } }).projection.run.id })).payload).toMatchObject({ projection: { run: { status: "completed" } } });
    const runId = (authorized.payload as { projection: { run: { id: string } } }).projection.run.id;
    const inspected = await invoke(window, "sub_agent.run.inspect", { runId });
    const projection = (inspected.payload as { projection: { tasks: Array<{ role: string; status: string; handoff?: { outputPath?: string; provenance: unknown[] } }> } }).projection;
    expect(projection.tasks).toHaveLength(4);
    expect(projection.tasks.every((task) => task.status === "completed")).toBe(true);
    expect(projection.tasks.find((task) => task.role === "writer")?.handoff?.provenance).toHaveLength(1);
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toContain("Fixture Sub-Agent Output");
    const list = await invoke(window, "sub_agent.run.list", {});
    expect((list.payload as { projections: unknown[] }).projections).toHaveLength(1);
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});

async function invoke(window: import("@playwright/test").Page, command: string, payload: Record<string, unknown> = {}) {
  return window.evaluate(async ({ command: commandName, payload: commandPayload }) => {
    const bridge = (window as unknown as { vcAgent: { invoke(command: unknown): Promise<unknown> } }).vcAgent;
    return bridge.invoke({ schemaVersion: 1, command: commandName, commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actor: { actorType: "user", actorId: "e2e" }, sentAt: new Date().toISOString(), payload: commandPayload });
  }, { command, payload }) as Promise<{ event: string; payload: unknown }>;
}
