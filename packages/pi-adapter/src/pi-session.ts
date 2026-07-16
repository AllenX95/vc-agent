import { InMemoryCredentialStore, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession
} from "@earendil-works/pi-coding-agent";
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
  readonly profile: PiSessionProfile;
  readonly resources: RuntimeResourceSnapshot;
  readonly extensions: ExtensionInventorySnapshot;
}

export type PiSessionEvent =
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "completed"; readonly message: string; readonly usage: Usage; readonly responseId?: string }
  | { readonly type: "failed"; readonly error: unknown };

export interface PiSessionHandle {
  readonly provider: string;
  readonly model: string;
  readonly activeTools: readonly string[];
  submit(prompt: string): Promise<void>;
  dispose(): void;
}

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
  const { session } = await createAgentSession({
    cwd: config.cwd,
    modelRuntime,
    model,
    thinkingLevel: config.profile.thinkingLevel ?? "off",
    noTools: "all",
    resourceLoader,
    sessionManager: SessionManager.inMemory(config.cwd),
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
    submit: async (prompt) => {
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
    dispose: () => session.dispose()
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
