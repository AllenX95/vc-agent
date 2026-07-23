import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { terminateProcessTree, waitForProcessExit } from "../../apps/desktop/src/main/process-tree.js";

describe("desktop process tree lifecycle", () => {
  it("terminates a managed child within the shutdown deadline", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { windowsHide: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const exited = waitForProcessExit((callback) => child.once("exit", callback), 5_000);
    terminateProcessTree(child.pid, () => child.kill());
    expect(await exited).toBe(true);
    expect(child.exitCode).not.toBeNull();
  });
});
