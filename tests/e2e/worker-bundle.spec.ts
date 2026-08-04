import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testEnvironment } from "./test-environment";

test("keeps fixture implementations out of the production Agent Worker bundle", () => {
  const root = resolve(import.meta.dirname, "../..");
  const production = readJavaScriptBundle(join(root, "apps/agent-worker/dist"));
  const testing = readJavaScriptBundle(join(root, "apps/agent-worker/dist-test"));
  const fixtureMarkers = /Dogfood Investment Note|Fixture Sub-Agent Output|vc-agent-sub-agent-faux|VC_AGENT_TEST_WORKER_CRASH_ON_COMPACTION/u;
  expect(production).not.toMatch(fixtureMarkers);
  expect(testing).toMatch(fixtureMarkers);
});

test("boots the built Agent Worker and completes a Project Turn", async () => {
  const fixture = await launchWorkerFixture();
  try {
    await fixture.window.getByRole("textbox", { name: "Message" }).fill("Return exactly OK.");
    await fixture.window.getByRole("button", { name: "Send", exact: true }).click();

    await expect(fixture.window.locator(".assistant-message.completed").last()).toBeVisible({ timeout: 10_000 });
    await expect(fixture.window.locator(".provider-failure")).toHaveCount(0);
    const response = fixture.window.locator(".assistant-message.completed").last();
    await expect(response.getByRole("heading", { name: "Markdown Fixture" })).toBeVisible();
    await expect(response.getByText("strong emphasis", { exact: true })).toBeVisible();
    const markdownTable = response.getByRole("table");
    await expect(markdownTable).toBeVisible();
    await expect(markdownTable).toHaveCSS("overflow-x", "auto");
    await expect(markdownTable.getByRole("columnheader")).toHaveText(["Dimension", "Conclusion", "Evidence"]);
    await expect(markdownTable.getByRole("cell")).toHaveText(["Architecture", "Partially supported", "Paper and public repository"]);
    await expect(response.locator("span", { hasText: "unsafe fixture markup" })).toHaveCount(0);

    await selectElementText(response.getByText("strong emphasis", { exact: true }));
    await fixture.window.getByRole("button", { name: "Add to task" }).click();
    const quotes = fixture.window.getByLabel("Conversation Quotes");
    await expect(quotes).toContainText("strong emphasis");
    await expect(fixture.window.getByLabel("Message")).toBeFocused();

    await quotes.getByRole("button", { name: "Remove conversation quote" }).click();
    await expect(quotes).toHaveCount(0);

    await selectElementText(response.getByText("strong emphasis", { exact: true }));
    await fixture.window.getByRole("button", { name: "Add to task" }).click();
    await fixture.window.getByLabel("Message").fill("Focus on this excerpt.");
    await fixture.window.getByRole("button", { name: "Send", exact: true }).click();
    const submitted = fixture.window.locator(".user-message").last();
    await expect(submitted.locator(".submitted-conversation-quote")).toContainText("strong emphasis");
    await expect(submitted.locator(".user-message-text")).toHaveText("Focus on this excerpt.");
    await expect(submitted).not.toContainText("<conversation_quotes>");
    await expect.poll(() => latestSubmittedText(fixture.trajectoryPath)).toContain('<conversation_quote source_turn="');
    await expect(fixture.window.locator(".assistant-message.completed")).toHaveCount(2, { timeout: 10_000 });

    await fixture.window.reload();
    await fixture.window.getByRole("button", { name: "Worker Bundle Test", exact: true }).click();
    const restored = fixture.window.locator(".user-message").last();
    await expect(restored.locator(".submitted-conversation-quote")).toContainText("strong emphasis");
    await expect(restored.locator(".user-message-text")).toHaveText("Focus on this excerpt.");

    await fixture.window.getByLabel("Message").fill("/compact");
    await fixture.window.getByLabel("Message").press("Enter");
    await expect(fixture.window.getByText(/Thread compaction started/u)).toBeVisible({ timeout: 10_000 });
    await expect(fixture.window.getByText(/Thread compaction (completed|failed):/u)).toBeVisible({ timeout: 10_000 });
  } finally {
    await fixture.close();
  }
});

test("reports a Worker crash during manual compaction as a compaction failure", async () => {
  const fixture = await launchWorkerFixture({ VC_AGENT_TEST_WORKER_CRASH_ON_COMPACTION: "1" });
  try {
    await fixture.window.getByRole("textbox", { name: "Message" }).fill("Return exactly OK.");
    await fixture.window.getByRole("button", { name: "Send", exact: true }).click();
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
      VC_AGENT_TEST_WEB_FIXTURE: "1",
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
    trajectoryPath: join(userDataDirectory, "threads", threadId, "trajectory.jsonl"),
    close: async () => {
      await application.close();
      rmSync(userDataDirectory, { recursive: true, force: true });
      rmSync(projectDirectory, { recursive: true, force: true });
    }
  };
}

async function selectElementText(element: Locator) {
  await element.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
  });
}

function latestSubmittedText(trajectoryPath: string): string {
  return readFileSync(trajectoryPath, "utf8").trim().split("\n").flatMap((line) => {
    const event = JSON.parse(line) as { event?: unknown; payload?: { text?: unknown } };
    return event.event === "turn.submitted" && typeof event.payload?.text === "string" ? [event.payload.text] : [];
  }).at(-1) ?? "";
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

function readJavaScriptBundle(directory: string): string {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? [readJavaScriptBundle(path)]
      : entry.endsWith(".js")
        ? [readFileSync(path, "utf8")]
        : [];
  }).join("\n");
}
