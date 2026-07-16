import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import {
  IPC_SCHEMA_VERSION,
  hostCommandSchema,
  type ActorRef,
  type CapabilityExecutionRequest,
  type CapabilityExecutionResult,
  type HostEvent,
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
import { CapabilityRegistry, createTextOutputCapability, TextOutputStore } from "@vc-agent/capabilities";
import { CapabilityGateway, detectOutputIntent, estimateTokens, ProjectIdentityStore, SHIPPED_MINIMAL_VC_SYSTEM_PROMPT, type CapabilityAuthorizationSnapshot } from "@vc-agent/host-services";
import { HostStateStore, ThreadTrajectoryStore } from "@vc-agent/persistence";
import { AgentWorkerSupervisor } from "./agent-worker-supervisor.js";
import { InflightTurnCoordinator } from "./inflight-turn-coordinator.js";
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
  readonly activeCapabilities: readonly string[];
  readonly expectedStateVersion: number;
  readonly promptRevision: SystemPromptRevision;
  readonly retryOfTurnId?: string;
}

let mainWindow: BrowserWindow | null = null;
let stateStore: HostStateStore | null = null;
let trajectoryStore: ThreadTrajectoryStore | null = null;
let inflight: InflightTurnCoordinator | null = null;
let workerSupervisor: AgentWorkerSupervisor | null = null;
let capabilityGateway: CapabilityGateway | null = null;
let capabilityRegistry: CapabilityRegistry | null = null;
let externalNetworkRequests = 0;
let shuttingDown = false;
const sequenceByThread = new Map<string, number>();
const turnContexts = new Map<string, TurnContext>();
const activeTurnByThread = new Map<string, string>();
const capabilityRequests = new Map<string, { context: TurnContext; request: CapabilityExecutionRequest }>();
const pendingProjectCollisions = new Map<string, { projectId: string; existingPath: string; selectedPath: string }>();
const loadedPromptByThread = new Map<string, SystemPromptRevision>();
const credentials = new ProtectedCredentialService();
const projectIdentities = new ProjectIdentityStore();

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
    return { ...eventMetadata(correlationId), event: "project.opened", payload: { project } };
  }
  if (resolve(existing.path) === projectPath) {
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

function resolveProjectCollision(
  correlationId: string,
  collisionId: string,
  action: "moved_project" | "project_copy"
): HostEvent {
  const collision = pendingProjectCollisions.get(collisionId);
  pendingProjectCollisions.delete(collisionId);
  if (collision === undefined) return diagnostic(correlationId, "HOST_FAILURE", "The Project Identity Collision is no longer active.");
  if (action === "moved_project") {
    const project = stateStore!.moveProject(collision.projectId, basename(collision.selectedPath), collision.selectedPath);
    return { ...eventMetadata(correlationId), event: "project.opened", payload: { project } };
  }
  const marker = projectIdentities.replaceForCopy(collision.selectedPath);
  const project = stateStore!.registerProject({ id: marker.projectId, displayName: basename(collision.selectedPath), path: collision.selectedPath, createdAt: marker.createdAt });
  return { ...eventMetadata(correlationId), event: "project.opened", payload: { project } };
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
  const activeCapabilities = outputIntent && thread.scope === "unscoped" ? ["output.write_text"] : [];
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
      summary: result.content,
      artifactIds: result.artifact === undefined ? [] : [result.artifact.id]
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
  capabilityGateway = new CapabilityGateway(capabilityRegistry);
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
  workerSupervisor = null;
  stateStore?.close();
  stateStore = null;
});
