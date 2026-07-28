import { createPiSession } from "@vc-agent/pi-adapter";
import { createFauxPiSession } from "@vc-agent/pi-adapter/testing";
import { startAgentWorker, type AgentWorkerSessionAdapter, type ExecuteCommand } from "./worker-runtime.js";
import {
  dogfoodFixtureResponses,
  dreamSynthesisFixtureResponses,
  explicitLongTermMemoryFixtureResponses,
  learningGateRecallFixtureResponses,
  longTermMemoryFixtureResponses,
  memoryAwareReflectionContinuationFixtureResponses,
  memoryAwareReflectionFixtureResponses,
  reflectionFixtureResponses,
  subAgentFixtureResponses,
  unscopedMemoryAwareReflectionContinuationFixtureResponses,
  unscopedMemoryAwareReflectionFixtureResponses,
  unscopedReflectionFixtureResponses
} from "./testing/fixture-responses.js";

const fixtureProviders = new Set([
  "vc-agent-faux",
  "vc-agent-memory-faux",
  "vc-agent-explicit-memory-faux",
  "vc-agent-learning-recall-faux",
  "vc-agent-reflection-faux",
  "vc-agent-reflection-memory-faux",
  "vc-agent-unscoped-evidence-faux",
  "vc-agent-unscoped-memory-faux",
  "vc-agent-dream-synthesis-faux",
  "vc-agent-sub-agent-faux"
]);

const adapter: AgentWorkerSessionAdapter = {
  async createSession({ config, command, onEvent }) {
    if (!fixtureProviders.has(command.profile.provider)) {
      return createPiSession({ ...config, profile: command.profile }, onEvent);
    }
    return createFauxPiSession({
      config,
      responses: fixtureResponses(command),
      onEvent
    });
  },
  beforeTurn(command) {
    if (process.env.VC_AGENT_TEST_WORKER_CRASH_ON_COMPACTION === "1" && command.compactOnly === true) {
      process.exit(86);
    }
    if (command.profile.provider === "vc-agent-reflection-provider-failure-faux") {
      throw new Error(JSON.stringify({
        error: {
          code: "FIXTURE_PROVIDER_REJECTED",
          message: `Provider rejected credential ${command.profile.apiKey}`,
          request_id: "req-reflection-fixture"
        }
      }));
    }
  },
  async beforeSubmit() {
    const delayMs = Number.parseInt(process.env.VC_AGENT_TEST_FAUX_DELAY_MS ?? "0", 10);
    if (Number.isInteger(delayMs) && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

startAgentWorker(adapter);

function fixtureResponses(command: ExecuteCommand) {
  if (command.profile.provider === "vc-agent-memory-faux") return longTermMemoryFixtureResponses();
  if (command.profile.provider === "vc-agent-explicit-memory-faux") return explicitLongTermMemoryFixtureResponses();
  if (command.profile.provider === "vc-agent-learning-recall-faux") return learningGateRecallFixtureResponses();
  if (command.profile.provider === "vc-agent-reflection-faux") return reflectionFixtureResponses();
  if (command.profile.provider === "vc-agent-reflection-memory-faux") {
    return command.contextHistory.length > 0
      ? memoryAwareReflectionContinuationFixtureResponses()
      : memoryAwareReflectionFixtureResponses();
  }
  if (command.profile.provider === "vc-agent-unscoped-evidence-faux") return unscopedReflectionFixtureResponses();
  if (command.profile.provider === "vc-agent-unscoped-memory-faux") {
    return command.contextHistory.length > 0
      ? unscopedMemoryAwareReflectionContinuationFixtureResponses()
      : unscopedMemoryAwareReflectionFixtureResponses();
  }
  if (command.profile.provider === "vc-agent-dream-synthesis-faux") return dreamSynthesisFixtureResponses(command.prompt);
  if (command.profile.provider === "vc-agent-sub-agent-faux") return subAgentFixtureResponses(command.prompt);
  return dogfoodFixtureResponses();
}
