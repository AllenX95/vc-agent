import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiIntegrationMigration, PiIntegrationMigrationError } from "@vc-agent/host-services";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vc-pi-migration-"));
  roots.push(root);
  const oldExtensionRoot = join(root, "old", "integrations", "extensions");
  const oldMcpRoot = join(root, "old", "integrations", "mcp");
  const oldSkillsRoot = join(root, "old", "skills");
  const newAgentDir = join(root, "new", "pi");
  const newExtensionRoot = join(newAgentDir, "extensions");
  const newMcpConfigPath = join(newAgentDir, "mcp.json");
  const newSkillsRoot = join(newAgentDir, "skills");

  const approvedPath = join(oldExtensionRoot, "approved", "fixture-extension", "revision-1");
  mkdirSync(approvedPath, { recursive: true });
  writeFileSync(join(approvedPath, "package.json"), JSON.stringify({ name: "fixture-extension", version: "1.0.0", main: "index.js" }), "utf8");
  writeFileSync(join(approvedPath, "index.js"), "throw new Error('must not execute during migration');", "utf8");
  writeFileSync(join(oldExtensionRoot, "state.json"), JSON.stringify({
    schemaVersion: 1,
    staged: [],
    reports: [],
    audits: [],
    approved: [{
      schemaVersion: 1,
      extensionId: "fixture-extension",
      approvedRevisionId: "revision-1",
      approvedPath,
      artifactHash: "legacy-hash",
      invalidated: false
    }]
  }), "utf8");
  writeFileSync(join(oldExtensionRoot, "global-revision.json"), JSON.stringify({
    schemaVersion: 1,
    effectiveRevisionId: "global-r1",
    effectiveExtensions: [{ extensionId: "fixture-extension", approvedRevisionId: "revision-1" }],
    history: []
  }), "utf8");

  mkdirSync(oldMcpRoot, { recursive: true });
  writeFileSync(join(oldMcpRoot, "mcp-servers.json"), JSON.stringify({ schemaVersion: 1, servers: [
    {
      schemaVersion: 1,
      serverId: "server-1",
      name: "Fixture MCP",
      transport: "stdio",
      command: "fixture-mcp",
      args: ["--safe"],
      enabled: true,
      allowedScopes: ["project"],
      enabledToolIds: [],
      adapterVersion: "pi-mcp-adapter@1.5.1",
      schemaRevision: "schema-1",
      cachedToolSchemas: [],
      connectionStatus: "disconnected",
      schemaState: "unknown",
      failureCount: 0,
      credentialRef: "super-secret-value"
    },
    {
      schemaVersion: 1,
      serverId: "disabled-server",
      name: "Disabled",
      transport: "stdio",
      command: "disabled",
      args: [],
      enabled: false,
      allowedScopes: ["project"],
      enabledToolIds: [],
      adapterVersion: "pi-mcp-adapter@1.5.1",
      schemaRevision: "schema-0",
      cachedToolSchemas: [],
      connectionStatus: "disconnected",
      schemaState: "unknown",
      failureCount: 0
    }
  ] }), "utf8");

  const activeSkillPath = join(oldSkillsRoot, "active", "investment-diligence", "skill-revision-1");
  mkdirSync(activeSkillPath, { recursive: true });
  writeFileSync(join(activeSkillPath, "SKILL.md"), "---\nname: investment-diligence\ndescription: Diligence fixture\n---\nUse the fixture.", "utf8");
  writeFileSync(join(activeSkillPath, "references.txt"), "bounded reference", "utf8");
  writeFileSync(join(oldSkillsRoot, "inventory.json"), JSON.stringify({ schemaVersion: 1, packages: [{
    schemaVersion: 1,
    packageId: "investment-diligence",
    revisionId: "skill-revision-1",
    importId: "import-1",
    sourceKind: "local_directory",
    importedAt: "2026-08-10T00:00:00.000Z",
    contentHash: "legacy-content",
    compatibility: "compatible",
    declaredDependencies: [],
    enabled: true,
    licensePresent: false,
    state: "active",
    files: ["SKILL.md", "references.txt"],
    findings: [],
    metadata: { name: "investment-diligence", description: "Diligence fixture" }
  }] }), "utf8");

  return { oldExtensionRoot, oldMcpRoot, oldSkillsRoot, newAgentDir, newExtensionRoot, newMcpConfigPath, newSkillsRoot };
}

describe("PiIntegrationMigration", () => {
  it("migrates effective Extension, MCP, and active Skill bytes with backup and marker", () => {
    const paths = fixture();
    const migration = new PiIntegrationMigration({ ...paths, now: () => "2026-08-10T12:34:56.000Z" });

    const inspection = migration.inspect();
    expect(inspection.status).toBe("ready");
    expect(inspection.extensions).toHaveLength(1);
    expect(inspection.mcpServers).toHaveLength(1);
    expect(inspection.skills).toHaveLength(1);

    const result = migration.migrate();
    expect(result.status).toBe("migrated");
    expect(existsSync(join(paths.newExtensionRoot, "revision-1", "index.js"))).toBe(true);
    expect(existsSync(join(paths.newSkillsRoot, "investment-diligence", "SKILL.md"))).toBe(true);
    const configText = readFileSync(paths.newMcpConfigPath, "utf8");
    expect(configText).toContain('"Fixture MCP"');
    expect(configText).toContain('"command": "fixture-mcp"');
    expect(configText).not.toContain("super-secret-value");
    expect(existsSync(join(result.backupPath, "manifest.json"))).toBe(true);
    expect(readFileSync(join(result.backupPath, "mcp", "mcp-servers.json"), "utf8")).not.toContain("super-secret-value");
    expect(existsSync(migration.markerPath)).toBe(true);

    const retry = migration.migrate();
    expect(retry.status).toBe("already_migrated");
    expect(retry.backupPath).toBe(result.backupPath);
  });

  it("blocks malformed legacy state without writing targets or executing Extension code", () => {
    const paths = fixture();
    writeFileSync(join(paths.oldMcpRoot, "mcp-servers.json"), "{ malformed", "utf8");
    const migration = new PiIntegrationMigration(paths);
    const inspection = migration.inspect();
    expect(inspection.status).toBe("blocked");
    expect(inspection.diagnostics.some((diagnostic) => diagnostic.code === "MIGRATION_SOURCE_INVALID")).toBe(true);
    expect(() => migration.migrate()).toThrowError(PiIntegrationMigrationError);
    expect(existsSync(migration.markerPath)).toBe(false);
    expect(existsSync(join(paths.oldExtensionRoot, "approved", "fixture-extension", "revision-1", "index.js"))).toBe(true);
    expect(existsSync(paths.newMcpConfigPath)).toBe(false);
  });

  it("keeps legacy state retryable when a native target conflicts", () => {
    const paths = fixture();
    mkdirSync(join(paths.newExtensionRoot, "revision-1"), { recursive: true });
    writeFileSync(join(paths.newExtensionRoot, "revision-1", "index.js"), "different", "utf8");
    const migration = new PiIntegrationMigration(paths);
    expect(() => migration.migrate()).toThrowError(PiIntegrationMigrationError);
    expect(existsSync(migration.markerPath)).toBe(false);
    expect(readFileSync(join(paths.oldExtensionRoot, "global-revision.json"), "utf8")).toContain("revision-1");
    expect(readFileSync(join(paths.newExtensionRoot, "revision-1", "index.js"), "utf8")).toBe("different");
    expect(existsSync(paths.newMcpConfigPath)).toBe(false);
  });
});
