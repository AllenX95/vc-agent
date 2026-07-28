import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentTurnIdleTimeoutError,
  SnapshotResourceLoader,
  aggregateUsage,
  createPiSession,
  listKnownPiModels,
  sanitizeProviderFailure,
  type ExtensionInventorySnapshot,
  type PiSessionEvent,
  type RuntimeResourceSnapshot
} from "@vc-agent/pi-adapter";
import { createFauxPiSession, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@vc-agent/pi-adapter/testing";

const temporaryDirectories: string[] = [];
const resources: RuntimeResourceSnapshot = {
  schemaVersion: 1,
  revisionId: "f2-tracer",
  systemPrompt: "You are vc-agent.",
  appendSystemPrompt: []
};
const extensions: ExtensionInventorySnapshot = {
  schemaVersion: 1,
  revisionId: "bundled-empty-v1",
  enabled: []
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("real Pi SDK tracer", () => {
  it("uses explicit context and output limits instead of catalog defaults", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-model-limits-"));
    temporaryDirectories.push(cwd);
    const handle = await createFauxPiSession({
      config: { cwd, threadDirectory: cwd, contextHistory: [], resources, extensions },
      profileOverrides: { contextWindow: 64_000, maxOutputTokens: 8_000 },
      responses: [fauxAssistantMessage("Done.")],
      onEvent: () => {}
    });

    expect(handle.contextWindow).toBe(64_000);
    expect(handle.maxOutputTokens).toBe(8_000);
    handle.dispose();
  });

  it("forwards thinking deltas separately from visible assistant text", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-thinking-stream-"));
    temporaryDirectories.push(cwd);
    const thinking: string[] = [];
    const text: string[] = [];
    const handle = await createFauxPiSession({
      config: {
        cwd,
        threadDirectory: cwd,
        contextHistory: [],
        resources,
        extensions
      },
      responses: [
        fauxAssistantMessage([fauxThinking("Inspect the evidence first."), { type: "text", text: "Visible answer." }])
      ],
      onEvent: (event) => {
        if (event.type === "thinking_delta") thinking.push(event.delta);
        if (event.type === "text_delta") text.push(event.delta);
      }
    });

    await handle.submit("Review this.");
    expect(thinking.join("")).toBe("Inspect the evidence first.");
    expect(text.join("")).toBe("Visible answer.");
    handle.dispose();
  });

  it("aggregates every model call in a tool-using turn and reports session context usage", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-turn-usage-"));
    temporaryDirectories.push(cwd);
    const toolResponse = fauxAssistantMessage(
      fauxToolCall("material_recall", { disclosureLevel: "cards" }),
      { stopReason: "toolUse" }
    );
    const finalResponse = fauxAssistantMessage("Visible answer.");
    let completed: Extract<PiSessionEvent, { type: "completed" }> | undefined;
    const handle = await createFauxPiSession({
      config: {
        cwd,
        threadDirectory: cwd,
        contextHistory: [],
        resources,
        extensions,
        capabilityProxy: async () => ({ schemaVersion: 1, requestId: "recall-1", status: "completed", content: "Evidence card" })
      },
      responses: [toolResponse, finalResponse],
      onEvent: (event) => {
        if (event.type === "completed") completed = event;
      }
    });

    await handle.submit("Review the material.", { activeCapabilities: ["material_recall"] });
    const assistantUsages = readFileSync(handle.sessionFile, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; message?: { role?: string; usage?: typeof toolResponse.usage } })
      .flatMap((entry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage !== undefined ? [entry.message.usage] : []);
    expect(completed?.usage).toMatchObject({
      input: assistantUsages.reduce((sum, usage) => sum + usage.input, 0),
      output: assistantUsages.reduce((sum, usage) => sum + usage.output, 0),
      totalTokens: assistantUsages.reduce((sum, usage) => sum + usage.totalTokens, 0)
    });
    expect(completed?.contextUsage).toMatchObject({
      contextWindow: handle.contextWindow,
      tokens: expect.any(Number),
      percent: expect.any(Number)
    });
    const usage = (reasoning: number) => ({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    });
    expect(aggregateUsage(usage(2), usage(3)).reasoning).toBe(5);
    handle.dispose();
  });

  it("creates a real session without default resources, tools, persistence, or network discovery", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-pi-tracer-"));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    mkdirSync(join(cwd, ".agents", "skills", "untrusted"), { recursive: true });
    writeFileSync(join(cwd, "AGENTS.md"), "This must not load.");
    writeFileSync(join(cwd, ".pi", "extensions", "untrusted.ts"), "throw new Error('loaded untrusted extension')");
    writeFileSync(join(cwd, ".agents", "skills", "untrusted", "SKILL.md"), "# Must not load");

    const model = (await listKnownPiModels())[0];
    expect(model).toBeDefined();

    const handle = await createPiSession(
      {
        cwd,
        threadDirectory: cwd,
        contextHistory: [],
        profile: {
          provider: model!.provider,
          model: model!.model,
          apiKey: "tracer-not-submitted"
        },
        resources,
        extensions
      },
      () => {}
    );

    expect(handle.provider).toBe(model!.provider);
    expect(handle.model).toBe(model!.model);
    expect(handle.activeTools).toEqual([]);
    expect(existsSync(join(cwd, ".pi", "sessions"))).toBe(false);
    handle.dispose();
  });

  it("keeps Host snapshots immutable and rejects dynamic resource extension", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-loader-"));
    temporaryDirectories.push(cwd);
    const loader = new SnapshotResourceLoader({ cwd, resources, extensions });
    await loader.reload();

    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(() => loader.extendResources({ skillPaths: [] })).toThrow("immutable");
    expect(Object.isFrozen(loader.snapshot)).toBe(true);
  });

  it("projects task-scoped Skill instructions into the real Pi resource loader", () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-skill-loader-"));
    temporaryDirectories.push(cwd);
    const skillPath = join(cwd, "active", "docx", "SKILL.md");
    const skillResources: RuntimeResourceSnapshot = {
      ...resources,
      skills: {
        schemaVersion: 1,
        revisionId: "skill-snapshot-1",
        decisions: [{ packageId: "docx", revisionId: "docx-rev-1", reason: "task_match", resources: ["SKILL.md"], capabilities: [] }],
        instructions: [{
          packageId: "docx",
          revisionId: "docx-rev-1",
          name: "docx",
          description: "Create Word documents",
          filePath: skillPath,
          baseDir: join(cwd, "active", "docx"),
          content: "---\nname: docx\ndescription: Create Word documents\n---\nUse the imported Word workflow."
        }],
        resources: []
      }
    };
    const loader = new SnapshotResourceLoader({ cwd, resources: skillResources, extensions });

    expect(loader.getSkills().skills).toMatchObject([{ name: "docx", description: "Create Word documents", filePath: skillPath }]);
    expect(loader.getAppendSystemPrompt().at(-1)).toContain("Use the imported Word workflow.");
    expect(loader.getAppendSystemPrompt().at(-1)).toContain(`References are relative to ${join(cwd, "active", "docx")}.`);
    expect(Object.isFrozen(loader.snapshot.resources.skills)).toBe(true);
  });

  it("resumes only an exactly acknowledged Pi context and rebuilds when the Host is ahead", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-reconcile-"));
    temporaryDirectories.push(cwd);
    const model = (await listKnownPiModels())[0]!;
    const profile = { provider: model.provider, model: model.model, apiKey: "reconcile-secret" };
    const first = await createPiSession(
      {
        cwd,
        threadDirectory: cwd,
        contextHistory: [{ user: "Prior question", assistant: "Prior visible answer", status: "completed" }],
        profile,
        resources,
        extensions
      },
      () => {}
    );
    expect(first.reconciliation).toBe("missing");
    first.acknowledge("terminal-1", 2);
    const firstFile = first.sessionFile;
    expect(firstFile).not.toBe("");
    expect(existsSync(firstFile)).toBe(true);
    first.dispose();

    const resumed = await createPiSession(
      {
        cwd,
        threadDirectory: cwd,
        previousSessionFile: firstFile,
        hostHighWater: { eventId: "terminal-1", sequence: 2 },
        contextHistory: [],
        profile,
        resources,
        extensions
      },
      () => {}
    );
    expect(resumed.reconciliation).toBe("resumed");
    expect(resumed.sessionFile).toBe(firstFile);
    resumed.dispose();

    const rebuilt = await createPiSession(
      {
        cwd,
        threadDirectory: cwd,
        previousSessionFile: firstFile,
        hostHighWater: { eventId: "terminal-2", sequence: 4 },
        contextHistory: [{ user: "Question", assistant: "Visible answer", status: "completed" }],
        profile,
        resources,
        extensions
      },
      () => {}
    );
    expect(rebuilt.reconciliation).toBe("host_ahead");
    expect(rebuilt.sessionFile).not.toBe(firstFile);
    expect(readFileSync(rebuilt.sessionFile, "utf8")).not.toContain(profile.apiKey);
    rebuilt.dispose();
  });

  it("sanitizes structured Provider failures without losing useful fields", () => {
    const apiKey = "sk-secret-value-123456";
    const failure = sanitizeProviderFailure(
      new Error(JSON.stringify({ error: { code: "invalid_api_key", message: `Bad key ${apiKey}`, request_id: "req-7" } })),
      { provider: "anthropic", model: "claude-sonnet-4-5", apiKey }
    );
    expect(failure).toMatchObject({
      kind: "provider",
      code: "invalid_api_key",
      message: "Bad key [REDACTED]",
      requestId: "req-7",
      provider: "anthropic",
      model: "claude-sonnet-4-5"
    });
    expect(JSON.stringify(failure)).not.toContain(apiKey);
  });

  it("executes an active Host capability proxy through a real Pi tool-call turn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-tool-proxy-"));
    temporaryDirectories.push(cwd);
    const events: string[] = [];
    const requests: Array<{ toolCallId: string; capabilityId: string; arguments_: Record<string, unknown> }> = [];
    const handle = await createFauxPiSession({
      config: {
        cwd,
        threadDirectory: cwd,
        contextHistory: [],
        resources,
        extensions,
        capabilityProxy: async (toolCallId, capabilityId, arguments_) => {
          requests.push({ toolCallId, capabilityId, arguments_ });
          return {
            schemaVersion: 1,
            requestId: "capability-request-1",
            status: "completed",
            content: "Created text Output",
            artifact: {
              schemaVersion: 1,
              id: "artifact-1",
              mediaType: "text/plain",
              producer: { type: "agent", id: "primary-agent" },
              destination: "C:\\outputs\\memo.txt",
              source: { threadId: "thread-1", turnId: "turn-1", capabilityRequestId: "capability-request-1" },
              createdAt: new Date().toISOString()
            }
          };
        }
      },
      responses: [
        fauxAssistantMessage(
          fauxToolCall("output.write_text", { path: "memo.txt", content: "Investment view", mediaType: "text/plain" }),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage("The requested Output was created.")
      ],
      onEvent: (event) => events.push(event.type === "text_delta" ? `delta:${event.delta}` : event.type)
    });

    await handle.submit("Create a memo file.", { activeCapabilities: ["output.write_text"] });
    expect(requests).toMatchObject([{
      capabilityId: "output.write_text",
      arguments_: { path: "memo.txt", content: "Investment view", mediaType: "text/plain" }
    }]);
    expect(events.some((event) => event.startsWith("delta:"))).toBe(true);
    expect(events.at(-1)).toBe("completed");
    expect(events.filter((event) => event === "completed")).toHaveLength(1);
    handle.dispose();
  });

  it("activates a requested recall capability within the same Pi turn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-dynamic-capability-"));
    temporaryDirectories.push(cwd);
    const requested: string[] = [];
    const handle = await createFauxPiSession({
      config: {
        cwd,
        threadDirectory: cwd,
        contextHistory: [],
        resources,
        extensions,
        capabilityProxy: async (_toolCallId, capabilityId) => {
          requested.push(capabilityId);
          if (capabilityId === "capability_request") {
            return { schemaVersion: 1, requestId: "request-activation", status: "completed", content: "Activated material_recall", activatedCapabilities: ["material_recall"] };
          }
          return { schemaVersion: 1, requestId: "request-recall", status: "completed", content: "bounded material result" };
        }
      },
      responses: [
        fauxAssistantMessage(fauxToolCall("capability_request", { need: "Read project materials", capabilityId: "material_recall" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("material_recall", { disclosureLevel: "cards" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("I inspected the available material cards.")
      ],
      onEvent: () => {}
    });

    await handle.submit("Inspect the project materials.", { activeCapabilities: ["capability_request"] });
    expect(requested).toEqual(["capability_request", "material_recall"]);
    handle.dispose();
  });

  it("classifies the local idle watchdog as a Worker failure rather than a Provider failure", () => {
    const failure = sanitizeProviderFailure(
      new AgentTurnIdleTimeoutError(120_000),
      { provider: "xiaomi", model: "mimo-v2.5", apiKey: "secret" }
    );
    expect(failure).toMatchObject({
      kind: "worker",
      code: "AGENT_TURN_IDLE_TIMEOUT",
      provider: "xiaomi",
      model: "mimo-v2.5"
    });
  });

  it("uses an idle timeout so a progressing multi-tool turn may exceed one timeout window", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-progressing-turn-"));
    temporaryDirectories.push(cwd);
    const events: string[] = [];
    const handle = await createFauxPiSession({
      config: {
        cwd,
        threadDirectory: cwd,
        contextHistory: [],
        resources,
        extensions,
        turnIdleTimeoutMs: 300,
        capabilityProxy: async (_toolCallId, capabilityId) => {
          await new Promise((resolve) => setTimeout(resolve, 180));
          return {
            schemaVersion: 1,
            requestId: `request-${capabilityId}`,
            status: "completed",
            content: `completed ${capabilityId}`
          };
        }
      },
      responses: [
        fauxAssistantMessage(fauxToolCall("project_state_recall", { source: "project_context", query: "materials" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("material_recall", { disclosureLevel: "cards" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("The progressing turn completed.")
      ],
      onEvent: (event) => events.push(event.type)
    });

    await handle.submit("Inspect the project.");
    expect(events.at(-1)).toBe("completed");
    handle.dispose();
  });

  it("honors the configured idle timeout for a stalled tool stage", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-stalled-turn-"));
    temporaryDirectories.push(cwd);
    const handle = await createFauxPiSession({
      config: {
        cwd,
        threadDirectory: cwd,
        contextHistory: [],
        resources,
        extensions,
        turnIdleTimeoutMs: 40,
        capabilityProxy: async (_toolCallId, capabilityId) => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return {
            schemaVersion: 1,
            requestId: `request-${capabilityId}`,
            status: "completed",
            content: `completed ${capabilityId}`
          };
        }
      },
      responses: [
        fauxAssistantMessage(fauxToolCall("material_recall", { disclosureLevel: "cards" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("This response must not be reached.")
      ],
      onEvent: () => {}
    });

    await expect(handle.submit("Inspect the project.", { activeCapabilities: ["material_recall"] }))
      .rejects.toThrow("no model or capability progress for 40 ms");
    handle.dispose();
  });

  it("rebuilds retired retrievals as source references without their bodies", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-context-reference-"));
    temporaryDirectories.push(cwd);
    const model = (await listKnownPiModels())[0]!;
    const handle = await createPiSession(
      {
        cwd,
        threadDirectory: cwd,
        contextHistory: [{
          user: "Review the material.",
          assistant: "I found one risk.",
          status: "completed",
          contextReferences: [{
            schemaVersion: 1,
            sourceClass: "material",
            sourceId: "material-1",
            label: "company.md",
            sourceRange: "paragraph-4",
            contentVersion: "a".repeat(64),
            originatingTool: "material_recall",
            originatingTurnId: "turn-1",
            retrievedAt: "2026-07-17T00:00:00.000Z",
            status: "active"
          }]
        }],
        profile: { provider: model.provider, model: model.model, apiKey: "reference-secret" },
        resources,
        extensions
      },
      () => {}
    );
    const physical = readFileSync(handle.sessionFile, "utf8");
    expect(physical).toContain("vc-agent.context-references");
    expect(physical).toContain("paragraph-4");
    expect(physical).not.toContain("FULL RETRIEVAL BODY");
    handle.dispose();
  });

  it("routes public-web tools through the same generic capability proxy", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-web-proxy-"));
    temporaryDirectories.push(cwd);
    const requests: string[] = [];
    const handle = await createFauxPiSession({
      config: {
        cwd,
        threadDirectory: cwd,
        contextHistory: [],
        resources,
        extensions,
        capabilityProxy: async (_toolCallId, capabilityId) => {
          requests.push(capabilityId);
          return { schemaVersion: 1, requestId: "web-request", status: "completed", content: "bounded web result" };
        }
      },
      responses: [
        fauxAssistantMessage(fauxToolCall("web_search", { query: "current market" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("I found a current public source.")
      ],
      onEvent: () => {}
    });
    await handle.submit("Search the current market.", { activeCapabilities: ["web_search", "web_fetch"] });
    expect(requests).toEqual(["web_search"]);
    handle.dispose();
  });
});
