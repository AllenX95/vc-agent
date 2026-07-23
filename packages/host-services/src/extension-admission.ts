import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { ExtensionInventorySnapshot } from "@vc-agent/contracts";
import { BoundedExecutionScheduler } from "./execution-scheduler.js";
import { LocalJobSupervisor, type LocalJobManifest } from "./agent-runtime-supervisor.js";

const LOCKFILE_NAMES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json"] as const;
const LIFECYCLE_SCRIPT_NAMES = new Set(["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly", "publish", "postpublish"]);
const NATIVE_EXTENSIONS = new Set([".node", ".dll", ".dylib", ".so", ".exe"]);
const ENTRY_FIELDS = ["main", "module", "browser", "types", "typings"] as const;

export type ExtensionAdmissionErrorCode =
  | "EXTENSION_STAGE_FAILED"
  | "EXTENSION_IDENTITY_INCOMPLETE"
  | "EXTENSION_INTEGRITY_FAILED"
  | "EXTENSION_DEPENDENCY_UNRESOLVED"
  | "EXTENSION_ADMISSION_BLOCKED"
  | "EXTENSION_AUDIT_PROFILE_MISSING"
  | "EXTENSION_AUDIT_FAILED"
  | "EXTENSION_AUDIT_CAPACITY_UNAVAILABLE"
  | "EXTENSION_APPROVAL_MISMATCH"
  | "EXTENSION_NOT_APPROVED"
  | "EXTENSION_ARTIFACT_CHANGED"
  | "EXTENSION_REVISION_CONFLICT"
  | "EXTENSION_ROLLBACK_UNAVAILABLE";

export class ExtensionAdmissionError extends Error {
  readonly code: ExtensionAdmissionErrorCode;

  constructor(code: ExtensionAdmissionErrorCode, message: string = code) {
    super(message);
    this.name = "ExtensionAdmissionError";
    this.code = code;
  }
}

export interface LocalExtensionStageRequest {
  readonly sourcePath: string;
  readonly extensionId?: string;
  readonly name?: string;
  readonly sourceRevision?: string;
}

export interface StagedExtension {
  readonly schemaVersion: 1;
  readonly stagedRevisionId: string;
  readonly extensionId: string;
  readonly name: string;
  readonly sourceRevision?: string;
  readonly stagedPath: string;
  readonly artifactHash: string;
  readonly fileCount: number;
  readonly state: "staged" | "inspecting" | "reviewable" | "blocked" | "audit_running" | "audit_paused" | "audit_complete" | "awaiting_user_decision" | "approved_disabled" | "rejected" | "invalidated";
  readonly createdAt: string;
}

export interface ExtensionFileInventory {
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
}

export interface ExtensionFinding {
  readonly id: string;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly category: "identity" | "integrity" | "dependency" | "lifecycle" | "native" | "permission" | "license" | "vulnerability" | "audit" | "coverage";
  readonly message: string;
  readonly source: "deterministic" | "audit";
  readonly overridable: boolean;
}

export interface DeterministicInspectionReport {
  readonly schemaVersion: 1;
  readonly reportId: string;
  readonly stagedRevisionId: string;
  readonly artifactHash: string;
  readonly dependencyClosureHash: string;
  readonly identity: {
    readonly extensionId: string;
    readonly name: string;
    readonly version?: string;
    readonly sourceRevision?: string;
  };
  readonly files: readonly ExtensionFileInventory[];
  readonly lockfile?: { readonly name: string; readonly sha256: string };
  readonly entryPoints: readonly string[];
  readonly lifecycleScripts: readonly string[];
  readonly nativeBinaries: readonly string[];
  readonly requestedPermissions: readonly string[];
  readonly licenses: readonly string[];
  readonly vulnerabilities: readonly string[];
  readonly findings: readonly ExtensionFinding[];
  readonly blockers: readonly string[];
  readonly gaps: readonly string[];
  readonly status: "reviewable" | "blocked";
  readonly generatedAt: string;
}

export interface ExtensionAuditRequest {
  readonly stagedRevisionId: string;
  readonly profileId?: string;
  readonly instructionsRevision?: string;
  readonly providerAvailable?: boolean;
}

export interface ExtensionAuditInput {
  readonly auditRunId: string;
  readonly stagedRevisionId: string;
  readonly stagedArtifactPath: string;
  readonly deterministicReport: DeterministicInspectionReport;
  readonly instructionsRevision: string;
}

export interface ExtensionAuditResult {
  readonly summary: string;
  readonly findings: readonly { readonly severity: "low" | "medium" | "high" | "critical"; readonly message: string }[];
  readonly residualRisk: readonly string[];
  readonly limitations: readonly string[];
}

export interface ExtensionAuditAdapter {
  review(input: ExtensionAuditInput, signal: AbortSignal): Promise<ExtensionAuditResult>;
}

export interface ExtensionAuditRun {
  readonly schemaVersion: 1;
  readonly auditRunId: string;
  readonly stagedRevisionId: string;
  readonly status: "audit_running" | "audit_paused" | "audit_complete" | "audit_failed";
  readonly assignmentKind: "extension_audit" | "explicit_profile_override";
  readonly profileId?: string;
  readonly deterministicReportId: string;
  readonly modelReview?: ExtensionAuditResult;
  readonly failureCode?: "EXTENSION_AUDIT_PROFILE_MISSING" | "EXTENSION_AUDIT_FAILED" | "EXTENSION_AUDIT_CAPACITY_UNAVAILABLE";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExtensionApprovalRequest {
  readonly stagedRevisionId: string;
  readonly reportId: string;
  readonly expectedArtifactHash: string;
  readonly acceptedFindingIds?: readonly string[];
  readonly userConfirmed: true;
}

export interface ApprovedExtensionRevision {
  readonly schemaVersion: 1;
  readonly extensionId: string;
  readonly approvedRevisionId: string;
  readonly stagedRevisionId: string;
  readonly name: string;
  readonly version: string;
  readonly approvedPath: string;
  readonly artifactHash: string;
  readonly dependencyClosureHash: string;
  readonly entryPoints: readonly string[];
  readonly requestedPermissions: readonly string[];
  readonly enabled: false;
  readonly invalidated: boolean;
  readonly trustDisclosure: "Trusted Worker Code: direct process behavior cannot be fully mediated by Standard Access.";
  readonly approvedAt: string;
}

interface PersistedAdmissionState {
  readonly schemaVersion: 1;
  readonly staged: StagedExtension[];
  readonly reports: DeterministicInspectionReport[];
  readonly audits: ExtensionAuditRun[];
  readonly approved: ApprovedExtensionRevision[];
}

export interface ExtensionAdmissionSnapshot {
  readonly staged: readonly StagedExtension[];
  readonly reports: readonly DeterministicInspectionReport[];
  readonly audits: readonly ExtensionAuditRun[];
  readonly approved: readonly ApprovedExtensionRevision[];
}

/**
 * Host-owned Extension admission. Every operation before approval is file
 * inspection only; no staged path is given to Pi or an Agent Worker.
 */
export class ExtensionAdmissionManager {
  readonly #root: string;
  readonly #stagedRoot: string;
  readonly #approvedRoot: string;
  readonly #reportsRoot: string;
  readonly #auditRoot: string;
  readonly #scheduler: BoundedExecutionScheduler | undefined;
  readonly #auditAdapter: ExtensionAuditAdapter | undefined;
  readonly #now: () => string;
  readonly #staged = new Map<string, StagedExtension>();
  readonly #reports = new Map<string, DeterministicInspectionReport>();
  readonly #audits = new Map<string, ExtensionAuditRun>();
  readonly #approved = new Map<string, ApprovedExtensionRevision>();
  readonly #auditReviews = new Map<string, ExtensionAuditResult>();
  readonly #auditJobs: LocalJobSupervisor;

  constructor(input: { root: string; scheduler?: BoundedExecutionScheduler; auditAdapter?: ExtensionAuditAdapter; now?: () => string }) {
    this.#root = resolve(input.root);
    this.#stagedRoot = join(this.#root, "staged");
    this.#approvedRoot = join(this.#root, "approved");
    this.#reportsRoot = join(this.#root, "reports");
    this.#auditRoot = join(this.#root, "audit-work");
    this.#scheduler = input.scheduler;
    this.#auditAdapter = input.auditAdapter;
    this.#now = input.now ?? (() => new Date().toISOString());
    this.#auditJobs = new LocalJobSupervisor({ capacity: 1, adapter: { run: (manifest, signal) => this.runAuditJob(manifest, signal) } });
    this.load();
  }

  async stage(request: LocalExtensionStageRequest): Promise<StagedExtension> {
    const sourcePath = resolve(request.sourcePath);
    if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) throw new ExtensionAdmissionError("EXTENSION_STAGE_FAILED", "The selected Extension directory is unavailable.");
    const stagedRevisionId = randomUUID();
    const destination = join(this.#stagedRoot, stagedRevisionId, "artifact");
    try {
      copyDirectoryWithoutExecution(sourcePath, destination);
      const files = inventoryDirectory(destination);
      if (files.length === 0) throw new Error("The Extension artifact is empty.");
      const packageJson = readPackageJson(destination);
      const extensionId = request.extensionId ?? (typeof packageJson?.name === "string" ? packageJson.name : "");
      const name = request.name ?? (typeof packageJson?.name === "string" ? packageJson.name : "");
      const staged: StagedExtension = {
        schemaVersion: 1, stagedRevisionId, extensionId, name,
        ...(request.sourceRevision === undefined ? {} : { sourceRevision: request.sourceRevision }),
        stagedPath: destination, artifactHash: hashInventory(files), fileCount: files.length, state: "staged", createdAt: this.#now()
      };
      this.#staged.set(stagedRevisionId, staged);
      this.save();
      return cloneStaged(staged);
    } catch (error) {
      rmSync(join(this.#stagedRoot, stagedRevisionId), { recursive: true, force: true });
      if (error instanceof ExtensionAdmissionError) throw error;
      throw new ExtensionAdmissionError("EXTENSION_STAGE_FAILED", error instanceof Error ? error.message : "Extension staging failed.");
    }
  }

  async inspect(stagedRevisionId: string): Promise<DeterministicInspectionReport> {
    const staged = this.requireStaged(stagedRevisionId);
    const inspecting: StagedExtension = { ...staged, state: "inspecting" };
    this.#staged.set(stagedRevisionId, inspecting);
    const report = buildInspection(inspecting, this.#now());
    this.#reports.set(report.reportId, report);
    this.#staged.set(stagedRevisionId, { ...inspecting, state: report.status === "blocked" ? "blocked" : "reviewable" });
    this.save();
    return cloneReport(report);
  }

  async startAudit(request: ExtensionAuditRequest): Promise<ExtensionAuditRun> {
    const staged = this.requireStaged(request.stagedRevisionId);
    const report = this.latestReportFor(staged.stagedRevisionId);
    if (report === undefined) throw new ExtensionAdmissionError("EXTENSION_ADMISSION_BLOCKED", "Deterministic inspection is required before Extension Audit.");
    const auditRunId = randomUUID();
    const assignmentKind = request.profileId === undefined ? "extension_audit" : "explicit_profile_override";
    const base: ExtensionAuditRun = {
      schemaVersion: 1, auditRunId, stagedRevisionId: staged.stagedRevisionId, status: "audit_running", assignmentKind,
      ...(request.profileId === undefined ? {} : { profileId: request.profileId }), deterministicReportId: report.reportId,
      createdAt: this.#now(), updatedAt: this.#now()
    };
    if (request.profileId === undefined || request.providerAvailable === false) {
      const paused: ExtensionAuditRun = { ...base, status: "audit_paused", failureCode: "EXTENSION_AUDIT_PROFILE_MISSING", updatedAt: this.#now() };
      this.#audits.set(auditRunId, paused);
      this.#staged.set(staged.stagedRevisionId, { ...staged, state: "audit_paused" });
      this.save();
      return cloneAudit(paused);
    }
    if (this.#auditAdapter === undefined) {
      const failed: ExtensionAuditRun = { ...base, status: "audit_failed", failureCode: "EXTENSION_AUDIT_FAILED", updatedAt: this.#now() };
      this.#audits.set(auditRunId, failed);
      this.#staged.set(staged.stagedRevisionId, { ...staged, state: "audit_paused" });
      this.save();
      return cloneAudit(failed);
    }
    const leaseId = "extension-audit:" + auditRunId;
    const admission = this.#scheduler?.admit({ id: leaseId, scopeKey: "extension-audit:" + staged.stagedRevisionId, kind: "extension_audit" });
    if (admission !== undefined && !admission.admitted) {
      const paused: ExtensionAuditRun = { ...base, status: "audit_paused", failureCode: "EXTENSION_AUDIT_CAPACITY_UNAVAILABLE", updatedAt: this.#now() };
      this.#audits.set(auditRunId, paused);
      this.#staged.set(staged.stagedRevisionId, { ...staged, state: "audit_paused" });
      this.save();
      return cloneAudit(paused);
    }
    this.#audits.set(auditRunId, base);
    this.#staged.set(staged.stagedRevisionId, { ...staged, state: "audit_running" });
    this.save();
    const instructionsRevision = request.instructionsRevision ?? "extension-audit-instructions-v1";
    const manifest: LocalJobManifest = {
      jobId: auditRunId, kind: "isolated", stagingDirectory: join(this.#auditRoot, auditRunId), inputPaths: [staged.stagedPath], outputPaths: [join(this.#auditRoot, auditRunId, "report.json")], timeoutMs: 120_000, maxOutputBytes: 200_000,
      metadata: { auditRunId, stagedRevisionId: staged.stagedRevisionId, instructionsRevision }
    };
    const result = await this.#auditJobs.submit(manifest);
    this.#scheduler?.release(leaseId, result.status === "completed" ? "completed" : "failed");
    const review = this.#auditReviews.get(auditRunId);
    if (result.status !== "completed" || review === undefined) {
      const failed: ExtensionAuditRun = { ...base, status: "audit_failed", failureCode: "EXTENSION_AUDIT_FAILED", updatedAt: this.#now() };
      this.#audits.set(auditRunId, failed);
      this.#staged.set(staged.stagedRevisionId, { ...staged, state: "awaiting_user_decision" });
      this.save();
      return cloneAudit(failed);
    }
    const completed: ExtensionAuditRun = { ...base, status: "audit_complete", modelReview: review, updatedAt: this.#now() };
    this.#audits.set(auditRunId, completed);
    this.#staged.set(staged.stagedRevisionId, { ...staged, state: "audit_complete" });
    this.save();
    return cloneAudit(completed);
  }

  async approve(request: ExtensionApprovalRequest): Promise<ApprovedExtensionRevision> {
    if (request.userConfirmed !== true) throw new ExtensionAdmissionError("EXTENSION_APPROVAL_MISMATCH", "Only an explicit User approval can admit an Extension.");
    const staged = this.requireStaged(request.stagedRevisionId);
    const report = this.#reports.get(request.reportId);
    if (report === undefined || report.stagedRevisionId !== staged.stagedRevisionId || report.artifactHash !== request.expectedArtifactHash) throw new ExtensionAdmissionError("EXTENSION_APPROVAL_MISMATCH", "Approval evidence does not match the staged artifact.");
    const currentHash = hashInventory(inventoryDirectory(staged.stagedPath));
    if (currentHash !== report.artifactHash || currentHash !== request.expectedArtifactHash) throw new ExtensionAdmissionError("EXTENSION_ARTIFACT_CHANGED", "The staged Extension bytes changed after review.");
    if (report.status === "blocked" || report.blockers.length > 0) throw new ExtensionAdmissionError("EXTENSION_ADMISSION_BLOCKED", "Deterministic inspection contains a non-overridable admission blocker.");
    const accepted = new Set(request.acceptedFindingIds ?? []);
    const unaccepted = report.findings.filter((finding) => finding.overridable && !accepted.has(finding.id));
    if (unaccepted.length > 0) throw new ExtensionAdmissionError("EXTENSION_APPROVAL_MISMATCH", "Every overridable finding must be explicitly accepted by the User.");
    const packageJson = readPackageJson(staged.stagedPath);
    const version = typeof packageJson?.version === "string" ? packageJson.version : "";
    if (staged.extensionId === "" || staged.name === "" || version === "") throw new ExtensionAdmissionError("EXTENSION_IDENTITY_INCOMPLETE", "Extension name, id, and version are required for approval.");
    const approvedRevisionId = randomUUID();
    const approvedPath = join(this.#approvedRoot, staged.extensionId, approvedRevisionId);
    try {
      copyDirectoryWithoutExecution(staged.stagedPath, approvedPath);
      const copiedHash = hashInventory(inventoryDirectory(approvedPath));
      if (copiedHash !== report.artifactHash) throw new ExtensionAdmissionError("EXTENSION_INTEGRITY_FAILED", "Approved artifact bytes do not match the reviewed identity.");
      const approved: ApprovedExtensionRevision = {
        schemaVersion: 1, extensionId: staged.extensionId, approvedRevisionId, stagedRevisionId: staged.stagedRevisionId, name: staged.name, version, approvedPath,
        artifactHash: report.artifactHash, dependencyClosureHash: report.dependencyClosureHash, entryPoints: [...report.entryPoints], requestedPermissions: [...report.requestedPermissions], enabled: false, invalidated: false,
        trustDisclosure: "Trusted Worker Code: direct process behavior cannot be fully mediated by Standard Access.", approvedAt: this.#now()
      };
      this.#approved.set(approvedRevisionId, approved);
      this.#staged.set(staged.stagedRevisionId, { ...staged, state: "approved_disabled" });
      this.save();
      return cloneApproved(approved);
    } catch (error) {
      rmSync(approvedPath, { recursive: true, force: true });
      if (error instanceof ExtensionAdmissionError) throw error;
      throw new ExtensionAdmissionError("EXTENSION_INTEGRITY_FAILED", error instanceof Error ? error.message : "Approved artifact copy failed.");
    }
  }

  async reject(stagedRevisionId: string, _reason?: string): Promise<void> {
    const staged = this.requireStaged(stagedRevisionId);
    this.#staged.set(stagedRevisionId, { ...staged, state: "rejected" });
    this.save();
  }

  invalidateChanged(): readonly string[] {
    const invalidated: string[] = [];
    for (const [revisionId, approved] of this.#approved) {
      if (approved.invalidated) continue;
      const actualHash = hashInventory(inventoryDirectory(approved.approvedPath));
      if (actualHash === approved.artifactHash) continue;
      this.#approved.set(revisionId, { ...approved, invalidated: true });
      invalidated.push(revisionId);
    }
    if (invalidated.length > 0) this.save();
    return invalidated;
  }

  getStaged(stagedRevisionId: string): StagedExtension | undefined { const staged = this.#staged.get(stagedRevisionId); return staged === undefined ? undefined : cloneStaged(staged); }
  getReport(reportId: string): DeterministicInspectionReport | undefined { const report = this.#reports.get(reportId); return report === undefined ? undefined : cloneReport(report); }
  getApproved(approvedRevisionId: string): ApprovedExtensionRevision | undefined { const approved = this.#approved.get(approvedRevisionId); return approved === undefined ? undefined : cloneApproved(approved); }
  listApproved(): readonly ApprovedExtensionRevision[] { return [...this.#approved.values()].map(cloneApproved); }

  assertApprovedRuntimeIdentity(approvedRevisionId: string): ApprovedExtensionRevision {
    const approved = this.#approved.get(approvedRevisionId);
    if (approved === undefined || approved.invalidated) throw new ExtensionAdmissionError("EXTENSION_NOT_APPROVED", "The Extension revision is not approved for runtime loading.");
    const actualHash = hashInventory(inventoryDirectory(approved.approvedPath));
    if (actualHash !== approved.artifactHash) {
      this.#approved.set(approvedRevisionId, { ...approved, invalidated: true });
      this.save();
      throw new ExtensionAdmissionError("EXTENSION_ARTIFACT_CHANGED", "Approved Extension bytes no longer match the retained identity.");
    }
    return cloneApproved(approved);
  }

  runtimeEntry(approvedRevisionId: string): { readonly id: string; readonly version: string; readonly entryPath: string; readonly integrity: string; readonly trust: "approved-trusted" } {
    const approved = this.assertApprovedRuntimeIdentity(approvedRevisionId);
    const entryPoint = approved.entryPoints[0];
    if (entryPoint === undefined) throw new ExtensionAdmissionError("EXTENSION_INTEGRITY_FAILED", "Approved Extension has no runtime entry point.");
    const entryPath = resolve(approved.approvedPath, entryPoint);
    if (!isContained(approved.approvedPath, entryPath) || !existsSync(entryPath)) throw new ExtensionAdmissionError("EXTENSION_INTEGRITY_FAILED", "Approved Extension entry point is outside the retained artifact.");
    return { id: approved.extensionId, version: approved.version, entryPath, integrity: approved.artifactHash, trust: "approved-trusted" };
  }

  snapshot(): ExtensionAdmissionSnapshot {
    return { staged: [...this.#staged.values()].map(cloneStaged), reports: [...this.#reports.values()].map(cloneReport), audits: [...this.#audits.values()].map(cloneAudit), approved: [...this.#approved.values()].map(cloneApproved) };
  }

  async shutdown(): Promise<void> { await this.#auditJobs.shutdown(2_000); }

  private async runAuditJob(manifest: LocalJobManifest, signal: AbortSignal): Promise<{ readonly outputPaths: readonly string[]; readonly outputBytes: number }> {
    const runId = manifest.metadata?.auditRunId;
    const stagedRevisionId = manifest.metadata?.stagedRevisionId;
    const instructionsRevision = manifest.metadata?.instructionsRevision ?? "extension-audit-instructions-v1";
    if (runId === undefined || stagedRevisionId === undefined || this.#auditAdapter === undefined) throw new Error("Audit assignment is incomplete.");
    const report = this.latestReportFor(stagedRevisionId);
    const staged = this.#staged.get(stagedRevisionId);
    if (report === undefined || staged === undefined) throw new Error("Audit evidence is unavailable.");
    const review = await this.#auditAdapter.review({ auditRunId: runId, stagedRevisionId, stagedArtifactPath: staged.stagedPath, deterministicReport: report, instructionsRevision }, signal);
    this.#auditReviews.set(runId, review);
    const outputPath = manifest.outputPaths[0];
    if (outputPath === undefined) throw new Error("Audit output path is missing.");
    mkdirSync(dirnameFor(outputPath), { recursive: true });
    const bytes = JSON.stringify({ schemaVersion: 1, auditRunId: runId, summary: review.summary, findings: review.findings, residualRisk: review.residualRisk, limitations: review.limitations });
    writeFileSync(outputPath, bytes, "utf8");
    return { outputPaths: [outputPath], outputBytes: Buffer.byteLength(bytes, "utf8") };
  }

  private latestReportFor(stagedRevisionId: string): DeterministicInspectionReport | undefined {
    return [...this.#reports.values()].filter((report) => report.stagedRevisionId === stagedRevisionId).sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0];
  }

  private requireStaged(stagedRevisionId: string): StagedExtension {
    const staged = this.#staged.get(stagedRevisionId);
    if (staged === undefined) throw new ExtensionAdmissionError("EXTENSION_STAGE_FAILED", "Staged Extension was not found.");
    return staged;
  }

  private load(): void {
    const path = join(this.#root, "state.json");
    if (!existsSync(path)) return;
    try {
      const state = JSON.parse(readFileSync(path, "utf8")) as PersistedAdmissionState;
      if (state.schemaVersion !== 1) return;
      for (const item of state.staged) this.#staged.set(item.stagedRevisionId, item);
      for (const item of state.reports) this.#reports.set(item.reportId, item);
      for (const item of state.audits) this.#audits.set(item.auditRunId, item);
      for (const item of state.approved) this.#approved.set(item.approvedRevisionId, item);
    } catch {
      // Corrupt admission state is left inert; it never manufactures approval evidence.
    }
  }

  private save(): void {
    mkdirSync(this.#root, { recursive: true });
    const path = join(this.#root, "state.json");
    const partial = path + ".partial";
    const state: PersistedAdmissionState = { schemaVersion: 1, staged: [...this.#staged.values()], reports: [...this.#reports.values()], audits: [...this.#audits.values()], approved: [...this.#approved.values()] };
    writeFileSync(partial, JSON.stringify(state, null, 2) + "\n", "utf8");
    renameSync(partial, path);
  }
}

export type ExtensionEnablementChange =
  | { readonly action: "enable" | "update"; readonly extensionId: string; readonly approvedRevisionId: string }
  | { readonly action: "disable"; readonly extensionId: string };

export interface GlobalExtensionEntry {
  readonly extensionId: string;
  readonly approvedRevisionId: string;
  readonly artifactHash: string;
  readonly version: string;
  readonly entryPoints: readonly string[];
  readonly requestedPermissions: readonly string[];
  readonly trustDisclosure: "Trusted Worker Code: direct process behavior cannot be fully mediated by Standard Access.";
}

export interface PendingGlobalExtensionRevision {
  readonly schemaVersion: 1;
  readonly revisionId: string;
  readonly baseRevisionId: string;
  readonly status: "pending" | "waiting_for_global_idle" | "activating";
  readonly proposedExtensions: readonly GlobalExtensionEntry[];
  readonly change: ExtensionEnablementChange;
  readonly createdAt: string;
}

export interface GlobalExtensionRevisionState {
  readonly schemaVersion: 1;
  readonly effectiveRevisionId: string;
  readonly effectiveExtensions: readonly GlobalExtensionEntry[];
  readonly pending?: PendingGlobalExtensionRevision;
  readonly history: readonly { readonly revisionId: string; readonly extensionIds: readonly string[]; readonly activatedAt: string }[];
  readonly workerTrustDisclosure: "Enabled Extensions run as Trusted Worker Code; Standard Access cannot fully mediate their direct process behavior.";
}

interface PersistedGlobalState { readonly schemaVersion: 1; readonly effectiveRevisionId: string; readonly effectiveExtensions: GlobalExtensionEntry[]; readonly pending?: PendingGlobalExtensionRevision; readonly history: Array<{ revisionId: string; extensionIds: string[]; activatedAt: string }> }

/** Installation-wide Extension set and atomic Worker changeover boundary. */
export class GlobalExtensionRevisionManager {
  readonly #root: string;
  readonly #admission: ExtensionAdmissionManager;
  readonly #isGloballyIdle: () => boolean;
  readonly #terminateWorkers: () => Promise<void> | void;
  readonly #interruptAndCheckpoint: () => Promise<void> | void;
  readonly #now: () => string;
  #effectiveRevisionId = "global-extension-r0";
  #effectiveExtensions: GlobalExtensionEntry[] = [];
  #pending: PendingGlobalExtensionRevision | undefined;
  #history: Array<{ revisionId: string; extensionIds: string[]; activatedAt: string }> = [];

  constructor(input: { root: string; admission: ExtensionAdmissionManager; isGloballyIdle?: () => boolean; terminateWorkers?: () => Promise<void> | void; interruptAndCheckpoint?: () => Promise<void> | void; now?: () => string }) {
    this.#root = resolve(input.root);
    this.#admission = input.admission;
    this.#isGloballyIdle = input.isGloballyIdle ?? (() => true);
    this.#terminateWorkers = input.terminateWorkers ?? (() => undefined);
    this.#interruptAndCheckpoint = input.interruptAndCheckpoint ?? (() => undefined);
    this.#now = input.now ?? (() => new Date().toISOString());
    this.load();
  }

  async propose(change: ExtensionEnablementChange): Promise<PendingGlobalExtensionRevision> {
    if (this.#pending !== undefined) throw new ExtensionAdmissionError("EXTENSION_REVISION_CONFLICT", "Another Global Extension Revision is already pending.");
    const next = new Map(this.#effectiveExtensions.map((entry) => [entry.extensionId, entry]));
    if (change.action === "disable") {
      if (!next.has(change.extensionId)) throw new ExtensionAdmissionError("EXTENSION_REVISION_CONFLICT", "The Extension is not enabled in the effective set.");
      next.delete(change.extensionId);
    } else {
      const approvedRevisionId = change.approvedRevisionId;
      const approved = approvedRevisionId === undefined ? undefined : this.#admission.assertApprovedRuntimeIdentity(approvedRevisionId);
      if (approved === undefined || approved.extensionId !== change.extensionId) throw new ExtensionAdmissionError("EXTENSION_NOT_APPROVED", "Enablement requires the exact approved Extension revision.");
      next.set(change.extensionId, {
        extensionId: approved.extensionId, approvedRevisionId: approved.approvedRevisionId, artifactHash: approved.artifactHash, version: approved.version,
        entryPoints: [...approved.entryPoints], requestedPermissions: [...approved.requestedPermissions], trustDisclosure: approved.trustDisclosure
      });
    }
    const pending: PendingGlobalExtensionRevision = { schemaVersion: 1, revisionId: randomUUID(), baseRevisionId: this.#effectiveRevisionId, status: "pending", proposedExtensions: [...next.values()].sort((left, right) => left.extensionId.localeCompare(right.extensionId)), change, createdAt: this.#now() };
    this.#pending = pending;
    this.save();
    return clonePending(pending);
  }

  async activateWhenIdle(revisionId: string): Promise<void> {
    this.requirePending(revisionId);
    if (!this.#isGloballyIdle()) {
      this.#pending = { ...this.#pending!, status: "waiting_for_global_idle" };
      this.save();
      return;
    }
    await this.activate(revisionId, false);
  }

  async activateImmediately(revisionId: string): Promise<{ readonly revisionId: string; readonly interrupted: true; readonly replayed: false }> {
    this.requirePending(revisionId);
    await this.#interruptAndCheckpoint();
    await this.#terminateWorkers();
    await this.activate(revisionId, true);
    return { revisionId, interrupted: true, replayed: false };
  }

  async rollback(approvedRevisionId: string): Promise<PendingGlobalExtensionRevision> {
    const approved = this.#admission.assertApprovedRuntimeIdentity(approvedRevisionId);
    return this.propose({ action: this.#effectiveExtensions.some((entry) => entry.extensionId === approved.extensionId) ? "update" : "enable", extensionId: approved.extensionId, approvedRevisionId });
  }

  snapshot(): GlobalExtensionRevisionState {
    return {
      schemaVersion: 1, effectiveRevisionId: this.#effectiveRevisionId, effectiveExtensions: this.#effectiveExtensions.map(cloneEntry),
      ...(this.#pending === undefined ? {} : { pending: clonePending(this.#pending) }), history: this.#history.map((item) => ({ ...item, extensionIds: [...item.extensionIds] })),
      workerTrustDisclosure: "Enabled Extensions run as Trusted Worker Code; Standard Access cannot fully mediate their direct process behavior."
    };
  }

  runtimeSnapshot(): ExtensionInventorySnapshot {
    return { schemaVersion: 1, revisionId: this.#effectiveRevisionId, enabled: this.#effectiveExtensions.map((entry) => ({ id: entry.extensionId, version: entry.version, entryPath: this.#admission.runtimeEntry(entry.approvedRevisionId).entryPath, integrity: entry.artifactHash, trust: "approved-trusted" })) };
  }

  private async activate(revisionId: string, immediate: boolean): Promise<void> {
    const pending = this.requirePending(revisionId);
    this.#pending = { ...pending, status: "activating" };
    this.save();
    if (!immediate) await this.#terminateWorkers();
    this.#effectiveRevisionId = pending.revisionId;
    this.#effectiveExtensions = pending.proposedExtensions.map(cloneEntry);
    this.#history.push({ revisionId: pending.revisionId, extensionIds: this.#effectiveExtensions.map((entry) => entry.extensionId), activatedAt: this.#now() });
    this.#pending = undefined;
    this.save();
  }

  private requirePending(revisionId: string): PendingGlobalExtensionRevision {
    if (this.#pending === undefined || this.#pending.revisionId !== revisionId) throw new ExtensionAdmissionError("EXTENSION_REVISION_CONFLICT", "The requested Global Extension Revision is not pending.");
    return this.#pending;
  }

  private load(): void {
    const path = join(this.#root, "global-revision.json");
    if (!existsSync(path)) return;
    try {
      const state = JSON.parse(readFileSync(path, "utf8")) as PersistedGlobalState;
      if (state.schemaVersion !== 1) return;
      this.#effectiveRevisionId = state.effectiveRevisionId;
      this.#effectiveExtensions = state.effectiveExtensions;
      this.#pending = state.pending;
      this.#history = state.history;
    } catch {
      // A corrupt revision file stays at the empty safe baseline.
    }
  }

  private save(): void {
    mkdirSync(this.#root, { recursive: true });
    const path = join(this.#root, "global-revision.json");
    const partial = path + ".partial";
    const state: PersistedGlobalState = { schemaVersion: 1, effectiveRevisionId: this.#effectiveRevisionId, effectiveExtensions: this.#effectiveExtensions, ...(this.#pending === undefined ? {} : { pending: this.#pending }), history: this.#history };
    writeFileSync(partial, JSON.stringify(state, null, 2) + "\n", "utf8");
    renameSync(partial, path);
  }
}

export function hashExtensionDirectory(directory: string): string {
  return hashInventory(inventoryDirectory(resolve(directory)));
}

function buildInspection(staged: StagedExtension, now: string): DeterministicInspectionReport {
  const files = inventoryDirectory(staged.stagedPath);
  const packageJson = readPackageJson(staged.stagedPath);
  const packageName = typeof packageJson?.name === "string" ? packageJson.name : staged.name;
  const version = typeof packageJson?.version === "string" ? packageJson.version : undefined;
  const lockName = LOCKFILE_NAMES.find((name) => files.some((file) => file.relativePath === name));
  const lockfile = lockName === undefined ? undefined : { name: lockName, sha256: files.find((file) => file.relativePath === lockName)!.sha256 };
  const dependencies = collectDependencies(packageJson);
  const lifecycleScripts = collectLifecycleScripts(packageJson);
  const entryPoints = collectEntryPoints(packageJson);
  const nativeBinaries = files.filter((file) => NATIVE_EXTENSIONS.has(extname(file.relativePath).toLowerCase())).map((file) => file.relativePath);
  const requestedPermissions = collectStringArray(packageJson?.permissions ?? packageJson?.requestedPermissions);
  const licenses = collectLicenses(packageJson);
  const vulnerabilities = collectStringArray(packageJson?.vulnerabilities);
  const findings: ExtensionFinding[] = [];
  const blockers: string[] = [];
  const gaps: string[] = [];
  if (packageName === "" || version === undefined) {
    blockers.push("EXTENSION_IDENTITY_INCOMPLETE");
    findings.push(finding("identity-missing", "critical", "identity", "Package name and version are required for immutable admission.", false));
  }
  if (lockfile === undefined) {
    blockers.push("EXTENSION_DEPENDENCY_UNRESOLVED");
    findings.push(finding("lockfile-missing", "critical", "dependency", "A lockfile is required for deterministic dependency closure.", false));
  }
  if (dependencies.some((value) => /^(latest|\*|file:|workspace:|git\+|https?:)/iu.test(value))) {
    blockers.push("EXTENSION_DEPENDENCY_UNRESOLVED");
    findings.push(finding("dependency-nondeterministic", "critical", "dependency", "A dependency uses a non-deterministic or external locator.", false));
  }
  for (const entryPoint of entryPoints) {
    if (!files.some((file) => file.relativePath === entryPoint)) {
      blockers.push("EXTENSION_INTEGRITY_FAILED");
      findings.push(finding("entry-point-missing-" + entryPoint.replace(/[^a-z0-9]/giu, "-"), "critical", "integrity", "Declared entry point is absent from the staged artifact.", false));
    }
  }
  if (lifecycleScripts.length > 0) findings.push(finding("lifecycle-scripts", "high", "lifecycle", "Lifecycle scripts are present and will not be executed during admission.", true));
  if (nativeBinaries.length > 0) findings.push(finding("native-binaries", "high", "native", "Native binaries are present in the retained artifact.", true));
  if (requestedPermissions.length > 0) findings.push(finding("requested-permissions", "high", "permission", "The artifact declares direct Worker permissions.", true));
  if (licenses.length === 0) gaps.push("license metadata was not declared");
  if (vulnerabilities.length === 0) gaps.push("offline vulnerability database evidence is unavailable");
  if (staged.sourceRevision === undefined) gaps.push("source revision was not supplied; artifact hash remains the immutable identity");
  const dependencyClosureHash = hashClosure(files, lockfile, dependencies);
  return {
    schemaVersion: 1, reportId: randomUUID(), stagedRevisionId: staged.stagedRevisionId, artifactHash: hashInventory(files), dependencyClosureHash,
    identity: { extensionId: packageName, name: packageName, ...(version === undefined ? {} : { version }), ...(staged.sourceRevision === undefined ? {} : { sourceRevision: staged.sourceRevision }) }, files, ...(lockfile === undefined ? {} : { lockfile }), entryPoints, lifecycleScripts, nativeBinaries, requestedPermissions, licenses, vulnerabilities,
    findings, blockers: [...new Set(blockers)], gaps, status: blockers.length === 0 ? "reviewable" : "blocked", generatedAt: now
  };
}

function finding(id: string, severity: ExtensionFinding["severity"], category: ExtensionFinding["category"], message: string, overridable: boolean): ExtensionFinding { return { id, severity, category, message, source: "deterministic", overridable }; }

function collectDependencies(packageJson: Record<string, unknown> | undefined): string[] {
  if (packageJson === undefined) return [];
  const all: string[] = [];
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const dependencies = packageJson[field];
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) continue;
    for (const value of Object.values(dependencies as Record<string, unknown>)) if (typeof value === "string") all.push(value);
  }
  return all.sort();
}

function collectLifecycleScripts(packageJson: Record<string, unknown> | undefined): string[] {
  const scripts = packageJson?.scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return [];
  return Object.keys(scripts as Record<string, unknown>).filter((key) => LIFECYCLE_SCRIPT_NAMES.has(key)).sort();
}

function collectEntryPoints(packageJson: Record<string, unknown> | undefined): string[] {
  if (packageJson === undefined) return [];
  const entries: string[] = [];
  for (const field of ENTRY_FIELDS) if (typeof packageJson[field] === "string") entries.push(normalizeRelative(packageJson[field] as string));
  const exports = packageJson.exports;
  if (typeof exports === "string") entries.push(normalizeRelative(exports));
  if (typeof exports === "object" && exports !== null) collectExportStrings(exports, entries);
  const bin = packageJson.bin;
  if (typeof bin === "string") entries.push(normalizeRelative(bin));
  if (typeof bin === "object" && bin !== null) for (const value of Object.values(bin as Record<string, unknown>)) if (typeof value === "string") entries.push(normalizeRelative(value));
  return [...new Set(entries)].filter((entry) => entry !== "").sort();
}

function collectExportStrings(value: unknown, entries: string[]): void {
  if (typeof value === "string") entries.push(normalizeRelative(value));
  else if (typeof value === "object" && value !== null) for (const child of Object.values(value as Record<string, unknown>)) collectExportStrings(child, entries);
}

function collectStringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").sort() : []; }

function collectLicenses(packageJson: Record<string, unknown> | undefined): string[] {
  if (packageJson === undefined) return [];
  if (typeof packageJson.license === "string") return [packageJson.license];
  if (Array.isArray(packageJson.licenses)) return packageJson.licenses.flatMap((item) => typeof item === "string" ? [item] : typeof item === "object" && item !== null && typeof (item as { type?: unknown }).type === "string" ? [(item as { type: string }).type] : []).sort();
  return [];
}

function hashClosure(files: readonly ExtensionFileInventory[], lockfile: { readonly name: string; readonly sha256: string } | undefined, dependencies: readonly string[]): string {
  return sha256(JSON.stringify({ lockfile: lockfile ?? null, dependencies, files: files.filter((file) => file.relativePath === "package.json" || file.relativePath.includes("lock")).map((file) => ({ path: file.relativePath, hash: file.sha256 })) }));
}

function readPackageJson(directory: string): Record<string, any> | undefined {
  const path = join(directory, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, any> : undefined;
  } catch { return undefined; }
}

function copyDirectoryWithoutExecution(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new ExtensionAdmissionError("EXTENSION_INTEGRITY_FAILED", "Symlinks are not admitted into an Extension artifact.");
    if (entry.isDirectory()) copyDirectoryWithoutExecution(sourcePath, destinationPath);
    else if (entry.isFile()) {
      mkdirSync(resolve(destinationPath, ".."), { recursive: true });
      writeFileSync(destinationPath, readFileSync(sourcePath));
    } else throw new ExtensionAdmissionError("EXTENSION_STAGE_FAILED", "Special filesystem entries are not admitted.");
  }
}

function inventoryDirectory(directory: string): ExtensionFileInventory[] {
  if (!existsSync(directory)) throw new ExtensionAdmissionError("EXTENSION_ARTIFACT_CHANGED", "Retained Extension artifact is missing.");
  const files: ExtensionFileInventory[] = [];
  walk(directory, directory, files);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function walk(root: string, current: string, files: ExtensionFileInventory[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new ExtensionAdmissionError("EXTENSION_ARTIFACT_CHANGED", "Retained Extension artifact contains a symlink.");
    if (entry.isDirectory()) walk(root, path, files);
    else if (entry.isFile()) {
      const stat = statSync(path);
      files.push({ relativePath: normalizeRelative(relative(root, path)), sha256: sha256(readFileSync(path)), size: stat.size, mode: stat.mode & 0o777 });
    } else throw new ExtensionAdmissionError("EXTENSION_ARTIFACT_CHANGED", "Retained Extension artifact contains a special entry.");
  }
}

function hashInventory(files: readonly ExtensionFileInventory[]): string { return sha256(files.map((file) => `${file.relativePath}\u0000${file.size}\u0000${file.mode}\u0000${file.sha256}`).join("\n")); }
function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function normalizeRelative(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/^\//u, ""); }
function isContained(root: string, candidate: string): boolean { const rootPath = resolve(root); const candidatePath = resolve(candidate); return candidatePath === rootPath || candidatePath.startsWith(rootPath + sep); }
function dirnameFor(path: string): string { const parts = path.split(/[\\/]/u); parts.pop(); return parts.join(sep) || "."; }

function cloneStaged(value: StagedExtension): StagedExtension { return { ...value }; }
function cloneReport(value: DeterministicInspectionReport): DeterministicInspectionReport { return { ...value, identity: { ...value.identity }, files: value.files.map((file) => ({ ...file })), ...(value.lockfile === undefined ? {} : { lockfile: { ...value.lockfile } }), entryPoints: [...value.entryPoints], lifecycleScripts: [...value.lifecycleScripts], nativeBinaries: [...value.nativeBinaries], requestedPermissions: [...value.requestedPermissions], licenses: [...value.licenses], vulnerabilities: [...value.vulnerabilities], findings: value.findings.map((finding) => ({ ...finding })), blockers: [...value.blockers], gaps: [...value.gaps] }; }
function cloneAudit(value: ExtensionAuditRun): ExtensionAuditRun { return { ...value, ...(value.profileId === undefined ? {} : { profileId: value.profileId }), ...(value.modelReview === undefined ? {} : { modelReview: { ...value.modelReview, findings: value.modelReview.findings.map((finding) => ({ ...finding })), residualRisk: [...value.modelReview.residualRisk], limitations: [...value.modelReview.limitations] } }) }; }
function cloneApproved(value: ApprovedExtensionRevision): ApprovedExtensionRevision { return { ...value, entryPoints: [...value.entryPoints], requestedPermissions: [...value.requestedPermissions] }; }
function cloneEntry(value: GlobalExtensionEntry): GlobalExtensionEntry { return { ...value, entryPoints: [...value.entryPoints], requestedPermissions: [...value.requestedPermissions] }; }
function clonePending(value: PendingGlobalExtensionRevision): PendingGlobalExtensionRevision { return { ...value, proposedExtensions: value.proposedExtensions.map(cloneEntry), change: { ...value.change } }; }
