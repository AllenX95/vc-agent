import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSession, type ExtensionInventorySnapshot, type RuntimeResourceSnapshot } from "@vc-agent/pi-adapter";

type CapturedPayload = {
  readonly tools?: readonly {
    readonly function?: {
      readonly name?: string;
      readonly parameters?: Record<string, unknown>;
    };
  }[];
};

const ACTIVE_CAPABILITIES = [
  "capability_request",
  "material_recall",
  "reflection_evidence_drilldown",
  "project_state_recall",
  "memory_recall",
  "reflection_outcome_propose",
  "web_search",
  "web_fetch",
  "academic_research",
  "file_download",
  "workspace.write_batch",
  "arxiv.fulltext",
  "output.write_text",
  "output.edit_text"
] as const;

const EXPECTED_PROVIDER_TOOL_NAMES = [
  "capability_request",
  "material_recall",
  "reflection_evidence_drilldown",
  "project_state_recall",
  "memory_recall",
  "reflection_outcome_propose",
  "web_search",
  "web_fetch",
  "academic_research",
  "file_download",
  "workspace_write_batch",
  "arxiv_fulltext",
  "output_write_text",
  "output_edit_text"
] as const;

const temporaryDirectories: string[] = [];
const resources: RuntimeResourceSnapshot = {
  schemaVersion: 1,
  revisionId: "provider-tool-schema-test",
  systemPrompt: "You are vc-agent.",
  appendSystemPrompt: []
};
const extensions: ExtensionInventorySnapshot = {
  schemaVersion: 1,
  revisionId: "provider-tool-schema-test-extensions",
  enabled: []
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function captureProjectCommandPayload(input: {
  readonly provider: string;
  readonly model: string;
  readonly expectedProvider: string;
}): Promise<Record<string, unknown>> {
  let captured: CapturedPayload | undefined;
  const originalFetch = globalThis.fetch;
  const cwd = mkdtempSync(join(tmpdir(), "vc-agent-provider-tool-schema-"));
  temporaryDirectories.push(cwd);
  let handle: Awaited<ReturnType<typeof createPiSession>> | undefined;
  globalThis.fetch = (async (_input, init) => {
    captured = JSON.parse(String(init?.body)) as CapturedPayload;
    const chunks = [
      { id: "provider-tool-schema-test", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { id: "provider-tool-schema-test", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
    ];
    const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  try {
    handle = await createPiSession({
      cwd,
      threadDirectory: cwd,
      contextHistory: [],
      resources,
      extensions,
      usePiWebAccess: false,
      profile: { provider: input.provider, model: input.model, apiKey: "schema-test-key" },
      capabilityProxy: async () => ({ schemaVersion: 1, requestId: "provider-tool-schema-test", status: "completed", content: "ok" })
    }, () => {});
    expect(handle.provider).toBe(input.expectedProvider);
    await handle.submit("Inspect the project.", { activeCapabilities: ACTIVE_CAPABILITIES });
  } finally {
    handle?.dispose();
    globalThis.fetch = originalFetch;
  }

  expect(captured).toBeDefined();
  return captured!;
}

describe("OpenAI-compatible Provider tool schemas", () => {
  it.each([
    ["DeepSeek", "https://api.deepseek.com/anthropic", "deepseek-v4-flash", "deepseek"],
    ["MiMo", "https://api.xiaomimimo.com/anthropic", "mimo-v2.5", "xiaomi"]
  ] as const)("sends object-root schemas for all active capabilities to %s", async (_providerName, provider, model, expectedProvider) => {
    const payload = await captureProjectCommandPayload({ provider, model, expectedProvider });
    const tools = payload.tools ?? [];
    const toolNames = tools.map((candidate) => candidate.function?.name);

    expect(toolNames).toEqual(EXPECTED_PROVIDER_TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.function?.parameters?.type).toBe("object");
      expect(tool.function?.parameters?.properties).toBeDefined();
    }
  });
});
