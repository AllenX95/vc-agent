import { _electron as electron, expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { testEnvironment } from "./test-environment";

const root = resolve(import.meta.dirname, "../..");
const executable = resolve(process.env.VC_AGENT_PACKAGED_EXE ?? join(root, "release", "win-unpacked", "VC Agent.exe"));

test("launches the packaged Windows application with its bounded runtimes", async () => {
  expect(process.platform).toBe("win32");
  expect(existsSync(executable), `packaged executable is missing: ${executable}`).toBe(true);

  const resources = join(executable, "..", "resources");
  for (const path of [
    join(resources, "app.asar"),
    join(resources, "workers", "agent-worker", "dist", "index.js"),
    join(resources, "workers", "utility-worker", "dist", "index.js"),
    join(resources, "workers", "utility-worker", "dist", "parser.py"),
    join(resources, "parser-runtime", "python.exe"),
    join(resources, "parser-runtime", "runtime-manifest.json")
  ]) expect(existsSync(path), `missing packaged resource ${path}`).toBe(true);

  const parserManifest = JSON.parse(readFileSync(join(resources, "parser-runtime", "runtime-manifest.json"), "utf8")) as {
    kind: string;
    architecture: string;
  };
  expect(parserManifest).toMatchObject({ kind: "vc-agent-parser-runtime", architecture: "x64" });

  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-packaged-e2e-"));
  const application = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userDataDirectory}`],
    env: testEnvironment({ VC_AGENT_USER_DATA_DIR: userDataDirectory })
  });
  try {
    const window = await application.firstWindow();
    await expect(window).toHaveTitle("vc-agent");
    await expect(window.getByLabel("Navigation")).toBeVisible();
    await expect(window.getByTestId("empty-workspace")).toBeVisible();

    const bootstrap = await window.evaluate(async () => {
      return (window as unknown as { vcAgent: { invoke(command: unknown): Promise<unknown> } }).vcAgent.invoke({
        schemaVersion: 1,
        command: "app.bootstrap",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        actor: { actorType: "user", actorId: "packaged-e2e" },
        sentAt: new Date().toISOString()
      });
    });
    expect(bootstrap).toMatchObject({
      event: "app.bootstrap.completed",
      payload: {
        runtimeActivity: {
          agentWorkersStarted: 0,
          piSessionsStarted: 0,
          providerRequests: 0,
          externalNetworkRequests: 0
        }
      }
    });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});
