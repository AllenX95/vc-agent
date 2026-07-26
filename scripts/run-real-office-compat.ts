import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  ANTHROPIC_SKILLS_SOURCE,
  OfficeSkillOrchestrator,
  SkillPackageManager,
  provisionAnthropicSkills,
  type OfficeExecutionPlan,
  type OfficeFormat,
  type OfficeSkillJobAdapter
} from "../packages/host-services/src/index.ts";

/**
 * Runs one complete user-supplied Anthropic Office Skill through the same
 * stdin-manifest contract used by the Desktop Utility Worker. The runner is
 * intentionally external: this script never invents a document engine and
 * never copies a third-party package into the repository.
 *
 * Required inputs are normally supplied through VC_AGENT_REAL_OFFICE_* env
 * vars. Example:
 *   pnpm office:compat -- --source-root C:\\skills --evidence C:\\evidence\\office.json --runner C:\\runner\\run.cmd
 */

interface RunnerSpec { readonly executable: string; readonly args: readonly string[] }
interface OfficeProviderReceipt {
  readonly schemaVersion: 1;
  readonly kind: "microsoft-office";
  readonly application: "word";
  readonly version: string;
}
interface OfficeEvidence {
  readonly schemaVersion: 1;
  readonly sanitized: true;
  readonly kind: "office-compatibility";
  readonly sourceRevision: string;
  readonly packageIds: readonly string[];
  readonly formats: readonly string[];
  readonly runner: { readonly mode: "external-stdin-manifest"; readonly status: "ready" };
  readonly provider: OfficeProviderReceipt;
  readonly workflows: readonly ["create", "edit", "replace"];
  readonly results: readonly { readonly workflow: "create" | "edit" | "replace"; readonly status: "validated" | "replaced"; readonly outputBytes?: number }[];
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const sourceRoot = resolveRequired(flags["source-root"] ?? process.env.VC_AGENT_REAL_OFFICE_SOURCE, "VC_AGENT_REAL_OFFICE_SOURCE");
  const evidencePath = resolveRequired(flags.evidence ?? process.env.VC_AGENT_REAL_OFFICE_EVIDENCE, "VC_AGENT_REAL_OFFICE_EVIDENCE");
  const format = (flags.format ?? "docx") as OfficeFormat;
  if (!(["docx", "pptx", "xlsx"] as readonly string[]).includes(format)) throw new Error("BLOCKED: only docx, pptx, and xlsx have an imported Anthropic Skill package.");
  assertExternalPath(sourceRoot);
  assertExternalPath(evidencePath);
  if (!existsSync(sourceRoot)) throw new Error("OFFICE_SOURCE_MISSING");
  const runner = readRunnerSpec(flags);
  if (runner === undefined) throw new Error("BLOCKED: VC_AGENT_REAL_OFFICE_RUNNER (and optional VC_AGENT_REAL_OFFICE_RUNNER_ARGS JSON) is required.");

  const workRoot = mkdtempSync(join(tmpdir(), "vc-agent-real-office-"));
  const activeChildren = new Map<string, ChildProcessWithoutNullStreams>();
  try {
    const skills = new SkillPackageManager({ root: join(workRoot, "skills") });
    const imported = await provisionAnthropicSkills({ sourceRoot, manager: skills, packageIds: [format] });
    const selected = imported[0];
    if (selected === undefined) throw new Error("OFFICE_SKILL_UNAVAILABLE");
    const projectPath = join(workRoot, "project");
    const outputDirectory = join(projectPath, "outputs");
    mkdirSync(projectPath, { recursive: true });
    let provider: OfficeProviderReceipt | undefined;
    const adapter: OfficeSkillJobAdapter = {
      run: (input) => runExternalOffice(input.plan, runner, activeChildren, input.signal, (receipt) => {
        if (provider !== undefined && JSON.stringify(provider) !== JSON.stringify(receipt)) throw new Error("OFFICE_PROVIDER_EVIDENCE_MISMATCH");
        provider = receipt;
      }),
      terminate: (jobId) => terminateChild(activeChildren.get(jobId))
    };
    const orchestrator = new OfficeSkillOrchestrator({ skills, adapter, root: join(workRoot, "office") });
    const base = {
      projectId: "real-office-compat",
      projectPath,
      threadId: "real-office-thread",
      profile: { id: "real-office-runner", provider: "external-runner", model: "user-supplied" },
      skillRevisionId: selected.overlay.revisionId,
      outputDirectory,
      explicitIntent: true as const
    };
    const createPlan = await orchestrator.prepare({ ...base, kind: "create", format, turnId: "create" });
    const created = await orchestrator.execute(createPlan.planId);
    if (created.status !== "validated" || created.stagedOutputPath === undefined) throw new Error("OFFICE_CREATE_NOT_VALIDATED");
    const createdOutput = await orchestrator.commit(created.resultId);
    const editPlan = await orchestrator.prepare({ ...base, kind: "edit", format, turnId: "edit", outputFileName: "edited-copy", sourcePath: createdOutput.destination, sourceReferences: ["real-office:create"] });
    const edited = await orchestrator.execute(editPlan.planId);
    if (edited.status !== "validated" || edited.stagedOutputPath === undefined || edited.sourceHash === undefined) throw new Error("OFFICE_EDIT_NOT_VALIDATED");
    await orchestrator.commit(edited.resultId);
    const replaced = await orchestrator.replaceOriginal({ resultId: edited.resultId, sourcePath: createdOutput.destination, expectedSourceHash: edited.sourceHash, accessMode: "full", confirmed: true });
    if (replaced.status !== "replaced") throw new Error("OFFICE_REPLACE_NOT_COMPLETED");
    if (provider === undefined) throw new Error("OFFICE_PROVIDER_EVIDENCE_MISSING");
    const evidence: OfficeEvidence = {
      schemaVersion: 1,
      sanitized: true,
      kind: "office-compatibility",
      sourceRevision: ANTHROPIC_SKILLS_SOURCE.revision,
      packageIds: [selected.packageId],
      formats: [format],
      runner: { mode: "external-stdin-manifest", status: "ready" },
      provider,
      workflows: ["create", "edit", "replace"],
      results: [
        { workflow: "create", status: "validated", outputBytes: created.outputBytes ?? statSync(created.stagedOutputPath).size },
        { workflow: "edit", status: "validated", ...(edited.editedCopyHash === undefined ? {} : { outputBytes: statSync(edited.stagedOutputPath).size }) },
        { workflow: "replace", status: "replaced" }
      ]
    };
    mkdirSync(resolve(evidencePath, ".."), { recursive: true });
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({ status: "pass", evidencePath: `external/office/compatibility.json`, packageId: selected.packageId, sourceRevision: ANTHROPIC_SKILLS_SOURCE.revision }, null, 2));
  } finally {
    for (const child of activeChildren.values()) terminateChild(child);
    rmSync(workRoot, { recursive: true, force: true });
  }
}

async function runExternalOffice(plan: OfficeExecutionPlan, runner: RunnerSpec, activeChildren: Map<string, ChildProcessWithoutNullStreams>, signal: AbortSignal, recordProvider: (receipt: OfficeProviderReceipt) => void): Promise<{ readonly outputPath: string; readonly outputBytes: number }> {
  const child = spawn(runner.executable, [...runner.args], { cwd: plan.skillRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: runnerEnvironment() });
  activeChildren.set(plan.job.jobId, child);
  let stderr = Buffer.alloc(0);
  child.stderr.on("data", (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-20_000); });
  child.stdout.resume();
  const abort = () => terminateChild(child);
  signal.addEventListener("abort", abort, { once: true });
  const providerEvidencePath = join(plan.job.stagingDirectory, "provider-evidence.json");
  child.stdin.end(JSON.stringify({
    schemaVersion: 1,
    jobId: plan.job.jobId,
    kind: plan.task.kind,
    format: plan.task.format,
    skillRevisionId: plan.task.skillRevisionId,
    skillRoot: plan.skillRoot,
    inputPaths: plan.job.inputPaths,
    stagingDirectory: plan.job.stagingDirectory,
    outputPath: plan.stagedOutputPath,
    providerEvidencePath,
    ...(plan.task.renderPreview === true ? { previewPath: plan.stagedOutputPath + ".preview" } : {}),
    logPath: join(plan.job.stagingDirectory, "runner.log"),
    cancellationToken: plan.job.cancellationToken ?? plan.planId,
    timeoutMs: plan.job.timeoutMs,
    maxOutputBytes: plan.job.maxOutputBytes
  }) + "\n");
  const result = await waitForExit(child, plan.job.timeoutMs);
  signal.removeEventListener("abort", abort);
  activeChildren.delete(plan.job.jobId);
  if (signal.aborted) throw new Error("OFFICE_JOB_CANCELLED");
  if (result.timedOut) throw new Error("OFFICE_JOB_TIMEOUT");
  if (result.error !== undefined) throw new Error("OFFICE_DEPENDENCY_MISSING");
  if (result.code !== 0) throw new Error(`OFFICE_RUNNER_FAILED${stderr.length === 0 ? "" : ":" + sanitizeLog(stderr.toString("utf8"))}`);
  recordProvider(readOfficeProviderReceipt(providerEvidencePath));
  if (!isValidArtifact(plan.stagedOutputPath, plan.task.format, plan.job.maxOutputBytes)) throw new Error("OFFICE_RESULT_INVALID");
  return { outputPath: plan.stagedOutputPath, outputBytes: statSync(plan.stagedOutputPath).size };
}

function readOfficeProviderReceipt(path: string): OfficeProviderReceipt {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
      || (parsed as Record<string, unknown>).schemaVersion !== 1
      || (parsed as Record<string, unknown>).kind !== "microsoft-office"
      || (parsed as Record<string, unknown>).application !== "word"
      || typeof (parsed as Record<string, unknown>).version !== "string"
      || !/^\d+(?:\.\d+){0,3}$/u.test((parsed as Record<string, unknown>).version as string)
    ) throw new Error();
    return parsed as OfficeProviderReceipt;
  } catch {
    throw new Error("OFFICE_PROVIDER_EVIDENCE_INVALID");
  }
}

function readRunnerSpec(flags: Record<string, string>): RunnerSpec | undefined {
  const executable = (flags.runner ?? process.env.VC_AGENT_REAL_OFFICE_RUNNER)?.trim();
  if (executable === undefined || executable === "") return undefined;
  const encoded = flags["runner-args"] ?? process.env.VC_AGENT_REAL_OFFICE_RUNNER_ARGS;
  if (encoded === undefined || encoded.trim() === "") return { executable, args: [] };
  try {
    const parsed = JSON.parse(encoded) as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) return undefined;
    return { executable, args: parsed };
  } catch { return undefined; }
}

function isValidArtifact(path: string, format: OfficeFormat, maxBytes: number): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return false;
    const bytes = readFileSync(path);
    if (format === "pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
    return extname(path).toLowerCase() === `.${format}` && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes.includes(Buffer.from("[Content_Types].xml", "utf8"));
  } catch { return false; }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<{ readonly code: number | null; readonly error?: Error; readonly timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const timer = setTimeout(() => { if (settled) return; settled = true; terminateChild(child); resolvePromise({ code: null, timedOut: true }); }, timeoutMs);
    child.once("error", (error) => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise({ code: null, error, timedOut: false }); });
    child.once("close", (code) => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise({ code, timedOut: false }); });
  });
}

function terminateChild(child: ChildProcessWithoutNullStreams | undefined): void {
  if (child === undefined) return;
  if (child.pid === undefined) { child.kill(); return; }
  if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else child.kill("SIGTERM");
}

function runnerEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? process.env.Path ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "", PYTHONUTF8: "1", ...(process.env.VC_AGENT_PYTHON === undefined ? {} : { VC_AGENT_PYTHON: process.env.VC_AGENT_PYTHON }) };
}

function sanitizeLog(value: string): string { return value.replace(/(api[_-]?key|bearer|password|secret|token)\s*[:=]\s*[^\s,;]+/giu, "$1=<redacted>").slice(-2_000); }
function resolveRequired(value: string | undefined, name: string): string { if (value === undefined || value.trim() === "") throw new Error(`BLOCKED: ${name} is required.`); return resolve(value); }
function assertExternalPath(path: string): void { const root = resolve(process.cwd()); const relativePath = relative(root, resolve(path)); if (relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith(".." + sep) && !/^[A-Za-z]:/u.test(relativePath))) throw new Error("OFFICE_EVIDENCE_MUST_BE_EXTERNAL"); }
function parseFlags(values: readonly string[]): Record<string, string> { const result: Record<string, string> = {}; for (let index = 0; index < values.length; index += 1) { const value = values[index]; if (value === undefined || !value.startsWith("--")) continue; const key = value.slice(2); const next = values[index + 1]; if (next !== undefined && !next.startsWith("--")) { result[key] = next; index += 1; } } return result; }

void main().catch((error) => { console.error(error instanceof Error ? error.message : "real Office compatibility failed"); process.exitCode = 1; });
