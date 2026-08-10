import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { testEnvironment } from "./test-environment";

test("uses the dedicated Pi Skills directory without a legacy activation UI", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-academic-skills-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  const application = await electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: testEnvironment({ VC_AGENT_USER_DATA_DIR: userDataDirectory })
  });
  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "Settings" }).click();
    const resources = window.getByTestId("pi-resources-settings");
    await expect(resources.getByTestId("pi-skills-settings")).toBeVisible();
    await expect(resources.getByText(/Only the dedicated VC Agent Skills directory/i)).toBeVisible();
    await expect(window.getByRole("button", { name: "Install academic skills" })).toHaveCount(0);
    await expect(window.getByRole("button", { name: /activate/i })).toHaveCount(0);
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});
