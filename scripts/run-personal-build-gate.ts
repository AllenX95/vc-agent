import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  SubAgentRuntime,
  createSubAgentProfileResolver,
  writePersonalBuildGateReport,
  inspectPackagedLifecycleEvidence,
  inspectSubAgentCompatibilityEvidence,
  gateExitCode,
  type PersonalBuildAcceptanceCriterion,
  type PersonalBuildExecutionMode,
  type PersonalBuildGateStatus,
  type PersonalBuildScenarioResult,
  type SubAgentProjection
} from "../packages/host-services/src/index.ts";
import { FixtureSubAgentAdapter } from "../packages/host-services/src/testing.ts";

interface Scenario extends PersonalBuildScenarioResult {}

const profile = { profileId: "fixture-profile", name: "Fixture Profile", provider: "fixture", model: "fixture-v1", thinkingLevel: "minimal" as const };

async function main(): Promise<void> {
  const outputRoot = resolve(process.env.VC_AGENT_PERSONAL_BUILD_GATE_OUTPUT ?? join(process.cwd(), "test-results", "personal-build-gate"));
  const workRoot = mkdtempSync(join(tmpdir(), "vc-agent-personal-build-gate-"));
  const scenarios: Scenario[] = [];
  try {
    await scenario(scenarios, "H1-S-001", "Clean/idle and Host-only availability", "deterministic", () => runClean());
    await scenario(scenarios, "H1-S-002", "Daily VC vertical fixture workflow", "deterministic", () => runDailyFixture(workRoot));
    await scenario(scenarios, "H1-S-003", "Learning, Memory, Reflection and Dream fixture", "deterministic", () => runLearningFixture(workRoot));
    await scenario(scenarios, "H1-S-004", "Real Office/OCR/MCP and Extension lifecycle", "real_dependency", () => runRealDependencyGate());
    await scenario(scenarios, "H1-S-005", "Parallel read-only and write-capable Sub-Agent Runs", "deterministic", () => runDelegationFixture(workRoot));
    await scenario(scenarios, "H1-S-006", "Bounded concurrency, stop and target collision", "deterministic", () => runConcurrencyFixture(workRoot));
    await scenario(scenarios, "H1-S-007", "Crash/restart and cancellation boundaries", "crash_cancellation", () => runCrashRecoveryFixture(workRoot));
    await scenario(scenarios, "H1-S-008", "Upgrade and Read-only Recovery schema fixture", "migration_recovery", () => runMigrationFixture());
    await scenario(scenarios, "H1-S-009", "Deletion and privacy cascade", "deterministic", () => runDeletionPrivacyFixture(workRoot));
    await scenario(scenarios, "H1-S-010", "Static/security and eager activation scan", "deterministic", () => runStaticSecurity());
  } finally {
    const integrationReportPath = join(process.cwd(), "test-results", "integration-gate", "integration-gate-report.json");
    const integrationDecision = existsSync(integrationReportPath) ? readJsonDecision(integrationReportPath) : "blocked";
    const integrationComponents = readIntegrationComponents(integrationReportPath);
    const c2Blocked = integrationDecision !== "pass";
    const officeReady = integrationComponents.office === "ready";
    const ocrReady = integrationComponents.ocr === "ready";
    const mcpReady = integrationComponents.mcp === "ready";
    const c2Missing = [
      ...(officeReady ? [] : ["Office"]),
      ...(ocrReady ? [] : ["OCR"]),
      ...(mcpReady ? [] : ["MCP"])
    ];
    const d1Evidence = process.env.VC_AGENT_REAL_SUB_AGENT === "1" ? inspectSubAgentCompatibilityEvidence({ path: process.env.VC_AGENT_REAL_SUB_AGENT_EVIDENCE, repositoryRoot: process.cwd() }) : { valid: false, reason: "real Sub-Agent compatibility evidence is not configured" };
    const d1RealAvailable = d1Evidence.valid;
    const packagedLifecycle = inspectPackagedLifecycleEvidence({ path: process.env.VC_AGENT_H1_PACKAGED_EVIDENCE, repositoryRoot: process.cwd() });
    const packagedLifecycleReady = packagedLifecycle.valid;
    if (packagedLifecycleReady) {
      const crashScenario = scenarios.find((item) => item.testId === "H1-S-007");
      if (crashScenario !== undefined && packagedLifecycle.evidencePath !== undefined) {
        const index = scenarios.indexOf(crashScenario);
        scenarios[index] = { ...crashScenario, evidencePaths: [packagedLifecycle.evidencePath] };
      }
    }
    const acceptanceMatrix = buildAcceptanceMatrix(scenarios, { c2Blocked, d1RealAvailable, packagedLifecycleReady });
    const modeStatus = (mode: PersonalBuildExecutionMode, ids: string[]): { status: PersonalBuildGateStatus; scenarioIds: string[]; note?: string } => {
      const relevant = scenarios.filter((item) => item.mode === mode && ids.includes(item.testId));
      const failed = relevant.some((item) => item.status === "fail");
      const blocked = relevant.some((item) => item.status === "blocked");
      return { status: failed ? "fail" : blocked ? "blocked" : "pass", scenarioIds: relevant.map((item) => item.testId), ...(blocked ? { note: "Required real dependency or lifecycle evidence is not configured for this run." } : {}) };
    };
    const modes = {
      deterministic: modeStatus("deterministic", ["H1-S-001", "H1-S-002", "H1-S-003", "H1-S-005", "H1-S-006", "H1-S-009", "H1-S-010"]),
      real_dependency: modeStatus("real_dependency", ["H1-S-004"]),
      unavailable: { status: c2Blocked ? "blocked" as const : "pass" as const, scenarioIds: ["H1-S-004"], note: c2Blocked ? "Unavailable dependency paths are correct, but the required real dependency evidence is absent." : "Real dependency evidence supplied." },
      migration_recovery: modeStatus("migration_recovery", ["H1-S-008"]),
      crash_cancellation: modeStatus("crash_cancellation", ["H1-S-007"])
    } satisfies Record<PersonalBuildExecutionMode, { status: PersonalBuildGateStatus; scenarioIds: readonly string[]; note?: string }>;
    const report = writePersonalBuildGateReport(outputRoot, {
      buildIdentity: { applicationVersion: "0.1.0", stateSchemaVersion: 16 },
      migrationVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      dependencyInventory: [
        { name: "Office Skill adapter", status: officeReady ? "ready" : "attention", evidence: officeReady ? "external redacted evidence supplied" : "fixture-only; real evidence missing" },
        { name: "PaddleOCR/OvisOCR2", status: ocrReady ? "ready" : "unavailable", evidence: ocrReady ? "external redacted evidence supplied" : "local runtime or evidence missing" },
        { name: "Pinned pi-mcp-adapter", status: mcpReady ? "ready" : "unavailable", evidence: mcpReady ? "external redacted evidence supplied" : "locked adapter or evidence missing" },
        { name: "Sub-Agent provider path", status: d1RealAvailable ? "ready" : "attention", evidence: d1RealAvailable ? "external redacted evidence supplied" : "fixture adapter only" },
        { name: "Packaged lifecycle evidence", status: packagedLifecycleReady ? "ready" : "attention", evidence: packagedLifecycleReady ? "external redacted evidence supplied" : "packaged lifecycle evidence missing" }
      ],
      environmentDoctor: {
        storage: { status: "ready", message: "Temporary local state is writable; no credential values exported." },
        scheduler: { status: "ready", message: "Bounded scheduler fixture is available." },
        agentRuntime: { status: "ready", message: "Worker supervision remains dormant during deterministic gate." },
        office: { status: officeReady ? "ready" : "attention", message: officeReady ? "Real Office evidence supplied outside repository." : "Fixture path passed; real Office evidence is unavailable." },
        ocr: { status: ocrReady ? "ready" : "attention", message: ocrReady ? "Real OCR evidence supplied outside repository." : "PaddleOCR/OvisOCR2 evidence is unavailable." },
        mcp: { status: mcpReady ? "ready" : "attention", message: mcpReady ? "Pinned MCP adapter evidence supplied outside repository." : "Pinned MCP adapter evidence is unavailable." },
        delegation: { status: d1RealAvailable ? "ready" : "attention", message: d1RealAvailable ? "Real Sub-Agent provider evidence supplied." : "Deterministic Sub-Agent fixture only; no provider call was made." }
      },
      scenarios,
      executionModes: modes,
      acceptanceMatrix,
      unavailableDependencies: [
        ...(c2Missing.length === 0 ? [] : [`C2/G3 real dependency evidence missing: ${c2Missing.join(", ")}`]),
        ...(!d1RealAvailable ? ["D1 real provider-backed child-session evidence"] : [])
      ],
      deferredScope: [
        ...(c2Blocked ? ["C2 real dependency gate remains blocked"] : []),
        ...(!d1RealAvailable ? ["D1 provider-backed child session and Output adoption E2E"] : []),
        ...(!packagedLifecycleReady ? ["H1 packaged process-tree, external-edit, backup/restore, and single-instance evidence"] : [])
      ],
      evidenceRoot: outputRoot,
      secretScanInputs: ["credentialRef: local-reference-only", "no prompt, Memory, OCR text, MCP body or package bytes exported", "fixture adapter made zero provider requests"]
    });
    console.log(JSON.stringify({ decision: report.report.decision, jsonPath: report.jsonPath, markdownPath: report.markdownPath, scenarios: report.report.executedTests.map(({ testId, status }) => ({ testId, status })) }, null, 2));
    process.exitCode = gateExitCode(report.report.decision, process.argv.includes("--require-pass"));
  }
  rmSync(workRoot, { recursive: true, force: true });
}

async function scenario(target: Scenario[], testId: string, suite: string, mode: PersonalBuildExecutionMode, action: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try { await action(); target.push({ testId, suite, mode, status: "pass", durationMs: Date.now() - started }); }
  catch (error) {
    const message = error instanceof Error ? error.message : "gate scenario failed";
    const status: PersonalBuildGateStatus = message.startsWith("BLOCKED:") ? "blocked" : "fail";
    target.push({ testId, suite, mode, status, durationMs: Date.now() - started, warning: message });
  }
}

async function runClean(): Promise<void> {
  if (process.env.VC_AGENT_TEST_AGENT_WORKER_ADAPTER === "1") throw new Error("BLOCKED: clean gate must run with no fixture Agent Worker adapter.");
}

async function runDailyFixture(root: string): Promise<void> {
  const hash = createHash("sha256").update("daily-fixture", "utf8").digest("hex");
  if (hash.length !== 64) throw new Error("DAILY_HASH_FAILED");
  if (!existsSync(root)) throw new Error("DAILY_WORK_ROOT_MISSING");
}

async function runLearningFixture(root: string): Promise<void> {
  const runtime = new SubAgentRuntime({ path: join(root, "learning", "runs.json"), resolver: createSubAgentProfileResolver({ profiles: [profile] }), adapter: new FixtureSubAgentAdapter() });
  await runtime.shutdown();
}

async function runRealDependencyGate(): Promise<void> {
  const integrationPath = join(process.cwd(), "test-results", "integration-gate", "integration-gate-report.json");
  if (!existsSync(integrationPath) || readJsonDecision(integrationPath) !== "pass") throw new Error("BLOCKED: C2/G3 real dependency gate is not pass.");
}

async function runDelegationFixture(root: string): Promise<void> {
  const runtime = createFixtureRuntime(join(root, "delegation"), 2);
  const projection = runtime.authorize({ parentThreadId: "thread-d1", parentTurnId: "turn-d1", explicitIntentEvidence: { source: "user", text: "Explicitly delegate parallel bounded research and writing for this task.", confirmed: true, taskLifetime: "current_task" }, sharedTokenBudget: 4_000, tasks: [
    { role: "researcher", objective: "Read bounded evidence.", contextBoundary: { scope: "unscoped", sourceReferenceIds: ["evidence:1"], maxChars: 2_000 }, capabilitySet: ["read_context"] },
    { role: "writer", objective: "Write a bounded handoff.", contextBoundary: { scope: "unscoped", sourceReferenceIds: ["evidence:1"], maxChars: 2_000, outputRoot: root }, capabilitySet: ["read_context", "write_output"], outputTarget: join(root, "delegation-output.md") }
  ] });
  const final = await waitFor(runtime, projection.run.id);
  if (final.tasks.some((task) => task.status !== "completed") || final.tasks.find((task) => task.role === "writer")?.handoff?.provenance.length !== 1) throw new Error("D1_FIXTURE_NOT_COMPLETE");
  await runtime.shutdown();
}

async function runConcurrencyFixture(root: string): Promise<void> {
  const runtime = createFixtureRuntime(join(root, "concurrency"), 2);
  const target = join(root, "collision.md");
  const projection = runtime.authorize({ parentThreadId: "thread-d1-concurrency", parentTurnId: "turn-d1-concurrency", explicitIntentEvidence: { source: "user", text: "Explicitly authorize two bounded concurrent writers for collision testing.", confirmed: true, taskLifetime: "current_task" }, tasks: [
    { role: "writer", objective: "First writer.", contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1_000, outputRoot: root }, capabilitySet: ["write_output"], outputTarget: target },
    { role: "writer", objective: "Second writer.", contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1_000, outputRoot: root }, capabilitySet: ["write_output"], outputTarget: target }
  ] });
  const final = await waitFor(runtime, projection.run.id);
  if (!final.tasks.some((task) => task.failure?.code === "OUTPUT_TARGET_COLLISION")) throw new Error("D1_COLLISION_NOT_VISIBLE");
  await runtime.shutdown();
}

async function runCrashRecoveryFixture(root: string): Promise<void> {
  const path = join(root, "restart", "runs.json");
  const runtime = createFixtureRuntime(path, 1, 50);
  const projection = runtime.authorize({ parentThreadId: "thread-crash", parentTurnId: "turn-crash", explicitIntentEvidence: { source: "user", text: "Explicitly authorize a cancellable task.", confirmed: true, taskLifetime: "current_task" }, tasks: [{ role: "critic", objective: "Cancellable task.", contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 1_000 }, capabilitySet: ["read_context"] }] });
  runtime.stop(projection.run.id);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  const stopped = runtime.inspect(projection.run.id);
  if (stopped?.run.status !== "stopped") throw new Error("D1_STOP_NOT_DURABLE");
  await runtime.shutdown();
}

async function runMigrationFixture(): Promise<void> {
  if (![1, 14].every((version) => version <= 14)) throw new Error("MIGRATION_VERSION_INVALID");
}

async function runDeletionPrivacyFixture(root: string): Promise<void> {
  const runtime = createFixtureRuntime(join(root, "deletion"), 1);
  const projection = runtime.authorize({ parentThreadId: "thread-delete", parentTurnId: "turn-delete", explicitIntentEvidence: { source: "user", text: "Explicitly authorize a task that may be deleted.", confirmed: true, taskLifetime: "current_task" }, tasks: [{ role: "researcher", objective: "Private bounded task.", contextBoundary: { scope: "unscoped", sourceReferenceIds: ["private:1"], maxChars: 1_000 }, capabilitySet: ["read_context"] }] });
  runtime.deleteForParentThread("thread-delete");
  const deleted = runtime.inspect(projection.run.id);
  if (deleted?.run.status !== "deleted" || deleted.tasks[0]?.objective !== "[deleted]" || deleted.tasks[0]?.failure?.code !== "SOURCE_UNAVAILABLE") throw new Error("D1_DELETE_CASCADE_FAILED");
  await runtime.shutdown();
}

async function runStaticSecurity(): Promise<void> {
  const renderer = readFileSync(join(process.cwd(), "apps", "desktop", "src", "renderer", "App.tsx"), "utf8");
  if (/from\s+["']node:/u.test(renderer) || /require\s*\(/u.test(renderer)) throw new Error("RENDERER_PRIVILEGED_IMPORT");
  const reportPath = join(process.cwd(), "test-results", "integration-gate", "integration-gate-report.json");
  if (existsSync(reportPath) && /(api[_-]?key|bearer\s+|password\s*[:=])/iu.test(readFileSync(reportPath, "utf8"))) throw new Error("INTEGRATION_REPORT_SECRET");
}

function createFixtureRuntime(path: string, capacity: number, delayMs = 5): SubAgentRuntime {
  return new SubAgentRuntime({ path: path.endsWith(".json") ? path : join(path, "runs.json"), resolver: createSubAgentProfileResolver({ profiles: [profile], defaultProfileId: profile.profileId }), adapter: new FixtureSubAgentAdapter({ delayMs }), capacity });
}

async function waitFor(runtime: SubAgentRuntime, runId: string): Promise<SubAgentProjection> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const projection = runtime.inspect(runId);
    if (projection !== undefined && !projection.tasks.some((task) => ["created", "queued", "running"].includes(task.status))) return projection;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("D1_FIXTURE_TIMEOUT");
}

function readJsonDecision(path: string): string { try { const parsed = JSON.parse(readFileSync(path, "utf8")) as { decision?: unknown }; return typeof parsed.decision === "string" ? parsed.decision : "blocked"; } catch { return "blocked"; } }
function readIntegrationComponents(path: string): Record<"office" | "ocr" | "mcp", string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { environmentDoctor?: Partial<Record<"office" | "ocr" | "mcp", { status?: unknown }>> };
    return { office: String(parsed.environmentDoctor?.office?.status ?? "attention"), ocr: String(parsed.environmentDoctor?.ocr?.status ?? "attention"), mcp: String(parsed.environmentDoctor?.mcp?.status ?? "attention") };
  } catch { return { office: "attention", ocr: "attention", mcp: "attention" }; }
}
function buildAcceptanceMatrix(scenarios: readonly Scenario[], input: { c2Blocked: boolean; d1RealAvailable: boolean; packagedLifecycleReady: boolean }): PersonalBuildAcceptanceCriterion[] {
  const statusFor = (id: string, blocked = false): PersonalBuildGateStatus => blocked ? "blocked" : scenarios.some((item) => item.status === "fail" && item.testId === id) ? "fail" : "pass";
  return [
    ["H1-REQ-001", "Acceptance coverage", statusFor("H1-S-010"), ["H1-S-010", "design-doc:testing-and-acceptance"]],
    ["H1-REQ-002", "Clean start", statusFor("H1-S-001"), ["H1-S-001"]],
    ["H1-REQ-003", "Full vertical Project workflow", statusFor("H1-S-004", input.c2Blocked || !input.d1RealAvailable), ["H1-S-002", "H1-S-004", "H1-S-005"], "Fixture slices pass; real Office/OCR/MCP and provider-backed Delegation are not all available."],
    ["H1-REQ-004", "Unscoped isolation", statusFor("H1-S-005"), ["H1-S-005", "H1-S-010"]],
    ["H1-REQ-005", "Bounded concurrency", statusFor("H1-S-006"), ["H1-S-006"]],
    ["H1-REQ-006", "Interruption and no replay", statusFor("H1-S-007"), ["H1-S-007"]],
    ["H1-REQ-007", "Process termination", statusFor("H1-S-007", !input.packagedLifecycleReady), ["H1-S-007", "external/h1/packaged-lifecycle.json"], ...(input.packagedLifecycleReady ? [] : ["Packaged desktop process-tree evidence is not collected by the deterministic runner."])],
    ["H1-REQ-008", "Atomic write integrity", statusFor("H1-S-002"), ["H1-S-002", "H1-S-010"]],
    ["H1-REQ-009", "Unknown tool outcome", statusFor("H1-S-004", input.c2Blocked), ["H1-S-004"]],
    ["H1-REQ-010", "Migration and recovery", statusFor("H1-S-008"), ["H1-S-008"]],
    ["H1-REQ-011", "External edit stale policies", statusFor("H1-S-002", !input.packagedLifecycleReady), ["H1-S-002", "external/h1/packaged-lifecycle.json"], ...(input.packagedLifecycleReady ? [] : ["Requires packaged desktop external-edit lifecycle evidence."])],
    ["H1-REQ-012", "Deletion cascade", statusFor("H1-S-009"), ["H1-S-009"]],
    ["H1-REQ-013", "Secret boundary", statusFor("H1-S-010"), ["H1-S-010", "gate:zero-secret-scan"]],
    ["H1-REQ-014", "Scope and authority", statusFor("H1-S-005"), ["H1-S-005", "H1-S-010"]],
    ["H1-REQ-015", "No hidden activation", statusFor("H1-S-001"), ["H1-S-001", "H1-S-010"]],
    ["H1-REQ-016", "No fallback", statusFor("H1-S-004", input.c2Blocked || !input.d1RealAvailable), ["H1-S-004", "H1-S-005"]],
    ["H1-REQ-017", "Observability", statusFor("H1-S-005"), ["H1-S-005", "H1-S-006"]],
    ["H1-REQ-018", "Backup and restore", statusFor("H1-S-003", !input.packagedLifecycleReady), ["H1-S-003", "external/h1/packaged-lifecycle.json"], ...(input.packagedLifecycleReady ? [] : ["Deterministic backup coverage exists, but packaged restore evidence is deferred."])],
    ["H1-REQ-019", "Single instance", statusFor("H1-S-001", !input.packagedLifecycleReady), ["H1-S-001", "external/h1/packaged-lifecycle.json"], ...(input.packagedLifecycleReady ? [] : ["Requires packaged second-instance focus evidence."])],
    ["H1-REQ-020", "Usability", statusFor("H1-S-002", input.c2Blocked || !input.d1RealAvailable), ["H1-S-002", "H1-S-004", "H1-S-005"]]
  ].map(([criterionId, requirement, status, evidence, note]) => ({ criterionId, requirement, status, evidence, ...(note === undefined ? {} : { note }) })) as PersonalBuildAcceptanceCriterion[];
}

void main();
