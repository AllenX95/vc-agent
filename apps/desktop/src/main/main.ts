import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from "electron";
import {
  IPC_SCHEMA_VERSION,
  canonicalParseSchema,
  hostCommandSchema,
  type ActorRef,
  type CapabilityExecutionRequest,
  type CapabilityExecutionResult,
  type DreamProfileSnapshot,
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
  type WorkerEvent
} from "@vc-agent/contracts";
import { CapabilityRegistry, coreCapabilitiesForScope, createCapabilityBroker, createMaterialRecallCapability, createMemoryRecallCapability, createProjectStateRecallCapability, createReflectionEvidenceDrilldownCapability, createReflectionOutcomeProposalCapability, createTextOutputCapability, createWebFetchCapability, createWebSearchCapability, TextOutputStore } from "@vc-agent/capabilities";
import { BASELINE_PARSER_ADAPTERS, CapabilityGateway, DEFAULT_PROJECT_REFLECTION_OBJECTIVE, DEFAULT_UNSCOPED_REFLECTION_OBJECTIVE, DreamReviewStore, INDEPENDENT_EVIDENCE_STAGE_INSTRUCTIONS, INDEPENDENT_UNSCOPED_EVIDENCE_STAGE_INSTRUCTIONS, MEMORY_AWARE_REFLECTION_INSTRUCTIONS, LongTermMemoryRecallSource, LongTermMemoryStore, MemoryCandidateStore, MemoryEvolutionStore, ProjectOutputRegistry, ReflectionEvidenceDrilldownSource, ReflectionOutcomeStore, buildIndependentEvidencePrompt, buildMemoryAwareReflectionPrompt, buildReflectionProjectBrief, buildReflectionUnscopedBrief, captureReflectionDependencies, detectExplicitMemoryRecallIntent, detectJudgmentHeavyIntent, detectMemoryCandidateSignal, detectOutputIntent, detectReflectionDreamEligibility, detectWebResearchIntent, estimateTokens, expectedParserIdentity, inventoryProjectFiles, MaterialRecallSource, parseIndependentAssessment, ProjectContextRecallSource, ProjectContextStore, ProjectIdentityStore, ProjectMemoryRecallSource, ProjectMemoryStore, PublicWebRecallSource, reflectionFraming, retrievalMetadata, retrievalTrajectorySummary, selectEligibleDreamTrajectory, SHIPPED_MINIMAL_VC_SYSTEM_PROMPT, staleReflectionDependencies, type CapabilityAuthorizationSnapshot, type ReflectionDependencyState } from "@vc-agent/host-services";
import { exportRawStateBundle, HostStateStore, ThreadTrajectoryStore } from "@vc-agent/persistence";
import { AgentWorkerSupervisor } from "./agent-worker-supervisor.js";
import { InflightTurnCoordinator } from "./inflight-turn-coordinator.js";
import { UtilityJobRunner } from "./utility-job-runner.js";
import { ProtectedCredentialService } from "./protected-credential-service.js";

const COMMAND_CHANNEL = "vc-agent:command";
const EVENT_CHANNEL = "vc-agent:event";
const HOST_ACTOR = { actorType: "host", actorId: "desktop-host" } as const;
const HOST_PROVENANCE = { producerType: "host", producerId: "desktop-host" } as const;
const USER_ACTOR = { actorType: "user", actorId: "local-user" } as const;
const USER_PROVENANCE = { producerType: "user", producerId: "local-user" } as const;
const AGENT_ACTOR = { actorType: "agent", actorId: "primary-agent" } as const;
const AGENT_PROVENANCE = { producerType: "agent", producerId: "primary-agent" } as const;
const READ_ONLY_RECOVERY_COMMANDS = new Set<HostCommand["command"]>([
  "app.bootstrap",
  "state.recovery.export",
  "profile.list",
  "prompt.revision.list",
  "task_model_assignment.list",
  "reflection.list",
  "reflection.outcome.list",
  "dream.state.load",
  "project.list",
  "project.material.list",
  "project.output.list",
  "thread.list",
  "thread.trajectory.load"
]);

interface TurnContext {
  readonly correlationId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly text: string;
  readonly profile: ModelProfile;
  readonly outputIntent: boolean;
  readonly memoryRecallMode: "none" | "automatic" | "explicit";
  readonly longTermMemoryCardIds: Set<string>;
  readonly activeCapabilities: string[];
  readonly expectedStateVersion: number;
  readonly promptRevision: SystemPromptRevision;
  readonly retryOfTurnId?: string;
  readonly compactionOnly?: true;
  readonly reflectionRunId?: string;
  readonly reflectionOutcomeIntent: boolean;
  readonly appendSystemPrompt?: readonly string[];
  readonly submittedAtMs: number;
  recalledStateEstimatedTokens: number;
  recallBodyBytes: number;
}

interface ReflectionExecutionContext {
  readonly correlationId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly scope: "project" | "unscoped";
  readonly projectId?: string;
  readonly activeCapabilities: readonly string[];
  readonly outputLocation?: string;
  readonly profile: ModelProfile;
  readonly expectedStateVersion: number;
  readonly promptRevision: SystemPromptRevision;
}

let mainWindow: BrowserWindow | null = null;
let stateStore: HostStateStore | null = null;
let trajectoryStore: ThreadTrajectoryStore | null = null;
let inflight: InflightTurnCoordinator | null = null;
let workerSupervisor: AgentWorkerSupervisor | null = null;
let capabilityGateway: CapabilityGateway | null = null;
let utilityJobRunner: UtilityJobRunner | null = null;
let capabilityRegistry: CapabilityRegistry | null = null;
let projectMemories: ProjectMemoryStore | null = null;
let longTermMemories: LongTermMemoryStore | null = null;
let memoryEvolution: MemoryEvolutionStore | null = null;
let memoryCandidates: MemoryCandidateStore | null = null;
let reflectionOutcomes: ReflectionOutcomeStore | null = null;
let dreamReviews: DreamReviewStore | null = null;
let externalNetworkRequests = 0;
let shuttingDown = false;
const sequenceByThread = new Map<string, number>();
const turnContexts = new Map<string, TurnContext>();
const reflectionContexts = new Map<string, ReflectionExecutionContext>();
const activeTurnByThread = new Map<string, string>();
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

if (process.env.VC_AGENT_USER_DATA_DIR) app.setPath("userData", process.env.VC_AGENT_USER_DATA_DIR);

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

function toDreamProfileSnapshot(profile: ModelProfile): DreamProfileSnapshot {
  return { id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, thinkingLevel: profile.thinkingLevel };
}

function dreamStateEvent(correlationId: string): HostEvent {
  if (dreamReviews === null) return diagnostic(correlationId, "HOST_FAILURE", "Dream review state is unavailable.");
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
              bundledExtensions: { status: "ready", message: "Reviewed bundled Extension inventory loaded." }
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
      case "access.mode.set":
        stateStore.setAccessMode(command.payload.mode);
        return { ...eventMetadata(command.correlationId), event: "access.mode.changed", payload: { mode: command.payload.mode } };
      case "profile.list":
        return { ...eventMetadata(command.correlationId), event: "profiles.listed", payload: { profiles: stateStore.listModelProfiles() } };
      case "profile.create": {
        const profile = stateStore.createModelProfile({
          name: command.payload.name,
          provider: command.payload.provider,
          model: command.payload.model,
          thinkingLevel: command.payload.thinkingLevel,
          encryptedCredential: credentials.encrypt(command.payload.apiKey)
        });
        return { ...eventMetadata(command.correlationId), event: "profile.created", payload: { profile } };
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
          dreamReviews.createBatch({ promptRevision, profile: toDreamProfileSnapshot(profile), trajectory: currentEligibleDreamTrajectory(), candidates: memoryCandidates.list() });
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
        if (activeTurnByThread.has(command.payload.threadId)) return diagnostic(command.correlationId, "HOST_FAILURE", "Stop the active Turn before deleting its history.");
        if (stateStore.getThread(command.payload.threadId) === undefined) return diagnostic(command.correlationId, "HOST_FAILURE", "Thread not found.");
        const before = dreamReviews?.load().batches ?? [];
        const affectedBatchIds = before.filter((batch) => batch.trajectoryInputs.some((item) => item.threadId === command.payload.threadId) || batch.candidateInputs.some((item) => item.threadId === command.payload.threadId) || batch.carryoverInputs.some((item) => item.threadId === command.payload.threadId)).map((batch) => batch.id);
        const removedCandidateIds = memoryCandidates?.removeByThread(command.payload.threadId) ?? [];
        dreamReviews?.redactThreadSources(command.payload.threadId);
        trajectoryStore.deleteThreadHistory(command.payload.threadId);
        loadedPromptByThread.delete(command.payload.threadId);
        sequenceByThread.set(command.payload.threadId, 0);
        return { ...eventMetadata(command.correlationId, command.payload.threadId), event: "thread.trajectory.deleted", payload: { threadId: command.payload.threadId, removedCandidateIds, affectedBatchIds } };
      }
      case "thread.archive.set": {
        if (command.actor.actorType !== "user") return diagnostic(command.correlationId, "HOST_FAILURE", "Thread archival requires explicit User action.");
        if (activeTurnByThread.has(command.payload.threadId)) return diagnostic(command.correlationId, "HOST_FAILURE", "Stop the active Turn before changing archive state.");
        const thread = stateStore.setThreadArchived(command.payload.threadId, command.payload.archived);
        return { ...eventMetadata(command.correlationId, thread.id), event: "thread.archived", payload: { thread } };
      }
      case "thread.create.unscoped": {
        const thread = stateStore.createUnscopedThread(command.payload.title);
        return { ...eventMetadata(command.correlationId, thread.id), event: "thread.created", payload: { thread } };
      }
      case "thread.create.project": {
        const thread = stateStore.createProjectThread(command.payload.projectId, command.payload.title);
        return { ...eventMetadata(command.correlationId, thread.id), event: "thread.created", payload: { thread } };
      }
      case "thread.profile.select":
        return selectThreadProfile(command.correlationId, command.payload.threadId, command.payload.profileId);
      case "thread.profile.change.resolve":
        return resolveThreadProfileChange(command.correlationId, command.payload);
      case "thread.output.location.choose": {
        if (activeTurnByThread.has(command.payload.threadId)) {
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
        return submitTurn(command.correlationId, command.payload);
      case "thread.compact":
        return compactThread(command.correlationId, command.payload.threadId);
      case "turn.stop": {
        const context = turnContexts.get(command.payload.turnId);
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
  if (run.scope === "project") stateStore!.authorizeProjectProfile(run.projectId, profile.id, profile.provider);
  run = stateStore!.markReflectionRunning(run.id);
  const turnId = randomUUID();
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
  reflectionContexts.set(turnId, context);
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
    profile: { provider: profile.provider, model: profile.model, apiKey: credentials.decrypt(encrypted), thinkingLevel: profile.thinkingLevel },
    resources: { schemaVersion: 1, revisionId: promptRevision.id, systemPrompt: promptRevision.content, appendSystemPrompt: [stageInstructions] },
    extensions: { schemaVersion: 1, revisionId: "bundled-empty-v1", enabled: [] }
  };
  void workerSupervisor!.execute(workerCommand).catch(() => failReflectionExecution(context, {
    kind: "worker", code: "WORKER_EXITED", message: "Agent Worker exited before the Independent Evidence Pass completed.", provider: profile.provider, model: profile.model
  }));
  return { ...eventMetadata(correlationId, run.threadId), event: "reflection.run.updated", payload: { run } };
}

function stopIndependentAssessment(correlationId: string, runId: string): HostEvent {
  const context = [...reflectionContexts.values()].find((candidate) => candidate.runId === runId);
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
  if (activeTurnByThread.has(threadId)) return diagnostic(correlationId, "HOST_FAILURE", "Stop the active Turn before changing its Model Profile.");
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
  if (activeTurnByThread.has(input.threadId)) return diagnostic(correlationId, "HOST_FAILURE", "Stop the active Turn before changing its Model Profile.");

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
  if (activeTurnByThread.has(input.threadId)) {
    return diagnostic(correlationId, "HOST_FAILURE", "This Thread already has an active Turn.");
  }
  const reflectionRun = options.reflectionRun ?? stateStore!.getReflectionRunByThread(input.threadId);
  if (reflectionRun !== undefined && options.reflectionRun === undefined && reflectionRun.status !== "dialogue_active") return diagnostic(correlationId, "HOST_FAILURE", "Complete or explicitly resume the Reflection workflow before continuing its dialogue.");
  const outputIntent = reflectionRun === undefined && detectOutputIntent(input.text);
  const memoryRecallMode = reflectionRun !== undefined ? detectExplicitMemoryRecallIntent(input.text) ? "explicit" : "automatic" : detectExplicitMemoryRecallIntent(input.text) ? "explicit" : detectJudgmentHeavyIntent(input.text) ? "automatic" : "none";
  const effectiveProfileId = reflectionRun?.memoryAwareProfileId ?? thread.activeProfileId;
  const profile = effectiveProfileId === undefined ? undefined : stateStore!.getModelProfile(effectiveProfileId);
  const reflectionOutcomeIntent = reflectionRun !== undefined && detectReflectionOutcomeIntent(input.text);
  const activeCapabilities = reflectionRun === undefined
    ? [...coreCapabilitiesForScope(thread.scope)]
    : thread.scope === "project" ? ["memory_recall", "reflection_evidence_drilldown", "project_state_recall"] : ["memory_recall"];
  if (reflectionOutcomeIntent) activeCapabilities.push("reflection_outcome_propose");
  if (reflectionRun === undefined && detectWebResearchIntent(input.text)) activeCapabilities.push("web_search", "web_fetch");
  if (reflectionRun === undefined && outputIntent) activeCapabilities.push("output.write_text");
  const physical = stateStore!.getPhysicalContext(input.threadId);
  if (physical?.sessionFile !== undefined && !existsSync(physical.sessionFile)) loadedPromptByThread.delete(input.threadId);
  const promptRevision = reflectionRun === undefined ? loadedPromptByThread.get(input.threadId) ?? stateStore!.getActiveSystemPromptRevision() : stateStore!.getSystemPromptRevision(reflectionRun.promptSnapshot.revisionId);
  if (promptRevision === undefined) throw new Error("System Prompt is not initialized");
  const crossesPromptBoundary = !loadedPromptByThread.has(input.threadId);
  const contextHistory = options.contextHistory ?? trajectoryStore!.contextHistory(input.threadId);
  const workerPrompt = options.workerPrompt ?? input.text;
  const promptTelemetry = {
    revisionId: promptRevision.id,
    hash: promptRevision.hash,
    contributions: {
      promptEstimatedTokens: estimateTokens(promptRevision.content),
      toolSchemaEstimatedTokens: activeCapabilities.length === 0 ? 0 : estimateTokens(JSON.stringify(capabilityRegistry!.inventory().filter((item) => activeCapabilities.includes(item.id)).map((item) => item.inputSchema))),
      taskEstimatedTokens: estimateTokens(workerPrompt) + estimateTokens((options.appendSystemPrompt ?? (reflectionRun === undefined ? [] : [MEMORY_AWARE_REFLECTION_INSTRUCTIONS])).join("\n")),
      contextEstimatedTokens: contextHistory.length === 0 ? 0 : estimateTokens(JSON.stringify(contextHistory)),
      recalledStateEstimatedTokens: 0,
      outputReserveEstimatedTokens: 2_048,
      skillEstimatedTokens: 0,
      materialEstimatedTokens: 0
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
    expectedStateVersion: thread.stateVersion,
    promptRevision,
    submittedAtMs: Date.now(),
    recalledStateEstimatedTokens: 0,
    recallBodyBytes: 0,
    ...(reflectionRun === undefined ? {} : { reflectionRunId: reflectionRun.id }),
    ...((options.appendSystemPrompt ?? (reflectionRun === undefined ? [] : [MEMORY_AWARE_REFLECTION_INSTRUCTIONS])).length === 0 ? {} : { appendSystemPrompt: options.appendSystemPrompt ?? [MEMORY_AWARE_REFLECTION_INSTRUCTIONS] }),
    ...(input.retryOfTurnId === undefined ? {} : { retryOfTurnId: input.retryOfTurnId })
  };
  turnContexts.set(turnId, context);
  activeTurnByThread.set(input.threadId, turnId);
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
    estimatedInputTokens: Object.values(promptTelemetry.contributions).reduce((sum, value) => sum + value, 0),
    currentInputTokens: promptTelemetry.contributions.promptEstimatedTokens + promptTelemetry.contributions.toolSchemaEstimatedTokens + promptTelemetry.contributions.taskEstimatedTokens,
    activeCapabilities: [...context.activeCapabilities],
    expectedStateVersion: context.expectedStateVersion,
    executionScope: thread.scope === "project"
      ? { kind: "project", projectId: thread.projectId }
      : { kind: "unscoped", threadId: thread.id },
    prompt: workerPrompt,
    profile: {
      provider: profile.provider,
      model: profile.model,
      apiKey: credentials.decrypt(encrypted),
      thinkingLevel: profile.thinkingLevel
    },
    resources: {
      schemaVersion: 1,
      revisionId: promptRevision.id,
      systemPrompt: promptRevision.content,
      appendSystemPrompt: [...(context.appendSystemPrompt ?? [])]
    },
    extensions: { schemaVersion: 1, revisionId: "bundled-empty-v1", enabled: [] }
  };
  void workerSupervisor!.execute(workerCommand).catch(() => interruptTurn(context, "worker_exit", 0));
  return {
    ...ipcMetadata(submitted),
    event: "turn.accepted",
    payload: { threadId: input.threadId, turnId, text: input.text, ...(input.retryOfTurnId === undefined ? {} : { retryOfTurnId: input.retryOfTurnId }), profile, prompt: promptTelemetry }
  };
}

function compactThread(correlationId: string, threadId: string): HostEvent {
  const thread = stateStore!.getThread(threadId);
  if (thread === undefined) throw new Error("Thread not found");
  if (activeTurnByThread.has(threadId)) return diagnostic(correlationId, "HOST_FAILURE", "Stop the active Turn before compacting this Thread.");
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
    expectedStateVersion: thread.stateVersion,
    promptRevision,
    submittedAtMs: Date.now(),
    recalledStateEstimatedTokens: 0,
    recallBodyBytes: 0,
    compactionOnly: true
  };
  turnContexts.set(turnId, context);
  activeTurnByThread.set(threadId, turnId);
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
    activeCapabilities: [],
    expectedStateVersion: thread.stateVersion,
    executionScope: thread.scope === "project" ? { kind: "project", projectId: thread.projectId } : { kind: "unscoped", threadId },
    prompt: "Manual Thread Compaction",
    profile: { provider: profile.provider, model: profile.model, apiKey: credentials.decrypt(encrypted), thinkingLevel: profile.thinkingLevel },
    resources: { schemaVersion: 1, revisionId: promptRevision.id, systemPrompt: promptRevision.content, appendSystemPrompt: [] },
    extensions: { schemaVersion: 1, revisionId: "bundled-empty-v1", enabled: [] }
  };
  void workerSupervisor!.execute(command).catch(() => {
    finishTurn(context);
    emit(diagnostic(correlationId, "HOST_FAILURE", "Agent Worker exited during Thread compaction."));
  });
  return { ...ipcMetadata(started), event: "thread.compaction.started", payload: { threadId, turnId, reason: "manual" } };
}

function handleWorkerEvent(workerEvent: WorkerEvent): void {
  if (workerEvent.event === "trajectory.acknowledged") {
    stateStore?.acknowledgePhysicalContext(workerEvent.threadId, workerEvent.eventId, workerEvent.sequence);
    return;
  }
  const reflectionContext = reflectionContexts.get(workerEvent.turnId);
  if (reflectionContext !== undefined) {
    void handleReflectionWorkerEvent(reflectionContext, workerEvent);
    return;
  }
  const context = turnContexts.get(workerEvent.turnId);
  if (context === undefined) return;

  if (workerEvent.event === "capability.execution.requested") {
    void processCapabilityRequest(context, workerEvent);
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
    emit({ ...ipcMetadata(record), event: "turn.completed", payload: { threadId: context.threadId, turnId: context.turnId, message: workerEvent.message, profile: context.profile, usage: workerEvent.usage, latencyMs, recalledStateEstimatedTokens, ...(workerEvent.responseId === undefined ? {} : { responseId: workerEvent.responseId }) } });
    return;
  }

  if (workerEvent.event === "turn.interrupted") {
    interruptTurn(context, workerEvent.reason, workerEvent.workerSequence);
    return;
  }

  if (workerEvent.failure.code === "WORKER_EXITED") {
    interruptTurn(context, "worker_exit", workerEvent.workerSequence);
    return;
  }
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
  if (workerEvent.event === "turn.started" || workerEvent.event === "message.delta" || workerEvent.event.startsWith("thread.compaction.")) return;
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
  if (!reflectionContexts.has(context.turnId)) return;
  const current = stateStore!.getReflectionRun(context.runId);
  if (current?.status !== "independent_running") return;
  const run = stateStore!.failIndependentAssessment(context.runId, failure);
  finishReflectionExecution(context);
  emitReflectionRun(context.correlationId, run);
}

function finishReflectionExecution(context: ReflectionExecutionContext): void {
  reflectionContexts.delete(context.turnId);
  workerSupervisor?.retire(context.threadId);
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
    }
  }
  if (result.artifact !== undefined) {
    try {
      stateStore!.recordArtifact(result.artifact);
      const thread = stateStore!.getThread(context.threadId);
      if (thread?.scope === "project") {
        const project = stateStore!.getProject(thread.projectId);
        if (project === undefined) throw new Error("Project not found");
        projectOutput = projectOutputs.record({
          projectId: project.id, projectPath: project.path, artifact: result.artifact,
          profile: { id: context.profile.id, provider: context.profile.provider, model: context.profile.model }, capabilityId: request.capabilityId,
          ...(typeof request.arguments.skillId === "string" ? { skillId: request.arguments.skillId } : {}),
          sourceReferences: Array.isArray(request.arguments.sourceReferences) ? request.arguments.sourceReferences.filter((value): value is string => typeof value === "string") : [],
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
        content: "The file write completed but artifact registration could not be confirmed. Inspect the target before retrying."
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
      activeCapabilityIds: context.activeCapabilities,
      outputIntent: context.outputIntent,
      outputLocation: join(project.path, "outputs")
    };
  }
  return {
    accessMode: stateStore!.getAccessMode(),
    scope: "unscoped",
    stateVersion: thread.stateVersion,
    activeCapabilityIds: context.activeCapabilities,
    outputIntent: context.outputIntent,
    ...(thread.outputLocation === undefined ? {} : { outputLocation: thread.outputLocation })
  };
}

function summarizeCapabilityArguments(arguments_: Record<string, unknown>): Record<string, unknown> {
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
  if (!turnContexts.has(context.turnId)) return;
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
  finishTurn(context);
  if (reason === "worker_exit") loadedPromptByThread.delete(context.threadId);
  emit({ ...ipcMetadata(record), event: "turn.interrupted", payload: { threadId: context.threadId, turnId: context.turnId, partialMessage: record.payload.partialMessage, reason, profile: context.profile } });
}

function finishTurn(context: TurnContext): void {
  for (const [requestId, pending] of capabilityRequests) {
    if (pending.context.turnId !== context.turnId) continue;
    const result = capabilityGateway?.cancel(requestId);
    if (result !== undefined) resolveCapabilityInWorker(context, result);
    capabilityRequests.delete(requestId);
  }
  inflight!.complete(context.turnId);
  turnContexts.delete(context.turnId);
  activeTurnByThread.delete(context.threadId);
}

function toTrajectoryProfile(profile: ModelProfile): TrajectoryProfile {
  return { id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, thinkingLevel: profile.thinkingLevel };
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
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith("http://") || details.url.startsWith("https://")) externalNetworkRequests += 1;
    callback({});
  });
  stateStore = new HostStateStore(join(app.getPath("userData"), "state.db"), {
    failAfterStageValidation: process.env.NODE_ENV === "test" && process.env.VC_AGENT_TEST_MIGRATION_FAIL_AFTER_STAGE === "1"
  });
  const readOnlyRecovery = stateStore.isReadOnlyRecovery;
  if (!readOnlyRecovery) stateStore.recoverInterruptedReflections();
  longTermMemories = new LongTermMemoryStore(join(app.getPath("userData"), "memory", "long-term"));
  if (!readOnlyRecovery) {
    memoryEvolution = new MemoryEvolutionStore(longTermMemories);
    projectMemories = new ProjectMemoryStore(join(app.getPath("userData"), "memory", "project-index"));
    memoryCandidates = new MemoryCandidateStore(join(app.getPath("userData"), "memory", "candidates.jsonl"));
  }
  reflectionOutcomes = new ReflectionOutcomeStore(join(app.getPath("userData"), "memory", "reflection", "outcomes.jsonl"));
  trajectoryStore = new ThreadTrajectoryStore(join(app.getPath("userData"), "threads"), { createRoot: !readOnlyRecovery });
  dreamReviews = new DreamReviewStore(join(app.getPath("userData"), "memory", "dream"), { createRoot: !readOnlyRecovery });
  for (const thread of stateStore.listThreads()) {
    if (!readOnlyRecovery) trajectoryStore.recoverInterruptedTurns(thread.id);
    const lastSequence = trajectoryStore.loadEvents(thread.id).at(-1)?.sequence ?? 0;
    sequenceByThread.set(thread.id, lastSequence);
  }
  if (!readOnlyRecovery) synchronizeDreamSchedulingIndex();
  inflight = new InflightTurnCoordinator(trajectoryStore);
  if (!readOnlyRecovery) stateStore.ensureDefaultSystemPrompt(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT);
  capabilityRegistry = new CapabilityRegistry();
  capabilityRegistry.register(createTextOutputCapability(new TextOutputStore()));
  capabilityRegistry.register(createCapabilityBroker((input, context) => {
    const requested = input.capabilityId === undefined ? undefined : capabilityRegistry?.get(input.capabilityId)?.metadata;
    if (requested === undefined || requested.activationClass !== "ordinary_task" || !requested.allowedScopes.includes(context.request.scope.kind)) return [];
    return [requested.id];
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
        if (scope.kind !== "project") return undefined;
        let parsed = stateStore!.getCurrentParsedMaterial(materialId);
        if (parsed === undefined) {
          const parsedEvent = await parseMaterial(context.request.correlationId, materialId);
          if (parsedEvent.event !== "material.parse.completed") return undefined;
          parsed = stateStore!.getCurrentParsedMaterial(materialId);
        }
        const project = stateStore!.getProject(scope.projectId);
        if (parsed === undefined || project === undefined) return undefined;
        try { return canonicalParseSchema.parse(JSON.parse(readFileSync(join(project.path, parsed.artifact_path), "utf8"))); }
        catch { return undefined; }
      }
    });
    const query = {
      disclosureLevel: input.disclosureLevel,
      ...(input.materialId === undefined ? {} : { materialId: input.materialId }),
      ...(input.blockIds === undefined ? {} : { blockIds: input.blockIds }),
      ...(input.query === undefined ? {} : { query: input.query })
    };
    const envelope = await source.recall(query, { turnId: context.request.turnId, maxItems: input.maxItems, maxChars: input.maxChars, retrievedAt: new Date().toISOString() });
    const body = JSON.stringify(envelope);
    return { body, retrieval: retrievalMetadata(envelope, body) };
  }));
  capabilityRegistry.register(createReflectionEvidenceDrilldownCapability(async (input, context) => {
    const turn = turnContexts.get(context.request.turnId);
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
    const body = JSON.stringify(envelope);
    return { body, retrieval: retrievalMetadata(envelope, body) };
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
    const body = JSON.stringify(envelope);
    return { body, retrieval: retrievalMetadata(envelope, body) };
  }));
  capabilityRegistry.register(createMemoryRecallCapability(async (input, context) => {
    const scope = context.request.scope;
    const turn = turnContexts.get(context.request.turnId);
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
    const body = JSON.stringify(envelope);
    return { body, retrieval: retrievalMetadata(envelope, body) };
  }));
  capabilityRegistry.register(createReflectionOutcomeProposalCapability(async (input, context) => {
    const turn = turnContexts.get(context.request.turnId);
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
    const body = JSON.stringify(envelope);
    return { body, retrieval: retrievalMetadata(envelope, body) };
  }));
  capabilityRegistry.register(createWebFetchCapability(async (input, context) => {
    const envelope = await publicWeb.recall(
      { kind: "fetch", url: input.url },
      { turnId: context.request.turnId, maxItems: 1, maxChars: input.maxChars, retrievedAt: new Date().toISOString() }
    );
    const body = JSON.stringify(envelope);
    return { body, retrieval: retrievalMetadata(envelope, body) };
  }));
  capabilityGateway = new CapabilityGateway(capabilityRegistry);
  utilityJobRunner = new UtilityJobRunner(join(__dirname, "../../../utility-worker/dist/index.js"));
  if (!readOnlyRecovery) {
    for (const project of stateStore.listProjects()) {
      startMaterialWatcher(project.id);
      void refreshProjectInventory(randomUUID(), project.id, false).catch(() => undefined);
    }
  }
  workerSupervisor = new AgentWorkerSupervisor(join(__dirname, "../../../agent-worker/dist/index.js"), handleWorkerEvent);
  ipcMain.handle(COMMAND_CHANNEL, handleCommand);
  mainWindow = createMainWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const context of [...turnContexts.values()]) interruptTurn(context, "application_restart", 0);
  for (const context of [...reflectionContexts.values()]) {
    const run = stateStore?.getReflectionRun(context.runId);
    if (run?.status === "independent_running") stateStore?.interruptIndependentAssessment(context.runId);
    reflectionContexts.delete(context.turnId);
  }
  ipcMain.removeHandler(COMMAND_CHANNEL);
  workerSupervisor?.closeAll();
  utilityJobRunner?.close();
  utilityJobRunner = null;
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
  stateStore?.close();
  stateStore = null;
  projectMemories = null;
  longTermMemories = null;
  memoryCandidates = null;
});
