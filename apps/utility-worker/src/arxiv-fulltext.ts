import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { UtilityJobCommand, UtilityJobEvent } from "@vc-agent/contracts";
import { resolveParserPython } from "./python-runtime.js";

type ArxivFulltextCommand = Extract<UtilityJobCommand, { command: "arxiv.fulltext" }>;
type ArxivFulltextCompleted = Extract<UtilityJobEvent, { event: "arxiv.fulltext.completed" }>;

const ALLOWED_FILES = new Set(["paper.html", "paper.pdf", "paper.md", "metadata.json"]);
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  "paper.html": "text/html",
  "paper.pdf": "application/pdf",
  "paper.md": "text/markdown",
  "metadata.json": "application/json"
};

export async function runArxivFulltext(command: ArxivFulltextCommand): Promise<UtilityJobEvent> {
  const skillRoot = resolve(command.skillRoot);
  const stagingDirectory = resolve(command.stagingDirectory);
  const outputDirectory = resolve(stagingDirectory, "output");
  const scriptPath = resolve(skillRoot, "arxiv-fulltext-reader", "scripts", "arxiv_fulltext.txt");
  if (!isWithin(skillRoot, scriptPath) || !existsSync(scriptPath)) return failure(command, "ARXIV_SCRIPT_UNAVAILABLE", "The bundled ArXiv archive script is unavailable.");
  if (!isWithin(stagingDirectory, outputDirectory)) return failure(command, "ARXIV_STAGING_REJECTED", "The ArXiv archive staging path is invalid.");
  mkdirSync(outputDirectory, { recursive: true });

  const child = spawn(resolveParserPython(), [
    scriptPath,
    command.identifier,
    "--output-dir", outputDirectory,
    "--timeout", String(Math.max(1, Math.floor(command.timeoutMs / 1000) - 5)),
    "--json",
    ...(command.allowAr5iv ? ["--allow-ar5iv"] : []),
    ...(command.force ? ["--force"] : [])
  ], { cwd: skillRoot, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"], env: parserEnvironment() });
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let exceeded = false;
  let timedOut = false;
  const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
    const next = Buffer.concat([current, chunk]);
    if (next.length > command.maxOutputBytes) {
      exceeded = true;
      child.kill();
    }
    return next.subarray(-command.maxOutputBytes);
  };
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, command.timeoutMs);
  const result = await waitForExit(child);
  clearTimeout(timeout);
  if (exceeded) return failure(command, "ARXIV_OUTPUT_LIMIT_EXCEEDED", "The ArXiv archive script exceeded its bounded output limit.", stderr);
  if (timedOut) return failure(command, "ARXIV_FULLTEXT_TIMEOUT", "The ArXiv archive exceeded its declared timeout.", stderr);
  if (result.error !== undefined) return failure(command, "ARXIV_RUNTIME_UNAVAILABLE", result.error.message, stderr);
  if (result.code !== 0) return failure(command, "ARXIV_FULLTEXT_FAILED", "The bundled ArXiv archive failed.", stderr);

  try {
    const metadata = JSON.parse(stdout.toString("utf8")) as Record<string, unknown>;
    return validateArchive(command, outputDirectory, metadata);
  } catch (error) {
    return failure(command, "ARXIV_RESULT_INVALID", error instanceof Error ? error.message : "The ArXiv archive returned invalid metadata.", stderr);
  }
}

function validateArchive(command: ArxivFulltextCommand, outputDirectory: string, metadata: Record<string, unknown>): ArxivFulltextCompleted {
  if (metadata.status !== "completed" || typeof metadata.paperId !== "string" || typeof metadata.directory !== "string" || typeof metadata.source !== "string") {
    throw new Error("The ArXiv archive did not return a completed bundle.");
  }
  if (!(["html", "ar5iv_html", "pdf"] as const).includes(metadata.source as "html" | "ar5iv_html" | "pdf")) throw new Error("The ArXiv archive source is invalid.");
  const paperDirectory = resolve(metadata.directory);
  if (!isWithin(outputDirectory, paperDirectory)) throw new Error("The ArXiv archive wrote outside its staging directory.");
  const metadataFiles = metadata.files;
  if (typeof metadataFiles !== "object" || metadataFiles === null || Array.isArray(metadataFiles)) throw new Error("The ArXiv archive files manifest is invalid.");
  const files: Array<{ path: string; bytes: number; mediaType: string }> = [];
  for (const value of Object.values(metadataFiles as Record<string, unknown>)) {
    if (typeof value !== "string" || !ALLOWED_FILES.has(value)) throw new Error(`The ArXiv archive returned an unexpected file: ${String(value)}`);
    const path = resolve(paperDirectory, value);
    if (!isWithin(paperDirectory, path) || !existsSync(path) || !lstatSync(path).isFile()) throw new Error(`The ArXiv archive file is missing or unsafe: ${value}`);
    files.push({ path: value, bytes: statSync(path).size, mediaType: MEDIA_TYPES[value] ?? "application/octet-stream" });
  }
  const metadataPath = resolve(paperDirectory, "metadata.json");
  if (!existsSync(metadataPath) || !lstatSync(metadataPath).isFile()) throw new Error("The ArXiv archive did not write metadata.json.");
  if (!files.some((file) => file.path === "metadata.json")) files.push({ path: "metadata.json", bytes: statSync(metadataPath).size, mediaType: MEDIA_TYPES["metadata.json"] ?? "application/json" });
  if (files.length > 4 || files.reduce((total, file) => total + file.bytes, 0) > command.maxBytes) throw new Error("The ArXiv archive exceeded its bounded file size.");
  const urls = typeof metadata.urls === "object" && metadata.urls !== null ? metadata.urls as Record<string, unknown> : {};
  const sourceKey = metadata.source === "ar5iv_html" ? "ar5iv" : metadata.source;
  const sourceUrl = urls[sourceKey];
  if (typeof sourceUrl !== "string" || !/^https:\/\//iu.test(sourceUrl)) throw new Error("The ArXiv archive source URL is invalid.");
  const warnings = Array.isArray(metadata.warnings) ? metadata.warnings.filter((value): value is string => typeof value === "string").slice(0, 50) : [];
  return { schemaVersion: 1, jobId: command.jobId, event: "arxiv.fulltext.completed", paperId: metadata.paperId, source: metadata.source as "html" | "ar5iv_html" | "pdf", sourceUrl, paperDirectory, files, warnings };
}

function failure(command: ArxivFulltextCommand, code: string, message: string, stderr: Buffer = Buffer.alloc(0)): UtilityJobEvent {
  return { schemaVersion: 1, jobId: command.jobId, event: "arxiv.fulltext.failed", code, message: message.slice(0, 2_000), stderr: stderr.toString("utf8").slice(-20_000) };
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith(`..${sep}`) && !/^[A-Za-z]:/u.test(relativePath));
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolveResult) => {
    child.once("error", (error) => resolveResult({ code: null, error }));
    child.once("close", (code) => resolveResult({ code }));
  });
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
