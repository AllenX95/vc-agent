import { _electron as electron, expect, test } from "@playwright/test";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

test("launches the empty shell without activating execution resources", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  const application = await electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", VC_AGENT_USER_DATA_DIR: userDataDirectory }
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

test("retains a missing-Profile turn and runs Pi only after manual Profile selection and retry", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-f2-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  const apiKey = "sk-invalid-vc-agent-e2e-secret";
  const application = await electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", VC_AGENT_USER_DATA_DIR: userDataDirectory }
  });

  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "New thread" }).click();
    await expect(window.getByRole("heading", { name: "Thread 1" })).toBeVisible();
    await window.getByLabel("Message").fill("Reply with one short sentence.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(window.getByText("Model Profile not configured")).toBeVisible();

    const beforeProfile = await invokeBootstrap(window);
    expect(beforeProfile).toMatchObject({
      payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } }
    });

    await window.getByRole("button", { name: "Adjust profile" }).click();
    await window.getByRole("button", { name: "New profile" }).click();
    await window.getByLabel("Name").fill("Invalid key fixture");
    await window.getByLabel("Provider").fill("anthropic");
    await window.getByLabel("Model").fill("claude-sonnet-4-5");
    await window.getByLabel("API key").fill(apiKey);
    await window.getByRole("button", { name: "Save profile" }).click();
    await expect(window.getByText("Invalid key fixture", { exact: true })).toBeVisible();

    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Invalid key fixture" });
    await expect(window.getByText("anthropic / claude-sonnet-4-5", { exact: true }).first()).toBeVisible();
    await window.getByRole("button", { name: "Retry" }).click();

    await expect(window.locator(".provider-failure")).toHaveCount(2, { timeout: 30_000 });
    const providerFailure = window.locator(".provider-failure").last();
    await expect(providerFailure).not.toContainText(apiKey);
    await expect(providerFailure).toContainText("anthropic / claude-sonnet-4-5");

    const afterRetry = await invokeBootstrap(window);
    expect(afterRetry).toMatchObject({
      payload: { runtimeActivity: { agentWorkersStarted: 1, piSessionsStarted: 1, providerRequests: 1 } }
    });

    const database = new DatabaseSync(join(userDataDirectory, "state.db"), { readOnly: true });
    const credential = database.prepare("SELECT encrypted_value FROM protected_credentials").get() as { encrypted_value: Uint8Array };
    const profileColumns = database.prepare("PRAGMA table_info(model_profiles)").all().map((row) => String(row.name));
    database.close();
    expect(Buffer.from(credential.encrypted_value).toString("utf8")).not.toContain(apiKey);
    expect(profileColumns).not.toContain("api_key");
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});

async function invokeBootstrap(window: { evaluate<T>(fn: () => Promise<T>): Promise<T> }) {
  return window.evaluate(async () => {
    return (window as unknown as { vcAgent: { invoke(command: unknown): Promise<unknown> } }).vcAgent.invoke({
      schemaVersion: 1,
      command: "app.bootstrap",
      commandId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      actor: { actorType: "user", actorId: "e2e" },
      sentAt: new Date().toISOString()
    });
  });
}
