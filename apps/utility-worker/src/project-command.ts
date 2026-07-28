import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ProjectCommandInvocation } from "@vc-agent/contracts";

export interface PreparedProjectCommand {
  readonly executable: "rg" | "git" | "pdfinfo";
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface ProjectCommandProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function prepareProjectCommand(
  projectRoot: string,
  invocation: ProjectCommandInvocation
): Promise<PreparedProjectCommand> {
  const root = await realpath(resolve(projectRoot));
  if (invocation.program === "rg") {
    const target = await resolveProjectPath(root, invocation.path);
    return {
      executable: "rg",
      cwd: root,
      args: [
        "--color", "never",
        "--line-number",
        "--no-heading",
        ...(invocation.ignoreCase ? ["--ignore-case"] : []),
        ...(invocation.glob === undefined ? [] : ["--glob", invocation.glob]),
        "--",
        invocation.query,
        target
      ]
    };
  }
  if (invocation.program === "pdfinfo") {
    const target = await resolveProjectPath(root, invocation.path);
    return { executable: "pdfinfo", cwd: root, args: [target] };
  }
  const path = invocation.path === undefined ? undefined : await resolveProjectPath(root, invocation.path);
  const safeGitPrefix = [
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c", "submodule.recurse=false",
    "-C", root,
    "--no-pager"
  ];
  if (invocation.operation === "status") {
    return {
      executable: "git",
      cwd: root,
      args: [...safeGitPrefix, "status", "--short", ...(path === undefined ? [] : ["--", path])]
    };
  }
  if (invocation.operation === "diff") {
    return {
      executable: "git",
      cwd: root,
      args: [...safeGitPrefix, "diff", "--no-ext-diff", "--no-textconv", "--", ...(path === undefined ? [] : [path])]
    };
  }
  return {
    executable: "git",
    cwd: root,
    args: [...safeGitPrefix, "log", `--max-count=${invocation.maxCount}`, "--oneline", "--decorate=no", ...(path === undefined ? [] : ["--", path])]
  };
}

export function runPreparedProjectCommand(
  prepared: PreparedProjectCommand,
  options: { readonly timeoutMs: number; readonly maxOutputBytes: number }
): Promise<ProjectCommandProcessResult> {
  return new Promise((resolveResult, reject) => {
    let executable: string;
    try {
      executable = resolveTrustedExecutable(prepared.executable, prepared.cwd);
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(executable, [...prepared.args], {
      cwd: prepared.cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: commandEnvironment()
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let exceeded = false;
    let timedOut = false;
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.length > options.maxOutputBytes) {
        exceeded = true;
        child.kill();
      }
      return combined.subarray(0, options.maxOutputBytes);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) return reject(new Error("Project command exceeded its declared timeout."));
      if (exceeded) return reject(new Error("Project command output exceeded its declared bound."));
      resolveResult({
        exitCode: code ?? -1,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8")
      });
    });
  });
}

function resolveTrustedExecutable(program: PreparedProjectCommand["executable"], projectRoot: string): string {
  const extensions = process.platform === "win32" ? [".exe"] : [""];
  const pathEntries = (process.env.PATH ?? process.env.Path ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = resolve(directory, `${program}${extension}`);
      if (!existsSync(candidate)) continue;
      try {
        accessSync(candidate, constants.X_OK);
        const canonical = realpathSync(candidate);
        const relativePath = relative(realpathSync(projectRoot), canonical);
        if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\") || isAbsolute(relativePath)) {
          return canonical;
        }
      } catch {
        // Continue to the next trusted PATH entry.
      }
    }
  }
  throw new Error(`Allowlisted executable is unavailable: ${program}`);
}

async function resolveProjectPath(projectRoot: string, requestedPath: string): Promise<string> {
  const candidate = await realpath(resolve(projectRoot, requestedPath));
  const relativePath = relative(projectRoot, candidate);
  if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\") || isAbsolute(relativePath)) {
    throw new Error("The requested path resolves outside the active Project folder.");
  }
  return candidate;
}

function commandEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? process.env.Path ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    TEMP: process.env.TEMP ?? "",
    TMP: process.env.TMP ?? "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    NO_COLOR: "1"
  };
}
