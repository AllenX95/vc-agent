import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { testEnvironment } from "./test-environment";

test("archives, restores, and deletes an entire Project Thread", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-project-thread-lifecycle-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-project-thread-"));
  const root = resolve(import.meta.dirname, "../..");
  const application = await electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: testEnvironment({
      VC_AGENT_USER_DATA_DIR: userDataDirectory,
      VC_AGENT_TEST_PROJECT_PATH: projectDirectory
    })
  });

  try {
    const window = await application.firstWindow();
    await invokeRaw(window, "project.open");
    await window.reload();
    await window.getByRole("button", { name: `New thread in ${basename(projectDirectory)}` }).click();
    await expect(window.getByRole("heading", { name: "Thread 1" })).toBeVisible();

    await window.getByRole("button", { name: "Archive thread" }).click();
    await expect(window.getByText("Archived", { exact: true })).toBeVisible();
    await expect(window.getByRole("button", { name: "Restore Thread 1" })).toBeVisible();

    await window.getByRole("button", { name: "Restore Thread 1" }).click();
    await expect(window.getByText("Archived", { exact: true })).toHaveCount(0);
    await expect(window.getByRole("button", { name: "Thread 1", exact: true })).toBeVisible();

    await window.getByRole("button", { name: "Delete thread" }).click();
    const confirmation = window.getByRole("dialog", { name: "Delete thread" });
    await expect(confirmation).toContainText("Confirmed Memory and Outputs remain.");
    await confirmation.getByRole("button", { name: "Delete thread", exact: true }).click();
    await expect(window.getByText("No active thread", { exact: true })).toBeVisible();
    await expect(window.getByRole("button", { name: "Thread 1", exact: true })).toHaveCount(0);
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

async function invokeRaw(window: Page, command: string, payload?: unknown) {
  return window.evaluate(async ({ command, payload }) => {
    return (window as unknown as { vcAgent: { invoke(command: unknown): Promise<unknown> } }).vcAgent.invoke({
      schemaVersion: 1,
      command,
      commandId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      actor: { actorType: "user", actorId: "e2e" },
      sentAt: new Date().toISOString(),
      ...(payload === undefined ? {} : { payload })
    });
  }, { command, payload });
}
