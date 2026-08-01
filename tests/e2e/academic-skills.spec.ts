import { _electron as electron, expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { testEnvironment } from "./test-environment";

test("installs and activates the bundled academic skills from Settings", async () => {
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
    const section = window.getByTestId("skills-settings");
    const install = section.getByRole("button", { name: "Install academic skills" });
    await expect(install).toBeEnabled();
    await install.click();
    await expect(section.getByText("6/6", { exact: true })).toBeVisible();
    await expect(install).toBeDisabled();
    for (const packageId of [
      "paper-technical-diligence",
      "founder-academic-diligence",
      "technical-claim-verification",
      "novelty-and-prior-art-map",
      "research-to-company-map",
      "arxiv-fulltext-reader"
    ]) {
      await expect(section.locator(".profile-row").filter({ hasText: packageId })).toContainText("active");
    }

    const inventoryPath = join(userDataDirectory, "skills", "inventory.json");
    expect(existsSync(inventoryPath)).toBe(true);
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as { packages: Array<{ sourceKind: string; enabled: boolean }> };
    expect(inventory.packages).toHaveLength(6);
    expect(inventory.packages.every((item) => item.sourceKind === "bundled_reviewed" && item.enabled)).toBe(true);
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});
