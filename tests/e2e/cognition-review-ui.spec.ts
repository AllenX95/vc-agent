import { _electron as electron, expect, test } from "@playwright/test";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { testEnvironment } from "./test-environment";

test("cognition settings expose intent profiles and the Memory Review entry point", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-cognition-ui-"));
  const root = resolve(import.meta.dirname, "../..");
  const application = await electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: testEnvironment({ VC_AGENT_USER_DATA_DIR: userDataDirectory })
  });

  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "Settings" }).click();
    await expect(window.getByLabel("Reflection Profile")).toBeVisible();
    await expect(window.getByLabel("Memory Review Profile")).toBeVisible();
    await expect(window.getByLabel("Independent Evidence Profile")).toHaveCount(0);
    await expect(window.getByLabel("Memory-Aware Reflection Profile")).toHaveCount(0);

    await window.getByLabel("Settings views").getByRole("tab", { name: "Memory", exact: true }).click();
    await expect(window.getByRole("button", { name: "Prepare Memory Review", exact: true })).toBeVisible();
    await expect(window.getByText("Dream", { exact: true })).toHaveCount(0);
    await expect(window.getByRole("button", { name: /scope extraction|global synthesis|New batch/i })).toHaveCount(0);

    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByRole("button", { name: "New thread", exact: true }).click();
    await window.getByRole("button", { name: "Reflection", exact: true }).click();
    const launch = window.getByRole("dialog", { name: "Start Investment Reflection" });
    await expect(launch).toBeVisible();
    await expect(launch.getByLabel("Reflection Model Profile")).toHaveCount(0);
    await expect(launch.getByRole("button", { name: "Start Reflection", exact: true })).toBeVisible();
    await expect(launch.getByRole("button", { name: /critical dialogue|evidence pass|Judgment Record|Memory patch/i })).toHaveCount(0);
    await launch.getByRole("button", { name: "Start Reflection", exact: true }).click();
    await expect(window.getByTestId("reflection-workspace")).toContainText("Awaiting profile");
    const composer = window.getByRole("textbox", { name: "Message" });
    await expect(composer).toBeVisible();
    await expect(composer).toBeDisabled();
    await expect(composer).toHaveAttribute("placeholder", "Reflection is awaiting profile");
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});
