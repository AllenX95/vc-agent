import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SnapshotResourceLoader,
  createPiSession,
  listKnownPiModels,
  sanitizeProviderFailure,
  type ExtensionInventorySnapshot,
  type RuntimeResourceSnapshot
} from "@vc-agent/pi-adapter";

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
});
