import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
});
