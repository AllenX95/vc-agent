import { _electron as electron, expect, test } from "@playwright/test";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { testEnvironment } from "./test-environment";

test("edits saved profiles, scrolls long conversations, and sends with Enter", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-ui-details-"));
  const root = resolve(import.meta.dirname, "../..");
  const application = await electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: testEnvironment({ VC_AGENT_USER_DATA_DIR: userDataDirectory })
  });

  try {
    const window = await application.firstWindow();

    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByRole("button", { name: "New profile" }).click();
    await window.getByRole("textbox", { name: "Name", exact: true }).fill("Editable profile");
    await window.getByLabel("Provider").fill("provider-before");
    await window.getByLabel("Model").fill("model-before");
    await window.getByRole("textbox", { name: "API key", exact: true }).fill("fixture-secret");
    await window.getByRole("button", { name: "Save profile" }).click();
    await window.getByRole("button", { name: "Edit Editable profile" }).click();
    await window.getByLabel("Provider").fill("provider-after");
    await window.getByLabel("Model").fill("model-after");
    await window.getByLabel("Context window override").fill("200000");
    await window.getByLabel("Max output tokens override").fill("32000");
    await window.getByRole("button", { name: "Save profile" }).click();
    await expect(window.getByText("provider-after / model-after", { exact: true })).toBeVisible();
    await expect(window.getByText("Context 200,000 · Output 32,000", { exact: true })).toBeVisible();

    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByRole("button", { name: "New thread" }).click();
    const message = window.getByLabel("Message");
    await message.fill("First line");
    await message.press("Shift+Enter");
    await expect(message).toHaveValue("First line\n");
    await expect(window.getByText("Model Profile not configured")).toHaveCount(0);
    await message.fill("Send this with Enter");
    await message.press("Enter");
    await expect(window.getByText("Model Profile not configured")).toBeVisible();

    const messageList = window.locator(".message-list");
    await messageList.evaluate((element) => {
      for (let index = 0; index < 80; index += 1) {
        const row = document.createElement("div");
        row.textContent = `Long context row ${index}`;
        row.style.height = "32px";
        element.append(row);
      }
    });
    await messageList.hover();
    await window.mouse.wheel(0, 700);
    await expect.poll(() => messageList.evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    }))).toMatchObject({ scrollTop: expect.any(Number) });
    const scrollState = await messageList.evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    }));
    expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
    expect(scrollState.scrollTop).toBeGreaterThan(0);
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});
