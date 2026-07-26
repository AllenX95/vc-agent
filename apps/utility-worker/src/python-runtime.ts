import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ParserRuntimeResolutionOptions {
  readonly executable?: string;
  readonly runtimeRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

/**
 * Resolves the Python executable used by the local parser.
 *
 * Explicit configuration wins. When no executable is configured, the parser
 * venv created by the local OCR deployment is preferred over the ambient
 * system Python. The final `python` fallback is intentionally retained so a
 * normal development installation can still report a useful dependency
 * error from the child process.
 */
export function resolveParserPython(options: ParserRuntimeResolutionOptions = {}): string {
  const environment = options.environment ?? process.env;
  const explicit = options.executable?.trim() || environment.VC_AGENT_PYTHON?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;

  const runtimeRoot = options.runtimeRoot?.trim() || environment.VC_AGENT_OCR_RUNTIME_ROOT?.trim();
  if (runtimeRoot !== undefined && runtimeRoot !== "") {
    const executable = options.platform === "win32" || (options.platform === undefined && process.platform === "win32")
      ? join(runtimeRoot, "venv", "Scripts", "python.exe")
      : join(runtimeRoot, "venv", "bin", "python");
    if (existsSync(executable)) return executable;
  }

  return "python";
}
