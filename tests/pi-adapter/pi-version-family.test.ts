import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const expectedVersion = "0.84.1";
const piPackages = ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"] as const;

function dependencies(relativePath: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(resolve(root, relativePath), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return manifest.dependencies ?? {};
}

describe("Pi runtime version family", () => {
  it("pins every directly owned Pi runtime package to the accepted version", () => {
    const worker = dependencies("apps/agent-worker/package.json");
    const desktop = dependencies("apps/desktop/package.json");
    const adapter = dependencies("packages/pi-adapter/package.json");

    for (const packageName of piPackages) {
      expect(worker[`@earendil-works/${packageName}`]).toBe(expectedVersion);
    }
    for (const packageName of ["pi-ai", "pi-coding-agent", "pi-tui"]) {
      expect(desktop[`@earendil-works/${packageName}`]).toBe(expectedVersion);
    }
    for (const packageName of ["pi-ai", "pi-coding-agent"]) {
      expect(adapter[`@earendil-works/${packageName}`]).toBe(expectedVersion);
    }
  });

  it("rejects mixed Pi runtime versions in the resolved lockfile", () => {
    const lockfile = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
    const resolvedVersions = new Set(
      [...lockfile.matchAll(/^  '@earendil-works\/pi-(?:agent-core|ai|coding-agent|tui)@([^']+)':$/gmu)]
        .map((match) => match[1].split("(", 1)[0])
    );

    expect([...resolvedVersions]).toEqual([expectedVersion]);
  });
});
