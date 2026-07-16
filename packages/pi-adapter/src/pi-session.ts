import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { InMemoryCredentialStore, type AssistantMessage, type Message, type Model, type Usage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CapabilityExecutionResult, PhysicalContextHistoryItem } from "@vc-agent/contracts";
import {
  SnapshotResourceLoader,
  type ExtensionInventorySnapshot,
  type RuntimeResourceSnapshot
} from "./snapshot-resource-loader.js";

export interface PiSessionProfile {
  readonly provider: string;
  readonly model: string;
  readonly apiKey: string;
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface PiSessionConfig {
  readonly cwd: string;
  readonly threadDirectory: string;
  readonly previousSessionFile?: string;
  readonly hostHighWater?: { readonly eventId: string; readonly sequence: number };
  readonly contextHistory: readonly PhysicalContextHistoryItem[];
  readonly profile: PiSessionProfile;
  readonly resources: RuntimeResourceSnapshot;
  readonly extensions: ExtensionInventorySnapshot;
  readonly capabilityProxy?: (
    toolCallId: string,
    capabilityId: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<CapabilityExecutionResult>;
}

export type PiSessionEvent =
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "completed"; readonly message: string; readonly usage: Usage; readonly responseId?: string; readonly piEntryId?: string }
  | { readonly type: "failed"; readonly error: unknown };

export interface PiSessionHandle {
  readonly provider: string;
  readonly model: string;
  readonly activeTools: readonly string[];
  readonly sessionFile: string;
  readonly reconciliation: PiSessionReconciliation;
  readonly retainedTurnCount: number;
  submit(prompt: string, options?: { readonly activeCapabilities?: readonly string[] }): Promise<void>;
  abort(): Promise<void>;
  acknowledge(eventId: string, sequence: number): string;
  dispose(): void;
}

export type PiSessionReconciliation = "resumed" | "missing" | "host_ahead" | "pi_ahead" | "irreconcilable";

export interface PiModelReference {
  readonly provider: string;
  readonly model: string;
}

export async function listKnownPiModels(): Promise<readonly PiModelReference[]> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false
  });
  return runtime.getModels().map((model) => ({ provider: model.provider, model: model.id }));
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export async function createPiSession(
  config: PiSessionConfig,
  onEvent: (event: PiSessionEvent) => void
): Promise<PiSessionHandle> {
  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false
  });
  return createPiSessionUsingRuntime(config, onEvent, modelRuntime);
}

export async function createPiSessionUsingRuntime(
  config: PiSessionConfig,
  onEvent: (event: PiSessionEvent) => void,
  modelRuntime: ModelRuntime
): Promise<PiSessionHandle> {
  await modelRuntime.setRuntimeApiKey(config.profile.provider, config.profile.apiKey);

  const model = modelRuntime.getModel(config.profile.provider, config.profile.model);
  if (model === undefined) {
    throw new Error(`Model not found: ${config.profile.provider}/${config.profile.model}`);
  }

  const resourceLoader = new SnapshotResourceLoader({
    cwd: config.cwd,
    resources: config.resources,
    extensions: config.extensions
  });
  await resourceLoader.reload();

  const settingsManager = SettingsManager.inMemory(
    {
      retry: { enabled: false, maxRetries: 0 },
      enableAnalytics: false,
      enableInstallTelemetry: false
    },
    { projectTrusted: false }
  );
  const physicalContext = reconcilePhysicalContext(config, model);
  const customTools = config.capabilityProxy === undefined ? [] : [createTextOutputProxy(config.capabilityProxy)];
  const { session } = await createAgentSession({
    cwd: config.cwd,
    modelRuntime,
    model,
    thinkingLevel: config.profile.thinkingLevel ?? "off",
    noTools: "builtin",
    customTools,
    resourceLoader,
    sessionManager: physicalContext.sessionManager,
    settingsManager
  });

  let failureEmitted = false;
  subscribeToSession(session, (event) => {
    if (event.type === "failed") failureEmitted = true;
    onEvent(event);
  });
  return {
    provider: model.provider,
    model: model.id,
    activeTools: Object.freeze(session.getActiveToolNames()),
    sessionFile: session.sessionFile ?? physicalContext.sessionManager.getSessionFile() ?? "",
    reconciliation: physicalContext.reconciliation,
    retainedTurnCount: config.contextHistory.length,
    submit: async (prompt, options) => {
      const activeCapabilities = options?.activeCapabilities ?? [];
      session.setActiveToolsByName(activeCapabilities.filter((id) => id === "output.write_text"));
      failureEmitted = false;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        void session.abort();
      }, 15_000);
      try {
        await session.prompt(prompt, { expandPromptTemplates: false });
        if (timedOut) throw new Error("Provider request timed out after 15 seconds");
      } catch (error) {
        if (!failureEmitted) onEvent({ type: "failed", error });
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    abort: () => session.abort(),
    acknowledge: (eventId, sequence) => session.sessionManager.appendCustomEntry("vc-agent.trajectory-high-water", { eventId, sequence }),
    dispose: () => session.dispose()
  };
}

function createTextOutputProxy(
  proxy: NonNullable<PiSessionConfig["capabilityProxy"]>
) {
  return defineTool({
    name: "output.write_text",
    label: "Write text output",
    description: "Create a requested text deliverable in the current Thread's authorized Output Location. Use only when the User explicitly requested a file or document.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative output filename or path" }),
      content: Type.String({ description: "Complete UTF-8 text content" }),
      mediaType: Type.Optional(Type.String({ description: "Format-neutral media type" })),
      replaceExisting: Type.Optional(Type.Boolean({ description: "Whether replacement is explicitly requested" }))
    }),
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => {
      const result = await proxy(toolCallId, "output.write_text", params, signal);
      return {
        content: [{ type: "text" as const, text: result.content }],
        details: { requestId: result.requestId, status: result.status, artifact: result.artifact }
      };
    }
  });
}

function reconcilePhysicalContext(config: PiSessionConfig, activeModel: Model<any>): {
  sessionManager: SessionManager;
  reconciliation: PiSessionReconciliation;
} {
  let reconciliation: PiSessionReconciliation = "missing";
  if (config.previousSessionFile !== undefined) {
    const threadRoot = `${resolve(config.threadDirectory)}${sep}`;
    const candidate = resolve(config.previousSessionFile);
    if (!candidate.startsWith(threadRoot) || !existsSync(candidate)) {
      reconciliation = "missing";
    } else {
      try {
        const existing = SessionManager.open(candidate, resolve(config.threadDirectory, "pi"), config.cwd);
        const entries = existing.getEntries();
        const marks = entries.filter((entry) => entry.type === "custom" && entry.customType === "vc-agent.trajectory-high-water");
        const mark = marks.at(-1);
        const data = mark?.type === "custom" && typeof mark.data === "object" && mark.data !== null
          ? mark.data as { eventId?: unknown; sequence?: unknown }
          : undefined;
        const piHighWater = typeof data?.eventId === "string" && typeof data.sequence === "number"
          ? { eventId: data.eventId, sequence: data.sequence }
          : undefined;
        if (
          config.hostHighWater !== undefined &&
          piHighWater?.eventId === config.hostHighWater.eventId &&
          piHighWater.sequence === config.hostHighWater.sequence &&
          existing.getLeafId() === mark?.id
        ) {
          return { sessionManager: existing, reconciliation: "resumed" };
        }
        if (piHighWater === undefined && config.hostHighWater !== undefined) reconciliation = "host_ahead";
        else if (piHighWater !== undefined && config.hostHighWater === undefined) reconciliation = "pi_ahead";
        else if (piHighWater !== undefined && config.hostHighWater !== undefined) {
          reconciliation = piHighWater.sequence > config.hostHighWater.sequence ? "pi_ahead" : "host_ahead";
        } else if (entries.length > 0) reconciliation = "pi_ahead";
      } catch {
        reconciliation = "irreconcilable";
      }
    }
  }

  const sessionManager = SessionManager.create(config.cwd, resolve(config.threadDirectory, "pi"));
  appendRetainedHistory(sessionManager, config.contextHistory, activeModel);
  if (config.hostHighWater !== undefined) {
    sessionManager.appendCustomEntry("vc-agent.trajectory-high-water", config.hostHighWater);
  } else {
    sessionManager.appendCustomEntry("vc-agent.physical-context", { schemaVersion: 1 });
  }
  return { sessionManager, reconciliation };
}

function appendRetainedHistory(
  sessionManager: SessionManager,
  history: readonly PhysicalContextHistoryItem[],
  activeModel: Model<any>
): void {
  for (const item of history) {
    sessionManager.appendMessage({ role: "user", content: item.user, timestamp: Date.now() });
    if (item.status === "interrupted") {
      sessionManager.appendCustomMessageEntry(
        "vc-agent.interrupted-visible-context",
        `[Interrupted assistant response retained for context]\n${item.assistant}`,
        false
      );
      continue;
    }
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: item.assistant }],
      api: activeModel.api,
      provider: item.profile?.provider ?? activeModel.provider,
      model: item.profile?.model ?? activeModel.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now()
    };
    sessionManager.appendMessage(message as Message);
  }
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function subscribeToSession(session: AgentSession, onEvent: (event: PiSessionEvent) => void): void {
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      onEvent({ type: "text_delta", delta: event.assistantMessageEvent.delta });
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        onEvent({ type: "failed", error: new Error(event.message.errorMessage ?? `Provider stopped: ${event.message.stopReason}`) });
        return;
      }
      const completed: PiSessionEvent = {
        type: "completed",
        message: assistantText(event.message),
        usage: event.message.usage,
        ...(event.message.responseId === undefined ? {} : { responseId: event.message.responseId })
      };
      onEvent(completed);
    }
  });
}
