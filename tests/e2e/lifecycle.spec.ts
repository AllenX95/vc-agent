import { _electron as electron, expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("keeps one desktop writer and exits the second instance", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-single-instance-"));
  const root = resolve(import.meta.dirname, "../..");
  let first: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let second: ReturnType<typeof spawn> | undefined;
  try {
    first = await electron.launch({ args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`], cwd: root, env: { ...process.env, NODE_ENV: "test", VC_AGENT_USER_DATA_DIR: userDataDirectory } });
    await expect(first.firstWindow()).resolves.toBeTruthy();
    second = spawn(first.process().spawnfile, [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`], { cwd: root, env: { ...process.env, NODE_ENV: "test", VC_AGENT_USER_DATA_DIR: userDataDirectory }, windowsHide: true, stdio: "ignore" });
    await expect.poll(() => second!.exitCode, { timeout: 10_000 }).not.toBeNull();
    expect(first.process().exitCode).toBeNull();
  } finally {
    if (second !== undefined && second.exitCode === null) second.kill();
    await first?.close().catch(() => undefined);
    expect(existsSync(userDataDirectory)).toBe(true);
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});
