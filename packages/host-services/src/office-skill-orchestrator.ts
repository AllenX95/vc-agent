import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { LocalJobSupervisor, type LocalJobManifest, type LocalJobResult } from "./agent-runtime-supervisor.js";
import { SkillPackageManager } from "./skills-directory.js";

export type OfficeFormat = "docx" | "pptx" | "xlsx" | "pdf";
export type OfficeTaskKind = "create" | "edit" | "review";

export interface OfficeTaskRequest {
  readonly kind: OfficeTaskKind;
  readonly format: OfficeFormat;
  readonly projectId: string;
  readonly projectPath: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly profile: { readonly id: string; readonly provider: string; readonly model: string };
  readonly skillRevisionId: string;
  readonly outputDirectory: string;
  readonly outputFileName?: string;
  readonly sourcePath?: string;
  readonly sourceReferences?: readonly string[];
  readonly renderPreview?: boolean;
  readonly explicitIntent: boolean;
}

export interface OfficeExecutionPlan {
  readonly planId: string;
  readonly task: OfficeTaskRequest;
  readonly job: LocalJobManifest;
  /** Effective app-owned root of the imported Skill revision selected by I1. */
  readonly skillRoot: string;
  readonly stagedOutputPath: string;
  readonly expectedSourceHash?: string;
}

export interface OfficeStagedResult {
  readonly resultId: string;
  readonly planId: string;
  readonly status: "validated" | "failed" | "cancelled" | "timed_out";
  readonly format: OfficeFormat;
  readonly stagedOutputPath?: string;
  readonly sourcePath?: string;
  readonly sourceHash?: string;
  readonly editedCopyHash?: string;
  readonly changeSummaryPath?: string;
  readonly previewPaths: readonly string[];
  readonly warnings: readonly string[];
  readonly job?: LocalJobResult;
}

export interface ProjectOfficeOutput {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly mediaType: string;
  readonly destination: string;
  readonly relativePath: string;
  readonly producer: { readonly skillRevisionId: string; readonly threadId: string; readonly turnId: string; readonly profileId: string; readonly provider: string; readonly model: string };
  readonly sourceReferences: readonly string[];
  readonly warnings: readonly string[];
  readonly hash: string;
  readonly createdAt: string;
  readonly relatedArtifacts: readonly { readonly id: string; readonly kind: "change_summary" | "preview"; readonly path: string }[];
}

export interface OriginalReplacementRequest {
  readonly resultId: string;
  readonly sourcePath: string;
  readonly expectedSourceHash: string;
  readonly accessMode: "standard" | "full";
  readonly confirmed: boolean;
  readonly duplicateRiskAcknowledged?: boolean;
  readonly simulateUnknownOutcome?: boolean;
}

export type ReplacementResult =
  | { readonly status: "replaced"; readonly sourcePath: string; readonly hash: string }
  | { readonly status: "confirmation_required"; readonly sourcePath: string; readonly editedCopyPath: string }
  | { readonly status: "collision"; readonly code: "OFFICE_SOURCE_CHANGED" | "OFFICE_TARGET_COLLISION"; readonly sourcePath: string }
  | { readonly status: "unknown_outcome"; readonly code: "UNKNOWN_TOOL_OUTCOME"; readonly sourcePath: string; readonly requiresInspection: true }
  | { readonly status: "failed"; readonly code: string; readonly message: string };

export interface OfficeSkillJobAdapter {
  run(input: {
    readonly plan: OfficeExecutionPlan;
    readonly signal: AbortSignal;
  }): Promise<{ readonly outputPath: string; readonly outputBytes?: number; readonly previewPath?: string; readonly warnings?: readonly string[] }>;
  terminate?(jobId: string): Promise<void> | void;
}

interface StoredOfficeTask {
  readonly plan: OfficeExecutionPlan;
  result?: OfficeStagedResult;
  output?: ProjectOfficeOutput;
}

export class OfficeSkillOrchestrator {
  readonly #manager: SkillPackageManager;
  readonly #jobs: LocalJobSupervisor;
  readonly #adapter: OfficeSkillJobAdapter;
  readonly #root: string;
  readonly #now: () => string;
  readonly #tasks = new Map<string, StoredOfficeTask>();
  readonly #registerOutput: ((output: ProjectOfficeOutput) => void) | undefined;

  constructor(input: {
    skills: SkillPackageManager;
    adapter: OfficeSkillJobAdapter;
    root: string;
    jobCapacity?: number;
    now?: () => string;
    registerOutput?: (output: ProjectOfficeOutput) => void;
  }) {
    this.#manager = input.skills;
    this.#adapter = input.adapter;
    this.#root = resolve(input.root);
    this.#now = input.now ?? (() => new Date().toISOString());
    this.#registerOutput = input.registerOutput;
    this.#jobs = new LocalJobSupervisor({ capacity: input.jobCapacity ?? 1, adapter: { run: async (manifest, signal) => {
      const plan = this.#tasks.get(manifest.jobId)?.plan;
      if (plan === undefined) throw new Error("OFFICE_JOB_REJECTED");
      const result = await this.#adapter.run({ plan, signal });
      const bytes = result.outputBytes ?? (existsSync(result.outputPath) ? statSync(result.outputPath).size : 0);
      return { outputPaths: [result.outputPath, ...(result.previewPath === undefined ? [] : [result.previewPath])], outputBytes: bytes, warnings: result.warnings ?? [] };
    }, terminate: (jobId) => this.#adapter.terminate?.(jobId) } });
    this.load();
  }

  async prepare(request: OfficeTaskRequest): Promise<OfficeExecutionPlan> {
    if (!request.explicitIntent) throw new Error("OFFICE_JOB_REJECTED");
    if (!request.projectId || !request.threadId || !request.turnId) throw new Error("OFFICE_JOB_REJECTED");
    if (!/^[a-z0-9-]+$/iu.test(request.format)) throw new Error("OFFICE_JOB_REJECTED");
    const skill = this.#manager.getRevision(request.skillRevisionId);
    if (skill === undefined || !skill.enabled || skill.state !== "active") throw new Error("OFFICE_SKILL_UNAVAILABLE");
    const skillRoot = this.#manager.activePath(skill);
    if (!existsSync(skillRoot)) throw new Error("OFFICE_SKILL_UNAVAILABLE");
    if (request.kind !== "create" && (request.sourcePath === undefined || !existsSync(request.sourcePath))) throw new Error("OFFICE_SOURCE_CHANGED");
    if (request.kind === "create" && request.sourcePath !== undefined) throw new Error("OFFICE_JOB_REJECTED");
    const planId = randomUUID();
    const jobId = "office-" + planId;
    const stagingDirectory = join(this.#root, "jobs", jobId);
    const stagedOutputPath = join(stagingDirectory, outputName(request));
    mkdirSync(stagingDirectory, { recursive: true });
    const expectedSourceHash = request.sourcePath === undefined ? undefined : hashFile(request.sourcePath);
    const inputSnapshotPath = request.sourcePath === undefined ? undefined : join(stagingDirectory, `input-${basename(request.sourcePath)}`);
    if (request.sourcePath !== undefined && inputSnapshotPath !== undefined) {
      copyFileSync(request.sourcePath, inputSnapshotPath);
      if (hashFile(request.sourcePath) !== expectedSourceHash) throw new Error("OFFICE_SOURCE_CHANGED");
    }
    const job: LocalJobManifest = {
      jobId,
      kind: "isolated",
      stagingDirectory,
      inputPaths: inputSnapshotPath === undefined ? [] : [inputSnapshotPath],
      outputPaths: [stagedOutputPath, ...(request.renderPreview === true ? [stagedOutputPath + ".preview"] : [])],
      timeoutMs: 300_000,
      maxOutputBytes: 100_000_000,
      cancellationToken: randomUUID(),
      metadata: { format: request.format, skillRevisionId: request.skillRevisionId }
    };
    const plan: OfficeExecutionPlan = { planId, task: { ...request, ...(expectedSourceHash === undefined ? {} : {}) }, job, skillRoot, stagedOutputPath, ...(expectedSourceHash === undefined ? {} : { expectedSourceHash }) };
    this.#tasks.set(jobId, { plan });
    this.save();
    return plan;
  }

  async execute(planId: string): Promise<OfficeStagedResult> {
    const stored = this.findByPlan(planId);
    if (stored === undefined) throw new Error("OFFICE_JOB_REJECTED");
    const plan = stored.plan;
    if (plan.task.kind !== "create" && (plan.task.sourcePath === undefined || hashFile(plan.task.sourcePath) !== plan.expectedSourceHash)) return this.saveResult(plan, { resultId: randomUUID(), planId, status: "failed", format: plan.task.format, ...(plan.task.sourcePath === undefined ? {} : { sourcePath: plan.task.sourcePath }), previewPaths: [], warnings: ["OFFICE_SOURCE_CHANGED"] }, "OFFICE_SOURCE_CHANGED");
    let job: LocalJobResult;
    try {
      job = await this.#jobs.submit(plan.job);
    } catch (error) {
      return this.saveResult(plan, { resultId: randomUUID(), planId, status: "failed", format: plan.task.format, previewPaths: [], warnings: [], job: { jobId: plan.job.jobId, status: "failed", outputPaths: [], outputBytes: 0, warnings: [], code: "OFFICE_JOB_REJECTED" } }, error instanceof Error ? error.message : "OFFICE_JOB_REJECTED");
    }
    if (job.status !== "completed") {
      const status = job.status === "cancelled" ? "cancelled" : job.status === "timed_out" ? "timed_out" : "failed";
      return this.saveResult(plan, { resultId: randomUUID(), planId, status, format: plan.task.format, previewPaths: [], warnings: job.warnings, job }, job.code ?? "OFFICE_JOB_REJECTED");
    }
    if (plan.task.kind !== "create" && plan.task.sourcePath !== undefined && hashFile(plan.task.sourcePath) !== plan.expectedSourceHash) {
      return this.saveResult(plan, { resultId: randomUUID(), planId, status: "failed", format: plan.task.format, sourcePath: plan.task.sourcePath, previewPaths: [], warnings: job.warnings, job }, "OFFICE_SOURCE_CHANGED");
    }
    const stagedPath = job.outputPaths.find((path) => path.toLowerCase().endsWith("." + plan.task.format));
    if (stagedPath === undefined || !existsSync(stagedPath) || !isWithin(plan.job.stagingDirectory, stagedPath) || extname(stagedPath).toLowerCase() !== "." + plan.task.format) {
      return this.saveResult(plan, { resultId: randomUUID(), planId, status: "failed", format: plan.task.format, previewPaths: [], warnings: job.warnings, job }, "OFFICE_RESULT_INVALID");
    }
    const sourcePath = plan.task.sourcePath;
    const sourceHash = sourcePath === undefined ? undefined : hashFile(sourcePath);
    const editedCopyHash = hashFile(stagedPath);
    let changeSummaryPath: string | undefined;
    if (plan.task.kind !== "create" && sourcePath !== undefined) {
      changeSummaryPath = join(plan.job.stagingDirectory, "change-summary.json");
      writeFileSync(changeSummaryPath, JSON.stringify({ schemaVersion: 1, sourcePath: relative(plan.task.projectPath, sourcePath), sourceHash, editedCopyHash, summary: sourceHash === editedCopyHash ? "No byte changes." : "Edited copy differs from the source; review semantic changes in the Office application." }, null, 2) + "\n", "utf8");
    }
    const preview = job.outputPaths.find((path) => path !== stagedPath && path.toLowerCase().endsWith(".preview"));
    const result: OfficeStagedResult = {
      resultId: randomUUID(), planId, status: "validated", format: plan.task.format, stagedOutputPath: stagedPath,
      ...(sourcePath === undefined ? {} : { sourcePath, sourceHash: sourceHash! }),
      editedCopyHash, ...(changeSummaryPath === undefined ? {} : { changeSummaryPath }),
      previewPaths: preview === undefined ? [] : [preview], warnings: job.warnings, job
    };
    return this.saveResult(plan, result);
  }

  async commit(resultId: string): Promise<ProjectOfficeOutput> {
    const stored = [...this.#tasks.values()].find((item) => item.result?.resultId === resultId);
    if (stored?.result?.status !== "validated" || stored.result.stagedOutputPath === undefined) throw new Error("OFFICE_RESULT_INVALID");
    const result = stored.result;
    const plan = stored.plan;
    const stagedOutputPath = result.stagedOutputPath;
    if (stagedOutputPath === undefined) throw new Error("OFFICE_RESULT_INVALID");
    const targetDirectory = resolve(plan.task.outputDirectory);
    if (!isWithin(plan.task.projectPath, targetDirectory) || !isWithin(targetDirectory, targetDirectory)) throw new Error("OFFICE_JOB_REJECTED");
    mkdirSync(targetDirectory, { recursive: true });
    const destination = join(targetDirectory, outputName(plan.task));
    if (!isWithin(targetDirectory, destination)) throw new Error("OFFICE_JOB_REJECTED");
    if (existsSync(destination)) throw new Error("OFFICE_TARGET_COLLISION");
    const partial = destination + ".partial-" + result.resultId;
    copyFileSync(stagedOutputPath, partial);
    renameSync(partial, destination);
    const output: ProjectOfficeOutput = {
      schemaVersion: 1, id: randomUUID(), projectId: plan.task.projectId, mediaType: mediaType(plan.task.format), destination,
      relativePath: relative(plan.task.projectPath, destination).split(sep).join("/"),
      producer: { skillRevisionId: plan.task.skillRevisionId, threadId: plan.task.threadId, turnId: plan.task.turnId, profileId: plan.task.profile.id, provider: plan.task.profile.provider, model: plan.task.profile.model },
      sourceReferences: [...(plan.task.sourceReferences ?? [])], warnings: [...result.warnings], hash: hashFile(destination), createdAt: this.#now(),
      relatedArtifacts: [
        ...(result.changeSummaryPath === undefined ? [] : [{ id: randomUUID(), kind: "change_summary" as const, path: result.changeSummaryPath }]),
        ...result.previewPaths.map((path) => ({ id: randomUUID(), kind: "preview" as const, path }))
      ]
    };
    stored.output = output;
    this.#registerOutput?.(output);
    this.save();
    return output;
  }

  async replaceOriginal(request: OriginalReplacementRequest): Promise<ReplacementResult> {
    const stored = [...this.#tasks.values()].find((item) => item.result?.resultId === request.resultId);
    const result = stored?.result;
    if (stored === undefined || result?.status !== "validated" || result.stagedOutputPath === undefined || result.sourcePath === undefined) return { status: "failed", code: "OFFICE_RESULT_INVALID", message: "No validated edited copy is available." };
    if (request.accessMode === "standard" && !request.confirmed) return { status: "confirmation_required", sourcePath: request.sourcePath, editedCopyPath: result.stagedOutputPath };
    const sourcePath = request.sourcePath;
    if (sourcePath !== result.sourcePath || hashFile(sourcePath) !== request.expectedSourceHash) return { status: "collision", code: "OFFICE_SOURCE_CHANGED", sourcePath };
    if (request.simulateUnknownOutcome === true) return { status: "unknown_outcome", code: "UNKNOWN_TOOL_OUTCOME", sourcePath: request.sourcePath, requiresInspection: true };
    try {
      const partial = request.sourcePath + ".replacement-" + randomUUID();
      const backup = request.sourcePath + ".backup-" + randomUUID();
      copyFileSync(result.stagedOutputPath, partial);
      renameSync(request.sourcePath, backup);
      try {
        renameSync(partial, request.sourcePath);
        rmSync(backup, { force: true });
      } catch (error) {
        if (!existsSync(request.sourcePath) && existsSync(backup)) renameSync(backup, request.sourcePath);
        rmSync(partial, { force: true });
        throw error;
      }
      return { status: "replaced", sourcePath: request.sourcePath, hash: hashFile(request.sourcePath) };
    } catch (error) {
      return { status: "failed", code: "OFFICE_REPLACEMENT_FAILED", message: error instanceof Error ? error.message : "Office replacement failed." };
    }
  }

  getTask(planOrJobId: string): { readonly plan: OfficeExecutionPlan; readonly result?: OfficeStagedResult; readonly output?: ProjectOfficeOutput } | undefined {
    const found = this.#tasks.get(planOrJobId) ?? this.findByPlan(planOrJobId);
    return found === undefined ? undefined : { ...found };
  }

  /** Read-only result projection used by the Host UI to render review and replacement actions. */
  getResult(resultId: string): { readonly plan: OfficeExecutionPlan; readonly result: OfficeStagedResult; readonly output?: ProjectOfficeOutput } | undefined {
    const found = [...this.#tasks.values()].find((item) => item.result?.resultId === resultId);
    return found?.result === undefined ? undefined : { plan: found.plan, result: found.result, ...(found.output === undefined ? {} : { output: found.output }) };
  }

  async cancel(planOrJobId: string): Promise<{ readonly jobId: string; readonly status: "cancelled" | "not_found" }> {
    const stored = this.#tasks.get(planOrJobId) ?? this.findByPlan(planOrJobId);
    const jobId = stored?.plan.job.jobId ?? planOrJobId;
    const result = await this.#jobs.cancel(jobId);
    return { jobId, status: result.status };
  }

  async shutdown(): Promise<void> { await this.#jobs.shutdown(10_000); }

  private findByPlan(planId: string): StoredOfficeTask | undefined { return [...this.#tasks.values()].find((item) => item.plan.planId === planId); }

  private saveResult(plan: OfficeExecutionPlan, result: OfficeStagedResult, failureCode?: string): OfficeStagedResult {
    const stored = this.#tasks.get(plan.job.jobId);
    if (stored === undefined) return result;
    stored.result = failureCode === undefined ? result : { ...result, warnings: [...new Set([...result.warnings, failureCode])] };
    this.save();
    return stored.result;
  }

  private load(): void {
    const path = join(this.#root, "office-tasks.json");
    if (!existsSync(path)) return;
    try {
      const records = JSON.parse(readFileSync(path, "utf8")) as StoredOfficeTask[];
      for (const record of records) if (record?.plan?.planId !== undefined) this.#tasks.set(record.plan.job.jobId, record);
    } catch {
      // Corrupt temporary integration state is inspectable as unavailable; no job is resumed.
    }
  }

  private save(): void {
    mkdirSync(this.#root, { recursive: true });
    const path = join(this.#root, "office-tasks.json");
    const partial = path + ".partial";
    writeFileSync(partial, JSON.stringify([...this.#tasks.values()], null, 2) + "\n", "utf8");
    renameSync(partial, path);
  }
}

function outputName(request: OfficeTaskRequest): string {
  const base = (request.outputFileName ?? (request.kind === "edit" ? "edited-copy" : request.kind === "review" ? "reviewed-copy" : "generated-output")).replace(/[^a-z0-9._-]+/giu, "-");
  return base.toLowerCase().endsWith("." + request.format) ? base : base + "." + request.format;
}

function mediaType(format: OfficeFormat): string {
  return ({ docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pdf: "application/pdf" })[format];
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith(".." + sep) && !/^[A-Za-z]:/u.test(relativePath));
}
