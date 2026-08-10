import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { LocalJobSupervisor, type LocalJobManifest } from "./agent-runtime-supervisor.js";
import { VcSkillsDirectoryAdapter, type VcSkillImportResult, type VcSkillMetadata } from "./vc-skills-directory.js";

export type SkillDraftState = "requested" | "planned" | "running" | "draft_ready" | "reviewed" | "accepted_into_i1" | "discarded" | "failed" | "cancelled" | "timed_out" | "stale";

export interface CreateSkillDraftRequest {
  readonly explicitIntent: boolean;
  readonly packageId: string;
  readonly files: Readonly<Record<string, string>>;
  readonly dependencies?: readonly string[];
  readonly accessMode?: "standard" | "full";
}

export interface UpdateSkillDraftRequest {
  readonly explicitIntent: boolean;
  readonly draftId?: string;
  readonly packageId: string;
  /** Preferred target source path below the dedicated Skills Directory. */
  readonly targetSkillPath?: string;
  /** Preferred target Skill name. */
  readonly targetSkillName?: string;
  readonly files: Readonly<Record<string, string>>;
  readonly dependencies?: readonly string[];
  readonly accessMode?: "standard" | "full";
}

export interface SkillDraft {
  readonly schemaVersion: 1;
  readonly draftId: string;
  readonly packageId: string;
  readonly operation: "create" | "update";
  readonly state: SkillDraftState;
  readonly stagingPath: string;
  readonly targetSkillPath?: string;
  readonly targetSkillHash?: string;
  readonly targetHash?: string;
  readonly targetActiveHash?: string;
  readonly files: readonly string[];
  readonly dependencies: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failureCode?: string;
}

export interface SkillDraftReview {
  readonly draft: SkillDraft;
  readonly status: "reviewable" | "stale" | "blocked";
  readonly fileInventory: readonly string[];
  readonly dependencies: readonly string[];
  readonly executableEntryPoints: readonly string[];
  readonly contentPreview: string;
  readonly exactDiff: string;
  readonly compatibilityFindings: readonly string[];
}

export interface SkillCreatorAdapter {
  run(input: { readonly draft: SkillDraft; readonly files: Readonly<Record<string, string>>; readonly signal: AbortSignal }): Promise<{ readonly outputPaths: readonly string[]; readonly outputBytes: number }>;
  terminate?(jobId: string): Promise<void> | void;
}

interface StoredDraft extends SkillDraft {
  readonly inputFiles: Readonly<Record<string, string>>;
}

export class SkillCreationWorkflow {
  readonly #skills: VcSkillsDirectoryAdapter;
  readonly #root: string;
  readonly #now: () => string;
  readonly #adapter: SkillCreatorAdapter;
  readonly #jobs: LocalJobSupervisor;
  readonly #drafts = new Map<string, StoredDraft>();

  constructor(input: { skills: VcSkillsDirectoryAdapter | { readonly root: string }; root?: string; adapter?: SkillCreatorAdapter; now?: () => string }) {
    this.#skills = asAdapter(input.skills);
    // Draft files live outside the dedicated Skill source so Pi never
    // discovers an in-progress Creator package as an available Skill.
    this.#root = resolve(input.root ?? join(dirnameFor(this.#skills.root), "skill-creator"));
    this.#now = input.now ?? (() => new Date().toISOString());
    this.#adapter = input.adapter ?? defaultCreatorAdapter();
    this.#jobs = new LocalJobSupervisor({ capacity: 1, adapter: { run: async (manifest, signal) => {
      const draft = this.#drafts.get(manifest.jobId.startsWith("creator-") ? manifest.jobId.slice("creator-".length) : manifest.jobId);
      if (draft === undefined) throw new Error("SKILL_CREATOR_JOB_FAILED");
      return this.#adapter.run({ draft, files: draft.inputFiles, signal });
    }, terminate: (jobId) => this.#adapter.terminate?.(jobId) } });
    this.load();
  }

  async createDraft(request: CreateSkillDraftRequest): Promise<SkillDraft> {
    if (!request.explicitIntent) throw new Error("SKILL_CREATOR_CAPABILITY_REJECTED");
    return this.startDraft({ operation: "create", packageId: request.packageId, files: request.files, dependencies: request.dependencies ?? [] });
  }

  async updateDraft(request: UpdateSkillDraftRequest): Promise<SkillDraft> {
    if (!request.explicitIntent) throw new Error("SKILL_CREATOR_CAPABILITY_REJECTED");
    const target = this.resolveTarget(request.targetSkillPath, request.targetSkillName);
    if (target === undefined) throw new Error("SKILL_DRAFT_STALE");
    const base = readFiles(target.baseDir);
    const files = { ...base, ...request.files };
    return this.startDraft({ operation: "update", ...(request.draftId === undefined ? {} : { draftId: request.draftId }), packageId: request.packageId, files, dependencies: request.dependencies ?? [], targetSkillPath: target.baseDir, targetSkillHash: hashDirectory(target.baseDir) });
  }

  async review(draftId: string): Promise<SkillDraftReview> {
    const draft = this.#drafts.get(draftId);
    if (draft === undefined) throw new Error("SKILL_DRAFT_PATH_ESCAPE");
    if (!["draft_ready", "reviewed"].includes(draft.state)) throw new Error("SKILL_CREATOR_RESULT_INVALID");
    const currentTarget = draft.targetSkillPath === undefined ? undefined : this.resolveTarget(draft.targetSkillPath, undefined);
    const currentTargetHash = currentTarget === undefined ? undefined : hashDirectory(currentTarget.baseDir);
    if (draft.targetSkillPath !== undefined && (currentTarget === undefined || currentTargetHash !== draft.targetSkillHash)) {
      const stale = this.update(draft, { state: "stale" });
      this.#drafts.set(draftId, stale);
      this.save();
      return { draft: stale, status: "stale", fileInventory: listFiles(stale.stagingPath), dependencies: stale.dependencies, executableEntryPoints: executableFiles(stale.stagingPath), contentPreview: preview(stale.stagingPath), exactDiff: diffFor(draft, currentTarget === undefined ? {} : readFiles(currentTarget.baseDir)), compatibilityFindings: ["SKILL_DRAFT_STALE"] };
    }
    const reviewed = this.update(draft, { state: "reviewed" });
    this.#drafts.set(draftId, reviewed);
    this.save();
    const baseline = currentTarget === undefined ? {} : readFiles(currentTarget.baseDir);
    return {
      draft: reviewed,
      status: "reviewable",
      fileInventory: listFiles(reviewed.stagingPath),
      dependencies: reviewed.dependencies,
      executableEntryPoints: executableFiles(reviewed.stagingPath),
      contentPreview: preview(reviewed.stagingPath),
      exactDiff: diffFor(reviewed, baseline),
      compatibilityFindings: []
    };
  }

  async accept(draftId: string, options: { readonly confirmed?: boolean; readonly accessMode?: "standard" | "full" } = {}): Promise<VcSkillImportResult> {
    const draft = this.#drafts.get(draftId);
    if (draft === undefined || draft.state !== "reviewed") throw new Error("SKILL_CREATOR_RESULT_INVALID");
    if ((options.accessMode ?? "standard") === "standard" && options.confirmed !== true) throw new Error("SKILL_CREATOR_CAPABILITY_REJECTED");
    if (draft.targetSkillPath !== undefined) {
      const target = this.resolveTarget(draft.targetSkillPath, undefined);
      if (target === undefined || hashDirectory(target.baseDir) !== draft.targetSkillHash) throw new Error("SKILL_DRAFT_STALE");
    }
    const result = draft.targetSkillPath === undefined
      ? this.#skills.importSkill({ sourceDirectory: draft.stagingPath, destinationName: draft.packageId })
      : this.#skills.replaceSkill({ sourceDirectory: draft.stagingPath, destinationName: draft.packageId });
    const accepted = this.update(draft, { state: "accepted_into_i1" });
    this.#drafts.set(draftId, accepted);
    this.save();
    return result;
  }

  async discard(draftId: string): Promise<void> {
    const draft = this.#drafts.get(draftId);
    if (draft === undefined) return;
    rmSync(join(this.#root, draft.draftId), { recursive: true, force: true });
    this.#drafts.set(draftId, this.update(draft, { state: "discarded" }));
    this.save();
  }

  listDrafts(): SkillDraft[] {
    return [...this.#drafts.values()].map((draft) => ({ ...draft, files: [...draft.files], dependencies: [...draft.dependencies] }));
  }

  async cancel(draftId: string): Promise<void> { await this.#jobs.cancel("creator-" + draftId); }
  async shutdown(): Promise<void> { await this.#jobs.shutdown(10_000); }

  private resolveTarget(skillPath?: string, skillName?: string): VcSkillMetadata | undefined {
    const snapshot = this.#skills.discover();
    if (skillPath !== undefined) {
      const candidate = resolve(skillPath);
      const found = snapshot.skills.find((skill) => skill.baseDir === candidate || skill.filePath === candidate || skill.filePath === join(candidate, "SKILL.md"));
      if (found !== undefined && this.#skills.isContained(found.baseDir) && this.#skills.isContained(found.filePath)) return found;
    }
    if (skillName !== undefined) {
      const found = snapshot.skills.find((skill) => skill.name === skillName);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private async startDraft(input: { operation: "create" | "update"; draftId?: string; packageId: string; files: Readonly<Record<string, string>>; dependencies: readonly string[]; targetSkillPath?: string; targetSkillHash?: string }): Promise<SkillDraft> {
    const packageId = normalizePackageId(input.packageId);
    const draftId = input.draftId ?? randomUUID();
    const stageRoot = join(this.#root, draftId, "source");
    rmSync(join(this.#root, draftId), { recursive: true, force: true });
    mkdirSync(stageRoot, { recursive: true });
    for (const [path, content] of Object.entries(input.files)) {
      if (!safeRelativePath(path)) throw new Error("SKILL_DRAFT_PATH_ESCAPE");
      const destination = join(stageRoot, path);
      mkdirSync(dirnameFor(destination), { recursive: true });
      writeFileSync(destination, content, "utf8");
    }
    if (!listFiles(stageRoot).some((path) => basename(path).toLowerCase() === "skill.md")) throw new Error("SKILL_CREATOR_RESULT_INVALID");
    const now = this.#now();
    const draft: StoredDraft = {
      schemaVersion: 1,
      draftId,
      packageId,
      operation: input.operation,
      state: "running",
      stagingPath: stageRoot,
      ...(input.targetSkillPath === undefined ? {} : { targetSkillPath: input.targetSkillPath }),
      ...(input.targetSkillHash === undefined ? {} : { targetSkillHash: input.targetSkillHash }),
      files: listFiles(stageRoot),
      dependencies: [...input.dependencies],
      createdAt: now,
      updatedAt: now,
      inputFiles: { ...input.files }
    };
    this.#drafts.set(draftId, draft);
    this.save();
    const job: LocalJobManifest = {
      jobId: "creator-" + draftId,
      kind: "isolated",
      stagingDirectory: stageRoot,
      inputPaths: [],
      outputPaths: listFiles(stageRoot).map((path) => join(stageRoot, path)),
      timeoutMs: 300_000,
      maxOutputBytes: 20_000_000
    };
    try {
      const result = await this.#jobs.submit(job);
      const state = result.status === "completed" ? "draft_ready" : result.status === "cancelled" ? "cancelled" : result.status === "timed_out" ? "timed_out" : "failed";
      const updated = this.update(draft, { state, ...(result.code === undefined ? {} : { failureCode: result.code }) });
      this.#drafts.set(draftId, updated);
      this.save();
      return { ...updated, files: [...updated.files], dependencies: [...updated.dependencies] };
    } catch (error) {
      const updated = this.update(draft, { state: "failed", failureCode: error instanceof Error ? error.message : "SKILL_CREATOR_JOB_FAILED" });
      this.#drafts.set(draftId, updated);
      this.save();
      return updated;
    }
  }

  private update(draft: StoredDraft, patch: Partial<SkillDraft>): StoredDraft {
    return { ...draft, ...patch, updatedAt: this.#now() };
  }

  private load(): void {
    const path = join(this.#root, "drafts.json");
    if (!existsSync(path)) return;
    try {
      const records = JSON.parse(readFileSync(path, "utf8")) as StoredDraft[];
      for (const record of records) if (record?.draftId !== undefined && record.state !== "running") this.#drafts.set(record.draftId, record);
    } catch {
      // Incomplete Creator state is left unavailable and is never resumed.
    }
  }

  private save(): void {
    mkdirSync(this.#root, { recursive: true });
    const path = join(this.#root, "drafts.json");
    const partial = path + ".partial";
    writeFileSync(partial, JSON.stringify([...this.#drafts.values()], null, 2) + "\n", "utf8");
    renameSync(partial, path);
  }
}

function defaultCreatorAdapter(): SkillCreatorAdapter {
  return {
    run: async ({ draft }) => ({ outputPaths: listFiles(draft.stagingPath).map((path) => join(draft.stagingPath, path)), outputBytes: listFiles(draft.stagingPath).reduce((total, path) => total + statSync(join(draft.stagingPath, path)).size, 0) })
  };
}

function normalizePackageId(value: string): string {
  const result = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (result === "") throw new Error("SKILL_CREATOR_RESULT_INVALID");
  return result;
}

function dirnameFor(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index < 0 ? "." : path.slice(0, index);
}

function safeRelativePath(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !path.startsWith("\\") && !path.includes("..") && !/^[A-Za-z]:/u.test(path);
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  visit(root);
  return files.sort();
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
    }
  }
}

function readFiles(root: string): Record<string, string> {
  return Object.fromEntries(listFiles(root).filter((path) => isText(path)).map((path) => [path, readFileSync(join(root, path), "utf8")]));
}

function hashDirectory(root: string): string {
  const hash = createHash("sha256");
  for (const path of listFiles(root)) {
    hash.update(path, "utf8");
    hash.update(readFileSync(join(root, path)));
  }
  return hash.digest("hex");
}

function isText(path: string): boolean {
  return new Set([".md", ".txt", ".json", ".yaml", ".yml", ".xml", ".csv", ".py", ".js", ".ts", ".sh", ".ps1"]).has(extname(path).toLowerCase());
}

function executableFiles(root: string): string[] {
  return listFiles(root).filter((path) => new Set([".py", ".js", ".mjs", ".cjs", ".sh", ".ps1", ".bat", ".cmd", ".exe"]).has(extname(path).toLowerCase()));
}

function preview(root: string): string {
  const skill = listFiles(root).find((path) => basename(path).toLowerCase() === "skill.md");
  return skill === undefined ? "" : readFileSync(join(root, skill), "utf8").slice(0, 4_000);
}

function diffFor(draft: SkillDraft, baseline: Readonly<Record<string, string>>): string {
  const current = readFiles(draft.stagingPath);
  const paths = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
  const lines = ["--- target", "+++ draft"];
  for (const path of paths) {
    const before = baseline[path];
    const after = current[path];
    if (before === after) continue;
    if (before !== undefined) lines.push("- " + path + ": " + before.slice(0, 2_000));
    if (after !== undefined) lines.push("+ " + path + ": " + after.slice(0, 2_000));
  }
  return lines.join("\n");
}

function asAdapter(source: (VcSkillsDirectoryAdapter | { readonly root: string }) | undefined): VcSkillsDirectoryAdapter {
  if (source === undefined) throw new Error("VC_SKILLS_DIRECTORY_REQUIRED");
  if (source instanceof VcSkillsDirectoryAdapter) return source;
  return new VcSkillsDirectoryAdapter({ root: source.root });
}
