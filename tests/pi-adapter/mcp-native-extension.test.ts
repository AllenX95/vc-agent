import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createNativePiSessionServicesForTesting } from "@vc-agent/pi-adapter/testing";

const adapterRoot = resolve("packages/pi-adapter/node_modules/pi-mcp-adapter");
const fixtureServer = resolve(import.meta.dirname, "native-mcp-fixture.mjs");
const temporaryDirectories: string[] = [];

type TextResult = {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
};

type AgentToolForTest = {
  readonly name: string;
  readonly execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown
  ) => Promise<TextResult>;
};

function textFromResult(result: TextResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

describe("Pi-native pi-mcp-adapter compatibility", () => {
  it("loads through DefaultResourceLoader, honors mcp-config, exposes the proxy lazily, and closes on session reload", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-pi-native-mcp-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "pi-agent");
    mkdirSync(agentDir, { recursive: true });
    const startedPath = join(root, "started.log");
    const closedPath = join(root, "closed.log");
    const callsPath = join(root, "calls.log");
    const configPath = join(agentDir, "mcp.json");
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fixtureServer, startedPath, closedPath, callsPath]
        }
      }
    }), "utf8");

    const native = await createNativePiSessionServicesForTesting({
      cwd: root,
      agentDir,
      mcpConfigPath: configPath,
      extensionPaths: [adapterRoot]
    });
    const { services } = native;

    expect(services.diagnostics).toEqual([]);
    const extensions = services.resourceLoader.getExtensions();
    expect(extensions.extensions.some((extension) => extension.tools.has("mcp"))).toBe(true);
    expect(extensions.runtime.flagValues.get("mcp-config")).toBe(configPath);
    expect(existsSync(startedPath)).toBe(false);

    const { session } = await native.createSession();
    expect(session.getAllTools().map((tool: { readonly name: string }) => tool.name)).toContain("mcp");
    expect(existsSync(startedPath)).toBe(false);

    await session.bindExtensions({ mode: "print" });
    await waitForFile(startedPath);
    expect(existsSync(startedPath)).toBe(true);

    const mcpTool = (session.agent.state.tools as AgentToolForTest[]).find((tool) => tool.name === "mcp");
    expect(mcpTool).toBeDefined();
    const execute = mcpTool!.execute.bind(mcpTool);
    const status = await execute("mcp-status", {}, undefined, undefined);
    const statusText = textFromResult(status);
    expect(statusText).toContain("fixture");

    const search = await execute("mcp-search", { search: "fixture" }, undefined, undefined);
    const searchText = textFromResult(search);
    expect(searchText).toContain("fixture_fixture.search");

    const describeResult = await execute("mcp-describe", { describe: "fixture_fixture.search" }, undefined, undefined);
    const describeText = textFromResult(describeResult);
    expect(describeText).toContain("Bounded fixture read");

    const call = await execute("mcp-call", {
      tool: "fixture_fixture.search",
      args: JSON.stringify({ query: "demo" })
    }, undefined, undefined);
    const callText = textFromResult(call);
    expect(callText).toContain("vc-agent-native-mcp-fixture");
    expect(readFileSync(callsPath, "utf8").trim()).toBe("fixture.search");

    await session.reload();
    await waitForFile(closedPath);
    expect(readFileSync(closedPath, "utf8").trim().split(/\r?\n/u)).toContain("closed");
    session.dispose();
  });
});
