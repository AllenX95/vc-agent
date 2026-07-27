import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testEnvironment } from "./test-environment";

test("boots the built Agent Worker and completes a Project Turn", async () => {
  const fixture = await launchWorkerFixture();
  try {
    await fixture.window.getByRole("textbox", { name: "Message" }).fill("Return exactly OK.");
    await fixture.window.getByRole("button", { name: "Send" }).click();

    await expect(fixture.window.locator(".assistant-message.completed").last()).toBeVisible({ timeout: 10_000 });
    await expect(fixture.window.locator(".provider-failure")).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test("reports a Worker crash during manual compaction as a compaction failure", async () => {
  const fixture = await launchWorkerFixture({ VC_AGENT_TEST_WORKER_CRASH_ON_COMPACTION: "1" });
  try {
    await fixture.window.getByRole("textbox", { name: "Message" }).fill("Return exactly OK.");
    await fixture.window.getByRole("button", { name: "Send" }).click();
    await expect(fixture.window.locator(".assistant-message.completed").last()).toBeVisible({ timeout: 10_000 });

    const compact = fixture.window.getByRole("button", { name: "Compact thread" });
    await expect(compact).toBeEnabled({ timeout: 10_000 });
    await compact.click();

    await expect(fixture.window.getByText(/Thread compaction failed:/u)).toBeVisible({ timeout: 10_000 });
    await expect(fixture.window.getByText(/Thread compaction started/u)).toBeVisible();
  } finally {
    await fixture.close();
  }
});

async function launchWorkerFixture(extraEnvironment: Record<string, string> = {}) {
  const root = resolve(import.meta.dirname, "../..");
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-worker-bundle-e2e-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-worker-project-e2e-"));
  const application = await electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: testEnvironment({
      VC_AGENT_USER_DATA_DIR: userDataDirectory,
      VC_AGENT_TEST_PROJECT_PATH: projectDirectory,
      ...extraEnvironment
    })
  });
  const window = await application.firstWindow();
  const opened = await invoke(window, "project.open");
  const projectId = (opened.payload as { project: { id: string } }).project.id;
  const created = await invoke(window, "thread.create.project", { projectId, title: "Worker Bundle Test" });
  const threadId = (created.payload as { thread: { id: string } }).thread.id;
  const profile = await invoke(window, "profile.create", {
    name: "Worker Bundle Faux",
    provider: "vc-agent-faux",
    model: "fixture",
    apiKey: "fixture-key",
    thinkingLevel: "off"
  });
  const profileId = (profile.payload as { profile: { id: string } }).profile.id;
  await invoke(window, "thread.profile.select", { threadId, profileId });
  await window.reload();
  await window.getByRole("button", { name: "Worker Bundle Test", exact: true }).click();

  return {
    window,
    close: async () => {
      await application.close();
      rmSync(userDataDirectory, { recursive: true, force: true });
      rmSync(projectDirectory, { recursive: true, force: true });
    }
  };
}

async function invoke(window: Page, command: string, payload: Record<string, unknown> = {}) {
  return window.evaluate(async ({ command: commandName, payload: commandPayload }) => {
    const bridge = (window as unknown as {
      vcAgent: { invoke(command: unknown): Promise<{ event: string; payload: unknown }> };
    }).vcAgent;
    return bridge.invoke({
      schemaVersion: 1,
      command: commandName,
      commandId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      actor: { actorType: "user", actorId: "worker-bundle-e2e" },
      sentAt: new Date().toISOString(),
      payload: commandPayload
    });
  }, { command, payload });
}
