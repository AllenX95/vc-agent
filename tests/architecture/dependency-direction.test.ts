import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (entry === "node_modules" || entry === "dist") return [];
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

function importsIn(directory: string): Array<{ file: string; specifier: string }> {
  const importPattern = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;
  return sourceFiles(directory).flatMap((file) => {
    const content = readFileSync(file, "utf8");
    return [...content.matchAll(importPattern)].map((match) => ({
      file: relative(root, file),
      specifier: match[1] ?? ""
    }));
  });
}

describe("workspace dependency direction", () => {
  it("keeps the Renderer isolated to UI code and contracts", () => {
    const imports = importsIn(join(root, "apps/desktop/src/renderer"));
    const forbidden = imports.filter(({ specifier }) =>
      specifier === "electron" ||
      specifier.startsWith("node:") ||
      /^@vc-agent\/(core|persistence|host-services|capabilities|pi-adapter)/.test(specifier)
    );
    expect(forbidden).toEqual([]);
  });

  it("keeps core free of runtime and framework dependencies", () => {
    const imports = importsIn(join(root, "packages/core"));
    const forbidden = imports.filter(({ specifier }) =>
      specifier === "electron" ||
      specifier.startsWith("node:") ||
      /sqlite|python|pi-coding-agent|pi-ai/.test(specifier)
    );
    expect(forbidden).toEqual([]);
  });

  it("allows direct Pi SDK imports only in pi-adapter", () => {
    const imports = sourceFiles(root).flatMap((file) => {
      const content = readFileSync(file, "utf8");
      return /@(mariozechner|earendil-works)\/pi-(?:coding-agent|agent-core|ai)/.test(content)
        ? [relative(root, file)]
        : [];
    });
    expect(imports.every((file) => file.startsWith("packages\\pi-adapter\\") || file.startsWith("packages/pi-adapter/"))).toBe(true);
  });

  it("keeps workspace manifests within the accepted dependency graph", () => {
    const allowed: Record<string, Set<string>> = {
      "@vc-agent/core": new Set(),
      "@vc-agent/contracts": new Set(),
      "@vc-agent/persistence": new Set(["@vc-agent/core", "@vc-agent/contracts"]),
      "@vc-agent/host-services": new Set(["@vc-agent/core", "@vc-agent/contracts", "@vc-agent/capabilities"]),
      "@vc-agent/capabilities": new Set(["@vc-agent/core", "@vc-agent/contracts"]),
      "@vc-agent/pi-adapter": new Set(["@vc-agent/contracts"]),
      "@vc-agent/agent-worker": new Set(["@vc-agent/contracts", "@vc-agent/pi-adapter"]),
      "@vc-agent/utility-worker": new Set(["@vc-agent/contracts", "@vc-agent/capabilities"]),
      "@vc-agent/desktop": new Set([
        "@vc-agent/core",
        "@vc-agent/contracts",
        "@vc-agent/host-services",
        "@vc-agent/persistence",
        "@vc-agent/capabilities"
      ])
    };

    const manifests = ["packages", "apps"].flatMap((kind) =>
      readdirSync(join(root, kind)).map((name) => join(root, kind, name, "package.json"))
    );

    for (const manifestPath of manifests) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name: string;
        dependencies?: Record<string, string>;
      };
      const internalDependencies = Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@vc-agent/"));
      for (const dependency of internalDependencies) {
        expect(allowed[manifest.name], `${manifest.name} cannot depend on ${dependency}`).toContain(dependency);
      }
    }
  });
});
