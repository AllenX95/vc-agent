import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import {
  IPC_SCHEMA_VERSION,
  hostCommandSchema,
  type ActorRef,
  type HostEvent,
  type ModelProfile,
  type ProvenanceRef,
  type WorkerCommand,
  type WorkerEvent
} from "@vc-agent/contracts";
import { HostStateStore } from "@vc-agent/persistence";
import { AgentWorkerSupervisor } from "./agent-worker-supervisor.js";
import { ProtectedCredentialService } from "./protected-credential-service.js";

const COMMAND_CHANNEL = "vc-agent:command";
const EVENT_CHANNEL = "vc-agent:event";
const HOST_ACTOR = { actorType: "host", actorId: "desktop-host" } as const;
const HOST_PROVENANCE = { producerType: "host", producerId: "desktop-host" } as const;
const AGENT_ACTOR = { actorType: "agent", actorId: "primary-agent" } as const;
const AGENT_PROVENANCE = { producerType: "agent", producerId: "primary-agent" } as const;

interface TurnContext {
  readonly text: string;
  readonly profile: ModelProfile;
  readonly retryOfTurnId?: string;
}

let mainWindow: BrowserWindow | null = null;
let stateStore: HostStateStore | null = null;
let workerSupervisor: AgentWorkerSupervisor | null = null;
let externalNetworkRequests = 0;
const sequenceByThread = new Map<string, number>();
const turnContexts = new Map<string, TurnContext>();
const credentials = new ProtectedCredentialService();

if (process.env.VC_AGENT_USER_DATA_DIR) {
  app.setPath("userData", process.env.VC_AGENT_USER_DATA_DIR);
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

function diagnostic(
  correlationId: string,
  code: "UNSUPPORTED_SCHEMA_VERSION" | "INVALID_COMMAND" | "HOST_FAILURE",
  message: string
): HostEvent {
  return {
    ...eventMetadata(correlationId),
    event: "diagnostic.raised",
    payload: { code, message, recoverable: true }
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
    switch (command.command) {
      case "app.bootstrap": {
        return {
          ...eventMetadata(command.correlationId),
          event: "app.bootstrap.completed",
          payload: stateStore.getBootstrapState(app.getVersion(), {
            ...workerSupervisor.activity,
            externalNetworkRequests
          })
        };
      }
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
      case "thread.list":
        return { ...eventMetadata(command.correlationId), event: "threads.listed", payload: { threads: stateStore.listUnscopedThreads() } };
      case "thread.create.unscoped": {
        const thread = stateStore.createUnscopedThread(command.payload.title);
        return { ...eventMetadata(command.correlationId, thread.id), event: "thread.created", payload: { thread } };
      }
      case "thread.profile.select": {
        const thread = stateStore.selectThreadProfile(command.payload.threadId, command.payload.profileId);
        return { ...eventMetadata(command.correlationId, thread.id), event: "thread.profile.selected", payload: { thread } };
      }
      case "turn.submit":
        return submitTurn(command.correlationId, command.payload);
    }
  } catch {
    return diagnostic(correlationId, "HOST_FAILURE", "The local Host could not complete the command.");
  }
}

function submitTurn(
  correlationId: string,
  input: { threadId: string; text: string; retryOfTurnId?: string | undefined }
): HostEvent {
  const turnId = randomUUID();
  const thread = stateStore?.getUnscopedThread(input.threadId);
  const profile = thread?.activeProfileId === undefined ? undefined : stateStore?.getModelProfile(thread.activeProfileId);
  if (thread === undefined || profile === undefined) {
    return {
      ...eventMetadata(correlationId, input.threadId),
      event: "turn.failed",
      payload: {
        threadId: input.threadId,
        turnId,
        text: input.text,
        ...(input.retryOfTurnId === undefined ? {} : { retryOfTurnId: input.retryOfTurnId }),
        failure: {
          kind: "configuration",
          code: "MODEL_PROFILE_NOT_CONFIGURED",
          message: "Model Profile not configured"
        }
      }
    };
  }
  const encrypted = stateStore?.getEncryptedCredential(profile.credentialRef);
  if (encrypted === undefined) throw new Error("Credential reference is unavailable");
  const context: TurnContext = {
    text: input.text,
    profile,
    ...(input.retryOfTurnId === undefined ? {} : { retryOfTurnId: input.retryOfTurnId })
  };
  turnContexts.set(turnId, context);
  const workerCommand: WorkerCommand = {
    schemaVersion: IPC_SCHEMA_VERSION,
    command: "turn.execute",
    commandId: randomUUID(),
    correlationId,
    threadId: input.threadId,
    turnId,
    cwd: app.getPath("userData"),
    prompt: input.text,
    profile: {
      provider: profile.provider,
      model: profile.model,
      apiKey: credentials.decrypt(encrypted),
      thinkingLevel: profile.thinkingLevel
    },
    resources: {
      schemaVersion: 1,
      revisionId: "foundation-f2-v1",
      systemPrompt: "You are vc-agent. Answer the user's request directly and clearly.",
      appendSystemPrompt: []
    },
    extensions: { schemaVersion: 1, revisionId: "bundled-empty-v1", enabled: [] }
  };
  void workerSupervisor?.execute(workerCommand).catch(() => {
    handleWorkerEvent({
      schemaVersion: 1,
      correlationId,
      threadId: input.threadId,
      turnId,
      event: "turn.failed",
      failure: {
        kind: "worker",
        code: "WORKER_START_FAILED",
        message: "Agent Worker could not be started.",
        provider: profile.provider,
        model: profile.model
      }
    });
  });
  return {
    ...eventMetadata(correlationId, input.threadId),
    event: "turn.accepted",
    payload: {
      threadId: input.threadId,
      turnId,
      text: input.text,
      ...(input.retryOfTurnId === undefined ? {} : { retryOfTurnId: input.retryOfTurnId }),
      profile
    }
  };
}

function handleWorkerEvent(workerEvent: WorkerEvent): void {
  const context = turnContexts.get(workerEvent.turnId);
  if (context === undefined || mainWindow === null) return;
  let hostEvent: HostEvent;
  if (workerEvent.event === "turn.started") {
    hostEvent = {
      ...eventMetadata(workerEvent.correlationId, workerEvent.threadId, AGENT_ACTOR, AGENT_PROVENANCE),
      event: "turn.started",
      payload: { threadId: workerEvent.threadId, turnId: workerEvent.turnId }
    };
  } else if (workerEvent.event === "message.delta") {
    hostEvent = {
      ...eventMetadata(workerEvent.correlationId, workerEvent.threadId, AGENT_ACTOR, AGENT_PROVENANCE),
      event: "message.delta",
      payload: { threadId: workerEvent.threadId, turnId: workerEvent.turnId, delta: workerEvent.delta }
    };
  } else if (workerEvent.event === "turn.completed") {
    hostEvent = {
      ...eventMetadata(workerEvent.correlationId, workerEvent.threadId, AGENT_ACTOR, AGENT_PROVENANCE),
      event: "turn.completed",
      payload: {
        threadId: workerEvent.threadId,
        turnId: workerEvent.turnId,
        message: workerEvent.message,
        profile: context.profile,
        usage: workerEvent.usage,
        ...(workerEvent.responseId === undefined ? {} : { responseId: workerEvent.responseId })
      }
    };
    turnContexts.delete(workerEvent.turnId);
  } else {
    hostEvent = {
      ...eventMetadata(workerEvent.correlationId, workerEvent.threadId, AGENT_ACTOR, AGENT_PROVENANCE),
      event: "turn.failed",
      payload: {
        threadId: workerEvent.threadId,
        turnId: workerEvent.turnId,
        text: context.text,
        ...(context.retryOfTurnId === undefined ? {} : { retryOfTurnId: context.retryOfTurnId }),
        profile: context.profile,
        failure: workerEvent.failure
      }
    };
    turnContexts.delete(workerEvent.turnId);
  }
  mainWindow.webContents.send(EVENT_CHANNEL, hostEvent);
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
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
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
  workerSupervisor = new AgentWorkerSupervisor(join(__dirname, "../../../agent-worker/dist/index.js"), handleWorkerEvent);
  ipcMain.handle(COMMAND_CHANNEL, handleCommand);
  mainWindow = createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
  });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  ipcMain.removeHandler(COMMAND_CHANNEL);
  workerSupervisor?.closeAll();
  workerSupervisor = null;
  stateStore?.close();
  stateStore = null;
});
