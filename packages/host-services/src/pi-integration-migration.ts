import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * The migration is deliberately a file-only Module. It never imports an
 * Extension entry point, starts a Worker, opens an MCP connection, or calls a
 * Provider. The only external effect is copying already-selected bytes and
 * writing the new native configuration.
 */

export const PI_INTEGRATION_MIGRATION_SCHEMA_VERSION = 1 as const;
export const PI_INTEGRATION_MIGRATION_MARKER = "pi-native-integration-migration.json" as const;

export interface PiIntegrationMigrationInput {
  /** Legacy ExtensionAdmission/GlobalRevision directory. */
  readonly oldExtensionRoot: string;
  /** Legacy McpIntegrationManager directory. */
  readonly oldMcpRoot: string;
  /** Legacy SkillPackageManager directory. */
  readonly oldSkillsRoot: string;
  /** App-owned Pi agent directory used by DefaultResourceLoader. */
  readonly newAgentDir: string;
  /** App-owned Pi Extension directory below `newAgentDir`. */
  readonly newExtensionRoot: string;
  /** App-owned MCP configuration consumed by pi-mcp-adapter. */
  readonly newMcpConfigPath: string;
  /** The only Skill directory supplied to Pi. */
  readonly newSkillsRoot: string;
  readonly now?: () => string;
}

export type PiIntegrationMigrationDiagnosticCode =
  | "MIGRATION_SOURCE_INVALID"
  | "MIGRATION_SOURCE_MISSING"
  | "MIGRATION_ARTIFACT_MISSING"
  | "MIGRATION_ARTIFACT_CHANGED"
  | "MIGRATION_DUPLICATE_IDENTITY"
  | "MIGRATION_UNSUPPORTED_MCP_TRANSPORT"
  | "MIGRATION_MCP_CONFIGURATION_INVALID"
  | "MIGRATION_TARGET_CONFLICT"
  | "MIGRATION_PATH_OVERLAP"
  | "MIGRATION_MARKER_INVALID"
  | "MIGRATION_MARKER_TARGET_MISSING"
  | "MIGRATION_BACKUP_FAILED"
  | "MIGRATION_COMMIT_FAILED";

export interface PiIntegrationMigrationDiagnostic {
  readonly code: PiIntegrationMigrationDiagnosticCode;
  readonly severity: "warning" | "error";
  readonly message: string;
  readonly path?: string;
}

export interface PiIntegrationExtensionPlan {
  readonly extensionId: string;
  readonly approvedRevisionId: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sourceIdentity: string;
}

export interface PiIntegrationMcpPlan {
  readonly serverId: string;
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly credentialEnvironmentVariable?: string;
  readonly configuration: Record<string, unknown>;
}

export interface PiIntegrationSkillPlan {
  readonly packageId: string;
  readonly revisionId: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sourceIdentity: string;
}

export interface PiIntegrationMigrationInspection {
  readonly schemaVersion: typeof PI_INTEGRATION_MIGRATION_SCHEMA_VERSION;
  readonly status: "ready" | "blocked" | "already_migrated";
  readonly markerPath: string;
  readonly backupPath?: string;
  readonly planHash: string;
  readonly extensions: readonly PiIntegrationExtensionPlan[];
  readonly mcpServers: readonly PiIntegrationMcpPlan[];
  readonly skills: readonly PiIntegrationSkillPlan[];
  readonly diagnostics: readonly PiIntegrationMigrationDiagnostic[];
}

export type PiIntegrationMigrationResult = Omit<PiIntegrationMigrationInspection, "status"> & {
  readonly status: "migrated" | "already_migrated";
  readonly backupPath: string;
  readonly migratedAt: string;
};

export type PiIntegrationMigrationErrorCode = PiIntegrationMigrationDiagnosticCode | "MIGRATION_NOT_READY";

export class PiIntegrationMigrationError extends Error {
  readonly code: PiIntegrationMigrationErrorCode;
  readonly diagnostics: readonly PiIntegrationMigrationDiagnostic[];

  constructor(code: PiIntegrationMigrationErrorCode, message: string, diagnostics: readonly PiIntegrationMigrationDiagnostic[] = []) {
    super(message);
    this.name = "PiIntegrationMigrationError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

interface NormalizedInput {
  readonly oldExtensionRoot: string;
  readonly oldMcpRoot: string;
  readonly oldSkillsRoot: string;
  readonly newAgentDir: string;
  readonly newExtensionRoot: string;
  readonly newMcpConfigPath: string;
  readonly newSkillsRoot: string;
}

interface MigrationMarker {
  readonly schemaVersion: typeof PI_INTEGRATION_MIGRATION_SCHEMA_VERSION;
  readonly sourceRoots: {
    readonly extensions: string;
    readonly mcp: string;
    readonly skills: string;
  };
  readonly destinations: {
    readonly agentDir: string;
    readonly extensions: string;
    readonly mcpConfig: string;
    readonly skills: string;
  };
  readonly planHash: string;
  readonly backupPath: string;
  readonly migratedAt: string;
  readonly extensions: readonly { readonly destinationPath: string; readonly sourceIdentity: string }[];
  readonly skills: readonly { readonly destinationPath: string; readonly sourceIdentity: string }[];
  readonly mcpConfigIdentity: string;
}

interface MigrationPlan {
  readonly extensions: readonly PiIntegrationExtensionPlan[];
  readonly mcpServers: readonly PiIntegrationMcpPlan[];
  readonly skills: readonly PiIntegrationSkillPlan[];
  readonly mcpConfig: Record<string, unknown>;
  readonly planHash: string;
  readonly diagnostics: readonly PiIntegrationMigrationDiagnostic[];
}

interface PersistedExtensionState {
  readonly schemaVersion?: unknown;
  readonly approved?: unknown;
}

interface PersistedGlobalExtensionState {
  readonly schemaVersion?: unknown;
  readonly effectiveExtensions?: unknown;
}

interface PersistedSkillState {
  readonly schemaVersion?: unknown;
  readonly packages?: unknown;
}

/**
 * One-shot, idempotent migration from the old Host-owned integration stores
 * to Pi-native Extension/MCP/Skill sources.
 */
export class PiIntegrationMigration {
  readonly #input: NormalizedInput;
  readonly #now: () => string;

  constructor(input: PiIntegrationMigrationInput) {
    this.#input = normalizeInput(input);
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  get markerPath(): string {
    return join(this.#input.newAgentDir, PI_INTEGRATION_MIGRATION_MARKER);
  }

  /**
   * Read and validate legacy state without writing files or touching external
   * resources. A blocked inspection is safe to display from settings/Doctor.
   */
  inspect(): PiIntegrationMigrationInspection {
    const marker = this.#readMarker();
    if (marker !== undefined) return this.#inspectMarker(marker);

    const plan = this.#buildPlan();
    return {
      schemaVersion: PI_INTEGRATION_MIGRATION_SCHEMA_VERSION,
      status: plan.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "blocked" : "ready",
      markerPath: this.markerPath,
      planHash: plan.planHash,
      extensions: plan.extensions,
      mcpServers: plan.mcpServers,
      skills: plan.skills,
      diagnostics: plan.diagnostics
    };
  }

  /**
   * Copy effective old state, create a backup, atomically publish the native
   * sources, and record a marker. A completed marker makes retries a no-op.
   */
  migrate(): PiIntegrationMigrationResult {
    const inspected = this.inspect();
    if (inspected.status === "already_migrated") {
      return {
        ...inspected,
        status: "already_migrated",
        backupPath: inspected.backupPath!,
        migratedAt: this.#readMarker()?.migratedAt ?? this.#now()
      };
    }
    if (inspected.status === "blocked") {
      throw new PiIntegrationMigrationError("MIGRATION_NOT_READY", "Pi integration migration is blocked by legacy state or target conflicts.", inspected.diagnostics);
    }

    const plan = this.#buildPlan();
    const stagingRoot = join(this.#input.newAgentDir, `.pi-integration-migration-${plan.planHash.slice(0, 16)}-${randomUUID()}`);
    const backupPath = join(this.#input.newAgentDir, "migration-backups", `${this.#now().replace(/[^0-9]/gu, "").slice(0, 14) || "unknown"}-${plan.planHash.slice(0, 16)}`);
    try {
      this.#stage(plan, stagingRoot);
      this.#createBackup(backupPath);
      this.#publish(plan, stagingRoot);
      const marker: MigrationMarker = {
        schemaVersion: PI_INTEGRATION_MIGRATION_SCHEMA_VERSION,
        sourceRoots: {
          extensions: this.#input.oldExtensionRoot,
          mcp: this.#input.oldMcpRoot,
          skills: this.#input.oldSkillsRoot
        },
        destinations: {
          agentDir: this.#input.newAgentDir,
          extensions: this.#input.newExtensionRoot,
          mcpConfig: this.#input.newMcpConfigPath,
          skills: this.#input.newSkillsRoot
        },
        planHash: plan.planHash,
        backupPath,
        migratedAt: this.#now(),
        extensions: plan.extensions.map((extension) => ({ destinationPath: extension.destinationPath, sourceIdentity: extension.sourceIdentity })),
        skills: plan.skills.map((skill) => ({ destinationPath: skill.destinationPath, sourceIdentity: skill.sourceIdentity })),
        mcpConfigIdentity: stableIdentity(plan.mcpConfig)
      };
      writeJsonAtomic(this.markerPath, marker);
      return {
        schemaVersion: PI_INTEGRATION_MIGRATION_SCHEMA_VERSION,
        status: "migrated",
        markerPath: this.markerPath,
        backupPath,
        planHash: plan.planHash,
        extensions: plan.extensions,
        mcpServers: plan.mcpServers,
        skills: plan.skills,
        diagnostics: plan.diagnostics,
        migratedAt: marker.migratedAt
      };
    } catch (error) {
      // Prior roots are never removed or modified. Partial destination data is
      // safe to retry because publish accepts only byte-identical targets.
      if (error instanceof PiIntegrationMigrationError) throw error;
      throw new PiIntegrationMigrationError("MIGRATION_COMMIT_FAILED", error instanceof Error ? error.message : "Pi integration migration failed.");
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  #buildPlan(): MigrationPlan {
    const diagnostics: PiIntegrationMigrationDiagnostic[] = [];
    const extensions = readEffectiveExtensions(this.#input, diagnostics);
    const mcpServers = readMcpServers(this.#input, diagnostics);
    const skills = readActiveSkills(this.#input, diagnostics);
    const mcpConfig: Record<string, unknown> = {
      mcpServers: Object.fromEntries(mcpServers.map((server) => [server.name, server.configuration]))
    };
    const planHash = stableIdentity({
      extensions: extensions.map((extension) => ({ id: extension.extensionId, revision: extension.approvedRevisionId, source: extension.sourceIdentity, destination: extension.destinationPath })),
      mcpConfig,
      skills: skills.map((skill) => ({ packageId: skill.packageId, revisionId: skill.revisionId, source: skill.sourceIdentity, destination: skill.destinationPath }))
    });
    return { extensions, mcpServers, skills, mcpConfig, planHash, diagnostics };
  }

  #stage(plan: MigrationPlan, stagingRoot: string): void {
    mkdirSync(stagingRoot, { recursive: true });
    const stagedExtensions = join(stagingRoot, "extensions");
    const stagedSkills = join(stagingRoot, "skills");
    for (const extension of plan.extensions) {
      const destination = join(stagedExtensions, basename(extension.destinationPath));
      copyTree(extension.sourcePath, destination, { rejectSymlinks: true });
      if (treeIdentity(destination) !== extension.sourceIdentity) throw new PiIntegrationMigrationError("MIGRATION_ARTIFACT_CHANGED", "An approved Extension changed while it was being migrated.", [{ code: "MIGRATION_ARTIFACT_CHANGED", severity: "error", message: "Approved Extension bytes changed during migration.", path: extension.sourcePath }]);
    }
    for (const skill of plan.skills) {
      const destination = join(stagedSkills, basename(skill.destinationPath));
      copyTree(skill.sourcePath, destination, { rejectSymlinks: false });
      if (treeIdentity(destination) !== skill.sourceIdentity) throw new PiIntegrationMigrationError("MIGRATION_ARTIFACT_CHANGED", "An active Skill changed while it was being migrated.", [{ code: "MIGRATION_ARTIFACT_CHANGED", severity: "error", message: "Active Skill bytes changed during migration.", path: skill.sourcePath }]);
    }
    writeJsonAtomic(join(stagingRoot, "mcp.json"), plan.mcpConfig);
  }

  #createBackup(backupPath: string): void {
    try {
      mkdirSync(backupPath, { recursive: true });
      const sources: readonly [string, string][] = [
        [this.#input.oldExtensionRoot, "extensions"],
        [this.#input.oldMcpRoot, "mcp"],
        [this.#input.oldSkillsRoot, "skills"]
      ];
      const presence: Record<string, boolean> = {};
      for (const [source, name] of sources) {
        const destination = join(backupPath, name);
        if (!existsSync(source)) {
          presence[name] = false;
          continue;
        }
        presence[name] = true;
        copyTree(source, destination, { rejectSymlinks: false });
      }
      // Legacy records only contain credential references, but a user-edited
      // state file may contain a token accidentally. Backups are migration
      // output too, so redact sensitive-looking fields before publishing it.
      const mcpBackupPath = join(backupPath, "mcp", "mcp-servers.json");
      const mcpBackup = readJsonFile(mcpBackupPath);
      if (mcpBackup !== undefined) writeJsonAtomic(mcpBackupPath, redactSensitive(mcpBackup));
      writeJsonAtomic(join(backupPath, "manifest.json"), {
        schemaVersion: PI_INTEGRATION_MIGRATION_SCHEMA_VERSION,
        sourceRoots: {
          extensions: this.#input.oldExtensionRoot,
          mcp: this.#input.oldMcpRoot,
          skills: this.#input.oldSkillsRoot
        },
        presence
      });
    } catch (error) {
      rmSync(backupPath, { recursive: true, force: true });
      throw new PiIntegrationMigrationError("MIGRATION_BACKUP_FAILED", error instanceof Error ? error.message : "Unable to create migration backup.");
    }
  }

  #publish(plan: MigrationPlan, stagingRoot: string): void {
    try {
      mkdirSync(this.#input.newExtensionRoot, { recursive: true });
      mkdirSync(this.#input.newSkillsRoot, { recursive: true });
      // Validate every existing destination before moving any staged bytes so
      // a conflict cannot leave a half-published native source set.
      for (const extension of plan.extensions) {
        if (existsSync(extension.destinationPath) && treeIdentity(extension.destinationPath) !== extension.sourceIdentity) {
          throw new PiIntegrationMigrationError("MIGRATION_TARGET_CONFLICT", "An app-owned resource target already contains different bytes.", [{ code: "MIGRATION_TARGET_CONFLICT", severity: "error", message: "Destination bytes differ from the selected legacy artifact.", path: extension.destinationPath }]);
        }
      }
      for (const skill of plan.skills) {
        if (existsSync(skill.destinationPath) && treeIdentity(skill.destinationPath) !== skill.sourceIdentity) {
          throw new PiIntegrationMigrationError("MIGRATION_TARGET_CONFLICT", "An app-owned resource target already contains different bytes.", [{ code: "MIGRATION_TARGET_CONFLICT", severity: "error", message: "Destination bytes differ from the selected legacy artifact.", path: skill.destinationPath }]);
        }
      }
      if (existsSync(this.#input.newMcpConfigPath)) {
        const existing = readJsonFile(this.#input.newMcpConfigPath);
        if (existing === undefined || stableIdentity(existing) !== stableIdentity(plan.mcpConfig)) {
          throw new PiIntegrationMigrationError("MIGRATION_TARGET_CONFLICT", "The app-owned MCP configuration already contains different data.", [{ code: "MIGRATION_TARGET_CONFLICT", severity: "error", message: "App-owned mcp.json differs from the migration result.", path: this.#input.newMcpConfigPath }]);
        }
      }
      for (const extension of plan.extensions) {
        const staged = join(stagingRoot, "extensions", basename(extension.destinationPath));
        publishTree(staged, extension.destinationPath, extension.sourceIdentity);
      }
      for (const skill of plan.skills) {
        const staged = join(stagingRoot, "skills", basename(skill.destinationPath));
        publishTree(staged, skill.destinationPath, skill.sourceIdentity);
      }
      const stagedMcp = join(stagingRoot, "mcp.json");
      if (!existsSync(this.#input.newMcpConfigPath)) {
        mkdirSync(dirname(this.#input.newMcpConfigPath), { recursive: true });
        renameSync(stagedMcp, this.#input.newMcpConfigPath);
      }
    } catch (error) {
      if (error instanceof PiIntegrationMigrationError) throw error;
      throw new PiIntegrationMigrationError("MIGRATION_COMMIT_FAILED", error instanceof Error ? error.message : "Unable to publish migrated resources.");
    }
  }

  #readMarker(): MigrationMarker | undefined {
    if (!existsSync(this.markerPath)) return undefined;
    const marker = readJsonFile(this.markerPath);
    if (!isMigrationMarker(marker)) {
      throw new PiIntegrationMigrationError("MIGRATION_MARKER_INVALID", "The Pi integration migration marker is malformed.", [{ code: "MIGRATION_MARKER_INVALID", severity: "error", message: "Migration marker is not a valid schema version 1 marker.", path: this.markerPath }]);
    }
    return marker;
  }

  #inspectMarker(marker: MigrationMarker): PiIntegrationMigrationInspection {
    const inputMatches = marker.sourceRoots.extensions === this.#input.oldExtensionRoot
      && marker.sourceRoots.mcp === this.#input.oldMcpRoot
      && marker.sourceRoots.skills === this.#input.oldSkillsRoot
      && marker.destinations.agentDir === this.#input.newAgentDir
      && marker.destinations.extensions === this.#input.newExtensionRoot
      && marker.destinations.mcpConfig === this.#input.newMcpConfigPath
      && marker.destinations.skills === this.#input.newSkillsRoot;
    const diagnostics: PiIntegrationMigrationDiagnostic[] = [];
    if (!inputMatches) diagnostics.push({ code: "MIGRATION_MARKER_INVALID", severity: "error", message: "Migration marker belongs to a different source or destination set.", path: this.markerPath });
    if (!existsSync(marker.backupPath)) diagnostics.push({ code: "MIGRATION_MARKER_TARGET_MISSING", severity: "error", message: "The migration backup referenced by the marker is unavailable.", path: marker.backupPath });
    for (const output of marker.extensions) {
      if (!existsSync(output.destinationPath) || treeIdentity(output.destinationPath) !== output.sourceIdentity) diagnostics.push({ code: "MIGRATION_MARKER_TARGET_MISSING", severity: "error", message: "A migrated Extension target is unavailable or changed.", path: output.destinationPath });
    }
    for (const output of marker.skills) {
      if (!existsSync(output.destinationPath) || treeIdentity(output.destinationPath) !== output.sourceIdentity) diagnostics.push({ code: "MIGRATION_MARKER_TARGET_MISSING", severity: "error", message: "A migrated Skill target is unavailable or changed.", path: output.destinationPath });
    }
    if (!existsSync(marker.destinations.mcpConfig)) diagnostics.push({ code: "MIGRATION_MARKER_TARGET_MISSING", severity: "error", message: "Migrated mcp.json is unavailable.", path: marker.destinations.mcpConfig });
    else {
      const config = readJsonFile(marker.destinations.mcpConfig);
      if (config === undefined || stableIdentity(config) !== marker.mcpConfigIdentity) diagnostics.push({ code: "MIGRATION_MARKER_TARGET_MISSING", severity: "error", message: "Migrated mcp.json changed after migration.", path: marker.destinations.mcpConfig });
    }
    return {
      schemaVersion: PI_INTEGRATION_MIGRATION_SCHEMA_VERSION,
      status: diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "blocked" : "already_migrated",
      markerPath: this.markerPath,
      backupPath: marker.backupPath,
      planHash: marker.planHash,
      extensions: marker.extensions.map((item) => ({ extensionId: basename(item.destinationPath), approvedRevisionId: basename(item.destinationPath), sourcePath: "<migrated>", destinationPath: item.destinationPath, sourceIdentity: item.sourceIdentity })),
      mcpServers: [],
      skills: marker.skills.map((item) => ({ packageId: basename(item.destinationPath), revisionId: "<migrated>", sourcePath: "<migrated>", destinationPath: item.destinationPath, sourceIdentity: item.sourceIdentity })),
      diagnostics
    };
  }
}

function normalizeInput(input: PiIntegrationMigrationInput): NormalizedInput {
  const result: NormalizedInput = {
    oldExtensionRoot: resolveRequired(input.oldExtensionRoot, "oldExtensionRoot"),
    oldMcpRoot: resolveRequired(input.oldMcpRoot, "oldMcpRoot"),
    oldSkillsRoot: resolveRequired(input.oldSkillsRoot, "oldSkillsRoot"),
    newAgentDir: resolveRequired(input.newAgentDir, "newAgentDir"),
    newExtensionRoot: resolveRequired(input.newExtensionRoot, "newExtensionRoot"),
    newMcpConfigPath: resolveRequired(input.newMcpConfigPath, "newMcpConfigPath"),
    newSkillsRoot: resolveRequired(input.newSkillsRoot, "newSkillsRoot")
  };
  if (!isWithin(result.newAgentDir, result.newExtensionRoot) || !isWithin(result.newAgentDir, result.newSkillsRoot) || !isWithin(result.newAgentDir, dirname(result.newMcpConfigPath))) {
    throw new PiIntegrationMigrationError("MIGRATION_PATH_OVERLAP", "Pi-native destinations must remain below the app-owned agent directory.");
  }
  const oldRoots = [result.oldExtensionRoot, result.oldMcpRoot, result.oldSkillsRoot];
  const newRoots = [result.newExtensionRoot, result.newSkillsRoot, dirname(result.newMcpConfigPath)];
  if (oldRoots.some((oldRoot) => existsSync(oldRoot) && newRoots.some((newRoot) => isWithin(oldRoot, newRoot) || isWithin(newRoot, oldRoot)))) {
    throw new PiIntegrationMigrationError("MIGRATION_PATH_OVERLAP", "Legacy and Pi-native migration paths overlap.");
  }
  return result;
}

function resolveRequired(value: string, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new PiIntegrationMigrationError("MIGRATION_PATH_OVERLAP", `Migration path ${name} is required.`);
  return resolve(value);
}

function readEffectiveExtensions(input: NormalizedInput, diagnostics: PiIntegrationMigrationDiagnostic[]): PiIntegrationExtensionPlan[] {
  const statePath = join(input.oldExtensionRoot, "state.json");
  const globalPath = join(input.oldExtensionRoot, "global-revision.json");
  const state = readJsonFile(statePath) as PersistedExtensionState | undefined;
  const global = readJsonFile(globalPath) as PersistedGlobalExtensionState | undefined;
  if (existsSync(statePath) && state === undefined) diagnostics.push({ code: "MIGRATION_SOURCE_INVALID", severity: "error", message: "Legacy Extension admission state is not valid JSON.", path: statePath });
  if (existsSync(globalPath) && global === undefined) diagnostics.push({ code: "MIGRATION_SOURCE_INVALID", severity: "error", message: "Legacy Extension revision state is not valid JSON.", path: globalPath });
  if (state === undefined && global === undefined) return [];
  if (state !== undefined && state.schemaVersion !== 1) diagnostics.push({ code: "MIGRATION_SOURCE_INVALID", severity: "error", message: "Legacy Extension admission state has an unsupported schema.", path: join(input.oldExtensionRoot, "state.json") });
  if (global !== undefined && global.schemaVersion !== 1) diagnostics.push({ code: "MIGRATION_SOURCE_INVALID", severity: "error", message: "Legacy Extension revision state has an unsupported schema.", path: join(input.oldExtensionRoot, "global-revision.json") });
  const approved = new Map<string, Record<string, unknown>>();
  for (const item of asObjectArray(state?.approved)) {
    const revision = stringValue(item.approvedRevisionId);
    if (revision !== undefined) approved.set(revision, item);
  }
  const result: PiIntegrationExtensionPlan[] = [];
  const seenIds = new Set<string>();
  for (const entry of asObjectArray(global?.effectiveExtensions)) {
    const revision = stringValue(entry.approvedRevisionId);
    const extensionId = stringValue(entry.extensionId);
    if (revision === undefined || extensionId === undefined) {
      diagnostics.push({ code: "MIGRATION_SOURCE_INVALID", severity: "error", message: "Effective Extension identity is incomplete.", path: join(input.oldExtensionRoot, "global-revision.json") });
      continue;
    }
    if (seenIds.has(extensionId)) {
      diagnostics.push({ code: "MIGRATION_DUPLICATE_IDENTITY", severity: "error", message: `Effective Extension identity "${extensionId}" appears more than once.` });
      continue;
    }
    seenIds.add(extensionId);
    const artifact = approved.get(revision);
    const sourcePath = stringValue(artifact?.approvedPath);
    if (artifact === undefined || sourcePath === undefined || !isWithin(input.oldExtensionRoot, sourcePath) || !existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
      diagnostics.push({ code: "MIGRATION_ARTIFACT_MISSING", severity: "error", message: `Effective Extension "${extensionId}" artifact is unavailable.`, path: sourcePath ?? input.oldExtensionRoot });
      continue;
    }
    if (artifact.invalidated === true) {
      diagnostics.push({ code: "MIGRATION_ARTIFACT_CHANGED", severity: "error", message: `Effective Extension "${extensionId}" is invalidated.` });
      continue;
    }
    const destinationPath = join(input.newExtensionRoot, safeDestinationSegment(revision));
    result.push({ extensionId, approvedRevisionId: revision, sourcePath: resolve(sourcePath), destinationPath, sourceIdentity: treeIdentity(sourcePath) });
  }
  return result.sort((left, right) => left.extensionId.localeCompare(right.extensionId));
}

function readMcpServers(input: NormalizedInput, diagnostics: PiIntegrationMigrationDiagnostic[]): PiIntegrationMcpPlan[] {
  const path = join(input.oldMcpRoot, "mcp-servers.json");
  const state = readJsonFile(path);
  if (existsSync(path) && state === undefined) {
    diagnostics.push({ code: "MIGRATION_SOURCE_INVALID", severity: "error", message: "Legacy MCP state is not valid JSON.", path });
    return [];
  }
  if (state === undefined) return [];
  if (state.schemaVersion !== 1 || !Array.isArray(state.servers)) {
    diagnostics.push({ code: "MIGRATION_SOURCE_INVALID", severity: "error", message: "Legacy MCP state has an unsupported schema.", path });
    return [];
  }
  const result: PiIntegrationMcpPlan[] = [];
  const seenNames = new Set<string>();
  for (const raw of state.servers) {
    const server = asObject(raw);
    if (server?.enabled !== true) continue;
    const serverId = stringValue(server.serverId);
    const name = stringValue(server.name)?.trim() || serverId;
    const transport = server.transport;
    if (serverId === undefined || name === undefined || name === "") {
      diagnostics.push({ code: "MIGRATION_MCP_CONFIGURATION_INVALID", severity: "error", message: "An enabled MCP server has incomplete identity.", path });
      continue;
    }
    if (seenNames.has(name)) {
      diagnostics.push({ code: "MIGRATION_DUPLICATE_IDENTITY", severity: "error", message: `Enabled MCP server name "${name}" appears more than once.` });
      continue;
    }
    seenNames.add(name);
    const configuration: Record<string, unknown> = {};
    let normalizedTransport: "stdio" | "http";
    if (transport === "stdio") {
      const command = stringValue(server.command);
      if (command === undefined || command.trim() === "") {
        diagnostics.push({ code: "MIGRATION_MCP_CONFIGURATION_INVALID", severity: "error", message: `Enabled MCP server "${name}" has no stdio command.` });
        continue;
      }
      normalizedTransport = "stdio";
      configuration.command = command;
      if (Array.isArray(server.args)) configuration.args = server.args.filter((value): value is string => typeof value === "string");
      if (stringValue(server.workingDirectory) !== undefined) configuration.cwd = stringValue(server.workingDirectory);
    } else if (transport === "http") {
      const endpoint = stringValue(server.endpoint);
      if (endpoint === undefined || endpoint.trim() === "") {
        diagnostics.push({ code: "MIGRATION_MCP_CONFIGURATION_INVALID", severity: "error", message: `Enabled MCP server "${name}" has no HTTP endpoint.` });
        continue;
      }
      normalizedTransport = "http";
      configuration.url = endpoint;
    } else {
      diagnostics.push({ code: "MIGRATION_UNSUPPORTED_MCP_TRANSPORT", severity: "error", message: `Enabled MCP server "${name}" uses a transport unsupported by pi-mcp-adapter.` });
      continue;
    }
    const credentialRef = stringValue(server.credentialRef);
    const credentialEnvironmentVariable = credentialRef === undefined ? undefined : credentialEnvironmentVariableFor(credentialRef, serverId);
    if (credentialEnvironmentVariable !== undefined) {
      if (normalizedTransport === "http") {
        configuration.auth = "bearer";
        configuration.bearerTokenEnv = credentialEnvironmentVariable;
      } else {
        configuration.env = { [credentialEnvironmentVariable]: `\${${credentialEnvironmentVariable}}` };
      }
    }
    result.push({ serverId, name, transport: normalizedTransport, ...(credentialEnvironmentVariable === undefined ? {} : { credentialEnvironmentVariable }), configuration });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

function readActiveSkills(input: NormalizedInput, diagnostics: PiIntegrationMigrationDiagnostic[]): PiIntegrationSkillPlan[] {
  const path = join(input.oldSkillsRoot, "inventory.json");
  const state = readJsonFile(path) as PersistedSkillState | undefined;
  if (existsSync(path) && state === undefined) {
    diagnostics.push({ code: "MIGRATION_SOURCE_INVALID", severity: "error", message: "Legacy Skills inventory is not valid JSON.", path });
    return [];
  }
  if (state === undefined) return [];
  if (state.schemaVersion !== 1 || !Array.isArray(state.packages)) {
    diagnostics.push({ code: "MIGRATION_SOURCE_INVALID", severity: "error", message: "Legacy Skills inventory has an unsupported schema.", path });
    return [];
  }
  const result: PiIntegrationSkillPlan[] = [];
  const seenPackages = new Set<string>();
  for (const raw of state.packages) {
    const item = asObject(raw);
    if (item?.enabled !== true || item.state !== "active") continue;
    const packageId = stringValue(item.packageId);
    const revisionId = stringValue(item.revisionId);
    if (packageId === undefined || revisionId === undefined) {
      diagnostics.push({ code: "MIGRATION_SOURCE_INVALID", severity: "error", message: "An active Skill identity is incomplete.", path });
      continue;
    }
    if (seenPackages.has(packageId)) {
      diagnostics.push({ code: "MIGRATION_DUPLICATE_IDENTITY", severity: "error", message: `Active Skill package "${packageId}" appears more than once.` });
      continue;
    }
    seenPackages.add(packageId);
    const sourcePath = join(input.oldSkillsRoot, "active", packageId, revisionId);
    if (!isWithin(input.oldSkillsRoot, sourcePath) || !existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
      diagnostics.push({ code: "MIGRATION_ARTIFACT_MISSING", severity: "error", message: `Active Skill package "${packageId}" is unavailable.`, path: sourcePath });
      continue;
    }
    const sourceIdentity = treeIdentity(sourcePath);
    if (typeof item.activeHash === "string" && item.activeHash !== legacySkillIdentity(sourcePath)) {
      diagnostics.push({ code: "MIGRATION_ARTIFACT_CHANGED", severity: "error", message: `Active Skill package "${packageId}" no longer matches its inventory hash.`, path: sourcePath });
      continue;
    }
    result.push({ packageId, revisionId, sourcePath: resolve(sourcePath), destinationPath: join(input.newSkillsRoot, safeDestinationSegment(packageId)), sourceIdentity });
  }
  return result.sort((left, right) => left.packageId.localeCompare(right.packageId));
}

function publishTree(staged: string, destination: string, expectedIdentity: string): void {
  if (existsSync(destination)) {
    if (treeIdentity(destination) !== expectedIdentity) throw new PiIntegrationMigrationError("MIGRATION_TARGET_CONFLICT", "An app-owned resource target already contains different bytes.", [{ code: "MIGRATION_TARGET_CONFLICT", severity: "error", message: "Destination bytes differ from the selected legacy artifact.", path: destination }]);
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(staged, destination);
}

function copyTree(source: string, destination: string, options: { readonly rejectSymlinks: boolean }): void {
  const canonicalSourceRoot = canonicalExisting(source);
  if (canonicalSourceRoot === undefined) throw new Error("source unavailable");
  const sourceRoot = canonicalSourceRoot;
  mkdirSync(destination, { recursive: true });
  const active = new Set<string>();
  walk(source, destination);

  function walk(current: string, target: string): void {
    const canonicalCurrent = canonicalExisting(current);
    if (canonicalCurrent === undefined || !isWithin(sourceRoot, canonicalCurrent)) throw new Error("source path escapes root");
    if (active.has(canonicalCurrent)) throw new Error("source symlink cycle");
    active.add(canonicalCurrent);
    try {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const sourcePath = join(current, entry.name);
        const targetPath = join(target, entry.name);
        const information = lstatSync(sourcePath);
        if (information.isSymbolicLink()) {
          if (options.rejectSymlinks) throw new Error("symlink is not allowed");
          const canonicalLinked = canonicalExisting(sourcePath);
          if (canonicalLinked === undefined) throw new Error("symlink escapes root");
          if (!isWithin(sourceRoot, canonicalLinked)) throw new Error("symlink escapes root");
          const linked = canonicalLinked;
          const linkedStats = statSync(linked);
          if (linkedStats.isDirectory()) {
            mkdirSync(targetPath, { recursive: true });
            walk(linked, targetPath);
          } else if (linkedStats.isFile()) {
            mkdirSync(dirname(targetPath), { recursive: true });
            copyFileSync(linked, targetPath);
          } else throw new Error("special file is not allowed");
        } else if (information.isDirectory()) {
          mkdirSync(targetPath, { recursive: true });
          walk(sourcePath, targetPath);
        } else if (information.isFile()) {
          mkdirSync(dirname(targetPath), { recursive: true });
          copyFileSync(sourcePath, targetPath);
        } else throw new Error("special file is not allowed");
      }
    } finally {
      active.delete(canonicalCurrent);
    }
  }
}

function treeIdentity(root: string): string {
  const canonical = canonicalExisting(root);
  if (canonical === undefined) throw new Error("resource unavailable");
  const files: string[] = [];
  collectFiles(canonical, canonical, files);
  const hash = createHash("sha256");
  for (const path of files.sort((left, right) => left.localeCompare(right))) {
    hash.update(path.replaceAll(sep, "/"), "utf8");
    hash.update("\0", "utf8");
    hash.update(readFileSync(join(canonical, path)));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

/** Matches SkillPackageManager's legacy activeHash algorithm. */
function legacySkillIdentity(root: string): string {
  const canonical = canonicalExisting(root);
  if (canonical === undefined) throw new Error("resource unavailable");
  const files: string[] = [];
  collectFiles(canonical, canonical, files);
  const hash = createHash("sha256");
  for (const path of files.sort((left, right) => left.localeCompare(right))) {
    hash.update(path.replaceAll(sep, "/"), "utf8");
    hash.update(readFileSync(join(canonical, path)));
  }
  return hash.digest("hex");
}

function collectFiles(root: string, current: string, files: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const information = lstatSync(path);
    if (information.isSymbolicLink()) {
      const linked = canonicalExisting(path);
      if (linked === undefined || !isWithin(root, linked)) throw new Error("resource symlink escapes root");
      const linkedStats = statSync(linked);
      if (linkedStats.isDirectory()) collectFiles(root, linked, files);
      else if (linkedStats.isFile()) files.push(relative(root, path));
      else throw new Error("special file is not allowed");
    } else if (information.isDirectory()) collectFiles(root, path, files);
    else if (information.isFile()) files.push(relative(root, path));
    else throw new Error("special file is not allowed");
  }
}

function canonicalExisting(path: string): string | undefined {
  try { return realpathSync.native(path); } catch { try { return realpathSync(path); } catch { return undefined; } }
}

function safeDestinationSegment(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/gu, "_");
  if (normalized === "" || normalized === "." || normalized === "..") throw new Error("unsafe destination segment");
  return normalized.slice(0, 96);
}

function credentialEnvironmentVariableFor(reference: string, serverId: string): string {
  const explicit = /^(?:env|environment):([A-Za-z_][A-Za-z0-9_]*)$/u.exec(reference.trim());
  if (explicit?.[1] !== undefined) return explicit[1];
  return `VC_AGENT_MCP_CREDENTIAL_${createHash("sha256").update(serverId, "utf8").digest("hex").slice(0, 16).toUpperCase()}`;
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep);
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return asObject(value);
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asObjectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item) => { const object = asObject(item); return object === undefined ? [] : [object]; }) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stableIdentity(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${randomUUID()}.partial`;
  writeFileSync(partial, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(partial, path);
}

function redactSensitive(value: unknown, key?: string): unknown {
  if (key !== undefined && /(?:credential|token|secret|password|api[-_]?key)/iu.test(key)) return "<redacted>";
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(object).map(([childKey, childValue]) => [childKey, redactSensitive(childValue, childKey)]));
  }
  return value;
}

function isMigrationMarker(value: unknown): value is MigrationMarker {
  const object = asObject(value);
  if (object === undefined || object.schemaVersion !== PI_INTEGRATION_MIGRATION_SCHEMA_VERSION) return false;
  const sourceRoots = asObject(object.sourceRoots);
  const destinations = asObject(object.destinations);
  return sourceRoots !== undefined && destinations !== undefined
    && typeof sourceRoots.extensions === "string" && typeof sourceRoots.mcp === "string" && typeof sourceRoots.skills === "string"
    && typeof destinations.agentDir === "string" && typeof destinations.extensions === "string" && typeof destinations.mcpConfig === "string" && typeof destinations.skills === "string"
    && typeof object.planHash === "string" && typeof object.backupPath === "string" && typeof object.migratedAt === "string"
    && Array.isArray(object.extensions) && Array.isArray(object.skills) && typeof object.mcpConfigIdentity === "string";
}
