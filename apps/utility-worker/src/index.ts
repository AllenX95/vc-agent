import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalParseSchema, utilityJobCommandSchema, type OfficeSkillJobCommand, type UtilityJobCommand, type UtilityJobEvent } from "@vc-agent/contracts";
import { resolveParserPython } from "./python-runtime.js";
import { extractAcademicPdf } from "./academic-pdf-extract.js";
import { runArxivFulltext } from "./arxiv-fulltext.js";

const parentPort = process.parentPort;
if (parentPort === undefined) throw new Error("Utility Worker requires an Electron Utility Process parent port");
const children = new Set<ChildProcessWithoutNullStreams>();
const ocrRuntimes = new Map<"paddle" | "ovis", OcrRuntimeClient>();

parentPort.on("message", (message) => {
  const command = utilityJobCommandSchema.safeParse(message.data);
  if (command.success) void run(command.data);
});

async function run(command: UtilityJobCommand): Promise<void> {
  if (command.command === "material.parse") await runMaterialParse(command);
  else if (command.command === "page_recovery.ocr") await runOcr(command);
  else if (command.command === "office.skill") await runOfficeSkill(command);
  else if (command.command === "arxiv.fulltext") parentPort.postMessage(await runArxivFulltext(command));
  else await runAcademicPdf(command);
}

async function runAcademicPdf(command: Extract<UtilityJobCommand, { command: "academic.pdf.extract" }>): Promise<void> {
  try {
    const result = await extractAcademicPdf(command);
    parentPort.postMessage({ schemaVersion: 1, jobId: command.jobId, event: "academic.pdf.extract.completed", ...result } satisfies UtilityJobEvent);
  } catch (error) {
    parentPort.postMessage({
      schemaVersion: 1,
      jobId: command.jobId,
      event: "academic.pdf.extract.failed",
      code: error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : "ACADEMIC_PDF_EXTRACT_FAILED",
      message: error instanceof Error ? error.message.slice(0, 2_000) : "Academic PDF extraction failed.",
      stderr: ""
    } satisfies UtilityJobEvent);
  }
}

async function runMaterialParse(command: Extract<UtilityJobCommand, { command: "material.parse" }>): Promise<void> {
  const child = spawnPython("parser.py");
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
  const result = await waitForExit(child);
  clearTimeout(timeout);
  if (exceeded) return sendMaterialFailure(command.jobId, "OUTPUT_LIMIT_EXCEEDED", "Parser output exceeded its declared bound.", stderr);
  if (timedOut) return sendMaterialFailure(command.jobId, "PARSER_TIMEOUT", "Parser exceeded its declared timeout.", stderr);
  if (result.error !== undefined) return sendMaterialFailure(command.jobId, "PARSER_RUNTIME_UNAVAILABLE", result.error.message, stderr);
  if (result.code !== 0) return sendMaterialFailure(command.jobId, "PARSER_FAILED", "The parser process failed.", stderr);
  try {
    const parse = canonicalParseSchema.parse(JSON.parse(stdout.toString("utf8")));
    mkdirSync(command.stagingDirectory, { recursive: true });
    const artifactPath = join(command.stagingDirectory, "parse.json");
    const partialPath = `${artifactPath}.partial`;
    writeFileSync(partialPath, `${JSON.stringify(parse, null, 2)}\n`, "utf8");
    renameSync(partialPath, artifactPath);
    parentPort.postMessage({ schemaVersion: 1, jobId: command.jobId, event: "material.parse.completed", artifactPath, parse } satisfies UtilityJobEvent);
  } catch (error) {
    sendMaterialFailure(command.jobId, "MALFORMED_PARSER_OUTPUT", error instanceof Error ? error.message : "Parser output was invalid.", stderr);
  }
}

async function runOcr(command: Extract<UtilityJobCommand, { command: "page_recovery.ocr" }>): Promise<void> {
  try {
    let runtime = ocrRuntimes.get(command.stage);
    if (runtime === undefined) {
      runtime = new OcrRuntimeClient(command.stage, command.runtimeRoot);
      ocrRuntimes.set(command.stage, runtime);
    }
    const result = await runtime.run(command, command.timeoutMs, command.maxOutputBytes);
    parentPort.postMessage({ schemaVersion: 1, jobId: command.jobId, event: "page_recovery.ocr.completed", stage: command.stage, ...result } satisfies UtilityJobEvent);
  } catch (error) {
    parentPort.postMessage({ schemaVersion: 1, jobId: command.jobId, event: "page_recovery.ocr.failed", stage: command.stage, code: error instanceof OcrRuntimeError ? error.code : "OCR_RUNTIME_FAILED", message: error instanceof Error ? error.message.slice(0, 2_000) : "OCR runtime failed.", stderr: error instanceof OcrRuntimeError ? error.stderr : "" } satisfies UtilityJobEvent);
    if (error instanceof OcrRuntimeError && error.fatal) { ocrRuntimes.get(command.stage)?.close(); ocrRuntimes.delete(command.stage); }
  }
}

/**
 * Executes one explicitly configured, user-supplied Office runner. The
 * Utility Worker owns this process boundary so the Electron Main process never
 * imports or executes third-party Skill code directly. The runner receives a
 * JSON manifest on stdin and must write only the declared staged output(s).
 */
async function runOfficeSkill(command: OfficeSkillJobCommand): Promise<void> {
  const outputPath = resolve(command.outputPath);
  const stagingDirectory = resolve(command.stagingDirectory);
  const skillRoot = resolve(command.skillRoot);
  if (!isWithin(stagingDirectory, outputPath) || extname(outputPath).toLowerCase() !== `.${command.format}` || command.inputPaths.some((path) => resolve(path) === outputPath)) {
    return sendOfficeFailure(command, "OFFICE_JOB_REJECTED", "Office output path is not an isolated staged target.");
  }
  if (command.previewPath !== undefined && !isWithin(stagingDirectory, command.previewPath)) {
    return sendOfficeFailure(command, "OFFICE_JOB_REJECTED", "Office preview path is outside the staging directory.");
  }
  if (!isWithin(stagingDirectory, command.logPath)) {
    return sendOfficeFailure(command, "OFFICE_JOB_REJECTED", "Office log path is outside the staging directory.");
  }
  if (!existsSync(skillRoot)) return sendOfficeFailure(command, "OFFICE_SKILL_UNAVAILABLE", "The active Office Skill revision is unavailable.");

  const child = spawn(command.runner.executable, [...command.runner.args], {
    cwd: skillRoot,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: officeEnvironment()
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  let stdoutBytes = 0;
  let stdoutExceeded = false;
  let stderr = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > command.maxOutputBytes) {
      stdoutExceeded = true;
      terminateOfficeChild(child);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-20_000); });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; terminateOfficeChild(child); }, command.timeoutMs);
  child.stdin.end(JSON.stringify({
    schemaVersion: 1,
    jobId: command.jobId,
    kind: command.kind,
    format: command.format,
    skillRevisionId: command.skillRevisionId,
    skillRoot,
    inputPaths: command.inputPaths.map((path) => resolve(path)),
    stagingDirectory,
    outputPath,
    ...(command.previewPath === undefined ? {} : { previewPath: resolve(command.previewPath) }),
    logPath: resolve(command.logPath),
    cancellationToken: command.cancellationToken,
    timeoutMs: command.timeoutMs,
    maxOutputBytes: command.maxOutputBytes
  }) + "\n");
  const result = await waitForExit(child);
  clearTimeout(timeout);
  const sanitizedStderr = sanitizeOfficeLog(stderr.toString("utf8"), command);
  if (stdoutExceeded) return sendOfficeFailure(command, "OFFICE_OUTPUT_LIMIT_EXCEEDED", "Office runner logs exceeded the declared output bound.", sanitizedStderr);
  if (timedOut) return sendOfficeFailure(command, "OFFICE_JOB_TIMEOUT", "Office runner exceeded its declared timeout.", sanitizedStderr);
  if (result.error !== undefined) return sendOfficeFailure(command, "OFFICE_DEPENDENCY_MISSING", result.error.message, sanitizedStderr);
  if (result.code !== 0) return sendOfficeFailure(command, "OFFICE_RUNNER_FAILED", "The configured Office runner failed.", sanitizedStderr);
  if (!existsSync(outputPath)) return sendOfficeFailure(command, "OFFICE_RESULT_MISSING", "The Office runner did not create the declared output.", sanitizedStderr);
  if (!isOfficeArtifact(outputPath, command.format, command.maxOutputBytes)) return sendOfficeFailure(command, "OFFICE_RESULT_INVALID", "The staged file is not a valid Office artifact for the requested format.", sanitizedStderr);
  const outputBytes = statSync(outputPath).size;
  if (outputBytes > command.maxOutputBytes) return sendOfficeFailure(command, "OFFICE_OUTPUT_LIMIT_EXCEEDED", "Office output exceeded the declared byte bound.", sanitizedStderr);
  if (command.previewPath !== undefined && !existsSync(resolve(command.previewPath))) return sendOfficeFailure(command, "OFFICE_RENDER_FAILED", "The Office runner did not create the declared preview.", sanitizedStderr);
  persistOfficeLog(command, sanitizedStderr);
  parentPort.postMessage({ schemaVersion: 1, jobId: command.jobId, event: "office.skill.completed", outputPath, outputBytes, ...(command.previewPath === undefined ? {} : { previewPath: resolve(command.previewPath) }), warnings: sanitizedStderr === "" ? [] : ["OFFICE_RUNNER_LOG_CAPTURED"] } satisfies UtilityJobEvent);
}

class OcrRuntimeClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, { resolve: (value: OcrResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; maxOutputBytes: number }>();
  #stderr = Buffer.alloc(0);

  constructor(stage: "paddle" | "ovis", runtimeRoot: string) {
    const executable = join(runtimeRoot, `${stage}-venv`, "Scripts", "python.exe");
    this.#child = spawnPython("ocr_runtime.py", executable);
    this.#child.stderr.on("data", (chunk: Buffer) => { this.#stderr = Buffer.concat([this.#stderr, chunk]).subarray(-20_000); });
    createInterface({ input: this.#child.stdout }).on("line", (line) => this.#receive(line));
    this.#child.once("exit", () => this.#rejectAll(new OcrRuntimeError("OCR_RUNTIME_EXITED", "OCR runtime exited before completing the request.", this.#stderr.toString("utf8"), true)));
    this.#child.once("error", (error) => this.#rejectAll(new OcrRuntimeError("OCR_RUNTIME_UNAVAILABLE", error.message, this.#stderr.toString("utf8"), true)));
  }

  run(command: Extract<UtilityJobCommand, { command: "page_recovery.ocr" }>, timeoutMs: number, maxOutputBytes: number): Promise<OcrResult> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new OcrRuntimeError("PAGE_RECOVERY_TIMEOUT", `${command.stage} exceeded its declared timeout.`, this.#stderr.toString("utf8"), true));
        this.close();
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer, maxOutputBytes });
      this.#child.stdin.write(`${JSON.stringify({ requestId, stage: command.stage, absolutePath: command.absolutePath, pageNumber: command.pageNumber, device: command.device, runtimeRoot: command.runtimeRoot })}\n`);
    });
  }

  close(): void { this.#child.kill(); }

  #receive(line: string): void {
    let response: OcrResponse;
    try { response = JSON.parse(line) as OcrResponse; }
    catch { return; }
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined) return;
    this.#pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (Buffer.byteLength(line, "utf8") > pending.maxOutputBytes) return pending.reject(new OcrRuntimeError("OUTPUT_LIMIT_EXCEEDED", "OCR output exceeded its declared bound.", this.#stderr.toString("utf8"), false));
    if (!response.ok || response.result === undefined) return pending.reject(new OcrRuntimeError("OCR_FAILED", response.error?.message ?? "OCR runtime failed.", this.#stderr.toString("utf8"), false));
    pending.resolve(response.result);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }
}

interface OcrResult { readonly text: string; readonly confidence: number; readonly structurallyInsufficient: boolean; readonly adapterId: string; readonly adapterVersion: string; readonly runtimeRevision: string; readonly device: "cpu" | "cuda"; readonly warnings: string[] }
interface OcrResponse { readonly requestId: string; readonly ok: boolean; readonly result?: OcrResult; readonly error?: { readonly type?: string; readonly message?: string } }

class OcrRuntimeError extends Error {
  constructor(readonly code: string, message: string, readonly stderr: string, readonly fatal: boolean) { super(message); }
}

function isOfficeArtifact(path: string, format: OfficeSkillJobCommand["format"], maxOutputBytes: number): boolean {
  try {
    const size = statSync(path).size;
    if (size <= 0 || size > maxOutputBytes) return false;
    const bytes = readFileSync(path);
    if (format === "pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
    return bytes.includes(Buffer.from("[Content_Types].xml", "utf8"));
  } catch { return false; }
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith(".." + sep) && !/^[A-Za-z]:/u.test(relativePath));
}

function sanitizeOfficeLog(value: string, command: OfficeSkillJobCommand): string {
  let sanitized = value.replaceAll(command.skillRoot, "<skill-root>");
  for (const inputPath of command.inputPaths) sanitized = sanitized.replaceAll(inputPath, "<input>");
  sanitized = sanitized.replace(/(api[_-]?key|bearer|password|secret|token)\s*[:=]\s*[^\s,;]+/giu, "$1=<redacted>");
  return sanitized.slice(-20_000);
}

function sendOfficeFailure(command: OfficeSkillJobCommand, code: string, message: string, stderr = ""): void {
  persistOfficeLog(command, stderr);
  parentPort.postMessage({ schemaVersion: 1, jobId: command.jobId, event: "office.skill.failed", code, message: message.slice(0, 2_000), stderr: stderr.slice(-20_000) } satisfies UtilityJobEvent);
}

function persistOfficeLog(command: OfficeSkillJobCommand, value: string): void {
  try {
    if (isWithin(command.stagingDirectory, command.logPath)) writeFileSync(resolve(command.logPath), value.slice(-Math.min(20_000, command.maxOutputBytes)), "utf8");
  } catch { /* Diagnostics are best-effort and never change the job outcome. */ }
}

function terminateOfficeChild(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) { child.kill(); return; }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => { try { child.kill(); } catch { /* process may already be gone */ } });
  } else {
    try { child.kill("SIGTERM"); } catch { /* process may already be gone */ }
  }
}

function spawnPython(scriptName: string, executable?: string): ChildProcessWithoutNullStreams {
  const python = resolveParserPython(executable === undefined ? {} : { executable });
  const script = join(dirname(fileURLToPath(import.meta.url)), scriptName);
  const child = spawn(python, [script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: parserEnvironment() });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({ code }));
  });
}

function sendMaterialFailure(jobId: string, code: string, message: string, stderr: Buffer): void {
  parentPort.postMessage({ schemaVersion: 1, jobId, event: "material.parse.failed", code, message: message.slice(0, 2_000), stderr: stderr.toString("utf8") } satisfies UtilityJobEvent);
}

function parserEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? process.env.Path ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    TEMP: process.env.TEMP ?? "",
    TMP: process.env.TMP ?? "",
    PYTHONUTF8: "1",
    ...(process.env.VC_AGENT_OCR_RUNTIME_ROOT === undefined ? {} : { VC_AGENT_OCR_RUNTIME_ROOT: process.env.VC_AGENT_OCR_RUNTIME_ROOT }),
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
    ...(process.env.VC_AGENT_OCR_MODELS_ROOT === undefined ? {} : { VC_AGENT_OCR_MODELS_ROOT: process.env.VC_AGENT_OCR_MODELS_ROOT })
  };
}

function officeEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? process.env.Path ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    TEMP: process.env.TEMP ?? "",
    TMP: process.env.TMP ?? "",
    PYTHONUTF8: "1",
    ...(process.env.VC_AGENT_PYTHON === undefined ? {} : { VC_AGENT_PYTHON: process.env.VC_AGENT_PYTHON })
  };
}

process.on("exit", () => { for (const runtime of ocrRuntimes.values()) runtime.close(); for (const child of children) terminateOfficeChild(child); });
