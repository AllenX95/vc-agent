import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import {
  IPC_SCHEMA_VERSION,
  canonicalParseSchema,
  hostCommandSchema,
  type ActorRef,
  type CapabilityExecutionRequest,
  type CapabilityExecutionResult,
  type HostEvent,
  type MaterialInventoryItem,
  type ModelProfile,
  type ProvenanceRef,
  type ProviderFailure,
  type SystemPromptRevision,
  type Thread,
  type TrajectoryEvent,
  type TrajectoryProfile,
  type WorkerCommand,
  type WorkerEvent
} from "@vc-agent/contracts";
import { CapabilityRegistry, coreCapabilitiesForScope, createCapabilityBroker, createMaterialRecallCapability, createProjectStateRecallCapability, createTextOutputCapability, createUnavailableCoreRecallCapability, createWebFetchCapability, createWebSearchCapability, TextOutputStore } from "@vc-agent/capabilities";
import { CapabilityGateway, detectOutputIntent, detectWebResearchIntent, estimateTokens, expectedParserIdentity, inventoryProjectFiles, MaterialRecallSource, ProjectContextRecallSource, ProjectContextStore, ProjectIdentityStore, PublicWebRecallSource, retrievalMetadata, retrievalTrajectorySummary, SHIPPED_MINIMAL_VC_SYSTEM_PROMPT, type CapabilityAuthorizationSnapshot } from "@vc-agent/host-services";
import { HostStateStore, ThreadTrajectoryStore } from "@vc-agent/persistence";
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

interface TurnContext {
  readonly correlationId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly text: string;
  readonly profile: ModelProfile;
  readonly outputIntent: boolean;
  readonly activeCapabilities: string[];
  readonly expectedStateVersion: number;
  readonly promptRevision: SystemPromptRevision;
  readonly retryOfTurnId?: string;
  readonly compactionOnly?: true;
}

let mainWindow: BrowserWindow | null = null;
let stateStore: HostStateStore | null = null;
let trajectoryStore: ThreadTrajectoryStore | null = null;
let inflight: InflightTurnCoordinator | null = null;
let workerSupervisor: AgentWorkerSupervisor | null = null;
let capabilityGateway: CapabilityGateway | null = null;
let utilityJobRunner: UtilityJobRunner | null = null;
let capabilityRegistry: CapabilityRegistry | null = null;
let externalNetworkRequests = 0;
let shuttingDown = false;
const sequenceByThread = new Map<string, number>();
const turnContexts = new Map<string, TurnContext>();
const activeTurnByThread = new Map<string, string>();
const capabilityRequests = new Map<string, { context: TurnContext; request: CapabilityExecutionRequest }>();
const pendingProjectCollisions = new Map<string, { projectId: string; existingPath: string; selectedPath: string }>();
const loadedPromptByThread = new Map<string, SystemPromptRevision>();
const materialWatchers = new Map<string, { path: string; watcher: FSWatcher; timer?: ReturnType<typeof setTimeout>; contextTimer?: ReturnType<typeof setTimeout> }>();
const credentials = new ProtectedCredentialService();
const projectIdentities = new ProjectIdentityStore();
const projectContexts = new ProjectContextStore();
const ownProjectContextWrites = new Map<string, string>();

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
  code: "UNSUPPORTED_SCHEMA_VERSION" | "INVALID_COMMAND" | "HOST_FAILURE",
  message: string
): HostEvent {
  return { ...eventMetadata(correlationId), event: "diagnostic.raised", payload: { code, message, recoverable: true } };
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
  if (stateStore === null || trajectoryStore === null || inflight === null || workerSupervisor === null || capabilityGateway === null) {
    return diagnostic(correlationId, "HOST_FAILURE", "The local Host is not initialized.");
  }

  try {
    const command = parsed.data;
    switch (command.command) {
      case "app.bootstrap":
        return {
          ...eventMetadata(command.correlationId),
          event: "app.bootstrap.completed",
          payload: stateStore.getBootstrapState(app.getVersion(), { ...workerSupervisor.activity, externalNetworkRequests })
        };
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

function startMaterialWatcher(projectId: string): void {
  const project = stateStore!.getProject(projectId);
  if (project === undefined) return;
  const current = materialWatchers.get(projectId);
  if (current !== undefined) {
    if (current.path === project.path) return;
    current.watcher.close();
    if (current.timer !== undefined) clearTimeout(current.timer);
    if (current.contextTimer !== undefined) clearTimeout(current.contextTimer);
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
  input: { threadId: string; text: string; retryOfTurnId?: string | undefined }
): HostEvent {
  const turnId = randomUUID();
  const thread = stateStore!.getThread(input.threadId);
  if (thread === undefined) throw new Error("Thread not found");
  if (activeTurnByThread.has(input.threadId)) {
    return diagnostic(correlationId, "HOST_FAILURE", "This Thread already has an active Turn.");
  }
  const outputIntent = detectOutputIntent(input.text);
  const profile = thread.activeProfileId === undefined ? undefined : stateStore!.getModelProfile(thread.activeProfileId);
  const activeCapabilities = [...coreCapabilitiesForScope(thread.scope)];
  if (detectWebResearchIntent(input.text)) activeCapabilities.push("web_search", "web_fetch");
  if (outputIntent && thread.scope === "unscoped") activeCapabilities.push("output.write_text");
  const physical = stateStore!.getPhysicalContext(input.threadId);
  if (physical?.sessionFile !== undefined && !existsSync(physical.sessionFile)) loadedPromptByThread.delete(input.threadId);
  const promptRevision = loadedPromptByThread.get(input.threadId) ?? stateStore!.getActiveSystemPromptRevision();
  if (promptRevision === undefined) throw new Error("System Prompt is not initialized");
  const crossesPromptBoundary = !loadedPromptByThread.has(input.threadId);
  const contextHistory = trajectoryStore!.contextHistory(input.threadId);
  const promptTelemetry = {
    revisionId: promptRevision.id,
    hash: promptRevision.hash,
    contributions: {
      promptEstimatedTokens: estimateTokens(promptRevision.content),
      toolSchemaEstimatedTokens: activeCapabilities.length === 0 ? 0 : estimateTokens(JSON.stringify(capabilityRegistry!.inventory().filter((item) => activeCapabilities.includes(item.id)).map((item) => item.inputSchema))),
      taskEstimatedTokens: estimateTokens(input.text),
      contextEstimatedTokens: contextHistory.length === 0 ? 0 : estimateTokens(JSON.stringify(contextHistory)),
      recalledStateEstimatedTokens: 0,
      skillEstimatedTokens: 0,
      materialEstimatedTokens: 0
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
    activeCapabilities,
    expectedStateVersion: thread.stateVersion,
    promptRevision,
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
    prompt: input.text,
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
      appendSystemPrompt: []
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
    activeCapabilities: [],
    expectedStateVersion: thread.stateVersion,
    promptRevision,
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
    const record: TrajectoryEvent = {
      ...trajectoryMetadata(context.correlationId, context.threadId, context.turnId, AGENT_ACTOR, AGENT_PROVENANCE),
      event: "turn.completed",
      payload: {
        message: workerEvent.message,
        profile: toTrajectoryProfile(context.profile),
        usage: workerEvent.usage,
        ...(workerEvent.responseId === undefined ? {} : { responseId: workerEvent.responseId }),
        ...(workerEvent.piEntryId === undefined ? {} : { piEntryId: workerEvent.piEntryId })
      }
    };
    trajectoryStore!.append(record);
    finishTurn(context);
    acknowledgeTrajectory(context, record);
    emit({ ...ipcMetadata(record), event: "turn.completed", payload: { threadId: context.threadId, turnId: context.turnId, message: workerEvent.message, profile: context.profile, usage: workerEvent.usage, ...(workerEvent.responseId === undefined ? {} : { responseId: workerEvent.responseId }) } });
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
  finishTurn(context);
  acknowledgeTrajectory(context, record);
  emit({ ...ipcMetadata(record), event: "turn.failed", payload: { threadId: context.threadId, turnId: context.turnId, text: context.text, ...(context.retryOfTurnId === undefined ? {} : { retryOfTurnId: context.retryOfTurnId }), profile: context.profile, failure: workerEvent.failure } });
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
  if (result.activatedCapabilities !== undefined) {
    for (const capabilityId of result.activatedCapabilities) {
      if (!context.activeCapabilities.includes(capabilityId)) context.activeCapabilities.push(capabilityId);
    }
  }
  if (result.artifact !== undefined) {
    try {
      stateStore!.recordArtifact(result.artifact);
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
    return {
      accessMode: stateStore!.getAccessMode(),
      scope: "project",
      stateVersion: thread.stateVersion,
      activeCapabilityIds: context.activeCapabilities,
      outputIntent: context.outputIntent
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
  stateStore = new HostStateStore(join(app.getPath("userData"), "state.db"));
  trajectoryStore = new ThreadTrajectoryStore(join(app.getPath("userData"), "threads"));
  for (const thread of stateStore.listThreads()) {
    trajectoryStore.recoverInterruptedTurns(thread.id);
    const lastSequence = trajectoryStore.loadEvents(thread.id).at(-1)?.sequence ?? 0;
    sequenceByThread.set(thread.id, lastSequence);
  }
  inflight = new InflightTurnCoordinator(trajectoryStore);
  stateStore.ensureDefaultSystemPrompt(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT);
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
  capabilityRegistry.register(createUnavailableCoreRecallCapability("memory_recall", ["unscoped", "project"]));
  const publicWeb = new PublicWebRecallSource();
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
  for (const project of stateStore.listProjects()) {
    startMaterialWatcher(project.id);
    void refreshProjectInventory(randomUUID(), project.id, false).catch(() => undefined);
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
  ipcMain.removeHandler(COMMAND_CHANNEL);
  workerSupervisor?.closeAll();
  utilityJobRunner?.close();
  utilityJobRunner = null;
  for (const state of materialWatchers.values()) {
    state.watcher.close();
    if (state.timer !== undefined) clearTimeout(state.timer);
    if (state.contextTimer !== undefined) clearTimeout(state.contextTimer);
  }
  materialWatchers.clear();
  workerSupervisor = null;
  stateStore?.close();
  stateStore = null;
});
