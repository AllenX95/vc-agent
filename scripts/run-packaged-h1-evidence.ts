import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

interface PackagedEvidence {
  readonly schemaVersion: 1;
  readonly sanitized: true;
  readonly kind: "h1-packaged-compatibility";
  readonly buildIdentity: { readonly applicationVersion: string; readonly stateSchemaVersion: number };
  readonly runner: { readonly mode: "playwright-electron"; readonly status: "ready" };
  readonly workflows: readonly ["process-tree", "external-edit", "backup-restore", "single-instance"];
  readonly results: readonly { readonly workflow: PackagedEvidence["workflows"][number]; readonly status: "passed" }[];
  readonly testCount: number;
}

const workflowPatterns: Readonly<Record<PackagedEvidence["workflows"][number], string>> = {
  "process-tree": "cancels a running Office runner",
  "external-edit": "inventories Project Materials and requires explicit stale parse refresh choices",
  "backup-restore": "backs up and mechanically restores Personal Cognition",
  "single-instance": "keeps one desktop writer and exits the second instance"
};

async function main(): Promise<void> {
  const evidencePath = resolveRequired(parseFlags(process.argv.slice(2)).evidence ?? process.env.VC_AGENT_H1_PACKAGED_EVIDENCE, "VC_AGENT_H1_PACKAGED_EVIDENCE");
  assertExternalPath(evidencePath);
  const pattern = Object.values(workflowPatterns).join("|");
  const env = { ...process.env, NODE_ENV: "test" };
  delete env.VC_AGENT_REAL_OCR;
  delete env.VC_AGENT_REAL_OCR_EVIDENCE;
  delete env.VC_AGENT_OCR_RUNTIME_ROOT;
  // This runner assumes the packaged Desktop artifacts were built by the
  // caller (`pnpm build`). It executes only the four named Electron suites and
  // captures Playwright's JSON summary in memory; no trace or test body is
  // copied into the evidence file.
  const result = await runPlaywright(["tests/e2e/lifecycle.spec.ts", "tests/e2e/empty-shell.spec.ts", "--grep", pattern, "--reporter=json"], env);
  if (result.code !== 0) throw new Error(`H1_PACKAGED_E2E_FAILED:${sanitizeDiagnostic(`${result.stdout}\n${result.stderr}`)}`);
  const summary = parsePlaywrightSummary(result.stdout);
  if (summary.testCount < 4 || summary.failed > 0) throw new Error("H1_PACKAGED_E2E_INCOMPLETE");
  const evidence: PackagedEvidence = {
    schemaVersion: 1,
    sanitized: true,
    kind: "h1-packaged-compatibility",
    buildIdentity: { applicationVersion: "0.1.0", stateSchemaVersion: 14 },
    runner: { mode: "playwright-electron", status: "ready" },
    workflows: ["process-tree", "external-edit", "backup-restore", "single-instance"],
    results: ["process-tree", "external-edit", "backup-restore", "single-instance"].map((workflow) => ({ workflow, status: "passed" as const })),
    testCount: summary.testCount
  };
  mkdirSync(resolve(evidencePath, ".."), { recursive: true });
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ status: "pass", evidencePath: "external/h1/packaged-lifecycle.json", testCount: summary.testCount, workflows: evidence.workflows }, null, 2));
}

function runPlaywright(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const invocation = pnpmInvocation();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, [...invocation.args, "exec", "playwright", "test", ...args], { cwd: process.cwd(), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-1_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-50_000); });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function pnpmInvocation(): { readonly command: string; readonly args: readonly string[] } {
  const candidates = [
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, "npm", "node_modules", "pnpm", "bin", "pnpm.cjs"),
    join(process.cwd(), "node_modules", "pnpm", "bin", "pnpm.cjs")
  ].filter((path): path is string => path !== undefined && existsSync(path));
  const script = candidates[0];
  if (script !== undefined) return { command: process.execPath, args: [script] };
  if (process.platform === "win32") return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "pnpm"] };
  return { command: "pnpm", args: [] };
}

function parsePlaywrightSummary(stdout: string): { readonly testCount: number; readonly failed: number } {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error("H1_PACKAGED_E2E_REPORT_INVALID"); }
  let testCount = 0;
  let failed = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.tests)) {
      for (const test of record.tests) {
        if (typeof test !== "object" || test === null) continue;
        testCount += 1;
        if ((test as { status?: unknown }).status !== "expected") failed += 1;
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(parsed);
  return { testCount, failed };
}

function parseFlags(values: readonly string[]): { readonly evidence?: string } {
  for (let index = 0; index < values.length; index += 1) if (values[index] === "--evidence" && values[index + 1] !== undefined) return { evidence: values[index + 1] };
  return {};
}

function resolveRequired(value: string | undefined, name: string): string { if (value === undefined || value.trim() === "") throw new Error(`BLOCKED: ${name} is required.`); return resolve(value); }
function assertExternalPath(path: string): void {
  const root = resolve(process.cwd());
  const candidate = resolve(path);
  const relativePath = relative(root, candidate);
  if (relativePath === "" || (!relativePath.startsWith(".." + sep) && relativePath !== ".." && !/^[A-Za-z]:/u.test(relativePath))) throw new Error("H1_EVIDENCE_MUST_BE_EXTERNAL");
}

function sanitizeDiagnostic(value: string): string { return value.replace(/[A-Za-z]:\\[^\s,;]+|(?:\\\\|\/)(?:Users|home|tmp|var|private)[^\s,;]*/giu, "<local-path>").replace(/(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*[^\s,;]+/giu, "<redacted>").slice(-1_200); }

void main().catch((error) => { console.error(error instanceof Error ? error.message : "packaged H1 evidence failed"); process.exitCode = 1; });
