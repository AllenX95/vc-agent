import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PersonalCognitionBackupService } from "@vc-agent/host-services";

interface State { schemaVersion: 1; accessMode: "standard" | "full"; profiles: Array<{ id: string }>; marker: string; taskAssignments?: Array<{ taskType: string }> }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vc-agent-cognition-"));
  const memoryRoot = join(root, "memory", "long-term");
  const cognitionRoot = join(root, "cognition-v2");
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
  mkdirSync(cognitionRoot, { recursive: true });
  writeFileSync(join(cognitionRoot, "epoch.json"), JSON.stringify({ schemaVersion: 1, learningEpochStartedAt: "2026-07-22T00:00:00.000Z", status: "active" }), "utf8");
  writeFileSync(join(cognitionRoot, "source-index.jsonl"), "{\"source\":\"fixture\"}\n", "utf8");
  let state: State = { schemaVersion: 1, accessMode: "standard", profiles: [{ id: "profile-1" }], marker: "original" };
  const adapter = {
    exportPersonalCognitionState: () => structuredClone(state),
    replacePersonalCognitionState: (next: State) => { state = structuredClone(next); }
  };
  const service = new PersonalCognitionBackupService({ state: adapter, memoryFiles: paths, cognitionRoot, now: () => new Date("2026-07-22T00:00:00.000Z") });
  return { root, paths, cognitionRoot, service, getState: () => state, setState: (next: State) => { state = next; } };
}

describe("PersonalCognitionBackupService", () => {
  it("creates a transparent checksummed allowlist without Project data, trajectories, or credentials", () => {
    const item = fixture();
    const bundle = join(item.root, "backup");
    const manifest = item.service.create(bundle);
    expect(manifest).toMatchObject({ formatVersion: 2, stateSchemaVersion: 2, credentialsIncluded: false, trajectoriesIncluded: false });
    expect(manifest.files.map((file) => file.path)).toContain("domains/personal-state.json");
    expect(manifest.files.map((file) => file.path)).toContain("domains/cognition-v2/epoch.json");
    expect(manifest.files).toHaveLength(7);
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
    writeFileSync(join(item.cognitionRoot, "source-index.jsonl"), "changed\n", "utf8");
    writeFileSync(join(item.cognitionRoot, "stale.json"), "must be removed", "utf8");
    expect(() => item.service.restore(bundle, false)).toThrow(/confirmation/iu);
    const restored = item.service.restore(bundle, true);
    expect(restored.requiresCredentialSetup).toBe(true);
    expect(item.getState().marker).toBe("original");
    expect(readFileSync(item.paths["long-term-memory.md"], "utf8")).toContain("original");
    expect(readFileSync(join(item.cognitionRoot, "source-index.jsonl"), "utf8")).toContain("fixture");
    expect(existsSync(join(item.cognitionRoot, "stale.json"))).toBe(false);
    expect(existsSync(join(bundle, "domains", "credentials"))).toBe(false);
  });

  it("refuses a legacy cognition-v1 bundle at the v2 boundary", () => {
    const item = fixture();
    const bundle = join(item.root, "legacy-backup");
    item.service.create(bundle);
    const manifestPath = join(bundle, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.formatVersion = 1;
    manifest.stateSchemaVersion = 1;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    expect(() => item.service.inspect(bundle)).toThrow(/v2|unsupported|legacy/iu);
  });

  it("rejects legacy cognition assignments before creating a v2 bundle", () => {
    const item = fixture();
    item.setState({ ...item.getState(), taskAssignments: [{ taskType: "dream" }] });
    expect(() => item.service.create(join(item.root, "legacy-state"))).toThrow(/legacy cognition task assignment/iu);
  });

  it("rejects unmanifested files and path escapes", () => {
    const item = fixture();
    const bundle = join(item.root, "backup");
    item.service.create(bundle);
    writeFileSync(join(bundle, "domains", "cognition-v2", "unmanifested.json"), "not covered", "utf8");
    expect(() => item.service.inspect(bundle)).toThrow(/manifest file set/iu);
  });
});
