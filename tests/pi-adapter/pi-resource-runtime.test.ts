import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiResourceRuntime, resolveBundledPiMcpAdapterPath, resolveBundledPiWebAccessPath } from "@vc-agent/pi-adapter";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function createExtension(root: string, name: string, toolName: string, markerPath?: string): string {
  const extensionRoot = join(root, name);
  mkdirSync(extensionRoot, { recursive: true });
  const entry = join(extensionRoot, "index.mjs");
  writeFileSync(entry, `${markerPath === undefined ? "" : `import { writeFileSync } from \"node:fs\"; writeFileSync(${JSON.stringify(markerPath)}, \"loaded\");`}
export default function (pi) {
  pi.registerTool({ name: ${JSON.stringify(toolName)}, label: ${JSON.stringify(toolName)}, description: "fixture", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });
}
`, "utf8");
  return entry;
}

function createSkill(root: string, name: string, description = "Fixture skill"): string {
  const skillRoot = join(root, name);
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(join(skillRoot, "SKILL.md"), `---
name: ${name}
description: ${description}
---

Instructions for ${name}.
`, "utf8");
  return skillRoot;
}

describe("PiResourceRuntime", () => {
  it("does not execute an Extension while constructing the runtime", async () => {
    const root = createRoot("vc-agent-pi-runtime-construction-");
    const marker = join(root, "extension-loaded.marker");
    const agentDir = join(root, "pi");
    const entry = createExtension(root, "fixture-extension", "fixture_tool", marker);

    const runtime = new PiResourceRuntime({ cwd: root, agentDir, extensionPaths: [entry], skillsRoot: join(root, "skills") });
    expect(existsSync(marker)).toBe(false);

    await runtime.reload();
    expect(existsSync(marker)).toBe(true);
    await runtime.close();
  });

  it("loads only the dedicated Skills directory and ignores ambient roots", async () => {
    const root = createRoot("vc-agent-pi-runtime-skills-");
    const agentDir = join(root, "pi");
    const dedicated = join(root, "vc-skills");
    const ambient = join(root, "ambient", ".agents", "skills");
    createSkill(dedicated, "investment-diligence");
    createSkill(ambient, "coding-helper");

    const runtime = new PiResourceRuntime({ cwd: root, agentDir, skillsRoot: dedicated });
    await runtime.reload();

    expect(runtime.snapshot.skills.map((skill) => skill.name)).toEqual(["investment-diligence"]);
    expect(runtime.snapshot.skills.some((skill) => skill.name === "coding-helper")).toBe(false);
    await runtime.close();
  });

  it("reports deterministic Extension tool collisions without silently hiding them", async () => {
    const root = createRoot("vc-agent-pi-runtime-collision-");
    const agentDir = join(root, "pi");
    const first = createExtension(root, "first-extension", "duplicate_tool");
    const second = createExtension(root, "second-extension", "duplicate_tool");

    const runtime = new PiResourceRuntime({ cwd: root, agentDir, extensionPaths: [first, second] });
    const snapshot = await runtime.reload();

    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "collision", source: "extension", blocking: true, message: expect.stringContaining("duplicate_tool") })
    ]));
    expect(snapshot.hasBlockingDiagnostics).toBe(true);
    await runtime.close();
  });

  it("defers reload until the active Turn closes", async () => {
    const root = createRoot("vc-agent-pi-runtime-turn-");
    const runtime = new PiResourceRuntime({ cwd: root, agentDir: join(root, "pi") });
    const lease = runtime.beginTurn();
    const deferred = await runtime.reload();
    expect(deferred.reloadDeferred).toBe(true);
    expect(deferred.generation).toBe(0);

    const reloaded = await lease.close();
    expect(reloaded?.reloadDeferred).toBe(false);
    expect(reloaded?.generation).toBe(1);
    await runtime.close();
  });

  it("forwards Host prompt inputs and explicit dormant-resource switches to Pi", async () => {
    const root = createRoot("vc-agent-pi-runtime-prompt-");
    writeFileSync(join(root, "AGENTS.md"), "ambient context must not be selected when disabled", "utf8");
    const runtime = new PiResourceRuntime({
      cwd: root,
      agentDir: join(root, "pi"),
      systemPrompt: "Host-owned prompt",
      appendSystemPrompt: ["Host-owned suffix"],
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true
    });

    const snapshot = await runtime.reload();
    expect(snapshot.systemPrompt).toBe("Host-owned prompt");
    expect(snapshot.appendSystemPrompt).toEqual(["Host-owned suffix"]);
    expect(runtime.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(runtime.resourceLoader.getPrompts().prompts).toEqual([]);
    expect(runtime.resourceLoader.getThemes().themes).toEqual([]);
    await runtime.close();
  });

  it("constructs with the pinned MCP adapter without connecting it", async () => {
    const adapterPath = resolveBundledPiMcpAdapterPath();
    expect(adapterPath).toBeDefined();
    const root = createRoot("vc-agent-pi-runtime-mcp-");
    const agentDir = join(root, "pi");
    const configPath = join(root, "mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), "utf8");

    const runtime = new PiResourceRuntime({
      cwd: root,
      agentDir,
      mcpAdapterPath: adapterPath,
      mcpConfigPath: configPath
    });
    expect(runtime.snapshot.generation).toBe(0);
    expect(runtime.snapshot.extensions.extensions).toHaveLength(0);

    const snapshot = await runtime.reload();
    expect(snapshot.extensions.extensions.some((extension) => extension.flags.has("mcp-config"))).toBe(true);
    expect(snapshot.diagnostics.filter((diagnostic) => diagnostic.source === "mcp")).toEqual([]);
    await runtime.close();
  });

  it("ships a deterministic MCP adapter asset beside the production Worker bundle", () => {
    const workerBundlePath = resolve("apps/agent-worker/dist/index.js");
    const adapterAssetPath = join(dirname(workerBundlePath), "pi-mcp-adapter.js");
    expect(existsSync(workerBundlePath)).toBe(true);
    expect(existsSync(adapterAssetPath)).toBe(true);
    expect(resolveBundledPiMcpAdapterPath(pathToFileURL(workerBundlePath).href)).toBe(adapterAssetPath);
    const workerBundle = readFileSync(workerBundlePath, "utf8");
    expect(workerBundle).toContain("pi-mcp-adapter.js");
  });

  it("reports MCP_ADAPTER_UNAVAILABLE instead of an unknown flag when the asset is missing", async () => {
    const root = createRoot("vc-agent-pi-runtime-mcp-missing-");
    const configPath = join(root, "mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
    const runtime = new PiResourceRuntime({
      cwd: root,
      agentDir: join(root, "pi"),
      mcpConfigPath: configPath
    });
    const snapshot = await runtime.reload();
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "mcp",
        blocking: true,
        message: expect.stringContaining("MCP_ADAPTER_UNAVAILABLE")
      })
    ]));
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.message.includes("Unknown Extension flag"))).toBe(false);
    await runtime.close();
  });

  it("loads the standalone Worker adapter asset and registers the MCP tool", async () => {
    const root = createRoot("vc-agent-pi-runtime-mcp-asset-");
    const configPath = join(root, "mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
    const adapterAssetPath = resolve("apps/agent-worker/dist/pi-mcp-adapter.js");
    const runtime = new PiResourceRuntime({
      cwd: root,
      agentDir: join(root, "pi"),
      mcpAdapterPath: adapterAssetPath,
      mcpConfigPath: configPath
    });
    const snapshot = await runtime.reload();
    expect(snapshot.hasBlockingDiagnostics).toBe(false);
    expect(snapshot.extensions.extensions.some((extension) => extension.tools.has("mcp"))).toBe(true);
    expect(snapshot.extensions.runtime.flagValues.get("mcp-config")).toBe(configPath);
    await runtime.close();
  });

  it("resolves the pinned Web Extension without importing it", () => {
    const entryPath = resolveBundledPiWebAccessPath();
    expect(entryPath).toBeDefined();
    expect(existsSync(entryPath!)).toBe(true);
  });

  it("rejects Markdown references and multi-hop symlinks that escape the dedicated root", async () => {
    const root = createRoot("vc-agent-pi-runtime-skill-escape-");
    const dedicated = join(root, "vc-skills");
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    const outsideFile = join(outside, "secret.md");
    writeFileSync(outsideFile, "secret", "utf8");

    const referenceSkill = createSkill(dedicated, "reference-escape");
    writeFileSync(join(referenceSkill, "SKILL.md"), `---
name: reference-escape
description: Escape fixture
---

[outside](../outside/secret.md)
![absolute](${outsideFile.replace(/\\/gu, "/")})
`, "utf8");

    const symlinkSkill = createSkill(dedicated, "symlink-escape");
    try {
      const hopTwo = join(symlinkSkill, "hop-two");
      const hopOne = join(symlinkSkill, "hop-one");
      symlinkSync(outside, hopTwo, "junction");
      symlinkSync(hopTwo, hopOne, "junction");
    } catch {
      // Windows CI may not grant symlink privileges; Markdown containment
      // remains deterministic and still exercises the containment Adapter.
    }

    const runtime = new PiResourceRuntime({ cwd: root, agentDir: join(root, "pi"), skillsRoot: dedicated });
    const snapshot = await runtime.reload();
    expect(snapshot.skills.map((skill) => skill.name)).not.toEqual(expect.arrayContaining(["reference-escape"]));
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "skill", type: "error", message: expect.stringContaining("escapes") })
    ]));
    if (existsSync(join(symlinkSkill, "hop-one"))) {
      expect(snapshot.skills.map((skill) => skill.name)).not.toEqual(expect.arrayContaining(["symlink-escape"]));
    }
    await runtime.close();
  });
});
