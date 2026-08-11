import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  coverageLedgerSchema,
  extractionChunkSchema,
  eligibleLearningSourceSchema,
  learningEpochSchema,
  reviewBundleSchema,
  type CoverageLedger,
  type EligibleLearningSource,
  type ExtractionChunk,
  type LearningEpoch,
  type ReviewBundle
} from "@vc-agent/contracts";
import { z } from "zod";

const committedCutoffSchema = z.object({
  schemaVersion: z.literal(1),
  // Keep the identifier path-safe as it is also used to address the run and
  // its ledger.  A malformed value must never influence a later cutoff read.
  batchId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u),
  cutoff: z.string().datetime({ offset: true }).refine((value) => Number.isFinite(new Date(value).valueOf()), "cutoff must be a finite ISO datetime"),
  updatedAt: z.string().datetime({ offset: true }).refine((value) => Number.isFinite(new Date(value).valueOf()), "updatedAt must be a finite ISO datetime")
}).strict();

export interface CognitionReviewStoreOptions {
  readonly now?: () => Date;
  /** Set to false to keep inspection-only tests from creating directories. */
  readonly createRoot?: boolean;
}

/**
 * Durable v2 cognition metadata.  The store owns only references and bounded
 * workflow records; raw exchange bodies remain in Thread Trajectory.
 */
export class CognitionReviewStore {
  readonly #root: string;
  readonly #epochPath: string;
  readonly #sourceIndexPath: string;
  readonly #reviewsPath: string;
  readonly #batchesPath: string;
  readonly #workPath: string;
  readonly #now: () => Date;
  readonly #createRoot: boolean;

  constructor(appDataRoot: string, options: CognitionReviewStoreOptions = {}) {
    this.#root = basename(appDataRoot).toLowerCase() === "cognition-v2" ? appDataRoot : join(appDataRoot, "cognition-v2");
    this.#epochPath = join(this.#root, "epoch.json");
    this.#sourceIndexPath = join(this.#root, "source-index.jsonl");
    this.#reviewsPath = join(this.#root, "reviews");
    this.#batchesPath = join(this.#root, "batches");
    this.#workPath = join(this.#root, "work");
    this.#now = options.now ?? (() => new Date());
    this.#createRoot = options.createRoot !== false;
  }

  get rootPath(): string { return this.#root; }
  get epochPath(): string { return this.#epochPath; }
  get sourceIndexPath(): string { return this.#sourceIndexPath; }
  /** Host-internal paths used by the journaled Cognition Review commit. */
  get reviewsPath(): string { return this.#reviewsPath; }
  get batchesPath(): string { return this.#batchesPath; }
  get workPath(): string { return this.#workPath; }
  get committedCutoffPath(): string { return join(this.#root, "committed-cutoff.json"); }

  loadCommittedCutoff(): { readonly schemaVersion: 1; readonly batchId: string; readonly cutoff: string; readonly updatedAt: string } | undefined {
    if (!existsSync(this.committedCutoffPath)) return undefined;
    const value = JSON.parse(readFileSync(this.committedCutoffPath, "utf8"));
    const parsed = committedCutoffSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid Cognition Review committed cutoff.");
    return parsed.data;
  }

  reviewPath(reviewId: string): string { return join(this.#reviewsPath, `${safeFilePart(reviewId)}.json`); }
  coverageLedgerPath(batchId: string): string { return join(this.#batchesPath, `${safeFilePart(batchId)}.json`); }

  loadEpoch(): LearningEpoch | undefined {
    if (!existsSync(this.#epochPath)) return undefined;
    return learningEpochSchema.parse(JSON.parse(readFileSync(this.#epochPath, "utf8")));
  }

  writeEpoch(epoch: LearningEpoch): LearningEpoch {
    const parsed = learningEpochSchema.parse(epoch);
    this.#atomicWrite(this.#epochPath, parsed);
    return parsed;
  }

  readSourceIndex(): EligibleLearningSource[] {
    if (!existsSync(this.#sourceIndexPath)) return [];
    const latest = new Map<string, EligibleLearningSource>();
    for (const line of readFileSync(this.#sourceIndexPath, "utf8").split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      const source = eligibleLearningSourceSchema.parse(JSON.parse(line));
      latest.set(source.sourceReference, source);
    }
    return [...latest.values()].sort((left, right) => left.completedAt.localeCompare(right.completedAt) || left.sourceReference.localeCompare(right.sourceReference));
  }

  upsertSourceIndex(sources: readonly EligibleLearningSource[]): EligibleLearningSource[] {
    const latest = new Map(this.readSourceIndex().map((source) => [source.sourceReference, source]));
    for (const source of sources) {
      const parsed = eligibleLearningSourceSchema.parse(source);
      latest.set(parsed.sourceReference, parsed);
    }
    const sorted = [...latest.values()].sort((left, right) => left.completedAt.localeCompare(right.completedAt) || left.sourceReference.localeCompare(right.sourceReference));
    this.#writeSourceIndex(sorted);
    return sorted;
  }

  /** Preserve content-free provenance when a Thread or its history is deleted. */
  markThreadSourcesDeleted(threadId: string): string[] {
    if (!threadId.trim()) throw new Error("Thread id is required for cognition redaction.");
    const current = this.readSourceIndex();
    const removed = current.filter((source) => source.threadId === threadId).map((source) => source.sourceReference);
    if (removed.length === 0) return [];
    const updated = current.map((source) => source.threadId === threadId ? { ...source, availability: "deleted" as const } : source);
    this.#writeSourceIndex(updated);
    return removed.sort();
  }

  /**
   * Remove uncommitted source pointers for a deleted Thread.  Committed
   * Memory is outside this store and is intentionally untouched.
   */
  redactThreadSources(threadId: string): string[] {
    if (!threadId.trim()) throw new Error("Thread id is required for cognition redaction.");
    const current = this.readSourceIndex();
    const removed = current.filter((source) => source.threadId === threadId).map((source) => source.sourceReference);
    if (removed.length > 0) this.#writeSourceIndex(current.filter((source) => source.threadId !== threadId));
    return removed.sort();
  }

  saveReviewBundle(bundle: ReviewBundle): ReviewBundle {
    const parsed = reviewBundleSchema.parse(bundle);
    this.#atomicWrite(join(this.#reviewsPath, `${safeFilePart(parsed.id)}.json`), parsed);
    return parsed;
  }

  loadReviewBundle(reviewId: string): ReviewBundle | undefined {
    const path = join(this.#reviewsPath, `${safeFilePart(reviewId)}.json`);
    if (!existsSync(path)) return undefined;
    return reviewBundleSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  listReviewBundles(): ReviewBundle[] {
    return this.#listJson(this.#reviewsPath).flatMap((path) => {
      try { return [reviewBundleSchema.parse(JSON.parse(readFileSync(path, "utf8")))]; }
      catch { return []; }
    }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  saveCoverageLedger(ledger: CoverageLedger): CoverageLedger {
    const parsed = coverageLedgerSchema.parse(ledger);
    this.#atomicWrite(join(this.#batchesPath, `${safeFilePart(parsed.batchId)}.json`), parsed);
    return parsed;
  }

  loadCoverageLedger(batchId: string): CoverageLedger | undefined {
    const path = join(this.#batchesPath, `${safeFilePart(batchId)}.json`);
    if (!existsSync(path)) return undefined;
    return coverageLedgerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  listCoverageLedgers(): CoverageLedger[] {
    return this.#listJson(this.#batchesPath).flatMap((path) => {
      try { return [coverageLedgerSchema.parse(JSON.parse(readFileSync(path, "utf8")))]; }
      catch { return []; }
    }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.batchId.localeCompare(right.batchId));
  }

  saveExtractionChunk(chunk: ExtractionChunk): ExtractionChunk {
    const parsed = extractionChunkSchema.parse(chunk);
    this.#atomicWrite(join(this.#workPath, `${safeFilePart(parsed.id)}.json`), parsed);
    return parsed;
  }

  loadExtractionChunk(chunkId: string): ExtractionChunk | undefined {
    const path = join(this.#workPath, `${safeFilePart(chunkId)}.json`);
    if (!existsSync(path)) return undefined;
    return extractionChunkSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  /** Remove all v2 files. Callers must perform explicit cutover authorization. */
  clear(): void {
    if (!this.#createRoot) throw new Error("Cognition Review store is read-only.");
    rmSync(this.#root, { recursive: true, force: true });
  }

  #listJson(directory: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => join(directory, entry.name));
  }

  #writeSourceIndex(sources: readonly EligibleLearningSource[]): void {
    const sorted = [...sources].sort((left, right) => left.completedAt.localeCompare(right.completedAt) || left.sourceReference.localeCompare(right.sourceReference));
    this.#atomicWriteText(this.#sourceIndexPath, sorted.length === 0 ? "" : `${sorted.map((source) => JSON.stringify(source)).join("\n")}\n`);
  }

  #atomicWrite(path: string, value: unknown): void {
    this.#atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  #atomicWriteText(path: string, content: string): void {
    if (!this.#createRoot) throw new Error("Cognition Review store is read-only.");
    mkdirSync(join(path, ".."), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, "utf8");
    try { renameSync(temporary, path); }
    catch (error) { rmSync(temporary, { force: true }); throw error; }
  }
}

function safeFilePart(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/u.test(value)) throw new Error("Cognition Review record id contains unsupported path characters.");
  return value;
}
