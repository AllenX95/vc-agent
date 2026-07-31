import { InMemoryCredentialStore, fauxProvider, type AssistantMessage, type Api } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createPiSessionUsingRuntime,
  type PiSessionConfig,
  type PiSessionEvent,
  type PiSessionHandle
} from "./pi-session.js";

export async function createFauxPiSession(input: {
  readonly config: Omit<PiSessionConfig, "profile">;
  readonly profileOverrides?: Pick<PiSessionConfig["profile"], "contextWindow" | "maxOutputTokens">;
  readonly responses: readonly AssistantMessage[];
  readonly onEvent: (event: PiSessionEvent) => void;
}): Promise<PiSessionHandle> {
  const faux = fauxProvider({ provider: "vc-agent-faux", models: [{ id: "vc-agent-faux-model" }], tokensPerSecond: 10_000 });
  faux.setResponses([...input.responses]);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false
  });
  runtime.registerProvider(faux.provider.id, {
    name: faux.provider.name,
    api: faux.api as Api,
    streamSimple: faux.provider.streamSimple,
    models: faux.models.map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api as Api,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      input: [...model.input],
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens
    }))
  });
  return createPiSessionUsingRuntime(
    {
      ...input.config,
      // Faux sessions must remain deterministic and network-free unless a
      // test explicitly opts into the bundled web extension.
      usePiWebAccess: input.config.usePiWebAccess ?? false,
      profile: { provider: faux.provider.id, model: faux.models[0].id, apiKey: "faux-runtime-key", ...input.profileOverrides }
    },
    input.onEvent,
    runtime
  );
}

export { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
