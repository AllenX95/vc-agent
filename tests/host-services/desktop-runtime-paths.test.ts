import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { resolveDesktopRuntimePaths } from "../../apps/desktop/src/main/runtime-paths";

describe("desktop packaged runtime paths", () => {
  it("uses workspace build outputs during development", () => {
    const mainDirectory = resolve("apps/desktop/dist/main");
    expect(resolveDesktopRuntimePaths({
      isPackaged: false,
      resourcesPath: resolve("unused"),
      mainDirectory,
      environment: {}
    })).toEqual({
      agentWorkerEntry: resolve("apps/agent-worker/dist/index.js"),
      utilityWorkerEntry: resolve("apps/utility-worker/dist/index.js")
    });
  });

  it("uses ordinary resource files in a packaged application", () => {
    const resourcesPath = resolve("release/resources");
    const paths = resolveDesktopRuntimePaths({
      isPackaged: true,
      resourcesPath,
      mainDirectory: resolve("release/resources/app.asar/apps/desktop/dist/main"),
      environment: { VC_AGENT_PYTHON: join(resourcesPath, "custom-parser", "python.exe") }
    });
    expect(paths).toEqual({
      agentWorkerEntry: join(resourcesPath, "workers", "agent-worker", "dist", "index.js"),
      utilityWorkerEntry: join(resourcesPath, "workers", "utility-worker", "dist", "index.js"),
      parserPython: join(resourcesPath, "custom-parser", "python.exe")
    });
  });
});
