import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from "electron";
import {
  IPC_SCHEMA_VERSION,
  canonicalParseSchema,
  hostCommandSchema,
  thinkingLevelSchema,
  type ArtifactRecord,
  type ActorRef,
  type AcademicCredentialSource,
  type CapabilityExecutionRequest,
  type CapabilityExecutionResult,
  type HostCommand,
  type HostEvent,
  type ReflectionRun,
  type ReflectionReviewInput,
  type CognitionDependency,
  type LearningProposal,
  type ReviewBundle,
  type JudgmentRecordDraft,
  type LongTermLearningProposal,
  type MaterialInventoryItem,
  type ModelProfile,
  type ProvenanceRef,
  type ProviderFailure,
  type ProjectOutputArtifact,
  type ReflectionOutcomeProposalInput,
  type SystemPromptRevision,
  type AutoMemoryReviewPolicy,
  type EligibleLearningSource,
  type Thread,
  type TrajectoryEvent,
  type TrajectoryProfile,
  type WorkerCommand,
  type WorkerEvent,
  type IntegrationState,
  type IntegrationJobSummary,
  type SubAgentProfileSnapshot,
  type SubAgentRole,
  type RuntimeResourceSnapshot,
  type PiResourcesSettingsState,
  type SubAgentContextBoundary,
  type TaskModelType,
  reflectionCompletionTransition,
  reflectionLaunchTransition
} from "@vc-agent/contracts";
import { MAX_ARXIV_BUNDLE_BYTES, BinaryOutputStore, CapabilityRegistry, WorkspaceWriteStore, capabilitiesForTurn, createAcademicResearchCapability, createArxivFulltextCapability, createCapabilityBroker, createFileDownloadCapability, createMaterialRecallCapability, createMemoryRecallCapability, createProjectStateRecallCapability, createReflectionEvidenceDrilldownCapability, createReflectionOutcomeProposalCapability, createRuntimeExtensionCapability, createTextEditCapability, createTextOutputCapability, createTurnCapabilitySurface, createWorkspaceWriteCapability, FetchFileDownloadClient, TextOutputStore, type CapabilityExecutionContext } from "@vc-agent/capabilities";
import { PI_BUILTIN_PROVIDER_IDS } from "@vc-agent/pi-adapter/provider-catalog";
import { PROJECT_READ_TOOL_METADATA, PROJECT_READ_TOOL_NAMES } from "@vc-agent/pi-adapter/project-read-tool-metadata";
import { AcademicResearchService, BASELINE_PARSER_ADAPTERS, CapabilityGateway, CognitionReviewModule, CognitionReviewStore, CitationRegistry, CITATION_OUTPUT_INSTRUCTIONS, ContextBudgetService, createCognitionReviewModule, createMemoryReviewOrchestrator, createReflectionDrafts, DEFAULT_PROJECT_REFLECTION_OBJECTIVE, DEFAULT_UNSCOPED_REFLECTION_OBJECTIVE, DefaultAcademicHttpAccess, INDEPENDENT_EVIDENCE_STAGE_INSTRUCTIONS, INDEPENDENT_UNSCOPED_EVIDENCE_STAGE_INSTRUCTIONS, LearningEpochReset, MEMORY_AWARE_REFLECTION_INSTRUCTIONS, MEMORY_REVIEW_EXTRACTION_STAGE_INSTRUCTIONS, MEMORY_REVIEW_SYNTHESIS_STAGE_INSTRUCTIONS, LongTermMemoryRecallSource, LongTermMemoryStore, MemoryCandidateStore, MemoryEvolutionStore, PersonalCognitionBackupService, ProjectOutputRegistry, ReflectionEvidenceDrilldownSource, ReflectionRunStore, academicWorkflowPrototype, buildIndependentEvidencePrompt, buildMemoryAwareReflectionPrompt, buildReflectionProjectBrief, buildReflectionUnscopedBrief, captureReflectionDependencies, detectAcademicResearchIntent, detectArxivFulltextIntent, detectExplicitMemoryRecallIntent, detectFileDownloadIntent, detectJudgmentHeavyIntent, detectMaterialRecallIntent, detectMemoryCandidateSignal, detectOutputIntent, detectProjectStateRecallIntent, detectTextEditIntent, detectWebResearchIntent, estimateTokens, expectedParserIdentity, inventoryProjectFiles, MaterialRecallSource, parseIndependentAssessment, ProjectContextRecallSource, ProjectContextStore, ProjectIdentityStore, ProjectMemoryRecallSource, ProjectMemoryStore, reflectionDependencyFingerprint, reflectionFraming, retrievalTrajectorySummary, selectEligibleLearningSources, serializeBoundedRetrieval, SHIPPED_MINIMAL_VC_SYSTEM_PROMPT, staleReflectionDependencies, type MemoryReviewOrchestrator, type MemoryReviewPreparationResult, type MemoryReviewProfileSnapshot, type MemoryReviewPromptSnapshot, type MemoryReviewProgress, type MemoryReviewSynthesisCard, type CapabilityAuthorizationSnapshot, type ReflectionDependencyState, type ReflectionDrafts } from "@vc-agent/host-services";
import { BoundedExecutionScheduler, OfficeSkillOrchestrator, PageRecoveryPipeline, ProviderSubAgentAdapter, SkillCreationWorkflow, SubAgentContextCompiler, SubAgentRuntime, VcSkillsDirectoryAdapter, resolveVcAgentUserDataRoot, type SkillDraft, type SkillDraftReview, type SubAgentRuntimeEvent } from "@vc-agent/host-services";
import { AcademicResearchRunStore } from "@vc-agent/host-services";
import { evaluateAutomaticMemoryReview } from "@vc-agent/host-services";
import { PiIntegrationMigration, type PiIntegrationMigrationDiagnostic } from "@vc-agent/host-services";
import { exportRawStateBundle, HostStateStore, restoreStateStorageRollback, ThreadTrajectoryStore } from "@vc-agent/persistence";
import { AgentWorkerSupervisor } from "./agent-worker-supervisor.js";
import { InflightTurnCoordinator } from "./inflight-turn-coordinator.js";
import { UtilityJobRunner } from "./utility-job-runner.js";
import { BundledArxivFulltextClient } from "./arxiv-fulltext-client.js";
import { ProtectedCredentialService } from "./protected-credential-service.js";
import { resolveDesktopRuntimePaths, validatePackagedRuntimePaths } from "./runtime-paths.js";
import { DesktopSubAgentProviderExecutor, providerCapabilityIds, type SubAgentCapabilityExecutionContext } from "./sub-agent-provider-executor.js";
import { createDesktopNativePdfAdapter, createDesktopOfficeAdapter, createDesktopOvisAdapter, createDesktopPaddleAdapter } from "./integration-adapters.js";
import { HostTurnExecutionModule, type ReflectionExecutionContext, type TurnContext } from "./turn-execution.js";

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
  "integration.state.load",
  "pi.resources.load",
  "pi.resources.open",
  "office.source.choose",
  "office.artifact.open",
  "skill_creator.list",
  "page_recovery.inspect",
  "prompt.revision.list",
  "task_model_assignment.list",
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
// Set when the one-shot cognition-v2 Learning Epoch reset cannot activate.
// This is intentionally separate from HostStateStore's migration mode: the
// SQLite schema may be writable while the cognition file reset is not.
let learningEpochRecovery = false;
let trajectoryStore: ThreadTrajectoryStore | null = null;
let inflight: InflightTurnCoordinator | null = null;
let workerSupervisor: AgentWorkerSupervisor | null = null;
let turnExecution: HostTurnExecutionModule | null = null;
let capabilityGateway: CapabilityGateway | null = null;
let utilityJobRunner: UtilityJobRunner | null = null;
let capabilityRegistry: CapabilityRegistry | null = null;
let projectMemories: ProjectMemoryStore | null = null;
let longTermMemories: LongTermMemoryStore | null = null;
let memoryEvolution: MemoryEvolutionStore | null = null;
let memoryCandidates: MemoryCandidateStore | null = null;
let reflectionDrafts: ReflectionDrafts | null = null;
let reflectionRuns: ReflectionRunStore | null = null;
let cognitionReviews: CognitionReviewModule | null = null;
let cognitionReviewStore: CognitionReviewStore | null = null;
const reflectionReviewRuns = new Map<string, string>();
let memoryReviewOrchestrator: MemoryReviewOrchestrator | null = null;
let memoryReviewPolicy: AutoMemoryReviewPolicy | undefined;
let automaticReviewUserWorkCompletedInAppRun = false;
const memoryReviewWorkerStages = new Map<string, MemoryReviewWorkerStage>();
const memoryReviewCorrelationByBatch = new Map<string, string>();
let personalCognition: PersonalCognitionBackupService | null = null;
let executionScheduler: BoundedExecutionScheduler | null = null;
let vcSkillsDirectory: VcSkillsDirectoryAdapter | null = null;
let officeOrchestrator: OfficeSkillOrchestrator | null = null;
let skillCreatorWorkflow: SkillCreationWorkflow | null = null;
let pageRecoveryPipeline: PageRecoveryPipeline | null = null;
let subAgentRuntime: SubAgentRuntime | null = null;
let subAgentProviderExecutor: DesktopSubAgentProviderExecutor | null = null;
let lastPageRecoveryParse: IntegrationState["pageRecovery"]["lastParse"] | undefined;
let externalNetworkRequests = 0;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let allowQuitAfterShutdown = false;
let piResourcesGeneration = 0;
let piResourcesReloadPending = false;
let projectPiResourcesTrusted = false;
let piResourceMigrationDiagnostics: readonly PiIntegrationMigrationDiagnostic[] = [];
const sequenceByThread = new Map<string, number>();
const integrationJobs = new Map<string, IntegrationJobSummary>();
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

const EMPTY_WORKER_ACTIVITY = {
  agentWorkersStarted: 0,
  piSessionsStarted: 0,
  providerRequests: 0,
  projectWorkers: 0,
  unscopedWorkers: 0,
  activeSessions: 0,
  workerCrashes: 0
} as const;

function hostReadOnlyRecovery(): boolean {
  return learningEpochRecovery || stateStore?.isReadOnlyRecovery === true;
}

type MemoryReviewWorkerStage = {
  readonly batchId: string;
  readonly stage: "extraction" | "synthesis";
  readonly threadId: string;
  readonly turnId: string;
  readonly correlationId: string;
  readonly profile: ModelProfile;
  readonly resolve: (message: string) => void;
  readonly reject: (error: Error) => void;
};

type NativeSkillCompatibilitySnapshot = {
  readonly schemaVersion: 1;
  readonly revisionId: string;
  readonly decisions: readonly { readonly packageId: string }[];
  readonly instructions: readonly Record<string, unknown>[];
  readonly resources: readonly unknown[];
};
const EMPTY_RUNTIME_SKILLS: NativeSkillCompatibilitySnapshot = {
  schemaVersion: 1,
  revisionId: "skills-empty-v1",
  decisions: [],
  instructions: [],
  resources: []
};

function runtimeSkillsForTask(_task: string, _scope: "project" | "unscoped"): NativeSkillCompatibilitySnapshot {
  // Skill discovery and progressive disclosure now belong to Pi's native
  // ResourceLoader. Keep the transitional Worker field empty so Host never
  // projects or selects a legacy Skill revision.
  return EMPTY_RUNTIME_SKILLS;
}

function runtimeSkillMetadataText(skills: NativeSkillCompatibilitySnapshot): string {
  return JSON.stringify({
    revisionId: skills.revisionId,
    decisions: skills.decisions,
    instructions: skills.instructions
  });
}

function skillsDoctorMessage(): { readonly status: "ready" | "attention"; readonly message: string } {
  const snapshot = vcSkillsDirectory?.discover();
  if (snapshot === undefined || snapshot.skills.length === 0) return { status: "attention", message: "No Skill was found in the dedicated VC Agent directory; the directory remains dormant." };
  const errors = snapshot.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  return { status: errors === 0 ? "ready" : "attention", message: `${snapshot.skills.length} Skill(s) discovered in the dedicated VC Agent directory${errors === 0 ? "." : `; ${errors} validation diagnostic(s) require attention.`}` };
}

function officeSkillsDoctorMessage(): { readonly status: "ready" | "attention"; readonly message: string } {
  const imported = vcSkillsDirectory?.discover().skills ?? [];
  if (imported.length === 0) return { status: "attention", message: "No compatible Office Skill was found in the dedicated VC Agent directory; import a local Skill from Settings." };
  const runnerConfigured = (process.env.VC_AGENT_OFFICE_RUNNER?.trim() ?? "") !== "";
  const status = runnerConfigured ? "ready" : "attention";
  const dependencyMessage = runnerConfigured ? "an explicit Office runner is configured" : "VC_AGENT_OFFICE_RUNNER is not configured";
  return { status, message: `${imported.length} dedicated Office Skill(s) discovered; ${dependencyMessage}. Runtime dependencies are checked again at explicit Skill job admission; no fallback is used.` };
}

function piResourcesConfig(): NonNullable<Extract<WorkerCommand, { command: "turn.execute" }>["piResources"]> {
  const userData = app.getPath("userData");
  const agentDir = join(userData, "pi-agent");
  return {
    agentDir,
    skillsRoot: join(agentDir, "skills"),
    mcpConfigPath: join(agentDir, "mcp.json"),
    projectResourcesTrusted: projectPiResourcesTrusted
  };
}

function piResourcePaths(): {
  readonly agentDir: string;
  readonly extensions: string;
  readonly mcpConfig: string;
  readonly skills: string;
  readonly settings: string;
} {
  const agentDir = join(app.getPath("userData"), "pi-agent");
  return {
    agentDir,
    extensions: join(agentDir, "extensions"),
    mcpConfig: join(agentDir, "mcp.json"),
    skills: join(agentDir, "skills"),
    settings: join(agentDir, "vc-agent-resources.json")
  };
}

function loadPiResourceSettings(): void {
  const paths = piResourcePaths();
  mkdirSync(paths.agentDir, { recursive: true });
  try {
    const parsed = JSON.parse(readFileSync(paths.settings, "utf8")) as { projectResourcesTrusted?: unknown };
    projectPiResourcesTrusted = parsed.projectResourcesTrusted === true;
  } catch {
    projectPiResourcesTrusted = false;
  }
}

function persistPiResourceSettings(): void {
  const paths = piResourcePaths();
  mkdirSync(paths.agentDir, { recursive: true });
  writeFileSync(paths.settings, `${JSON.stringify({ schemaVersion: 1, projectResourcesTrusted: projectPiResourcesTrusted }, null, 2)}\n`, "utf8");
}

function ensureNativePiResourceFiles(): void {
  const paths = piResourcePaths();
  mkdirSync(paths.extensions, { recursive: true });
  mkdirSync(paths.skills, { recursive: true });
  if (!existsSync(paths.mcpConfig)) writeFileSync(paths.mcpConfig, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, "utf8");
}

function migrateLegacyPiResources(): void {
  const userData = app.getPath("userData");
  const paths = piResourcePaths();
  const migration = new PiIntegrationMigration({
    oldExtensionRoot: join(userData, "integrations", "extensions"),
    oldMcpRoot: join(userData, "integrations", "mcp"),
    oldSkillsRoot: join(userData, "skills"),
    newAgentDir: paths.agentDir,
    newExtensionRoot: paths.extensions,
    newMcpConfigPath: paths.mcpConfig,
    newSkillsRoot: paths.skills
  });
  try {
    const result = migration.migrate();
    piResourceMigrationDiagnostics = result.diagnostics;
  } catch (error) {
    piResourceMigrationDiagnostics = error instanceof Error
      ? [{ code: "MIGRATION_COMMIT_FAILED", severity: "error", message: error.message }]
      : [{ code: "MIGRATION_COMMIT_FAILED", severity: "error", message: "Pi resource migration failed." }];
  } finally {
    ensureNativePiResourceFiles();
  }
}

function piResourcesSettingsSnapshot(): PiResourcesSettingsState {
  const paths = piResourcePaths();
  const skillSnapshot = new VcSkillsDirectoryAdapter({ root: paths.skills }).discover();
  const diagnostics: PiResourcesSettingsState["diagnostics"] = [
    ...piResourceMigrationDiagnostics.map((diagnostic) => ({
      type: diagnostic.severity === "error" ? "error" as const : "warning" as const,
      source: "runtime" as const,
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
      blocking: diagnostic.severity === "error"
    })),
    ...skillSnapshot.diagnostics.map((diagnostic) => ({
      type: diagnostic.severity === "error" ? "error" as const : "warning" as const,
      source: "skill" as const,
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
      blocking: diagnostic.severity === "error"
    }))
  ];
  let serverCount = 0;
  try {
    const parsed = JSON.parse(readFileSync(paths.mcpConfig, "utf8")) as { mcpServers?: unknown };
    if (parsed.mcpServers !== null && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)) {
      serverCount = Object.keys(parsed.mcpServers).length;
    } else throw new Error("mcpServers must be an object");
  } catch (error) {
    diagnostics.push({ type: "error", source: "mcp", code: "MCP_CONFIGURATION_INVALID", message: error instanceof Error ? error.message : "mcp.json is invalid", path: paths.mcpConfig, blocking: true });
  }
  const extensionCount = existsSync(paths.extensions)
    ? readdirSync(paths.extensions, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isFile()).length
    : 0;
  const statusFor = (source: "extension" | "mcp" | "skill"): "ready" | "attention" => diagnostics.some((diagnostic) => diagnostic.source === source && (diagnostic.type === "error" || diagnostic.type === "warning")) ? "attention" : "ready";
  return {
    schemaVersion: 1,
    generation: piResourcesGeneration,
    reloadPending: piResourcesReloadPending,
    diagnostics,
    extensions: {
      status: statusFor("extension"),
      diagnostics: diagnostics.filter((diagnostic) => diagnostic.source === "extension"),
      trustDisclosure: "Files in this directory are Trusted Worker Code with the Agent Worker process authority.",
      directoryPath: paths.extensions,
      loadedCount: extensionCount,
      projectResourcesTrusted: projectPiResourcesTrusted
    },
    mcp: {
      status: statusFor("mcp"),
      diagnostics: diagnostics.filter((diagnostic) => diagnostic.source === "mcp"),
      trustDisclosure: "Servers listed in effective mcp.json and their tools are trusted as a set.",
      configPath: paths.mcpConfig,
      serverCount,
      connectedServerCount: 0
    },
    skills: {
      status: statusFor("skill"),
      diagnostics: diagnostics.filter((diagnostic) => diagnostic.source === "skill"),
      trustDisclosure: "Skill instructions are trusted when copied into the dedicated VC Agent directory.",
      directoryPath: paths.skills,
      loadedCount: skillSnapshot.skills.length,
      sourceIsolationDisclosure: "Only this dedicated directory is read; ambient Pi, Codex, Claude Code, .agents, and project Skill roots are ignored."
    }
  };
}

function piResourcesEvent(
  correlationId: string,
  action: "loaded" | "opened" | "reloaded" | "imported" | "project_trust_changed"
): HostEvent {
  return { ...eventMetadata(correlationId), event: "pi.resources.updated", payload: { state: piResourcesSettingsSnapshot(), action } };
}

function requestPiResourcesReload(): void {
  if ((workerSupervisor?.activity.activeSessions ?? 0) > 0) {
    piResourcesReloadPending = true;
    return;
  }
  workerSupervisor?.closeAll();
  piResourcesReloadPending = false;
  piResourcesGeneration += 1;
}

function applyPendingPiResourcesReload(): void {
  if (!piResourcesReloadPending || (workerSupervisor?.activity.activeSessions ?? 0) > 0) return;
  requestPiResourcesReload();
  if (!shuttingDown) emit(piResourcesEvent(randomUUID(), "reloaded"));
}

function runtimeCapabilityDoctorMessage(): { readonly status: "ready" | "attention"; readonly message: string } {
  const state = piResourcesSettingsSnapshot();
  const blocking = state.diagnostics.filter((diagnostic) => diagnostic.blocking === true);
  return {
    status: blocking.length === 0 ? "ready" : "attention",
    message: `Pi 0.80.8; pi-web-access 0.17.0; pi-mcp-adapter 1.5.1; ${state.extensions.loadedCount} Extension source(s), ${state.mcp.serverCount} MCP server(s), ${state.skills.loadedCount} isolated Skill(s). Doctor executed no integration code${blocking.length === 0 ? "." : `; ${blocking.map((item) => item.code ?? item.source).join(", ")}.`}`
  };
}

function integrationStateSnapshot(): IntegrationState {
  const officeStatus = officeSkillsDoctorMessage();
  const officeJobs = [...integrationJobs.values()].filter((job) => job.kind.startsWith("office:"));
  const creatorStatus = vcSkillsDirectory === null ? { status: "unavailable" as const, message: "Skill Creator is unavailable in Read-only Recovery or before Host initialization." } : { status: "ready" as const, message: "Explicit Creator drafts are staged, reviewed, and handed off disabled." };
  const page = pageRecoveryPipeline?.inspectAvailability() ?? { native: { status: "unavailable" as const, message: "Native page recovery is not initialized." }, paddle: { status: "unavailable" as const, message: "PaddleOCR local runtime is not configured." }, ovis: { status: "unavailable" as const, message: "OvisOCR2 local runtime is not configured." }, policyRevision: "page-quality-v1" };
  const pageTelemetry = pageRecoveryPipeline?.telemetry() ?? { policyRevision: page.policyRevision, pageCount: 0, nativePages: 0, paddlePages: 0, ovisPages: 0, retainedEarlierPages: 0, failures: 0, durationMs: 0, lastStatus: "failed" as const };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    office: { status: officeStatus, activeSkillCount: vcSkillsDirectory?.discover().skills.length ?? 0, supportedFormats: ["docx", "pptx", "xlsx", "pdf"], jobs: officeJobs },
    skillCreator: { status: creatorStatus, drafts: (skillCreatorWorkflow?.listDrafts() ?? []).map((draft) => ({ draftId: draft.draftId, packageId: draft.packageId, operation: draft.operation, state: draft.state, files: [...draft.files], dependencies: [...draft.dependencies], updatedAt: draft.updatedAt, ...(draft.failureCode === undefined ? {} : { failureCode: draft.failureCode }) })) },
    pageRecovery: { status: page.native.status === "ready" ? { status: "ready", message: "Native parsing is available; OCR stages remain explicit and local." } : { status: "attention", message: page.native.message }, availability: page, telemetry: pageTelemetry, parses: [...integrationJobs.values()].filter((job) => job.kind.startsWith("page_recovery:")), ...(lastPageRecoveryParse === undefined ? {} : { lastParse: lastPageRecoveryParse }) },
    runtime: { runningJobs: [...integrationJobs.values()].filter((job) => ["running", "queued"].includes(job.state)).length, queuedJobs: [...integrationJobs.values()].filter((job) => job.state === "queued").length, failures: [...integrationJobs.values()].filter((job) => ["failed", "unknown_outcome"].includes(job.state)).length }
  };
}

function integrationStateEvent(correlationId: string, action: "loaded" | "changed" | "recovered" = "loaded"): HostEvent {
  return { ...eventMetadata(correlationId), event: "integration.state.updated", payload: { state: integrationStateSnapshot(), action } };
}

function integrationJobEvent(correlationId: string, workflow: "office" | "skill_creator" | "page_recovery", job: IntegrationJobSummary): HostEvent {
  integrationJobs.set(job.id, job);
  persistIntegrationJobs();
  return { ...eventMetadata(correlationId), event: "integration.job.updated", payload: { workflow, job } };
}

function integrationDiagnostic(correlationId: string, workflow: "office" | "skill_creator" | "page_recovery", error: unknown): HostEvent {
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
    ...(task?.plan.task.skillIdentity === undefined ? {} : { skillRevisionId: task.plan.task.skillIdentity }),
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
  const delegatedOutputWrite = input.request.capabilityId === "output.write_text"
    && input.capabilitySet.includes("write_output")
    && input.outputTarget !== undefined
    && outputLocation !== undefined;
  if (delegatedOutputWrite) {
    const requestedPath = typeof input.request.arguments.path === "string" ? input.request.arguments.path : "";
    if (resolve(outputLocation, requestedPath) !== resolve(input.outputTarget!)) return fail("SUB_AGENT_OUTPUT_TARGET_MISMATCH", "The delegated writer requested a path outside its explicitly authorized output target.");
  }
  const decision = await capabilityGateway.request(request, {
    accessMode: delegatedOutputWrite ? "full" : stateStore.getAccessMode(),
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
function memoryReviewProfileSnapshot(profile: ModelProfile): MemoryReviewProfileSnapshot {
  return {
    id: profile.id,
    provider: profile.provider,
    model: profile.model,
    ...(profile.thinkingLevel === undefined ? {} : { thinkingLevel: profile.thinkingLevel }),
    ...(profile.contextWindow === undefined ? {} : { contextWindow: profile.contextWindow }),
    ...(profile.maxOutputTokens === undefined ? {} : { maxOutputTokens: profile.maxOutputTokens })
  };
}

function memoryReviewPromptSnapshot(revision: SystemPromptRevision): MemoryReviewPromptSnapshot {
  return { revisionId: revision.id, hash: revision.hash };
}

function resolveMemoryReviewConfiguration(): { readonly profile: ModelProfile; readonly profileSnapshot: MemoryReviewProfileSnapshot; readonly promptRevision: SystemPromptRevision; readonly promptSnapshot: MemoryReviewPromptSnapshot } | undefined {
  if (stateStore === null) return undefined;
  const assignment = stateStore.getTaskModelAssignment("memory_review");
  if (assignment === undefined) return undefined;
  const profile = stateStore.getModelProfile(assignment.profileId);
  const promptRevision = stateStore.getActiveSystemPromptRevision();
  if (profile === undefined || promptRevision === undefined) return undefined;
  return { profile, profileSnapshot: memoryReviewProfileSnapshot(profile), promptRevision, promptSnapshot: memoryReviewPromptSnapshot(promptRevision) };
}

function memoryReviewEligibility(cutoff: string): { readonly learningEpochStartedAt: string; readonly eventsByThread: ReadonlyMap<string, readonly TrajectoryEvent[]>; readonly threads: readonly { readonly id: string; readonly scope: "project" | "unscoped"; readonly projectId?: string }[]; readonly cutoff: string } | undefined {
  if (stateStore === null || trajectoryStore === null || cognitionReviewStore === null) return undefined;
  const epoch = cognitionReviewStore.loadEpoch();
  if (epoch === undefined || epoch.status === "pending_reset" || epoch.status === "failed_reset") return undefined;
  const threads = stateStore.listThreads().map((thread) => ({ id: thread.id, scope: thread.scope, ...(thread.scope === "project" ? { projectId: thread.projectId } : {}) }));
  return {
    learningEpochStartedAt: epoch.learningEpochStartedAt,
    eventsByThread: new Map(threads.map((thread) => [thread.id, trajectoryStore!.loadEvents(thread.id)])),
    threads,
    cutoff
  };
}

function resolveMemoryReviewSourceBody(source: EligibleLearningSource): { readonly userText: string; readonly assistantText: string } | undefined {
  if (trajectoryStore === null || source.threadId === undefined || source.turnId === undefined) return undefined;
  const events = trajectoryStore.loadEvents(source.threadId);
  const submitted = events.find((event) => event.turnId === source.turnId && event.event === "turn.submitted");
  const completed = events.find((event) => event.turnId === source.turnId && event.event === "turn.completed");
  if (submitted?.event !== "turn.submitted" || completed?.event !== "turn.completed") return undefined;
  return { userText: submitted.payload.text, assistantText: completed.payload.message };
}

function memoryReviewCards(sources: readonly EligibleLearningSource[]): { readonly projectMemoryCards: readonly MemoryReviewSynthesisCard[]; readonly longTermMemoryCards: readonly MemoryReviewSynthesisCard[]; readonly dependencies: readonly CognitionDependency[] } {
  const projectMemoryCards: MemoryReviewSynthesisCard[] = [];
  const dependencies: CognitionDependency[] = [];
  const projectIds = [...new Set(sources.filter((source) => source.scope === "project" && source.projectId !== undefined).map((source) => source.projectId!))].sort();
  for (const projectId of projectIds) {
    const project = stateStore?.getProject(projectId);
    const document = project === undefined || projectMemories === null ? undefined : projectMemories.load(project.id, project.path, false);
    if (document === undefined) continue;
    dependencies.push({ kind: "project_memory", reference: projectId, hash: document.sourceHash, required: true });
    for (const entry of document.entries) {
      projectMemoryCards.push({ id: entry.id, title: entry.title, content: entry.body, tags: entry.tags, maturity: entry.maturity, scope: "project", projectId, status: "current" });
    }
  }
  const longTerm = longTermMemories?.load(false);
  const longTermMemoryCards = longTerm?.entries.map((entry) => ({
    id: entry.id, title: entry.title, content: entry.content, applicability: entry.applicability, limitations: entry.limitations,
    tags: entry.tags, version: entry.version, maturity: entry.maturity, recallPolicy: entry.recallPolicy, conflictState: entry.conflictState, scope: "long_term" as const, status: entry.status
  })) ?? [];
  if (longTerm !== undefined) dependencies.push({ kind: "long_term_memory", reference: "long_term_memory", hash: longTerm.sourceHash, required: true });
  return { projectMemoryCards, longTermMemoryCards, dependencies };
}

function memoryReviewSources(cutoff: string, profile: ModelProfile): EligibleLearningSource[] {
  const eligibility = memoryReviewEligibility(cutoff);
  if (eligibility === undefined) return [];
  const sources = selectEligibleLearningSources(eligibility);
  const committed = cognitionReviewStore?.loadCommittedCutoff();
  const committedLedger = committed === undefined ? undefined : cognitionReviewStore?.loadCoverageLedger(committed.batchId);
  const carriedOver = new Set((committedLedger?.entries ?? []).filter((entry) => entry.status === "carried_over").map((entry) => entry.sourceReference));
  const sourceIndex = cognitionReviewStore?.readSourceIndex() ?? [];
  const selectedByReference = new Map(sources.map((source) => [source.sourceReference, source]));
  for (const source of sourceIndex) {
    if (carriedOver.has(source.sourceReference) && !selectedByReference.has(source.sourceReference)) selectedByReference.set(source.sourceReference, source);
  }
  const lowerBound = committed === undefined ? undefined : new Date(committed.cutoff).valueOf();
  const pending = [...selectedByReference.values()].filter((source) => lowerBound === undefined || new Date(source.completedAt).valueOf() > lowerBound || carriedOver.has(source.sourceReference));
  // A global Memory Review never falls back to a Thread Profile. Project
  // sources are admitted only when the frozen assigned Profile is authorized
  // for that Project; reject the batch rather than silently shrinking the
  // strict eligible source set.
  if (pending.some((source) => source.availability !== "deleted" && source.scope === "project" && (source.projectId === undefined || stateStore?.isProjectProfileAuthorized(source.projectId, profile.id) !== true))) {
    throw new Error("MEMORY_REVIEW_PROJECT_PROFILE_UNAUTHORIZED");
  }
  return pending;
}

function initializeMemoryReviewOrchestrator(): void {
  if (memoryReviewOrchestrator !== null || cognitionReviewStore === null || cognitionReviews === null) return;
  memoryReviewOrchestrator = createMemoryReviewOrchestrator({
    root: cognitionReviewStore.rootPath,
    reviewModule: cognitionReviews,
    resolveSource: resolveMemoryReviewSourceBody,
    generate: (prompt, context) => runMemoryReviewModel({
      batchId: context.batchId,
      mode: context.mode,
      stage: context.stage,
      workerKey: context.workerKey,
      prompt,
      profileSnapshot: context.profileSnapshot,
      promptSnapshot: context.promptSnapshot
    }),
    onProgress: (progress) => {
      const correlationId = memoryReviewCorrelationByBatch.get(progress.batchId) ?? randomUUID();
      emit({ ...eventMetadata(correlationId), event: "memory_review.progress.updated", payload: { progress } });
      if (progress.reviewId !== undefined && progress.status === "waiting_for_review") {
        const bundle = cognitionReviewStore?.loadReviewBundle(progress.reviewId);
        if (bundle !== undefined) emit({ ...eventMetadata(correlationId), event: "cognition_review.bundle.updated", payload: { bundle } });
      }
    },
    now: () => new Date()
  });
}

function buildMemoryReviewPreparationInput(cutoff: string, profile: ModelProfile, profileSnapshot: MemoryReviewProfileSnapshot, promptSnapshot: MemoryReviewPromptSnapshot): { readonly sources: readonly (EligibleLearningSource & { readonly body?: { readonly userText: string; readonly assistantText: string } })[]; readonly profileSnapshot: MemoryReviewProfileSnapshot; readonly promptSnapshot: MemoryReviewPromptSnapshot; readonly cutoff: string; readonly projectMemoryCards: readonly MemoryReviewSynthesisCard[]; readonly longTermMemoryCards: readonly MemoryReviewSynthesisCard[]; readonly dependencies: readonly CognitionDependency[] } | undefined {
  const sources = memoryReviewSources(cutoff, profile);
  if (sources.length === 0) return undefined;
  cognitionReviewStore?.upsertSourceIndex(sources);
  const cards = memoryReviewCards(sources);
  return {
    cutoff,
    sources: sources.map((source) => {
      const body = resolveMemoryReviewSourceBody(source);
      return body === undefined ? source : { ...source, body };
    }),
    profileSnapshot,
    promptSnapshot,
    projectMemoryCards: cards.projectMemoryCards,
    longTermMemoryCards: cards.longTermMemoryCards,
    dependencies: cards.dependencies
  };
}

function startMemoryReviewPreparation(correlationId: string, mode: "manual" | "automatic"): HostEvent {
  if (stateStore === null || stateStore.isReadOnlyRecovery || memoryReviewOrchestrator === null) return diagnostic(correlationId, "HOST_FAILURE", "Memory Review is unavailable in Read-only Recovery.");
  const configuration = resolveMemoryReviewConfiguration();
  if (configuration === undefined) return diagnostic(correlationId, "HOST_FAILURE", "Configure a Memory Review Profile before preparing a Memory Review.");
  const cutoff = new Date().toISOString();
  let input: ReturnType<typeof buildMemoryReviewPreparationInput>;
  try { input = buildMemoryReviewPreparationInput(cutoff, configuration.profile, configuration.profileSnapshot, configuration.promptSnapshot); }
  catch (error) { return diagnostic(correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Memory Review source selection failed."); }
  if (input === undefined) return diagnostic(correlationId, "HOST_FAILURE", "No eligible learning sources are available for Memory Review.");
  const batchId = randomUUID();
  memoryReviewCorrelationByBatch.set(batchId, correlationId);
  const preparation = { ...input, batchId };
  void (mode === "automatic" ? memoryReviewOrchestrator.prepare(preparation) : memoryReviewOrchestrator.prepare(preparation))
    .then((run) => {
      if (run.reviewId !== undefined) {
        const bundle = cognitionReviewStore?.loadReviewBundle(run.reviewId);
        if (bundle !== undefined) emit({ ...eventMetadata(correlationId), event: "cognition_review.bundle.updated", payload: { bundle } });
      }
    })
    .catch((error) => emit(diagnostic(correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Memory Review preparation failed.")))
    .finally(() => { memoryReviewCorrelationByBatch.delete(batchId); });
  return { ...eventMetadata(correlationId), event: "memory_review.progress.updated", payload: { progress: { batchId, status: "preparing", eligible: input.sources.length, processed: 0, noSignal: 0, represented: 0, carriedOver: 0, completedChunks: 0, totalChunks: 0 } } };
}

function cancelMemoryReviewPreparation(correlationId: string): HostEvent {
  const active = memoryReviewOrchestrator?.listRuns().find((run) => run.status === "preparing");
  if (active === undefined || memoryReviewOrchestrator === null) return diagnostic(correlationId, "HOST_FAILURE", "No active Memory Review preparation was found.");
  try {
    const run = memoryReviewOrchestrator.cancel(active.batchId);
    return { ...eventMetadata(correlationId), event: "memory_review.progress.updated", payload: { progress: memoryReviewProgressProjection(run) } };
  } catch (error) {
    return diagnostic(correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Memory Review cancellation failed.");
  }
}

function memoryReviewProgressProjection(run: MemoryReviewPreparationResult): MemoryReviewProgress {
  const entries = run.ledger.entries;
  const noSignal = entries.filter((entry) => entry.status === "no_signal").length;
  const represented = entries.filter((entry) => entry.status === "represented").length;
  const carriedOver = entries.filter((entry) => entry.status === "carried_over").length;
  return { batchId: run.batchId, ...(run.reviewId === undefined ? {} : { reviewId: run.reviewId }), status: run.status, eligible: entries.length, processed: noSignal + represented + carriedOver, noSignal, represented, carriedOver, completedChunks: run.chunks.filter((chunk) => chunk.status === "completed").length, totalChunks: run.chunks.length, ...(run.failureCode === undefined ? {} : { failureCode: run.failureCode }) };
}

function runMemoryReviewModel(input: { readonly batchId: string; readonly mode: "manual" | "automatic"; readonly stage: "extraction" | "synthesis"; readonly workerKey: string; readonly prompt: string; readonly profileSnapshot: MemoryReviewProfileSnapshot; readonly promptSnapshot?: MemoryReviewPromptSnapshot }): Promise<string> {
  if (stateStore === null || workerSupervisor === null || executionScheduler === null) return Promise.reject(new Error("MEMORY_REVIEW_WORKER_UNAVAILABLE"));
  const profile = stateStore.getModelProfile(input.profileSnapshot.id);
  const frozenThinkingLevel = thinkingLevelSchema.safeParse(input.profileSnapshot.thinkingLevel ?? "off");
  const promptRevision = input.promptSnapshot === undefined ? stateStore.getActiveSystemPromptRevision() : stateStore.getSystemPromptRevision(input.promptSnapshot.revisionId);
  if (!frozenThinkingLevel.success
    || profile === undefined
    || profile.provider !== input.profileSnapshot.provider
    || profile.model !== input.profileSnapshot.model
    || profile.thinkingLevel !== frozenThinkingLevel.data
    || profile.contextWindow !== input.profileSnapshot.contextWindow
    || profile.maxOutputTokens !== input.profileSnapshot.maxOutputTokens
    || promptRevision === undefined
    || (input.promptSnapshot !== undefined && promptRevision.hash !== input.promptSnapshot.hash)) return Promise.reject(new Error("MEMORY_REVIEW_FROZEN_CONFIGURATION_UNAVAILABLE"));
  const encrypted = stateStore.getEncryptedCredential(profile.credentialRef);
  if (encrypted === undefined) return Promise.reject(new Error("MEMORY_REVIEW_CREDENTIAL_UNAVAILABLE"));
  const turnId = randomUUID();
  const safeWorkerKey = input.workerKey.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 120);
  const threadId = `memory-review-${input.batchId}-${input.stage}-${safeWorkerKey}-${turnId}`;
  const admission = executionScheduler.admit({ id: turnId, scopeKey: threadId, kind: "internal_model_stage" });
  if (!admission.admitted) return Promise.reject(new Error("MEMORY_REVIEW_EXECUTION_CAPACITY"));
  const correlationId = memoryReviewCorrelationByBatch.get(input.batchId) ?? randomUUID();
  const resources = {
    schemaVersion: 1 as const,
    revisionId: promptRevision.id,
    systemPrompt: promptRevision.content,
    appendSystemPrompt: [input.stage === "extraction" ? MEMORY_REVIEW_EXTRACTION_STAGE_INSTRUCTIONS : MEMORY_REVIEW_SYNTHESIS_STAGE_INSTRUCTIONS]
  };
  const command: Extract<WorkerCommand, { command: "turn.execute" }> = {
    schemaVersion: 1,
    command: "turn.execute",
    commandId: randomUUID(),
    correlationId,
    threadId,
    turnId,
    cwd: app.getPath("userData"),
    threadDirectory: join(app.getPath("userData"), "cognition-v2", "work", input.batchId, input.stage, safeWorkerKey),
    contextHistory: [],
    estimatedInputTokens: estimateTokens(promptRevision.content) + estimateTokens(input.prompt),
    currentInputTokens: estimateTokens(promptRevision.content) + estimateTokens(input.prompt),
    activeCapabilities: [],
    expectedStateVersion: 1,
    executionScope: { kind: "unscoped", threadId },
    prompt: input.prompt,
    profile: {
      provider: input.profileSnapshot.provider,
      model: input.profileSnapshot.model,
      apiKey: credentials.decrypt(encrypted),
      thinkingLevel: frozenThinkingLevel.data,
      ...(input.profileSnapshot.contextWindow === undefined ? {} : { contextWindow: input.profileSnapshot.contextWindow }),
      ...(input.profileSnapshot.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.profileSnapshot.maxOutputTokens })
    },
    resources,
    piResources: piResourcesConfig()
  };
  return new Promise<string>((resolve, reject) => {
    memoryReviewWorkerStages.set(turnId, { batchId: input.batchId, stage: input.stage, threadId, turnId, correlationId, profile, resolve, reject });
    void workerSupervisor!.execute(command).catch((error: unknown) => settleMemoryReviewWorkerStage(turnId, error instanceof Error ? error : new Error("MEMORY_REVIEW_WORKER_FAILED"), true));
  });
}

function settleMemoryReviewWorkerStage(turnId: string, error?: Error, recordFailure = false, message?: string): void {
  const stage = memoryReviewWorkerStages.get(turnId);
  if (stage === undefined) return;
  memoryReviewWorkerStages.delete(turnId);
  if (recordFailure) executionScheduler?.recordFailure();
  executionScheduler?.release(turnId);
  workerSupervisor?.retire(stage.threadId);
  queueMicrotask(() => drainExecutionQueue());
  if (error === undefined) stage.resolve(message ?? "");
  else stage.reject(error);
}

function handleMemoryReviewWorkerEvent(workerEvent: WorkerEvent, stage: MemoryReviewWorkerStage): void {
  if (workerEvent.event === "capability.execution.requested") {
    workerSupervisor?.resolveCapability({ schemaVersion: 1, command: "capability.execution.resolve", commandId: randomUUID(), correlationId: stage.correlationId, threadId: stage.threadId, turnId: stage.turnId, result: { schemaVersion: 1, requestId: workerEvent.request.requestId, status: "rejected", code: "MEMORY_REVIEW_CAPABILITY_NOT_ALLOWED", content: "Memory Review model stages receive only their frozen bounded input." } });
    return;
  }
  if (workerEvent.event === "physical_context.ready" || workerEvent.event === "turn.started" || workerEvent.event === "message.delta" || workerEvent.event === "thinking.delta" || workerEvent.event.startsWith("thread.compaction.")) return;
  if (workerEvent.event === "turn.completed") { settleMemoryReviewWorkerStage(stage.turnId, undefined, false, workerEvent.message); return; }
  if (workerEvent.event === "turn.interrupted") { settleMemoryReviewWorkerStage(stage.turnId, new Error("MEMORY_REVIEW_INTERRUPTED"), true); return; }
  if (workerEvent.event === "turn.failed") { settleMemoryReviewWorkerStage(stage.turnId, new Error(`MEMORY_REVIEW_MODEL_FAILED:${workerEvent.failure.code}`), true); }
}

function markMemoryReviewRunTerminal(reviewId: string, status: "completed" | "cancelled" = "completed"): void {
  if (memoryReviewOrchestrator === null) return;
  if (status === "completed") memoryReviewOrchestrator.completeReview(reviewId);
  else memoryReviewOrchestrator.discardReview(reviewId);
}

function maybeStartAutomaticMemoryReview(correlationId: string): void {
  if (!automaticReviewUserWorkCompletedInAppRun || memoryReviewPolicy?.enabled !== true || memoryReviewOrchestrator === null || executionScheduler === null || !executionScheduler.hasCapacity()) return;
  const configuration = resolveMemoryReviewConfiguration();
  if (configuration === undefined || memoryReviewPolicy === undefined) return;
  const cutoff = new Date().toISOString();
  let input: ReturnType<typeof buildMemoryReviewPreparationInput>;
  try { input = buildMemoryReviewPreparationInput(cutoff, configuration.profile, configuration.profileSnapshot, configuration.promptSnapshot); }
  catch { return; }
  if (input === undefined) return;
  const runs = memoryReviewOrchestrator.listRuns();
  const latestAutomatic = runs.filter((run) => run.mode === "automatic").sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const latestCompleted = runs.filter((run) => run.status === "completed").sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const explicitCandidate = memoryCandidates?.list().some((candidate) => candidate.status === "active" && input.sources.some((source) => source.sourceReference === candidate.sourceReference)) ?? false;
  const autoInput = {
    ...input,
    ...(latestAutomatic === undefined ? {} : { lastAutomaticStartAt: latestAutomatic.createdAt }),
    ...(latestCompleted === undefined ? {} : { lastReviewCompletedAt: latestCompleted.updatedAt }),
    policy: memoryReviewPolicy,
    profileAvailable: true,
    activeBatch: runs.some((run) => ["preparing", "waiting_for_review"].includes(run.status)) || (reflectionRuns?.list().some((run) => !["idle", "completed", "discarded"].includes(run.status)) ?? false),
    bundleUnderReview: cognitionReviewStore?.listReviewBundles().some((bundle) => ["waiting_for_review", "reviewing", "prepared"].includes(bundle.status)) ?? false,
    pendingEligibleExchangeCount: input.sources.length,
    explicitCandidate,
    phase: "post_user_work" as const,
    userWorkCompletedInAppRun: true,
    executionIdle: (() => { const telemetry = executionScheduler!.telemetry(); return telemetry.runningCount === 0 && telemetry.queuedCount === 0; })()
  };
  const batchId = randomUUID();
  memoryReviewCorrelationByBatch.set(batchId, correlationId);
  void memoryReviewOrchestrator.prepareAutomatically({ ...autoInput, batchId }).then((result) => {
    if (result.run?.reviewId !== undefined) {
      const bundle = cognitionReviewStore?.loadReviewBundle(result.run.reviewId);
      if (bundle !== undefined) emit({ ...eventMetadata(correlationId), event: "cognition_review.bundle.updated", payload: { bundle } });
    }
  }).catch(() => undefined).finally(() => { memoryReviewCorrelationByBatch.delete(batchId); automaticReviewUserWorkCompletedInAppRun = false; });
}

function runMemoryReviewStartupDueCheck(): void {
  if (memoryReviewPolicy?.enabled !== true || memoryReviewOrchestrator === null || executionScheduler === null) return;
  const configuration = resolveMemoryReviewConfiguration();
  if (configuration === undefined) return;
  let sources: EligibleLearningSource[];
  try { sources = memoryReviewSources(new Date().toISOString(), configuration.profile); }
  catch { return; }
  if (sources.length === 0) return;
  const runs = memoryReviewOrchestrator.listRuns();
  const latestAutomatic = runs.filter((run) => run.mode === "automatic").sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const latestCompleted = runs.filter((run) => run.status === "completed").sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const telemetry = executionScheduler.telemetry();
  // This call is deliberately model-free. Startup may record/read due state,
  // but the admission phase is post-user-work and never starts a Provider.
  evaluateAutomaticMemoryReview({
    policy: memoryReviewPolicy,
    profileAvailable: true,
    activeBatch: runs.some((run) => ["preparing", "waiting_for_review"].includes(run.status)),
    bundleUnderReview: cognitionReviewStore?.listReviewBundles().some((bundle) => ["waiting_for_review", "reviewing", "prepared"].includes(bundle.status)) ?? false,
    pendingEligibleExchangeCount: sources.length,
    ...(latestAutomatic === undefined ? {} : { lastAutomaticStartAt: latestAutomatic.createdAt }),
    ...(latestCompleted === undefined ? {} : { lastReviewCompletedAt: latestCompleted.updatedAt }),
    phase: "startup",
    userWorkCompletedInAppRun: false,
    executionIdle: telemetry.runningCount === 0 && telemetry.queuedCount === 0
  }, { now: () => new Date() });
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
  if (stateStore === null) {
    return diagnostic(correlationId, "HOST_FAILURE", "The local Host is not initialized.");
  }

  try {
    const command = parsed.data;
    const recovery = hostReadOnlyRecovery();
    if (recovery && !READ_ONLY_RECOVERY_COMMANDS.has(command.command)) {
      return diagnostic(command.correlationId, "READ_ONLY_RECOVERY_MODE", "This action is unavailable while local state is open in Read-only Recovery.");
    }
    if (workerSupervisor === null && !recovery) {
      return diagnostic(correlationId, "HOST_FAILURE", "The local Host is not initialized.");
    }
    const recoverySafeCommand = command.command === "app.bootstrap"
      || command.command === "state.recovery.export"
      || command.command === "profile.list"
      || command.command === "academic.credentials.list";
    if ((trajectoryStore === null || inflight === null || capabilityGateway === null) && !(recovery && recoverySafeCommand)) {
      return diagnostic(correlationId, "HOST_FAILURE", "The local Host is not initialized.");
    }
    switch (command.command) {
      case "app.bootstrap": {
        const profileCount = stateStore.listModelProfiles().length;
        const preparation = stateStore.statePreparation;
        const recovery = hostReadOnlyRecovery();
        const runtimeCapabilityDoctor = recovery
          ? { status: "attention" as const, message: "Pi execution is disabled in Read-only Recovery; no integration resources were loaded." }
          : runtimeCapabilityDoctorMessage();
        return {
          ...eventMetadata(command.correlationId),
          event: "app.bootstrap.completed",
          payload: {
            ...stateStore.getBootstrapState(app.getVersion(), { ...(workerSupervisor?.activity ?? EMPTY_WORKER_ACTIVITY), externalNetworkRequests }),
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
              bundledExtensions: runtimeCapabilityDoctor,
              scheduler: { status: "ready", message: `Bounded capacity ${EXECUTION_CAPACITY}; no integration resource was activated by Doctor.` },
              agentRuntime: { status: recovery ? "unavailable" : "ready", message: recovery ? "Agent Workers are disabled in Read-only Recovery." : "Project and Unscoped Worker supervision is available." },
              utilityRuntime: { status: recovery ? "unavailable" : "ready", message: recovery ? "Utility jobs are disabled in Read-only Recovery." : "Utility runtime is available for bounded local jobs." },
              isolatedRuntime: { status: recovery ? "unavailable" : "ready", message: recovery ? "Isolated jobs are disabled in Read-only Recovery." : "Isolated runtime is dormant until an explicit task." },
              skills: recovery ? { status: "attention", message: "Skills are disabled in Read-only Recovery." } : skillsDoctorMessage(),
              office: recovery ? { status: "attention", message: "Office Skills are unavailable in Read-only Recovery." } : officeSkillsDoctorMessage(),
              ocr: { status: "attention", message: "Local page recovery dependencies are checked only when configured." },
              mcp: { status: "ready", message: "Pinned MCP adapter is lazy; no server connection was opened." },
              extensions: runtimeCapabilityDoctor,
              backup: { status: "ready", message: "Personal Cognition Backup is local and credential-free." }
            }
          }
        };
      }
      case "state.recovery.export": {
        if (!hostReadOnlyRecovery()) return diagnostic(command.correlationId, "INVALID_COMMAND", "Raw state export is available only in Read-only Recovery.");
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
      case "pi.resources.load":
        return piResourcesEvent(command.correlationId, "loaded");
      case "pi.resources.open": {
        const paths = piResourcePaths();
        ensureNativePiResourceFiles();
        const target = command.payload.target === "extensions_folder"
          ? paths.extensions
          : command.payload.target === "skills_folder"
            ? paths.skills
            : paths.mcpConfig;
        const error = await shell.openPath(target);
        if (error !== "") return diagnostic(command.correlationId, "HOST_FAILURE", error);
        return piResourcesEvent(command.correlationId, "opened");
      }
      case "pi.resources.reload":
        requestPiResourcesReload();
        return piResourcesEvent(command.correlationId, "reloaded");
      case "pi.resources.import_skill": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "INVALID_COMMAND", "Skill import requires explicit User action.");
        let sourceDirectory = process.env.VC_AGENT_TEST_SKILL_SOURCE;
        if (sourceDirectory === undefined) {
          const selection = await dialog.showOpenDialog(mainWindow!, { title: "Import Skill into VC Agent", properties: ["openDirectory"] });
          sourceDirectory = selection.canceled ? undefined : selection.filePaths[0];
        }
        if (sourceDirectory === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Skill import was canceled.");
        new VcSkillsDirectoryAdapter({ root: piResourcePaths().skills }).importSkill({ sourceDirectory });
        requestPiResourcesReload();
        return piResourcesEvent(command.correlationId, "imported");
      }
      case "pi.resources.project_trust.set":
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "INVALID_COMMAND", "Project resource trust requires explicit User action.");
        projectPiResourcesTrusted = command.payload.trusted;
        persistPiResourceSettings();
        requestPiResourcesReload();
        return piResourcesEvent(command.correlationId, "project_trust_changed");
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
            : command.payload.targetSkillName === undefined && command.payload.targetSkillPath === undefined
              ? (() => { throw new Error("SKILL_DRAFT_STALE"); })()
              : await skillCreatorWorkflow.updateDraft({ explicitIntent: true, packageId: command.payload.packageId, ...(command.payload.targetSkillName === undefined ? {} : { targetSkillName: command.payload.targetSkillName }), ...(command.payload.targetSkillPath === undefined ? {} : { targetSkillPath: command.payload.targetSkillPath }), files: command.payload.files, ...(command.payload.dependencies === undefined ? {} : { dependencies: command.payload.dependencies }), ...(command.payload.draftId === undefined ? {} : { draftId: command.payload.draftId }) });
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
        try {
          const result = await skillCreatorWorkflow.accept(command.payload.draftId, command.payload.accessMode === undefined ? { confirmed: true } : { confirmed: true, accessMode: command.payload.accessMode });
          const importedSkill = result.skills[0];
          const importedName = importedSkill?.name ?? basename(result.destinationPath);
          emit(integrationJobEvent(command.correlationId, "skill_creator", { id: command.payload.draftId, kind: "skill_creator:handoff", state: "completed", message: `Draft copied into the dedicated Skills directory as ${importedName}.`, updatedAt: new Date().toISOString(), resultId: result.destinationPath }));
          emit(piResourcesEvent(command.correlationId, "imported"));
          return integrationStateEvent(command.correlationId, "changed");
        }
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
      case "memory_review.prepare": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Memory Review preparation requires explicit User initiation.");
        return startMemoryReviewPreparation(command.correlationId, "manual");
      }
      case "memory_review.cancel": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Memory Review cancellation requires explicit User action.");
        return cancelMemoryReviewPreparation(command.correlationId);
      }
      case "memory_review.policy.set": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Automatic Memory Review policy requires explicit User action.");
        if (stateStore === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Automatic Memory Review policy is unavailable.");
        try {
          const policy = stateStore.setAutoMemoryReviewPolicy(command.payload.policy);
          memoryReviewPolicy = policy;
          return { ...eventMetadata(command.correlationId), event: "memory_review.policy.updated", payload: { policy } };
        } catch (error) {
          return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Automatic Memory Review policy could not be saved.");
        }
      }
      case "reflection.start": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Investment Reflection requires explicit User initiation.");
        return command.payload.scope === "project"
          ? startProjectReflection(command.correlationId, command.payload)
          : startUnscopedReflection(command.correlationId, command.payload);
      }
      case "reflection.finish": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Finishing Reflection requires explicit User action.");
        const run = reflectionRuns?.get(command.payload.runId);
        if (run === undefined || run.status !== "dialogue_active") return diagnostic(command.correlationId, "HOST_FAILURE", "Reflection finalization requires an active dialogue.");
        const bundle = prepareReflectionCognitionBundle(run);
        if (bundle === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Reflection must produce exactly one Judgment Record draft before finalization.");
        return { ...eventMetadata(command.correlationId, run.threadId), event: "cognition_review.bundle.updated", payload: { bundle } };
      }
      case "cognition_review.load": {
        if (cognitionReviewStore === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Cognition Review is unavailable in read-only recovery.");
        const bundle = cognitionReviewStore.loadReviewBundle(command.payload.reviewId);
        return bundle === undefined
          ? diagnostic(command.correlationId, "HOST_FAILURE", "Cognition Review bundle not found.")
          : { ...eventMetadata(command.correlationId), event: "cognition_review.bundle.updated", payload: { bundle } };
      }
      case "cognition_review.decide": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Cognition Review decisions require explicit User action.");
        if (cognitionReviews === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Cognition Review is unavailable in read-only recovery.");
        try {
          const bundle = cognitionReviews.decide(command.payload.reviewId, command.payload.decisions);
          return { ...eventMetadata(command.correlationId), event: "cognition_review.bundle.updated", payload: { bundle } };
        } catch (error) {
          return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Cognition Review decision could not be recorded.");
        }
      }
      case "cognition_review.commit": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Cognition Review commit requires explicit User confirmation.");
        if (cognitionReviews === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Cognition Review is unavailable in read-only recovery.");
        try {
          const result = cognitionReviews.commit(command.payload.reviewId);
          if (result.status === "committed" && reflectionRuns !== null) {
            const run = reflectionRunForReview(command.payload.reviewId);
            if (run !== undefined) {
              const completed = reflectionRuns.complete(run.id);
              emit({ ...eventMetadata(command.correlationId, completed.threadId), event: "reflection.run.updated", payload: { run: completed } });
            }
          }
          if (result.status === "committed") markMemoryReviewRunTerminal(command.payload.reviewId);
          return { ...eventMetadata(command.correlationId), event: "cognition_review.commit.result", payload: { result } };
        } catch (error) {
          return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Cognition Review commit could not be completed.");
        }
      }
      case "cognition_review.discard": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Discarding Cognition Review requires explicit User action.");
        if (cognitionReviews === null || cognitionReviewStore === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Cognition Review is unavailable in read-only recovery.");
        try {
          // Reflection reviews are owned by an active Reflection dialogue.  Resolve
          // the Host-side mapping before discarding the bundle so that the run can
          // leave dialogue_active as part of the same user action.
          const reflectionRun = reflectionRunForReview(command.payload.reviewId);
          cognitionReviews.discard(command.payload.reviewId);
          if (reflectionRun !== undefined && reflectionRuns !== null) {
            const discarded = reflectionRuns.discard(reflectionRun.id);
            if (reflectionDrafts !== null) reflectionDrafts.discardRunDrafts(discarded.id);
            emit({ ...eventMetadata(command.correlationId, discarded.threadId), event: "reflection.run.updated", payload: { run: discarded } });
          } else {
            // A discarded Memory Review must not count as a completed run for
            // automatic interval throttling.
            markMemoryReviewRunTerminal(command.payload.reviewId, "cancelled");
          }
          const bundle = cognitionReviewStore.loadReviewBundle(command.payload.reviewId);
          return bundle === undefined
            ? diagnostic(command.correlationId, "HOST_FAILURE", "Cognition Review bundle not found after discard.")
            : { ...eventMetadata(command.correlationId), event: "cognition_review.bundle.updated", payload: { bundle } };
        } catch (error) {
          return diagnostic(command.correlationId, "HOST_FAILURE", error instanceof Error ? error.message : "Cognition Review could not be discarded.");
        }
      }
      case "reflection.discard": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Discarding Reflection requires explicit User initiation.");
        if (reflectionRuns === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Reflection runs are unavailable.");
        const run = reflectionRuns.discard(command.payload.runId);
        if (reflectionDrafts !== null) reflectionDrafts.discardRunDrafts(run.id);
        return { ...eventMetadata(command.correlationId, run.threadId), event: "reflection.run.updated", payload: { run } };
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
        return { ...eventMetadata(command.correlationId), event: "project.memory.loaded", payload: { document, source: existed ? "load" : "lazy_create" } };
      }
      case "project.memory.save": {
        const project = stateStore.getProject(command.payload.projectId);
        if (project === undefined || projectMemories === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Project not found.");
        try {
          const document = projectMemories.save(project.id, project.path, command.payload.content, command.payload.expectedSourceHash);
          ownProjectMemoryWrites.set(project.id, document.sourceHash);
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
        return { ...eventMetadata(command.correlationId), event: "long_term_memory.updated", payload: { document, source: "manual_refresh" } };
      }
      case "long_term_memory.save": {
        if (longTermMemories === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Long-term Memory is unavailable.");
        try {
          const document = longTermMemories.save(command.payload.content, command.payload.expectedSourceHash);
          ownLongTermMemoryWriteHash = document.sourceHash;
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
        return { ...eventMetadata(command.correlationId, candidate.threadId), event: "memory.candidate.resolved", payload: { candidate } };
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
        if (trajectoryStore === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Thread trajectory is unavailable in read-only recovery.");
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
        if (trajectoryStore === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Thread trajectory is unavailable.");
        if (turnExecution!.isThreadActive(command.payload.threadId)) return diagnostic(command.correlationId, "HOST_FAILURE", "Stop the active Turn before deleting its history.");
        if (stateStore.getThread(command.payload.threadId) === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Thread not found.");
        const affectedBatchIds: string[] = [];
        const removedCandidateIds = memoryCandidates?.removeByThread(command.payload.threadId) ?? [];
        cognitionReviewStore?.markThreadSourcesDeleted(command.payload.threadId);
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
        if (trajectoryStore === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Thread trajectory is unavailable.");
        if (turnExecution!.isThreadActive(command.payload.threadId)) return diagnostic(command.correlationId, "HOST_FAILURE", "Stop the active Turn before deleting this Thread.");
        if (stateStore.getThread(command.payload.threadId) === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Thread not found.");
        const affectedBatchIds: string[] = [];
        const removedCandidateIds = memoryCandidates?.removeByThread(command.payload.threadId) ?? [];
        cognitionReviewStore?.markThreadSourcesDeleted(command.payload.threadId);
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
        if (inflight === null || workerSupervisor === null) return diagnostic(command.correlationId, "HOST_FAILURE", "Turn execution is unavailable in read-only recovery.");
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
    return diagnostic(correlationId, "INVALID_COMMAND", "The Host does not recognize this command.");
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
  // The intent-level Reflection assignment is the sole profile authority for
  // both isolated stages.  Keep the legacy payload field for wire
  // compatibility, but never let a per-launch selector replace the frozen
  // assignment.
  const assignment = stateStore!.getTaskModelAssignment("reflection");
  const effectiveProfileId = assignment?.profileId;
  const profile = effectiveProfileId === undefined ? undefined : stateStore!.getModelProfile(effectiveProfileId);
  if (effectiveProfileId !== undefined && profile === undefined) return diagnostic(correlationId, "HOST_FAILURE", "The selected Independent Evidence Profile is unavailable.");
  const framing = reflectionFraming(input.focus ?? "");
  if (reflectionRuns === null) return diagnostic(correlationId, "HOST_FAILURE", "Reflection runs are unavailable.");
  const run = reflectionRuns.create({
    scope: "project",
    projectId: project.id,
    framing,
    objective: framing === "retrospective" ? "Review this Project retrospectively against later evidence, subsequent developments, or observed outcomes." : DEFAULT_PROJECT_REFLECTION_OBJECTIVE,
    ...(input.focus?.trim() ? { focus: input.focus.trim() } : {}),
    brief,
    promptRevision,
    ...(profile === undefined ? {} : { independentProfileId: profile.id })
  });
  if (profile !== undefined) stateStore!.authorizeProjectProfile(project.id, profile.id, profile.provider);
  const thread = stateStore!.getThread(run.threadId);
  if (thread?.scope !== "project") throw new Error("Reflection Thread was not created");
  const created: HostEvent = { ...eventMetadata(correlationId, thread.id), event: "reflection.run.created", payload: { run, thread } };
  // A configured Reflection Profile is the complete launch authorization.  Do
  // not borrow the current Thread Profile or wait for a second stage action.
  if (reflectionLaunchTransition({ profileId: profile?.id }).action === "start_independent") {
    emit(created);
    return startIndependentAssessment(correlationId, run.id);
  }
  return created;
}

async function startUnscopedReflection(correlationId: string, input: { threadId: string; focus?: string | undefined; profileId?: string | undefined }): Promise<HostEvent> {
  const sourceThread = stateStore!.getThread(input.threadId);
  const promptRevision = stateStore!.getActiveSystemPromptRevision();
  if (sourceThread?.scope !== "unscoped" || promptRevision === undefined || reflectionRuns?.getByThread(sourceThread.id) !== undefined) {
    return diagnostic(correlationId, "HOST_FAILURE", "An ordinary Unscoped task and System Prompt are required.");
  }
  const userInputs = trajectoryStore!.loadEvents(sourceThread.id).flatMap((event) => event.event === "turn.submitted" ? [{ turnId: event.turnId, text: event.payload.text }] : []);
  const brief = buildReflectionUnscopedBrief({ sourceThreadId: sourceThread.id, userInputs });
  const assignment = stateStore!.getTaskModelAssignment("reflection");
  const effectiveProfileId = assignment?.profileId;
  const profile = effectiveProfileId === undefined ? undefined : stateStore!.getModelProfile(effectiveProfileId);
  if (effectiveProfileId !== undefined && profile === undefined) return diagnostic(correlationId, "HOST_FAILURE", "The selected Independent Evidence Profile is unavailable.");
  const framing = reflectionFraming(`${input.focus ?? ""} ${userInputs.map((item) => item.text).join(" ")}`);
  if (reflectionRuns === null) return diagnostic(correlationId, "HOST_FAILURE", "Reflection runs are unavailable.");
  const run = reflectionRuns.create({
    scope: "unscoped",
    sourceThreadId: sourceThread.id,
    framing,
    objective: framing === "retrospective" ? "Review this investment question retrospectively against later evidence, subsequent developments, or observed outcomes." : DEFAULT_UNSCOPED_REFLECTION_OBJECTIVE,
    ...(input.focus?.trim() ? { focus: input.focus.trim() } : {}),
    brief,
    promptRevision,
    ...(profile === undefined ? {} : { independentProfileId: profile.id })
  });
  const thread = stateStore!.getThread(run.threadId);
  if (thread?.scope !== "unscoped") throw new Error("Unscoped Reflection task was not created");
  const created: HostEvent = { ...eventMetadata(correlationId, thread.id), event: "reflection.run.created", payload: { run, thread } };
  if (reflectionLaunchTransition({ profileId: profile?.id }).action === "start_independent") {
    emit(created);
    return startIndependentAssessment(correlationId, run.id);
  }
  return created;
}

async function startIndependentAssessment(correlationId: string, runId: string, profileId?: string): Promise<HostEvent> {
  // `profileId` is retained for legacy command compatibility only.  A
  // Reflection run always executes the profile frozen at its launch.
  void profileId;
  if (reflectionRuns === null) return diagnostic(correlationId, "HOST_FAILURE", "Reflection runs are unavailable.");
  let run = reflectionRuns.get(runId);
  if (run === undefined) return diagnostic(correlationId, "HOST_FAILURE", "Reflection run not found.");
  if (run.status === "independent_completed" || run.status === "independent_running") {
    return { ...eventMetadata(correlationId, run.threadId), event: "reflection.run.updated", payload: { run } };
  }
  if (!executionScheduler!.hasCapacity()) return executionCapacityDiagnostic(correlationId, "Independent Evidence Pass");
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
  const admission = executionScheduler!.admit({ id: turnId, scopeKey: run.threadId, kind: "internal_model_stage" });
  if (!admission.admitted) return executionCapacityDiagnostic(correlationId, "Independent Evidence Pass");
  if (run.scope === "project") stateStore!.authorizeProjectProfile(run.projectId, profile.id, profile.provider);
  run = reflectionRuns.markIndependentRunning(run.id);
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
    piResources: piResourcesConfig()
  };
  turnExecution!.start({ kind: "reflection", context }, workerCommand, () => failReflectionExecution(context, {
    kind: "worker", code: "WORKER_EXITED", message: "Agent Worker exited before the Independent Evidence Pass completed.", provider: profile.provider, model: profile.model
  }));
  return { ...eventMetadata(correlationId, run.threadId), event: "reflection.run.updated", payload: { run } };
}

function stopIndependentAssessment(correlationId: string, runId: string): HostEvent {
  const context = turnExecution!.findReflection(runId);
  const run = reflectionRuns?.get(runId);
  if (run === undefined) return diagnostic(correlationId, "HOST_FAILURE", "Reflection run not found.");
  if (context !== undefined) {
    workerSupervisor?.stop({ schemaVersion: 1, command: "turn.stop", commandId: randomUUID(), correlationId: context.correlationId, threadId: context.threadId, turnId: context.turnId });
  }
  return { ...eventMetadata(correlationId, run.threadId), event: "reflection.run.updated", payload: { run } };
}

function startMemoryAwareReflection(correlationId: string, runId: string, profileId?: string): HostEvent {
  // The second stage cannot select a stage-specific or current-Thread
  // fallback.  The optional argument remains only for legacy command shape.
  void profileId;
  if (reflectionRuns === null) return diagnostic(correlationId, "HOST_FAILURE", "Reflection runs are unavailable.");
  let run = reflectionRuns.get(runId);
  if (run === undefined || run.assessment === undefined) return diagnostic(correlationId, "HOST_FAILURE", "A completed Independent Assessment is required.");
  const assessment = run.assessment;
  if (run.status === "dialogue_active" || run.status === "memory_aware_running") {
    return { ...eventMetadata(correlationId, run.threadId), event: "reflection.run.updated", payload: { run } };
  }
  if (!executionScheduler!.hasCapacity()) return executionCapacityDiagnostic(correlationId, "Memory-Aware Reflection");
  // New launches freeze one Reflection Profile for both isolated stages and
  // never fall back to a current-Thread or stage assignment.
  const effectiveProfileId = run.independentProfileId;
  const profile = effectiveProfileId === undefined ? undefined : stateStore!.getModelProfile(effectiveProfileId);
  if (profile === undefined) return { ...eventMetadata(correlationId, run.threadId), event: "reflection.run.updated", payload: { run } };
  const thread = stateStore!.getThread(run.threadId);
  const promptRevision = stateStore!.getSystemPromptRevision(run.promptSnapshot.revisionId);
  if (thread === undefined || thread.scope !== run.scope || promptRevision?.hash !== run.promptSnapshot.hash) return diagnostic(correlationId, "HOST_FAILURE", "The frozen Reflection scope or Prompt Snapshot is unavailable.");
  const turnId = randomUUID();
  run = reflectionRuns.startMemoryAware(run.id, profile.id, turnId);
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
  const reflectionRun = options.reflectionRun ?? reflectionRuns?.getByThread(input.threadId);
  if (reflectionRun !== undefined && options.reflectionRun === undefined && reflectionRun.status !== "dialogue_active") return diagnostic(correlationId, "HOST_FAILURE", "Complete or explicitly resume the Reflection workflow before continuing its dialogue.");
  const fileDownloadIntent = reflectionRun === undefined && detectFileDownloadIntent(input.text);
  const arxivFulltextIntent = reflectionRun === undefined && detectArxivFulltextIntent(input.text);
  const outputIntent = reflectionRun === undefined && (detectOutputIntent(input.text) || fileDownloadIntent || arxivFulltextIntent);
  const textEditIntent = reflectionRun === undefined && detectTextEditIntent(input.text);
  const memoryRecallMode = reflectionRun !== undefined ? detectExplicitMemoryRecallIntent(input.text) ? "explicit" : "automatic" : detectExplicitMemoryRecallIntent(input.text) ? "explicit" : detectJudgmentHeavyIntent(input.text) ? "automatic" : "none";
  const effectiveProfileId = reflectionRun?.memoryAwareProfileId ?? thread.activeProfileId;
  const profile = effectiveProfileId === undefined ? undefined : stateStore!.getModelProfile(effectiveProfileId);
  const reflectionOutcomeIntent = reflectionRun !== undefined && detectReflectionOutcomeIntent(input.text);
  const academicWorkflow = reflectionRun === undefined ? academicWorkflowPrototype(input.text) : undefined;
  const runtimeSkills = runtimeSkillsForTask(input.text, thread.scope);
  const academicWorkflowLoaded = academicWorkflow !== undefined
    && runtimeSkills.decisions.some((decision) => decision.packageId === academicWorkflow.id);
  const taskAppendSystemPrompt = options.appendSystemPrompt
    ?? (reflectionRun === undefined
      ? academicWorkflow === undefined || academicWorkflowLoaded ? [] : [academicWorkflow.instructions]
      : [MEMORY_AWARE_REFLECTION_INSTRUCTIONS]);
  const effectiveAppendSystemPrompt = [...taskAppendSystemPrompt, CITATION_OUTPUT_INSTRUCTIONS];
  const preloadHints = reflectionRun === undefined
    ? [
        ...capabilitiesForTurn({
        scope: thread.scope,
        materialRecall: detectMaterialRecallIntent(input.text),
        projectStateRecall: detectProjectStateRecallIntent(input.text),
        memoryRecall: memoryRecallMode !== "none",
        webResearch: detectWebResearchIntent(input.text),
        outputWrite: outputIntent && !textEditIntent && !fileDownloadIntent && !arxivFulltextIntent
      }),
        ...(fileDownloadIntent && !arxivFulltextIntent ? ["file_download"] : []),
        ...(arxivFulltextIntent ? ["arxiv.fulltext"] : []),
        ...(outputIntent && !textEditIntent ? ["workspace.write_batch"] : []),
        ...(textEditIntent ? ["output.edit_text"] : []),
        ...(detectAcademicResearchIntent(input.text) ? ["academic_research"] : []),
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
    outputCreateRequested: outputIntent && !textEditIntent && !fileDownloadIntent && !arxivFulltextIntent,
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
  const skillMetadataText = runtimeSkillMetadataText(runtimeSkills);
  const toolSchemaText = JSON.stringify(capabilityInventory.filter((item) => activeCapabilities.includes(item.id)).map((item) => item.inputSchema));
  const budget = contextBudgetService.telemetry({
    systemPromptBytes: Buffer.byteLength(promptRevision.content, "utf8"),
    toolSchemaBytes: Buffer.byteLength(toolSchemaText, "utf8"),
    taskBytes: Buffer.byteLength(`${workerPrompt}\n${effectiveAppendSystemPrompt.join("\n")}\n${skillMetadataText}`, "utf8"),
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
      skillEstimatedTokens: estimateTokens(skillMetadataText),
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
  const submitted: TrajectoryEvent = {
    ...trajectoryMetadata(correlationId, input.threadId, turnId, USER_ACTOR, USER_PROVENANCE),
    event: "turn.submitted",
    payload: {
      text: input.text,
      idempotencyKey: randomUUID(),
      ...(input.retryOfTurnId === undefined ? {} : { retryOfTurnId: input.retryOfTurnId }),
      ...(profile === undefined ? {} : { profile: toTrajectoryProfile(profile) }),
      prompt: promptTelemetry
    }
  };
  trajectoryStore!.append(submitted);
  if (reflectionRun === undefined) automaticReviewUserWorkCompletedInAppRun = true;
  const memorySignal = detectMemoryCandidateSignal(input.text);
  if (memorySignal !== undefined && input.retryOfTurnId === undefined && memoryCandidates !== null && options.skipMemoryCandidate !== true) {
    const candidate = memoryCandidates.capture({ scope: thread.scope, ...(thread.scope === "project" ? { projectId: thread.projectId } : {}), threadId: thread.id, turnId, sourceSnippet: input.text.slice(0, 2_000), sourceKind: reflectionRun?.status === "dialogue_active" ? "reflection_dialogue" : "ordinary_user_signal", signal: memorySignal });
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
  const admission = executionScheduler!.admit({ id: turnId, scopeKey: input.threadId, kind: options.reflectionRun?.status === "memory_aware_running" ? "internal_model_stage" : "ordinary_turn" });
  if (!admission.admitted) return executionCapacityDiagnostic(correlationId, "Turn");
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
    citations: new CitationRegistry(),
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
      appendSystemPrompt: [...(context.appendSystemPrompt ?? [])]
    },
    piResources: piResourcesConfig()
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
  return executionScheduler?.telemetry() ?? {
    capacity: EXECUTION_CAPACITY,
    runningCount: 0,
    queuedCount: 0,
    draftCount: 0,
    averageQueueDelayMs: 0,
    longestRunningMs: 0,
    failureCount: 0
  };
}

function submitOrQueueTurn(correlationId: string, input: { threadId: string; text: string; retryOfTurnId?: string | undefined }): HostEvent {
  const thread = stateStore!.getThread(input.threadId);
  if (thread === undefined) throw new Error("Thread not found");
  const reflection = reflectionRuns?.getByThread(thread.id);
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
      const effectiveProfileId = reflectionRuns?.getByThread(candidateThread.id)?.memoryAwareProfileId ?? candidateThread.activeProfileId;
      return candidate.requestedProfileId === undefined || candidate.requestedProfileId === effectiveProfileId;
    });
    if (item === undefined) break;
    const thread = stateStore.getThread(item.threadId);
    if (thread === undefined) {
      stateStore.cancelExecutionQueueItem(item.id);
      continue;
    }
    const effectiveProfileId = reflectionRuns?.getByThread(thread.id)?.memoryAwareProfileId ?? thread.activeProfileId;
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
    citations: new CitationRegistry(),
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
    piResources: piResourcesConfig()
  };
  turnExecution!.start({ kind: "turn", context }, command, () => {
    finishTurn(context);
    emit(diagnostic(correlationId, "HOST_FAILURE", "Agent Worker exited during Thread compaction."));
  });
  return { ...ipcMetadata(started), event: "thread.compaction.started", payload: { threadId, turnId, reason: "manual" } };
}

function handleWorkerEvent(workerEvent: WorkerEvent): void {
  if (workerEvent.event === "turn.completed" || workerEvent.event === "turn.failed" || workerEvent.event === "turn.interrupted") {
    queueMicrotask(() => applyPendingPiResourcesReload());
  }
  if (subAgentProviderExecutor?.handleEvent(workerEvent) === true) return;
  if (workerEvent.event === "trajectory.acknowledged") {
    stateStore?.acknowledgePhysicalContext(workerEvent.threadId, workerEvent.eventId, workerEvent.sequence);
    return;
  }
  const memoryReviewStage = memoryReviewWorkerStages.get(workerEvent.turnId);
  if (memoryReviewStage !== undefined) {
    handleMemoryReviewWorkerEvent(workerEvent, memoryReviewStage);
    return;
  }
  const execution = turnExecution?.route(workerEvent.turnId);
  if (execution === undefined) return;
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
  if (workerEvent.event === "runtime_tool.started" || workerEvent.event === "runtime_tool.completed") {
    processRuntimeToolObservation(context, workerEvent);
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
    const formattedMessage = context.citations.formatAssistantMessage(workerEvent.message);
    const record: TrajectoryEvent = {
      ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, AGENT_ACTOR, AGENT_PROVENANCE),
      event: "turn.completed",
      payload: {
        message: formattedMessage.message,
        profile: toTrajectoryProfile(context.profile),
        usage: workerEvent.usage,
        citations: formattedMessage.citations,
        ...(workerEvent.contextUsage === undefined ? {} : { contextUsage: workerEvent.contextUsage }),
        latencyMs,
        recalledStateEstimatedTokens,
        ...(workerEvent.responseId === undefined ? {} : { responseId: workerEvent.responseId }),
        ...(workerEvent.piEntryId === undefined ? {} : { piEntryId: workerEvent.piEntryId })
      }
    };
    trajectoryStore!.append(record);
    if (context.reflectionRunId !== undefined) {
      const run = reflectionRuns?.get(context.reflectionRunId);
      if (run?.status === "memory_aware_running" && run.memoryInitialTurnId === context.turnId && reflectionRuns !== null) emitReflectionRun(context.correlationId, reflectionRuns.activateDialogue(run.id));
    }
    finishTurn(context);
    acknowledgeTrajectory(context, record);
    emit({ ...ipcMetadata(record), event: "turn.completed", payload: { threadId: context.threadId, turnId: context.turnId, message: formattedMessage.message, profile: context.profile, usage: workerEvent.usage, citations: formattedMessage.citations, ...(workerEvent.contextUsage === undefined ? {} : { contextUsage: workerEvent.contextUsage }), latencyMs, recalledStateEstimatedTokens, ...(workerEvent.responseId === undefined ? {} : { responseId: workerEvent.responseId }) } });
    if (context.reflectionRunId === undefined) maybeStartAutomaticMemoryReview(context.correlationId);
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
    const run = reflectionRuns?.get(context.reflectionRunId);
    if (run?.status === "memory_aware_running" && reflectionRuns !== null) emitReflectionRun(context.correlationId, reflectionRuns.failMemoryAware(run.id, workerEvent.failure));
  }
  finishTurn(context);
  acknowledgeTrajectory(context, record);
  emit({ ...ipcMetadata(record), event: "turn.failed", payload: { threadId: context.threadId, turnId: context.turnId, text: context.text, ...(context.retryOfTurnId === undefined ? {} : { retryOfTurnId: context.retryOfTurnId }), profile: context.profile, failure: workerEvent.failure } });
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
    if (reflectionRuns === null) return;
    const run = reflectionRuns.setSessionFile(context.runId, workerEvent.sessionFile);
    emitReflectionRun(context.correlationId, run);
    return;
  }
  if (workerEvent.event === "turn.started" || workerEvent.event === "message.delta" || workerEvent.event === "thinking.delta" || workerEvent.event.startsWith("thread.compaction.")) return;
  if (workerEvent.event === "turn.completed") {
    try {
      const assessment = parseIndependentAssessment(workerEvent.message);
      if (reflectionRuns === null) return;
      const run = reflectionRuns.completeIndependent(context.runId, assessment);
      finishReflectionExecution(context);
      emitReflectionRun(context.correlationId, run);
      const promptSnapshot = stateStore!.getSystemPromptRevision(run.promptSnapshot.revisionId);
      const transition = reflectionCompletionTransition({
        status: run.status,
        independentProfileId: run.independentProfileId,
        assessmentAvailable: run.assessment !== undefined,
        frozenBriefAvailable: run.brief !== undefined,
        frozenPromptSnapshotAvailable: promptSnapshot?.hash === run.promptSnapshot.hash
      });
      if (transition.action === "start_memory_aware") {
        try {
          // finishReflectionExecution above releases the Independent Evidence
          // lease and retires its Worker before this new isolated context is
          // admitted.  The handoff prompt is rebuilt from only the frozen
          // brief and bounded assessment; no Independent session/history is
          // passed to submitTurn.
          const started = startMemoryAwareReflection(context.correlationId, run.id, transition.profileId);
          if (started.event !== "reflection.run.updated") emit(started);
        } catch {
          // The completed assessment remains resumable and visible.  A local
          // start failure never retries or silently chooses another Profile.
          emit(diagnostic(context.correlationId, "HOST_FAILURE", "Memory-Aware Reflection could not start automatically."));
        }
      }
    } catch {
      failReflectionExecution(context, {
        kind: "worker", code: "INVALID_INDEPENDENT_ASSESSMENT", message: "The model response did not match the bounded Independent Assessment contract.", provider: context.profile.provider, model: context.profile.model
      });
    }
    return;
  }
  if (workerEvent.event === "turn.interrupted") {
    if (reflectionRuns === null) return;
    const run = reflectionRuns.interruptIndependent(context.runId);
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
  if (reflectionRuns === null) return;
  const current = reflectionRuns.get(context.runId);
  if (current?.status !== "independent_running") return;
  const run = reflectionRuns.failIndependent(context.runId, failure);
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

function processRuntimeToolObservation(
  context: TurnContext,
  workerEvent: Extract<WorkerEvent, { event: "runtime_tool.started" | "runtime_tool.completed" }>
): void {
  const requestId = `runtime:${workerEvent.toolCallId}`;
  const runtime = {
    sourceClass: workerEvent.source,
    sourceId: workerEvent.sourceId,
    sourceRevision: workerEvent.sourceRevision,
    activationReason: workerEvent.toolName === "source_check" ? "capability_broker" : "task_visibility",
    actionClass: "network_read" as const,
    confirmationState: "not_required" as const,
    ...(workerEvent.event === "runtime_tool.completed" ? { durationMs: workerEvent.durationMs, truncated: workerEvent.content.length >= 20_000 } : {})
  };
  if (workerEvent.event === "runtime_tool.started") {
    const started: TrajectoryEvent = {
      ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, AGENT_ACTOR, AGENT_PROVENANCE),
      event: "tool.started",
      payload: {
        toolCallId: workerEvent.toolCallId,
        capabilityId: workerEvent.toolName,
        arguments: summarizeCapabilityArguments(workerEvent.arguments),
        expectedStateVersion: context.expectedStateVersion,
        runtime
      }
    };
    trajectoryStore!.append(started);
    inflight!.startTool(context.turnId, { toolCallId: workerEvent.toolCallId, capabilityId: workerEvent.toolName }, workerEvent.workerSequence, started.sequence);
    emit({
      ...ipcMetadata(started),
      event: "capability.execution.updated",
      payload: {
        threadId: context.threadId,
        turnId: context.turnId,
        requestId,
        capabilityId: workerEvent.toolName,
        status: "started",
        content: `Runtime Extension '${workerEvent.toolName}' started.`,
        runtime
      }
    });
    return;
  }

  const observedResult: CapabilityExecutionResult = {
    schemaVersion: 1,
    requestId,
    status: workerEvent.isError ? "failed" : "completed",
    content: workerEvent.content
  };
  const result = context.citations.annotateCapabilityResult(observedResult, {
    capabilityId: workerEvent.toolName,
    toolCallId: workerEvent.toolCallId
  });
  const terminal: TrajectoryEvent = {
    ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, AGENT_ACTOR, AGENT_PROVENANCE),
    event: result.status === "completed" ? "tool.completed" : "tool.failed",
    payload: {
      toolCallId: workerEvent.toolCallId,
      capabilityId: workerEvent.toolName,
      summary: result.content,
      artifactIds: [],
      runtime
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
      status: result.status,
      content: result.content,
      runtime
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
  emit({
    ...ipcMetadata(started),
    event: "capability.execution.updated",
    payload: { threadId: context.threadId, turnId: context.turnId, requestId: request.requestId, capabilityId: request.capabilityId, status: "started", content: "Capability execution requested." }
  });

  capabilityRequests.set(request.requestId, { context, request });

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
  emitToRenderer: boolean,
  runtime?: NonNullable<Extract<TrajectoryEvent, { event: "tool.completed" | "tool.failed" | "tool.unknown_outcome" }>["payload"]["runtime"]>
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
  result = context.citations.annotateCapabilityResult(result, {
    capabilityId: request.capabilityId,
    toolCallId: request.toolCallId
  });
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
      ...(result.retrieval === undefined ? {} : { contextReference: result.retrieval.contextReference }),
      ...(runtime === undefined ? {} : { runtime })
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
      ...(result.artifact === undefined ? {} : { artifact: { id: result.artifact.id, mediaType: result.artifact.mediaType, destination: result.artifact.destination } }),
      ...(runtime === undefined ? {} : { runtime })
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
    const run = reflectionRuns?.get(context.reflectionRunId);
    if (run?.status === "memory_aware_running" && reflectionRuns !== null) emitReflectionRun(context.correlationId, reflectionRuns.interruptMemoryAware(run.id));
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

/**
 * Convert the legacy Reflection outcome projection into the one Cognition
 * Review Module input.  The conversion is Host-owned: the Renderer never
 * chooses a destination path, scope, dependency hash, or Memory action.
 */
function prepareReflectionCognitionBundle(run: ReflectionRun): ReviewBundle | undefined {
  if (cognitionReviews === null || cognitionReviewStore === null || reflectionDrafts === null) return undefined;
  const existing = cognitionReviewStore.listReviewBundles().find((bundle) => bundle.kind === "reflection" && bundle.judgment !== undefined && bundle.judgment.id === reflectionDrafts!.list(run.id).judgments.at(-1)?.id && ["analysis_completed", "waiting_for_review", "reviewing", "prepared"].includes(bundle.status));
  if (existing !== undefined) {
    reflectionReviewRuns.set(existing.id, run.id);
    return existing;
  }
  const outcomes = reconcileReflectionOutcomeState(run);
  const judgment = [...outcomes.judgments].reverse().find((draft) => draft.status === "draft");
  if (judgment === undefined) return undefined;
  const proposals = outcomes.learningProposals.filter((proposal) => proposal.status === "draft").map((proposal) => toCognitionLearningProposal(run, judgment, proposal));
  const dependencies = cognitionDependencies(run, judgment, outcomes.learningProposals);
  const input: ReflectionReviewInput = {
    kind: "reflection",
    judgment: {
      id: judgment.id,
      title: "Investment Judgment",
      judgment: judgment.view,
      rationale: judgment.reasoning,
      uncertainty: judgment.uncertainties,
      evidenceReferences: judgment.evidenceReferences,
      createdAt: judgment.createdAt
    },
    proposals,
    dependencies
  };
  const bundle = cognitionReviews.prepare(input);
  reflectionReviewRuns.set(bundle.id, run.id);
  return bundle;
}

function reflectionRunForReview(reviewId: string): ReflectionRun | undefined {
  const mapped = reflectionReviewRuns.get(reviewId);
  if (mapped !== undefined) return reflectionRuns?.get(mapped);
  const bundle = cognitionReviewStore?.loadReviewBundle(reviewId);
  const judgmentId = bundle?.judgment?.id;
  if (judgmentId === undefined || reflectionRuns === null || reflectionDrafts === null) return undefined;
  const run = reflectionRuns.list().find((candidate) => reflectionDrafts!.list(candidate.id).judgments.some((draft) => draft.id === judgmentId));
  if (run !== undefined) reflectionReviewRuns.set(reviewId, run.id);
  return run;
}

function toCognitionLearningProposal(run: ReflectionRun, judgment: JudgmentRecordDraft, proposal: LongTermLearningProposal): LearningProposal {
  return {
    id: proposal.id,
    title: proposal.proposed.title,
    content: proposal.proposed.content,
    applicability: proposal.proposed.applicability,
    limitations: proposal.proposed.limitations,
    destination: "long_term_memory",
    action: proposal.action,
    sourceReferences: [judgment.sourceReferenceId, ...judgment.evidenceReferences].slice(0, 100),
    targetEntryIds: proposal.targetEntryIds,
    ...(run.scope === "project" ? { projectId: run.projectId } : {})
  };
}

function cognitionDependencies(run: ReflectionRun, judgment: JudgmentRecordDraft, proposals: readonly LongTermLearningProposal[]): CognitionDependency[] {
  const dependencies: CognitionDependency[] = [{ kind: "source", reference: judgment.sourceReferenceId, hash: `reflection:${run.id}`, required: true }];
  for (const dependency of [...judgment.dependencies, ...proposals.flatMap((proposal) => proposal.dependencies)]) {
    const kind = dependency.kind === "material" ? "material" : dependency.kind === "project_memory" ? "project_memory" : "long_term_memory";
    const reference = `${dependency.kind}:${dependency.targetId}:${dependency.referenceId}`;
    if (!dependencies.some((candidate) => candidate.kind === kind && candidate.reference === reference)) dependencies.push({ kind, reference, hash: dependency.contentVersion, required: true });
  }
  return dependencies;
}

function reconcileReflectionOutcomeState(run: ReflectionRun) {
  if (reflectionDrafts === null) throw new Error("Reflection drafts are unavailable.");
  let outcomes = reflectionDrafts.list(run.id);
  if (stateStore?.isReadOnlyRecovery === true) return outcomes;
  const state = reflectionDependencyState(run);
  for (const outcome of [...outcomes.judgments, ...outcomes.learningProposals]) {
    if (outcome.status !== "draft") continue;
    const reasons = staleReflectionDependencies(outcome.dependencies, state);
    if (reasons.length === 0) continue;
    reflectionDrafts.markStale(outcome.id, reasons);
  }
  outcomes = reflectionDrafts.list(run.id);
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

interface CurrentCognitionDependency {
  readonly hash: string;
  readonly path?: string;
}

/**
 * Re-resolve Cognition Review dependencies against the current Host state.
 * Review bundles keep only frozen hashes; this seam prevents commit from
 * trusting a stale target file or a renderer-provided dependency value.
 */
function resolveCognitionReviewDependency(dependency: CognitionDependency): CurrentCognitionDependency | undefined {
  if (stateStore === null) return undefined;
  if (dependency.kind === "source") {
    if (reflectionRuns === null || reflectionDrafts === null) return undefined;
    const matches = reflectionRuns.list().filter((run) => run.status !== "discarded" && reflectionDrafts!.list(run.id).judgments.some((judgment) => judgment.sourceReferenceId === dependency.reference && judgment.status !== "discarded"));
    return matches.length === 1 ? { hash: `reflection:${matches[0]!.id}` } : undefined;
  }

  if (dependency.kind === "project_memory") {
    // Memory Review dependencies identify the project document directly.
    const project = stateStore.getProject(dependency.reference);
    if (project !== undefined && projectMemories !== null) {
      const document = projectMemories.load(project.id, project.path, false);
      return document === undefined ? undefined : { hash: document.sourceHash, path: projectMemories.markdownPath(project.path) };
    }
    const scoped = parseScopedCognitionDependencyReference(dependency.reference, "project_memory");
    if (scoped === undefined || projectMemories === null) return undefined;
    const matches: { readonly value: unknown; readonly path: string }[] = [];
    for (const candidate of stateStore.listProjects()) {
      const document = projectMemories.load(candidate.id, candidate.path, false);
      const entry = document?.entries.find((item) => item.id === scoped.targetId);
      if (document !== undefined && entry !== undefined) matches.push({ value: entry, path: projectMemories.markdownPath(candidate.path) });
    }
    return matches.length === 1 ? { hash: reflectionDependencyFingerprint(matches[0]!.value), path: matches[0]!.path } : undefined;
  }

  if (dependency.kind === "long_term_memory") {
    const document = longTermMemories?.load(false);
    if (document === undefined) return undefined;
    if (dependency.reference === "long_term_memory") return { hash: document.sourceHash, path: document.markdownPath };
    const scoped = parseScopedCognitionDependencyReference(dependency.reference, "long_term_memory");
    if (scoped === undefined) return undefined;
    const matches = document.entries.filter((entry) => entry.id === scoped.targetId);
    return matches.length === 1 ? { hash: reflectionDependencyFingerprint(matches[0]!) } : undefined;
  }

  if (dependency.kind === "material") {
    const scoped = parseScopedCognitionDependencyReference(dependency.reference, "material");
    if (scoped === undefined) return undefined;
    const matches = stateStore.listProjects().flatMap((project) => stateStore!.listMaterials(project.id).filter((material) => material.id === scoped.targetId && material.availability === "active"));
    return matches.length === 1 ? { hash: matches[0]!.sourceHash } : undefined;
  }

  // Memory and judgment_destination are not current source documents.  An
  // unresolved required dependency must make the review stale at commit.
  return undefined;
}

function parseScopedCognitionDependencyReference(reference: string, kind: "material" | "project_memory" | "long_term_memory"): { readonly targetId: string; readonly referenceId: string } | undefined {
  const prefix = `${kind}:`;
  if (!reference.startsWith(prefix)) return undefined;
  const remainder = reference.slice(prefix.length);
  const separator = remainder.indexOf(":");
  if (separator <= 0 || separator === remainder.length - 1) return undefined;
  return { targetId: remainder.slice(0, separator), referenceId: remainder.slice(separator + 1) };
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

function testWebExtensionOptions(toolName: "web_search" | "web_fetch" | "source_check"): {
  readonly testExecutor?: (input: Record<string, unknown>, context: CapabilityExecutionContext) => Promise<CapabilityExecutionResult>;
} {
  if (process.env.NODE_ENV !== "test" || process.env.VC_AGENT_TEST_WEB_FIXTURE !== "1") return {};
  return {
    testExecutor: async (input, context) => {
      const retrievedAt = new Date().toISOString();
      const isSearch = toolName === "web_search";
      const url = isSearch
        ? "https://example.com/market"
        : typeof input.url === "string" ? input.url : "https://example.com/market";
      const item = {
        url,
        title: "Fixture market evidence",
        accessedAt: retrievedAt,
        content: "Public evidence for the bounded dogfood workflow."
      };
      const envelope = {
        schemaVersion: 1 as const,
        sourceClass: "web" as const,
        disclosureLevel: isSearch ? "search" : "fetch",
        items: [item],
        complete: true,
        omittedItems: 0,
        warnings: [],
        contextReference: {
          schemaVersion: 1 as const,
          sourceClass: "web" as const,
          sourceId: isSearch ? "search:fixture-market" : url,
          label: item.title,
          sourceRange: isSearch ? "search-results" : "document",
          originatingTool: toolName,
          originatingTurnId: context.request.turnId,
          retrievedAt,
          status: "active" as const
        }
      };
      const serialized = serializeBoundedRetrieval(envelope);
      return {
        schemaVersion: 1,
        requestId: context.request.requestId,
        status: "completed",
        content: serialized.body,
        retrieval: serialized.retrieval
      };
    }
  };
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

/**
 * Run the one-shot cognition-v2 reset before constructing any execution
 * runtime.  Project roots and Unscoped Output locations come directly from
 * the just-opened Host state; no guessed/default path is admitted to the
 * destructive boundary.
 */
function runLearningEpochCutover(userDataRoot: string, statePath: string, openedState: HostStateStore): boolean {
  try {
    const reset = new LearningEpochReset({
      appDataRoot: userDataRoot,
      stateStore: openedState,
      rollbackState: () => restoreStateStorageRollback(statePath),
      projectRoots: openedState.listProjects().map((project) => project.path),
      unscopedOutputRoots: openedState.listUnscopedThreads()
        .flatMap((thread) => thread.outputLocation === undefined ? [] : [thread.outputLocation])
    });
    const result = reset.reset();
    learningEpochRecovery = result.mode === "read_only_recovery" || openedState.isReadOnlyRecovery;
    return !learningEpochRecovery;
  } catch {
    // A malformed reset boundary is itself a recovery condition.  Keep the
    // Host alive for bootstrap/export diagnostics and admit no runtime.
    learningEpochRecovery = true;
    return false;
  }
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  const runtimePaths = resolveDesktopRuntimePaths({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDirectory: __dirname
  });
  const bundledAcademicSkillsRoot = runtimePaths.bundledAcademicSkillsRoot;
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
  const userDataRoot = app.getPath("userData");
  const statePath = join(userDataRoot, "state.db");
  stateStore = new HostStateStore(statePath, {
    failAfterStageValidation: process.env.NODE_ENV === "test" && process.env.VC_AGENT_TEST_MIGRATION_FAIL_AFTER_STAGE === "1"
  });
  // This is the first operation after State v18 opens.  It must stay ahead of
  // every Worker, Pi, Provider, Utility, and scheduling/runtime constructor.
  if (!runLearningEpochCutover(userDataRoot, statePath, stateStore)) {
    ipcMain.handle(COMMAND_CHANNEL, handleCommand);
    mainWindow = createMainWindow();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow(); });
    return;
  }
  loadPiResourceSettings();
  migrateLegacyPiResources();
  loadIntegrationJobs(join(app.getPath("userData"), "integrations", "jobs.json"));
  vcSkillsDirectory = new VcSkillsDirectoryAdapter({ root: piResourcePaths().skills });
  executionScheduler = new BoundedExecutionScheduler({ capacity: EXECUTION_CAPACITY, store: stateStore });
  workerSupervisor = new AgentWorkerSupervisor(runtimePaths.agentWorkerEntry, handleWorkerEvent);
  turnExecution = new HostTurnExecutionModule((command) => workerSupervisor!.execute(command));
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
        appendSystemPrompt: [CITATION_OUTPUT_INSTRUCTIONS]
      };
    },
    piResources: () => piResourcesConfig(),
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
  utilityJobRunner = new UtilityJobRunner(runtimePaths.utilityWorkerEntry);
  officeOrchestrator = new OfficeSkillOrchestrator({ skills: vcSkillsDirectory!, adapter: createDesktopOfficeAdapter({ runner: utilityJobRunner }), root: join(app.getPath("userData"), "integrations", "office") });
  skillCreatorWorkflow = new SkillCreationWorkflow({ skills: vcSkillsDirectory!, root: join(app.getPath("userData"), "integrations", "skill-creator") });
  const ocrRuntimeRoot = resolve(process.env.VC_AGENT_OCR_RUNTIME_ROOT ?? join(process.env.LOCALAPPDATA ?? app.getPath("userData"), "vc-agent", "runtimes", "ocr"));
  const localOcrOptions = { runner: utilityJobRunner, runtimeRoot: ocrRuntimeRoot, stagingRoot: join(app.getPath("userData"), "integrations", "page-recovery", "staging") };
  const useFixtureOcr = process.env.NODE_ENV === "test" && process.env.VC_AGENT_REAL_OCR !== "1";
  pageRecoveryPipeline = new PageRecoveryPipeline(useFixtureOcr
    ? { native: createDesktopNativePdfAdapter(), paddle: createDesktopPaddleAdapter(), ovis: createDesktopOvisAdapter() }
    : { native: createDesktopNativePdfAdapter(localOcrOptions), paddle: createDesktopPaddleAdapter(localOcrOptions), ovis: createDesktopOvisAdapter(localOcrOptions) });
  const readOnlyRecovery = hostReadOnlyRecovery();
  reflectionRuns = new ReflectionRunStore(join(app.getPath("userData"), "cognition-v2", "reflection-runs.json"), {
    createProjectThread: (projectId, title) => stateStore!.createProjectThread(projectId, title),
    createUnscopedThread: (title) => stateStore!.createUnscopedThread(title),
    getThread: (threadId) => stateStore!.getThread(threadId),
    selectThreadProfile: (threadId, profileId) => stateStore!.selectThreadProfile(threadId, profileId),
    setThreadOutputLocation: (threadId, outputLocation) => stateStore!.setThreadOutputLocation(threadId, outputLocation)
  }, { createRoot: !readOnlyRecovery });
  if (!readOnlyRecovery) reflectionRuns?.recoverInterrupted();
  if (!readOnlyRecovery) stateStore.recoverQueuedExecutionAsDrafts();
  if (!readOnlyRecovery) stateStore.clearStaleExecutionLeases();
  longTermMemories = new LongTermMemoryStore(join(app.getPath("userData"), "memory", "long-term"));
  if (!readOnlyRecovery) {
    memoryEvolution = new MemoryEvolutionStore(longTermMemories);
    projectMemories = new ProjectMemoryStore(join(app.getPath("userData"), "memory", "project-index"));
    memoryCandidates = new MemoryCandidateStore(join(app.getPath("userData"), "memory", "candidates.jsonl"));
    cognitionReviewStore = new CognitionReviewStore(join(app.getPath("userData"), "cognition-v2"));
    cognitionReviews = createCognitionReviewModule({
      store: cognitionReviewStore,
      memory: longTermMemories,
      evolution: memoryEvolution,
      projectMemory: projectMemories,
      transactionRoot: join(app.getPath("userData"), "cognition-v2", "transactions"),
      allowedRoots: () => [app.getPath("userData"), ...stateStore!.listProjects().map((project) => project.path)],
      resolveProject: (projectId) => {
        const project = stateStore!.getProject(projectId);
        return project === undefined ? undefined : { id: project.id, path: project.path };
      },
      resolveDependency: resolveCognitionReviewDependency
    });
  }
  // Reflection analytical drafts are non-authoritative and live under the
  // active cognition-v2 root.  The concrete event-log store stays behind the
  // narrow Host factory; legacy Reflection outcome state is never recreated.
  reflectionDrafts = createReflectionDrafts({ root: join(app.getPath("userData"), "cognition-v2") });
  trajectoryStore = new ThreadTrajectoryStore(join(app.getPath("userData"), "threads"), { createRoot: !readOnlyRecovery });
  if (!readOnlyRecovery && cognitionReviewStore !== null && cognitionReviews !== null) {
    initializeMemoryReviewOrchestrator();
    try { memoryReviewPolicy = stateStore.getAutoMemoryReviewPolicy(); } catch { memoryReviewPolicy = undefined; }
  }
  for (const thread of stateStore.listThreads()) {
    if (!readOnlyRecovery) trajectoryStore.recoverInterruptedTurns(thread.id);
    const lastSequence = trajectoryStore.loadEvents(thread.id).at(-1)?.sequence ?? 0;
    sequenceByThread.set(thread.id, lastSequence);
  }
  inflight = new InflightTurnCoordinator(trajectoryStore);
  if (!readOnlyRecovery) stateStore.ensureDefaultSystemPrompt(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT);
  if (!readOnlyRecovery) runMemoryReviewStartupDueCheck();
  if (!readOnlyRecovery) personalCognition = new PersonalCognitionBackupService({
    state: stateStore,
    memoryFiles: {
      "long-term-memory.md": longTermMemories.markdownPath,
      "long-term-memory-condensation-archive.md": longTermMemories.archivePath,
      "cognitive-evolution-history.md": longTermMemories.historyPath,
      "long-term-maintenance.json": join(app.getPath("userData"), "memory", "long-term-maintenance.json")
    },
    cognitionRoot: join(app.getPath("userData"), "cognition-v2"),
    skillsRoot: piResourcePaths().skills
  });
  capabilityRegistry = new CapabilityRegistry();
  const textOutputStore = new TextOutputStore();
  capabilityRegistry.register(createTextOutputCapability(textOutputStore));
  capabilityRegistry.register(createTextEditCapability(textOutputStore));
  capabilityRegistry.register(createFileDownloadCapability(new BinaryOutputStore(), new FetchFileDownloadClient()));
  capabilityRegistry.register(createWorkspaceWriteCapability(new WorkspaceWriteStore()));
  if (bundledAcademicSkillsRoot !== undefined && utilityJobRunner !== null) {
    capabilityRegistry.register(createArxivFulltextCapability(
      new WorkspaceWriteStore(MAX_ARXIV_BUNDLE_BYTES, 4),
      new BundledArxivFulltextClient({ skillRoot: bundledAcademicSkillsRoot, stagingRoot: join(app.getPath("userData"), "academic-research", "staging"), runner: utilityJobRunner })
    ));
  }
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
    const run = turn?.reflectionRunId === undefined ? undefined : reflectionRuns?.get(turn.reflectionRunId);
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
    if (turn?.reflectionRunId === undefined || !turn.reflectionOutcomeIntent || reflectionDrafts === null) {
      throw new Error("Reflection outcomes require an explicit User request in an active Reflection dialogue.");
    }
    const run = reflectionRuns?.get(turn.reflectionRunId);
    if (run === undefined || run.status !== "dialogue_active") throw new Error("Reflection dialogue is not active.");
    const created = reflectionDrafts.propose(run.id, input, reflectionOutcomeDependencies(run, input));
    return JSON.stringify({ status: "drafted", judgmentCount: created.judgments.length, learningProposalCount: created.learningProposals.length });
  }));
  capabilityRegistry.register(createRuntimeExtensionCapability({
    id: "web_search",
    version: "pi-web-access@0.17.0",
    label: "Search public web",
    description: "Search the current public web through the pinned pi-web-access Extension without login, browser state, writes, or durable snapshots.",
    useWhen: "Use when current external facts or public-source verification materially affect the answer.",
    tier: "common_read",
    activationClass: "ordinary_task",
    sideEffectClass: "network_read",
    allowedScopes: ["unscoped", "project"],
    executor: "host",
    modelCallable: true,
    inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 500 }, maxResults: { type: "integer", minimum: 1, maximum: 6 }, maxChars: { type: "integer", minimum: 500, maximum: 8_000 } }, required: ["query"] },
    outputSchema: { type: "object", properties: { sourceClass: { const: "web" }, items: { type: "array" }, complete: { type: "boolean" }, omittedItems: { type: "integer" }, warnings: { type: "array" }, contextReference: { type: "object" } } }
  }, testWebExtensionOptions("web_search")));
  capabilityRegistry.register(createRuntimeExtensionCapability({
    id: "web_fetch",
    version: "pi-web-access@0.17.0",
    label: "Fetch public URL",
    description: "Fetch and extract a bounded public page or PDF through the pinned pi-web-access Extension without login, browser state, writes, or durable snapshots.",
    useWhen: "Use after search, or when the User supplies a public URL that must be verified.",
    tier: "common_read",
    activationClass: "ordinary_task",
    sideEffectClass: "network_read",
    allowedScopes: ["unscoped", "project"],
    executor: "host",
    modelCallable: true,
    inputSchema: { type: "object", properties: { url: { type: "string", maxLength: 2_000 }, maxChars: { type: "integer", minimum: 500, maximum: 8_000 } }, required: ["url"] },
    outputSchema: { type: "object", properties: { sourceClass: { const: "web" }, items: { type: "array" }, complete: { type: "boolean" }, omittedItems: { type: "integer" }, warnings: { type: "array" }, contextReference: { type: "object" } } }
  }, testWebExtensionOptions("web_fetch")));
  capabilityRegistry.register(createRuntimeExtensionCapability({
    id: "source_check",
    version: "pi-web-access@0.17.0",
    label: "Check public source",
    description: "Check a public source through the pinned pi-web-access Extension and return bounded source-reference evidence.",
    useWhen: "Use when a public URL or search result needs an explicit source check before making a claim.",
    tier: "on_demand",
    activationClass: "ordinary_task",
    sideEffectClass: "network_read",
    allowedScopes: ["unscoped", "project"],
    executor: "host",
    modelCallable: true,
    inputSchema: { type: "object", properties: { url: { type: "string", maxLength: 2_000 }, query: { type: "string", maxLength: 500 } } },
    outputSchema: { type: "object", properties: { sourceClass: { const: "web" }, items: { type: "array" }, warnings: { type: "array" } } }
  }, testWebExtensionOptions("source_check")));
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
      const run = reflectionRuns?.get(execution.context.runId);
      if (run?.status === "independent_running") reflectionRuns?.interruptIndependent(execution.context.runId);
      if (run?.status === "memory_aware_running") reflectionRuns?.interruptMemoryAware(execution.context.runId);
      turnExecution?.finish(execution);
    } else {
      turnExecution?.finish(execution);
    }
  }
  for (const stage of [...memoryReviewWorkerStages.values()]) settleMemoryReviewWorkerStage(stage.turnId, new Error("MEMORY_REVIEW_APPLICATION_RESTART"));
  memoryReviewCorrelationByBatch.clear();
  memoryReviewOrchestrator = null;
  memoryReviewPolicy = undefined;
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
  officeOrchestrator = null;
  skillCreatorWorkflow = null;
  pageRecoveryPipeline = null;
  vcSkillsDirectory = null;
  persistIntegrationJobs();
  integrationJobsPath = undefined;
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
  stateStore?.close();
  stateStore = null;
  projectMemories = null;
  longTermMemories = null;
  memoryCandidates = null;
  await Promise.allSettled([subAgentShutdown, workerShutdown, utilityShutdown, officeShutdown, skillCreatorShutdown]);
}
