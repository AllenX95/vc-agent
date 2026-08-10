import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSession, type RuntimeResourceSnapshot } from "@vc-agent/pi-adapter";

const temporaryDirectories: string[] = [];
const resources: RuntimeResourceSnapshot = {
  schemaVersion: 1,
  revisionId: "custom-url-test",
  systemPrompt: "You are a test agent.",
  appendSystemPrompt: []
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("custom URL Pi providers", () => {
  it("registers a custom URL as a usable Pi model without network discovery", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-custom-url-provider-"));
    temporaryDirectories.push(cwd);
    const handle = await createPiSession({
      cwd,
      threadDirectory: cwd,
      contextHistory: [],
      profile: { provider: "https://gateway.example/anthropic", model: "custom-model", apiKey: "test-key" },
      resources,
      piResources: { agentDir: join(cwd, "pi-agent"), skillsRoot: join(cwd, "skills") },
      usePiWebAccess: false
    }, () => {});

    expect(handle.provider).toMatch(/^vc-agent-url-[0-9a-f]{8}$/u);
    expect(handle.model).toBe("custom-model");
    expect(handle.contextWindow).toBe(128_000);
    expect(handle.maxOutputTokens).toBe(16_384);
    handle.dispose();
  });
});
