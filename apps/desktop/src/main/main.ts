import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from "electron";
import {
  IPC_SCHEMA_VERSION,
  canonicalParseSchema,
  hostCommandSchema,
  type ArtifactRecord,
  type ActorRef,
  type AcademicCredentialSource,
  type CapabilityExecutionRequest,
  type CapabilityExecutionResult,
  type DreamProfileSnapshot,
  type DreamExtractionScope,
  type HostCommand,
  type HostEvent,
  type ReflectionRun,
  type MaterialInventoryItem,
  type ModelProfile,
  type ProvenanceRef,
  type ProviderFailure,
  type ProjectOutputArtifact,
  type ReflectionOutcomeProposalInput,
  type SystemPromptRevision,
  type Thread,
  type TrajectoryEvent,
  type TrajectoryProfile,
  type WorkerCommand,
  type WorkerEvent,
  type ExtensionInventorySnapshot,
  type RuntimeSkillSnapshot as ContractRuntimeSkillSnapshot,
  type SkillCompatibilityReport as ContractSkillCompatibilityReport,
  type SkillInventoryItem as ContractSkillInventoryItem,
  type IntegrationState,
  type IntegrationJobSummary,
  type SubAgentProfileSnapshot,
  type SubAgentRole,
  type RuntimeResourceSnapshot,
  type SubAgentContextBoundary,
  type TaskModelType
} from "@vc-agent/contracts";
import { BinaryOutputStore, CapabilityRegistry, capabilitiesForTurn, createAcademicResearchCapability, createCapabilityBroker, createFileDownloadCapability, createMaterialRecallCapability, createMemoryRecallCapability, createProjectCommandCapability, createProjectStateRecallCapability, createReflectionEvidenceDrilldownCapability, createReflectionOutcomeProposalCapability, createTextEditCapability, createTextOutputCapability, createTurnCapabilitySurface, createWebFetchCapability, createWebSearchCapability, FetchFileDownloadClient, TextOutputStore } from "@vc-agent/capabilities";
import { PI_BUILTIN_PROVIDER_IDS } from "@vc-agent/pi-adapter/provider-catalog";
import { PROJECT_READ_TOOL_METADATA, PROJECT_READ_TOOL_NAMES } from "@vc-agent/pi-adapter/project-read-tool-metadata";
import { AcademicResearchService, BASELINE_PARSER_ADAPTERS, CapabilityGateway, ContextBudgetService, DEFAULT_PROJECT_REFLECTION_OBJECTIVE, DEFAULT_UNSCOPED_REFLECTION_OBJECTIVE, DREAM_EXTRACTION_STAGE_INSTRUCTIONS, DREAM_GLOBAL_SYNTHESIS_INSTRUCTIONS, DefaultAcademicHttpAccess, DreamCommitStore, DreamReviewStore, INDEPENDENT_EVIDENCE_STAGE_INSTRUCTIONS, INDEPENDENT_UNSCOPED_EVIDENCE_STAGE_INSTRUCTIONS, MEMORY_AWARE_REFLECTION_INSTRUCTIONS, LongTermMemoryRecallSource, LongTermMemoryStore, MemoryCandidateStore, MemoryEvolutionStore, PersonalCognitionBackupService, ProjectOutputRegistry, ReflectionEvidenceDrilldownSource, ReflectionOutcomeStore, academicWorkflowPrototype, buildDreamGlobalSynthesisPrompt, buildDreamScopeExtractionContext, buildDreamScopeExtractionPrompt, buildDreamSynthesisInput, buildIndependentEvidencePrompt, buildMemoryAwareReflectionPrompt, buildReflectionProjectBrief, buildReflectionUnscopedBrief, captureReflectionDependencies, detectAcademicResearchIntent, detectExplicitMemoryRecallIntent, detectFileDownloadIntent, detectJudgmentHeavyIntent, detectMaterialRecallIntent, detectMemoryCandidateSignal, detectOutputIntent, detectProjectCommandIntent, detectProjectStateRecallIntent, detectReflectionDreamEligibility, detectTextEditIntent, detectWebResearchIntent, dreamSynthesisInputHash, estimateTokens, expectedParserIdentity, inventoryProjectFiles, MaterialRecallSource, parseDreamGlobalSynthesis, parseDreamScopeSummary, parseIndependentAssessment, ProjectContextRecallSource, ProjectContextStore, ProjectIdentityStore, ProjectMemoryRecallSource, ProjectMemoryStore, PublicWebRecallSource, reflectionFraming, retrievalTrajectorySummary, selectEligibleDreamTrajectory, serializeBoundedRetrieval, SHIPPED_MINIMAL_VC_SYSTEM_PROMPT, staleReflectionDependencies, type CapabilityAuthorizationSnapshot, type ReflectionDependencyState } from "@vc-agent/host-services";
import { BUNDLED_ACADEMIC_SKILL_IDS, BoundedExecutionScheduler, ExtensionAdmissionManager, GlobalExtensionRevisionManager, McpIntegrationManager, OfficeSkillOrchestrator, PageRecoveryPipeline, ProviderSubAgentAdapter, SkillCreationWorkflow, SkillPackageManager, SkillResourceProjector, SubAgentContextCompiler, SubAgentRuntime, installBundledAcademicSkills, isUserOfficeSkillPackage, resolveVcAgentUserDataRoot, type RuntimeSkillSnapshot, type SkillCompatibilityReport, type SkillInventoryItem, type SkillDraft, type SkillDraftReview, type McpActivationDecision, type McpServerStatus, type SubAgentRuntimeEvent } from "@vc-agent/host-services";
import { AcademicResearchRunStore } from "@vc-agent/host-services";
import { exportRawStateBundle, HostStateStore, ThreadTrajectoryStore } from "@vc-agent/persistence";
import { AgentWorkerSupervisor } from "./agent-worker-supervisor.js";
import { ExtensionAuditWorkerExecutor } from "./extension-audit-worker.js";
import { InflightTurnCoordinator } from "./inflight-turn-coordinator.js";
import { UtilityJobRunner } from "./utility-job-runner.js";
import { ProtectedCredentialService } from "./protected-credential-service.js";
import { resolveDesktopRuntimePaths, validatePackagedRuntimePaths } from "./runtime-paths.js";
import { DesktopSubAgentProviderExecutor, providerCapabilityIds, type SubAgentCapabilityExecutionContext } from "./sub-agent-provider-executor.js";
import { createDesktopExtensionAuditAdapter, createDesktopMcpAdapter, createDesktopNativePdfAdapter, createDesktopOfficeAdapter, createDesktopOvisAdapter, createDesktopPaddleAdapter } from "./integration-adapters.js";
import { HostTurnExecutionModule, type DreamExecutionContext, type DreamSynthesisExecutionContext, type ReflectionExecutionContext, type TurnContext } from "./turn-execution.js";

const COMMAND_CHANNEL = "vc-agent:command";
const EVENT_CHANNEL = "vc-agent:event";
const HOST_ACTOR = { actorType: "host", actorId: "desktop-host" } as const;
const HOST_PROVENANCE = { producerType: "host", producerId: "desktop-host" } as const;
const USER_ACTOR = { actorType: "user", actorId: "local-user" } as const;
const USER_PROVENANCE = { producerType: "user", producerId: "local-user" } as const;
const AGENT_ACTOR = { actorType: "agent", actorId: "primary-agent" } as const;
const AGENT_PROVENANCE = { producerType: "agent", producerId: "primary-agent" } as const;
const configuredExecutionCapacity = Number.parseInt(process.env.VC_AGENT_EXECUTION_CAPACITY ?? "2", 10);
const EXECUTION_CAPACITY = Number.isInteger(configuredExecutionCapacity) && configuredExecutionCapacity > 0 ? configuredExecutionCapacity : 2;
const contextBudgetService = new ContextBudgetService();
const ACADEMIC_CREDENTIAL_ENVIRONMENT: Readonly<Record<AcademicCredentialSource, string>> = {
  openalex: "OPENALEX_API_KEY",
  github: "GITHUB_TOKEN",
  huggingface: "HF_TOKEN"
};

const READ_ONLY_RECOVERY_COMMANDS = new Set<HostCommand["command"]>([
  "app.bootstrap",
  "state.recovery.export",
  "profile.list",
  "academic.credentials.list",
  "skills.list",
  "skills.inspect",
  "integration.state.load",
  "office.source.choose",
  "office.artifact.open",
  "skill_creator.list",
  "page_recovery.inspect",
  "mcp.server.list",
  "extension.list",
  "prompt.revision.list",
  "task_model_assignment.list",
  "reflection.list",
  "reflection.outcome.list",
  "dream.state.load",
  "project.list",
  "project.material.list",
  "project.output.list",
  "thread.list",
  "thread.trajectory.load",
  "execution_queue.list",
  "sub_agent.run.list",
  "sub_agent.run.inspect"
]);

function resolveAcademicCredentials(): Partial<Record<AcademicCredentialSource, string>> {
  const resolved: Partial<Record<AcademicCredentialSource, string>> = {};
  for (const source of Object.keys(ACADEMIC_CREDENTIAL_ENVIRONMENT) as AcademicCredentialSource[]) {
    const encrypted = stateStore?.getAcademicCredential(source);
    if (encrypted !== undefined) {
      try {
        resolved[source] = credentials.decrypt(encrypted);
      } catch {
        continue;
      }
    } else {
      const environmentValue = process.env[ACADEMIC_CREDENTIAL_ENVIRONMENT[source]];
      if (environmentValue !== undefined && environmentValue.length > 0) resolved[source] = environmentValue;
    }
  }
  return resolved;
}

let mainWindow: BrowserWindow | null = null;
let stateStore: HostStateStore | null = null;
let trajectoryStore: ThreadTrajectoryStore | null = null;
let inflight: InflightTurnCoordinator | null = null;
let workerSupervisor: AgentWorkerSupervisor | null = null;
let turnExecution: HostTurnExecutionModule | null = null;
let extensionAuditWorker: ExtensionAuditWorkerExecutor | null = null;
let capabilityGateway: CapabilityGateway | null = null;
let utilityJobRunner: UtilityJobRunner | null = null;
let capabilityRegistry: CapabilityRegistry | null = null;
let projectMemories: ProjectMemoryStore | null = null;
let longTermMemories: LongTermMemoryStore | null = null;
let memoryEvolution: MemoryEvolutionStore | null = null;
let memoryCandidates: MemoryCandidateStore | null = null;
let reflectionOutcomes: ReflectionOutcomeStore | null = null;
let dreamReviews: DreamReviewStore | null = null;
let dreamCommits: DreamCommitStore | null = null;
let personalCognition: PersonalCognitionBackupService | null = null;
let executionScheduler: BoundedExecutionScheduler | null = null;
let extensionAdmission: ExtensionAdmissionManager | null = null;
let globalExtensionRevisions: GlobalExtensionRevisionManager | null = null;
let skillsDirectory: SkillPackageManager | null = null;
let skillProjector: SkillResourceProjector | null = null;
let bundledAcademicSkillsRoot: string | null = null;
let officeOrchestrator: OfficeSkillOrchestrator | null = null;
let skillCreatorWorkflow: SkillCreationWorkflow | null = null;
let pageRecoveryPipeline: PageRecoveryPipeline | null = null;
let mcpIntegration: McpIntegrationManager | null = null;
let subAgentRuntime: SubAgentRuntime | null = null;
let subAgentProviderExecutor: DesktopSubAgentProviderExecutor | null = null;
let lastPageRecoveryParse: IntegrationState["pageRecovery"]["lastParse"] | undefined;
let externalNetworkRequests = 0;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let allowQuitAfterShutdown = false;
const sequenceByThread = new Map<string, number>();
const integrationJobs = new Map<string, IntegrationJobSummary>();
const mcpActivations = new Map<string, { readonly activationId: string; readonly serverId: string; readonly schemaRevision: string; readonly toolIds: readonly string[]; readonly scope: "project" | "unscoped" }>();
let integrationJobsPath: string | undefined;
const capabilityRequests = new Map<string, { context: TurnContext; request: CapabilityExecutionRequest }>();
const pendingProjectCollisions = new Map<string, { projectId: string; existingPath: string; selectedPath: string }>();
const loadedPromptByThread = new Map<string, SystemPromptRevision>();
const materialWatchers = new Map<string, { path: string; watcher: FSWatcher; timer?: ReturnType<typeof setTimeout>; contextTimer?: ReturnType<typeof setTimeout>; memoryTimer?: ReturnType<typeof setTimeout> }>();
const credentials = new ProtectedCredentialService();
const projectIdentities = new ProjectIdentityStore();
const projectContexts = new ProjectContextStore();
const ownProjectContextWrites = new Map<string, string>();
const ownProjectMemoryWrites = new Map<string, string>();
let ownLongTermMemoryWriteHash: string | undefined;
let longTermMemoryWatcher: FSWatcher | null = null;
let longTermMemoryWatchTimer: ReturnType<typeof setTimeout> | undefined;
const projectOutputs = new ProjectOutputRegistry();

const EMPTY_RUNTIME_SKILLS: RuntimeSkillSnapshot = {
  schemaVersion: 1,
  revisionId: "skills-empty-v1",
  decisions: [],
  instructions: [],
  resources: []
};

function runtimeSkillsForTask(task: string, scope: "project" | "unscoped"): ContractRuntimeSkillSnapshot {
  const snapshot = skillProjector === null ? EMPTY_RUNTIME_SKILLS : skillProjector.project(skillProjector.resolve({ task, scope }));
  return {
    schemaVersion: 1,
    revisionId: snapshot.revisionId,
    decisions: snapshot.decisions.map((decision) => ({ ...decision, resources: [...decision.resources], capabilities: [...decision.capabilities] })),
    instructions: snapshot.instructions.map((instruction) => ({ ...instruction })),
    resources: snapshot.resources.map((resource) => ({ ...resource }))
  };
}

function skillsDoctorMessage(): { readonly status: "ready" | "attention"; readonly message: string } {
  const inventory = skillsDirectory?.inventory() ?? [];
  const active = inventory.filter((item) => item.enabled && item.state === "active");
  const office = active.filter((item) => isUserOfficeSkillPackage(item.packageId));
  const academic = active.filter((item) => BUNDLED_ACADEMIC_SKILL_IDS.some((packageId) => packageId === item.packageId));
  if (inventory.length === 0) return { status: "attention", message: "No imported Skill package is configured; the app-owned directory remains dormant." };
  return { status: "ready", message: `${inventory.length} imported Skill package(s), ${active.length} active, ${office.length} user-supplied Office package(s), ${academic.length}/${BUNDLED_ACADEMIC_SKILL_IDS.length} VC academic package(s); no package was activated by Doctor.` };
}

function skillPackageProjection(item: SkillInventoryItem): ContractSkillInventoryItem {
  return {
    ...item,
    declaredDependencies: [...item.declaredDependencies],
    files: [...item.files],
    findings: item.findings.map((finding) => ({ ...finding })),
    metadata: { ...item.metadata }
  };
}

function skillReportProjection(report: SkillCompatibilityReport): ContractSkillCompatibilityReport {
  return {
    ...report,
    package: skillPackageProjection(report.package),
    files: [...report.files],
    missingReferences: [...report.missingReferences],
    unsupportedDirectives: [...report.unsupportedDirectives],
    undeclaredExecutables: [...report.undeclaredExecutables],
    findings: report.findings.map((finding) => ({ ...finding }))
  };
}

function skillsStateEvent(correlationId: string, action: "listed" | "imported" | "bundled_installed" | "inspected" | "activated" | "disabled", selectedRevisionId?: string, report?: SkillCompatibilityReport): HostEvent {
  if (skillsDirectory === null) return diagnostic(correlationId, "HOST_FAILURE", "The Skills Directory is not initialized.");
  return {
    ...eventMetadata(correlationId),
    event: "skills.updated",
    payload: {
      root: skillsDirectory.root,
      packages: skillsDirectory.inventory().map(skillPackageProjection),
      action,
      ...(selectedRevisionId === undefined ? {} : { selectedRevisionId }),
      ...(report === undefined ? {} : { report: skillReportProjection(report) })
    }
  };
}

function officeSkillsDoctorMessage(): { readonly status: "ready" | "attention"; readonly message: string } {
  const inventory = skillsDirectory?.inventory() ?? [];
  const imported = inventory.filter((item) => isUserOfficeSkillPackage(item.packageId));
  const active = imported.filter((item) => item.enabled && item.state === "active");
  if (imported.length === 0) return { status: "attention", message: "No compatible user-supplied Office Skill package is imported; import a local package from Settings." };
  const runnerConfigured = (process.env.VC_AGENT_OFFICE_RUNNER?.trim() ?? "") !== "";
  const status = active.length === imported.length && runnerConfigured ? "ready" : "attention";
  const dependencyMessage = runnerConfigured ? "an explicit Office runner is configured" : "VC_AGENT_OFFICE_RUNNER is not configured";
  return { status, message: `${active.length}/${imported.length} imported user-supplied Office package(s) are active; ${dependencyMessage}. Runtime dependencies are checked again at explicit Skill job admission; no fallback is used.` };
}

function extensionRuntimeSnapshot(): ExtensionInventorySnapshot {
  return globalExtensionRevisions?.runtimeSnapshot() ?? { schemaVersion: 1, revisionId: "bundled-empty-v1", enabled: [] };
}

function integrationStateSnapshot(): IntegrationState {
  const officeStatus = officeSkillsDoctorMessage();
  const officeJobs = [...integrationJobs.values()].filter((job) => job.kind.startsWith("office:"));
  const creatorStatus = skillsDirectory === null ? { status: "unavailable" as const, message: "Skill Creator is unavailable in Read-only Recovery or before Host initialization." } : { status: "ready" as const, message: "Explicit Creator drafts are staged, reviewed, and handed off disabled." };
  const page = pageRecoveryPipeline?.inspectAvailability() ?? { native: { status: "unavailable" as const, message: "Native page recovery is not initialized." }, paddle: { status: "unavailable" as const, message: "PaddleOCR local runtime is not configured." }, ovis: { status: "unavailable" as const, message: "OvisOCR2 local runtime is not configured." }, policyRevision: "page-quality-v1" };
  const pageTelemetry = pageRecoveryPipeline?.telemetry() ?? { policyRevision: page.policyRevision, pageCount: 0, nativePages: 0, paddlePages: 0, ovisPages: 0, retainedEarlierPages: 0, failures: 0, durationMs: 0, lastStatus: "failed" as const };
  const mcpTelemetry = mcpIntegration?.telemetry() ?? { adapterVersion: "not-initialized", connectedServers: 0, activeTools: 0, failureCount: 0, retiredTurns: 0 };
  const activeMcpActivation = mcpActivations.values().next().value as { readonly activationId: string; readonly serverId: string; readonly schemaRevision: string; readonly toolIds: readonly string[]; readonly scope: "project" | "unscoped" } | undefined;
  const extensionState = globalExtensionRevisions?.snapshot();
  const admissionState = extensionAdmission?.snapshot();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    office: { status: officeStatus, activeSkillCount: (skillsDirectory?.inventory() ?? []).filter((item) => item.enabled && item.state === "active").length, supportedFormats: ["docx", "pptx", "xlsx", "pdf"], jobs: officeJobs },
    skillCreator: { status: creatorStatus, drafts: (skillCreatorWorkflow?.listDrafts() ?? []).map((draft) => ({ draftId: draft.draftId, packageId: draft.packageId, operation: draft.operation, state: draft.state, files: [...draft.files], dependencies: [...draft.dependencies], updatedAt: draft.updatedAt, ...(draft.failureCode === undefined ? {} : { failureCode: draft.failureCode }) })) },
    pageRecovery: { status: page.native.status === "ready" ? { status: "ready", message: "Native parsing is available; OCR stages remain explicit and local." } : { status: "attention", message: page.native.message }, availability: page, telemetry: pageTelemetry, parses: [...integrationJobs.values()].filter((job) => job.kind.startsWith("page_recovery:")), ...(lastPageRecoveryParse === undefined ? {} : { lastParse: lastPageRecoveryParse }) },
     mcp: { status: { status: "ready", message: mcpTelemetry.connectedServers === 0 ? "Pinned MCP adapter is dormant; no server connection is open." : `${mcpTelemetry.connectedServers} MCP server connection(s) are active for an explicit task.` }, adapterVersion: mcpTelemetry.adapterVersion, servers: (mcpIntegration?.inventory() ?? []).map((server) => ({ ...server, enabledToolIds: [...server.enabledToolIds], toolSchemas: server.toolSchemas.map((schema) => ({ ...schema, allowedScopes: [...schema.allowedScopes] })) })), connectedServers: mcpTelemetry.connectedServers, activeTools: mcpTelemetry.activeTools, failureCount: mcpTelemetry.failureCount, ...(activeMcpActivation === undefined ? {} : { activeActivation: { ...activeMcpActivation, toolIds: [...activeMcpActivation.toolIds] } }) },
    extensions: {
      status: { status: "ready", message: "Extension staging, inspection, audit, approval, and enablement remain separate Host actions." },
      stagedCount: admissionState?.staged.length ?? 0, inspectionCount: admissionState?.reports.length ?? 0, auditCount: admissionState?.audits.length ?? 0, approvedCount: admissionState?.approved.length ?? 0,
      effectiveRevisionId: extensionState?.effectiveRevisionId ?? "global-extension-r0", enabledCount: extensionState?.effectiveExtensions.length ?? 0,
      ...(extensionState?.pending === undefined ? {} : { pendingRevisionId: extensionState.pending.revisionId }),
      invalidatedRevisionIds: (admissionState?.approved ?? []).filter((item) => item.invalidated).map((item) => item.approvedRevisionId),
      staged: (admissionState?.staged ?? []).map((item) => ({ stagedRevisionId: item.stagedRevisionId, extensionId: item.extensionId, name: item.name, state: item.state, artifactHash: item.artifactHash, createdAt: item.createdAt })),
      reports: (admissionState?.reports ?? []).map((item) => ({ reportId: item.reportId, stagedRevisionId: item.stagedRevisionId, status: item.status, artifactHash: item.artifactHash, findingCount: item.findings.length, blockerCount: item.blockers.length, generatedAt: item.generatedAt })),
      audits: (admissionState?.audits ?? []).map((item) => ({ auditRunId: item.auditRunId, stagedRevisionId: item.stagedRevisionId, status: item.status, updatedAt: item.updatedAt, ...(item.failureCode === undefined ? {} : { failureCode: item.failureCode }) })),
      approved: (admissionState?.approved ?? []).map((item) => ({ approvedRevisionId: item.approvedRevisionId, extensionId: item.extensionId, name: item.name, version: item.version, artifactHash: item.artifactHash, enabled: item.enabled, invalidated: item.invalidated, approvedAt: item.approvedAt }))
    },
    runtime: { runningJobs: [...integrationJobs.values()].filter((job) => ["running", "queued"].includes(job.state)).length, queuedJobs: [...integrationJobs.values()].filter((job) => job.state === "queued").length, failures: [...integrationJobs.values()].filter((job) => ["failed", "unknown_outcome"].includes(job.state)).length }
  };
}

function integrationStateEvent(correlationId: string, action: "loaded" | "changed" | "recovered" = "loaded"): HostEvent {
  return { ...eventMetadata(correlationId), event: "integration.state.updated", payload: { state: integrationStateSnapshot(), action } };
}

function integrationJobEvent(correlationId: string, workflow: "office" | "skill_creator" | "page_recovery" | "mcp" | "extension", job: IntegrationJobSummary): HostEvent {
  integrationJobs.set(job.id, job);
  persistIntegrationJobs();
  return { ...eventMetadata(correlationId), event: "integration.job.updated", payload: { workflow, job } };
}

function integrationDiagnostic(correlationId: string, workflow: "office" | "skill_creator" | "page_recovery" | "mcp" | "extension", error: unknown): HostEvent {
  const code = error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : error instanceof Error ? error.message : "INTEGRATION_FAILURE";
  return { ...eventMetadata(correlationId), event: "integration.diagnostic", payload: { workflow, code: code.slice(0, 120), message: error instanceof Error ? error.message.slice(0, 1_200) : "Integration workflow failed.", recoverable: true } };
}

function officeJobProjection(planId: string, state: IntegrationJobSummary["state"], message: string, updatedAt: string): IntegrationJobSummary {
  const task = officeOrchestrator?.getTask(planId);
  const result = task?.result;
  return {
    id: planId,
    kind: `office:${task?.plan.task.kind ?? "task"}`,
    state,
    message,
    updatedAt,
    ...(result?.resultId === undefined ? {} : { resultId: result.resultId }),
    ...(task?.plan.task.sourcePath === undefined ? {} : { sourcePath: task.plan.task.sourcePath }),
    ...(result?.sourceHash === undefined && task?.plan.expectedSourceHash === undefined ? {} : { sourceHash: result?.sourceHash ?? task?.plan.expectedSourceHash! }),
    ...(result?.editedCopyHash === undefined ? {} : { editedCopyHash: result.editedCopyHash }),
    ...(result?.changeSummaryPath === undefined ? {} : { changeSummaryPath: result.changeSummaryPath }),
    ...(result?.stagedOutputPath === undefined ? {} : { stagedOutputPath: result.stagedOutputPath }),
    ...(result === undefined ? {} : { previewPaths: [...result.previewPaths] }),
    ...(task?.output?.relativePath === undefined ? {} : { committedRelativePath: task.output.relativePath }),
    ...(task?.plan.task.format === undefined ? {} : { format: task.plan.task.format }),
    ...(task?.plan.task.skillRevisionId === undefined ? {} : { skillRevisionId: task.plan.task.skillRevisionId }),
    ...(task?.plan.task.sourceReferences === undefined ? {} : { sourceReferences: [...task.plan.task.sourceReferences] })
  };
}

function loadIntegrationJobs(path: string): void {
  integrationJobsPath = path;
  if (!existsSync(path)) return;
  try {
    const records = JSON.parse(readFileSync(path, "utf8")) as IntegrationJobSummary[];
    for (const record of records) if (record?.id !== undefined && record.updatedAt !== undefined) integrationJobs.set(record.id, record.state === "running" ? { ...record, state: "interrupted", message: "Application restarted before this Integration job completed; retry is explicit." } : record);
  } catch {
    integrationJobs.clear();
  }
}

function persistIntegrationJobs(): void {
  if (integrationJobsPath === undefined) return;
  mkdirSync(dirname(integrationJobsPath), { recursive: true });
  const partial = integrationJobsPath + ".partial";
  writeFileSync(partial, JSON.stringify([...integrationJobs.values()], null, 2) + "\n", "utf8");
  renameSync(partial, integrationJobsPath);
}

app.setName("vc-agent");
app.setPath("userData", resolveVcAgentUserDataRoot(process.env, app.getPath("appData")));

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
} else {
  app.quit();
}

function nextSequence(threadId?: string): number {
  if (threadId === undefined) return 0;
  const next = (sequenceByThread.get(threadId) ?? 0) + 1;
  sequenceByThread.set(threadId, next);
  return next;
}

function eventMetadata(
  correlationId: string,
  threadId?: string,
  actor: ActorRef = HOST_ACTOR,
  provenance: ProvenanceRef = HOST_PROVENANCE
) {
  return {
    schemaVersion: IPC_SCHEMA_VERSION,
    eventId: randomUUID(),
    correlationId,
    sequence: nextSequence(threadId),
    actor,
    provenance,
    occurredAt: new Date().toISOString()
  };
}

function trajectoryMetadata(
  correlationId: string,
  threadId: string,
  turnId: string,
  actor: ActorRef,
  provenance: ProvenanceRef,
  eventId: string = randomUUID()
) {
  return {
    schemaVersion: IPC_SCHEMA_VERSION,
    eventId,
    correlationId,
    sequence: nextSequence(threadId),
    threadId,
    turnId,
    actor,
    provenance,
    occurredAt: new Date().toISOString()
  } as const;
}

function ipcMetadata(event: TrajectoryEvent) {
  const { threadId: _threadId, turnId: _turnId, ...metadata } = event;
  return metadata;
}

function diagnostic(
  correlationId: string,
  code: "UNSUPPORTED_SCHEMA_VERSION" | "INVALID_COMMAND" | "HOST_FAILURE" | "READ_ONLY_RECOVERY_MODE",
  message: string
): HostEvent {
  return { ...eventMetadata(correlationId), event: "diagnostic.raised", payload: { code, message, recoverable: true } };
}

function currentEligibleDreamTrajectory() {
  if (stateStore === null || trajectoryStore === null) return [];
  const threads = stateStore.listThreads();
  const reflectionThreadIds = new Set(stateStore.listReflectionRuns().map((run) => run.threadId));
  return selectEligibleDreamTrajectory(
    threads,
    new Map(threads.map((thread) => [thread.id, trajectoryStore!.loadEvents(thread.id)])),
    reflectionThreadIds
  );
}

function synchronizeDreamSchedulingIndex(): void {
  if (stateStore?.isReadOnlyRecovery !== false || dreamReviews === null || memoryCandidates === null) return;
  dreamReviews.synchronizeSchedulingIndex(currentEligibleDreamTrajectory(), memoryCandidates.list());
}

function resolveDreamProfile(profileId?: string): ModelProfile | undefined {
  if (stateStore === null) return undefined;
  const effectiveId = profileId ?? stateStore.getTaskModelAssignment("dream")?.profileId;
  return effectiveId === undefined ? undefined : stateStore.getModelProfile(effectiveId);
}

function resolveSubAgentProfile(input: { readonly role: "researcher" | "critic" | "synthesizer" | "writer" | "custom"; readonly requestedProfileId?: string; readonly parentThreadId?: string }): SubAgentProfileSnapshot | undefined {
  if (stateStore === null) return undefined;
  const parentThread = input.parentThreadId === undefined ? undefined : stateStore.getThread(input.parentThreadId);
  if (parentThread === undefined) return undefined;
  const roleAssignment = stateStore.getTaskModelAssignment(subAgentAssignmentTaskType(input.role))?.profileId;
  const defaultAssignment = stateStore.getTaskModelAssignment("sub_agent_default")?.profileId;
  const selectedId = input.requestedProfileId ?? roleAssignment ?? defaultAssignment ?? parentThread.activeProfileId;
  const selected = selectedId === undefined ? undefined : stateStore.getModelProfile(selectedId);
  if (selected !== undefined && parentThread.scope === "project" && !stateStore.isProjectProfileAuthorized(parentThread.projectId, selected.id)) return undefined;
  const resolutionSource = input.requestedProfileId !== undefined
    ? "explicit_override" as const
    : roleAssignment !== undefined
      ? "role_assignment" as const
      : defaultAssignment !== undefined
        ? "default_sub_agent" as const
        : "primary_active" as const;
  return selected === undefined ? undefined : {
    profileId: selected.id,
    name: selected.name,
    provider: selected.provider,
    model: selected.model,
    thinkingLevel: selected.thinkingLevel,
    ...(selected.contextWindow === undefined ? {} : { contextWindow: selected.contextWindow }),
    ...(selected.maxOutputTokens === undefined ? {} : { maxOutputTokens: selected.maxOutputTokens }),
    resolutionSource
  };
}

function subAgentAssignmentTaskType(role: SubAgentRole): TaskModelType {
  return `sub_agent_${role}` as TaskModelType;
}

async function resolveSubAgentCapability(input: SubAgentCapabilityExecutionContext): Promise<CapabilityExecutionResult> {
  const fail = (code: string, content: string, status: CapabilityExecutionResult["status"] = "rejected"): CapabilityExecutionResult => ({ schemaVersion: 1, requestId: input.request.requestId, status, code, content: content.slice(0, 20_000) });
  if (stateStore === null || capabilityGateway === null) return fail("SUB_AGENT_CAPABILITY_UNAVAILABLE", "The Host capability broker is not initialized.", "failed");
  const parentThread = stateStore.getThread(input.parentThreadId);
  if (parentThread === undefined) return fail("SUB_AGENT_PARENT_THREAD_UNAVAILABLE", "The parent Thread is no longer available.", "failed");
  if (parentThread.scope !== input.contextBoundary.scope) return fail("SUB_AGENT_SCOPE_REJECTED", "The capability request crossed the parent Sub-Agent scope boundary.");
  if (parentThread.scope === "project" && parentThread.projectId !== input.contextBoundary.projectId) return fail("SUB_AGENT_SCOPE_REJECTED", "The capability request crossed the parent Project boundary.");
  const activeCapabilityIds = providerCapabilityIds(input.capabilitySet, input.contextBoundary.scope);
  if (!activeCapabilityIds.includes(input.request.capabilityId)) return fail("SUB_AGENT_CAPABILITY_NOT_ALLOWED", "This capability was not authorized for the Sub-Agent task.");
  const request: CapabilityExecutionRequest = {
    ...input.request,
    expectedStateVersion: parentThread.stateVersion,
    actor: { actorType: "sub_agent", actorId: input.taskId, parentActorId: "primary-agent" },
    provenance: { producerType: "sub_agent", producerId: input.taskId }
  };
  const outputLocation = parentThread.scope === "project"
    ? (() => { const project = stateStore!.getProject(parentThread.projectId); return project === undefined ? undefined : join(project.path, "outputs"); })()
    : input.contextBoundary.outputRoot ?? parentThread.outputLocation;
  const decision = await capabilityGateway.request(request, {
    accessMode: stateStore.getAccessMode(),
    scope: input.contextBoundary.scope,
    stateVersion: parentThread.stateVersion,
    activeCapabilityIds,
    outputIntent: input.capabilitySet.includes("write_output"),
    ...(outputLocation === undefined ? {} : { outputLocation })
  });
  if (decision.type === "confirmation_required") return fail("SUB_AGENT_CONFIRMATION_REQUIRED", "This capability requires an interactive parent confirmation and was not executed.");
  let result = decision.result;
  if (result.artifact !== undefined && result.status === "completed") {
    try {
      // The provider Worker uses an isolated synthetic Thread/Turn for model
      // execution. Artifacts are owned by the parent Thread, however: the
      // persistence layer enforces a foreign key to persisted threads. Keep
      // the Sub-Agent producer/capability request provenance while projecting
      // the source to the parent conversation before registration.
      const registeredArtifact: ArtifactRecord = {
        ...result.artifact,
        source: {
          ...result.artifact.source,
          threadId: input.parentThreadId,
          turnId: input.parentTurnId
        }
      };
      stateStore.recordArtifact(registeredArtifact);
      result = { ...result, artifact: registeredArtifact };
      if (parentThread.scope === "project") {
        const project = stateStore.getProject(parentThread.projectId);
        if (project === undefined) throw new Error("Project not found");
        const projectOutput = projectOutputs.record({
          projectId: project.id,
          projectPath: project.path,
          artifact: registeredArtifact,
          profile: { id: input.profile.profileId, provider: input.profile.provider, model: input.profile.model },
          capabilityId: request.capabilityId,
          ...(typeof request.arguments.skillId === "string" ? { skillId: request.arguments.skillId } : {}),
          sourceReferences: Array.isArray(request.arguments.sourceReferences) ? request.arguments.sourceReferences.filter((value): value is string => typeof value === "string") : [],
          warnings: Array.isArray(request.arguments.warnings) ? request.arguments.warnings.filter((value): value is string => typeof value === "string") : [],
          relatedArtifacts: Array.isArray(request.arguments.relatedArtifacts) ? request.arguments.relatedArtifacts.flatMap((value) => { const parsed = zRelatedArtifact(value); return parsed === undefined ? [] : [parsed]; }) : []
        });
        emit({ ...eventMetadata(request.correlationId, input.parentThreadId), event: "project.outputs.updated", payload: { projectId: projectOutput.projectId, outputs: projectOutputs.list(projectOutput.projectId, project.path) } });
      }
    } catch {
      result = { schemaVersion: 1, requestId: result.requestId, status: "unknown_outcome", code: "ARTIFACT_COMMIT_UNKNOWN", content: "The Sub-Agent file write completed but Output registration could not be confirmed." };
    }
  }
  return result;
}

async function resolveSubAgentContextReference(input: { readonly referenceId: string; readonly boundary: SubAgentContextBoundary }): Promise<{ readonly source: string; readonly content: string } | undefined> {
  if (input.boundary.scope !== "project" || input.boundary.projectId === undefined || stateStore === null) return undefined;
  const project = stateStore.getProject(input.boundary.projectId);
  if (project === undefined) return undefined;
  if (input.referenceId.startsWith("project-context:")) {
    const sectionId = input.referenceId.slice("project-context:".length).split("@")[0];
    const document = projectContexts.load(project.id, project.path, false);
    const section = document?.sections.find((candidate) => candidate.id === sectionId || candidate.title === sectionId);
    return section === undefined ? undefined : { source: `project-context:${section.id}`, content: `${section.title}\n${section.content}` };
  }
  if (!input.referenceId.startsWith("material:")) return undefined;
  const reference = input.referenceId.slice("material:".length);
  const [materialId, blockPart] = reference.split("/block:", 2);
  const material = stateStore.listMaterials(project.id).find((candidate) => candidate.id === materialId);
  if (material === undefined || material.availability !== "active") return undefined;
  let parsed = stateStore.getCurrentParsedMaterial(material.id);
  if (parsed === undefined) {
    const parsedEvent = await parseMaterial(`sub-agent-context:${material.id}`, material.id);
    if (parsedEvent.event !== "material.parse.completed") return undefined;
    parsed = stateStore.getCurrentParsedMaterial(material.id);
  }
  if (parsed === undefined) return undefined;
  try {
    const canonical = canonicalParseSchema.parse(JSON.parse(readFileSync(join(project.path, parsed.artifact_path), "utf8")));
    const blocks = blockPart === undefined ? canonical.blocks : canonical.blocks.filter((block) => block.id === blockPart);
    const content = blocks.map((block) => block.rows === undefined ? block.text ?? "" : block.rows.map((row) => row.join(" | ")).join("\n")).filter(Boolean).join("\n\n");
    return content.length === 0 ? undefined : { source: `material:${material.id}`, content };
  } catch {
    return undefined;
  }
}

function subAgentHostEvent(event: SubAgentRuntimeEvent): HostEvent {
  const correlationId = event.projection.run.parentTurnId;
  const metadata = eventMetadata(correlationId, event.projection.run.parentThreadId);
  if (event.event === "sub_agent.attempt.created") {
    if (event.attempt === undefined) throw new Error("SUB_AGENT_ATTEMPT_EVENT_INVALID");
    return { ...metadata, event: "sub_agent.attempt.created", payload: { projection: event.projection, attempt: event.attempt } };
  }
  if (event.event === "sub_agent.budget.exhausted") {
    return { ...metadata, event: "sub_agent.budget.exhausted", payload: { projection: event.projection, remainingTokens: event.remainingTokens ?? 0 } };
  }
  const { task, attempt } = event;
  return { ...metadata, event: event.event, payload: { projection: event.projection, ...(task === undefined ? {} : { task }), ...(attempt === undefined ? {} : { attempt }) } } as HostEvent;
}

function toDreamProfileSnapshot(profile: ModelProfile): DreamProfileSnapshot {
  return { id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, thinkingLevel: profile.thinkingLevel };
}

function dreamStateEvent(correlationId: string): HostEvent {
  if (dreamReviews === null) return diagnostic(correlationId, "HOST_FAILURE", "Dream review state is unavailable.");
  if (stateStore?.isReadOnlyRecovery === false && projectMemories !== null) dreamReviews.revalidateProjectMemory(currentProjectMemoryHashes());
  if (stateStore?.isReadOnlyRecovery === false) revalidateDreamSynthesis();
  const profile = resolveDreamProfile();
  const dueProposal = dreamReviews.dueCheck(profile === undefined ? undefined : toDreamProfileSnapshot(profile));
  const reminder = dreamReviews.pendingReminder();
  return {
    ...eventMetadata(correlationId),
    event: "dream.state.updated",
    payload: {
      state: dreamReviews.load(),
      ...(dueProposal === undefined ? {} : { dueProposal }),
      ...(reminder === undefined ? {} : { reminder })
    }
  };
}

function revalidateDreamSynthesis(): void {
  if (dreamReviews === null || longTermMemories === null) return;
  const state = dreamReviews.load();
  const batch = state.batches.find((item) => item.id === state.schedule.activeBatchId);
  if (batch?.synthesis === undefined || batch.synthesis.status === "stale" || (batch.status === "running" && batch.currentStage === "global_synthesis")) return;
  const memory = longTermMemories.load(false);
  if (memory === undefined) { dreamReviews.markSynthesisStale(batch.id); return; }
  const input = buildDreamSynthesisInput(batch, memory);
  if (dreamSynthesisInputHash(input) !== batch.synthesis.inputHash || memory.sourceHash !== batch.synthesis.longTermMemoryHash) dreamReviews.markSynthesisStale(batch.id);
}

function currentProjectMemoryHashes(): Record<string, string | undefined> {
  if (stateStore === null || projectMemories === null) return {};
  return Object.fromEntries(stateStore.listProjects().map((project) => [project.id, projectMemories!.load(project.id, project.path, false)?.sourceHash]));
}

function startDreamScopeExtraction(correlationId: string, batchId: string, scopeId: string): HostEvent {
  if (dreamReviews === null || projectMemories === null) return diagnostic(correlationId, "HOST_FAILURE", "Dream is unavailable in read-only recovery.");
  if (!executionScheduler!.hasCapacity()) return executionCapacityDiagnostic(correlationId, "Dream scope extraction");
  const batch = dreamReviews.load().batches.find((item) => item.id === batchId);
  const existingScope = batch?.extractionScopes.find((item) => item.id === scopeId);
  if (batch === undefined || existingScope === undefined) return diagnostic(correlationId, "HOST_FAILURE", "Dream extraction scope was not found.");
  const profile = stateStore!.getModelProfile(batch.profileSnapshot.id);
  if (profile === undefined || profile.provider !== batch.profileSnapshot.provider || profile.model !== batch.profileSnapshot.model) {
    return diagnostic(correlationId, "HOST_FAILURE", "The frozen Dream Model Profile is unavailable or changed. No fallback was selected.");
  }
  const promptRevision = stateStore!.getSystemPromptRevision(batch.promptSnapshot.revisionId);
  if (promptRevision?.hash !== batch.promptSnapshot.hash) return diagnostic(correlationId, "HOST_FAILURE", "The frozen Dream Prompt Snapshot is unavailable.");
  const encrypted = stateStore!.getEncryptedCredential(profile.credentialRef);
  if (encrypted === undefined) return diagnostic(correlationId, "HOST_FAILURE", "The frozen Dream credential is unavailable.");
  const project = existingScope.kind === "project" ? stateStore!.getProject(existingScope.projectId!) : undefined;
  if (existingScope.kind === "project" && project === undefined) return diagnostic(correlationId, "HOST_FAILURE", "The Dream Project scope is unavailable.");
  const projectMemory = existingScope.kind === "project" ? projectMemories.load(existingScope.projectId!, project!.path, false) : undefined;
  const executionThreadId = `dream-${batch.id}-${existingScope.id.replace(/[^a-z0-9-]/giu, "-")}`;
  const turnId = randomUUID();
  const admission = executionScheduler!.admit({ id: turnId, scopeKey: executionThreadId, kind: "dream_scope" });
  if (!admission.admitted) return executionCapacityDiagnostic(correlationId, "Dream scope extraction");
  let scope: DreamExtractionScope;
  try {
    scope = dreamReviews.startScope(batch.id, existingScope.id, projectMemory?.sourceHash);
  } catch (error) {
    executionScheduler!.release(turnId);
    return diagnostic(correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Dream extraction scope could not start.");
  }
  const currentBatch = dreamReviews.load().batches.find((item) => item.id === batch.id)!;
  const extractionContext = buildDreamScopeExtractionContext(currentBatch, scope, projectMemory);
  const prompt = buildDreamScopeExtractionPrompt(extractionContext);
  const context: DreamExecutionContext = { correlationId, batchId: batch.id, scope, executionThreadId, turnId, profile, allowedSourceReferences: [...scope.sourceReferences, ...(extractionContext.projectMemory?.map((entry) => entry.sourceReference) ?? [])] };
  if (scope.kind === "project") stateStore!.authorizeProjectProfile(scope.projectId!, profile.id, profile.provider);
  const workerCommand: Extract<WorkerCommand, { command: "turn.execute" }> = {
    schemaVersion: 1, command: "turn.execute", commandId: randomUUID(), correlationId, threadId: executionThreadId, turnId,
    cwd: project?.path ?? app.getPath("userData"),
    threadDirectory: join(app.getPath("userData"), "memory", "dream", "scope-work", batch.id, scope.id.replace(/[^a-z0-9-]/giu, "-")),
    contextHistory: [],
    estimatedInputTokens: estimateTokens(promptRevision.content) + estimateTokens(DREAM_EXTRACTION_STAGE_INSTRUCTIONS) + estimateTokens(prompt),
    currentInputTokens: estimateTokens(promptRevision.content) + estimateTokens(DREAM_EXTRACTION_STAGE_INSTRUCTIONS) + estimateTokens(prompt),
    activeCapabilities: [], expectedStateVersion: 1,
    executionScope: scope.kind === "project" ? { kind: "project", projectId: scope.projectId! } : { kind: "unscoped", threadId: executionThreadId },
    prompt,
    profile: toWorkerModelProfile(profile, credentials.decrypt(encrypted)),
    resources: { schemaVersion: 1, revisionId: promptRevision.id, systemPrompt: promptRevision.content, appendSystemPrompt: [DREAM_EXTRACTION_STAGE_INSTRUCTIONS] },
    extensions: extensionRuntimeSnapshot()
  };
  turnExecution!.start({ kind: "dream", context }, workerCommand, () => failDreamExecution(context, { kind: "worker", code: "WORKER_EXITED", message: "Agent Worker exited before Dream scope extraction completed.", provider: profile.provider, model: profile.model }));
  return dreamStateEvent(correlationId);
}

function startDreamGlobalSynthesis(correlationId: string, batchId: string): HostEvent {
  if (dreamReviews === null || longTermMemories === null) return diagnostic(correlationId, "HOST_FAILURE", "Dream is unavailable in read-only recovery.");
  if (!executionScheduler!.hasCapacity()) return executionCapacityDiagnostic(correlationId, "Global Dream Synthesis");
  revalidateDreamSynthesis();
  let batch = dreamReviews.load().batches.find((item) => item.id === batchId);
  if (batch === undefined) return diagnostic(correlationId, "HOST_FAILURE", "Dream batch was not found.");
  if (batch.preparedPatch?.status === "stale") {
    try { dreamCommits?.discard(batch.id, batch.preparedPatch.id); } catch { /* A missing stale preview cannot authorize a commit. */ }
  }
  const profile = stateStore!.getModelProfile(batch.profileSnapshot.id);
  if (profile === undefined || profile.provider !== batch.profileSnapshot.provider || profile.model !== batch.profileSnapshot.model) return diagnostic(correlationId, "HOST_FAILURE", "The frozen Dream Model Profile is unavailable or changed. No fallback was selected.");
  const promptRevision = stateStore!.getSystemPromptRevision(batch.promptSnapshot.revisionId);
  if (promptRevision?.hash !== batch.promptSnapshot.hash) return diagnostic(correlationId, "HOST_FAILURE", "The frozen Dream Prompt Snapshot is unavailable.");
  const encrypted = stateStore!.getEncryptedCredential(profile.credentialRef);
  if (encrypted === undefined) return diagnostic(correlationId, "HOST_FAILURE", "The frozen Dream credential is unavailable.");
  const memory = longTermMemories.load(true)!;
  const input = buildDreamSynthesisInput(batch, memory);
  const forbiddenTerms = batch.extractionScopes.flatMap((scope) => {
    if (scope.kind !== "project") return [];
    const project = stateStore!.getProject(scope.projectId!);
    return project === undefined ? [] : [project.displayName, basename(project.path)];
  });
  const executionThreadId = `dream-synthesis-${batch.id}`;
  const turnId = randomUUID();
  const admission = executionScheduler!.admit({ id: turnId, scopeKey: executionThreadId, kind: "dream_synthesis" });
  if (!admission.admitted) return executionCapacityDiagnostic(correlationId, "Global Dream Synthesis");
  try { batch = dreamReviews.beginSynthesis(batch.id); }
  catch (error) {
    executionScheduler!.release(turnId);
    return diagnostic(correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Global Dream Synthesis could not start.");
  }
  const prompt = buildDreamGlobalSynthesisPrompt(input);
  const context: DreamSynthesisExecutionContext = { correlationId, batchId: batch.id, executionThreadId, turnId, profile, input, forbiddenTerms };
  const workerCommand: Extract<WorkerCommand, { command: "turn.execute" }> = {
    schemaVersion: 1, command: "turn.execute", commandId: randomUUID(), correlationId, threadId: executionThreadId, turnId,
    cwd: app.getPath("userData"), threadDirectory: join(app.getPath("userData"), "memory", "dream", "synthesis-work", batch.id), contextHistory: [],
    estimatedInputTokens: estimateTokens(promptRevision.content) + estimateTokens(DREAM_GLOBAL_SYNTHESIS_INSTRUCTIONS) + estimateTokens(prompt),
    currentInputTokens: estimateTokens(promptRevision.content) + estimateTokens(DREAM_GLOBAL_SYNTHESIS_INSTRUCTIONS) + estimateTokens(prompt),
    activeCapabilities: [], expectedStateVersion: 1, executionScope: { kind: "unscoped", threadId: executionThreadId }, prompt,
    profile: toWorkerModelProfile(profile, credentials.decrypt(encrypted)),
    resources: { schemaVersion: 1, revisionId: promptRevision.id, systemPrompt: promptRevision.content, appendSystemPrompt: [DREAM_GLOBAL_SYNTHESIS_INSTRUCTIONS] },
    extensions: extensionRuntimeSnapshot()
  };
  turnExecution!.start({ kind: "dream_synthesis", context }, workerCommand, () => failDreamSynthesisExecution(context, { kind: "worker", code: "WORKER_EXITED", message: "Agent Worker exited before Global Dream Synthesis completed.", provider: profile.provider, model: profile.model }));
  return dreamStateEvent(correlationId);
}

async function handleCommand(event: IpcMainInvokeEvent, rawCommand: unknown): Promise<HostEvent> {
  const correlationId = readString(rawCommand, "correlationId") ?? randomUUID();
  const rawVersion = readValue(rawCommand, "schemaVersion");
  if (rawVersion !== IPC_SCHEMA_VERSION) {
    const result = diagnostic(correlationId, "UNSUPPORTED_SCHEMA_VERSION", `Unsupported IPC schema version: ${String(rawVersion)}`);
    event.sender.send(EVENT_CHANNEL, result);
    return result;
  }
  const parsed = hostCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    const result = diagnostic(correlationId, "INVALID_COMMAND", "The Host rejected an invalid command envelope.");
    event.sender.send(EVENT_CHANNEL, result);
    return result;
  }
  if (stateStore === null || workerSupervisor === null) {
    return diagnostic(correlationId, "HOST_FAILURE", "The local Host is not initialized.");
  }

  try {
    const command = parsed.data;
    if (stateStore.isReadOnlyRecovery && !READ_ONLY_RECOVERY_COMMANDS.has(command.command)) {
      return diagnostic(command.correlationId, "READ_ONLY_RECOVERY_MODE", "This action is unavailable while local state is open in Read-only Recovery.");
    }
    if (trajectoryStore === null || inflight === null || capabilityGateway === null) {
      return diagnostic(correlationId, "HOST_FAILURE", "The local Host is not initialized.");
    }
    switch (command.command) {
      case "app.bootstrap": {
        const profileCount = stateStore.listModelProfiles().length;
        const preparation = stateStore.statePreparation;
        const recovery = preparation.mode === "read_only_recovery";
        return {
          ...eventMetadata(command.correlationId),
          event: "app.bootstrap.completed",
          payload: {
            ...stateStore.getBootstrapState(app.getVersion(), { ...workerSupervisor.activity, externalNetworkRequests }),
            piProviders: [...PI_BUILTIN_PROVIDER_IDS],
            executionScheduler: executionSchedulerTelemetry(),
            environmentDoctor: {
              pi: recovery ? { status: "unavailable", message: "Pi execution is disabled in Read-only Recovery." } : { status: "ready", message: "Bundled Pi SDK is available." },
              provider: profileCount > 0 ? { status: "ready", message: `${profileCount} Model Profile reference(s) configured.` } : { status: "attention", message: "No Model Profile is configured." },
              parser: { status: "ready", message: `${BASELINE_PARSER_ADAPTERS.length} baseline parser adapter(s) available.` },
              credentialReference: { status: "ready", message: "Protected local credential references are available." },
              storage: recovery ? { status: "attention", message: "Local state is open for inspection only." } : { status: "ready", message: "Local state storage is writable." },
              migration: {
                status: recovery ? "attention" : "ready",
                message: `State ${preparation.storedVersion}; supported ${preparation.supportedVersion}; ${preparation.status}; rollback ${preparation.rollbackAvailable ? "available" : "unavailable"}.`
              },
              bundledExtensions: { status: "ready", message: "Reviewed bundled Extension inventory loaded." },
              scheduler: { status: "ready", message: `Bounded capacity ${EXECUTION_CAPACITY}; no integration resource was activated by Doctor.` },
              agentRuntime: { status: recovery ? "unavailable" : "ready", message: recovery ? "Agent Workers are disabled in Read-only Recovery." : "Project and Unscoped Worker supervision is available." },
              utilityRuntime: { status: recovery ? "unavailable" : "ready", message: recovery ? "Utility jobs are disabled in Read-only Recovery." : "Utility runtime is available for bounded local jobs." },
              isolatedRuntime: { status: recovery ? "unavailable" : "ready", message: recovery ? "Isolated jobs are disabled in Read-only Recovery." : "Isolated runtime is dormant until an explicit task." },
              skills: recovery ? { status: "attention", message: "Skills are disabled in Read-only Recovery." } : skillsDoctorMessage(),
              office: recovery ? { status: "attention", message: "Office Skills are unavailable in Read-only Recovery." } : officeSkillsDoctorMessage(),
              ocr: { status: "attention", message: "Local page recovery dependencies are checked only when configured." },
              mcp: { status: "ready", message: "Pinned MCP adapter is lazy; no server connection was opened." },
              extensionRevision: { status: "ready", message: "Global Extension revision is dormant; no code was loaded by Doctor." },
              backup: { status: "ready", message: "Personal Cognition Backup is local and credential-free." }
            }
          }
        };
      }
      case "state.recovery.export": {
        if (!stateStore.isReadOnlyRecovery) return diagnostic(command.correlationId, "INVALID_COMMAND", "Raw state export is available only in Read-only Recovery.");
        const selection = await dialog.showOpenDialog({ title: "Export raw recovery state", properties: ["openDirectory", "createDirectory"] });
        if (selection.canceled || selection.filePaths[0] === undefined) {
          return { ...eventMetadata(command.correlationId), event: "state.recovery.export.completed", payload: { status: "canceled", fileCount: 0 } };
        }
        const preparation = stateStore.statePreparation;
        const destination = join(selection.filePaths[0], `vc-agent-raw-state-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`);
        const source = join(app.getPath("userData"), "state.db");
        const files = exportRawStateBundle(source, destination, preparation);
        return { ...eventMetadata(command.correlationId), event: "state.recovery.export.completed", payload: { status: "exported", destination, fileCount: files.length } };
      }
      case "personal_cognition.backup.create": {
        if (command.actor.actorType !== "user" || personalCognition === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Personal Cognition Backup requires explicit User action.");
        let parent = process.env.VC_AGENT_TEST_BACKUP_DESTINATION;
        if (parent === undefined) {
          const selection = await dialog.showOpenDialog({ title: "Choose Personal Cognition Backup destination", properties: ["openDirectory", "createDirectory"] });
          parent = selection.canceled ? undefined : selection.filePaths[0];
        }
        if (parent === undefined) return { ...eventMetadata(command.correlationId), event: "personal_cognition.operation.completed", payload: { operation: "backup", status: "canceled", fileCount: 0, requiresCredentialSetup: false } };
        const destination = join(parent, `vc-agent-personal-cognition-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`);
        const manifest = personalCognition.create(destination);
        return { ...eventMetadata(command.correlationId), event: "personal_cognition.operation.completed", payload: { operation: "backup", status: "completed", path: destination, fileCount: manifest.files.length, requiresCredentialSetup: false } };
      }
      case "personal_cognition.restore": {
        if (command.actor.actorType !== "user" || personalCognition === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Personal Cognition Restore requires explicit User action.");
        let source = process.env.VC_AGENT_TEST_RESTORE_SOURCE;
        if (source === undefined) {
          const selection = await dialog.showOpenDialog({ title: "Select Personal Cognition Backup", properties: ["openDirectory"] });
          source = selection.canceled ? undefined : selection.filePaths[0];
        }
        if (source === undefined) return { ...eventMetadata(command.correlationId), event: "personal_cognition.operation.completed", payload: { operation: "restore", status: "canceled", fileCount: 0, requiresCredentialSetup: false } };
        const preview = personalCognition.inspect(source);
        let confirmed = process.env.VC_AGENT_TEST_CONFIRM_RESTORE === "1";
        if (!confirmed) {
          const choice = await dialog.showMessageBox({ type: "warning", buttons: ["Cancel", "Replace Personal Cognition"], defaultId: 0, cancelId: 0, title: "Replace Personal Cognition?", message: "This replaces all supported personal cognition domains.", detail: "The bundle is validated first. Project data and credentials are not restored. Model Profiles will require fresh credential setup." });
          confirmed = choice.response === 1;
        }
        if (!confirmed) return { ...eventMetadata(command.correlationId), event: "personal_cognition.operation.completed", payload: { operation: "restore", status: "canceled", path: source, fileCount: preview.manifest.files.length, requiresCredentialSetup: preview.requiresCredentialSetup } };
        personalCognition.restore(source, true);
        loadedPromptByThread.clear();
        longTermMemories?.refreshIfExists();
        return { ...eventMetadata(command.correlationId), event: "personal_cognition.operation.completed", payload: { operation: "restore", status: "completed", path: source, fileCount: preview.manifest.files.length, requiresCredentialSetup: preview.requiresCredentialSetup } };
      }
      case "access.mode.set":
        stateStore.setAccessMode(command.payload.mode);
        return { ...eventMetadata(command.correlationId), event: "access.mode.changed", payload: { mode: command.payload.mode } };
      case "profile.list":
        return { ...eventMetadata(command.correlationId), event: "profiles.listed", payload: { profiles: stateStore.listModelProfiles() } };
      case "academic.credentials.list":
        return { ...eventMetadata(command.correlationId), event: "academic.credentials.updated", payload: { credentials: stateStore.listAcademicCredentialStatuses(), action: "listed" } };
      case "skills.list":
        return skillsStateEvent(command.correlationId, "listed");
      case "skills.import": {
        if (command.actor.actorType !== "user" || skillsDirectory === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Skill import requires explicit User action and an initialized Skills Directory.");
        let sourceDirectory = process.env.VC_AGENT_TEST_SKILL_SOURCE;
        if (sourceDirectory === undefined) {
          const selection = await dialog.showOpenDialog(mainWindow!, { title: "Import Skill Package", properties: ["openDirectory"] });
          sourceDirectory = selection.canceled ? undefined : selection.filePaths[0];
        }
        if (sourceDirectory === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Skill import was canceled.");
        const imported = await skillsDirectory.importLocalDirectory({ sourceDirectory });
        return skillsStateEvent(command.correlationId, "imported", imported.package.revisionId);
      }
      case "skills.academic.install": {
        if (command.actor.actorType !== "user" || skillsDirectory === null || bundledAcademicSkillsRoot === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Bundled academic Skill installation requires explicit User action and an initialized Skills Directory.");
        await installBundledAcademicSkills({ manager: skillsDirectory, sourceRoot: bundledAcademicSkillsRoot });
        return skillsStateEvent(command.correlationId, "bundled_installed");
      }
      case "skills.inspect": {
        if (skillsDirectory === null) return diagnostic(command.correlationId, "HOST_FAILURE", "The Skills Directory is not initialized.");
        const report = await skillsDirectory.inspect(command.payload.revisionId);
        return skillsStateEvent(command.correlationId, "inspected", command.payload.revisionId, report);
      }
      case "skills.activate": {
        if (command.actor.actorType !== "user" || skillsDirectory === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Skill activation requires explicit User action and an initialized Skills Directory.");
        await skillsDirectory.activate(command.payload.revisionId);
        return skillsStateEvent(command.correlationId, "activated", command.payload.revisionId);
      }
      case "skills.disable": {
        if (command.actor.actorType !== "user" || skillsDirectory === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Skill disable requires explicit User action and an initialized Skills Directory.");
        const disabled = await skillsDirectory.disable(command.payload.packageId);
        return skillsStateEvent(command.correlationId, "disabled", disabled.revisionId);
      }
      case "integration.state.load":
        return integrationStateEvent(command.correlationId, "loaded");
      case "office.source.choose": {
        const testSourcePath = process.env.NODE_ENV === "test" ? process.env.VC_AGENT_TEST_OFFICE_SOURCE_PATH : undefined;
        if (testSourcePath !== undefined && testSourcePath !== "") {
          return { ...eventMetadata(command.correlationId), event: "office.source.selected", payload: { canceled: false, path: resolve(testSourcePath) } };
        }
        const selection = await dialog.showOpenDialog({
          title: `Choose ${command.payload.format.toUpperCase()} source`,
          properties: ["openFile"],
          filters: [{ name: command.payload.format.toUpperCase(), extensions: [command.payload.format] }]
        });
        return { ...eventMetadata(command.correlationId), event: "office.source.selected", payload: { canceled: selection.canceled || selection.filePaths[0] === undefined, ...(selection.filePaths[0] === undefined ? {} : { path: selection.filePaths[0] }) } };
      }
      case "office.task.prepare": {
        if (command.actor.actorType !== "user" || officeOrchestrator === null) return integrationDiagnostic(command.correlationId, "office", new Error("OFFICE_INTEGRATION_UNAVAILABLE"));
        try {
          const { outputFileName, sourcePath, sourceReferences, renderPreview, ...officeFields } = command.payload;
          const plan = await officeOrchestrator.prepare({ ...officeFields, ...(outputFileName === undefined ? {} : { outputFileName }), ...(sourcePath === undefined ? {} : { sourcePath }), ...(sourceReferences === undefined ? {} : { sourceReferences }), ...(renderPreview === undefined ? {} : { renderPreview }) });
          emit(integrationJobEvent(command.correlationId, "office", officeJobProjection(plan.planId, "pending", "Office task is prepared and awaits explicit Run.", new Date().toISOString())));
          return integrationStateEvent(command.correlationId, "changed");
        } catch (error) { return integrationDiagnostic(command.correlationId, "office", error); }
      }
      case "office.task.run": {
        if (command.actor.actorType !== "user" || officeOrchestrator === null) return integrationDiagnostic(command.correlationId, "office", new Error("OFFICE_INTEGRATION_UNAVAILABLE"));
        const task = officeOrchestrator.getTask(command.payload.planId);
        if (task === undefined) return integrationDiagnostic(command.correlationId, "office", new Error("OFFICE_JOB_REJECTED"));
        emit(integrationJobEvent(command.correlationId, "office", officeJobProjection(task.plan.planId, "running", "Office Skill job is running in the isolated local adapter.", new Date().toISOString())));
        try {
          const result = await officeOrchestrator.execute(command.payload.planId);
          const state = result.status === "validated" ? "completed" : result.status === "cancelled" ? "interrupted" : result.status === "timed_out" ? "failed" : "failed";
          emit(integrationJobEvent(command.correlationId, "office", officeJobProjection(task.plan.planId, state, result.status === "validated" ? "Validated staged Office result is ready for review." : `Office task ended as ${result.status}.`, new Date().toISOString())));
          return integrationStateEvent(command.correlationId, "changed");
        } catch (error) { emit(integrationJobEvent(command.correlationId, "office", officeJobProjection(task.plan.planId, "failed", error instanceof Error ? error.message : "Office task failed.", new Date().toISOString()))); return integrationDiagnostic(command.correlationId, "office", error); }
      }
      case "office.task.cancel": {
        if (command.actor.actorType !== "user" || officeOrchestrator === null) return integrationDiagnostic(command.correlationId, "office", new Error("OFFICE_INTEGRATION_UNAVAILABLE"));
        try {
          const cancellation = await officeOrchestrator.cancel(command.payload.jobId);
          const task = officeOrchestrator.getTask(command.payload.jobId);
          if (cancellation.status === "cancelled" && task !== undefined) emit(integrationJobEvent(command.correlationId, "office", officeJobProjection(task.plan.planId, "interrupted", "Office task was cancelled before its result was committed.", new Date().toISOString())));
          return integrationStateEvent(command.correlationId, "changed");
        }
        catch (error) { return integrationDiagnostic(command.correlationId, "office", error); }
      }
      case "office.result.commit": {
        if (command.actor.actorType !== "user" || officeOrchestrator === null) return integrationDiagnostic(command.correlationId, "office", new Error("OFFICE_INTEGRATION_UNAVAILABLE"));
        try { const output = await officeOrchestrator.commit(command.payload.resultId); const result = officeOrchestrator.getResult(command.payload.resultId); if (result !== undefined) emit(integrationJobEvent(command.correlationId, "office", officeJobProjection(result.plan.planId, "completed", `Output committed to ${output.relativePath}; provenance retained.`, new Date().toISOString()))); return integrationStateEvent(command.correlationId, "changed"); }
        catch (error) { return integrationDiagnostic(command.correlationId, "office", error); }
      }
      case "office.source.replace": {
        if (command.actor.actorType !== "user" || officeOrchestrator === null) return integrationDiagnostic(command.correlationId, "office", new Error("OFFICE_INTEGRATION_UNAVAILABLE"));
        try {
          const result = await officeOrchestrator.replaceOriginal(command.payload as Parameters<OfficeSkillOrchestrator["replaceOriginal"]>[0]);
          const state = result.status === "unknown_outcome" ? "unknown_outcome" : result.status === "replaced" ? "completed" : result.status === "confirmation_required" ? "pending" : "failed";
          const stored = officeOrchestrator.getResult(command.payload.resultId);
          emit(integrationJobEvent(command.correlationId, "office", stored === undefined ? { id: command.payload.resultId, kind: "office:replace", state, message: `Original replacement ${result.status}.`, updatedAt: new Date().toISOString() } : officeJobProjection(stored.plan.planId, state, `Original replacement ${result.status}.`, new Date().toISOString())));
          return integrationStateEvent(command.correlationId, "changed");
        } catch (error) { return integrationDiagnostic(command.correlationId, "office", error); }
      }
      case "skill_creator.list":
        return integrationStateEvent(command.correlationId, "loaded");
      case "skill_creator.prepare": {
        if (command.actor.actorType !== "user" || skillCreatorWorkflow === null) return integrationDiagnostic(command.correlationId, "skill_creator", new Error("SKILL_CREATOR_UNAVAILABLE"));
        try {
          const draft = command.payload.operation === "create"
            ? await skillCreatorWorkflow.createDraft({ explicitIntent: true, packageId: command.payload.packageId, files: command.payload.files, ...(command.payload.dependencies === undefined ? {} : { dependencies: command.payload.dependencies }) })
            : command.payload.targetRevisionId === undefined
              ? (() => { throw new Error("SKILL_DRAFT_STALE"); })()
              : await skillCreatorWorkflow.updateDraft({ explicitIntent: true, packageId: command.payload.packageId, targetRevisionId: command.payload.targetRevisionId, files: command.payload.files, ...(command.payload.dependencies === undefined ? {} : { dependencies: command.payload.dependencies }), ...(command.payload.draftId === undefined ? {} : { draftId: command.payload.draftId }) });
          emit(integrationJobEvent(command.correlationId, "skill_creator", { id: draft.draftId, kind: `skill_creator:${draft.operation}`, state: draft.state === "draft_ready" ? "completed" : draft.state === "running" ? "running" : "failed", message: `Skill Creator draft is ${draft.state}.`, updatedAt: draft.updatedAt }));
          return integrationStateEvent(command.correlationId, "changed");
        } catch (error) { return integrationDiagnostic(command.correlationId, "skill_creator", error); }
      }
      case "skill_creator.review": {
        if (skillCreatorWorkflow === null) return integrationDiagnostic(command.correlationId, "skill_creator", new Error("SKILL_CREATOR_UNAVAILABLE"));
        try { const review = await skillCreatorWorkflow.review(command.payload.draftId); emit(integrationJobEvent(command.correlationId, "skill_creator", { id: review.draft.draftId, kind: `skill_creator:${review.draft.operation}`, state: review.status === "reviewable" ? "completed" : "failed", message: review.status === "reviewable" ? "Draft diff and compatibility review are ready." : "Draft is stale and needs explicit refresh.", updatedAt: review.draft.updatedAt })); return integrationStateEvent(command.correlationId, "changed"); }
        catch (error) { return integrationDiagnostic(command.correlationId, "skill_creator", error); }
      }
      case "skill_creator.handoff": {
        if (command.actor.actorType !== "user" || skillCreatorWorkflow === null) return integrationDiagnostic(command.correlationId, "skill_creator", new Error("SKILL_CREATOR_UNAVAILABLE"));
        try { const result = await skillCreatorWorkflow.accept(command.payload.draftId, command.payload.accessMode === undefined ? { confirmed: true } : { confirmed: true, accessMode: command.payload.accessMode }); emit(integrationJobEvent(command.correlationId, "skill_creator", { id: command.payload.draftId, kind: "skill_creator:handoff", state: "completed", message: `Draft handed off to I1 as ${result.package.packageId}; activation remains disabled.`, updatedAt: new Date().toISOString(), resultId: result.package.revisionId })); emit(skillsStateEvent(command.correlationId, "imported", result.package.revisionId)); return integrationStateEvent(command.correlationId, "changed"); }
        catch (error) { return integrationDiagnostic(command.correlationId, "skill_creator", error); }
      }
      case "skill_creator.discard": {
        if (command.actor.actorType !== "user" || skillCreatorWorkflow === null) return integrationDiagnostic(command.correlationId, "skill_creator", new Error("SKILL_CREATOR_UNAVAILABLE"));
        try { await skillCreatorWorkflow.discard(command.payload.draftId); return integrationStateEvent(command.correlationId, "changed"); }
        catch (error) { return integrationDiagnostic(command.correlationId, "skill_creator", error); }
      }
      case "page_recovery.inspect":
        return integrationStateEvent(command.correlationId, "loaded");
      case "page_recovery.run": {
        if (command.actor.actorType !== "user" || pageRecoveryPipeline === null) return integrationDiagnostic(command.correlationId, "page_recovery", new Error("PAGE_RECOVERY_UNAVAILABLE"));
        const project = stateStore?.getProject(command.payload.projectId);
        if (project === undefined) return integrationDiagnostic(command.correlationId, "page_recovery", new Error("PROJECT_NOT_FOUND"));
        const absolutePath = resolve(project.path, command.payload.relativePath);
        const projectRoot = resolve(project.path);
        if (absolutePath !== projectRoot && !absolutePath.startsWith(projectRoot + sep) || !existsSync(absolutePath)) return integrationDiagnostic(command.correlationId, "page_recovery", new Error("PAGE_SOURCE_UNAVAILABLE"));
        const parseId = randomUUID();
        emit(integrationJobEvent(command.correlationId, "page_recovery", { id: parseId, kind: "page_recovery:parse", state: "running", message: "Page recovery is running through native -> Paddle -> Ovis quality gates.", updatedAt: new Date().toISOString() }));
        try {
          const parsed = await pageRecoveryPipeline.parse({ parseId, absolutePath, material: { id: command.payload.materialId, projectId: command.payload.projectId, relativePath: command.payload.relativePath, mediaType: command.payload.mediaType, sourceHash: command.payload.sourceHash }, ...(command.payload.pageCount === undefined ? {} : { pageCount: command.payload.pageCount }) });
          lastPageRecoveryParse = { parseId, pages: parsed.structure.units.map((unit) => { const block = parsed.blocks.find((candidate) => unit.blockIds.includes(candidate.id)); const selectedStage = block?.id.startsWith("native-") ? "native" : block?.id.startsWith("paddle-") ? "paddle" : block?.id.startsWith("ovis-") ? "ovis" : "unavailable"; const warningCodes = parsed.warnings.filter((warning) => warning.source?.locator.index === unit.index).map((warning) => warning.code); return { pageNumber: unit.index, selectedStage, retainedEarlier: warningCodes.some((code) => ["NATIVE_PARSE_WARNING", "COMPLEX_PARSE_FAILED", "COMPLEX_PARSE_UNAVAILABLE", "OCR_FAILED"].includes(code)), warningCodes }; }) };
          emit(integrationJobEvent(command.correlationId, "page_recovery", { id: parseId, kind: "page_recovery:parse", state: "completed", message: "Canonical Parse completed; per-page provenance and warnings remain local.", updatedAt: new Date().toISOString(), resultId: parseId }));
          return integrationStateEvent(command.correlationId, "changed");
        } catch (error) { emit(integrationJobEvent(command.correlationId, "page_recovery", { id: parseId, kind: "page_recovery:parse", state: error instanceof Error && error.message.includes("cancel") ? "interrupted" : "failed", message: error instanceof Error ? error.message : "Page recovery failed.", updatedAt: new Date().toISOString() })); return integrationDiagnostic(command.correlationId, "page_recovery", error); }
      }
      case "page_recovery.cancel": {
        if (command.actor.actorType !== "user" || pageRecoveryPipeline === null) return integrationDiagnostic(command.correlationId, "page_recovery", new Error("PAGE_RECOVERY_UNAVAILABLE"));
        try { await pageRecoveryPipeline.cancel(command.payload.parseId); return integrationStateEvent(command.correlationId, "changed"); } catch (error) { return integrationDiagnostic(command.correlationId, "page_recovery", error); }
      }
      case "mcp.server.list":
        return integrationStateEvent(command.correlationId, "loaded");
      case "mcp.server.test": {
        if (command.actor.actorType !== "user" || mcpIntegration === null) return integrationDiagnostic(command.correlationId, "mcp", new Error("MCP_INTEGRATION_UNAVAILABLE"));
        try {
          const status = await mcpIntegration.testConnection(command.payload.serverId);
          emit(integrationJobEvent(command.correlationId, "mcp", { id: command.payload.serverId, kind: "mcp:test-connection", state: "completed", message: status.lastStatusMessage ?? "MCP connection test completed and the connection was closed.", updatedAt: new Date().toISOString() }));
          return integrationStateEvent(command.correlationId, "changed");
        } catch (error) { return integrationDiagnostic(command.correlationId, "mcp", error); }
      }
      case "office.artifact.open": {
        if (officeOrchestrator === null) return integrationDiagnostic(command.correlationId, "office", new Error("OFFICE_INTEGRATION_UNAVAILABLE"));
        const stored = officeOrchestrator.getResult(command.payload.resultId);
        const result = stored?.result;
        const target = result === undefined ? undefined
          : command.payload.artifact === "staged_output" ? result.stagedOutputPath
            : command.payload.artifact === "change_summary" ? result.changeSummaryPath
              : result.previewPaths[command.payload.previewIndex ?? 0];
        if (target === undefined || !existsSync(target)) return integrationDiagnostic(command.correlationId, "office", new Error("OFFICE_ARTIFACT_UNAVAILABLE"));
        const error = await shell.openPath(target);
        if (error !== "") return integrationDiagnostic(command.correlationId, "office", new Error("OFFICE_ARTIFACT_OPEN_FAILED"));
        return { ...eventMetadata(command.correlationId), event: "office.artifact.opened", payload: { resultId: command.payload.resultId, artifact: command.payload.artifact } };
      }
      case "mcp.server.save": {
        if (command.actor.actorType !== "user" || mcpIntegration === null) return integrationDiagnostic(command.correlationId, "mcp", new Error("MCP_INTEGRATION_UNAVAILABLE"));
        if (command.payload.transport === "fixture" && process.env.NODE_ENV !== "test") return integrationDiagnostic(command.correlationId, "mcp", new Error("MCP_FIXTURE_TRANSPORT_TEST_ONLY"));
        try { if (command.payload.serverId !== undefined) mcpActivations.delete(command.payload.serverId); const configured = mcpIntegration.configure(command.payload as Parameters<McpIntegrationManager["configure"]>[0]); mcpActivations.delete(configured.serverId); return integrationStateEvent(command.correlationId, "changed"); } catch (error) { return integrationDiagnostic(command.correlationId, "mcp", error); }
      }
      case "mcp.activate": {
        if (command.actor.actorType !== "user" || mcpIntegration === null) return integrationDiagnostic(command.correlationId, "mcp", new Error("MCP_INTEGRATION_UNAVAILABLE"));
        try { const activation = await mcpIntegration.resolveActivation({ serverId: command.payload.serverId, toolIds: command.payload.toolIds, scope: command.payload.scope, reason: "task_preactivation", ...(command.payload.connect === undefined ? {} : { connect: command.payload.connect }) }); mcpActivations.set(activation.serverId, { activationId: activation.activationId, serverId: activation.serverId, schemaRevision: activation.schemaRevision, toolIds: activation.toolSchemas.map((schema) => schema.name), scope: command.payload.scope }); emit(integrationJobEvent(command.correlationId, "mcp", { id: activation.activationId, kind: "mcp:activation", state: "completed", message: `MCP activation admitted ${activation.toolSchemas.length} tool schema(s); provenance is pinned to ${activation.schemaRevision}.`, updatedAt: new Date().toISOString(), resultId: activation.activationId })); return integrationStateEvent(command.correlationId, "changed"); } catch (error) { return integrationDiagnostic(command.correlationId, "mcp", error); }
      }
      case "mcp.disconnect": {
        if (command.actor.actorType !== "user" || mcpIntegration === null) return integrationDiagnostic(command.correlationId, "mcp", new Error("MCP_INTEGRATION_UNAVAILABLE"));
        try { await mcpIntegration.disconnect(command.payload.serverId); mcpActivations.delete(command.payload.serverId); return integrationStateEvent(command.correlationId, "changed"); } catch (error) { return integrationDiagnostic(command.correlationId, "mcp", error); }
      }
      case "mcp.permission.resolve": {
        if (command.actor.actorType !== "user" || mcpIntegration === null) return integrationDiagnostic(command.correlationId, "mcp", new Error("MCP_INTEGRATION_UNAVAILABLE"));
        try { const result = await mcpIntegration.execute(command.payload as Parameters<McpIntegrationManager["execute"]>[0]); const state = result.status === "completed" ? "completed" : result.status === "unknown_outcome" ? "unknown_outcome" : "failed"; emit(integrationJobEvent(command.correlationId, "mcp", { id: command.payload.activationId, kind: "mcp:tool", state, message: `MCP tool execution ${result.status}; response bodies remain bounded and task-scoped.`, updatedAt: new Date().toISOString() })); return integrationStateEvent(command.correlationId, "changed"); } catch (error) { return integrationDiagnostic(command.correlationId, "mcp", error); }
      }
      case "extension.list":
        return integrationStateEvent(command.correlationId, "loaded");
      case "extension.stage": {
        if (command.actor.actorType !== "user" || extensionAdmission === null) return integrationDiagnostic(command.correlationId, "extension", new Error("EXTENSION_ADMISSION_UNAVAILABLE"));
        let sourcePath = process.env.VC_AGENT_TEST_EXTENSION_SOURCE;
        if (sourcePath === undefined) { const selection = await dialog.showOpenDialog(mainWindow!, { title: "Stage Extension", properties: ["openDirectory"] }); sourcePath = selection.canceled ? undefined : selection.filePaths[0]; }
        if (sourcePath === undefined) return integrationDiagnostic(command.correlationId, "extension", new Error("EXTENSION_STAGE_CANCELLED"));
        try { const staged = await extensionAdmission.stage({ sourcePath }); emit(integrationJobEvent(command.correlationId, "extension", { id: staged.stagedRevisionId, kind: "extension:stage", state: "completed", message: "Extension bytes are staged for non-executing inspection.", updatedAt: staged.createdAt, resultId: staged.stagedRevisionId })); return integrationStateEvent(command.correlationId, "changed"); } catch (error) { return integrationDiagnostic(command.correlationId, "extension", error); }
      }
      case "extension.inspect": {
        if (extensionAdmission === null) return integrationDiagnostic(command.correlationId, "extension", new Error("EXTENSION_ADMISSION_UNAVAILABLE"));
        try { const report = await extensionAdmission.inspect(command.payload.stagedRevisionId); emit(integrationJobEvent(command.correlationId, "extension", { id: report.reportId, kind: "extension:inspect", state: "completed", message: `Deterministic inspection is ${report.status}; approval remains a separate action.`, updatedAt: report.generatedAt, resultId: report.reportId })); return integrationStateEvent(command.correlationId, "changed"); } catch (error) { return integrationDiagnostic(command.correlationId, "extension", error); }
      }
      case "extension.audit": {
        if (command.actor.actorType !== "user" || extensionAdmission === null) return integrationDiagnostic(command.correlationId, "extension", new Error("EXTENSION_ADMISSION_UNAVAILABLE"));
        try { const audit = await extensionAdmission.startAudit({ stagedRevisionId: command.payload.stagedRevisionId, ...(command.payload.profileId === undefined ? {} : { profileId: command.payload.profileId }), ...(command.payload.providerAvailable === undefined ? {} : { providerAvailable: command.payload.providerAvailable }) }); emit(integrationJobEvent(command.correlationId, "extension", { id: audit.auditRunId, kind: "extension:audit", state: audit.status === "audit_complete" ? "completed" : audit.status === "audit_paused" ? "pending" : "failed", message: `Extension Audit is ${audit.status}; no approval was manufactured.`, updatedAt: audit.updatedAt, resultId: audit.auditRunId })); return integrationStateEvent(command.correlationId, "changed"); } catch (error) { return integrationDiagnostic(command.correlationId, "extension", error); }
      }
      case "extension.approve": {
        if (command.actor.actorType !== "user" || extensionAdmission === null) return integrationDiagnostic(command.correlationId, "extension", new Error("EXTENSION_ADMISSION_UNAVAILABLE"));
        try { const approved = await extensionAdmission.approve(command.payload as Parameters<ExtensionAdmissionManager["approve"]>[0]); emit(integrationJobEvent(command.correlationId, "extension", { id: approved.approvedRevisionId, kind: "extension:approve", state: "completed", message: "Extension is approved but remains disabled until a separate revision activation.", updatedAt: approved.approvedAt, resultId: approved.approvedRevisionId })); return integrationStateEvent(command.correlationId, "changed"); } catch (error) { return integrationDiagnostic(command.correlationId, "extension", error); }
      }
      case "extension.revision.prepare": {
        if (command.actor.actorType !== "user" || globalExtensionRevisions === null) return integrationDiagnostic(command.correlationId, "extension", new Error("EXTENSION_REVISION_UNAVAILABLE"));
        try { const pending = command.payload.action === "disable" ? await globalExtensionRevisions.propose({ action: "disable", extensionId: command.payload.extensionId }) : command.payload.approvedRevisionId === undefined ? (() => { throw new Error("EXTENSION_NOT_APPROVED"); })() : await globalExtensionRevisions.propose({ action: command.payload.action, extensionId: command.payload.extensionId, approvedRevisionId: command.payload.approvedRevisionId }); emit(integrationJobEvent(command.correlationId, "extension", { id: pending.revisionId, kind: "extension:revision", state: "pending", message: "Global Extension Revision awaits explicit activation at an idle boundary.", updatedAt: pending.createdAt, resultId: pending.revisionId })); return integrationStateEvent(command.correlationId, "changed"); } catch (error) { return integrationDiagnostic(command.correlationId, "extension", error); }
      }
      case "extension.revision.activate": {
        if (command.actor.actorType !== "user" || globalExtensionRevisions === null) return integrationDiagnostic(command.correlationId, "extension", new Error("EXTENSION_REVISION_UNAVAILABLE"));
        try { if ((command.payload.mode ?? "idle") === "immediate") await globalExtensionRevisions.activateImmediately(command.payload.revisionId); else await globalExtensionRevisions.activateWhenIdle(command.payload.revisionId); return integrationStateEvent(command.correlationId, "changed"); } catch (error) { return integrationDiagnostic(command.correlationId, "extension", error); }
      }
      case "extension.rollback": {
        if (command.actor.actorType !== "user" || globalExtensionRevisions === null) return integrationDiagnostic(command.correlationId, "extension", new Error("EXTENSION_REVISION_UNAVAILABLE"));
        try { await globalExtensionRevisions.rollback(command.payload.approvedRevisionId); return integrationStateEvent(command.correlationId, "changed"); } catch (error) { return integrationDiagnostic(command.correlationId, "extension", error); }
      }
      case "profile.create": {
        const profile = stateStore.createModelProfile({
          name: command.payload.name,
          provider: command.payload.provider,
          model: command.payload.model,
          thinkingLevel: command.payload.thinkingLevel,
          ...(command.payload.contextWindow === undefined ? {} : { contextWindow: command.payload.contextWindow }),
          ...(command.payload.maxOutputTokens === undefined ? {} : { maxOutputTokens: command.payload.maxOutputTokens }),
          encryptedCredential: credentials.encrypt(command.payload.apiKey)
        });
        return { ...eventMetadata(command.correlationId), event: "profile.created", payload: { profile } };
      }
      case "profile.update": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Model Profile editing requires explicit User action.");
        const profile = stateStore.updateModelProfile(command.payload.profileId, {
          name: command.payload.name,
          provider: command.payload.provider,
          model: command.payload.model,
          thinkingLevel: command.payload.thinkingLevel,
          ...(command.payload.contextWindow === undefined ? {} : { contextWindow: command.payload.contextWindow }),
          ...(command.payload.maxOutputTokens === undefined ? {} : { maxOutputTokens: command.payload.maxOutputTokens }),
          ...(command.payload.apiKey === undefined ? {} : { encryptedCredential: credentials.encrypt(command.payload.apiKey) })
        });
        return { ...eventMetadata(command.correlationId), event: "profile.updated", payload: { profile } };
      }
      case "profile.credential.set": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Credential setup requires explicit User action.");
        const profile = stateStore.setModelProfileCredential(command.payload.profileId, credentials.encrypt(command.payload.apiKey));
        return { ...eventMetadata(command.correlationId), event: "profile.credential.updated", payload: { profile } };
      }
      case "academic.credentials.set": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Academic source credential setup requires explicit User action.");
        const statuses = stateStore.setAcademicCredential(command.payload.source, credentials.encrypt(command.payload.credential));
        return { ...eventMetadata(command.correlationId), event: "academic.credentials.updated", payload: { credentials: statuses, action: "set" } };
      }
      case "academic.credentials.clear": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Academic source credential removal requires explicit User action.");
        const statuses = stateStore.clearAcademicCredential(command.payload.source);
        return { ...eventMetadata(command.correlationId), event: "academic.credentials.updated", payload: { credentials: statuses, action: "cleared" } };
      }
      case "prompt.revision.list": {
        const active = stateStore.getActiveSystemPromptRevision();
        if (active === undefined) throw new Error("System Prompt is not initialized");
        return { ...eventMetadata(command.correlationId), event: "prompt.revisions.listed", payload: { activeRevisionId: active.id, revisions: stateStore.listSystemPromptRevisions() } };
      }
      case "prompt.revision.create": {
        const revision = stateStore.createSystemPromptRevision(command.payload.content, command.payload.changeNote);
        const active = stateStore.getActiveSystemPromptRevision()!;
        return { ...eventMetadata(command.correlationId), event: "prompt.revision.created", payload: { revision, activeRevisionId: active.id } };
      }
      case "prompt.revision.activate": {
        const revision = stateStore.activateSystemPromptRevision(command.payload.revisionId);
        return { ...eventMetadata(command.correlationId), event: "prompt.revision.activated", payload: { revision } };
      }
      case "prompt.restore_default": {
        const revision = stateStore.restoreDefaultSystemPrompt(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT, command.payload.changeNote);
        return { ...eventMetadata(command.correlationId), event: "prompt.revision.activated", payload: { revision } };
      }
      case "task_model_assignment.list":
        return { ...eventMetadata(command.correlationId), event: "task_model_assignments.listed", payload: { assignments: stateStore.listTaskModelAssignments() } };
      case "task_model_assignment.set": {
        const assignment = stateStore.setTaskModelAssignment(command.payload.taskType, command.payload.profileId);
        return { ...eventMetadata(command.correlationId), event: "task_model_assignment.updated", payload: { taskType: command.payload.taskType, assignment } };
      }
      case "task_model_assignment.clear": {
        stateStore.clearTaskModelAssignment(command.payload.taskType);
        return { ...eventMetadata(command.correlationId), event: "task_model_assignment.updated", payload: { taskType: command.payload.taskType } };
      }
      case "reflection.list":
        return { ...eventMetadata(command.correlationId), event: "reflection.runs.listed", payload: { runs: stateStore.listReflectionRuns(command.payload.projectId) } };
      case "reflection.start.project": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Investment Reflection requires explicit User initiation.");
        return startProjectReflection(command.correlationId, command.payload);
      }
      case "reflection.start.unscoped": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Investment Reflection requires explicit User initiation.");
        return startUnscopedReflection(command.correlationId, command.payload);
      }
      case "reflection.independent.start": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Independent Evidence requires explicit User initiation.");
        return startIndependentAssessment(command.correlationId, command.payload.runId, command.payload.profileId);
      }
      case "reflection.independent.stop":
        return stopIndependentAssessment(command.correlationId, command.payload.runId);
      case "reflection.memory_aware.start": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Memory-Aware Reflection requires explicit User initiation.");
        return startMemoryAwareReflection(command.correlationId, command.payload.runId, command.payload.profileId);
      }
      case "reflection.discard": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Discarding Reflection requires explicit User initiation.");
        const run = stateStore.discardReflection(command.payload.runId);
        if (reflectionOutcomes !== null) {
          reflectionOutcomes.discardRunDrafts(run.id);
          emit(reflectionOutcomesEvent(command.correlationId, run.id, run.threadId));
        }
        return { ...eventMetadata(command.correlationId, run.threadId), event: "reflection.run.updated", payload: { run } };
      }
      case "reflection.outcome.list": {
        if (reflectionOutcomes === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Reflection outcomes are unavailable.");
        const run = stateStore.getReflectionRun(command.payload.runId);
        if (run === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Reflection run not found.");
        return reflectionOutcomesEvent(command.correlationId, run.id, run.threadId);
      }
      case "reflection.judgment.confirm": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Confirming a Judgment Record requires explicit User action.");
        if (reflectionOutcomes === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Reflection outcomes are unavailable.");
        let draft = reflectionOutcomes.getJudgment(command.payload.draftId);
        const run = draft === undefined ? undefined : stateStore.getReflectionRun(draft.runId);
        if (draft === undefined || run === undefined || run.status !== "dialogue_active") return diagnostic(command.correlationId, "HOST_FAILURE", "Judgment Record confirmation requires an active Reflection dialogue.");
        reconcileReflectionOutcomeState(run);
        draft = reflectionOutcomes.getJudgment(command.payload.draftId);
        if (draft?.status !== "draft") {
          if (draft?.status === "stale") emit(reflectionOutcomesEvent(command.correlationId, run.id, run.threadId));
          return diagnostic(command.correlationId, "HOST_FAILURE", draft?.status === "stale" ? "The Judgment Record draft is stale because relevant evidence or Memory changed. Continue the Reflection and prepare a new draft." : "Judgment Record draft is no longer confirmable.");
        }
        if (run.scope === "project") {
          const project = stateStore.getProject(run.projectId);
          if (project === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "The Reflection Project is unavailable.");
          reflectionOutcomes.confirmJudgment(draft.id, project.path, { scope: "project", projectId: project.id, threadId: run.threadId });
        } else {
          const thread = stateStore.getThread(run.threadId);
          if (thread?.scope !== "unscoped" || thread.outputLocation === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Choose an Unscoped Output Location before confirming the Judgment Record.");
          reflectionOutcomes.confirmJudgment(draft.id, thread.outputLocation, { scope: "unscoped", threadId: run.threadId });
        }
        return reflectionOutcomesEvent(command.correlationId, run.id, run.threadId);
      }
      case "reflection.outcome.discard": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Discarding a Reflection outcome requires explicit User action.");
        if (reflectionOutcomes === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Reflection outcomes are unavailable.");
        const judgment = reflectionOutcomes.getJudgment(command.payload.draftId);
        const learning = reflectionOutcomes.getLearningProposal(command.payload.draftId);
        const runId = judgment?.runId ?? learning?.runId;
        const run = runId === undefined ? undefined : stateStore.getReflectionRun(runId);
        if (run === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Reflection outcome context is unavailable.");
        reflectionOutcomes.discard(command.payload.draftId);
        return reflectionOutcomesEvent(command.correlationId, run.id, run.threadId);
      }
      case "reflection.learning.prepare_patch": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Preparing a Memory patch requires explicit User action.");
        if (reflectionOutcomes === null || memoryEvolution === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Reflection learning is unavailable.");
        let proposal = reflectionOutcomes.getLearningProposal(command.payload.proposalId);
        const judgment = reflectionOutcomes.getJudgment(command.payload.judgmentDraftId);
        if (proposal === undefined || judgment === undefined || proposal.runId !== judgment.runId || judgment.status !== "confirmed") {
          return diagnostic(command.correlationId, "HOST_FAILURE", "A draft Learning Proposal and confirmed Judgment Record from the same Reflection are required.");
        }
        const run = stateStore.getReflectionRun(proposal.runId);
        if (run === undefined || run.status !== "dialogue_active") return diagnostic(command.correlationId, "HOST_FAILURE", "Memory patch preparation requires an active Reflection dialogue.");
        reconcileReflectionOutcomeState(run);
        proposal = reflectionOutcomes.getLearningProposal(command.payload.proposalId);
        if (proposal?.status !== "draft") {
          if (proposal?.status === "stale") emit(reflectionOutcomesEvent(command.correlationId, run.id, run.threadId));
          return diagnostic(command.correlationId, "HOST_FAILURE", proposal?.status === "stale" ? "The Long-term Learning Proposal is stale because relevant evidence or Memory changed. Continue the Reflection and prepare a new proposal." : "Learning Proposal is no longer available for patch preparation.");
        }
        const patch = memoryEvolution.prepare({
          action: proposal.action,
          targetEntryIds: proposal.targetEntryIds,
          proposed: { ...proposal.proposed, sourceReferenceIds: [judgment.sourceReferenceId] },
          rationale: proposal.rationale,
          resolutionSignal: { type: run.framing === "retrospective" ? "approved_retrospective" : "approved_reflection", referenceId: judgment.id },
          provenanceRecords: [{
            schemaVersion: 1,
            sourceReferenceId: judgment.sourceReferenceId,
            scope: run.scope,
            ...(run.scope === "project" ? { projectId: run.projectId } : {}),
            workflowType: "reflection",
            workflowRunId: run.id,
            judgmentRecordId: judgment.id,
            threadId: run.threadId,
            evidenceReferences: judgment.evidenceReferences,
            availability: judgment.sourceAvailability === "source_unavailable" ? "source_unavailable" : "active",
            createdAt: judgment.confirmedAt ?? judgment.createdAt
          }]
        });
        reflectionOutcomes.markPatchPrepared(proposal.id, patch.id);
        emit(reflectionOutcomesEvent(command.correlationId, run.id, run.threadId));
        return { ...eventMetadata(command.correlationId, run.threadId), event: "long_term_memory.patch.prepared", payload: { patch } };
      }
      case "project.list":
        return { ...eventMetadata(command.correlationId), event: "projects.listed", payload: { projects: stateStore.listProjects() } };
      case "project.open":
        return openProject(command.correlationId);
      case "project.collision.resolve":
        return resolveProjectCollision(command.correlationId, command.payload.collisionId, command.payload.action);
      case "project.material.list":
        return { ...eventMetadata(command.correlationId), event: "project.materials.listed", payload: { projectId: command.payload.projectId, materials: stateStore.listMaterials(command.payload.projectId) } };
      case "project.material.refresh":
        return refreshProjectInventory(command.correlationId, command.payload.projectId, false);
      case "project.context.load": {
        const project = stateStore.getProject(command.payload.projectId);
        if (project === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Project not found.");
        const existed = existsSync(projectContexts.paths(project.path).markdown);
        const document = projectContexts.load(project.id, project.path, true)!;
        if (!existed) ownProjectContextWrites.set(project.id, document.sourceHash);
        return { ...eventMetadata(command.correlationId), event: "project.context.loaded", payload: { document, source: existed ? "load" : "lazy_create" } };
      }
      case "project.context.save": {
        const project = stateStore.getProject(command.payload.projectId);
        if (project === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Project not found.");
        try {
          const document = projectContexts.save(project.id, project.path, command.payload.content, command.payload.expectedSourceHash);
          ownProjectContextWrites.set(project.id, document.sourceHash);
          return { ...eventMetadata(command.correlationId), event: "project.context.updated", payload: { document, source: "user_save" } };
        } catch (error) {
          return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error && error.message === "STALE_PROJECT_CONTEXT_WRITE" ? "Project Context changed externally. Reload before saving." : "Project Context could not be saved.");
        }
      }
      case "project.memory.load": {
        const project = stateStore.getProject(command.payload.projectId);
        if (project === undefined || projectMemories === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Project not found.");
        const existed = existsSync(projectMemories.markdownPath(project.path));
        const document = projectMemories.load(project.id, project.path, true)!;
        if (!existed) ownProjectMemoryWrites.set(project.id, document.sourceHash);
        emit(dreamStateEvent(randomUUID()));
        return { ...eventMetadata(command.correlationId), event: "project.memory.loaded", payload: { document, source: existed ? "load" : "lazy_create" } };
      }
      case "project.memory.save": {
        const project = stateStore.getProject(command.payload.projectId);
        if (project === undefined || projectMemories === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Project not found.");
        try {
          const document = projectMemories.save(project.id, project.path, command.payload.content, command.payload.expectedSourceHash);
          ownProjectMemoryWrites.set(project.id, document.sourceHash);
          emit(dreamStateEvent(randomUUID()));
          return { ...eventMetadata(command.correlationId), event: "project.memory.updated", payload: { document, source: "user_save" } };
        } catch (error) {
          return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error && error.message === "STALE_PROJECT_MEMORY_WRITE" ? "Project Memory changed externally. Reload before saving." : "Project Memory could not be saved.");
        }
      }
      case "long_term_memory.load": {
        if (longTermMemories === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Long-term Memory is unavailable.");
        const existed = existsSync(longTermMemories.markdownPath);
        const document = longTermMemories.load(true)!;
        startLongTermMemoryWatcher();
        return { ...eventMetadata(command.correlationId), event: "long_term_memory.loaded", payload: { document, source: existed ? "load" : "lazy_create" } };
      }
      case "long_term_memory.refresh": {
        const document = longTermMemories?.refreshIfExists();
        if (document === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Open the Long-term Memory view before refreshing it.");
        startLongTermMemoryWatcher();
        emit(dreamStateEvent(randomUUID()));
        return { ...eventMetadata(command.correlationId), event: "long_term_memory.updated", payload: { document, source: "manual_refresh" } };
      }
      case "long_term_memory.save": {
        if (longTermMemories === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Long-term Memory is unavailable.");
        try {
          const document = longTermMemories.save(command.payload.content, command.payload.expectedSourceHash);
          ownLongTermMemoryWriteHash = document.sourceHash;
          emit(dreamStateEvent(randomUUID()));
          return { ...eventMetadata(command.correlationId), event: "long_term_memory.updated", payload: { document, source: "user_save" } };
        } catch (error) {
          return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error && error.message === "STALE_LONG_TERM_MEMORY_WRITE" ? "Long-term Memory changed externally. Refresh before saving." : "Long-term Memory could not be saved.");
        }
      }
      case "long_term_memory.open_folder": {
        if (longTermMemories === null || !existsSync(longTermMemories.rootPath)) return diagnostic(command.correlationId, "HOST_FAILURE", "Open the Long-term Memory view first.");
        const error = await shell.openPath(longTermMemories.rootPath);
        if (error !== "") return diagnostic(command.correlationId, "HOST_FAILURE", "The Long-term Memory folder could not be opened.");
        return { ...eventMetadata(command.correlationId), event: "long_term_memory.folder.opened", payload: { path: longTermMemories.rootPath } };
      }
      case "long_term_memory.patch.prepare": {
        if (memoryEvolution === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Memory Evolution is unavailable in read-only recovery.");
        try {
          const patch = memoryEvolution.prepare(command.payload);
          return { ...eventMetadata(command.correlationId), event: "long_term_memory.patch.prepared", payload: { patch } };
        } catch (error) {
          return diagnostic(command.correlationId, "HOST_FAILURE", memoryEvolutionFailure(error, "Memory patch could not be prepared."));
        }
      }
      case "long_term_memory.patch.commit": {
        if (memoryEvolution === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Memory Evolution is unavailable in read-only recovery.");
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Memory changes require explicit User confirmation.");
        try {
          const document = memoryEvolution.commit(command.payload.patchId);
          ownLongTermMemoryWriteHash = document.sourceHash;
          const proposal = reflectionOutcomes?.markPatchCommitted(command.payload.patchId);
          if (proposal !== undefined) {
            const run = stateStore.getReflectionRun(proposal.runId);
            if (run !== undefined) emit(reflectionOutcomesEvent(command.correlationId, run.id, run.threadId));
          }
          emit(dreamStateEvent(randomUUID()));
          return { ...eventMetadata(command.correlationId), event: "long_term_memory.patch.committed", payload: { patchId: command.payload.patchId, document } };
        } catch (error) {
          return diagnostic(command.correlationId, "HOST_FAILURE", memoryEvolutionFailure(error, "Memory patch could not be committed."));
        }
      }
      case "long_term_memory.patch.discard": {
        if (memoryEvolution === null || !memoryEvolution.discard(command.payload.patchId)) return diagnostic(command.correlationId, "HOST_FAILURE", "Memory patch is no longer available.");
        const proposal = reflectionOutcomes?.markPatchDiscarded(command.payload.patchId);
        if (proposal !== undefined) {
          const run = stateStore.getReflectionRun(proposal.runId);
          if (run !== undefined) emit(reflectionOutcomesEvent(command.correlationId, run.id, run.threadId));
        }
        return { ...eventMetadata(command.correlationId), event: "long_term_memory.patch.discarded", payload: { patchId: command.payload.patchId } };
      }
      case "long_term_memory.maintenance.load": {
        if (memoryEvolution === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Memory maintenance is unavailable in read-only recovery.");
        let state = memoryEvolution.loadMaintenance();
        if (state.automaticDeletion) state = memoryEvolution.cleanupArchive();
        return { ...eventMetadata(command.correlationId), event: "long_term_memory.maintenance.loaded", payload: { state } };
      }
      case "long_term_memory.maintenance.save": {
        if (memoryEvolution === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Memory maintenance is unavailable in read-only recovery.");
        const state = memoryEvolution.saveMaintenanceSettings(command.payload.retention, command.payload.automaticDeletion);
        return { ...eventMetadata(command.correlationId), event: "long_term_memory.maintenance.updated", payload: { state } };
      }
      case "long_term_memory.archive.update": {
        if (memoryEvolution === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Memory maintenance is unavailable in read-only recovery.");
        try {
          const state = memoryEvolution.updateArchiveItem(command.payload.archiveId, command.payload.action);
          return { ...eventMetadata(command.correlationId), event: "long_term_memory.maintenance.updated", payload: { state } };
        } catch (error) {
          return diagnostic(command.correlationId, "HOST_FAILURE", memoryEvolutionFailure(error, "Condensation Archive could not be updated."));
        }
      }
      case "long_term_memory.archive.cleanup": {
        if (memoryEvolution === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Memory maintenance is unavailable in read-only recovery.");
        const state = memoryEvolution.cleanupArchive(command.payload.archiveIds);
        return { ...eventMetadata(command.correlationId), event: "long_term_memory.maintenance.updated", payload: { state } };
      }
      case "long_term_memory.provenance.inspect": {
        if (memoryEvolution === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Memory provenance is unavailable in read-only recovery.");
        const thread = stateStore.getThread(command.payload.threadId);
        if (thread?.scope !== "project" || thread.activeProfileId === undefined || !stateStore.isProjectProfileAuthorized(thread.projectId, thread.activeProfileId)) return diagnostic(command.correlationId, "HOST_FAILURE", "Source verification requires an authorized Profile inside the source Project.");
        const inspection = memoryEvolution.inspectProvenance(command.payload.sourceReferenceId, thread.projectId);
        return { ...eventMetadata(command.correlationId, thread.id), event: "long_term_memory.provenance.inspected", payload: inspection };
      }
      case "memory.candidate.dismiss": {
        const candidate = memoryCandidates?.resolve(command.payload.candidateId, "dismissed");
        if (candidate === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Memory candidate is no longer active.");
        synchronizeDreamSchedulingIndex();
        return { ...eventMetadata(command.correlationId, candidate.threadId), event: "memory.candidate.resolved", payload: { candidate } };
      }
      case "dream.state.load":
        return dreamStateEvent(command.correlationId);
      case "dream.interval.set": {
        if (dreamReviews === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Dream review state is unavailable.");
        dreamReviews.setReviewIntervalDays(command.payload.reviewIntervalDays);
        return dreamStateEvent(command.correlationId);
      }
      case "dream.reminder.defer": {
        if (dreamReviews === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Dream review state is unavailable.");
        dreamReviews.defer(command.payload.until);
        return dreamStateEvent(command.correlationId);
      }
      case "dream.launch": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Dream requires explicit User initiation.");
        if (dreamReviews === null || memoryCandidates === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Dream is unavailable in read-only recovery.");
        const profile = resolveDreamProfile(command.payload.profileId);
        if (profile === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Configure a Dream Task Model Assignment or choose a Model Profile before launching Dream.");
        const promptRevision = stateStore.getActiveSystemPromptRevision();
        if (promptRevision === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "An active System Prompt Revision is required before launching Dream.");
        synchronizeDreamSchedulingIndex();
        try {
          const projectMemoryHashes = currentProjectMemoryHashes();
          dreamReviews.createBatch({ promptRevision, profile: toDreamProfileSnapshot(profile), trajectory: currentEligibleDreamTrajectory(), candidates: memoryCandidates.list(), projectMemoryHashes });
          return dreamStateEvent(command.correlationId);
        } catch (error) {
          return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Dream batch could not be created.");
        }
      }
      case "dream.resume": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Resuming Dream requires explicit User action.");
        if (dreamReviews === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Dream is unavailable in read-only recovery.");
        try { dreamReviews.resume(command.payload.batchId); return dreamStateEvent(command.correlationId); }
        catch (error) { return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Dream could not be resumed."); }
      }
      case "dream.discard": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Discarding Dream requires explicit User action.");
        if (dreamReviews === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Dream is unavailable in read-only recovery.");
        try { dreamReviews.discard(command.payload.batchId); return dreamStateEvent(command.correlationId); }
        catch (error) { return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Dream could not be discarded."); }
      }
      case "dream.scope.start": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Dream extraction and retry require explicit User action.");
        return startDreamScopeExtraction(command.correlationId, command.payload.batchId, command.payload.scopeId);
      }
      case "dream.scope.review": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Dream scope review requires explicit User action.");
        if (dreamReviews === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Dream is unavailable in read-only recovery.");
        try {
          dreamReviews.reviewScope(command.payload.batchId, command.payload.scopeId, command.payload.decision);
          const reviewedBatch = dreamReviews.load().batches.find((item) => item.id === command.payload.batchId);
          if (reviewedBatch?.status === "synthesis_pending" && reviewedBatch.synthesis === undefined) {
            return startDreamGlobalSynthesis(command.correlationId, command.payload.batchId);
          }
          return dreamStateEvent(command.correlationId);
        } catch (error) {
          return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Dream scope could not be reviewed.");
        }
      }
      case "dream.synthesis.start": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Global Dream Synthesis requires explicit User action.");
        return startDreamGlobalSynthesis(command.correlationId, command.payload.batchId);
      }
      case "dream.proposal.review": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Dream proposal review requires explicit User action.");
        if (dreamReviews === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Dream is unavailable in read-only recovery.");
        try {
          const reviewedBatch = dreamReviews.reviewSynthesisProposals(command.payload.batchId, [{ proposalId: command.payload.proposalId, decision: command.payload.decision, ...(command.payload.destination === undefined ? {} : { destination: command.payload.destination }) }]);
          if (reviewedBatch.synthesis?.status === "reviewed" && reviewedBatch.preparedPatch === undefined && dreamCommits !== null) {
            revalidateDreamSynthesis();
            dreamCommits.prepare(command.payload.batchId, new Map(stateStore.listProjects().map((project) => [project.id, { id: project.id, path: project.path }])));
          }
          return dreamStateEvent(command.correlationId);
        } catch (error) { return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Dream proposal could not be reviewed."); }
      }
      case "dream.proposal.review_all": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Bulk Dream proposal review requires explicit User action.");
        if (dreamReviews === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Dream is unavailable in read-only recovery.");
        try {
          const batch = dreamReviews.load().batches.find((item) => item.id === command.payload.batchId);
          if (batch?.synthesis === undefined) throw new Error("DREAM_SYNTHESIS_NOT_REVIEWABLE");
          const reviewedBatch = dreamReviews.reviewSynthesisProposals(batch.id, batch.synthesis.proposals.filter((proposal) => proposal.status === "pending").map((proposal) => ({ proposalId: proposal.id, decision: command.payload.decision })));
          if (reviewedBatch.synthesis?.status === "reviewed" && reviewedBatch.preparedPatch === undefined && dreamCommits !== null) {
            revalidateDreamSynthesis();
            dreamCommits.prepare(batch.id, new Map(stateStore.listProjects().map((project) => [project.id, { id: project.id, path: project.path }])));
          }
          return dreamStateEvent(command.correlationId);
        } catch (error) { return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Dream proposals could not be reviewed."); }
      }
      case "dream.patch.prepare": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Dream patch preparation requires explicit User action.");
        if (dreamCommits === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Dream patch preparation is unavailable.");
        try {
          revalidateDreamSynthesis();
          dreamCommits.prepare(command.payload.batchId, new Map(stateStore.listProjects().map((project) => [project.id, { id: project.id, path: project.path }])));
          return dreamStateEvent(command.correlationId);
        } catch (error) { return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Dream patch could not be prepared."); }
      }
      case "dream.patch.commit": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Dream Memory commit requires explicit final confirmation.");
        if (dreamCommits === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Dream patch commit is unavailable.");
        try {
          revalidateDreamSynthesis();
          dreamCommits.commit(command.payload.batchId, command.payload.patchId);
          synchronizeDreamSchedulingIndex();
          return dreamStateEvent(command.correlationId);
        } catch (error) { return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Dream patch commit failed without activating changes."); }
      }
      case "dream.patch.discard": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Discarding a Dream patch requires explicit User action.");
        if (dreamCommits === null || dreamReviews === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Dream patch discard is unavailable.");
        try {
          dreamCommits.discard(command.payload.batchId, command.payload.patchId);
          dreamReviews.discardPreparedPatch(command.payload.batchId, command.payload.patchId);
          return dreamStateEvent(command.correlationId);
        } catch (error) { return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Dream patch could not be discarded."); }
      }
      case "project.memory.append.confirm": {
        const candidate = memoryCandidates?.list().find((item) => item.id === command.payload.candidateId && item.status === "active");
        const project = stateStore.getProject(command.payload.projectId);
        if (candidate === undefined || candidate.scope !== "project" || candidate.projectId !== command.payload.projectId || project === undefined || projectMemories === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Memory candidate is not eligible for this Project.");
        try {
          const document = projectMemories.append(project.id, project.path, { title: command.payload.title, tags: command.payload.tags, body: command.payload.body, threadId: candidate.threadId }, command.payload.expectedSourceHash);
          ownProjectMemoryWrites.set(project.id, document.sourceHash);
          const resolved = memoryCandidates!.resolve(candidate.id, "promoted")!;
          synchronizeDreamSchedulingIndex();
          emit({ ...eventMetadata(command.correlationId, candidate.threadId), event: "memory.candidate.resolved", payload: { candidate: resolved } });
          emit(dreamStateEvent(randomUUID()));
          return { ...eventMetadata(command.correlationId), event: "project.memory.updated", payload: { document, source: "confirmed_append" } };
        } catch (error) {
          return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error && error.message === "STALE_PROJECT_MEMORY_WRITE" ? "Project Memory changed externally. Reload before confirming this draft." : "Project Memory could not be updated.");
        }
      }
      case "project.output.list": {
        const project = stateStore.getProject(command.payload.projectId);
        if (project === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Project not found.");
        return { ...eventMetadata(command.correlationId), event: "project.outputs.listed", payload: { projectId: project.id, outputs: projectOutputs.list(project.id, project.path) } };
      }
      case "project.output.open": {
        const project = stateStore.getProject(command.payload.projectId);
        const output = project === undefined ? undefined : projectOutputs.list(project.id, project.path).find((item) => item.id === command.payload.artifactId);
        if (project === undefined || output === undefined || !existsSync(output.destination)) return diagnostic(command.correlationId, "HOST_FAILURE", "Project Output is unavailable.");
        const error = await shell.openPath(output.destination);
        if (error !== "") return diagnostic(command.correlationId, "HOST_FAILURE", error);
        return { ...eventMetadata(command.correlationId), event: "project.output.opened", payload: { projectId: project.id, artifactId: output.id, destination: output.destination } };
      }
      case "material.need": {
        const context = stateStore.getStaleMaterialRefreshContext(command.payload.materialId);
        if (context === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "This Material does not require a Parse Refresh Choice.");
        return { ...eventMetadata(command.correlationId), event: "material.parse.refresh.choice.required", payload: { ...context, currentSourceHash: context.material.sourceHash } };
      }
      case "material.parse.request":
        return parseMaterial(command.correlationId, command.payload.materialId);
      case "material.parse.refresh.resolve": {
        const result = stateStore.resolveParseRefreshChoice(command.payload.materialId, command.payload.choice);
        const resolved: HostEvent = { ...eventMetadata(command.correlationId), event: "material.parse.refresh.choice.resolved", payload: { materialId: command.payload.materialId, choice: command.payload.choice, status: result.status } };
        if (command.payload.choice === "cancel") return resolved;
        emit(resolved);
        return parseMaterial(command.correlationId, command.payload.materialId, result.requestId);
      }
      case "thread.list":
        return { ...eventMetadata(command.correlationId), event: "threads.listed", payload: { threads: stateStore.listThreads() } };
      case "thread.trajectory.load":
        if (stateStore.getThread(command.payload.threadId) === undefined) {
          return diagnostic(command.correlationId, "HOST_FAILURE", "Thread not found.");
        }
        return {
          ...eventMetadata(command.correlationId, command.payload.threadId),
          event: "thread.trajectory.loaded",
          payload: {
            threadId: command.payload.threadId,
            turns: trajectoryStore.projectTurns(command.payload.threadId),
            activities: trajectoryStore.projectActivities(command.payload.threadId)
          }
        };
      case "thread.trajectory.delete": {
        if (command.actor.actorType !== "user" || command.payload.confirmed !== true) return diagnostic(command.correlationId, "HOST_FAILURE", "Thread history deletion requires explicit User confirmation.");
        if (turnExecution!.isThreadActive(command.payload.threadId)) return diagnostic(command.correlationId, "HOST_FAILURE", "Stop the active Turn before deleting its history.");
        if (stateStore.getThread(command.payload.threadId) === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Thread not found.");
        const before = dreamReviews?.load().batches ?? [];
        const affectedBatchIds = before.filter((batch) => batch.trajectoryInputs.some((item) => item.threadId === command.payload.threadId) || batch.candidateInputs.some((item) => item.threadId === command.payload.threadId) || batch.carryoverInputs.some((item) => item.threadId === command.payload.threadId)).map((batch) => batch.id);
        const removedCandidateIds = memoryCandidates?.removeByThread(command.payload.threadId) ?? [];
        dreamReviews?.redactThreadSources(command.payload.threadId);
        subAgentRuntime?.deleteForParentThread(command.payload.threadId);
        trajectoryStore.deleteThreadHistory(command.payload.threadId);
        loadedPromptByThread.delete(command.payload.threadId);
        sequenceByThread.set(command.payload.threadId, 0);
        return { ...eventMetadata(command.correlationId, command.payload.threadId), event: "thread.trajectory.deleted", payload: { threadId: command.payload.threadId, removedCandidateIds, affectedBatchIds } };
      }
      case "thread.archive.set": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Thread archival requires explicit User action.");
        if (turnExecution!.isThreadActive(command.payload.threadId)) return diagnostic(command.correlationId, "HOST_FAILURE", "Stop the active Turn before changing archive state.");
        const thread = stateStore.setThreadArchived(command.payload.threadId, command.payload.archived);
        return { ...eventMetadata(command.correlationId, thread.id), event: "thread.archived", payload: { thread } };
      }
      case "thread.delete": {
        if (command.actor.actorType !== "user" || command.payload.confirmed !== true) return diagnostic(command.correlationId, "HOST_FAILURE", "Thread deletion requires explicit User confirmation.");
        if (turnExecution!.isThreadActive(command.payload.threadId)) return diagnostic(command.correlationId, "HOST_FAILURE", "Stop the active Turn before deleting this Thread.");
        if (stateStore.getThread(command.payload.threadId) === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Thread not found.");
        const before = dreamReviews?.load().batches ?? [];
        const affectedBatchIds = before.filter((batch) => batch.trajectoryInputs.some((item) => item.threadId === command.payload.threadId) || batch.candidateInputs.some((item) => item.threadId === command.payload.threadId) || batch.carryoverInputs.some((item) => item.threadId === command.payload.threadId)).map((batch) => batch.id);
        const removedCandidateIds = memoryCandidates?.removeByThread(command.payload.threadId) ?? [];
        dreamReviews?.redactThreadSources(command.payload.threadId);
        subAgentRuntime?.deleteForParentThread(command.payload.threadId);
        workerSupervisor?.discardThread(command.payload.threadId);
        trajectoryStore.deleteThreadHistory(command.payload.threadId);
        if (!stateStore.deleteThread(command.payload.threadId)) return diagnostic(command.correlationId, "HOST_FAILURE", "Thread not found.");
        loadedPromptByThread.delete(command.payload.threadId);
        sequenceByThread.delete(command.payload.threadId);
        return { ...eventMetadata(command.correlationId, command.payload.threadId), event: "thread.deleted", payload: { threadId: command.payload.threadId, removedCandidateIds, affectedBatchIds } };
      }
      case "thread.create.unscoped": {
        const thread = stateStore.createUnscopedThread(command.payload.title);
        return { ...eventMetadata(command.correlationId, thread.id), event: "thread.created", payload: { thread } };
      }
      case "thread.create.project": {
        const thread = stateStore.createProjectThread(command.payload.projectId, command.payload.title);
        return { ...eventMetadata(command.correlationId, thread.id), event: "thread.created", payload: { thread } };
      }
      case "thread.rename": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Thread renaming requires explicit User action.");
        const thread = stateStore.renameThread(command.payload.threadId, command.payload.title);
        return { ...eventMetadata(command.correlationId, thread.id), event: "thread.renamed", payload: { thread } };
      }
      case "thread.profile.select":
        return selectThreadProfile(command.correlationId, command.payload.threadId, command.payload.profileId);
      case "thread.profile.change.resolve":
        return resolveThreadProfileChange(command.correlationId, command.payload);
      case "thread.output.location.choose": {
        if (turnExecution!.isThreadActive(command.payload.threadId)) {
          return diagnostic(command.correlationId, "HOST_FAILURE", "Stop the active Turn before changing its Output Location.");
        }
        const thread = stateStore.getThread(command.payload.threadId);
        if (thread === undefined || thread.scope !== "unscoped") throw new Error("Unscoped Thread not found");
        let outputLocation = process.env.VC_AGENT_TEST_OUTPUT_LOCATION;
        if (outputLocation === undefined) {
          const selection = await dialog.showOpenDialog(mainWindow!, {
            title: "Choose Output Location",
            ...(thread.outputLocation === undefined ? {} : { defaultPath: thread.outputLocation }),
            properties: ["openDirectory", "createDirectory"]
          });
          outputLocation = selection.canceled ? undefined : selection.filePaths[0];
        }
        if (outputLocation === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Output Location selection was cancelled.");
        const absolute = resolve(outputLocation);
        if (!isAbsolute(absolute) || !existsSync(absolute) || !statSync(absolute).isDirectory()) {
          return diagnostic(command.correlationId, "HOST_FAILURE", "The selected Output Location is not an existing directory.");
        }
        const updated = stateStore.setThreadOutputLocation(thread.id, absolute);
        return { ...eventMetadata(command.correlationId, thread.id), event: "thread.output.location.selected", payload: { thread: updated } };
      }
      case "turn.submit":
        return submitOrQueueTurn(command.correlationId, command.payload);
      case "execution_queue.list":
        return executionQueueEvent(command.correlationId);
      case "execution_queue.update":
        stateStore.updateExecutionQueueItem(command.payload.itemId, command.payload.text);
        return executionQueueEvent(command.correlationId);
      case "execution_queue.cancel":
        if (!stateStore.cancelExecutionQueueItem(command.payload.itemId)) return diagnostic(command.correlationId, "HOST_FAILURE", "Execution Queue item not found.");
        return executionQueueEvent(command.correlationId);
      case "execution_queue.activate": {
        stateStore.reactivateExecutionQueueItem(command.payload.itemId);
        drainExecutionQueue(command.correlationId);
        return executionQueueEvent(command.correlationId);
      }
      case "execution_queue.reorder":
        stateStore.reorderExecutionQueueItem(command.payload.itemId, command.payload.beforeItemId);
        return executionQueueEvent(command.correlationId);
      case "thread.compact":
        return compactThread(command.correlationId, command.payload.threadId);
      case "turn.stop": {
        const context = turnExecution!.getTurn(command.payload.turnId);
        if (context === undefined || context.threadId !== command.payload.threadId) {
          return diagnostic(command.correlationId, "HOST_FAILURE", "The requested Turn is not active.");
        }
        inflight.flush(context.turnId);
        workerSupervisor.stop({
          schemaVersion: 1,
          command: "turn.stop",
          commandId: randomUUID(),
          correlationId: command.correlationId,
          threadId: context.threadId,
          turnId: context.turnId
        });
        return { ...eventMetadata(command.correlationId, context.threadId), event: "turn.stop.requested", payload: { threadId: context.threadId, turnId: context.turnId } };
      }
      case "sub_agent.run.authorize": {
        if (command.actor.actorType !== "user" || subAgentRuntime === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Sub-Agent delegation requires explicit User action and an initialized Host runtime.");
        try {
          const parentThread = stateStore.getThread(command.payload.parentThreadId);
          if (parentThread === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Sub-Agent delegation requires an existing parent Thread.");
          for (const task of command.payload.tasks) {
            if (parentThread.scope === "project" && (task.contextBoundary.scope !== "project" || task.contextBoundary.projectId !== parentThread.projectId)) return diagnostic(command.correlationId, "HOST_FAILURE", "Project Sub-Agent tasks must remain inside the parent Project scope.");
            if (parentThread.scope === "unscoped" && task.contextBoundary.scope !== "unscoped") return diagnostic(command.correlationId, "HOST_FAILURE", "Unscoped Sub-Agent tasks cannot acquire Project scope.");
            if (parentThread.scope === "project" && task.profileId !== undefined && !stateStore.isProjectProfileAuthorized(parentThread.projectId, task.profileId)) return diagnostic(command.correlationId, "HOST_FAILURE", "The requested Sub-Agent Model Profile is not authorized in the parent Project.");
          }
          const projection = subAgentRuntime.authorize(command.payload);
          return { ...eventMetadata(command.correlationId, projection.run.parentThreadId), event: "sub_agent.run.authorized", payload: { projection } };
        } catch (error) {
          return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Sub-Agent run could not be authorized.");
        }
      }
      case "sub_agent.run.list": {
        if (subAgentRuntime === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Sub-Agent runtime is unavailable.");
        return { ...eventMetadata(command.correlationId), event: "sub_agent.runs.listed", payload: { projections: subAgentRuntime.listRunProjections() } };
      }
      case "sub_agent.run.inspect": {
        const projection = subAgentRuntime?.inspect(command.payload.runId);
        return projection === undefined ? diagnostic(command.correlationId, "HOST_FAILURE", "Sub-Agent run not found.") : { ...eventMetadata(command.correlationId, projection.run.parentThreadId), event: "sub_agent.run.inspected", payload: { projection } };
      }
      case "sub_agent.task.inspect": {
        const projection = subAgentRuntime?.inspectTask(command.payload.runId, command.payload.taskId);
        return projection === undefined ? diagnostic(command.correlationId, "HOST_FAILURE", "Sub-Agent task not found.") : { ...eventMetadata(command.correlationId, projection.run.parentThreadId), event: "sub_agent.task.inspected", payload: { projection } };
      }
      case "sub_agent.run.stop": {
        if (command.actor.actorType !== "user" || subAgentRuntime === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Stopping a Sub-Agent run requires explicit User action.");
        const projection = subAgentRuntime.stop(command.payload.runId, command.payload.reason);
        return projection === undefined ? diagnostic(command.correlationId, "HOST_FAILURE", "Sub-Agent run not found.") : { ...eventMetadata(command.correlationId, projection.run.parentThreadId), event: "sub_agent.run.stopped", payload: { projection } };
      }
      case "sub_agent.task.retry": {
        if (command.actor.actorType !== "user" || subAgentRuntime === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Retrying a Sub-Agent task requires explicit User action.");
        try {
          const projection = subAgentRuntime.retry(command.payload.taskId);
          return projection === undefined ? diagnostic(command.correlationId, "HOST_FAILURE", "Sub-Agent task not found.") : { ...eventMetadata(command.correlationId, projection.run.parentThreadId), event: "sub_agent.task.retry", payload: { projection } };
        } catch (error) { return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Sub-Agent task could not be retried."); }
      }
      case "sub_agent.task.skip": {
        if (command.actor.actorType !== "user" || subAgentRuntime === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Skipping a Sub-Agent task requires explicit User action.");
        const projection = subAgentRuntime.skip(command.payload.taskId);
        return projection === undefined ? diagnostic(command.correlationId, "HOST_FAILURE", "Sub-Agent task not found.") : { ...eventMetadata(command.correlationId, projection.run.parentThreadId), event: "sub_agent.task.skipped", payload: { projection } };
      }
      case "sub_agent.handoff.adopt": {
        if (command.actor.actorType !== "user" || subAgentRuntime === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Adopting a Sub-Agent handoff requires explicit User action.");
        try {
          const projection = subAgentRuntime.adoptHandoff(command.payload.taskId);
          return projection === undefined ? diagnostic(command.correlationId, "HOST_FAILURE", "Sub-Agent task not found.") : { ...eventMetadata(command.correlationId, projection.run.parentThreadId), event: "sub_agent.handoff.adopted", payload: { projection } };
        } catch (error) { return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Sub-Agent handoff could not be adopted."); }
      }
      case "sub_agent.handoff.reject": {
        if (command.actor.actorType !== "user" || subAgentRuntime === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Rejecting a Sub-Agent handoff requires explicit User action.");
        try {
          const projection = subAgentRuntime.rejectHandoff(command.payload.taskId);
          return projection === undefined ? diagnostic(command.correlationId, "HOST_FAILURE", "Sub-Agent task not found.") : { ...eventMetadata(command.correlationId, projection.run.parentThreadId), event: "sub_agent.handoff.rejected", payload: { projection } };
        } catch (error) { return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Sub-Agent handoff could not be rejected."); }
      }
      case "sub_agent.record.delete": {
        if (command.actor.actorType !== "user" || subAgentRuntime === null || command.payload.confirmed !== true) return diagnostic(command.correlationId, "HOST_FAILURE", "Deleting Sub-Agent records requires explicit User confirmation.");
        const projection = subAgentRuntime.deleteRecord(command.payload.runId, command.payload.taskId);
        return projection === undefined ? diagnostic(command.correlationId, "HOST_FAILURE", "Sub-Agent run not found.") : { ...eventMetadata(command.correlationId, projection.run.parentThreadId), event: "sub_agent.record.deleted", payload: { projection } };
      }
      case "capability.confirmation.resolve":
        return resolveCapabilityConfirmation(command.correlationId, command.payload.requestId, command.payload.approved);
    }
  } catch {
    return diagnostic(correlationId, "HOST_FAILURE", "The local Host could not complete the command.");
  }
}

async function openProject(correlationId: string): Promise<HostEvent> {
  let selectedPath = process.env.VC_AGENT_TEST_PROJECT_PATH;
  if (selectedPath === undefined) {
    const selection = await dialog.showOpenDialog(mainWindow!, { title: "Open Project", properties: ["openDirectory"] });
    selectedPath = selection.canceled ? undefined : selection.filePaths[0];
  }
  if (selectedPath === undefined) return diagnostic(correlationId, "HOST_FAILURE", "Project selection was cancelled.");
  const projectPath = resolve(selectedPath);
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    return diagnostic(correlationId, "HOST_FAILURE", "The selected Project path is not an existing directory.");
  }
  const marker = projectIdentities.read(projectPath) ?? projectIdentities.create(projectPath);
  const registeredAtPath = stateStore!.getProjectByPath(projectPath);
  if (registeredAtPath !== undefined && registeredAtPath.id !== marker.projectId) {
    return diagnostic(correlationId, "HOST_FAILURE", "The selected path is already registered to another Project Identity.");
  }
  const existing = stateStore!.getProject(marker.projectId);
  if (existing === undefined) {
    const project = stateStore!.registerProject({ id: marker.projectId, displayName: basename(projectPath), path: projectPath, createdAt: marker.createdAt });
    await refreshProjectInventory(correlationId, project.id, false);
    startMaterialWatcher(project.id);
    return { ...eventMetadata(correlationId), event: "project.opened", payload: { project } };
  }
  if (resolve(existing.path) === projectPath) {
    await refreshProjectInventory(correlationId, existing.id, false);
    startMaterialWatcher(existing.id);
    return { ...eventMetadata(correlationId), event: "project.opened", payload: { project: existing } };
  }
  const collisionId = randomUUID();
  pendingProjectCollisions.set(collisionId, { projectId: marker.projectId, existingPath: existing.path, selectedPath: projectPath });
  return {
    ...eventMetadata(correlationId),
    event: "project.identity.collision",
    payload: { collisionId, projectId: marker.projectId, existingPath: existing.path, selectedPath: projectPath }
  };
}

async function resolveProjectCollision(
  correlationId: string,
  collisionId: string,
  action: "moved_project" | "project_copy"
): Promise<HostEvent> {
  const collision = pendingProjectCollisions.get(collisionId);
  pendingProjectCollisions.delete(collisionId);
  if (collision === undefined) return diagnostic(correlationId, "HOST_FAILURE", "The Project Identity Collision is no longer active.");
  if (action === "moved_project") {
    const project = stateStore!.moveProject(collision.projectId, basename(collision.selectedPath), collision.selectedPath);
    await refreshProjectInventory(correlationId, project.id, false);
    startMaterialWatcher(project.id);
    return { ...eventMetadata(correlationId), event: "project.opened", payload: { project } };
  }
  const marker = projectIdentities.replaceForCopy(collision.selectedPath);
  const project = stateStore!.registerProject({ id: marker.projectId, displayName: basename(collision.selectedPath), path: collision.selectedPath, createdAt: marker.createdAt });
  await refreshProjectInventory(correlationId, project.id, false);
  startMaterialWatcher(project.id);
  return { ...eventMetadata(correlationId), event: "project.opened", payload: { project } };
}

async function refreshProjectInventory(correlationId: string, projectId: string, broadcast: boolean): Promise<HostEvent> {
  const project = stateStore!.getProject(projectId);
  if (project === undefined) throw new Error("Project not found");
  const previous = stateStore!.listMaterials(projectId).filter((item) => item.availability === "active");
  const records = await inventoryProjectFiles(project.path, previous);
  const refreshed = stateStore!.refreshMaterialInventory(projectId, records);
  const event: HostEvent = {
    ...eventMetadata(correlationId),
    event: broadcast ? "project.materials.updated" : "project.materials.listed",
    payload: broadcast
      ? { projectId, materials: refreshed.materials, changedMaterialIds: refreshed.changedMaterialIds }
      : { projectId, materials: refreshed.materials }
  } as HostEvent;
  if (broadcast && refreshed.changedMaterialIds.length > 0) emit(event);
  return event;
}

async function startProjectReflection(correlationId: string, input: { projectId: string; focus?: string | undefined; profileId?: string | undefined }): Promise<HostEvent> {
  const project = stateStore!.getProject(input.projectId);
  const promptRevision = stateStore!.getActiveSystemPromptRevision();
  if (project === undefined || promptRevision === undefined) return diagnostic(correlationId, "HOST_FAILURE", "Project or System Prompt is unavailable.");
  await refreshProjectInventory(correlationId, project.id, false);
  const context = projectContexts.rebuildIfExists(project.id, project.path);
  const brief = buildReflectionProjectBrief({
    projectId: project.id,
    context,
    materials: stateStore!.listMaterials(project.id),
    outputs: projectOutputs.list(project.id, project.path)
  });
  const assignment = stateStore!.getTaskModelAssignment("independent_evidence");
  const effectiveProfileId = input.profileId ?? assignment?.profileId;
  const profile = effectiveProfileId === undefined ? undefined : stateStore!.getModelProfile(effectiveProfileId);
  if (effectiveProfileId !== undefined && profile === undefined) return diagnostic(correlationId, "HOST_FAILURE", "The selected Independent Evidence Profile is unavailable.");
  const framing = reflectionFraming(input.focus ?? "");
  const run = stateStore!.createReflectionRun({
    scope: "project",
    projectId: project.id,
    framing,
    objective: framing === "retrospective" ? "Review this Project retrospectively against later evidence, subsequent developments, or observed outcomes." : DEFAULT_PROJECT_REFLECTION_OBJECTIVE,
    ...(input.focus?.trim() ? { focus: input.focus.trim() } : {}),
    brief,
    promptRevision,
    ...(profile === undefined ? {} : { independentProfileId: profile.id }),
    ...(input.profileId === undefined ? {} : { launchOverrideProfileId: input.profileId })
  });
  if (profile !== undefined) stateStore!.authorizeProjectProfile(project.id, profile.id, profile.provider);
  const thread = stateStore!.getThread(run.threadId);
  if (thread?.scope !== "project") throw new Error("Reflection Thread was not created");
  return { ...eventMetadata(correlationId, thread.id), event: "reflection.run.created", payload: { run, thread } };
}

async function startUnscopedReflection(correlationId: string, input: { threadId: string; focus?: string | undefined; profileId?: string | undefined }): Promise<HostEvent> {
  const sourceThread = stateStore!.getThread(input.threadId);
  const promptRevision = stateStore!.getActiveSystemPromptRevision();
  if (sourceThread?.scope !== "unscoped" || promptRevision === undefined || stateStore!.getReflectionRunByThread(sourceThread.id) !== undefined) {
    return diagnostic(correlationId, "HOST_FAILURE", "An ordinary Unscoped task and System Prompt are required.");
  }
  const userInputs = trajectoryStore!.loadEvents(sourceThread.id).flatMap((event) => event.event === "turn.submitted" ? [{ turnId: event.turnId, text: event.payload.text }] : []);
  const brief = buildReflectionUnscopedBrief({ sourceThreadId: sourceThread.id, userInputs });
  const assignment = stateStore!.getTaskModelAssignment("independent_evidence");
  const effectiveProfileId = input.profileId ?? assignment?.profileId;
  const profile = effectiveProfileId === undefined ? undefined : stateStore!.getModelProfile(effectiveProfileId);
  if (effectiveProfileId !== undefined && profile === undefined) return diagnostic(correlationId, "HOST_FAILURE", "The selected Independent Evidence Profile is unavailable.");
  const framing = reflectionFraming(`${input.focus ?? ""} ${userInputs.map((item) => item.text).join(" ")}`);
  const run = stateStore!.createReflectionRun({
    scope: "unscoped",
    sourceThreadId: sourceThread.id,
    framing,
    objective: framing === "retrospective" ? "Review this investment question retrospectively against later evidence, subsequent developments, or observed outcomes." : DEFAULT_UNSCOPED_REFLECTION_OBJECTIVE,
    ...(input.focus?.trim() ? { focus: input.focus.trim() } : {}),
    brief,
    promptRevision,
    ...(profile === undefined ? {} : { independentProfileId: profile.id }),
    ...(input.profileId === undefined ? {} : { launchOverrideProfileId: input.profileId })
  });
  const thread = stateStore!.getThread(run.threadId);
  if (thread?.scope !== "unscoped") throw new Error("Unscoped Reflection task was not created");
  return { ...eventMetadata(correlationId, thread.id), event: "reflection.run.created", payload: { run, thread } };
}

async function startIndependentAssessment(correlationId: string, runId: string, profileId?: string): Promise<HostEvent> {
  let run = stateStore!.getReflectionRun(runId);
  if (run === undefined) return diagnostic(correlationId, "HOST_FAILURE", "Reflection run not found.");
  if (run.status === "independent_completed" || run.status === "independent_running") {
    return { ...eventMetadata(correlationId, run.threadId), event: "reflection.run.updated", payload: { run } };
  }
  if (!executionScheduler!.hasCapacity()) return executionCapacityDiagnostic(correlationId, "Independent Evidence Pass");
  if (profileId !== undefined) run = stateStore!.selectReflectionProfile(run.id, profileId, true);
  const profile = run.independentProfileId === undefined ? undefined : stateStore!.getModelProfile(run.independentProfileId);
  if (profile === undefined) {
    return { ...eventMetadata(correlationId, run.threadId), event: "reflection.run.updated", payload: { run } };
  }
  const thread = stateStore!.getThread(run.threadId);
  const promptRevision = stateStore!.getSystemPromptRevision(run.promptSnapshot.revisionId);
  const project = run.scope === "project" ? stateStore!.getProject(run.projectId) : undefined;
  if (thread === undefined || thread.scope !== run.scope || (run.scope === "project" && project === undefined) || promptRevision?.hash !== run.promptSnapshot.hash) {
    return diagnostic(correlationId, "HOST_FAILURE", "The frozen Reflection scope or Prompt Snapshot is unavailable.");
  }
  const encrypted = stateStore!.getEncryptedCredential(profile.credentialRef);
  if (encrypted === undefined) return diagnostic(correlationId, "HOST_FAILURE", "The selected Independent Evidence credential is unavailable.");
  const turnId = randomUUID();
  const admission = executionScheduler!.admit({ id: turnId, scopeKey: run.threadId, kind: "independent_evidence" });
  if (!admission.admitted) return executionCapacityDiagnostic(correlationId, "Independent Evidence Pass");
  if (run.scope === "project") stateStore!.authorizeProjectProfile(run.projectId, profile.id, profile.provider);
  run = stateStore!.markReflectionRunning(run.id);
  const activeCapabilities = run.scope === "project" ? ["material_recall"] : ["web_search", "web_fetch"];
  const context: ReflectionExecutionContext = {
    correlationId,
    runId: run.id,
    threadId: run.threadId,
    turnId,
    scope: run.scope,
    ...(run.scope === "project" ? { projectId: run.projectId, outputLocation: join(project!.path, "outputs") } : thread.scope !== "unscoped" || thread.outputLocation === undefined ? {} : { outputLocation: thread.outputLocation }),
    activeCapabilities,
    profile,
    expectedStateVersion: thread.stateVersion,
    promptRevision
  };
  const createdAt = new Date().toISOString();
  const prompt = buildIndependentEvidencePrompt({ objective: run.objective, ...(run.focus === undefined ? {} : { focus: run.focus }), brief: run.brief, createdAt });
  const stageInstructions = run.scope === "project" ? INDEPENDENT_EVIDENCE_STAGE_INSTRUCTIONS : INDEPENDENT_UNSCOPED_EVIDENCE_STAGE_INSTRUCTIONS;
  const workerCommand: Extract<WorkerCommand, { command: "turn.execute" }> = {
    schemaVersion: 1,
    command: "turn.execute",
    commandId: randomUUID(),
    correlationId,
    threadId: run.threadId,
    turnId,
    cwd: run.scope === "project" ? project!.path : app.getPath("userData"),
    threadDirectory: trajectoryStore!.threadDirectory(run.threadId),
    contextHistory: [],
    estimatedInputTokens: estimateTokens(promptRevision.content) + estimateTokens(stageInstructions) + estimateTokens(prompt),
    currentInputTokens: estimateTokens(promptRevision.content) + estimateTokens(stageInstructions) + estimateTokens(prompt),
    activeCapabilities,
    expectedStateVersion: thread.stateVersion,
    executionScope: run.scope === "project" ? { kind: "project", projectId: run.projectId } : { kind: "unscoped", threadId: run.threadId },
    prompt,
    profile: toWorkerModelProfile(profile, credentials.decrypt(encrypted)),
    resources: { schemaVersion: 1, revisionId: promptRevision.id, systemPrompt: promptRevision.content, appendSystemPrompt: [stageInstructions] },
    extensions: extensionRuntimeSnapshot()
  };
  turnExecution!.start({ kind: "reflection", context }, workerCommand, () => failReflectionExecution(context, {
    kind: "worker", code: "WORKER_EXITED", message: "Agent Worker exited before the Independent Evidence Pass completed.", provider: profile.provider, model: profile.model
  }));
  return { ...eventMetadata(correlationId, run.threadId), event: "reflection.run.updated", payload: { run } };
}

function stopIndependentAssessment(correlationId: string, runId: string): HostEvent {
  const context = turnExecution!.findReflection(runId);
  const run = stateStore!.getReflectionRun(runId);
  if (run === undefined) return diagnostic(correlationId, "HOST_FAILURE", "Reflection run not found.");
  if (context !== undefined) {
    workerSupervisor?.stop({ schemaVersion: 1, command: "turn.stop", commandId: randomUUID(), correlationId: context.correlationId, threadId: context.threadId, turnId: context.turnId });
  }
  return { ...eventMetadata(correlationId, run.threadId), event: "reflection.run.updated", payload: { run } };
}

function startMemoryAwareReflection(correlationId: string, runId: string, profileId?: string): HostEvent {
  let run = stateStore!.getReflectionRun(runId);
  if (run === undefined || run.assessment === undefined) return diagnostic(correlationId, "HOST_FAILURE", "A completed Independent Assessment is required.");
  const assessment = run.assessment;
  if (run.status === "dialogue_active" || run.status === "memory_aware_running") {
    return { ...eventMetadata(correlationId, run.threadId), event: "reflection.run.updated", payload: { run } };
  }
  if (!executionScheduler!.hasCapacity()) return executionCapacityDiagnostic(correlationId, "Memory-Aware Reflection");
  const effectiveProfileId = profileId ?? stateStore!.getTaskModelAssignment("memory_aware_reflection")?.profileId ?? run.memoryAwareProfileId;
  const profile = effectiveProfileId === undefined ? undefined : stateStore!.getModelProfile(effectiveProfileId);
  if (profile === undefined) return { ...eventMetadata(correlationId, run.threadId), event: "reflection.run.updated", payload: { run } };
  const thread = stateStore!.getThread(run.threadId);
  const promptRevision = stateStore!.getSystemPromptRevision(run.promptSnapshot.revisionId);
  if (thread === undefined || thread.scope !== run.scope || promptRevision?.hash !== run.promptSnapshot.hash) return diagnostic(correlationId, "HOST_FAILURE", "The frozen Reflection scope or Prompt Snapshot is unavailable.");
  const turnId = randomUUID();
  run = stateStore!.startMemoryAwareReflection(run.id, profile.id, turnId);
  if (run.scope === "project") stateStore!.authorizeProjectProfile(run.projectId, profile.id, profile.provider);
  loadedPromptByThread.set(run.threadId, promptRevision);
  emitReflectionRun(correlationId, run);
  const workerPrompt = buildMemoryAwareReflectionPrompt({ objective: run.objective, ...(run.focus === undefined ? {} : { focus: run.focus }), brief: run.brief, assessment });
  return submitTurn(correlationId, { threadId: run.threadId, text: "Begin Memory-Aware Investment Reflection." }, {
    turnId,
    reflectionRun: run,
    workerPrompt,
    contextHistory: [],
    appendSystemPrompt: [MEMORY_AWARE_REFLECTION_INSTRUCTIONS],
    skipMemoryCandidate: true
  });
}

function startMaterialWatcher(projectId: string): void {
  const project = stateStore!.getProject(projectId);
  if (project === undefined) return;
  const current = materialWatchers.get(projectId);
  if (current !== undefined) {
    if (current.path === project.path) return;
    current.watcher.close();
    if (current.timer !== undefined) clearTimeout(current.timer);
    if (current.contextTimer !== undefined) clearTimeout(current.contextTimer);
    if (current.memoryTimer !== undefined) clearTimeout(current.memoryTimer);
  }
  try {
    const watcher = watch(project.path, { recursive: true }, (_eventType, filename) => {
      const state = materialWatchers.get(projectId);
      if (state === undefined) return;
      const relative = filename?.toString().replace(/\\/gu, "/").toLowerCase();
      if (relative === "outputs/system/project-context.md") {
        if (state.contextTimer !== undefined) clearTimeout(state.contextTimer);
        state.contextTimer = setTimeout(() => {
          const currentProject = stateStore?.getProject(projectId);
          if (currentProject === undefined) return;
          try {
            const document = projectContexts.rebuildIfExists(projectId, currentProject.path);
            if (document === undefined) return;
            if (ownProjectContextWrites.get(projectId) === document.sourceHash) {
              ownProjectContextWrites.delete(projectId);
              return;
            }
            emit({ ...eventMetadata(randomUUID()), event: "project.context.updated", payload: { document, source: "external_edit" } });
          } catch {
            // The next stable write or explicit load retries deterministic mirror rebuild.
          }
        }, 750);
      }
      if (relative === "outputs/system/project-memory.md") {
        if (state.memoryTimer !== undefined) clearTimeout(state.memoryTimer);
        state.memoryTimer = setTimeout(() => {
          const currentProject = stateStore?.getProject(projectId);
          if (currentProject === undefined || projectMemories === null) return;
          try {
            const document = projectMemories.rebuildIfExists(projectId, currentProject.path);
            if (document === undefined) return;
            if (ownProjectMemoryWrites.get(projectId) === document.sourceHash) { ownProjectMemoryWrites.delete(projectId); return; }
            emit({ ...eventMetadata(randomUUID()), event: "project.memory.updated", payload: { document, source: "external_edit" } });
            emit(dreamStateEvent(randomUUID()));
          } catch { /* The next stable write or explicit load retries index rebuild. */ }
        }, 750);
      }
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        void refreshProjectInventory(randomUUID(), projectId, true).catch(() => undefined);
      }, 750);
    });
    watcher.on("error", () => watcher.close());
    materialWatchers.set(projectId, { path: project.path, watcher });
  } catch {
    // A manual refresh remains available when recursive watching is unavailable.
  }
}

function startLongTermMemoryWatcher(): void {
  if (longTermMemoryWatcher !== null || longTermMemories === null || !existsSync(longTermMemories.rootPath)) return;
  try {
    longTermMemoryWatcher = watch(longTermMemories.rootPath, (_eventType, filename) => {
      if (filename?.toString().toLocaleLowerCase() !== "long-term-memory.md") return;
      if (longTermMemoryWatchTimer !== undefined) clearTimeout(longTermMemoryWatchTimer);
      longTermMemoryWatchTimer = setTimeout(() => {
        try {
          const document = longTermMemories?.refreshIfExists();
          if (document === undefined) return;
          if (ownLongTermMemoryWriteHash === document.sourceHash) {
            ownLongTermMemoryWriteHash = undefined;
            return;
          }
          emit({ ...eventMetadata(randomUUID()), event: "long_term_memory.updated", payload: { document, source: "external_edit" } });
          emit(dreamStateEvent(randomUUID()));
        } catch {
          // Manual refresh retries deterministic parsing after an unstable external write.
        }
      }, 750);
    });
    longTermMemoryWatcher.on("error", () => {
      longTermMemoryWatcher?.close();
      longTermMemoryWatcher = null;
    });
  } catch {
    longTermMemoryWatcher = null;
  }
}

async function parseMaterial(correlationId: string, materialId: string, refreshRequestId?: string): Promise<HostEvent> {
  let material = stateStore!.getMaterial(materialId);
  if (material === undefined || material.availability !== "active") return materialParseFailure(correlationId, materialId, "MATERIAL_UNAVAILABLE", "Material is unavailable.");
  const project = stateStore!.getProject(material.projectId);
  if (project === undefined) return materialParseFailure(correlationId, materialId, "PROJECT_UNAVAILABLE", "Project is unavailable.");
  await refreshProjectInventory(correlationId, project.id, false);
  material = stateStore!.getMaterial(materialId);
  if (material === undefined || material.availability !== "active") return materialParseFailure(correlationId, materialId, "MATERIAL_UNAVAILABLE", "Material changed before parsing started.");
  if (material.parseStatus === "stale" && refreshRequestId === undefined) return materialParseFailure(correlationId, materialId, "PARSE_REFRESH_CHOICE_REQUIRED", "Choose how to refresh the stale parse before continuing.");
  const expectedParser = expectedParserIdentity(material.extension);
  if (expectedParser === undefined) return materialParseFailure(correlationId, materialId, "PARSER_UNAVAILABLE", "No baseline parser is registered for this Material.");
  const reusable = stateStore!.getReusableParsedMaterial(materialId, expectedParser);
  if (refreshRequestId === undefined && reusable !== undefined && existsSync(join(project.path, reusable.artifact_path))) {
    return { ...eventMetadata(correlationId), event: "material.parse.completed", payload: { material, parseId: reusable.id, parserId: reusable.parser_id, artifactPath: reusable.artifact_path, warningCount: 0, reused: true } };
  }

  const jobId = randomUUID();
  const stagingDirectory = join(project.path, "outputs", "parsed", ".staging", jobId);
  emit({ ...eventMetadata(correlationId), event: "material.parse.started", payload: { materialId, jobId } });
  const result = await utilityJobRunner!.run({
    schemaVersion: 1, command: "material.parse", jobId,
    material: { id: material.id, projectId: material.projectId, relativePath: material.relativePath, mediaType: material.mediaType, sourceHash: material.sourceHash, absolutePath: join(project.path, material.relativePath) },
    stagingDirectory, timeoutMs: 120_000, maxOutputBytes: 50_000_000
  });
  if (result.event === "material.parse.failed") {
    if (refreshRequestId !== undefined) stateStore!.failParseRefreshRequest(refreshRequestId, result.message);
    removeStaging(stagingDirectory, project.path);
    return materialParseFailure(correlationId, materialId, result.code, result.message);
  }
  const parserId = `${result.parse.parser.id}@${result.parse.parser.version}`;
  if (parserId !== expectedParser) {
    if (refreshRequestId !== undefined) stateStore!.failParseRefreshRequest(refreshRequestId, "Parser identity did not match the registered adapter.");
    removeStaging(stagingDirectory, project.path);
    return materialParseFailure(correlationId, materialId, "PARSER_IDENTITY_MISMATCH", "Parser identity did not match the registered adapter.");
  }
  const concurrentlyCompleted = refreshRequestId === undefined ? stateStore!.getReusableParsedMaterial(materialId, expectedParser) : undefined;
  if (concurrentlyCompleted !== undefined && existsSync(join(project.path, concurrentlyCompleted.artifact_path))) {
    removeStaging(stagingDirectory, project.path);
    return { ...eventMetadata(correlationId), event: "material.parse.completed", payload: { material, parseId: concurrentlyCompleted.id, parserId: concurrentlyCompleted.parser_id, artifactPath: concurrentlyCompleted.artifact_path, warningCount: 0, reused: true } };
  }
  await refreshProjectInventory(correlationId, project.id, false);
  const current = stateStore!.getMaterial(materialId);
  if (current?.sourceHash !== result.parse.material.sourceHash) {
    if (refreshRequestId !== undefined) stateStore!.failParseRefreshRequest(refreshRequestId, "Source changed while parsing.");
    removeStaging(stagingDirectory, project.path);
    return materialParseFailure(correlationId, materialId, "SOURCE_CHANGED_DURING_PARSE", "Source changed while parsing; retry from the current version.");
  }

  const relativeArtifactPath = `outputs/parsed/${material.id}/${result.parse.parseId}/parse.json`;
  const finalDirectory = join(project.path, dirname(relativeArtifactPath));
  mkdirSync(dirname(finalDirectory), { recursive: true });
  let replacedArtifactPath: string | undefined;
  try {
    renameSync(stagingDirectory, finalDirectory);
    if (refreshRequestId === undefined) stateStore!.recordParsedMaterialVersion(materialId, parserId, relativeArtifactPath, result.parse.parseId);
    else ({ replacedArtifactPath } = stateStore!.completeParseRefresh(refreshRequestId, result.parse.parseId, parserId, relativeArtifactPath));
  } catch (error) {
    removeParsedArtifact(project.path, relativeArtifactPath);
    if (refreshRequestId !== undefined) {
      try { stateStore!.failParseRefreshRequest(refreshRequestId, error instanceof Error ? error.message : "Parse commit failed"); } catch { /* request may already be completed */ }
    }
    return materialParseFailure(correlationId, materialId, "PARSE_COMMIT_FAILED", "Parsed artifact could not be committed.");
  }
  let registryWarning = 0;
  try { recordParsedArtifact(project.path, result.parse.parseId, material, parserId, relativeArtifactPath, result.parse.warnings.length); }
  catch { registryWarning = 1; }
  if (replacedArtifactPath !== undefined) removeParsedArtifact(project.path, replacedArtifactPath);
  const updated = stateStore!.getMaterial(materialId)!;
  return { ...eventMetadata(correlationId), event: "material.parse.completed", payload: { material: updated, parseId: result.parse.parseId, parserId, artifactPath: relativeArtifactPath, warningCount: result.parse.warnings.length + registryWarning, reused: false } };
}

function materialParseFailure(correlationId: string, materialId: string, code: string, message: string): HostEvent {
  return { ...eventMetadata(correlationId), event: "material.parse.failed", payload: { materialId, code, message } };
}

function removeStaging(stagingDirectory: string, projectPath: string): void {
  const root = resolve(projectPath, "outputs", "parsed", ".staging");
  const target = resolve(stagingDirectory);
  if (target.startsWith(`${root}${sep}`)) rmSync(target, { recursive: true, force: true });
}

function removeParsedArtifact(projectPath: string, artifactPath: string): void {
  const root = resolve(projectPath, "outputs", "parsed");
  const target = resolve(projectPath, artifactPath);
  if (target.startsWith(`${root}${sep}`)) rmSync(dirname(target), { recursive: true, force: true });
}

function recordParsedArtifact(projectPath: string, parseId: string, material: MaterialInventoryItem, parserId: string, artifactPath: string, warningCount: number): void {
  const registryPath = join(projectPath, "outputs", "system", "artifacts.jsonl");
  mkdirSync(dirname(registryPath), { recursive: true });
  appendFileSync(registryPath, `${JSON.stringify({
    schemaVersion: 1, id: parseId, type: "canonical_parse", path: artifactPath,
    source: { materialId: material.id, relativePath: material.relativePath, sourceHash: material.sourceHash },
    parserId, warningCount, producer: "utility-worker", createdAt: new Date().toISOString()
  })}\n`, "utf8");
}

function selectThreadProfile(correlationId: string, threadId: string, profileId: string): HostEvent {
  const thread = stateStore!.getThread(threadId);
  const requested = stateStore!.getModelProfile(profileId);
  if (thread === undefined || requested === undefined) throw new Error("Thread or Profile not found");
  if (turnExecution!.isThreadActive(threadId)) return diagnostic(correlationId, "HOST_FAILURE", "Stop the active Turn before changing its Model Profile.");
  const previous = trajectoryStore!.lastProfile(threadId);
  if (previous !== undefined && previous.provider !== requested.provider) {
    return {
      ...eventMetadata(correlationId, threadId),
      event: "thread.profile.change.required",
      payload: {
        threadId,
        currentProfile: previous,
        requestedProfile: toTrajectoryProfile(requested),
        retainedContext: "visible-retained-trajectory"
      }
    };
  }
  const selected = stateStore!.selectThreadProfile(threadId, profileId);
  authorizeProjectProfile(selected, requested);
  if (previous !== undefined && (previous.provider !== requested.provider || previous.model !== requested.model)) loadedPromptByThread.delete(threadId);
  return { ...eventMetadata(correlationId, threadId), event: "thread.profile.selected", payload: { thread: selected } };
}

function resolveThreadProfileChange(
  correlationId: string,
  input: { threadId: string; profileId: string; action: "continue_current_thread" | "start_new_thread" }
): HostEvent {
  const source = stateStore!.getThread(input.threadId);
  const requested = stateStore!.getModelProfile(input.profileId);
  const previous = trajectoryStore!.lastProfile(input.threadId);
  if (source === undefined || requested === undefined || previous === undefined) throw new Error("Profile change is stale");
  if (turnExecution!.isThreadActive(input.threadId)) return diagnostic(correlationId, "HOST_FAILURE", "Stop the active Turn before changing its Model Profile.");

  let destination = source;
  let retainedContext: "visible-retained-trajectory" | "none" = "visible-retained-trajectory";
  if (input.action === "start_new_thread") {
    destination = source.scope === "project"
      ? stateStore!.createProjectThread(source.projectId, `${source.title} - ${requested.provider}`)
      : stateStore!.createUnscopedThread(`${source.title} - ${requested.provider}`);
    destination = stateStore!.selectThreadProfile(destination.id, requested.id);
    retainedContext = "none";
  } else {
    destination = stateStore!.selectThreadProfile(source.id, requested.id);
  }
  authorizeProjectProfile(destination, requested);
  loadedPromptByThread.delete(destination.id);

  const record: TrajectoryEvent = {
    ...trajectoryMetadata(correlationId, source.id, randomUUID(), USER_ACTOR, USER_PROVENANCE),
    event: "provider_continuation.authorized",
    payload: {
      previousProvider: previous.provider,
      previousModel: previous.model,
      nextProvider: requested.provider,
      nextModel: requested.model,
      action: input.action,
      destinationThreadId: destination.id,
      retainedContext
    }
  };
  trajectoryStore!.append(record);
  return {
    ...ipcMetadata(record),
    event: "thread.profile.change.resolved",
    payload: { sourceThreadId: source.id, thread: destination, profile: requested, action: input.action, retainedContext }
  };
}

function authorizeProjectProfile(thread: Thread, profile: ModelProfile): void {
  if (thread.scope === "project") stateStore!.authorizeProjectProfile(thread.projectId, profile.id, profile.provider);
}

function submitTurn(
  correlationId: string,
  input: { threadId: string; text: string; retryOfTurnId?: string | undefined },
  options: { turnId?: string; reflectionRun?: ReflectionRun; workerPrompt?: string; contextHistory?: ReturnType<ThreadTrajectoryStore["contextHistory"]>; appendSystemPrompt?: readonly string[]; skipMemoryCandidate?: boolean } = {}
): HostEvent {
  const turnId = options.turnId ?? randomUUID();
  const thread = stateStore!.getThread(input.threadId);
  if (thread === undefined) throw new Error("Thread not found");
  if (turnExecution!.isThreadActive(input.threadId)) {
    return diagnostic(correlationId, "HOST_FAILURE", "This Thread already has an active Turn.");
  }
  if (!executionScheduler!.hasCapacity()) return executionCapacityDiagnostic(correlationId, "Turn");
  const reflectionRun = options.reflectionRun ?? stateStore!.getReflectionRunByThread(input.threadId);
  if (reflectionRun !== undefined && options.reflectionRun === undefined && reflectionRun.status !== "dialogue_active") return diagnostic(correlationId, "HOST_FAILURE", "Complete or explicitly resume the Reflection workflow before continuing its dialogue.");
  const fileDownloadIntent = reflectionRun === undefined && detectFileDownloadIntent(input.text);
  const outputIntent = reflectionRun === undefined && (detectOutputIntent(input.text) || fileDownloadIntent);
  const textEditIntent = reflectionRun === undefined && detectTextEditIntent(input.text);
  const memoryRecallMode = reflectionRun !== undefined ? detectExplicitMemoryRecallIntent(input.text) ? "explicit" : "automatic" : detectExplicitMemoryRecallIntent(input.text) ? "explicit" : detectJudgmentHeavyIntent(input.text) ? "automatic" : "none";
  const effectiveProfileId = reflectionRun?.memoryAwareProfileId ?? thread.activeProfileId;
  const profile = effectiveProfileId === undefined ? undefined : stateStore!.getModelProfile(effectiveProfileId);
  const reflectionOutcomeIntent = reflectionRun !== undefined && detectReflectionOutcomeIntent(input.text);
  const academicWorkflow = reflectionRun === undefined ? academicWorkflowPrototype(input.text) : undefined;
  const runtimeSkills = runtimeSkillsForTask(input.text, thread.scope);
  const academicWorkflowLoaded = academicWorkflow !== undefined
    && runtimeSkills.decisions.some((decision) => decision.packageId === academicWorkflow.id);
  const effectiveAppendSystemPrompt = options.appendSystemPrompt
    ?? (reflectionRun === undefined
      ? academicWorkflow === undefined || academicWorkflowLoaded ? [] : [academicWorkflow.instructions]
      : [MEMORY_AWARE_REFLECTION_INSTRUCTIONS]);
  const preloadHints = reflectionRun === undefined
    ? [
        ...capabilitiesForTurn({
        scope: thread.scope,
        materialRecall: detectMaterialRecallIntent(input.text),
        projectStateRecall: detectProjectStateRecallIntent(input.text),
        memoryRecall: memoryRecallMode !== "none",
        webResearch: detectWebResearchIntent(input.text),
        outputWrite: outputIntent && !textEditIntent && !fileDownloadIntent
      }),
        ...(fileDownloadIntent ? ["file_download"] : []),
        ...(textEditIntent ? ["output.edit_text"] : []),
        ...(detectAcademicResearchIntent(input.text) ? ["academic_research"] : []),
        ...(thread.scope === "project" && detectProjectCommandIntent(input.text) ? ["project.command"] : []),
        ...(thread.scope === "project" ? PROJECT_READ_TOOL_NAMES : [])
      ]
    : [];
  const fixedCapabilityIds = reflectionRun === undefined
    ? []
    : [...(thread.scope === "project" ? ["memory_recall", "reflection_evidence_drilldown", "project_state_recall"] : ["memory_recall"]), ...(reflectionOutcomeIntent ? ["reflection_outcome_propose"] : [])];
  const capabilityInventory = [...capabilityRegistry!.inventory(), ...PROJECT_READ_TOOL_METADATA];
  const capabilitySurface = createTurnCapabilitySurface({
    kind: reflectionRun === undefined ? "ordinary" : "reflection_dialogue",
    scope: thread.scope,
    inventory: capabilityInventory,
    preloadHints,
    fixedCapabilityIds,
    outputRequested: outputIntent,
    outputCreateRequested: outputIntent && !textEditIntent && !fileDownloadIntent,
    explicitMemoryRecall: memoryRecallMode === "explicit",
    availability: {
      materials: thread.scope === "project" && stateStore!.listMaterials(thread.projectId).length > 0,
      projectContext: thread.scope === "project",
      publicWeb: capabilityRegistry!.get("web_search") !== undefined && capabilityRegistry!.get("web_fetch") !== undefined,
      directAttachments: false
    }
  });
  const activeCapabilities = [...capabilitySurface.visibleCapabilityIds];
  const physical = stateStore!.getPhysicalContext(input.threadId);
  if (physical?.sessionFile !== undefined && !existsSync(physical.sessionFile)) loadedPromptByThread.delete(input.threadId);
  const promptRevision = reflectionRun === undefined ? loadedPromptByThread.get(input.threadId) ?? stateStore!.getActiveSystemPromptRevision() : stateStore!.getSystemPromptRevision(reflectionRun.promptSnapshot.revisionId);
  if (promptRevision === undefined) throw new Error("System Prompt is not initialized");
  const crossesPromptBoundary = !loadedPromptByThread.has(input.threadId);
  const contextHistory = options.contextHistory ?? trajectoryStore!.contextHistory(input.threadId);
  const workerPrompt = options.workerPrompt ?? input.text;
  const toolSchemaText = JSON.stringify(capabilityInventory.filter((item) => activeCapabilities.includes(item.id)).map((item) => item.inputSchema));
  const budget = contextBudgetService.telemetry({
    systemPromptBytes: Buffer.byteLength(promptRevision.content, "utf8"),
    toolSchemaBytes: Buffer.byteLength(toolSchemaText, "utf8"),
    taskBytes: Buffer.byteLength(`${workerPrompt}\n${effectiveAppendSystemPrompt.join("\n")}\n${runtimeSkills.instructions.map((instruction) => instruction.content).join("\n")}`, "utf8"),
    retainedHistoryBytes: Buffer.byteLength(JSON.stringify(contextHistory), "utf8"),
    retrievalBytes: 0,
    contextWindowTokens: profile?.contextWindow ?? Number.MAX_SAFE_INTEGER,
    reservedOutputTokens: profile?.maxOutputTokens ?? 2_048
  });
  const budgetTelemetry = {
    estimatorRevision: contextBudgetService.estimatorRevision,
    safetyMarginTokens: contextBudgetService.safetyMarginTokens,
    usableContextTokens: budget.usableContextTokens,
    estimatedInputTokens: budget.estimatedInputTokens,
    action: budget.action
  } as const;
  const promptTelemetry = {
    revisionId: promptRevision.id,
    hash: promptRevision.hash,
    contributions: {
      promptEstimatedTokens: estimateTokens(promptRevision.content),
      toolSchemaEstimatedTokens: activeCapabilities.length === 0 ? 0 : estimateTokens(toolSchemaText),
      taskEstimatedTokens: estimateTokens(workerPrompt) + estimateTokens(effectiveAppendSystemPrompt.join("\n")),
      contextEstimatedTokens: contextHistory.length === 0 ? 0 : estimateTokens(JSON.stringify(contextHistory)),
      recalledStateEstimatedTokens: 0,
      outputReserveEstimatedTokens: 2_048,
      skillEstimatedTokens: estimateTokens(runtimeSkills.instructions.map((instruction) => instruction.content).join("\n")),
      materialEstimatedTokens: 0,
      contextBudget: budgetTelemetry
    },
    capabilitySurface: {
      revision: capabilitySurface.revision,
      visibleCapabilityIds: [...capabilitySurface.visibleCapabilityIds],
      requestableCapabilityCount: capabilitySurface.requestableCatalog.length,
      initialToolSchemaEstimatedTokens: capabilitySurface.initialToolSchemaEstimatedTokens,
      preloadHintCount: preloadHints.length
    }
  };
  const dreamEligibility = reflectionRun?.status === "dialogue_active" ? detectReflectionDreamEligibility(input.text) : undefined;
  const submitted: TrajectoryEvent = {
    ...trajectoryMetadata(correlationId, input.threadId, turnId, USER_ACTOR, USER_PROVENANCE),
    event: "turn.submitted",
    payload: {
      text: input.text,
      idempotencyKey: randomUUID(),
      ...(input.retryOfTurnId === undefined ? {} : { retryOfTurnId: input.retryOfTurnId }),
      ...(dreamEligibility === undefined ? {} : { dreamEligibility }),
      ...(profile === undefined ? {} : { profile: toTrajectoryProfile(profile) }),
      prompt: promptTelemetry
    }
  };
  trajectoryStore!.append(submitted);
  const memorySignal = dreamEligibility === undefined ? detectMemoryCandidateSignal(input.text) : `reflection_${dreamEligibility.signal}` as const;
  if (memorySignal !== undefined && input.retryOfTurnId === undefined && memoryCandidates !== null && options.skipMemoryCandidate !== true) {
    const candidate = memoryCandidates.capture({ scope: thread.scope, ...(thread.scope === "project" ? { projectId: thread.projectId } : {}), threadId: thread.id, turnId, sourceSnippet: input.text.slice(0, 2_000), sourceKind: reflectionRun?.status === "dialogue_active" ? "reflection_dialogue" : "ordinary_user_signal", signal: memorySignal });
    synchronizeDreamSchedulingIndex();
    emit({ ...eventMetadata(correlationId, thread.id), event: "memory.candidate.captured", payload: { candidate } });
  }

  if (outputIntent && thread.scope === "unscoped" && thread.outputLocation === undefined) {
    const failure: ProviderFailure = { kind: "configuration", code: "OUTPUT_LOCATION_NOT_CONFIGURED", message: "Choose an Output Location before creating a file." };
    const failed: TrajectoryEvent = {
      ...trajectoryMetadata(correlationId, input.threadId, turnId, HOST_ACTOR, HOST_PROVENANCE),
      event: "turn.failed",
      payload: { ...(profile === undefined ? {} : { profile: toTrajectoryProfile(profile) }), failure }
    };
    trajectoryStore!.append(failed);
    return {
      ...ipcMetadata(failed),
      event: "turn.failed",
      payload: { threadId: input.threadId, turnId, text: input.text, ...(input.retryOfTurnId === undefined ? {} : { retryOfTurnId: input.retryOfTurnId }), ...(profile === undefined ? {} : { profile }), failure }
    };
  }

  if (profile === undefined) {
    const failure: ProviderFailure = { kind: "configuration", code: "MODEL_PROFILE_NOT_CONFIGURED", message: "Model Profile not configured" };
    const failed: TrajectoryEvent = {
      ...trajectoryMetadata(correlationId, input.threadId, turnId, HOST_ACTOR, HOST_PROVENANCE),
      event: "turn.failed",
      payload: { failure }
    };
    trajectoryStore!.append(failed);
    return {
      ...ipcMetadata(failed),
      event: "turn.failed",
      payload: { threadId: input.threadId, turnId, text: input.text, ...(input.retryOfTurnId === undefined ? {} : { retryOfTurnId: input.retryOfTurnId }), failure }
    };
  }

  if (thread.scope === "project" && !stateStore!.isProjectProfileAuthorized(thread.projectId, profile.id)) {
    const failure: ProviderFailure = { kind: "configuration", code: "PROJECT_PROVIDER_NOT_AUTHORIZED", message: "Select this Model Profile in the Project Thread to authorize its Provider." };
    const failed: TrajectoryEvent = {
      ...trajectoryMetadata(correlationId, input.threadId, turnId, HOST_ACTOR, HOST_PROVENANCE),
      event: "turn.failed",
      payload: { profile: toTrajectoryProfile(profile), failure }
    };
    trajectoryStore!.append(failed);
    return { ...ipcMetadata(failed), event: "turn.failed", payload: { threadId: input.threadId, turnId, text: input.text, profile, failure } };
  }

  if (crossesPromptBoundary) {
    loadedPromptByThread.set(input.threadId, promptRevision);
    if (physical?.promptRevisionId !== undefined && physical.promptRevisionId !== promptRevision.id) {
      const updated: TrajectoryEvent = {
        ...trajectoryMetadata(correlationId, input.threadId, turnId, HOST_ACTOR, HOST_PROVENANCE),
        event: "system_prompt.updated",
        payload: { previousRevisionId: physical.promptRevisionId, nextRevisionId: promptRevision.id }
      };
      trajectoryStore!.append(updated);
      emit({ ...ipcMetadata(updated), event: "system_prompt.updated", payload: { threadId: input.threadId, turnId, ...updated.payload } });
    }
  }

  const encrypted = stateStore!.getEncryptedCredential(profile.credentialRef);
  if (encrypted === undefined) throw new Error("Credential reference is unavailable");
  const context: TurnContext = {
    correlationId,
    threadId: input.threadId,
    turnId,
    text: input.text,
    profile,
    outputIntent,
    memoryRecallMode,
    reflectionOutcomeIntent,
    longTermMemoryCardIds: new Set(),
    activeCapabilities,
    executableCapabilityIds: [...capabilitySurface.executableCapabilityIds],
    capabilitySurface,
    expectedStateVersion: thread.stateVersion,
    promptRevision,
    submittedAtMs: Date.now(),
    recalledStateEstimatedTokens: 0,
    recallBodyBytes: 0,
    capabilityActivationCount: 0,
    ...(reflectionRun === undefined ? {} : { reflectionRunId: reflectionRun.id }),
    ...(effectiveAppendSystemPrompt.length === 0 ? {} : { appendSystemPrompt: effectiveAppendSystemPrompt }),
    ...(input.retryOfTurnId === undefined ? {} : { retryOfTurnId: input.retryOfTurnId })
  };
  const admission = executionScheduler!.admit({ id: turnId, scopeKey: input.threadId, kind: options.reflectionRun?.status === "memory_aware_running" ? "memory_aware_reflection" : "ordinary_turn" });
  if (!admission.admitted) return executionCapacityDiagnostic(correlationId, "Turn");
  inflight!.begin({
    schemaVersion: 1,
    checkpointId: randomUUID(),
    interruptionEventId: randomUUID(),
    correlationId,
    threadId: input.threadId,
    turnId,
    profile: toTrajectoryProfile(profile),
    partialMessage: "",
    startedTools: [],
    lastWorkerSequence: 0,
    lastHostSequence: submitted.sequence,
    updatedAt: new Date().toISOString()
  });

  const workerCommand: Extract<WorkerCommand, { command: "turn.execute" }> = {
    schemaVersion: 1,
    command: "turn.execute",
    commandId: randomUUID(),
    correlationId,
    threadId: input.threadId,
    turnId,
    cwd: thread.scope === "project" ? stateStore!.getProject(thread.projectId)!.path : app.getPath("userData"),
    threadDirectory: trajectoryStore!.threadDirectory(input.threadId),
    ...(physical?.sessionFile === undefined ? {} : { previousSessionFile: physical.sessionFile }),
    ...(trajectoryStore!.highWater(input.threadId) === undefined ? {} : { hostHighWater: trajectoryStore!.highWater(input.threadId)! }),
    contextHistory,
    contextBudget: budgetTelemetry,
    estimatedInputTokens: budget.estimatedInputTokens,
    currentInputTokens: promptTelemetry.contributions.promptEstimatedTokens + promptTelemetry.contributions.toolSchemaEstimatedTokens + promptTelemetry.contributions.taskEstimatedTokens,
    capabilitySurface,
    activeCapabilities: [...context.activeCapabilities],
    expectedStateVersion: context.expectedStateVersion,
    executionScope: thread.scope === "project"
      ? { kind: "project", projectId: thread.projectId }
      : { kind: "unscoped", threadId: thread.id },
    prompt: workerPrompt,
    profile: toWorkerModelProfile(profile, credentials.decrypt(encrypted)),
    resources: {
      schemaVersion: 1,
      revisionId: promptRevision.id,
      systemPrompt: promptRevision.content,
      appendSystemPrompt: [...(context.appendSystemPrompt ?? [])],
      skills: runtimeSkills
    },
    extensions: extensionRuntimeSnapshot()
  };
  turnExecution!.start({ kind: "turn", context }, workerCommand, () => interruptTurn(context, "worker_exit", 0));
  return {
    ...ipcMetadata(submitted),
    event: "turn.accepted",
    payload: { threadId: input.threadId, turnId, text: input.text, ...(input.retryOfTurnId === undefined ? {} : { retryOfTurnId: input.retryOfTurnId }), profile, prompt: promptTelemetry }
  };
}

function runningExecutionCount(): number {
  return executionScheduler?.telemetry().runningCount ?? 0;
}

function executionCapacityDiagnostic(correlationId: string, task: string): HostEvent {
  return diagnostic(correlationId, "HOST_FAILURE", `${task} is waiting for execution capacity (${runningExecutionCount()} / ${EXECUTION_CAPACITY}). Retry after running work completes.`);
}

function executionQueueEvent(correlationId: string): HostEvent {
  return {
    ...eventMetadata(correlationId),
    event: "execution_queue.updated",
    payload: { items: stateStore!.listExecutionQueue(), runningCount: runningExecutionCount(), capacity: EXECUTION_CAPACITY, telemetry: executionSchedulerTelemetry() }
  };
}

function executionSchedulerTelemetry() {
  return executionScheduler!.telemetry();
}

function submitOrQueueTurn(correlationId: string, input: { threadId: string; text: string; retryOfTurnId?: string | undefined }): HostEvent {
  const thread = stateStore!.getThread(input.threadId);
  if (thread === undefined) throw new Error("Thread not found");
  const reflection = stateStore!.getReflectionRunByThread(thread.id);
  const requestedProfileId = reflection?.memoryAwareProfileId ?? thread.activeProfileId;
  if (requestedProfileId === undefined || (reflection !== undefined && reflection.status !== "dialogue_active")) return submitTurn(correlationId, input);
  const reason = turnExecution!.isThreadActive(thread.id) ? "thread_active" as const : !executionScheduler!.hasCapacity() ? "capacity" as const : undefined;
  if (reason === undefined) return submitTurn(correlationId, input);
  const item = stateStore!.enqueueOrdinaryTurn({
    threadId: thread.id,
    text: input.text,
    reason,
    ...(input.retryOfTurnId === undefined ? {} : { retryOfTurnId: input.retryOfTurnId }),
    ...(requestedProfileId === undefined ? {} : { requestedProfileId })
  });
  emit(executionQueueEvent(correlationId));
  return { ...eventMetadata(correlationId, thread.id, USER_ACTOR, USER_PROVENANCE), event: "turn.queued", payload: { item } };
}

function drainExecutionQueue(correlationId: string = randomUUID()): void {
  if (shuttingDown || stateStore === null || stateStore.isReadOnlyRecovery) return;
  while (executionScheduler!.hasCapacity()) {
    const item = stateStore.listExecutionQueue().find((candidate) => {
      if (candidate.status !== "queued" || turnExecution!.isThreadActive(candidate.threadId)) return false;
      const candidateThread = stateStore!.getThread(candidate.threadId);
      if (candidateThread === undefined) return true;
      const effectiveProfileId = stateStore!.getReflectionRunByThread(candidateThread.id)?.memoryAwareProfileId ?? candidateThread.activeProfileId;
      return candidate.requestedProfileId === undefined || candidate.requestedProfileId === effectiveProfileId;
    });
    if (item === undefined) break;
    const thread = stateStore.getThread(item.threadId);
    if (thread === undefined) {
      stateStore.cancelExecutionQueueItem(item.id);
      continue;
    }
    const effectiveProfileId = stateStore.getReflectionRunByThread(thread.id)?.memoryAwareProfileId ?? thread.activeProfileId;
    if (item.requestedProfileId !== undefined && effectiveProfileId !== item.requestedProfileId) break;
    stateStore.cancelExecutionQueueItem(item.id);
    // Remove the admitted item from the renderer before publishing the new Turn.
    // Otherwise the conversation message and its editable queue textarea can
    // briefly represent the same input at once.
    emit(executionQueueEvent(correlationId));
    const event = submitTurn(correlationId, { threadId: item.threadId, text: item.text, ...(item.retryOfTurnId === undefined ? {} : { retryOfTurnId: item.retryOfTurnId }) });
    executionScheduler!.recordQueueAdmission(item.submittedAt);
    emit(event);
  }
  emit(executionQueueEvent(correlationId));
}

function compactThread(correlationId: string, threadId: string): HostEvent {
  const thread = stateStore!.getThread(threadId);
  if (thread === undefined) throw new Error("Thread not found");
  if (turnExecution!.isThreadActive(threadId)) return diagnostic(correlationId, "HOST_FAILURE", "Stop the active Turn before compacting this Thread.");
  if (!executionScheduler!.hasCapacity()) return executionCapacityDiagnostic(correlationId, "Thread compaction");
  const profile = thread.activeProfileId === undefined ? undefined : stateStore!.getModelProfile(thread.activeProfileId);
  if (profile === undefined) return diagnostic(correlationId, "HOST_FAILURE", "Model Profile not configured");
  if (thread.scope === "project" && !stateStore!.isProjectProfileAuthorized(thread.projectId, profile.id)) {
    return diagnostic(correlationId, "HOST_FAILURE", "Select this Model Profile in the Project Thread to authorize its Provider.");
  }
  const promptRevision = stateStore!.getActiveSystemPromptRevision();
  if (promptRevision === undefined) throw new Error("System Prompt is not initialized");
  const encrypted = stateStore!.getEncryptedCredential(profile.credentialRef);
  if (encrypted === undefined) throw new Error("Credential reference is unavailable");
  const turnId = randomUUID();
  const contextHistory = trajectoryStore!.contextHistory(threadId);
  const physical = stateStore!.getPhysicalContext(threadId);
  const capabilitySurface = createTurnCapabilitySurface({ kind: "compaction", scope: thread.scope, inventory: capabilityRegistry!.inventory() });
  const context: TurnContext = {
    correlationId,
    threadId,
    turnId,
    text: "",
    profile,
    outputIntent: false,
    memoryRecallMode: "none",
    reflectionOutcomeIntent: false,
    longTermMemoryCardIds: new Set(),
    activeCapabilities: [],
    executableCapabilityIds: [],
    capabilitySurface,
    expectedStateVersion: thread.stateVersion,
    promptRevision,
    submittedAtMs: Date.now(),
    recalledStateEstimatedTokens: 0,
    recallBodyBytes: 0,
    capabilityActivationCount: 0,
    compactionOnly: true
  };
  const admission = executionScheduler!.admit({ id: turnId, scopeKey: threadId, kind: "compaction" });
  if (!admission.admitted) return executionCapacityDiagnostic(correlationId, "Thread compaction");
  const started: TrajectoryEvent = {
    ...trajectoryMetadata(correlationId, threadId, turnId, USER_ACTOR, USER_PROVENANCE),
    event: "thread.compaction.started",
    payload: { reason: "manual" }
  };
  trajectoryStore!.append(started);
  const command: Extract<WorkerCommand, { command: "turn.execute" }> = {
    schemaVersion: 1,
    command: "turn.execute",
    compactOnly: true,
    commandId: randomUUID(),
    correlationId,
    threadId,
    turnId,
    cwd: thread.scope === "project" ? stateStore!.getProject(thread.projectId)!.path : app.getPath("userData"),
    threadDirectory: trajectoryStore!.threadDirectory(threadId),
    ...(physical?.sessionFile === undefined ? {} : { previousSessionFile: physical.sessionFile }),
    ...(trajectoryStore!.highWater(threadId) === undefined ? {} : { hostHighWater: trajectoryStore!.highWater(threadId)! }),
    contextHistory,
    estimatedInputTokens: estimateTokens(promptRevision.content) + estimateTokens(JSON.stringify(contextHistory)),
    currentInputTokens: estimateTokens(promptRevision.content),
    capabilitySurface,
    activeCapabilities: [],
    expectedStateVersion: thread.stateVersion,
    executionScope: thread.scope === "project" ? { kind: "project", projectId: thread.projectId } : { kind: "unscoped", threadId },
    prompt: "Manual Thread Compaction",
    profile: toWorkerModelProfile(profile, credentials.decrypt(encrypted)),
    resources: { schemaVersion: 1, revisionId: promptRevision.id, systemPrompt: promptRevision.content, appendSystemPrompt: [] },
    extensions: extensionRuntimeSnapshot()
  };
  turnExecution!.start({ kind: "turn", context }, command, () => {
    finishTurn(context);
    emit(diagnostic(correlationId, "HOST_FAILURE", "Agent Worker exited during Thread compaction."));
  });
  return { ...ipcMetadata(started), event: "thread.compaction.started", payload: { threadId, turnId, reason: "manual" } };
}

function handleWorkerEvent(workerEvent: WorkerEvent): void {
  if (extensionAuditWorker?.handleEvent(workerEvent) === true) return;
  if (subAgentProviderExecutor?.handleEvent(workerEvent) === true) return;
  if (workerEvent.event === "trajectory.acknowledged") {
    stateStore?.acknowledgePhysicalContext(workerEvent.threadId, workerEvent.eventId, workerEvent.sequence);
    return;
  }
  const execution = turnExecution?.route(workerEvent.turnId);
  if (execution === undefined) return;
  if (execution.kind === "dream_synthesis") {
    handleDreamSynthesisWorkerEvent(execution.context, workerEvent);
    return;
  }
  if (execution.kind === "dream") {
    handleDreamWorkerEvent(execution.context, workerEvent);
    return;
  }
  if (execution.kind === "reflection") {
    void handleReflectionWorkerEvent(execution.context, workerEvent);
    return;
  }
  const context = execution.context;

  if (workerEvent.event === "capability.execution.requested") {
    void processCapabilityRequest(context, workerEvent);
    return;
  }
  if (workerEvent.event === "native_tool.started" || workerEvent.event === "native_tool.completed") {
    processNativeProjectToolEvent(context, workerEvent);
    return;
  }

  if (
    workerEvent.event === "thread.compaction.started" ||
    workerEvent.event === "thread.compaction.completed" ||
    workerEvent.event === "thread.compaction.failed"
  ) {
    if (context.compactionOnly === true && workerEvent.event === "thread.compaction.started") return;
    const payload = {
      reason: workerEvent.reason,
      ...(workerEvent.event === "thread.compaction.completed" ? {
        tokensBefore: workerEvent.tokensBefore,
        ...(workerEvent.estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter: workerEvent.estimatedTokensAfter })
      } : {}),
      ...(workerEvent.event === "thread.compaction.failed" ? { failure: workerEvent.failure } : {})
    };
    const record: TrajectoryEvent = {
      ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, AGENT_ACTOR, AGENT_PROVENANCE),
      event: workerEvent.event,
      payload
    };
    trajectoryStore!.append(record);
    synchronizeDreamSchedulingIndex();
    if (workerEvent.event === "thread.compaction.completed") loadedPromptByThread.delete(context.threadId);
    if (workerEvent.event === "thread.compaction.completed") acknowledgeTrajectory(context, record);
    emit({ ...ipcMetadata(record), event: workerEvent.event, payload: { threadId: context.threadId, turnId: context.turnId, ...payload } });
    if (context.compactionOnly === true && workerEvent.event !== "thread.compaction.started") finishTurn(context);
    return;
  }

  if (workerEvent.event === "physical_context.ready") {
    stateStore!.setPhysicalContextSession(workerEvent.threadId, workerEvent.sessionFile, context.promptRevision.id);
    if (workerEvent.reconciliation !== "resumed" && workerEvent.retainedTurnCount > 0) {
      const record: TrajectoryEvent = {
        ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, HOST_ACTOR, HOST_PROVENANCE),
        event: "physical_context.rebuilt",
        payload: { reason: workerEvent.reconciliation, retainedTurnCount: workerEvent.retainedTurnCount }
      };
      trajectoryStore!.append(record);
      emit({ ...ipcMetadata(record), event: "physical_context.rebuilt", payload: { threadId: context.threadId, turnId: context.turnId, ...record.payload } });
    }
    if (workerEvent.contextUsage !== undefined) {
      const metadata = eventMetadata(context.correlationId, context.threadId, HOST_ACTOR, HOST_PROVENANCE);
      emit({ ...metadata, event: "session.context.updated", payload: { threadId: context.threadId, contextUsage: workerEvent.contextUsage } });
    }
    return;
  }

  if (workerEvent.event === "turn.started") {
    const record: TrajectoryEvent = {
      ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, AGENT_ACTOR, AGENT_PROVENANCE),
      event: "turn.started",
      payload: { profile: toTrajectoryProfile(context.profile) }
    };
    trajectoryStore!.append(record);
    inflight!.updateBoundary(context.turnId, workerEvent.workerSequence, record.sequence);
    emit({ ...ipcMetadata(record), event: "turn.started", payload: { threadId: context.threadId, turnId: context.turnId } });
    return;
  }

  if (workerEvent.event === "message.delta") {
    const metadata = eventMetadata(context.correlationId, context.threadId, AGENT_ACTOR, AGENT_PROVENANCE);
    inflight!.updateDelta(context.turnId, workerEvent.delta, workerEvent.workerSequence, metadata.sequence);
    emit({ ...metadata, event: "message.delta", payload: { threadId: context.threadId, turnId: context.turnId, delta: workerEvent.delta } });
    return;
  }

  if (workerEvent.event === "thinking.delta") {
    const metadata = eventMetadata(context.correlationId, context.threadId, AGENT_ACTOR, AGENT_PROVENANCE);
    emit({ ...metadata, event: "thinking.delta", payload: { threadId: context.threadId, turnId: context.turnId, delta: workerEvent.delta } });
    return;
  }

  if (workerEvent.event === "turn.completed") {
    const latencyMs = Date.now() - context.submittedAtMs;
    const recalledStateEstimatedTokens = context.recalledStateEstimatedTokens;
    const record: TrajectoryEvent = {
      ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, AGENT_ACTOR, AGENT_PROVENANCE),
      event: "turn.completed",
      payload: {
        message: workerEvent.message,
        profile: toTrajectoryProfile(context.profile),
        usage: workerEvent.usage,
        ...(workerEvent.contextUsage === undefined ? {} : { contextUsage: workerEvent.contextUsage }),
        latencyMs,
        recalledStateEstimatedTokens,
        ...(workerEvent.responseId === undefined ? {} : { responseId: workerEvent.responseId }),
        ...(workerEvent.piEntryId === undefined ? {} : { piEntryId: workerEvent.piEntryId })
      }
    };
    trajectoryStore!.append(record);
    if (context.reflectionRunId !== undefined) {
      const run = stateStore!.getReflectionRun(context.reflectionRunId);
      if (run?.status === "memory_aware_running" && run.memoryInitialTurnId === context.turnId) emitReflectionRun(context.correlationId, stateStore!.activateReflectionDialogue(run.id));
    }
    finishTurn(context);
    acknowledgeTrajectory(context, record);
    emit({ ...ipcMetadata(record), event: "turn.completed", payload: { threadId: context.threadId, turnId: context.turnId, message: workerEvent.message, profile: context.profile, usage: workerEvent.usage, ...(workerEvent.contextUsage === undefined ? {} : { contextUsage: workerEvent.contextUsage }), latencyMs, recalledStateEstimatedTokens, ...(workerEvent.responseId === undefined ? {} : { responseId: workerEvent.responseId }) } });
    return;
  }

  if (workerEvent.event === "turn.interrupted") {
    interruptTurn(context, workerEvent.reason, workerEvent.workerSequence);
    return;
  }

  if (context.compactionOnly === true) {
    executionScheduler!.recordFailure();
    const record: TrajectoryEvent = {
      ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, AGENT_ACTOR, AGENT_PROVENANCE),
      event: "thread.compaction.failed",
      payload: { reason: "manual", failure: workerEvent.failure }
    };
    trajectoryStore!.append(record);
    finishTurn(context);
    acknowledgeTrajectory(context, record);
    emit({
      ...ipcMetadata(record),
      event: "thread.compaction.failed",
      payload: {
        threadId: context.threadId,
        turnId: context.turnId,
        reason: "manual",
        failure: workerEvent.failure
      }
    });
    return;
  }

  if (workerEvent.failure.code === "WORKER_EXITED") {
    interruptTurn(context, "worker_exit", workerEvent.workerSequence);
    return;
  }
  executionScheduler!.recordFailure();
  const record: TrajectoryEvent = {
    ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, AGENT_ACTOR, AGENT_PROVENANCE),
    event: "turn.failed",
    payload: { profile: toTrajectoryProfile(context.profile), failure: workerEvent.failure }
  };
  trajectoryStore!.append(record);
  if (context.reflectionRunId !== undefined) {
    const run = stateStore!.getReflectionRun(context.reflectionRunId);
    if (run?.status === "memory_aware_running") emitReflectionRun(context.correlationId, stateStore!.failMemoryAwareReflection(run.id, workerEvent.failure));
  }
  finishTurn(context);
  acknowledgeTrajectory(context, record);
  emit({ ...ipcMetadata(record), event: "turn.failed", payload: { threadId: context.threadId, turnId: context.turnId, text: context.text, ...(context.retryOfTurnId === undefined ? {} : { retryOfTurnId: context.retryOfTurnId }), profile: context.profile, failure: workerEvent.failure } });
}

function handleDreamSynthesisWorkerEvent(context: DreamSynthesisExecutionContext, workerEvent: WorkerEvent): void {
  if (workerEvent.event === "capability.execution.requested") {
    workerSupervisor?.resolveCapability({ schemaVersion: 1, command: "capability.execution.resolve", commandId: randomUUID(), correlationId: context.correlationId, threadId: context.executionThreadId, turnId: context.turnId, result: { schemaVersion: 1, requestId: workerEvent.request.requestId, status: "rejected", code: "DREAM_SYNTHESIS_CAPABILITY_NOT_ALLOWED", content: "Global Dream Synthesis receives only approved de-identified summaries and cannot use tools." } });
    return;
  }
  if (workerEvent.event === "physical_context.ready" || workerEvent.event === "turn.started" || workerEvent.event === "message.delta" || workerEvent.event === "thinking.delta" || workerEvent.event.startsWith("thread.compaction.")) return;
  if (workerEvent.event === "turn.completed") {
    try {
      const batch = dreamReviews!.load().batches.find((item) => item.id === context.batchId);
      if (batch === undefined) throw new Error("DREAM_BATCH_NOT_FOUND");
      const synthesis = parseDreamGlobalSynthesis(workerEvent.message, batch, context.input, context.forbiddenTerms);
      dreamReviews!.completeSynthesis(context.batchId, synthesis);
      finishDreamSynthesisExecution(context);
      emit(dreamStateEvent(context.correlationId));
    } catch {
      failDreamSynthesisExecution(context, { kind: "worker", code: "INVALID_DREAM_SYNTHESIS_RESULT", message: "The model response did not match the de-identified Global Dream Synthesis contract.", provider: context.profile.provider, model: context.profile.model });
    }
    return;
  }
  if (workerEvent.event === "turn.interrupted") {
    failDreamSynthesisExecution(context, { kind: "worker", code: "DREAM_SYNTHESIS_INTERRUPTED", message: "Global Dream Synthesis was interrupted and requires explicit retry.", provider: context.profile.provider, model: context.profile.model });
    return;
  }
  if (workerEvent.event === "turn.failed") failDreamSynthesisExecution(context, workerEvent.failure);
}

function failDreamSynthesisExecution(context: DreamSynthesisExecutionContext, failure: ProviderFailure): void {
  if (!turnExecution!.isActive({ kind: "dream_synthesis", context })) return;
  executionScheduler!.recordFailure();
  try { dreamReviews?.failSynthesis(context.batchId, failure); }
  finally { finishDreamSynthesisExecution(context); emit(dreamStateEvent(context.correlationId)); }
}

function finishDreamSynthesisExecution(context: DreamSynthesisExecutionContext): void {
  turnExecution?.finish({ kind: "dream_synthesis", context });
  executionScheduler?.release(context.turnId);
  workerSupervisor?.retire(context.executionThreadId);
  queueMicrotask(() => drainExecutionQueue());
}

function handleDreamWorkerEvent(context: DreamExecutionContext, workerEvent: WorkerEvent): void {
  if (workerEvent.event === "capability.execution.requested") {
    workerSupervisor?.resolveCapability({
      schemaVersion: 1, command: "capability.execution.resolve", commandId: randomUUID(), correlationId: context.correlationId,
      threadId: context.executionThreadId, turnId: context.turnId,
      result: { schemaVersion: 1, requestId: workerEvent.request.requestId, status: "rejected", code: "DREAM_EXTRACTION_CAPABILITY_NOT_ALLOWED", content: "Dream extraction receives only its frozen scope-local input and cannot use tools." }
    });
    return;
  }
  if (workerEvent.event === "physical_context.ready" || workerEvent.event === "turn.started" || workerEvent.event === "message.delta" || workerEvent.event === "thinking.delta" || workerEvent.event.startsWith("thread.compaction.")) return;
  if (workerEvent.event === "turn.completed") {
    try {
      const result = parseDreamScopeSummary(workerEvent.message, context.scope, context.allowedSourceReferences);
      dreamReviews!.completeScope(context.batchId, context.scope.id, result);
      finishDreamExecution(context);
      emit(dreamStateEvent(context.correlationId));
    } catch {
      failDreamExecution(context, { kind: "worker", code: "INVALID_DREAM_SCOPE_RESULT", message: "The model response did not match the bounded, de-identified Dream scope contract.", provider: context.profile.provider, model: context.profile.model });
    }
    return;
  }
  if (workerEvent.event === "turn.interrupted") {
    failDreamExecution(context, { kind: "worker", code: "DREAM_SCOPE_INTERRUPTED", message: "Dream scope extraction was interrupted and remains Pending for explicit retry.", provider: context.profile.provider, model: context.profile.model });
    return;
  }
  if (workerEvent.event === "turn.failed") failDreamExecution(context, workerEvent.failure);
}

function failDreamExecution(context: DreamExecutionContext, failure: ProviderFailure): void {
  if (!turnExecution!.isActive({ kind: "dream", context })) return;
  executionScheduler!.recordFailure();
  try { dreamReviews?.failScope(context.batchId, context.scope.id, failure); }
  finally {
    finishDreamExecution(context);
    emit(dreamStateEvent(context.correlationId));
  }
}

function finishDreamExecution(context: DreamExecutionContext): void {
  turnExecution?.finish({ kind: "dream", context });
  executionScheduler?.release(context.turnId);
  workerSupervisor?.retire(context.executionThreadId);
  queueMicrotask(() => drainExecutionQueue());
}

async function handleReflectionWorkerEvent(context: ReflectionExecutionContext, workerEvent: WorkerEvent): Promise<void> {
  if (workerEvent.event === "capability.execution.requested") {
    const request = workerEvent.request;
    const scopeMatches = context.scope === "project"
      ? request.scope.kind === "project" && request.scope.projectId === context.projectId
      : request.scope.kind === "unscoped" && request.scope.threadId === context.threadId;
    if (
      request.threadId !== context.threadId || request.turnId !== context.turnId || request.correlationId !== context.correlationId ||
      !context.activeCapabilities.includes(request.capabilityId) || !scopeMatches
    ) {
      resolveReflectionCapability(context, { schemaVersion: 1, requestId: request.requestId, status: "rejected", code: "REFLECTION_CAPABILITY_NOT_ALLOWED", content: "Independent Evidence Pass permits only capabilities authorized for its frozen scope." });
      return;
    }
    if (context.scope === "project" && (context.projectId === undefined || stateStore!.getProject(context.projectId) === undefined)) {
      resolveReflectionCapability(context, { schemaVersion: 1, requestId: request.requestId, status: "failed", code: "PROJECT_UNAVAILABLE", content: "The frozen Project scope is unavailable." });
      return;
    }
    const decision = await capabilityGateway!.request(request, {
      accessMode: stateStore!.getAccessMode(),
      scope: context.scope,
      stateVersion: context.expectedStateVersion,
      activeCapabilityIds: context.activeCapabilities,
      outputIntent: false,
      ...(context.outputLocation === undefined ? {} : { outputLocation: context.outputLocation })
    });
    if (decision.type === "confirmation_required") {
      resolveReflectionCapability(context, { schemaVersion: 1, requestId: request.requestId, status: "rejected", code: "REFLECTION_CONFIRMATION_UNSUPPORTED", content: "Independent Evidence recall cannot pause for a broader capability grant." });
    } else {
      resolveReflectionCapability(context, decision.result);
    }
    return;
  }
  if (workerEvent.event === "physical_context.ready") {
    const run = stateStore!.setReflectionSession(context.runId, workerEvent.sessionFile);
    emitReflectionRun(context.correlationId, run);
    return;
  }
  if (workerEvent.event === "turn.started" || workerEvent.event === "message.delta" || workerEvent.event === "thinking.delta" || workerEvent.event.startsWith("thread.compaction.")) return;
  if (workerEvent.event === "turn.completed") {
    try {
      const assessment = parseIndependentAssessment(workerEvent.message);
      const run = stateStore!.completeIndependentAssessment(context.runId, assessment);
      finishReflectionExecution(context);
      emitReflectionRun(context.correlationId, run);
    } catch {
      failReflectionExecution(context, {
        kind: "worker", code: "INVALID_INDEPENDENT_ASSESSMENT", message: "The model response did not match the bounded Independent Assessment contract.", provider: context.profile.provider, model: context.profile.model
      });
    }
    return;
  }
  if (workerEvent.event === "turn.interrupted") {
    const run = stateStore!.interruptIndependentAssessment(context.runId);
    finishReflectionExecution(context);
    emitReflectionRun(context.correlationId, run);
    return;
  }
  if (workerEvent.event === "turn.failed") failReflectionExecution(context, workerEvent.failure);
}

function resolveReflectionCapability(context: ReflectionExecutionContext, result: CapabilityExecutionResult): void {
  workerSupervisor?.resolveCapability({
    schemaVersion: 1, command: "capability.execution.resolve", commandId: randomUUID(), correlationId: context.correlationId,
    threadId: context.threadId, turnId: context.turnId, result
  });
}

function failReflectionExecution(context: ReflectionExecutionContext, failure: ProviderFailure): void {
  if (!turnExecution!.isActive({ kind: "reflection", context })) return;
  executionScheduler!.recordFailure();
  const current = stateStore!.getReflectionRun(context.runId);
  if (current?.status !== "independent_running") return;
  const run = stateStore!.failIndependentAssessment(context.runId, failure);
  finishReflectionExecution(context);
  emitReflectionRun(context.correlationId, run);
}

function finishReflectionExecution(context: ReflectionExecutionContext): void {
  turnExecution?.finish({ kind: "reflection", context });
  executionScheduler?.release(context.turnId);
  workerSupervisor?.retire(context.threadId);
  queueMicrotask(() => drainExecutionQueue());
}

function emitReflectionRun(correlationId: string, run: ReflectionRun): void {
  emit({ ...eventMetadata(correlationId, run.threadId), event: "reflection.run.updated", payload: { run } });
}

function acknowledgeTrajectory(context: TurnContext, record: TrajectoryEvent): void {
  workerSupervisor?.acknowledge({
    schemaVersion: 1,
    command: "trajectory.acknowledge",
    commandId: randomUUID(),
    correlationId: context.correlationId,
    threadId: context.threadId,
    turnId: context.turnId,
    eventId: record.eventId,
    sequence: record.sequence
  });
}

function processNativeProjectToolEvent(
  context: TurnContext,
  workerEvent: Extract<WorkerEvent, { event: "native_tool.started" | "native_tool.completed" }>
): void {
  const requestId = `native:${workerEvent.toolCallId}`;
  if (workerEvent.event === "native_tool.started") {
    const started: TrajectoryEvent = {
      ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, AGENT_ACTOR, AGENT_PROVENANCE),
      event: "tool.started",
      payload: {
        toolCallId: workerEvent.toolCallId,
        capabilityId: workerEvent.toolName,
        arguments: summarizeCapabilityArguments(workerEvent.arguments),
        expectedStateVersion: context.expectedStateVersion
      }
    };
    trajectoryStore!.append(started);
    inflight!.startTool(
      context.turnId,
      { toolCallId: workerEvent.toolCallId, capabilityId: workerEvent.toolName },
      workerEvent.workerSequence,
      started.sequence
    );
    emit({
      ...ipcMetadata(started),
      event: "capability.execution.updated",
      payload: {
        threadId: context.threadId,
        turnId: context.turnId,
        requestId,
        capabilityId: workerEvent.toolName,
        status: "started",
        content: "Project read requested."
      }
    });
    return;
  }

  const eventName = workerEvent.isError ? "tool.failed" : "tool.completed";
  const terminal: TrajectoryEvent = {
    ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, AGENT_ACTOR, AGENT_PROVENANCE),
    event: eventName,
    payload: {
      toolCallId: workerEvent.toolCallId,
      capabilityId: workerEvent.toolName,
      summary: workerEvent.content,
      artifactIds: []
    }
  };
  trajectoryStore!.append(terminal);
  inflight!.finishTool(context.turnId, workerEvent.toolCallId, terminal.sequence);
  emit({
    ...ipcMetadata(terminal),
    event: "capability.execution.updated",
    payload: {
      threadId: context.threadId,
      turnId: context.turnId,
      requestId,
      capabilityId: workerEvent.toolName,
      status: workerEvent.isError ? "failed" : "completed",
      content: workerEvent.content
    }
  });
}

async function processCapabilityRequest(
  context: TurnContext,
  workerEvent: Extract<WorkerEvent, { event: "capability.execution.requested" }>
): Promise<void> {
  const request = workerEvent.request;
  if (
    request.threadId !== context.threadId ||
    request.turnId !== context.turnId ||
    request.correlationId !== context.correlationId
  ) {
    resolveCapabilityInWorker(context, {
      schemaVersion: 1,
      requestId: request.requestId,
      status: "rejected",
      code: "REQUEST_CONTEXT_MISMATCH",
      content: "Capability request does not match the active Turn."
    });
    return;
  }
  const started: TrajectoryEvent = {
    ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, request.actor, request.provenance),
    event: "tool.started",
    payload: {
      toolCallId: request.toolCallId,
      capabilityId: request.capabilityId,
      arguments: summarizeCapabilityArguments(request.arguments),
      expectedStateVersion: request.expectedStateVersion
    }
  };
  trajectoryStore!.append(started);
  inflight!.startTool(context.turnId, { toolCallId: request.toolCallId, capabilityId: request.capabilityId }, workerEvent.workerSequence, started.sequence);
  capabilityRequests.set(request.requestId, { context, request });
  emit({
    ...ipcMetadata(started),
    event: "capability.execution.updated",
    payload: { threadId: context.threadId, turnId: context.turnId, requestId: request.requestId, capabilityId: request.capabilityId, status: "started", content: "Capability execution requested." }
  });

  const decision = await capabilityGateway!.request(request, capabilityAuthorization(context));
  if (decision.type === "confirmation_required") {
    emit({
      ...eventMetadata(context.correlationId, context.threadId, HOST_ACTOR, HOST_PROVENANCE),
      event: "capability.confirmation.required",
      payload: { threadId: context.threadId, turnId: context.turnId, ...decision.proposal }
    });
    return;
  }
  finalizeCapability(context, request, decision.result, true);
}

async function resolveCapabilityConfirmation(correlationId: string, requestId: string, approved: boolean): Promise<HostEvent> {
  const pending = capabilityRequests.get(requestId);
  if (pending === undefined || capabilityGateway === null) {
    return diagnostic(correlationId, "HOST_FAILURE", "The scoped capability confirmation is no longer active.");
  }
  const result = await capabilityGateway.resolve(requestId, approved, capabilityAuthorization(pending.context));
  return finalizeCapability(pending.context, pending.request, result, false);
}

function finalizeCapability(
  context: TurnContext,
  request: CapabilityExecutionRequest,
  initialResult: CapabilityExecutionResult,
  emitToRenderer: boolean
): HostEvent {
  let result = initialResult;
  if (result.retrieval !== undefined && context.reflectionRunId !== undefined && context.recallBodyBytes + result.retrieval.bodyBytes > 32_000) {
    result = { schemaVersion: 1, requestId: result.requestId, status: "failed", code: "REFLECTION_RECALL_BUDGET_EXCEEDED", content: "The bounded Reflection recall budget is exhausted. Continue the discussion from already recalled evidence and Memory." };
  }
  if (result.retrieval !== undefined) {
    context.recallBodyBytes += result.retrieval.bodyBytes;
    context.recalledStateEstimatedTokens += Math.ceil(result.retrieval.bodyBytes / 4);
  }
  let projectOutput: ProjectOutputArtifact | undefined;
  if (result.activatedCapabilities !== undefined) {
    for (const capabilityId of result.activatedCapabilities) {
      if (!context.activeCapabilities.includes(capabilityId)) context.activeCapabilities.push(capabilityId);
      if (!context.executableCapabilityIds.includes(capabilityId)) context.executableCapabilityIds.push(capabilityId);
    }
  }
  if (result.artifact !== undefined) {
    try {
      stateStore!.recordArtifact(result.artifact);
      const thread = stateStore!.getThread(context.threadId);
      if (thread?.scope === "project") {
        const project = stateStore!.getProject(thread.projectId);
        if (project === undefined) throw new Error("Project not found");
        const sourceReferences = Array.isArray(request.arguments.sourceReferences)
          ? request.arguments.sourceReferences.filter((value): value is string => typeof value === "string")
          : [];
        if (request.capabilityId === "file_download" && typeof request.arguments.url === "string" && !sourceReferences.includes(request.arguments.url)) {
          sourceReferences.push(request.arguments.url);
        }
        projectOutput = projectOutputs.record({
          projectId: project.id, projectPath: project.path, artifact: result.artifact,
          profile: { id: context.profile.id, provider: context.profile.provider, model: context.profile.model }, capabilityId: request.capabilityId,
          ...(typeof request.arguments.skillId === "string" ? { skillId: request.arguments.skillId } : {}),
          sourceReferences,
          warnings: Array.isArray(request.arguments.warnings) ? request.arguments.warnings.filter((value): value is string => typeof value === "string") : [],
          relatedArtifacts: Array.isArray(request.arguments.relatedArtifacts) ? request.arguments.relatedArtifacts.flatMap((value) => {
            const parsed = zRelatedArtifact(value); return parsed === undefined ? [] : [parsed];
          }) : []
        });
      }
    } catch {
      result = {
        schemaVersion: 1,
        requestId: result.requestId,
        status: "unknown_outcome",
        code: "ARTIFACT_COMMIT_UNKNOWN",
        content: "The file operation completed but artifact registration could not be confirmed. Inspect the target before retrying."
      };
    }
  }
  const eventName = result.status === "completed"
    ? "tool.completed"
    : result.status === "unknown_outcome"
      ? "tool.unknown_outcome"
      : "tool.failed";
  const terminal: TrajectoryEvent = {
    ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, request.actor, request.provenance),
    event: eventName,
    payload: {
      toolCallId: request.toolCallId,
      capabilityId: request.capabilityId,
      summary: retrievalTrajectorySummary(result),
      artifactIds: result.artifact === undefined ? [] : [result.artifact.id],
      ...(result.retrieval === undefined ? {} : { contextReference: result.retrieval.contextReference })
    }
  };
  trajectoryStore!.append(terminal);
  if (result.artifact !== undefined && result.status === "completed") {
    const artifactEvent: TrajectoryEvent = {
      ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, request.actor, request.provenance),
      event: "artifact.created",
      payload: {
        artifactId: result.artifact.id,
        mediaType: result.artifact.mediaType,
        destination: result.artifact.destination,
        sourceTurnId: context.turnId
      }
    };
    trajectoryStore!.append(artifactEvent);
  }
  inflight!.finishTool(context.turnId, request.toolCallId, terminal.sequence);
  capabilityRequests.delete(request.requestId);
  resolveCapabilityInWorker(context, result);
  const hostEvent: HostEvent = {
    ...ipcMetadata(terminal),
    event: "capability.execution.updated",
    payload: {
      threadId: context.threadId,
      turnId: context.turnId,
      requestId: request.requestId,
      capabilityId: request.capabilityId,
      status: result.status,
      content: result.content,
      ...(result.artifact === undefined ? {} : { artifact: { id: result.artifact.id, mediaType: result.artifact.mediaType, destination: result.artifact.destination } })
    }
  };
  if (emitToRenderer) emit(hostEvent);
  if (projectOutput !== undefined) {
    emit({ ...eventMetadata(context.correlationId, context.threadId), event: "project.outputs.updated", payload: { projectId: projectOutput.projectId, outputs: projectOutputs.list(projectOutput.projectId, stateStore!.getProject(projectOutput.projectId)!.path) } });
  }
  return hostEvent;
}

function resolveCapabilityInWorker(context: TurnContext, result: CapabilityExecutionResult): void {
  workerSupervisor?.resolveCapability({
    schemaVersion: 1,
    command: "capability.execution.resolve",
    commandId: randomUUID(),
    correlationId: context.correlationId,
    threadId: context.threadId,
    turnId: context.turnId,
    result
  });
}

function capabilityAuthorization(context: TurnContext): CapabilityAuthorizationSnapshot {
  const thread = stateStore!.getThread(context.threadId);
  if (thread === undefined) throw new Error("Thread not found");
  if (thread.scope === "project") {
    const project = stateStore!.getProject(thread.projectId);
    if (project === undefined) throw new Error("Project not found");
    return {
      accessMode: stateStore!.getAccessMode(),
      scope: "project",
      stateVersion: thread.stateVersion,
      activeCapabilityIds: context.executableCapabilityIds,
      outputIntent: context.outputIntent,
      outputLocation: join(project.path, "outputs"),
      projectRoot: project.path
    };
  }
  return {
    accessMode: stateStore!.getAccessMode(),
    scope: "unscoped",
    stateVersion: thread.stateVersion,
    activeCapabilityIds: context.executableCapabilityIds,
    outputIntent: context.outputIntent,
    ...(thread.outputLocation === undefined ? {} : { outputLocation: thread.outputLocation })
  };
}

function summarizeCapabilityArguments(arguments_: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(arguments_.operations)) {
    const operations = arguments_.operations.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null);
    return {
      path: typeof arguments_.path === "string" ? arguments_.path : "",
      operationCount: operations.length,
      oldTextBytes: operations.reduce((sum, operation) => sum + (typeof operation.oldText === "string" ? Buffer.byteLength(operation.oldText, "utf8") : 0), 0),
      newTextBytes: operations.reduce((sum, operation) => sum + (typeof operation.newText === "string" ? Buffer.byteLength(operation.newText, "utf8") : 0), 0)
    };
  }
  if (arguments_.program === "git" || arguments_.program === "pdfinfo") {
    return {
      program: arguments_.program,
      operation: typeof arguments_.operation === "string" ? arguments_.operation : undefined,
      path: typeof arguments_.path === "string" ? arguments_.path : ""
    };
  }
  if (arguments_.program === "rg") {
    return {
      program: "rg",
      queryChars: typeof arguments_.query === "string" ? arguments_.query.length : 0,
      path: typeof arguments_.path === "string" ? arguments_.path : ".",
      glob: typeof arguments_.glob === "string" ? arguments_.glob : undefined
    };
  }
  if (typeof arguments_.url === "string") {
    return { url: arguments_.url, maxChars: typeof arguments_.maxChars === "number" ? arguments_.maxChars : undefined };
  }
  if (typeof arguments_.query === "string" && (typeof arguments_.maxResults === "number" || arguments_.materialId === undefined)) {
    return {
      queryChars: arguments_.query.length,
      maxResults: typeof arguments_.maxResults === "number" ? arguments_.maxResults : undefined,
      maxChars: typeof arguments_.maxChars === "number" ? arguments_.maxChars : undefined
    };
  }
  if (typeof arguments_.disclosureLevel === "string") {
    return {
      disclosureLevel: arguments_.disclosureLevel,
      materialId: typeof arguments_.materialId === "string" ? arguments_.materialId : "",
      blockCount: Array.isArray(arguments_.blockIds) ? arguments_.blockIds.length : 0,
      queryChars: typeof arguments_.query === "string" ? arguments_.query.length : 0,
      maxItems: typeof arguments_.maxItems === "number" ? arguments_.maxItems : undefined,
      maxChars: typeof arguments_.maxChars === "number" ? arguments_.maxChars : undefined
    };
  }
  if (typeof arguments_.need === "string") {
    return {
      capabilityId: typeof arguments_.capabilityId === "string" ? arguments_.capabilityId : "",
      needChars: arguments_.need.length
    };
  }
  const content = typeof arguments_.content === "string" ? arguments_.content : "";
  return {
    path: typeof arguments_.path === "string" ? arguments_.path : "",
    mediaType: typeof arguments_.mediaType === "string" ? arguments_.mediaType : "text/plain; charset=utf-8",
    replaceExisting: arguments_.replaceExisting === true,
    contentBytes: Buffer.byteLength(content, "utf8")
  };
}

function zRelatedArtifact(value: unknown): ProjectOutputArtifact["relatedArtifacts"][number] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { relation?: unknown; path?: unknown; mediaType?: unknown };
  if ((candidate.relation !== "render" && candidate.relation !== "diff" && candidate.relation !== "supporting") || typeof candidate.path !== "string" || candidate.path.length === 0) return undefined;
  if (candidate.mediaType !== undefined && typeof candidate.mediaType !== "string") return undefined;
  return { relation: candidate.relation, path: candidate.path, ...(candidate.mediaType === undefined ? {} : { mediaType: candidate.mediaType }) };
}

function interruptTurn(
  context: TurnContext,
  reason: "user_stop" | "worker_exit" | "application_restart" | "provider_interrupted",
  workerSequence: number
): void {
  if (!turnExecution!.isActive({ kind: "turn", context })) return;
  inflight!.flush(context.turnId);
  const checkpoint = inflight!.get(context.turnId);
  const record: TrajectoryEvent = {
    ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, HOST_ACTOR, HOST_PROVENANCE, checkpoint?.interruptionEventId),
    event: "turn.interrupted",
    payload: {
      partialMessage: checkpoint?.partialMessage ?? "",
      reason,
      profile: toTrajectoryProfile(context.profile),
      tools: checkpoint?.startedTools.map((tool) => ({ ...tool, status: tool.status === "started" ? "interrupted" as const : tool.status })) ?? [],
      lastWorkerSequence: Math.max(workerSequence, checkpoint?.lastWorkerSequence ?? 0),
      lastHostSequence: checkpoint?.lastHostSequence ?? 0
    }
  };
  trajectoryStore!.append(record);
  if (context.reflectionRunId !== undefined) {
    const run = stateStore!.getReflectionRun(context.reflectionRunId);
    if (run?.status === "memory_aware_running") emitReflectionRun(context.correlationId, stateStore!.interruptMemoryAwareReflection(run.id));
  }
  if (reason === "user_stop") stateStore!.pauseThreadExecutionQueue(context.threadId);
  if (reason === "worker_exit") executionScheduler!.recordFailure();
  finishTurn(context);
  if (reason === "worker_exit") loadedPromptByThread.delete(context.threadId);
  emit({ ...ipcMetadata(record), event: "turn.interrupted", payload: { threadId: context.threadId, turnId: context.turnId, partialMessage: record.payload.partialMessage, reason, profile: context.profile } });
  if (reason === "user_stop") emit(executionQueueEvent(context.correlationId));
}

function finishTurn(context: TurnContext): void {
  for (const [requestId, pending] of capabilityRequests) {
    if (pending.context.turnId !== context.turnId) continue;
    const result = capabilityGateway?.cancel(requestId);
    if (result !== undefined) resolveCapabilityInWorker(context, result);
    capabilityRequests.delete(requestId);
  }
  inflight!.complete(context.turnId);
  turnExecution?.finish({ kind: "turn", context });
  executionScheduler?.release(context.turnId);
  queueMicrotask(() => drainExecutionQueue());
}

function toTrajectoryProfile(profile: ModelProfile): TrajectoryProfile {
  return { id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, thinkingLevel: profile.thinkingLevel };
}

function toWorkerModelProfile(
  profile: ModelProfile,
  apiKey: string
): Extract<WorkerCommand, { command: "turn.execute" }>["profile"] {
  return {
    provider: profile.provider,
    model: profile.model,
    apiKey,
    thinkingLevel: profile.thinkingLevel,
    ...(profile.contextWindow === undefined ? {} : { contextWindow: profile.contextWindow }),
    ...(profile.maxOutputTokens === undefined ? {} : { maxOutputTokens: profile.maxOutputTokens })
  };
}

function emit(event: HostEvent): void {
  if (!shuttingDown && mainWindow !== null) mainWindow.webContents.send(EVENT_CHANNEL, event);
}

function readValue(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && key in input ? (input as Record<string, unknown>)[key] : undefined;
}

function readString(input: unknown, key: string): string | undefined {
  const value = readValue(input, key);
  return typeof value === "string" ? value : undefined;
}

function memoryEvolutionFailure(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  switch (error.message) {
    case "STALE_MEMORY_PATCH": return "Long-term Memory or its lineage changed after preview. Prepare a new patch before committing.";
    case "MEMORY_PATCH_RESOLUTION_SIGNAL_REQUIRED": return "Narrow and Revise require an attributable User correction or approved Reflection or Retrospective conclusion.";
    case "MEMORY_PATCH_TARGET_NOT_FOUND": return "A target Memory entry is no longer current. Refresh and prepare a new patch.";
    case "MEMORY_REINFORCEMENT_CANNOT_LOWER_MATURITY": return "Reinforce cannot lower Memory maturity or replace its meaning.";
    case "MEMORY_PATCH_MATURITY_PROVENANCE_REQUIRED": return "Evidence-backed or retrospectively supported learning requires traceable local provenance.";
    case "MEMORY_PATCH_NO_CHANGES": return "Memory patch does not change learning, maturity, provenance, or lineage.";
    case "CONFLICTING_LOCAL_MEMORY_PROVENANCE": return "A source reference is already bound to different local provenance.";
    case "MEMORY_PATCH_NOT_FOUND": return "Memory patch is no longer available.";
    default: return fallback;
  }
}

function detectReflectionOutcomeIntent(text: string): boolean {
  const requestsPreparation = /\b(prepare|propose|draft|create|record|capture)\b/iu.test(text) || /(准备|提出|起草|生成|创建|记录|沉淀)/u.test(text);
  const namesOutcome = /\b(judg(?:e)?ment record|learning proposal|memory proposal|reflection outcome)\b/iu.test(text) || /(判断记录|判断结论|学习提案|记忆提案|复盘产出|长期记忆)/u.test(text);
  return requestsPreparation && namesOutcome;
}

function reflectionOutcomesEvent(correlationId: string, runId: string, threadId: string): HostEvent {
  if (reflectionOutcomes === null) throw new Error("Reflection outcomes are unavailable.");
  const run = stateStore?.getReflectionRun(runId);
  const outcomes = run === undefined ? reflectionOutcomes.list(runId) : reconcileReflectionOutcomeState(run);
  return { ...eventMetadata(correlationId, threadId), event: "reflection.outcomes.updated", payload: { runId, ...outcomes } };
}

function reflectionOutcomeDependencies(run: ReflectionRun, input: ReflectionOutcomeProposalInput) {
  const recalled = recalledReflectionMemoryIds(run.threadId);
  return captureReflectionDependencies({
    evidenceReferenceIds: [
      ...(run.assessment?.evidenceReferences.map((reference) => reference.referenceId) ?? []),
      ...(input.judgmentRecord?.evidenceReferences ?? [])
    ],
    projectMemoryEntryIds: run.scope === "project" ? recalled.projectMemory : [],
    longTermMemoryEntryIds: [...recalled.longTermMemory, ...input.learningProposals.flatMap((proposal) => proposal.targetEntryIds)],
    state: reflectionDependencyState(run)
  });
}

function reconcileReflectionOutcomeState(run: ReflectionRun) {
  if (reflectionOutcomes === null) throw new Error("Reflection outcomes are unavailable.");
  let outcomes = reflectionOutcomes.list(run.id);
  if (stateStore?.isReadOnlyRecovery === true) return outcomes;
  const state = reflectionDependencyState(run);
  for (const outcome of [...outcomes.judgments, ...outcomes.learningProposals]) {
    if (!["draft", "patch_prepared"].includes(outcome.status)) continue;
    const reasons = staleReflectionDependencies(outcome.dependencies, state);
    if (reasons.length === 0) continue;
    if ("preparedPatchId" in outcome && outcome.preparedPatchId !== undefined) memoryEvolution?.discard(outcome.preparedPatchId);
    reflectionOutcomes.markStale(outcome.id, reasons);
  }
  outcomes = reflectionOutcomes.list(run.id);
  return outcomes;
}

function reflectionDependencyState(run: ReflectionRun): ReflectionDependencyState {
  const longTermDocument = longTermMemories?.load(false);
  if (run.scope === "unscoped") {
    return {
      materials: [],
      ...(longTermDocument === undefined ? {} : { longTermMemory: longTermDocument.entries.map((entry) => ({ id: entry.id, value: entry })) })
    };
  }
  const project = stateStore?.getProject(run.projectId);
  const projectDocument = project === undefined ? undefined : projectMemories?.load(project.id, project.path, false);
  return {
    materials: stateStore?.listMaterials(run.projectId) ?? [],
    ...(projectDocument === undefined ? {} : { projectMemory: projectDocument.entries.map((entry) => ({ id: entry.id, value: entry })) }),
    ...(longTermDocument === undefined ? {} : { longTermMemory: longTermDocument.entries.map((entry) => ({ id: entry.id, value: entry })) })
  };
}

function recalledReflectionMemoryIds(threadId: string): { projectMemory: string[]; longTermMemory: string[] } {
  const projectMemory = new Set<string>();
  const longTermMemory = new Set<string>();
  for (const event of trajectoryStore?.loadEvents(threadId) ?? []) {
    if (event.event !== "tool.completed" || event.payload.capabilityId !== "memory_recall") continue;
    const reference = event.payload.contextReference;
    if (reference?.sourceClass !== "memory") continue;
    const target = reference.sourceId === "project-memory" ? projectMemory : reference.sourceId === "long-term-memory" ? longTermMemory : undefined;
    if (target === undefined) continue;
    for (const id of reference.sourceRange.split(",").map((value) => value.trim()).filter(Boolean)) target.add(id);
  }
  return { projectMemory: [...projectMemory], longTermMemory: [...longTermMemory] };
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#f4f5f2",
    title: "vc-agent",
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, "../preload/preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  void window.loadFile(join(__dirname, "../renderer/index.html"));
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => { mainWindow = null; });
  return window;
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  const runtimePaths = resolveDesktopRuntimePaths({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDirectory: __dirname
  });
  bundledAcademicSkillsRoot = runtimePaths.bundledAcademicSkillsRoot;
  if (app.isPackaged) {
    const missingRuntimeComponents = validatePackagedRuntimePaths(runtimePaths);
    if (missingRuntimeComponents.length > 0) {
      throw new Error(`PACKAGED_RUNTIME_INCOMPLETE:${missingRuntimeComponents.join(",")}`);
    }
  }
  if (runtimePaths.parserPython !== undefined) process.env.VC_AGENT_PYTHON = runtimePaths.parserPython;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith("http://") || details.url.startsWith("https://")) externalNetworkRequests += 1;
    callback({});
  });
  stateStore = new HostStateStore(join(app.getPath("userData"), "state.db"), {
    failAfterStageValidation: process.env.NODE_ENV === "test" && process.env.VC_AGENT_TEST_MIGRATION_FAIL_AFTER_STAGE === "1"
  });
  loadIntegrationJobs(join(app.getPath("userData"), "integrations", "jobs.json"));
  skillsDirectory = new SkillPackageManager({ root: join(app.getPath("userData"), "skills") });
  skillProjector = new SkillResourceProjector({ manager: skillsDirectory });
  executionScheduler = new BoundedExecutionScheduler({ capacity: EXECUTION_CAPACITY, store: stateStore });
  workerSupervisor = new AgentWorkerSupervisor(runtimePaths.agentWorkerEntry, handleWorkerEvent);
  turnExecution = new HostTurnExecutionModule((command) => workerSupervisor!.execute(command));
  extensionAuditWorker = new ExtensionAuditWorkerExecutor({
    supervisor: workerSupervisor,
    root: join(app.getPath("userData"), "integrations", "extensions", "audit-sessions")
  });
  subAgentProviderExecutor = new DesktopSubAgentProviderExecutor({
    supervisor: workerSupervisor,
    root: app.getPath("userData"),
    resolveProjectPath: (projectId) => stateStore?.getProject(projectId)?.path,
    resolveCredential: (profileId) => {
      const profile = stateStore?.getModelProfile(profileId);
      if (profile === undefined) return undefined;
      const encrypted = stateStore?.getEncryptedCredential(profile.credentialRef);
      if (encrypted === undefined) return undefined;
      try { return credentials.decrypt(encrypted); } catch { return undefined; }
    },
    resources: (): RuntimeResourceSnapshot => {
      const revision = stateStore?.getActiveSystemPromptRevision();
      return {
        schemaVersion: 1,
        revisionId: revision?.id ?? "sub-agent-fallback-v1",
        systemPrompt: revision?.content ?? SHIPPED_MINIMAL_VC_SYSTEM_PROMPT,
        appendSystemPrompt: []
      };
    },
    extensions: () => extensionRuntimeSnapshot(),
    resolveCapability: resolveSubAgentCapability
  });
  const subAgentContextCompiler = new SubAgentContextCompiler({ resolve: resolveSubAgentContextReference });
  subAgentRuntime = new SubAgentRuntime({
    path: join(app.getPath("userData"), "delegation", "runs.json"),
    resolver: { resolve: resolveSubAgentProfile },
    adapter: new ProviderSubAgentAdapter(subAgentProviderExecutor, { contextCompiler: subAgentContextCompiler }),
    scheduler: executionScheduler,
    capacity: Math.max(1, Math.min(EXECUTION_CAPACITY, Number.parseInt(process.env.VC_AGENT_SUB_AGENT_CAPACITY ?? String(EXECUTION_CAPACITY), 10) || EXECUTION_CAPACITY)),
    readOnly: stateStore.isReadOnlyRecovery,
    onEvent: (runtimeEvent) => { if (!shuttingDown) emit(subAgentHostEvent(runtimeEvent)); }
  });
  extensionAdmission = new ExtensionAdmissionManager({ root: join(app.getPath("userData"), "integrations", "extensions"), scheduler: executionScheduler, auditAdapter: createDesktopExtensionAuditAdapter({ resolveProfile: (profileId) => {
    const store = stateStore;
    if (store === null) return undefined;
    const profile = store.getModelProfile(profileId);
    if (profile === undefined) return undefined;
    const encrypted = store.getEncryptedCredential(profile.credentialRef);
    if (encrypted === undefined) return undefined;
    try { return { provider: profile.provider, model: profile.model, apiKey: credentials.decrypt(encrypted), thinkingLevel: profile.thinkingLevel }; } catch { return undefined; }
  }, executeAudit: (input) => {
    if (extensionAuditWorker === null) throw new Error("EXTENSION_AUDIT_PROVIDER_UNAVAILABLE");
    return extensionAuditWorker.execute(input);
  } }) });
  globalExtensionRevisions = new GlobalExtensionRevisionManager({
    root: join(app.getPath("userData"), "integrations", "extensions"),
    admission: extensionAdmission,
    isGloballyIdle: () => (executionScheduler?.telemetry().runningCount ?? 0) === 0 && (workerSupervisor?.activity.activeSessions ?? 0) === 0,
    terminateWorkers: () => { workerSupervisor?.closeAll(); }
  });
  utilityJobRunner = new UtilityJobRunner(runtimePaths.utilityWorkerEntry);
  officeOrchestrator = new OfficeSkillOrchestrator({ skills: skillsDirectory, adapter: createDesktopOfficeAdapter({ runner: utilityJobRunner }), root: join(app.getPath("userData"), "integrations", "office") });
  skillCreatorWorkflow = new SkillCreationWorkflow({ manager: skillsDirectory, root: join(app.getPath("userData"), "integrations", "skill-creator") });
  const ocrRuntimeRoot = resolve(process.env.VC_AGENT_OCR_RUNTIME_ROOT ?? join(process.env.LOCALAPPDATA ?? app.getPath("userData"), "vc-agent", "runtimes", "ocr"));
  const localOcrOptions = { runner: utilityJobRunner, runtimeRoot: ocrRuntimeRoot, stagingRoot: join(app.getPath("userData"), "integrations", "page-recovery", "staging") };
  const useFixtureOcr = process.env.NODE_ENV === "test" && process.env.VC_AGENT_REAL_OCR !== "1";
  pageRecoveryPipeline = new PageRecoveryPipeline(useFixtureOcr
    ? { native: createDesktopNativePdfAdapter(), paddle: createDesktopPaddleAdapter(), ovis: createDesktopOvisAdapter() }
    : { native: createDesktopNativePdfAdapter(localOcrOptions), paddle: createDesktopPaddleAdapter(localOcrOptions), ovis: createDesktopOvisAdapter(localOcrOptions) });
  mcpIntegration = new McpIntegrationManager({
    root: join(app.getPath("userData"), "integrations", "mcp"),
    adapter: createDesktopMcpAdapter(),
    credentials: { resolve: (reference) => { const encrypted = stateStore?.getEncryptedCredential(reference); if (encrypted === undefined) return undefined; try { return credentials.decrypt(encrypted); } catch { return undefined; } } }
  });
  const readOnlyRecovery = stateStore.isReadOnlyRecovery;
  if (!readOnlyRecovery) stateStore.recoverInterruptedReflections();
  if (!readOnlyRecovery) stateStore.recoverQueuedExecutionAsDrafts();
  if (!readOnlyRecovery) stateStore.clearStaleExecutionLeases();
  longTermMemories = new LongTermMemoryStore(join(app.getPath("userData"), "memory", "long-term"));
  if (!readOnlyRecovery) {
    memoryEvolution = new MemoryEvolutionStore(longTermMemories);
    projectMemories = new ProjectMemoryStore(join(app.getPath("userData"), "memory", "project-index"));
    memoryCandidates = new MemoryCandidateStore(join(app.getPath("userData"), "memory", "candidates.jsonl"));
  }
  reflectionOutcomes = new ReflectionOutcomeStore(join(app.getPath("userData"), "memory", "reflection", "outcomes.jsonl"));
  trajectoryStore = new ThreadTrajectoryStore(join(app.getPath("userData"), "threads"), { createRoot: !readOnlyRecovery });
  dreamReviews = new DreamReviewStore(join(app.getPath("userData"), "memory", "dream"), { createRoot: !readOnlyRecovery });
  if (!readOnlyRecovery && memoryEvolution !== null && projectMemories !== null && memoryCandidates !== null) dreamCommits = new DreamCommitStore(join(app.getPath("userData"), "memory", "dream"), { reviews: dreamReviews, evolution: memoryEvolution, memory: longTermMemories, projectMemory: projectMemories, candidates: memoryCandidates });
  if (!readOnlyRecovery) dreamReviews.recoverInterruptedScopes();
  for (const thread of stateStore.listThreads()) {
    if (!readOnlyRecovery) trajectoryStore.recoverInterruptedTurns(thread.id);
    const lastSequence = trajectoryStore.loadEvents(thread.id).at(-1)?.sequence ?? 0;
    sequenceByThread.set(thread.id, lastSequence);
  }
  if (!readOnlyRecovery) synchronizeDreamSchedulingIndex();
  inflight = new InflightTurnCoordinator(trajectoryStore);
  if (!readOnlyRecovery) stateStore.ensureDefaultSystemPrompt(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT);
  if (!readOnlyRecovery) personalCognition = new PersonalCognitionBackupService({
    state: stateStore,
    memoryFiles: {
      "long-term-memory.md": longTermMemories.markdownPath,
      "long-term-memory-condensation-archive.md": longTermMemories.archivePath,
      "cognitive-evolution-history.md": longTermMemories.historyPath,
      "long-term-maintenance.json": join(app.getPath("userData"), "memory", "long-term-maintenance.json")
    },
    skillsRoot: join(app.getPath("userData"), "skills")
  });
  capabilityRegistry = new CapabilityRegistry();
  const textOutputStore = new TextOutputStore();
  capabilityRegistry.register(createTextOutputCapability(textOutputStore));
  capabilityRegistry.register(createTextEditCapability(textOutputStore));
  capabilityRegistry.register(createFileDownloadCapability(new BinaryOutputStore(), new FetchFileDownloadClient()));
  capabilityRegistry.register(createProjectCommandCapability({
    run: async ({ projectRoot, invocation }) => {
      if (utilityJobRunner === null) throw new Error("Utility Worker is unavailable.");
      const event = await utilityJobRunner.run({
        schemaVersion: 1,
        command: "project.command",
        jobId: randomUUID(),
        projectRoot,
        invocation,
        timeoutMs: 10_000,
        maxOutputBytes: 20_000
      });
      if (event.event === "project.command.failed") {
        return { exitCode: -1, stdout: "", stderr: `${event.code}: ${event.message}${event.stderr === "" ? "" : `\n${event.stderr}`}` };
      }
      return { exitCode: event.exitCode, stdout: event.stdout, stderr: event.stderr };
    }
  }));
  const academicHttp = new DefaultAcademicHttpAccess();
  const academicStagingRoot = join(app.getPath("userData"), "academic-research", "staging");
  const configuredArxivIntervalMs = Number.parseInt(process.env.VC_AGENT_ARXIV_INTERVAL_MS ?? "3000", 10);
  const academicResearch = new AcademicResearchService({
    http: academicHttp,
    runStore: new AcademicResearchRunStore(join(app.getPath("userData"), "academic-research", "runs")),
    extractPdf: async ({ url, arxivId, maxChars, signal }) => {
      if (utilityJobRunner === null) throw new Error("ACADEMIC_PDF_EXTRACTOR_UNAVAILABLE");
      const response = await academicHttp.request({ url, signal, maxBytes: 50 * 1024 * 1024, timeoutMs: 30_000 });
      if (!response.status.toString().startsWith("2")) throw new Error(`ARXIV_PDF_HTTP_${response.status}`);
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.includes("pdf") && new TextDecoder().decode(response.body.subarray(0, 5)) !== "%PDF-") throw new Error("ARXIV_PDF_CONTENT_TYPE_INVALID");
      const hash = createHash("sha256").update(response.body).digest("hex");
      const jobId = randomUUID();
      mkdirSync(academicStagingRoot, { recursive: true });
      const stagedPath = join(academicStagingRoot, `${jobId}-${arxivId.replace(/[^A-Za-z0-9.-]/gu, "_")}.pdf`);
      writeFileSync(stagedPath, response.body, { flag: "wx" });
      try {
        const event = await utilityJobRunner.run({
          schemaVersion: 1,
          command: "academic.pdf.extract",
          jobId,
          absolutePath: stagedPath,
          expectedHash: hash,
          maxChars,
          timeoutMs: 120_000,
          maxOutputBytes: 5_000_000
        });
        if (event.event === "academic.pdf.extract.failed") throw new Error(`${event.code}:${event.message}`);
        return {
          contentHash: event.contentHash,
          pageCount: event.pageCount,
          sections: event.sections,
          warnings: event.warnings
        };
      } finally {
        rmSync(stagedPath, { force: true });
      }
    },
    arxivMinimumIntervalMs: Number.isFinite(configuredArxivIntervalMs) ? Math.max(3_000, configuredArxivIntervalMs) : 3_000
  });
  capabilityRegistry.register(createAcademicResearchCapability(async (input, context) => academicResearch.execute(input, {
    turnId: context.request.turnId,
    credentials: resolveAcademicCredentials()
  })));
  capabilityRegistry.register(createCapabilityBroker((input, context) => {
    const turn = turnExecution!.getTurn(context.request.turnId);
    if (turn === undefined) return [];
    const catalog = turn.capabilitySurface.requestableCatalog.filter((entry) => !turn.activeCapabilities.includes(entry.id));
    if ("mode" in input && input.mode === "catalog") {
      return {
        kind: "catalog" as const,
        catalogRevision: turn.capabilitySurface.revision,
        entries: catalog.map((entry) => ({
          id: entry.id,
          label: entry.label,
          useWhen: entry.useWhen,
          tier: entry.tier,
          sideEffectClass: entry.sideEffectClass,
          requiresUserIntent: entry.requiresUserIntent
        }))
      };
    }
    const requestedIds = "mode" in input && input.mode === "activate"
      ? input.capabilityIds
      : input.capabilityId === undefined ? [] : [input.capabilityId];
    const catalogRevision = "mode" in input && input.mode === "activate" ? input.catalogRevision : turn.capabilitySurface.revision;
    if (catalogRevision !== turn.capabilitySurface.revision) {
      return {
        kind: "activation" as const,
        catalogRevision: turn.capabilitySurface.revision,
        activatedCapabilities: [],
        alreadyVisible: [],
        rejected: requestedIds.map((id) => ({ id, code: "STALE_CATALOG" as const, reason: "Capability catalog changed before activation." }))
      };
    }
    const catalogIds = new Set(catalog.map((entry) => entry.id));
    const alreadyVisible = requestedIds.filter((id) => turn.activeCapabilities.includes(id));
    const candidates = requestedIds.filter((id) => !alreadyVisible.includes(id));
    const activatedCapabilities: string[] = [];
    const rejected: Array<{ id: string; code: "CAPABILITY_UNAVAILABLE" | "USER_INTENT_REQUIRED"; reason: string }> = [];
    for (const id of candidates) {
      if (!catalogIds.has(id)) {
        rejected.push({ id, code: "CAPABILITY_UNAVAILABLE", reason: "Capability is not requestable for this Turn." });
        continue;
      }
      if (id === "memory_recall" && turn.memoryRecallMode === "none") {
        rejected.push({ id, code: "USER_INTENT_REQUIRED", reason: "Memory recall requires judgment-heavy work or an explicit User request." });
        continue;
      }
      if (turn.capabilityActivationCount + activatedCapabilities.length >= 16) {
        rejected.push({ id, code: "CAPABILITY_UNAVAILABLE", reason: "The per-Turn dynamic capability limit has been reached." });
        continue;
      }
      activatedCapabilities.push(id);
    }
    turn.capabilityActivationCount += activatedCapabilities.length;
    return {
      kind: "activation" as const,
      catalogRevision: turn.capabilitySurface.revision,
      activatedCapabilities,
      alreadyVisible,
      ...(rejected.length === 0 ? {} : { rejected })
    };
  }));
  capabilityRegistry.register(createMaterialRecallCapability(async (input, context) => {
    const scope = context.request.scope;
    if (scope.kind === "project" && input.materialId !== undefined) {
      const refresh = stateStore!.getStaleMaterialRefreshContext(input.materialId);
      if (refresh !== undefined) {
        emit({
          ...eventMetadata(context.request.correlationId, context.request.threadId, HOST_ACTOR, HOST_PROVENANCE),
          event: "material.parse.refresh.choice.required",
          payload: { ...refresh, currentSourceHash: refresh.material.sourceHash }
        });
      }
    }
    const source = new MaterialRecallSource({
      listMaterials: () => scope.kind === "project" ? stateStore!.listMaterials(scope.projectId) : [],
      loadParse: async (materialId) => {
        if (scope.kind !== "project") return { status: "unavailable" as const, code: "MATERIAL_SCOPE_UNAVAILABLE", message: "Project Materials are unavailable in this Thread scope." };
        let parsed = stateStore!.getCurrentParsedMaterial(materialId);
        if (parsed === undefined) {
          const parsedEvent = await parseMaterial(context.request.correlationId, materialId);
          if (parsedEvent.event !== "material.parse.completed") {
            return parsedEvent.event === "material.parse.failed"
              ? { status: "unavailable" as const, code: parsedEvent.payload.code, message: parsedEvent.payload.message }
              : { status: "unavailable" as const, code: "PARSE_FAILED", message: "Material parsing did not produce a completed parse." };
          }
          parsed = stateStore!.getCurrentParsedMaterial(materialId);
        }
        const project = stateStore!.getProject(scope.projectId);
        if (parsed === undefined || project === undefined) return { status: "unavailable" as const, code: "PARSE_RECORD_UNAVAILABLE", message: "The parse completed but its committed artifact could not be located." };
        try { return canonicalParseSchema.parse(JSON.parse(readFileSync(join(project.path, parsed.artifact_path), "utf8"))); }
        catch { return { status: "unavailable" as const, code: "PARSE_ARTIFACT_INVALID", message: "The committed Canonical Parse artifact is missing or invalid." }; }
      }
    });
    const query = {
      disclosureLevel: input.disclosureLevel,
      ...(input.materialId === undefined ? {} : { materialId: input.materialId }),
      ...(input.blockIds === undefined ? {} : { blockIds: input.blockIds }),
      ...(input.query === undefined ? {} : { query: input.query })
    };
    const envelope = await source.recall(query, { turnId: context.request.turnId, maxItems: input.maxItems, maxChars: input.maxChars, retrievedAt: new Date().toISOString() });
    return serializeBoundedRetrieval(envelope);
  }));
  capabilityRegistry.register(createReflectionEvidenceDrilldownCapability(async (input, context) => {
    const turn = turnExecution!.getTurn(context.request.turnId);
    const run = turn?.reflectionRunId === undefined ? undefined : stateStore!.getReflectionRun(turn.reflectionRunId);
    if (run?.scope !== "project" || !["memory_aware_running", "dialogue_active"].includes(run.status) || run.assessment === undefined) {
      throw new Error("Evidence Drilldown requires an active Project Reflection with a completed Independent Assessment.");
    }
    const assessmentReference = run.assessment.evidenceReferences.find((reference) => reference.referenceId === input.referenceId);
    if (assessmentReference === undefined) throw new Error("Evidence Drilldown can resolve only references present in the frozen Independent Assessment.");
    const source = new ReflectionEvidenceDrilldownSource({
      listMaterials: () => stateStore!.listMaterials(run.projectId),
      loadParse: async (materialId) => {
        let parsed = stateStore!.getCurrentParsedMaterial(materialId);
        if (parsed === undefined) {
          const parsedEvent = await parseMaterial(context.request.correlationId, materialId);
          if (parsedEvent.event !== "material.parse.completed") return undefined;
          parsed = stateStore!.getCurrentParsedMaterial(materialId);
        }
        const project = stateStore!.getProject(run.projectId);
        if (parsed === undefined || project === undefined) return undefined;
        try { return canonicalParseSchema.parse(JSON.parse(readFileSync(join(project.path, parsed.artifact_path), "utf8"))); }
        catch { return undefined; }
      }
    });
    const envelope = await source.recall(
      { referenceId: input.referenceId, claim: assessmentReference.claim },
      { turnId: context.request.turnId, maxItems: 1, maxChars: input.maxChars, retrievedAt: new Date().toISOString() }
    );
    return serializeBoundedRetrieval(envelope);
  }));
  capabilityRegistry.register(createProjectStateRecallCapability(async (input, context) => {
    const scope = context.request.scope;
    if (scope.kind !== "project") throw new Error("Project Context recall requires a Project scope.");
    const project = stateStore!.getProject(scope.projectId);
    if (project === undefined) throw new Error("Project is unavailable.");
    const source = new ProjectContextRecallSource({ load: () => projectContexts.load(project.id, project.path, false) });
    const envelope = await source.recall(
      { ...(input.sectionIds === undefined ? {} : { sectionIds: input.sectionIds }), ...(input.query === undefined ? {} : { query: input.query }) },
      { turnId: context.request.turnId, maxItems: input.maxItems, maxChars: input.maxChars, retrievedAt: new Date().toISOString() }
    );
    return serializeBoundedRetrieval(envelope);
  }));
  capabilityRegistry.register(createMemoryRecallCapability(async (input, context) => {
    const scope = context.request.scope;
    const turn = turnExecution!.getTurn(context.request.turnId);
    if (turn === undefined || turn.memoryRecallMode === "none") throw new Error("Memory recall requires judgment-heavy work or an explicit User request.");
    let envelope;
    if (input.source === "project_memory") {
      if (scope.kind !== "project") throw new Error("Project Memory requires Project scope.");
      const project = stateStore!.getProject(scope.projectId);
      if (project === undefined || projectMemories === null) throw new Error("Project Memory is unavailable.");
      const source = new ProjectMemoryRecallSource(() => projectMemories!.load(project.id, project.path, false));
      envelope = await source.recall({ disclosureLevel: input.disclosureLevel, ...(input.entryIds ? { entryIds: input.entryIds } : {}), ...(input.query ? { query: input.query } : {}) }, { turnId: context.request.turnId, maxItems: input.maxItems, maxChars: input.maxChars, retrievedAt: new Date().toISOString() });
    } else {
      if (longTermMemories === null) throw new Error("Long-term Memory is unavailable.");
      if (input.disclosureLevel === "full") {
        if (input.entryIds === undefined || input.entryIds.length === 0 || input.entryIds.some((id) => !turn.longTermMemoryCardIds.has(id))) {
          throw new Error("Expand only Long-term Memory cards returned earlier in this Turn.");
        }
      }
      const preferredEntryIds = turn.reflectionRunId === undefined || memoryEvolution === null ? undefined : memoryEvolution.preferredMemoryEntryIds(scope.kind === "project" ? scope.projectId : "");
      const source = new LongTermMemoryRecallSource(longTermMemories, preferredEntryIds === undefined ? {} : { preferredEntryIds });
      envelope = await source.recall({ mode: turn.memoryRecallMode, disclosureLevel: input.disclosureLevel, ...(input.entryIds ? { entryIds: input.entryIds } : {}), ...(input.query ? { query: input.query } : {}) }, { turnId: context.request.turnId, maxItems: input.maxItems, maxChars: input.maxChars, retrievedAt: new Date().toISOString() });
      if (input.disclosureLevel === "cards") for (const item of envelope.items) turn.longTermMemoryCardIds.add(item.id);
    }
    return serializeBoundedRetrieval(envelope);
  }));
  capabilityRegistry.register(createReflectionOutcomeProposalCapability(async (input, context) => {
    const turn = turnExecution!.getTurn(context.request.turnId);
    if (turn?.reflectionRunId === undefined || !turn.reflectionOutcomeIntent || reflectionOutcomes === null) {
      throw new Error("Reflection outcomes require an explicit User request in an active Reflection dialogue.");
    }
    const run = stateStore!.getReflectionRun(turn.reflectionRunId);
    if (run === undefined || run.status !== "dialogue_active") throw new Error("Reflection dialogue is not active.");
    const created = reflectionOutcomes.propose(run.id, input, reflectionOutcomeDependencies(run, input));
    emit(reflectionOutcomesEvent(context.request.correlationId, run.id, run.threadId));
    return JSON.stringify({ status: "drafted", judgmentCount: created.judgments.length, learningProposalCount: created.learningProposals.length });
  }));
  const publicWeb = process.env.VC_AGENT_TEST_WEB_FIXTURE === "1"
    ? new PublicWebRecallSource({
        resolve: async () => ["93.184.216.34"],
        fetch: async () => new Response('<html><body><li class="b_algo"><h2><a href="https://example.com/market">Fixture market evidence</a></h2><div class="b_caption"><p>Public evidence for the bounded dogfood workflow.</p></div></li></body></html>', { status: 200, headers: { "content-type": "text/html" } })
      })
    : new PublicWebRecallSource();
  capabilityRegistry.register(createWebSearchCapability(async (input, context) => {
    const envelope = await publicWeb.recall(
      { kind: "search", query: input.query },
      { turnId: context.request.turnId, maxItems: input.maxResults, maxChars: input.maxChars, retrievedAt: new Date().toISOString() }
    );
    return serializeBoundedRetrieval(envelope);
  }));
  capabilityRegistry.register(createWebFetchCapability(async (input, context) => {
    const envelope = await publicWeb.recall(
      { kind: "fetch", url: input.url },
      { turnId: context.request.turnId, maxItems: 1, maxChars: input.maxChars, retrievedAt: new Date().toISOString() }
    );
    return serializeBoundedRetrieval(envelope);
  }));
  capabilityGateway = new CapabilityGateway(capabilityRegistry);
  if (!readOnlyRecovery) {
    for (const project of stateStore.listProjects()) {
      startMaterialWatcher(project.id);
      void refreshProjectInventory(randomUUID(), project.id, false).catch(() => undefined);
    }
  }
  ipcMain.handle(COMMAND_CHANNEL, handleCommand);
  mainWindow = createMainWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", (event) => {
  if (allowQuitAfterShutdown) return;
  if (shutdownPromise !== null) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  shutdownPromise = shutdownApplication().finally(() => { allowQuitAfterShutdown = true; app.quit(); });
});

async function shutdownApplication(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const execution of turnExecution?.activeExecutions() ?? []) {
    if (execution.kind === "turn") {
      interruptTurn(execution.context, "application_restart", 0);
    } else if (execution.kind === "reflection") {
      const run = stateStore?.getReflectionRun(execution.context.runId);
      if (run?.status === "independent_running") stateStore?.interruptIndependentAssessment(execution.context.runId);
      turnExecution?.finish(execution);
    } else if (execution.kind === "dream") {
      try { dreamReviews?.failScope(execution.context.batchId, execution.context.scope.id, { kind: "worker", code: "APPLICATION_RESTART", message: "Dream scope extraction was interrupted by application restart and remains Pending for explicit retry.", provider: execution.context.profile.provider, model: execution.context.profile.model }); }
      catch { /* Preserve already completed scope state. */ }
      turnExecution?.finish(execution);
    } else {
      try { dreamReviews?.failSynthesis(execution.context.batchId, { kind: "worker", code: "APPLICATION_RESTART", message: "Global Dream Synthesis was interrupted by application restart and requires explicit retry.", provider: execution.context.profile.provider, model: execution.context.profile.model }); }
      catch { /* Preserve already completed synthesis state. */ }
      turnExecution?.finish(execution);
    }
  }
  ipcMain.removeHandler(COMMAND_CHANNEL);
  const subAgentShutdown = subAgentRuntime?.shutdown() ?? Promise.resolve();
  subAgentRuntime = null;
  const workerShutdown = workerSupervisor?.shutdown(5_000) ?? Promise.resolve();
  const officeRuntime = officeOrchestrator;
  const utilityRuntime = utilityJobRunner;
  const officeShutdown = officeRuntime?.shutdown() ?? Promise.resolve();
  const utilityShutdown = officeShutdown.then(() => utilityRuntime?.shutdown(5_000) ?? Promise.resolve(), () => utilityRuntime?.shutdown(5_000) ?? Promise.resolve());
  utilityJobRunner = null;
  const skillCreatorShutdown = skillCreatorWorkflow?.shutdown() ?? Promise.resolve();
  const mcpShutdown = mcpIntegration?.shutdown() ?? Promise.resolve();
  officeOrchestrator = null;
  skillCreatorWorkflow = null;
  pageRecoveryPipeline = null;
  mcpIntegration = null;
  persistIntegrationJobs();
  integrationJobsPath = undefined;
  const extensionShutdown = extensionAdmission?.shutdown() ?? Promise.resolve();
  extensionAdmission = null;
  globalExtensionRevisions = null;
  skillProjector = null;
  bundledAcademicSkillsRoot = null;
  skillsDirectory = null;
  for (const state of materialWatchers.values()) {
    state.watcher.close();
    if (state.timer !== undefined) clearTimeout(state.timer);
    if (state.contextTimer !== undefined) clearTimeout(state.contextTimer);
    if (state.memoryTimer !== undefined) clearTimeout(state.memoryTimer);
  }
  materialWatchers.clear();
  longTermMemoryWatcher?.close();
  longTermMemoryWatcher = null;
  if (longTermMemoryWatchTimer !== undefined) clearTimeout(longTermMemoryWatchTimer);
  longTermMemoryWatchTimer = undefined;
  workerSupervisor = null;
  turnExecution = null;
  extensionAuditWorker = null;
  stateStore?.close();
  stateStore = null;
  projectMemories = null;
  longTermMemories = null;
  memoryCandidates = null;
  await Promise.allSettled([subAgentShutdown, workerShutdown, utilityShutdown, officeShutdown, skillCreatorShutdown, mcpShutdown, extensionShutdown]);
}
