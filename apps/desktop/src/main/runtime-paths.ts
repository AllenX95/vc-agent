import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface DesktopRuntimePathInput {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly mainDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface DesktopRuntimePaths {
  readonly agentWorkerEntry: string;
  readonly utilityWorkerEntry: string;
  readonly bundledAcademicSkillsRoot: string;
  readonly parserPython?: string;
}

/**
 * Keeps repository paths out of the packaged runtime contract.
 *
 * Packaged workers are copied to resources/workers instead of app.asar so
 * Electron Utility Processes and the external Python interpreter both receive
 * ordinary filesystem paths. Development continues to execute the workspace
 * build outputs directly.
 */
export function resolveDesktopRuntimePaths(input: DesktopRuntimePathInput): DesktopRuntimePaths {
  const environment = input.environment ?? process.env;
  if (!input.isPackaged) {
    const useTestAgentWorker = environment.NODE_ENV === "test"
      && environment.VC_AGENT_TEST_AGENT_WORKER_ADAPTER === "1";
    return {
      agentWorkerEntry: resolve(input.mainDirectory, useTestAgentWorker
        ? "../../../agent-worker/dist-test/index.js"
        : "../../../agent-worker/dist/index.js"),
      utilityWorkerEntry: resolve(input.mainDirectory, "../../../utility-worker/dist/index.js"),
      bundledAcademicSkillsRoot: resolve(input.mainDirectory, "../../../../skills/academic-research"),
      ...(nonEmpty(environment.VC_AGENT_PYTHON) === undefined ? {} : { parserPython: resolve(environment.VC_AGENT_PYTHON!) })
    };
  }

  const parserOverride = nonEmpty(environment.VC_AGENT_PYTHON);
  const bundledParser = join(input.resourcesPath, "parser-runtime", "python.exe");
  return {
    agentWorkerEntry: join(input.resourcesPath, "workers", "agent-worker", "dist", "index.js"),
    utilityWorkerEntry: join(input.resourcesPath, "workers", "utility-worker", "dist", "index.js"),
    bundledAcademicSkillsRoot: join(input.resourcesPath, "bundled-skills", "academic-research"),
    ...(parserOverride !== undefined
      ? { parserPython: resolve(parserOverride) }
      : existsSync(bundledParser)
        ? { parserPython: bundledParser }
        : {})
  };
}

export function validatePackagedRuntimePaths(paths: DesktopRuntimePaths): readonly string[] {
  return [
    ...(existsSync(paths.agentWorkerEntry) ? [] : ["Agent Worker"]),
    ...(existsSync(paths.utilityWorkerEntry) ? [] : ["Utility Worker"]),
    ...(existsSync(paths.bundledAcademicSkillsRoot) ? [] : ["Bundled academic Skills"]),
    ...(paths.parserPython !== undefined && existsSync(paths.parserPython) ? [] : ["Parser runtime"])
  ];
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}
