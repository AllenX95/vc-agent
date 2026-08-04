import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionInventorySnapshot, RuntimeResourceSnapshot } from "@vc-agent/contracts";
import { RuntimeCapabilityAssembler, SnapshotResourceLoader, runtimeExtensionTools } from "@vc-agent/pi-adapter";

const temporaryDirectories: string[] = [];
const resources: RuntimeResourceSnapshot = {
  schemaVersion: 1,
  revisionId: "loader-test-resources",
  systemPrompt: "Fixture prompt",
  appendSystemPrompt: []
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function hashInventory(root: string): string {
  const files: string[] = [];
  visit(root);
  const inventory = files.sort().map((file) => {
    const path = join(root, file);
    const stat = statSync(path);
    const fileHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    return `${file}\u0000${stat.size}\u0000${stat.mode & 0o777}\u0000${fileHash}`;
  }).join("\n");
  return createHash("sha256").update(inventory, "utf8").digest("hex");

  function visit(directory: string): void {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(relative(root, path).split(sep).join("/"));
    }
  }
}

function createApprovedFixture(): { readonly root: string; readonly entryPath: string; readonly extension: ExtensionInventorySnapshot["enabled"][number] } {
  const root = mkdtempSync(join(tmpdir(), "vc-agent-approved-extension-"));
  temporaryDirectories.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-extension", version: "1.0.0", type: "module" }), "utf8");
  const entryPath = join(root, "index.mjs");
  writeFileSync(entryPath, `export default function (pi) {
  pi.registerTool({
    name: "fixture_extension_tool",
    label: "Fixture extension tool",
    description: "A reviewed fixture tool.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "fixture" }] })
  });
}
`, "utf8");
  return {
    root,
    entryPath,
    extension: {
      id: "fixture-extension",
      version: "1.0.0",
      entryPath,
      integrity: hashInventory(root),
      trust: "approved-trusted"
    }
  };
}

describe("SnapshotResourceLoader", () => {
  it("loads an exact approved Extension through the public Pi loader and exposes its source identity", async () => {
    const fixture = createApprovedFixture();
    const loader = new SnapshotResourceLoader({
      cwd: fixture.root,
      resources,
      extensions: { schemaVersion: 1, revisionId: "approved-v1", enabled: [fixture.extension] }
    });

    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect([...loader.getExtensions().extensions[0].tools.keys()]).toContain("fixture_extension_tool");
    expect(runtimeExtensionTools(loader)).toEqual([{
      name: "fixture_extension_tool",
      source: "approved_extension",
      sourceId: "fixture-extension",
      sourceRevision: "1.0.0"
    }]);

    const assembly = new RuntimeCapabilityAssembler().assemble({
      hostSurface: {
        schemaVersion: 1,
        revision: "surface-v1",
        kind: "ordinary",
        scope: "project",
        visibleCapabilityIds: ["fixture_extension_tool"],
        executableCapabilityIds: ["fixture_extension_tool"],
        requestableCatalog: [],
        initialToolSchemaEstimatedTokens: 0
      },
      extensionRevision: loader.snapshot.extensions,
      skills: undefined,
      extensionTools: runtimeExtensionTools(loader)
    });
    expect(assembly.initialActiveToolNames).toContain("fixture_extension_tool");
  });

  it("rejects a changed approved artifact before it can execute", async () => {
    const fixture = createApprovedFixture();
    const loader = new SnapshotResourceLoader({ cwd: fixture.root, resources, extensions: { schemaVersion: 1, revisionId: "approved-v1", enabled: [fixture.extension] } });
    writeFileSync(fixture.entryPath, `${readFileSync(fixture.entryPath, "utf8")}\n// changed\n`, "utf8");

    expect(loader.inspect().rejected).toEqual([expect.objectContaining({ id: "fixture-extension", code: "EXTENSION_ARTIFACT_CHANGED" })]);
    await expect(loader.reload()).rejects.toThrow("EXTENSION_LOAD_PREFLIGHT_FAILED");
  });

  it("rejects a colliding approved Extension before either module executes", () => {
    const first = createApprovedFixture();
    const second = createApprovedFixture();
    const marker = join(second.root, "executed.marker");
    writeFileSync(second.entryPath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\n${readFileSync(second.entryPath, "utf8")}`, "utf8");
    const secondEntry = { ...second.extension, id: "second-extension", integrity: hashInventory(second.root) };

    expect(() => new SnapshotResourceLoader({
      cwd: first.root,
      resources,
      extensions: { schemaVersion: 1, revisionId: "collision-v1", enabled: [first.extension, secondEntry] }
    })).toThrow("EXTENSION_LOAD_PREFLIGHT_FAILED");
    expect(existsSync(marker)).toBe(false);
  });

  it("reports malformed Web configuration without changing it during preflight", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-web-config-"));
    temporaryDirectories.push(root);
    const configDirectory = join(root, "integrations", "pi-web-access");
    mkdirSync(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "web-search.json");
    writeFileSync(configPath, "{ malformed", "utf8");
    const previous = process.env.VC_AGENT_USER_DATA_DIR;
    process.env.VC_AGENT_USER_DATA_DIR = root;
    try {
      const loader = new SnapshotResourceLoader({ cwd: root, resources, extensions: { schemaVersion: 1, revisionId: "web-config-v1", enabled: [] }, loadBundledExtensions: true });
      expect(loader.inspect().diagnostics).toContainEqual(expect.objectContaining({ code: "WEB_CONFIGURATION_INVALID", sourceId: "pi-web-access" }));
      expect(readFileSync(configPath, "utf8")).toBe("{ malformed");
    } finally {
      if (previous === undefined) delete process.env.VC_AGENT_USER_DATA_DIR;
      else process.env.VC_AGENT_USER_DATA_DIR = previous;
    }
  });
});
