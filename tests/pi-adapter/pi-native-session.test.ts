import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFauxPiSession,
  fauxAssistantMessage,
  fauxToolCall
} from "@vc-agent/pi-adapter/testing";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createNativeExtension(root: string, marker: string): string {
  const extensionRoot = join(root, "fixture-extension");
  mkdirSync(extensionRoot, { recursive: true });
  const entry = join(extensionRoot, "index.mjs");
  writeFileSync(entry, `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerTool({
    name: "native_fixture",
    label: "Native fixture",
    description: "Fixture native Extension tool",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      writeFileSync(${JSON.stringify(marker)}, "called", "utf8");
      return { content: [{ type: "text", text: "native-ok" }] };
    }
  });
}
`, "utf8");
  return entry;
}

describe("Pi-native AgentSession integration", () => {
  it("loads the bundled MCP adapter when an MCP configuration is present", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-pi-native-session-mcp-"));
    temporaryDirectories.push(root);
    const mcpConfigPath = join(root, "mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }), "utf8");

    const handle = await createFauxPiSession({
      config: {
        cwd: root,
        threadDirectory: root,
        contextHistory: [],
        resources: { schemaVersion: 1, revisionId: "native-mcp-test", systemPrompt: "VC test prompt", appendSystemPrompt: [] },
        extensions: { schemaVersion: 1, revisionId: "legacy-unused", enabled: [] },
        piResources: {
          agentDir: join(root, "pi-agent"),
          skillsRoot: join(root, "vc-skills"),
          mcpConfigPath,
          projectResourcesTrusted: false
        },
        capabilityProxy: async () => ({ schemaVersion: 1, requestId: "native-mcp-cap", status: "completed", content: "ok" })
      },
      responses: [fauxAssistantMessage("Done.")],
      onEvent: () => {}
    });

    expect(handle.activeTools).toContain("mcp");
    await handle.disposeAsync?.();
  });

  it("keeps native Extension tools active while Host capability activation changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-pi-native-session-"));
    temporaryDirectories.push(root);
    const marker = join(root, "native-called.marker");
    const entry = createNativeExtension(root, marker);
    const handle = await createFauxPiSession({
      config: {
        cwd: root,
        threadDirectory: root,
        contextHistory: [],
        resources: { schemaVersion: 1, revisionId: "native-test", systemPrompt: "VC test prompt", appendSystemPrompt: [] },
        extensions: { schemaVersion: 1, revisionId: "legacy-unused", enabled: [] },
        piResources: {
          agentDir: join(root, "pi-agent"),
          skillsRoot: join(root, "vc-skills"),
          extensionPaths: [entry],
          projectResourcesTrusted: false
        },
        capabilityProxy: async () => ({ schemaVersion: 1, requestId: "native-cap", status: "completed", content: "ok" })
      },
      responses: [
        fauxAssistantMessage(fauxToolCall("native_fixture", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("Done.")
      ],
      onEvent: () => {}
    });

    expect(handle.activeTools).toContain("native_fixture");
    await handle.submit("Use the native fixture.", { activeCapabilities: [] });
    expect(existsSync(marker)).toBe(true);
    await handle.disposeAsync?.();
  });
});
