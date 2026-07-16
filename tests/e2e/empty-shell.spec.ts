import { _electron as electron, expect, test } from "@playwright/test";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test("launches the empty shell without activating execution resources", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  const application = await electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: { ...process.env, NODE_ENV: "test" }
  });

  try {
    const window = await application.firstWindow();
    await expect(window).toHaveTitle("vc-agent");
    await expect(window.getByLabel("Navigation")).toBeVisible();
    await expect(window.getByTestId("empty-workspace")).toBeVisible();
    await expect(window.getByRole("complementary", { name: "Project state" })).toBeVisible();
    await expect(window.getByText("No threads", { exact: true })).toBeVisible();
    await expect(window.getByText("No projects", { exact: true })).toBeVisible();

    const bootstrap = await window.evaluate(async () => {
      const bridge = (window as unknown as {
        vcAgent: { invoke(command: unknown): Promise<{ event: string; payload: unknown }> };
      }).vcAgent;
      return bridge.invoke({
        schemaVersion: 1,
        command: "app.bootstrap",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        actor: { actorType: "user", actorId: "e2e" },
        sentAt: new Date().toISOString()
      });
    });
    expect(bootstrap).toMatchObject({
      event: "app.bootstrap.completed",
      payload: {
        entityCounts: { projects: 0, threads: 0, modelProfiles: 0, taskAssignments: 0 },
        runtimeActivity: {
          agentWorkersStarted: 0,
          piSessionsStarted: 0,
          providerRequests: 0,
          externalNetworkRequests: 0
        }
      }
    });

    await window.getByRole("button", { name: "Settings" }).click();
    await expect(window.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(window.getByText("Agent workers")).toBeVisible();
    await expect(window.locator("dl").nth(1).getByText("0", { exact: true })).toHaveCount(3);

    await window.evaluate(async () => {
      await (window as unknown as { vcAgent: { invoke(command: unknown): Promise<unknown> } }).vcAgent.invoke({
        schemaVersion: 999,
        command: "app.bootstrap",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        actor: { actorType: "user", actorId: "e2e" },
        sentAt: new Date().toISOString()
      });
    });
    await expect(window.getByRole("alert")).toContainText("UNSUPPORTED_SCHEMA_VERSION");
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});
