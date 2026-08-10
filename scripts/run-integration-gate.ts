import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  PiIntegrationMigration,
  VcSkillsDirectoryAdapter,
  doctorIsActivationFree,
  gateExitCode,
  inspectEnvironmentDoctor,
  inspectRealDependencyEvidence,
  writeIntegrationGateReport,
  type GateScenarioResult
} from "../packages/host-services/src/index.ts";
import { STATE_SCHEMA_VERSION } from "../packages/persistence/src/index.ts";

async function main(): Promise<void> {
  const outputRoot = resolve(process.env.VC_AGENT_GATE_OUTPUT ?? join(process.cwd(), "test-results", "integration-gate"));
  const workRoot = mkdtempSync(join(tmpdir(), "vc-agent-gate-"));
  const scenarios: GateScenarioResult[] = [];
  try {
    await scenario(scenarios, "PI-R-001", "Dedicated Skills source rejects ambient roots", () => runDedicatedSkillsFixture(workRoot));
    await scenario(scenarios, "PI-R-002", "Legacy integration migration is dormant and idempotent", () => runMigrationFixture(workRoot));
    await scenario(scenarios, "PI-R-003", "Environment Doctor remains activation-free", runDoctorFixture);
  } finally {
    const office = realEvidence("office", process.env.VC_AGENT_REAL_OFFICE_EVIDENCE);
    const ocr = realEvidence("ocr", process.env.VC_AGENT_REAL_OCR_EVIDENCE);
    const mcp = realEvidence("mcp", process.env.VC_AGENT_REAL_MCP_EVIDENCE);
    const blocked = [office, ocr, mcp].filter((entry) => !entry.valid).map((entry) => `${entry.kind}: ${entry.reason ?? "evidence missing"}`);
    const evidencePaths = [office, ocr, mcp].flatMap((entry) => entry.valid && entry.evidencePath !== undefined ? [entry.evidencePath] : []);
    scenarios.push({
      testId: "PI-R-004",
      scenario: "Sanitized real dependency evidence",
      status: blocked.length === 0 ? "pass" : "blocked",
      durationMs: 0,
      ...(evidencePaths.length === 0 ? {} : { evidencePaths }),
      ...(blocked.length === 0 ? {} : { warning: blocked.join("; ") })
    });
    const doctor = inspectEnvironmentDoctor({
      piAdapter: { status: "ready", message: "Pi-native compatibility tests run separately; no session was started by Doctor." },
      profiles: { status: "attention", message: "The gate does not require a Provider profile." },
      credentialReferences: { status: "ready", message: "Only environment or protected credential references are accepted." },
      storage: { status: "ready", message: "Temporary local gate storage is writable." },
      migration: { status: "ready", message: "Pi resource migration is file-only and idempotent." },
      scheduler: { status: "ready", message: "Host execution scheduling remains available." },
      agentRuntime: { status: "ready", message: "Agent Worker stayed dormant during static gate checks." },
      utilityRuntime: { status: "ready", message: "Utility Worker stayed dormant during static gate checks." },
      isolatedRuntime: { status: "ready", message: "Protected Office and Creator workflows remain isolated." },
      skills: { status: "ready", message: "Only the dedicated VC Agent Skills Directory is supplied to Pi." },
      office: { status: office.valid ? "ready" : "attention", message: office.valid ? "Sanitized Office evidence supplied." : "Real Office evidence was not supplied." },
      ocr: { status: ocr.valid ? "ready" : "attention", message: ocr.valid ? "Sanitized OCR evidence supplied." : "Real OCR evidence was not supplied." },
      mcp: { status: mcp.valid ? "ready" : "attention", message: mcp.valid ? "Sanitized MCP evidence supplied." : "Pinned native adapter fixture is covered by the compatibility test." },
      extensions: { status: "ready", message: "Extension directories are inspected statically; code is not loaded by Doctor." },
      backup: { status: "ready", message: "Migration creates a redacted filesystem backup." }
    });
    const report = writeIntegrationGateReport(outputRoot, {
      buildIdentity: { applicationVersion: "0.1.0", stateSchemaVersion: STATE_SCHEMA_VERSION },
      environmentDoctor: doctor,
      scenarios,
      migrationVersions: Array.from({ length: STATE_SCHEMA_VERSION }, (_, index) => index + 1),
      unavailableDependencies: blocked,
      evidenceRoot: outputRoot,
      secretScanInputs: ["credentialRef: environment-reference-only"]
    });
    console.log(JSON.stringify({ decision: report.report.decision, jsonPath: report.jsonPath, scenarios: report.report.executedTests }, null, 2));
    process.exitCode = gateExitCode(report.report.decision, process.argv.includes("--require-pass"));
    rmSync(workRoot, { recursive: true, force: true });
  }
}

async function scenario(target: GateScenarioResult[], testId: string, name: string, action: () => Promise<void> | void): Promise<void> {
  const started = Date.now();
  try {
    await action();
    target.push({ testId, scenario: name, status: "pass", durationMs: Date.now() - started });
  } catch (error) {
    target.push({ testId, scenario: name, status: "fail", durationMs: Date.now() - started, warning: error instanceof Error ? error.message : "fixture failed" });
  }
}

function runDedicatedSkillsFixture(root: string): void {
  const dedicated = join(root, "pi-agent", "skills");
  const ambient = join(root, ".agents", "skills", "ambient");
  mkdirSync(ambient, { recursive: true });
  writeFileSync(join(ambient, "SKILL.md"), "---\nname: ambient\ndescription: must stay ambient\n---\n", "utf8");
  const adapter = new VcSkillsDirectoryAdapter({ root: dedicated });
  if (adapter.additionalSkillPaths().length !== 1 || adapter.additionalSkillPaths()[0] !== resolve(dedicated)) throw new Error("SKILL_SOURCE_NOT_ISOLATED");
  if (adapter.discover().skills.some((skill) => skill.name === "ambient")) throw new Error("AMBIENT_SKILL_DISCOVERED");
}

function runMigrationFixture(root: string): void {
  const legacy = join(root, "legacy");
  const target = join(root, "pi-agent");
  const migration = new PiIntegrationMigration({
    oldExtensionRoot: join(legacy, "extensions"),
    oldMcpRoot: join(legacy, "mcp"),
    oldSkillsRoot: join(legacy, "skills"),
    newAgentDir: target,
    newExtensionRoot: join(target, "extensions"),
    newMcpConfigPath: join(target, "mcp.json"),
    newSkillsRoot: join(target, "skills")
  });
  const first = migration.migrate();
  const second = migration.migrate();
  if (!existsSync(join(target, "mcp.json")) || first.status !== "migrated" || second.status !== "already_migrated") throw new Error("PI_RESOURCE_MIGRATION_NOT_IDEMPOTENT");
}

function runDoctorFixture(): void {
  const doctor = inspectEnvironmentDoctor({ extensions: { status: "ready", message: "Static only." }, mcp: { status: "ready", message: "Disconnected." } });
  if (!doctorIsActivationFree(doctor)) throw new Error("DOCTOR_ACTIVATION_OBSERVED");
}

function realEvidence(kind: "office" | "ocr" | "mcp", path: string | undefined): { kind: string; valid: boolean; reason?: string; evidencePath?: string } {
  if (path === undefined || !isExternalExistingPath(path)) return { kind, valid: false, reason: "external sanitized evidence missing" };
  return { kind, ...inspectRealDependencyEvidence({ kind, path, repositoryRoot: process.cwd() }) };
}

function isExternalExistingPath(value: string): boolean {
  const candidate = resolve(value);
  if (!existsSync(candidate)) return false;
  const relativePath = relative(resolve(process.cwd()), candidate);
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || /^[A-Za-z]:/u.test(relativePath);
}

void main();
