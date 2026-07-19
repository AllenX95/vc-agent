import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  LONG_TERM_MEMORY_ARCHIVE_HEADER,
  LongTermMemoryStore,
  createLongTermMemoryIndexContent,
  parseLongTermMemory,
  type LongTermMemoryEntry,
  type LongTermMemoryMaturity,
  type LongTermMemoryRecallPolicy
} from "./long-term-memory.js";

const MISSING_HASH = "missing";

export type MemoryEvolutionAction = "add" | "reinforce" | "narrow" | "revise" | "contradict" | "merge_condense";

export interface MemoryLearningDraft {
  readonly id?: string | undefined;
  readonly title: string;
  readonly date: string;
  readonly tags: readonly string[];
  readonly applicability: readonly string[];
  readonly maturity: LongTermMemoryMaturity;
  readonly recallPolicy: LongTermMemoryRecallPolicy;
  readonly limitations: string;
  readonly content: string;
  readonly sourceReferenceIds: readonly string[];
}

export interface LocalMemoryProvenanceRecord {
  readonly schemaVersion: 1;
  readonly sourceReferenceId: string;
  readonly scope?: "project" | "unscoped" | undefined;
  readonly projectId?: string | undefined;
  readonly workflowType: "reflection" | "dream";
  readonly workflowRunId: string;
  readonly judgmentRecordId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly outputId?: string | undefined;
  readonly evidenceReferences: string[];
  readonly availability: "active" | "source_unavailable";
  readonly createdAt: string;
}

export interface MemoryPatchRequest {
  readonly action: MemoryEvolutionAction;
  readonly targetEntryIds: readonly string[];
  readonly proposed?: MemoryLearningDraft | undefined;
  readonly rationale: string;
  readonly resolutionSignal?: {
    readonly type: "user_correction" | "approved_reflection" | "approved_retrospective";
    readonly referenceId: string;
  } | undefined;
  readonly provenanceRecords?: readonly LocalMemoryProvenanceRecord[] | undefined;
}

export interface MemoryPatchFileDiff {
  readonly kind: "active" | "condensation_archive" | "cognitive_evolution_history" | "local_provenance" | "recall_index";
  readonly path: string;
  readonly baseHash: string;
  readonly resultHash: string;
  readonly changed: boolean;
  readonly diff: string;
}

export interface PreparedMemoryPatch {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly action: MemoryEvolutionAction;
  readonly targetEntryIds: string[];
  readonly rationale: string;
  readonly createdAt: string;
  readonly confirmationRequired: true;
  readonly lineageDiff: string;
  readonly files: MemoryPatchFileDiff[];
}

export type CondensationRetention = 30 | 90 | 180 | 365 | "permanent";

export interface CondensationArchiveItem {
  readonly archiveId: string;
  readonly archivedAt: string;
  readonly reason: string;
  readonly sourceEntries: string[];
  readonly replacement: string;
  readonly kept: boolean;
  readonly eligibleForCleanup: boolean;
  readonly expiresAt?: string | undefined;
}

export interface MemoryMaintenanceState {
  readonly schemaVersion: 1;
  readonly retention: CondensationRetention;
  readonly automaticDeletion: boolean;
  readonly archiveItems: CondensationArchiveItem[];
}

export interface LocalMemoryProvenanceInspection {
  readonly sourceReferenceId: string;
  readonly status: "available" | "source_unavailable";
  readonly record?: LocalMemoryProvenanceRecord & { readonly scope: "project" | "unscoped" } | undefined;
}

interface StoredMemoryPatch extends PreparedMemoryPatch {
  readonly resultContents: Record<MemoryPatchFileDiff["kind"], string>;
}

interface TransactionTarget {
  readonly targetPath: string;
  readonly stagedPath: string;
  readonly backupPath: string;
  readonly existed: boolean;
}

interface TransactionManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly phase: "prepared" | "committed";
  readonly targets: readonly TransactionTarget[];
}

export interface MemoryEvolutionStoreOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly failAfterTargetActivation?: number;
}

export class MemoryEvolutionStore {
  readonly #memory: LongTermMemoryStore;
  readonly #memoryRoot: string;
  readonly #patchRoot: string;
  readonly #transactionRoot: string;
  readonly #provenancePath: string;
  readonly #maintenancePath: string;
  readonly #cleanupLogPath: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #failAfterTargetActivation: number | undefined;
  #committing = false;

  constructor(memory: LongTermMemoryStore, options: MemoryEvolutionStoreOptions = {}) {
    this.#memory = memory;
    this.#memoryRoot = dirname(memory.rootPath);
    this.#patchRoot = join(this.#memoryRoot, "patches");
    this.#transactionRoot = join(this.#memoryRoot, "transactions");
    this.#provenancePath = join(this.#memoryRoot, "local-memory-provenance.jsonl");
    this.#maintenancePath = join(this.#memoryRoot, "long-term-maintenance.json");
    this.#cleanupLogPath = join(this.#memoryRoot, "condensation-cleanup.jsonl");
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#failAfterTargetActivation = options.failAfterTargetActivation;
    this.recoverTransactions();
  }

  get provenancePath(): string { return this.#provenancePath; }

  prepare(request: MemoryPatchRequest): PreparedMemoryPatch {
    const document = this.#memory.load(true)!;
    const current = document.entries.filter((entry) => entry.status === "current");
    const targets = request.targetEntryIds.map((id) => current.find((entry) => entry.id === id));
    this.#validateRequest(request, targets);

    const now = this.#now().toISOString();
    const patchId = this.#createId();
    const before = this.#readState();
    const evolved = evolveMemory(current, request, now, patchId);
    const active = renderActivePatch(before.active, current, evolved.entries);
    validateActiveEvolution(active, evolved.entries);
    const archive = appendSection(before.condensation_archive, evolved.archiveSection);
    const history = appendSection(before.cognitive_evolution_history, evolved.historySection);
    const localProvenance = appendProvenance(before.local_provenance, request.provenanceRecords ?? [], evolved.entries);
    const recallIndex = createLongTermMemoryIndexContent(active);
    const resultContents = { active, condensation_archive: archive, cognitive_evolution_history: history, local_provenance: localProvenance, recall_index: recallIndex };
    const paths = this.#paths();
    const kinds = Object.keys(resultContents) as Array<keyof typeof resultContents>;
    const files = kinds.map((kind): MemoryPatchFileDiff => ({
      kind,
      path: paths[kind],
      baseHash: stateHash(paths[kind], before[kind]),
      resultHash: before[kind] === resultContents[kind] ? stateHash(paths[kind], before[kind]) : hash(resultContents[kind]),
      changed: before[kind] !== resultContents[kind],
      diff: textDiff(basename(paths[kind]), before[kind], resultContents[kind])
    }));
    if (!files.some((file) => file.changed)) throw new Error("MEMORY_PATCH_NO_CHANGES");
    const patch: StoredMemoryPatch = {
      schemaVersion: 1,
      id: patchId,
      action: request.action,
      targetEntryIds: [...request.targetEntryIds],
      rationale: request.rationale.trim(),
      createdAt: now,
      confirmationRequired: true,
      lineageDiff: evolved.lineageDiff,
      files,
      resultContents
    };
    mkdirSync(this.#patchRoot, { recursive: true });
    atomicWrite(this.#patchPath(patch.id), `${JSON.stringify(patch, null, 2)}\n`);
    return publicPatch(patch);
  }

  loadPrepared(id: string): PreparedMemoryPatch | undefined {
    const patch = this.#readPatch(id);
    return patch === undefined ? undefined : publicPatch(patch);
  }

  discard(id: string): boolean {
    const path = this.#patchPath(id);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  loadMaintenance(create = true): MemoryMaintenanceState {
    const settings = this.#readMaintenanceSettings(create);
    const archiveContent = existsSync(this.#memory.archivePath) ? readFileSync(this.#memory.archivePath, "utf8") : LONG_TERM_MEMORY_ARCHIVE_HEADER;
    return { ...settings, archiveItems: parseArchiveItems(archiveContent, settings.retention, this.#now()) };
  }

  saveMaintenanceSettings(retention: CondensationRetention, automaticDeletion: boolean): MemoryMaintenanceState {
    if (![30, 90, 180, 365, "permanent"].includes(retention)) throw new Error("INVALID_CONDENSATION_RETENTION");
    const settings = { schemaVersion: 1 as const, retention, automaticDeletion };
    atomicWrite(this.#maintenancePath, `${JSON.stringify(settings, null, 2)}\n`);
    return this.loadMaintenance(false);
  }

  updateArchiveItem(archiveId: string, action: "keep" | "refresh"): MemoryMaintenanceState {
    const settings = this.#readMaintenanceSettings(true);
    const content = read(this.#memory.archivePath);
    const sections = archiveSections(content);
    const section = sections.find((item) => item.archiveId === archiveId);
    if (section === undefined) throw new Error("CONDENSATION_ARCHIVE_ITEM_NOT_FOUND");
    const replacement = action === "keep"
      ? replaceMetadata(section.content, "Keep", "true")
      : replaceMetadata(replaceMetadata(section.content, "Archived-At", this.#now().toISOString()), "Keep", "false");
    atomicWrite(this.#memory.archivePath, replaceArchiveSection(content, section, replacement));
    return { ...settings, archiveItems: parseArchiveItems(read(this.#memory.archivePath), settings.retention, this.#now()) };
  }

  cleanupArchive(archiveIds?: readonly string[]): MemoryMaintenanceState {
    const settings = this.#readMaintenanceSettings(true);
    const content = read(this.#memory.archivePath);
    const items = parseArchiveItems(content, settings.retention, this.#now());
    const requested = archiveIds === undefined
      ? settings.automaticDeletion ? new Set(items.filter((item) => item.eligibleForCleanup).map((item) => item.archiveId)) : new Set<string>()
      : new Set(archiveIds);
    const eligible = new Set(items.filter((item) => item.eligibleForCleanup && requested.has(item.archiveId)).map((item) => item.archiveId));
    if (eligible.size === 0) return { ...settings, archiveItems: items };
    const sections = archiveSections(content);
    let result = content;
    for (const section of [...sections].reverse()) if (eligible.has(section.archiveId)) result = `${result.slice(0, section.start)}${result.slice(section.end)}`;
    atomicWrite(this.#memory.archivePath, `${result.trimEnd()}\n`);
    const logRecords = [...eligible].map((archiveId) => JSON.stringify({ schemaVersion: 1, archiveId, deletedAt: this.#now().toISOString(), retention: settings.retention }));
    const priorLog = read(this.#cleanupLogPath);
    atomicWrite(this.#cleanupLogPath, `${priorLog.trimEnd()}${priorLog.trim() ? "\n" : ""}${logRecords.join("\n")}\n`);
    return this.loadMaintenance(false);
  }

  inspectProvenance(sourceReferenceId: string, sourceProjectId: string): LocalMemoryProvenanceInspection {
    if (!opaqueId(sourceReferenceId)) throw new Error("INVALID_LOCAL_MEMORY_SOURCE_REFERENCE");
    const record = readProvenance(this.#provenancePath).find((item) => item.sourceReferenceId === sourceReferenceId && item.projectId === sourceProjectId);
    if (record === undefined || record.availability === "source_unavailable") return { sourceReferenceId, status: "source_unavailable" };
    return { sourceReferenceId, status: "available", record: { ...record, scope: record.scope ?? "project" } };
  }

  preferredMemoryEntryIds(projectId: string): Set<string> {
    const sourceReferences = new Set(readProvenance(this.#provenancePath).filter((record) => record.projectId === projectId && record.availability === "active").map((record) => record.sourceReferenceId));
    return new Set(this.#memory.readCurrent().entries.filter((entry) => entry.sourceReferenceIds.some((reference) => sourceReferences.has(reference))).map((entry) => entry.id));
  }

  commit(id: string): ReturnType<LongTermMemoryStore["rebuild"]> {
    if (this.#committing) throw new Error("MEMORY_EVOLUTION_COMMIT_IN_PROGRESS");
    const patch = this.#readPatch(id);
    if (patch === undefined) throw new Error("MEMORY_PATCH_NOT_FOUND");
    const current = this.#readState();
    const paths = this.#paths();
    for (const file of patch.files) {
      if (stateHash(paths[file.kind], current[file.kind]) !== file.baseHash) throw new Error("STALE_MEMORY_PATCH");
    }
    validateResultState(patch.resultContents);
    this.#committing = true;
    try {
      this.#commitTransaction(patch);
      rmSync(this.#patchPath(id), { force: true });
      return this.#memory.readCurrent();
    } finally {
      this.#committing = false;
    }
  }

  recoverTransactions(): void {
    if (!existsSync(this.#transactionRoot)) return;
    for (const name of readdirSync(this.#transactionRoot)) {
      const root = join(this.#transactionRoot, name);
      const manifestPath = join(root, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TransactionManifest;
      if (manifest.phase === "prepared") rollback(manifest);
      rmSync(root, { recursive: true, force: true });
    }
  }

  #validateRequest(request: MemoryPatchRequest, targets: readonly (LongTermMemoryEntry | undefined)[]): void {
    if (!request.rationale.trim()) throw new Error("MEMORY_PATCH_RATIONALE_REQUIRED");
    if (targets.some((entry) => entry === undefined)) throw new Error("MEMORY_PATCH_TARGET_NOT_FOUND");
    const expectedTargets = request.action === "add" ? 0 : request.action === "merge_condense" ? 2 : 1;
    if (request.action === "merge_condense" ? targets.length < expectedTargets : targets.length !== expectedTargets) throw new Error("MEMORY_PATCH_TARGET_COUNT_INVALID");
    if (request.action !== "reinforce" && request.proposed === undefined) throw new Error("MEMORY_PATCH_PROPOSED_LEARNING_REQUIRED");
    if ((request.action === "narrow" || request.action === "revise") && request.resolutionSignal === undefined) throw new Error("MEMORY_PATCH_RESOLUTION_SIGNAL_REQUIRED");
    if (request.action === "revise" && !["user_correction", "approved_reflection", "approved_retrospective"].includes(request.resolutionSignal!.type)) throw new Error("MEMORY_PATCH_REVISION_NOT_ATTRIBUTABLE");
    for (const record of request.provenanceRecords ?? []) validateProvenance(record);
    if (request.proposed !== undefined && request.proposed.maturity !== "user-confirmed") {
      const available = new Set([...readProvenance(this.#provenancePath).filter((record) => record.availability === "active").map((record) => record.sourceReferenceId), ...(request.provenanceRecords ?? []).filter((record) => record.availability === "active").map((record) => record.sourceReferenceId)]);
      if (request.proposed.sourceReferenceIds.length === 0 || request.proposed.sourceReferenceIds.some((reference) => !available.has(reference))) throw new Error("MEMORY_PATCH_MATURITY_PROVENANCE_REQUIRED");
    }
  }

  #readState(): Record<MemoryPatchFileDiff["kind"], string> {
    const paths = this.#paths();
    return {
      active: read(paths.active),
      condensation_archive: read(paths.condensation_archive),
      cognitive_evolution_history: read(paths.cognitive_evolution_history),
      local_provenance: read(paths.local_provenance),
      recall_index: read(paths.recall_index)
    };
  }

  #paths(): Record<MemoryPatchFileDiff["kind"], string> {
    return {
      active: this.#memory.markdownPath,
      condensation_archive: this.#memory.archivePath,
      cognitive_evolution_history: this.#memory.historyPath,
      local_provenance: this.#provenancePath,
      recall_index: this.#memory.indexPath
    };
  }

  #patchPath(id: string): string {
    if (!/^[a-z0-9-]{8,80}$/iu.test(id)) throw new Error("INVALID_MEMORY_PATCH_ID");
    return join(this.#patchRoot, `${id}.json`);
  }

  #readPatch(id: string): StoredMemoryPatch | undefined {
    const path = this.#patchPath(id);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as StoredMemoryPatch : undefined;
  }

  #readMaintenanceSettings(create: boolean): Omit<MemoryMaintenanceState, "archiveItems"> {
    if (!existsSync(this.#maintenancePath)) {
      const defaults = { schemaVersion: 1 as const, retention: 90 as const, automaticDeletion: false };
      if (create) atomicWrite(this.#maintenancePath, `${JSON.stringify(defaults, null, 2)}\n`);
      return defaults;
    }
    const parsed = JSON.parse(readFileSync(this.#maintenancePath, "utf8")) as Omit<MemoryMaintenanceState, "archiveItems">;
    if (parsed.schemaVersion !== 1 || ![30, 90, 180, 365, "permanent"].includes(parsed.retention) || typeof parsed.automaticDeletion !== "boolean") throw new Error("INVALID_MEMORY_MAINTENANCE_SETTINGS");
    return parsed;
  }

  #commitTransaction(patch: StoredMemoryPatch): void {
    const root = join(this.#transactionRoot, patch.id);
    mkdirSync(root, { recursive: true });
    const paths = this.#paths();
    const targets = patch.files.filter((file) => file.changed).map((file, index): TransactionTarget => {
      const stagedPath = join(root, `${index}.staged`);
      const backupPath = join(root, `${index}.backup`);
      writeFileSync(stagedPath, patch.resultContents[file.kind], "utf8");
      return { targetPath: paths[file.kind], stagedPath, backupPath, existed: existsSync(paths[file.kind]) };
    });
    let manifest: TransactionManifest = { schemaVersion: 1, id: patch.id, phase: "prepared", targets };
    const manifestPath = join(root, "manifest.json");
    atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    try {
      let activated = 0;
      for (const target of targets) {
        mkdirSync(dirname(target.targetPath), { recursive: true });
        if (target.existed) renameSync(target.targetPath, target.backupPath);
        renameSync(target.stagedPath, target.targetPath);
        activated += 1;
        if (this.#failAfterTargetActivation === activated) throw new Error("INJECTED_MEMORY_TRANSACTION_FAILURE");
      }
      manifest = { ...manifest, phase: "committed" };
      atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      rollback(manifest);
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }
}

interface EvolutionResult {
  readonly entries: LongTermMemoryEntry[];
  readonly historySection?: string;
  readonly archiveSection?: string;
  readonly lineageDiff: string;
}

function evolveMemory(entries: readonly LongTermMemoryEntry[], request: MemoryPatchRequest, now: string, patchId: string): EvolutionResult {
  const targets = entries.filter((entry) => request.targetEntryIds.includes(entry.id));
  const proposed = request.proposed;
  const sourceReferences = unique([...(proposed?.sourceReferenceIds ?? []), ...((request.provenanceRecords ?? []).map((record) => record.sourceReferenceId))]);
  if (request.action === "add") {
    const added = draftEntry(proposed!, proposed!.id ?? `ltm-${patchId.replace(/-/gu, "").slice(0, 20)}`, 1, "none", sourceReferences);
    ensureUniqueId(entries, added.id);
    return { entries: [...entries, added], lineageDiff: `Add ${added.id} v1 as current.` };
  }
  if (request.action === "reinforce") {
    const target = targets[0]!;
    const maturity = proposed?.maturity ?? target.maturity;
    if (maturityRank(maturity) < maturityRank(target.maturity)) throw new Error("MEMORY_REINFORCEMENT_CANNOT_LOWER_MATURITY");
    const reinforced = { ...target, maturity, sourceReferenceIds: unique([...target.sourceReferenceIds, ...sourceReferences]), provenanceStatus: unique([...target.sourceReferenceIds, ...sourceReferences]).length > 0 ? "traceable" as const : target.provenanceStatus };
    return { entries: replaceEntries(entries, [target.id], reinforced), lineageDiff: `Reinforce ${target.id} v${target.version}; meaning and version unchanged.` };
  }
  if (request.action === "narrow" || request.action === "revise") {
    const target = targets[0]!;
    const next = draftEntry(proposed!, target.id, target.version + 1, target.conflictState, unique([...target.sourceReferenceIds, ...sourceReferences]));
    const history = historySection(request.action, now, patchId, request.rationale, [target], [next], request.resolutionSignal?.referenceId);
    return { entries: replaceEntries(entries, [target.id], next), historySection: history, lineageDiff: `${capitalize(request.action)} ${target.id} v${target.version} -> v${next.version}; prior wording preserved in Cognitive Evolution History.` };
  }
  if (request.action === "contradict") {
    const target = targets[0]!;
    const conflictId = `unresolved:conflict_${patchId.replace(/-/gu, "").slice(0, 20)}`;
    const existing = { ...target, version: target.version + 1, conflictState: conflictId };
    const opposing = draftEntry(proposed!, proposed!.id ?? `ltm-${patchId.replace(/-/gu, "").slice(0, 20)}`, 1, conflictId, sourceReferences);
    ensureUniqueId(entries, opposing.id);
    const history = historySection("contradict", now, patchId, request.rationale, [target], [existing, opposing]);
    return { entries: [...replaceEntries(entries, [target.id], existing), opposing], historySection: history, lineageDiff: `Contradict ${target.id}: preserve both ${existing.id} v${existing.version} and ${opposing.id} v1 in ${conflictId}.` };
  }
  const replacementId = proposed!.id ?? targets[0]!.id;
  if (!request.targetEntryIds.includes(replacementId)) ensureUniqueId(entries, replacementId);
  const replacementVersion = replacementId === targets[0]!.id ? targets[0]!.version + 1 : 1;
  const replacement = draftEntry(proposed!, replacementId, replacementVersion, "none", unique([...targets.flatMap((entry) => entry.sourceReferenceIds), ...sourceReferences]));
  return {
    entries: replaceEntries(entries, request.targetEntryIds, replacement),
    archiveSection: archiveSection(now, patchId, request.rationale, targets, replacement),
    lineageDiff: `Merge / Condense ${targets.map((entry) => `${entry.id} v${entry.version}`).join(", ")} -> ${replacement.id} v${replacement.version}; removed wording preserved only in Condensation Archive.`
  };
}

function draftEntry(draft: MemoryLearningDraft, id: string, version: number, conflictState: string, sourceReferenceIds: readonly string[]): LongTermMemoryEntry {
  return {
    id,
    version,
    status: "current",
    title: draft.title.trim(),
    date: draft.date,
    tags: cleanList(draft.tags),
    applicability: cleanList(draft.applicability),
    maturity: draft.maturity,
    recallPolicy: draft.recallPolicy,
    conflictState,
    limitations: draft.limitations.trim(),
    content: draft.content.trim(),
    sourceReferenceIds: unique(sourceReferenceIds),
    provenanceStatus: sourceReferenceIds.length > 0 ? "traceable" : "user-authored-no-evidence"
  };
}

function renderEntry(entry: LongTermMemoryEntry): string {
  return `## ${entry.date} - ${entry.title}\nID: ${entry.id}\nVersion: ${entry.version}\nStatus: current\nTags: ${entry.tags.join(", ")}\nScope: global\nApplies To: ${entry.applicability.join(", ")}\nMaturity: ${entry.maturity}\nRecall: ${entry.recallPolicy}\nConflict: ${entry.conflictState}\nLimitations: ${entry.limitations}\nSource References: ${entry.sourceReferenceIds.join(", ")}\n\n${entry.content}\n`;
}

function renderActivePatch(content: string, before: readonly LongTermMemoryEntry[], after: readonly LongTermMemoryEntry[]): string {
  const beforeById = new Map(before.map((entry) => [entry.id, entry]));
  const afterById = new Map(after.map((entry) => [entry.id, entry]));
  const emitted = new Set<string>();
  const sections = memoryEntrySections(content);
  let result = "";
  let cursor = 0;
  for (const section of sections) {
    result += content.slice(cursor, section.start);
    cursor = section.end;
    const beforeEntry = beforeById.get(section.id);
    if (beforeEntry === undefined) {
      result += section.content;
      continue;
    }
    const afterEntry = afterById.get(section.id);
    if (afterEntry === undefined) continue;
    emitted.add(afterEntry.id);
    result += entriesEqual(beforeEntry, afterEntry) ? section.content : renderEntry(afterEntry);
  }
  result += content.slice(cursor);
  const additions = after.filter((entry) => !beforeById.has(entry.id) && !emitted.has(entry.id));
  if (additions.length > 0) result = `${result.trimEnd()}\n\n${additions.map(renderEntry).join("\n")}`;
  return result;
}

function memoryEntrySections(content: string): Array<{ id: string; start: number; end: number; content: string }> {
  const starts = [...content.matchAll(/^##\s+.*$/gmu)].map((match) => ({ index: match.index, heading: match[0] }));
  return starts.flatMap((start, index) => {
    const end = starts[index + 1]?.index ?? content.length;
    const section = content.slice(start.index, end);
    const explicitId = metadata(section, "ID");
    if (explicitId) return [{ id: explicitId, start: start.index, end, content: section }];
    const dated = /^##\s+(\d{4}-\d{2}-\d{2})\s+-\s+(.+?)\s*$/mu.exec(start.heading);
    return dated ? [{ id: `ltm-${hash(`${dated[1]}\n${dated[2]}`).slice(0, 20)}`, start: start.index, end, content: section }] : [];
  });
}

function entriesEqual(left: LongTermMemoryEntry, right: LongTermMemoryEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateActiveEvolution(content: string, expected: readonly LongTermMemoryEntry[]): void {
  const parsed = parseLongTermMemory(content);
  const actualIds = parsed.entries.filter((entry) => entry.status === "current").map((entry) => entry.id).sort();
  const expectedIds = expected.map((entry) => entry.id).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) throw new Error("INVALID_MEMORY_PATCH_RESULT");
}

function historySection(action: "narrow" | "revise" | "contradict", now: string, patchId: string, rationale: string, previous: readonly LongTermMemoryEntry[], current: readonly LongTermMemoryEntry[], resolutionReference?: string): string {
  return `## ${now} - ${capitalize(action)}\nPatch-ID: ${patchId}\nAction: ${capitalize(action)}\nPrevious: ${previous.map((entry) => `${entry.id}@${entry.version}`).join(", ")}\nCurrent: ${current.map((entry) => `${entry.id}@${entry.version}`).join(", ")}\nResolution-Reference: ${resolutionReference ?? "none"}\nRationale: ${rationale.trim()}\n\n### Earlier wording\n\n${previous.map(renderEntry).join("\n")}`;
}

function archiveSection(now: string, patchId: string, rationale: string, previous: readonly LongTermMemoryEntry[], replacement: LongTermMemoryEntry): string {
  return `## ${now} - Merge / Condense\nArchive-ID: ${patchId}\nPatch-ID: ${patchId}\nAction: Merge / Condense\nArchived-At: ${now}\nReason: ${rationale.trim()}\nSource-Entries: ${previous.map((entry) => `${entry.id}@${entry.version}`).join(", ")}\nReplacement: ${replacement.id}@${replacement.version}\nRetention-Status: eligible-by-policy\nKeep: false\n\n${previous.map(renderEntry).join("\n")}`;
}

function appendSection(content: string, section?: string): string {
  if (section === undefined) return content;
  return `${content.trimEnd()}\n\n${section.trim()}\n`;
}

function appendProvenance(content: string, records: readonly LocalMemoryProvenanceRecord[], entries: readonly LongTermMemoryEntry[]): string {
  const referenced = new Set(entries.flatMap((entry) => entry.sourceReferenceIds));
  const existingRecords = readProvenanceContent(content);
  const existing = new Map(existingRecords.map((record) => [record.sourceReferenceId, record]));
  const additions: LocalMemoryProvenanceRecord[] = [];
  for (const record of records) {
    if (!referenced.has(record.sourceReferenceId)) continue;
    const prior = existing.get(record.sourceReferenceId) ?? additions.find((item) => item.sourceReferenceId === record.sourceReferenceId);
    if (prior !== undefined) {
      if (JSON.stringify(prior) !== JSON.stringify(record)) throw new Error("CONFLICTING_LOCAL_MEMORY_PROVENANCE");
      continue;
    }
    additions.push(record);
  }
  return `${content.trimEnd()}${content.trim() && additions.length ? "\n" : ""}${additions.map((record) => JSON.stringify(record)).join("\n")}${additions.length ? "\n" : ""}`;
}

function validateResultState(state: StoredMemoryPatch["resultContents"]): void {
  for (const line of state.local_provenance.split(/\r?\n/gu).filter(Boolean)) validateProvenance(JSON.parse(line) as LocalMemoryProvenanceRecord);
  const index = JSON.parse(state.recall_index) as { sourceHash?: string };
  if (index.sourceHash !== hash(state.active)) throw new Error("INVALID_MEMORY_PATCH_INDEX");
}

function validateProvenance(record: LocalMemoryProvenanceRecord): void {
  const scope = record.scope ?? (record.projectId === undefined ? "unscoped" : "project");
  if (record.schemaVersion !== 1 || !opaqueId(record.sourceReferenceId) || !record.workflowRunId || !record.createdAt || Number.isNaN(Date.parse(record.createdAt)) || (scope === "project" && !record.projectId) || (scope === "unscoped" && record.projectId !== undefined)) throw new Error("INVALID_LOCAL_MEMORY_PROVENANCE");
}

interface ArchiveSection {
  readonly archiveId: string;
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

function archiveSections(content: string): ArchiveSection[] {
  const starts = [...content.matchAll(/^## (?=\d{4}-\d{2}-\d{2}T.* - Merge \/ Condense$)/gmu)].map((match) => match.index);
  return starts.flatMap((start, index) => {
    const end = starts[index + 1] ?? content.length;
    const section = content.slice(start, end);
    const archiveId = metadata(section, "Archive-ID") || metadata(section, "Patch-ID");
    return archiveId ? [{ archiveId, start, end, content: section }] : [];
  });
}

function parseArchiveItems(content: string, retention: CondensationRetention, now: Date): CondensationArchiveItem[] {
  return archiveSections(content).map((section) => {
    const archivedAt = metadata(section.content, "Archived-At");
    const kept = metadata(section.content, "Keep") === "true";
    const expiration = retention === "permanent" || !archivedAt ? undefined : new Date(new Date(archivedAt).getTime() + retention * 86_400_000);
    return {
      archiveId: section.archiveId,
      archivedAt,
      reason: metadata(section.content, "Reason"),
      sourceEntries: metadata(section.content, "Source-Entries").split(",").map((item) => item.trim()).filter(Boolean),
      replacement: metadata(section.content, "Replacement"),
      kept,
      eligibleForCleanup: !kept && expiration !== undefined && expiration.getTime() <= now.getTime(),
      ...(expiration === undefined ? {} : { expiresAt: expiration.toISOString() })
    };
  });
}

function replaceArchiveSection(content: string, section: ArchiveSection, replacement: string): string {
  return `${content.slice(0, section.start)}${replacement}${content.slice(section.end)}`;
}

function replaceMetadata(section: string, name: string, value: string): string {
  const pattern = new RegExp(`^${name}:.*$`, "mu");
  if (!pattern.test(section)) throw new Error("MALFORMED_CONDENSATION_ARCHIVE_ITEM");
  return section.replace(pattern, `${name}: ${value}`);
}

function metadata(section: string, name: string): string {
  return new RegExp(`^${name}:\\s*(.*)$`, "mu").exec(section)?.[1]?.trim() ?? "";
}

function readProvenance(path: string): LocalMemoryProvenanceRecord[] {
  return readProvenanceContent(read(path));
}

function readProvenanceContent(content: string): LocalMemoryProvenanceRecord[] {
  return content.split(/\r?\n/gu).filter(Boolean).map((line) => {
    try {
      const record = JSON.parse(line) as LocalMemoryProvenanceRecord;
      validateProvenance(record);
      return record;
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_LOCAL_MEMORY_PROVENANCE") throw error;
      throw new Error("MALFORMED_LOCAL_MEMORY_PROVENANCE");
    }
  });
}

function replaceEntries(entries: readonly LongTermMemoryEntry[], ids: readonly string[], replacement: LongTermMemoryEntry): LongTermMemoryEntry[] {
  const first = entries.findIndex((entry) => ids.includes(entry.id));
  const remaining = entries.filter((entry) => !ids.includes(entry.id));
  remaining.splice(Math.max(0, first), 0, replacement);
  return remaining;
}

function ensureUniqueId(entries: readonly LongTermMemoryEntry[], id: string): void {
  if (!opaqueId(id)) throw new Error("INVALID_LONG_TERM_MEMORY_ID");
  if (entries.some((entry) => entry.id === id)) throw new Error("DUPLICATE_LONG_TERM_MEMORY_ID");
}

function publicPatch(patch: StoredMemoryPatch): PreparedMemoryPatch {
  const { resultContents: _resultContents, ...result } = patch;
  return result;
}

function rollback(manifest: TransactionManifest): void {
  for (const target of [...manifest.targets].reverse()) {
    if (existsSync(target.backupPath)) {
      rmSync(target.targetPath, { force: true });
      mkdirSync(dirname(target.targetPath), { recursive: true });
      renameSync(target.backupPath, target.targetPath);
    } else if (!target.existed) {
      rmSync(target.targetPath, { force: true });
    }
  }
}

function textDiff(label: string, before: string, after: string): string {
  if (before === after) return `--- ${label}\n+++ ${label}\n(no changes)\n`;
  const left = before.replace(/\r\n?/gu, "\n").split("\n");
  const right = after.replace(/\r\n?/gu, "\n").split("\n");
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  return [`--- ${label}`, `+++ ${label}`, `@@ line ${prefix + 1} @@`, ...left.slice(prefix, left.length - suffix).map((line) => `-${line}`), ...right.slice(prefix, right.length - suffix).map((line) => `+${line}`), ""].join("\n");
}

function read(path: string): string { return existsSync(path) ? readFileSync(path, "utf8") : ""; }
function atomicWrite(path: string, content: string): void { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.${Date.now()}.tmp`; writeFileSync(temporary, content, "utf8"); renameSync(temporary, path); }
function stateHash(path: string, content: string): string { return existsSync(path) ? hash(content) : MISSING_HASH; }
function hash(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function unique(values: readonly string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function cleanList(values: readonly string[]): string[] { return unique(values); }
function opaqueId(value: string): boolean { return /^[a-z0-9][a-z0-9_-]{5,79}$/iu.test(value); }
function maturityRank(value: LongTermMemoryMaturity): number { return ["user-confirmed", "evidence-backed", "retrospectively-supported"].indexOf(value); }
function capitalize(value: string): string { return `${value[0]!.toUpperCase()}${value.slice(1)}`; }
