import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PersonalCognitionBackupService } from "@vc-agent/host-services";

interface State { schemaVersion: 1; accessMode: "standard" | "full"; profiles: Array<{ id: string }>; marker: string }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vc-agent-cognition-"));
  const memoryRoot = join(root, "memory", "long-term");
  const paths = {
    "long-term-memory.md": join(memoryRoot, "long-term-memory.md"),
    "long-term-memory-condensation-archive.md": join(memoryRoot, "long-term-memory-condensation-archive.md"),
    "cognitive-evolution-history.md": join(memoryRoot, "cognitive-evolution-history.md"),
    "memory-maintenance.json": join(root, "memory", "memory-maintenance.json")
  };
  for (const [name, path] of Object.entries(paths)) {
    const directory = path.slice(0, path.lastIndexOf("\\"));
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, `${name}: original`, "utf8");
  }
  let state: State = { schemaVersion: 1, accessMode: "standard", profiles: [{ id: "profile-1" }], marker: "original" };
  const adapter = {
    exportPersonalCognitionState: () => structuredClone(state),
    replacePersonalCognitionState: (next: State) => { state = structuredClone(next); }
  };
  const service = new PersonalCognitionBackupService({ state: adapter, memoryFiles: paths, now: () => new Date("2026-07-22T00:00:00.000Z") });
  return { root, paths, service, getState: () => state, setState: (next: State) => { state = next; } };
}

describe("PersonalCognitionBackupService", () => {
  it("creates a transparent checksummed allowlist without Project data, trajectories, or credentials", () => {
    const item = fixture();
    const bundle = join(item.root, "backup");
    const manifest = item.service.create(bundle);
    expect(manifest).toMatchObject({ formatVersion: 1, credentialsIncluded: false, trajectoriesIncluded: false });
    expect(manifest.files.map((file) => file.path)).toContain("domains/personal-state.json");
    expect(manifest.files).toHaveLength(5);
    expect(JSON.stringify(manifest)).not.toMatch(/project-id|credential_ref|absolute/iu);
    expect(JSON.parse(readFileSync(join(bundle, "domains", "personal-state.json"), "utf8"))).toMatchObject({ marker: "original" });
  });

  it("validates every checksum before replacing any domain", () => {
    const item = fixture();
    const bundle = join(item.root, "backup");
    item.service.create(bundle);
    writeFileSync(join(bundle, "domains", "long-term-memory", "long-term-memory.md"), "tampered", "utf8");
    item.setState({ schemaVersion: 1, accessMode: "full", profiles: [], marker: "current" });
    expect(() => item.service.restore(bundle, true)).toThrow(/checksum mismatch/iu);
    expect(item.getState().marker).toBe("current");
    expect(readFileSync(item.paths["long-term-memory.md"], "utf8")).toContain("original");
  });

  it("requires whole-domain confirmation and restores cognition without credentials", () => {
    const item = fixture();
    const bundle = join(item.root, "backup");
    item.service.create(bundle);
    item.setState({ schemaVersion: 1, accessMode: "full", profiles: [], marker: "changed" });
    writeFileSync(item.paths["long-term-memory.md"], "changed", "utf8");
    expect(() => item.service.restore(bundle, false)).toThrow(/confirmation/iu);
    const restored = item.service.restore(bundle, true);
    expect(restored.requiresCredentialSetup).toBe(true);
    expect(item.getState().marker).toBe("original");
    expect(readFileSync(item.paths["long-term-memory.md"], "utf8")).toContain("original");
    expect(existsSync(join(bundle, "domains", "credentials"))).toBe(false);
  });
});
