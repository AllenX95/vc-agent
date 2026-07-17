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
  | { readonly type: "compaction_started"; readonly reason: "manual" | "threshold" | "overflow" }
  | { readonly type: "compaction_completed"; readonly reason: "manual" | "threshold" | "overflow"; readonly tokensBefore: number; readonly estimatedTokensAfter?: number }
  | { readonly type: "compaction_failed"; readonly reason: "manual" | "threshold" | "overflow"; readonly message: string }
  | { readonly type: "failed"; readonly error: unknown };

export interface PiSessionHandle {
  readonly provider: string;
  readonly model: string;
  readonly activeTools: readonly string[];
  readonly sessionFile: string;
  readonly reconciliation: PiSessionReconciliation;
  readonly retainedTurnCount: number;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  submit(prompt: string, options?: { readonly activeCapabilities?: readonly string[] }): Promise<void>;
  compact(reason?: "manual" | "threshold"): Promise<void>;
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
  let sessionRef: AgentSession | undefined;
  const customTools = config.capabilityProxy === undefined ? [] : createCapabilityProxies(config.capabilityProxy, () => sessionRef);
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
  sessionRef = session;
  session.setAutoCompactionEnabled(true);

  let failureEmitted = false;
  let compactionReasonOverride: "manual" | "threshold" | undefined;
  subscribeToSession(session, (event) => {
    if (event.type === "failed") failureEmitted = true;
    if (
      compactionReasonOverride !== undefined &&
      (event.type === "compaction_started" || event.type === "compaction_completed" || event.type === "compaction_failed")
    ) {
      onEvent({ ...event, reason: compactionReasonOverride });
    } else onEvent(event);
  });
  return {
    provider: model.provider,
    model: model.id,
    activeTools: Object.freeze(session.getActiveToolNames()),
    sessionFile: session.sessionFile ?? physicalContext.sessionManager.getSessionFile() ?? "",
    reconciliation: physicalContext.reconciliation,
    retainedTurnCount: config.contextHistory.length,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    submit: async (prompt, options) => {
      const activeCapabilities = options?.activeCapabilities ?? [];
      session.setActiveToolsByName([...activeCapabilities]);
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
    compact: async (reason = "manual") => {
      compactionReasonOverride = reason;
      try { await session.compact(); }
      finally { compactionReasonOverride = undefined; }
    },
    abort: () => session.abort(),
    acknowledge: (eventId, sequence) => session.sessionManager.appendCustomEntry("vc-agent.trajectory-high-water", { eventId, sequence }),
    dispose: () => session.dispose()
  };
}

function createCapabilityProxies(
  proxy: NonNullable<PiSessionConfig["capabilityProxy"]>,
  session: () => AgentSession | undefined
) {
  const capabilityRequest = defineTool({
    name: "capability_request",
    label: "Request capability",
    description: "Request an allowed capability for this Turn. This neither executes it nor grants permission.",
    parameters: Type.Object({ need: Type.String(), capabilityId: Type.Optional(Type.String()) }),
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => {
      const result = await proxy(toolCallId, "capability_request", params, signal);
      if (result.activatedCapabilities !== undefined) {
        const active = session()?.getActiveToolNames() ?? [];
        session()?.setActiveToolsByName([...new Set([...active, ...result.activatedCapabilities])]);
      }
      return toolResult(result);
    }
  });
  const materialRecall = defineTool({
    name: "material_recall",
    label: "Recall material",
    description: "Start with cards or outline, then request bounded source-referenced excerpts. Never claim omitted blocks were read.",
    parameters: Type.Object({
      disclosureLevel: Type.Union([Type.Literal("cards"), Type.Literal("outline"), Type.Literal("excerpt"), Type.Literal("full")]),
      materialId: Type.Optional(Type.String()),
      blockIds: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
      query: Type.Optional(Type.String()),
      maxItems: Type.Optional(Type.Number()),
      maxChars: Type.Optional(Type.Number())
    }),
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => toolResult(await proxy(toolCallId, "material_recall", params, signal))
  });
  const projectStateRecall = defineTool({
    name: "project_state_recall",
    label: "Recall project state",
    description: "Recall bounded Project Context or Project Memory sections without reading other source classes.",
    parameters: Type.Object({
      source: Type.Optional(Type.Union([Type.Literal("project_context"), Type.Literal("project_memory")])),
      sectionIds: Type.Optional(Type.Array(Type.String(), { maxItems: 6 })),
      query: Type.Optional(Type.String()),
      maxItems: Type.Optional(Type.Number()),
      maxChars: Type.Optional(Type.Number())
    }),
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => toolResult(await proxy(toolCallId, "project_state_recall", params, signal))
  });
  const unavailable = (name: "memory_recall") => defineTool({
    name,
    label: name === "memory_recall" ? "Recall memory" : "Recall project state",
    description: `Recall bounded ${name === "memory_recall" ? "Long-term Memory" : "Project Context or Project Memory"} without reading other source classes.`,
    parameters: Type.Object({ query: Type.Optional(Type.String()) }),
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => toolResult(await proxy(toolCallId, name, params, signal))
  });
  const webSearch = defineTool({
    name: "web_search",
    label: "Search public web",
    description: "Search the current public web. Results are bounded, source-referenced, and transient.",
    parameters: Type.Object({ query: Type.String(), maxResults: Type.Optional(Type.Number()), maxChars: Type.Optional(Type.Number()) }),
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => toolResult(await proxy(toolCallId, "web_search", params, signal))
  });
  const webFetch = defineTool({
    name: "web_fetch",
    label: "Fetch public URL",
    description: "Fetch and extract a bounded public page or PDF without login, writes, or browser state.",
    parameters: Type.Object({ url: Type.String(), maxChars: Type.Optional(Type.Number()) }),
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => toolResult(await proxy(toolCallId, "web_fetch", params, signal))
  });
  return [capabilityRequest, materialRecall, projectStateRecall, unavailable("memory_recall"), webSearch, webFetch, createTextOutputProxy(proxy)];
}

function toolResult(result: CapabilityExecutionResult) {
  return {
    content: [{ type: "text" as const, text: result.content }],
    details: { requestId: result.requestId, status: result.status, code: result.code, retrieval: result.retrieval, activatedCapabilities: result.activatedCapabilities, artifact: result.artifact }
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
      return toolResult(result);
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
    if (item.contextReferences !== undefined && item.contextReferences.length > 0) {
      sessionManager.appendCustomMessageEntry(
        "vc-agent.context-references",
        `[Retired retrieval payloads; source references only]\n${JSON.stringify(item.contextReferences)}`,
        false,
        { schemaVersion: 1, references: item.contextReferences }
      );
    }
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
    if (event.type === "compaction_start") {
      onEvent({ type: "compaction_started", reason: event.reason });
      return;
    }
    if (event.type === "compaction_end") {
      if (event.result !== undefined) {
        onEvent({
          type: "compaction_completed",
          reason: event.reason,
          tokensBefore: event.result.tokensBefore,
          ...(event.result.estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter: event.result.estimatedTokensAfter })
        });
      } else if (!event.aborted) {
        onEvent({ type: "compaction_failed", reason: event.reason, message: event.errorMessage ?? "Thread compaction failed." });
      }
      return;
    }
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
