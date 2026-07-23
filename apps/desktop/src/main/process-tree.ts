import { spawn } from "node:child_process";

/** Kill an Electron child and any parser/model descendants it owns. */
export function terminateProcessTree(pid: number | undefined, fallbackKill: () => void): void {
  if (pid === undefined || process.platform !== "win32") {
    fallbackKill();
    return;
  }
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  let settled = false;
  const fallback = () => { if (settled) return; settled = true; try { fallbackKill(); } catch { /* The child may already have exited. */ } };
  killer.once("error", fallback);
  killer.once("close", (code) => { if (code !== 0) fallback(); else settled = true; });
}

export function waitForProcessExit(register: (callback: () => void) => void, deadlineMs: number): Promise<boolean> {
  if (deadlineMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (exited: boolean) => { if (done) return; done = true; clearTimeout(timer); resolve(exited); };
    const timer = setTimeout(() => finish(false), deadlineMs);
    register(() => finish(true));
  });
}
