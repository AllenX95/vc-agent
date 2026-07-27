import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testEnvironment } from "./test-environment";

test("switches the complete application chrome between English and Chinese", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-localization-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  const application = await electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: testEnvironment({ VC_AGENT_USER_DATA_DIR: userDataDirectory })
  });

  try {
    const window = await application.firstWindow();
    await expect(window.getByText("Unscoped Threads", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "Language" }).click();

    await expect(window.getByLabel("Navigation").getByText("独立任务", { exact: true })).toBeVisible();
    await expect(window.getByText("尚未选择任务", { exact: true })).toBeVisible();
    await expect(window.getByRole("button", { name: "设置" })).toBeVisible();
    await expect(window.getByRole("complementary", { name: "项目状态" })).toBeVisible();
    await expect.poll(() => window.evaluate(() => document.documentElement.lang)).toBe("zh-CN");

    await window.reload();
    await expect(window.getByLabel("Navigation").getByText("独立任务", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "语言" }).click();
    await expect(window.getByText("Unscoped Threads", { exact: true })).toBeVisible();
    await expect.poll(() => window.evaluate(() => document.documentElement.lang)).toBe("en");
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});
