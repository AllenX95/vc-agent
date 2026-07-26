const inheritedEnvironmentKeys = [
  "PATH",
  "Path",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "COMSPEC",
  "PATHEXT",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "PYTHONUTF8"
] as const;

/**
 * Builds the environment inherited by a desktop E2E child process.
 * VC_AGENT_* variables are never copied implicitly; tests must opt into a
 * real dependency or fixture adapter through explicit overrides.
 */
export function testEnvironment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of inheritedEnvironmentKeys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.NODE_ENV = "test";
  environment.VC_AGENT_PYTHON = resolveParserPython();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}
import { resolveParserPython } from "../../apps/utility-worker/src/python-runtime";
