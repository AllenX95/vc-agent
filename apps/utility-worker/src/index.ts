import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalParseSchema, utilityJobCommandSchema, type UtilityJobEvent } from "@vc-agent/contracts";

const parentPort = process.parentPort;
if (parentPort === undefined) throw new Error("Utility Worker requires an Electron Utility Process parent port");
const children = new Set<ChildProcessWithoutNullStreams>();

parentPort.on("message", (message) => {
  const command = utilityJobCommandSchema.safeParse(message.data);
  if (command.success) void run(command.data);
});

async function run(command: ReturnType<typeof utilityJobCommandSchema.parse>): Promise<void> {
  const python = process.env.VC_AGENT_PYTHON?.trim() || "python";
  const script = join(dirname(fileURLToPath(import.meta.url)), "parser.py");
  const child = spawn(python, [script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: parserEnvironment() });
  children.add(child);
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let exceeded = false;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, command.timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = Buffer.concat([stdout, chunk]);
    if (stdout.length > command.maxOutputBytes) { exceeded = true; child.kill(); }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-20_000); });
  child.stdin.end(JSON.stringify(command));
  const result = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({ code }));
  });
  clearTimeout(timeout);
  children.delete(child);
  if (exceeded) return sendFailure(command.jobId, "OUTPUT_LIMIT_EXCEEDED", "Parser output exceeded its declared bound.", stderr);
  if (timedOut) return sendFailure(command.jobId, "PARSER_TIMEOUT", "Parser exceeded its declared timeout.", stderr);
  if (result.error !== undefined) return sendFailure(command.jobId, "PARSER_RUNTIME_UNAVAILABLE", result.error.message, stderr);
  if (result.code !== 0) return sendFailure(command.jobId, "PARSER_FAILED", "The parser process failed.", stderr);
  try {
    const parse = canonicalParseSchema.parse(JSON.parse(stdout.toString("utf8")));
    mkdirSync(command.stagingDirectory, { recursive: true });
    const artifactPath = join(command.stagingDirectory, "parse.json");
    const partialPath = `${artifactPath}.partial`;
    writeFileSync(partialPath, `${JSON.stringify(parse, null, 2)}\n`, "utf8");
    renameSync(partialPath, artifactPath);
    parentPort.postMessage({ schemaVersion: 1, jobId: command.jobId, event: "material.parse.completed", artifactPath, parse } satisfies UtilityJobEvent);
  } catch (error) {
    sendFailure(command.jobId, "MALFORMED_PARSER_OUTPUT", error instanceof Error ? error.message : "Parser output was invalid.", stderr);
  }
}

function sendFailure(jobId: string, code: string, message: string, stderr: Buffer): void {
  parentPort.postMessage({ schemaVersion: 1, jobId, event: "material.parse.failed", code, message: message.slice(0, 2_000), stderr: stderr.toString("utf8") } satisfies UtilityJobEvent);
}

function parserEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? process.env.Path ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    TEMP: process.env.TEMP ?? "",
    TMP: process.env.TMP ?? "",
    PYTHONUTF8: "1"
  };
}

process.on("exit", () => { for (const child of children) child.kill(); });
