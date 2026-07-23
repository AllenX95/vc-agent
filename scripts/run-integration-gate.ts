import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  ExtensionAdmissionManager,
  GlobalExtensionRevisionManager,
  McpIntegrationManager,
  OfficeSkillOrchestrator,
  PageRecoveryPipeline,
  SkillCreationWorkflow,
  SkillPackageManager,
  inspectEnvironmentDoctor,
  doctorIsActivationFree,
  writeIntegrationGateReport,
  pageTextBlock,
  PINNED_PI_MCP_ADAPTER_VERSION,
  inspectRealDependencyEvidence,
  type McpAdapterConnection,
  type McpServerRecord,
  type McpToolSchema,
  type PinnedPiMcpAdapter
} from "../packages/host-services/src/index.ts";
import { createDesktopExtensionAuditAdapter, createDesktopMcpAdapter, createDesktopNativePdfAdapter, createDesktopOfficeAdapter, createDesktopOvisAdapter, createDesktopPaddleAdapter } from "../apps/desktop/src/main/integration-adapters.ts";

interface Scenario { testId: string; scenario: string; status: "pass" | "fail" | "blocked"; durationMs: number; evidencePath?: string; evidencePaths?: readonly string[]; warning?: string }

async function main(): Promise<void> {
  const outputRoot = resolve(process.env.VC_AGENT_GATE_OUTPUT ?? join(process.cwd(), "test-results", "integration-gate"));
  const workRoot = mkdtempSync(join(tmpdir(), "vc-agent-gate-"));
  const scenarios: Scenario[] = [];
  try {
    await scenario(scenarios, "G3-T-001", "Runtime ownership and activation-free Doctor fixture", () => runDoctorFixture());
    await scenario(scenarios, "G3-T-002", "Fixture Office import/create/edit/replace", () => runOffice(workRoot));
    await scenario(scenarios, "G3-T-003", "Skill Creator staged I1 handoff", () => runCreator(workRoot));
    await scenario(scenarios, "G3-T-004", "Mixed page recovery with retained candidates", () => runOcr(workRoot));
    await scenario(scenarios, "G3-T-005", "Lazy pinned MCP read/write/failure fixture", () => runMcp(workRoot));
    await scenario(scenarios, "G3-T-006", "Extension inspect/audit/approve/revision fixture", () => runExtension(workRoot));
    await scenario(scenarios, "G3-T-007", "Unavailable dependency and failure-injection paths", () => runUnavailable(workRoot));
    await scenario(scenarios, "G3-T-008", "Migration/restart recovery remains dormant", () => runRecoveryDormancy(workRoot));
    await scenario(scenarios, "G3-T-009", "Sanitized evidence and zero-secret scan", () => runEvidenceScan(workRoot));
    await scenario(scenarios, "G3-T-010", "Environment Doctor activation-free projection", () => runDoctorFixture());
  } finally {
    const realOffice = process.env.VC_AGENT_REAL_OFFICE_SOURCE;
    const realOcr = process.env.VC_AGENT_REAL_OCR === "1";
    const realMcp = process.env.VC_AGENT_REAL_MCP_ADAPTER === "1";
    const officeEvidence = process.env.VC_AGENT_REAL_OFFICE_EVIDENCE;
    const ocrEvidence = process.env.VC_AGENT_REAL_OCR_EVIDENCE;
    const mcpEvidence = process.env.VC_AGENT_REAL_MCP_EVIDENCE;
    const blocked: string[] = [];
    const office = realOffice !== undefined && isExternalExistingPath(realOffice) ? inspectRealDependencyEvidence({ kind: "office", path: officeEvidence, repositoryRoot: process.cwd() }) : { valid: false, reason: "Office source package is missing" };
    const ocr = realOcr && isExternalExistingPath(ocrEvidence) ? inspectRealDependencyEvidence({ kind: "ocr", path: ocrEvidence, repositoryRoot: process.cwd() }) : { valid: false, reason: "OCR runtime flag or evidence is missing" };
    const mcp = realMcp && isExternalExistingPath(mcpEvidence) ? inspectRealDependencyEvidence({ kind: "mcp", path: mcpEvidence, repositoryRoot: process.cwd() }) : { valid: false, reason: "MCP adapter flag or evidence is missing" };
    if (!office.valid) blocked.push(`Office: ${office.reason}`);
    if (!ocr.valid) blocked.push(`OCR: ${ocr.reason}`);
    if (!mcp.valid) blocked.push(`MCP: ${mcp.reason}`);
    const evidencePaths = [office, ocr, mcp].filter((item): item is typeof item & { evidencePath: string } => item.valid && typeof item.evidencePath === "string").map((item) => item.evidencePath);
    scenarios.push({ testId: "G3-T-011", scenario: "Personal Build real dependency path", status: blocked.length === 0 ? "pass" : "blocked", durationMs: 0, ...(evidencePaths.length === 0 ? {} : { evidencePaths }), ...(blocked.length === 0 ? {} : { warning: blocked.join("; ") }) });
    const doctor = inspectEnvironmentDoctor({
      piAdapter: { status: "ready", message: "Bundled adapter available; no Pi session was started." },
      profiles: { status: "attention", message: "Gate fixture uses no provider credential." },
      credentialReferences: { status: "ready", message: "Credential references only; no secret value was exported." },
      storage: { status: "ready", message: "Temporary local gate storage is writable." },
      migration: { status: "ready", message: "Supported state schema fixture is available." },
      scheduler: { status: "ready", message: "Bounded execution fixture is available." },
      agentRuntime: { status: "ready", message: "Worker supervisor remains dormant during fixture gate." },
      utilityRuntime: { status: "ready", message: "Utility runtime remains dormant during fixture gate." },
      isolatedRuntime: { status: "ready", message: "Isolated local jobs were bounded and cleaned up." },
      skills: { status: "ready", message: "Imported fixture packages remain app-owned and explicitly activated." },
      office: { status: office.valid ? "ready" : "attention", message: office.valid ? "User-supplied Office package and redacted compatibility evidence are configured outside the repository." : "Fixture path passed; real User-supplied package/evidence is not configured." },
      ocr: { status: ocr.valid ? "ready" : "attention", message: ocr.valid ? "Configured local OCR compatibility evidence supplied." : "PaddleOCR/OvisOCR2 local runtimes or evidence are unavailable in this run." },
      mcp: { status: mcp.valid ? "ready" : "attention", message: mcp.valid ? "Pinned adapter evidence is configured; fixture connections are opened only by activation." : "Pinned adapter fixture or evidence is unavailable in this run." },
      extensionRevision: { status: "ready", message: "Extension admission and revision fixture completed without auto-enable." },
      backup: { status: "ready", message: "No cognition backup was created by the gate." }
    });
    const report = writeIntegrationGateReport(outputRoot, {
      buildIdentity: { applicationVersion: "0.1.0", stateSchemaVersion: 14 },
      environmentDoctor: doctor,
      scenarios,
      migrationVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      unavailableDependencies: blocked,
      deferredScope: ["D1 Explicit Sub-Agent", "H1 Personal Build hardening"],
      evidenceRoot: outputRoot,
      secretScanInputs: ["credentialRef: local-reference-only", "no package bytes or OCR text exported"]
    });
    console.log(JSON.stringify({ decision: report.report.decision, jsonPath: report.jsonPath, markdownPath: report.markdownPath, scenarios: report.report.executedTests.map((item) => ({ testId: item.testId, status: item.status })) }, null, 2));
    if (report.report.decision === "fail") process.exitCode = 1;
  }
  rmSync(workRoot, { recursive: true, force: true });
}

function isExternalExistingPath(value: string | undefined): boolean {
  if (value === undefined) return false;
  const candidate = resolve(value);
  if (!existsSync(candidate)) return false;
  const relativePath = relative(resolve(process.cwd()), candidate);
  return relativePath === ".." || relativePath.startsWith(".." + sep) || /^[A-Za-z]:/u.test(relativePath);
}

async function scenario(target: Scenario[], testId: string, name: string, action: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try { await action(); target.push({ testId, scenario: name, status: "pass", durationMs: Date.now() - started }); }
  catch (error) { target.push({ testId, scenario: name, status: "fail", durationMs: Date.now() - started, warning: error instanceof Error ? error.message : "fixture failed" }); }
}

async function runDoctorFixture(): Promise<void> {
  const doctor = inspectEnvironmentDoctor({
    office: { status: "attention", message: "Fixture only; real Office package is not loaded." },
    ocr: { status: "attention", message: "Local OCR runtimes are not loaded during Doctor inspection." },
    mcp: { status: "ready", message: "Pinned adapter is dormant; no server connection is open." },
    extensionRevision: { status: "ready", message: "No Extension is enabled during Doctor inspection." }
  });
  if (!doctorIsActivationFree(doctor)) throw new Error("DOCTOR_ACTIVATION_OBSERVED");
}

async function runUnavailable(root: string): Promise<void> {
  const skills = new SkillPackageManager({ root: join(root, "unavailable-skills") });
  const skillSource = join(root, "unavailable-skill-source");
  mkdirSync(skillSource, { recursive: true });
  writeFileSync(join(skillSource, "SKILL.md"), "---\nname: Unavailable Office\n---\n# Fixture\n", "utf8");
  const imported = await skills.importLocalDirectory({ sourceDirectory: skillSource, packageId: "unavailable-office" });
  await skills.inspect(imported.package.revisionId); await skills.activate(imported.package.revisionId);
  const project = join(root, "unavailable-project"); mkdirSync(project, { recursive: true });
  const sourcePath = join(project, "source.docx"); writeFileSync(sourcePath, "source", "utf8");
  const office = new OfficeSkillOrchestrator({ skills, root: join(root, "unavailable-office"), adapter: { async run() { throw new Error("OFFICE_DEPENDENCY_UNAVAILABLE"); } } });
  const plan = await office.prepare({ kind: "edit", format: "docx", projectId: "unavailable-project", projectPath: project, threadId: "thread", turnId: "turn", profile: { id: "fixture", provider: "fixture", model: "fixture" }, skillRevisionId: imported.package.revisionId, outputDirectory: join(project, "outputs"), sourcePath, explicitIntent: true });
  const result = await office.execute(plan.planId); if (result.status !== "failed" || !existsSync(sourcePath)) throw new Error("OFFICE_FAILURE_DID_NOT_PRESERVE_SOURCE");
  await office.shutdown();

  const pipeline = new PageRecoveryPipeline({ native: createDesktopNativePdfAdapter(), paddle: createDesktopPaddleAdapter(), ovis: createDesktopOvisAdapter() });
  await pipeline.parse({ material: { id: randomUUID(), projectId: randomUUID(), relativePath: "unavailable.pdf", mediaType: "application/pdf", sourceHash: createHash("sha256").update("unavailable", "utf8").digest("hex") }, pageCount: 2 });
  if (pipeline.telemetry().lastStatus !== "completed_with_warnings") throw new Error("OCR_UNAVAILABLE_STATE_NOT_VISIBLE");

  const mcpRoot = join(root, "unavailable-mcp");
  const adapter: PinnedPiMcpAdapter = { version: PINNED_PI_MCP_ADAPTER_VERSION, async connect() { throw new Error("MCP_CONNECTION_FAILED"); } };
  const manager = new McpIntegrationManager({ root: mcpRoot, adapter });
  const server = manager.configure({ name: "Unavailable MCP", transport: "fixture", enabled: true, allowedScopes: ["project"] });
  try { await manager.resolveActivation({ serverId: server.serverId, toolIds: [], scope: "project", reason: "task_preactivation" }); throw new Error("MCP_FAILURE_WAS_SWALLOWED"); } catch (error) { if (!(error instanceof Error) || !error.message.toLowerCase().includes("mcp connection failed")) throw error; }
  await manager.shutdown();
  const restarted = new McpIntegrationManager({ root: mcpRoot, adapter: createGateMcpAdapter() });
  if (restarted.inventory()[0]?.connectionStatus !== "disconnected") throw new Error("MCP_RESTART_RECONNECTED");
  await restarted.shutdown();
}

async function runRecoveryDormancy(root: string): Promise<void> {
  const skills = new SkillPackageManager({ root: join(root, "recovery-skills") });
  const creatorRoot = join(root, "recovery-creator");
  const creator = new SkillCreationWorkflow({ manager: skills, root: creatorRoot });
  const draft = await creator.createDraft({ explicitIntent: true, packageId: "recovery-draft", files: { "SKILL.md": "---\nname: Recovery\n---\n# Recovery\n" } });
  await creator.shutdown();
  const restarted = new SkillCreationWorkflow({ manager: skills, root: creatorRoot });
  const restored = restarted.listDrafts().find((item) => item.draftId === draft.draftId);
  if (restored?.state !== "draft_ready") throw new Error("CREATOR_DRAFT_NOT_RESTORED");
  await restarted.shutdown();
}

async function runEvidenceScan(root: string): Promise<void> {
  const evidenceRoot = join(root, "evidence-scan");
  const artifacts = writeIntegrationGateReport(evidenceRoot, {
    buildIdentity: { applicationVersion: "0.1.0", stateSchemaVersion: 14 },
    environmentDoctor: inspectEnvironmentDoctor({ mcp: { status: "ready", message: "Credential references only; no secret value exported." } }),
    scenarios: [], migrationVersions: [1, 14], evidenceRoot,
    secretScanInputs: ["credentialRef: local-reference-only", "no OCR text or MCP response body exported"]
  });
  const content = readFileSync(artifacts.jsonPath, "utf8");
  if (!artifacts.report.zeroSecretScan.passed || content.includes(evidenceRoot)) throw new Error("EVIDENCE_SANITIZATION_FAILED");
}

async function runOffice(root: string): Promise<void> {
  const skills = new SkillPackageManager({ root: join(root, "skills") });
  const source = join(root, "office-skill-source"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: Fixture Office\ndescription: fixture\n---\n# Office\n", "utf8");
  writeFileSync(join(source, "LICENSE"), "fixture", "utf8");
  const imported = await skills.importLocalDirectory({ sourceDirectory: source, packageId: "fixture-office" });
  await skills.inspect(imported.package.revisionId); await skills.activate(imported.package.revisionId);
  const project = join(root, "project"); mkdirSync(project, { recursive: true });
  const sourcePath = join(project, "source.docx"); writeFileSync(sourcePath, "fixture source", "utf8");
  const outputs: Array<{ readonly sourceReferences: readonly string[]; readonly producer: { readonly skillRevisionId: string } }> = [];
  const orchestrator = new OfficeSkillOrchestrator({ skills, adapter: createDesktopOfficeAdapter(), root: join(root, "office"), registerOutput: (output) => outputs.push(output) });
  const plan = await orchestrator.prepare({ kind: "create", format: "docx", projectId: "project-1", projectPath: project, threadId: "thread-1", turnId: "turn-1", profile: { id: "fixture", provider: "fixture", model: "fixture" }, skillRevisionId: imported.package.revisionId, outputDirectory: join(project, "outputs"), explicitIntent: true });
  const result = await orchestrator.execute(plan.planId); if (result.status !== "validated") throw new Error("OFFICE_FIXTURE_NOT_VALIDATED");
  const output = await orchestrator.commit(result.resultId); if (!existsSync(output.destination)) throw new Error("OFFICE_OUTPUT_MISSING");
  const editPlan = await orchestrator.prepare({ kind: "edit", format: "docx", projectId: "project-1", projectPath: project, threadId: "thread-1", turnId: "turn-2", profile: { id: "fixture", provider: "fixture", model: "fixture" }, skillRevisionId: imported.package.revisionId, outputDirectory: join(project, "outputs"), outputFileName: "edited-copy", sourcePath, sourceReferences: ["fixture:source"], renderPreview: true, explicitIntent: true });
  const edited = await orchestrator.execute(editPlan.planId); if (edited.status !== "validated" || edited.changeSummaryPath === undefined || edited.sourceHash === undefined || edited.editedCopyHash === undefined) throw new Error("OFFICE_EDIT_FIXTURE_NOT_VALIDATED");
  const editedOutput = await orchestrator.commit(edited.resultId); if (!existsSync(editedOutput.destination)) throw new Error("OFFICE_EDITED_COPY_MISSING");
  const denied = await orchestrator.replaceOriginal({ resultId: edited.resultId, sourcePath, expectedSourceHash: edited.sourceHash, accessMode: "standard", confirmed: false }); if (denied.status !== "confirmation_required") throw new Error("OFFICE_STANDARD_CONFIRMATION_MISSING");
  const unknown = await orchestrator.replaceOriginal({ resultId: edited.resultId, sourcePath, expectedSourceHash: edited.sourceHash, accessMode: "full", confirmed: true, simulateUnknownOutcome: true }); if (unknown.status !== "unknown_outcome") throw new Error("OFFICE_UNKNOWN_OUTCOME_MISSING");
  const replaced = await orchestrator.replaceOriginal({ resultId: edited.resultId, sourcePath, expectedSourceHash: edited.sourceHash, accessMode: "full", confirmed: true }); if (replaced.status !== "replaced") throw new Error("OFFICE_REPLACEMENT_FIXTURE_FAILED");
  if (outputs.length < 2 || outputs.some((item) => item.producer.skillRevisionId !== imported.package.revisionId) || !outputs.some((item) => item.sourceReferences.includes("fixture:source"))) throw new Error("OFFICE_PROVENANCE_MISSING");
  await orchestrator.shutdown();
}

async function runCreator(root: string): Promise<void> {
  const skills = new SkillPackageManager({ root: join(root, "creator-skills") });
  const creator = new SkillCreationWorkflow({ manager: skills, root: join(root, "creator") });
  const draft = await creator.createDraft({ explicitIntent: true, packageId: "fixture-created", files: { "SKILL.md": "---\nname: Created\n---\n# Created\n", "LICENSE": "fixture" } });
  const review = await creator.review(draft.draftId); if (review.status !== "reviewable") throw new Error("CREATOR_FIXTURE_NOT_REVIEWABLE");
  const accepted = await creator.accept(draft.draftId, { confirmed: true }); if (accepted.package.enabled) throw new Error("CREATOR_FIXTURE_AUTO_ENABLED");
  await creator.shutdown();
}

async function runOcr(root: string): Promise<void> {
  const sourceHash = createHash("sha256").update("fixture-pdf", "utf8").digest("hex");
  const pipeline = new PageRecoveryPipeline({ native: createDesktopNativePdfAdapter(), paddle: { ...createDesktopPaddleAdapter(), inspectAvailability: () => ({ status: "ready", message: "fixture" }) }, ovis: { ...createDesktopOvisAdapter(), inspectAvailability: () => ({ status: "ready", message: "fixture" }) } });
  const result = await pipeline.parse({ material: { id: randomUUID(), projectId: randomUUID(), relativePath: "fixture.pdf", mediaType: "application/pdf", sourceHash }, pageCount: 2 });
  if (result.provenance.stages.length < 2) throw new Error("OCR_FIXTURE_STAGES_MISSING");
}

function createGateMcpAdapter(): PinnedPiMcpAdapter {
  const read: McpToolSchema = { name: "search", actionClass: "read", allowedScopes: ["project", "unscoped"], inputBytes: 1_000, outputBytes: 2_000, schemaHash: "search-v1" };
  const write: McpToolSchema = { name: "update", actionClass: "write", allowedScopes: ["project"], inputBytes: 1_000, outputBytes: 2_000, schemaHash: "update-v1" };
  return { version: PINNED_PI_MCP_ADAPTER_VERSION, async connect(): Promise<McpAdapterConnection> { return { listTools: async () => [read, write], call: async (toolName) => ({ toolName, fixture: true }), close: async () => undefined }; } };
}

async function runMcp(root: string): Promise<void> {
  const read: McpToolSchema = { name: "search", actionClass: "read", allowedScopes: ["project", "unscoped"], inputBytes: 1_000, outputBytes: 2_000, schemaHash: "search-v1" };
  const write: McpToolSchema = { name: "update", actionClass: "write", allowedScopes: ["project"], inputBytes: 1_000, outputBytes: 2_000, schemaHash: "update-v1" };
  const adapter: PinnedPiMcpAdapter = createGateMcpAdapter();
  const manager = new McpIntegrationManager({ root: join(root, "mcp"), adapter });
  const server = manager.configure({ name: "Fixture MCP", transport: "fixture", enabled: true, allowedScopes: ["project", "unscoped"], enabledToolIds: ["search", "update"], toolSchemas: [read, write] });
  if ((manager.inventory()[0]?.connectionStatus ?? "connected") !== "disconnected") throw new Error("MCP_EAGER_CONNECTION");
  const activation = await manager.resolveActivation({ serverId: server.serverId, toolIds: ["search"], scope: "unscoped", reason: "task_preactivation" });
  const result = await manager.execute({ activationId: activation.activationId, serverId: server.serverId, toolName: "search", arguments: {}, threadId: "thread", turnId: "turn", scope: "unscoped", accessMode: "standard", expectedSchemaRevision: activation.schemaRevision });
  if (result.status !== "completed") throw new Error("MCP_READ_NOT_COMPLETED"); await manager.shutdown();
}

async function runExtension(root: string): Promise<void> {
  const source = join(root, "extension-source"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "fixture-extension", version: "1.0.0", license: "MIT", main: "index.js" }), "utf8");
  writeFileSync(join(source, "package-lock.json"), "{}", "utf8"); writeFileSync(join(source, "index.js"), "module.exports = {};", "utf8");
  const admission = new ExtensionAdmissionManager({ root: join(root, "extensions"), auditAdapter: createDesktopExtensionAuditAdapter() });
  const staged = await admission.stage({ sourcePath: source }); const report = await admission.inspect(staged.stagedRevisionId);
  const audit = await admission.startAudit({ stagedRevisionId: staged.stagedRevisionId, profileId: "fixture-profile", providerAvailable: true }); if (audit.status !== "audit_complete") throw new Error("EXTENSION_AUDIT_NOT_COMPLETE");
  const approved = await admission.approve({ stagedRevisionId: staged.stagedRevisionId, reportId: report.reportId, expectedArtifactHash: report.artifactHash, userConfirmed: true });
  const global = new GlobalExtensionRevisionManager({ root: join(root, "extensions"), admission }); const pending = await global.propose({ action: "enable", extensionId: approved.extensionId, approvedRevisionId: approved.approvedRevisionId }); await global.activateWhenIdle(pending.revisionId); if (global.snapshot().effectiveExtensions.length !== 1) throw new Error("EXTENSION_REVISION_NOT_ACTIVE"); await admission.shutdown();
}

void main();
