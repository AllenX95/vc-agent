import type { VcAgentBridge } from "@vc-agent/contracts";

declare global {
  interface Window {
    vcAgent: VcAgentBridge;
  }
}

export {};
