import { contextBridge, ipcRenderer } from "electron";
import type { HostEvent, VcAgentBridge } from "@vc-agent/contracts";

const COMMAND_CHANNEL = "vc-agent:command";
const EVENT_CHANNEL = "vc-agent:event";

const bridge: VcAgentBridge = {
  invoke: (command) => ipcRenderer.invoke(COMMAND_CHANNEL, command) as Promise<HostEvent>,
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: HostEvent) => listener(payload);
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler);
  }
};

contextBridge.exposeInMainWorld("vcAgent", bridge);
