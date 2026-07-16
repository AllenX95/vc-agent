import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import {
  IPC_SCHEMA_VERSION,
  hostCommandSchema,
  type HostEvent
} from "@vc-agent/contracts";
import { HostStateStore } from "@vc-agent/persistence";

const COMMAND_CHANNEL = "vc-agent:command";
const EVENT_CHANNEL = "vc-agent:event";
const HOST_ACTOR = { actorType: "host", actorId: "desktop-host" } as const;
const HOST_PROVENANCE = { producerType: "host", producerId: "desktop-host" } as const;

let mainWindow: BrowserWindow | null = null;
let stateStore: HostStateStore | null = null;
let externalNetworkRequests = 0;

function eventMetadata(correlationId: string) {
  return {
    schemaVersion: IPC_SCHEMA_VERSION,
    eventId: randomUUID(),
    correlationId,
    sequence: 0,
    actor: HOST_ACTOR,
    provenance: HOST_PROVENANCE,
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

function handleCommand(event: IpcMainInvokeEvent, rawCommand: unknown): HostEvent {
  const correlationId =
    typeof rawCommand === "object" && rawCommand !== null && "correlationId" in rawCommand
      ? String(rawCommand.correlationId)
      : randomUUID();

  const rawVersion =
    typeof rawCommand === "object" && rawCommand !== null && "schemaVersion" in rawCommand
      ? rawCommand.schemaVersion
      : undefined;

  if (rawVersion !== IPC_SCHEMA_VERSION) {
    const result = diagnostic(
      correlationId,
      "UNSUPPORTED_SCHEMA_VERSION",
      `Unsupported IPC schema version: ${String(rawVersion)}`
    );
    event.sender.send(EVENT_CHANNEL, result);
    return result;
  }

  const parsed = hostCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    const result = diagnostic(correlationId, "INVALID_COMMAND", "The Host rejected an invalid command envelope.");
    event.sender.send(EVENT_CHANNEL, result);
    return result;
  }

  try {
    if (parsed.data.command === "app.bootstrap") {
      if (stateStore === null) {
        throw new Error("Host state is not initialized");
      }
      return {
        ...eventMetadata(parsed.data.correlationId),
        event: "app.bootstrap.completed",
        payload: stateStore.getBootstrapState(app.getVersion(), externalNetworkRequests)
      };
    }
  } catch {
    const result = diagnostic(correlationId, "HOST_FAILURE", "The local Host could not complete the command.");
    event.sender.send(EVENT_CHANNEL, result);
    return result;
  }

  return diagnostic(correlationId, "INVALID_COMMAND", "The Host does not support this command.");
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

  window.loadFile(join(__dirname, "../renderer/index.html"));
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    mainWindow = null;
  });
  return window;
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith("http://") || details.url.startsWith("https://")) {
      externalNetworkRequests += 1;
    }
    callback({});
  });

  stateStore = new HostStateStore(join(app.getPath("userData"), "state.db"));
  ipcMain.handle(COMMAND_CHANNEL, handleCommand);
  mainWindow = createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  ipcMain.removeHandler(COMMAND_CHANNEL);
  stateStore?.close();
  stateStore = null;
});
