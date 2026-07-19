import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { BoundedRecallEnvelope, RecallContext, RecallSource } from "./recall.js";

export const LONG_TERM_MEMORY_HEADER = "# Long-term Memory\n\nSchema-Version: 1\n";
export const LONG_TERM_MEMORY_ARCHIVE_HEADER = "# Long-term Memory Condensation Archive\n\nSchema-Version: 1\n";
export const COGNITIVE_EVOLUTION_HISTORY_HEADER = "# Cognitive Evolution History\n\nSchema-Version: 1\n";

export type LongTermMemoryMaturity = "user-confirmed" | "evidence-backed" | "retrospectively-supported";
export type LongTermMemoryRecallPolicy = "automatic" | "explicit-only";
export type LongTermMemoryStatus = "current" | "superseded";

export interface LongTermMemoryEntry {
  readonly id: string;
  readonly version: number;
  readonly status: LongTermMemoryStatus;
  readonly title: string;
  readonly date: string;
  readonly tags: string[];
  readonly applicability: string[];
  readonly maturity: LongTermMemoryMaturity;
  readonly recallPolicy: LongTermMemoryRecallPolicy;
  readonly conflictState: string;
  readonly limitations: string;
  readonly content: string;
  readonly sourceReferenceIds: string[];
  readonly provenanceStatus: "traceable" | "user-authored-no-evidence";
}

export interface LongTermMemoryWarning {
  readonly code: "MISSING_TITLE" | "MALFORMED_ENTRY" | "INVALID_FIELD" | "DUPLICATE_ID" | "PROJECT_SPECIFIC_CONTENT";
  readonly message: string;
  readonly line?: number;
}

export interface LongTermMemoryFileSummary {
  readonly kind: "active" | "condensation_archive" | "cognitive_evolution_history";
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly updatedAt: string;
  readonly sourceHash: string;
}

export interface LongTermMemoryDocument {
  readonly schemaVersion: 1;
  readonly rootPath: string;
  readonly markdownPath: string;
  readonly content: string;
  readonly sourceHash: string;
  readonly updatedAt: string;
  readonly entries: LongTermMemoryEntry[];
  readonly warnings: LongTermMemoryWarning[];
  readonly files: LongTermMemoryFileSummary[];
}

interface LongTermMemoryIndexEntry extends LongTermMemoryEntry {
  readonly normalizedTitle: string;
  readonly normalizedApplicability: string;
  readonly normalizedSearchText: string;
  readonly searchTerms: string[];
}

interface LongTermMemoryIndex {
  readonly schemaVersion: 1;
  readonly sourceHash: string;
  readonly entries: LongTermMemoryIndexEntry[];
  readonly warnings: LongTermMemoryWarning[];
}

export class LongTermMemoryStore {
  readonly #root: string;
  readonly #indexRoot: string;

  constructor(root: string, indexRoot: string = join(dirname(root), "long-term-index")) {
    this.#root = root;
    this.#indexRoot = indexRoot;
  }

  get rootPath(): string { return this.#root; }
  get markdownPath(): string { return join(this.#root, "long-term-memory.md"); }
  get archivePath(): string { return join(this.#root, "long-term-memory-condensation-archive.md"); }
  get historyPath(): string { return join(this.#root, "cognitive-evolution-history.md"); }
  get indexPath(): string { return join(this.#indexRoot, "index.json"); }

  load(create: boolean): LongTermMemoryDocument | undefined {
    if (!existsSync(this.markdownPath)) {
      if (!create) return undefined;
      this.#initializeFiles();
    }
    if (create) this.#initializeFiles();
    return this.rebuild();
  }

  refreshIfExists(): LongTermMemoryDocument | undefined {
    return existsSync(this.markdownPath) ? this.rebuild() : undefined;
  }

  save(content: string, expectedSourceHash: string): LongTermMemoryDocument {
    if (!existsSync(this.markdownPath)) throw new Error("Long-term Memory is not initialized.");
    if (hash(readFileSync(this.markdownPath, "utf8")) !== expectedSourceHash) throw new Error("STALE_LONG_TERM_MEMORY_WRITE");
    atomicWrite(this.markdownPath, content);
    return this.rebuild();
  }

  rebuild(): LongTermMemoryDocument {
    const content = readFileSync(this.markdownPath, "utf8");
    mkdirSync(this.#indexRoot, { recursive: true });
    atomicWrite(this.indexPath, createLongTermMemoryIndexContent(content));
    return this.readCurrent();
  }

  readCurrent(): LongTermMemoryDocument {
    if (!existsSync(this.markdownPath)) throw new Error("Long-term Memory is not initialized.");
    const content = readFileSync(this.markdownPath, "utf8");
    const parsed = parseLongTermMemory(content);
    const sourceHash = hash(content);
    const updatedAt = statSync(this.markdownPath).mtime.toISOString();
    return {
      schemaVersion: 1,
      rootPath: this.#root,
      markdownPath: this.markdownPath,
      content,
      sourceHash,
      updatedAt,
      entries: parsed.entries,
      warnings: parsed.warnings,
      files: [
        summarizeFile("active", this.markdownPath),
        summarizeFile("condensation_archive", this.archivePath),
        summarizeFile("cognitive_evolution_history", this.historyPath)
      ]
    };
  }

  loadIndex(): LongTermMemoryIndex | undefined {
    if (!existsSync(this.markdownPath)) return undefined;
    const sourceHash = hash(readFileSync(this.markdownPath, "utf8"));
    if (existsSync(this.indexPath)) {
      try {
        const index = JSON.parse(readFileSync(this.indexPath, "utf8")) as LongTermMemoryIndex;
        if (index.schemaVersion === 1 && index.sourceHash === sourceHash) return index;
      } catch { /* Rebuild the disposable index below. */ }
    }
    this.rebuild();
    return JSON.parse(readFileSync(this.indexPath, "utf8")) as LongTermMemoryIndex;
  }

  #initializeFiles(): void {
    mkdirSync(this.#root, { recursive: true });
    createIfMissing(this.markdownPath, LONG_TERM_MEMORY_HEADER);
    createIfMissing(this.archivePath, LONG_TERM_MEMORY_ARCHIVE_HEADER);
    createIfMissing(this.historyPath, COGNITIVE_EVOLUTION_HISTORY_HEADER);
  }
}

export function createLongTermMemoryIndexContent(content: string): string {
  const parsed = parseLongTermMemory(content);
  const index: LongTermMemoryIndex = {
    schemaVersion: 1,
    sourceHash: hash(content),
    entries: parsed.entries.filter((entry) => entry.status === "current").map(indexEntry),
    warnings: parsed.warnings
  };
  return `${JSON.stringify(index, null, 2)}\n`;
}

export function parseLongTermMemory(content: string): { entries: LongTermMemoryEntry[]; warnings: LongTermMemoryWarning[] } {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const warnings: LongTermMemoryWarning[] = [];
  if (lines.find((line) => line.trim())?.trim() !== "# Long-term Memory") {
    warnings.push({ code: "MISSING_TITLE", message: "Expected '# Long-term Memory' as the document title." });
  }
  const headings = lines.flatMap((line, index) => {
    if (!line.startsWith("## ")) return [];
    const dated = /^##\s+(\d{4}-\d{2}-\d{2})\s+-\s+(.+?)\s*$/u.exec(line);
    const plain = /^##\s+(.+?)\s*$/u.exec(line);
    return [{ index, date: dated?.[1], title: dated?.[2] ?? plain?.[1] }];
  });
  const entries: LongTermMemoryEntry[] = [];
  const ids = new Set<string>();
  headings.forEach((heading, headingIndex) => {
    const end = headings[headingIndex + 1]?.index ?? lines.length;
    const entryLines = lines.slice(heading.index + 1, end);
    const blank = entryLines.findIndex((line) => line.trim() === "");
    const metadataLines = entryLines.slice(0, blank < 0 ? entryLines.length : blank);
    const field = (name: string) => metadataLines.find((line) => line.toLocaleLowerCase().startsWith(`${name.toLocaleLowerCase()}:`))?.slice(name.length + 1).trim() ?? "";
    const title = heading.title?.trim() ?? "";
    const date = heading.date ?? field("Date");
    const body = entryLines.slice(blank < 0 ? entryLines.length : blank + 1).join("\n").trim();
    const line = heading.index + 1;
    if (!title || !/^\d{4}-\d{2}-\d{2}$/u.test(date) || blank <= 0 || !body) {
      warnings.push({ code: "MALFORMED_ENTRY", message: "Memory entry requires a title, YYYY-MM-DD date, metadata block, blank line, and content.", line });
      return;
    }
    if (field("Scope") && field("Scope") !== "global") {
      warnings.push({ code: "INVALID_FIELD", message: `Memory entry '${title}' must declare Scope: global.`, line });
      return;
    }
    const id = field("ID") || `ltm-${hash(`${date}\n${title}`).slice(0, 20)}`;
    if (!/^[a-z0-9][a-z0-9_-]{5,79}$/iu.test(id)) {
      warnings.push({ code: "INVALID_FIELD", message: `Memory entry '${title}' has an invalid opaque ID.`, line });
      return;
    }
    if (ids.has(id)) {
      warnings.push({ code: "DUPLICATE_ID", message: `Memory entry ID '${id}' is duplicated; later copies are excluded.`, line });
      return;
    }
    const version = Number(field("Version") || "1");
    const status = (field("Status") || "current") as LongTermMemoryStatus;
    const maturity = normalizeMaturity(field("Maturity") || "user-confirmed");
    const recallPolicy = (field("Recall") || "automatic") as LongTermMemoryRecallPolicy;
    const conflictState = field("Conflict") || "none";
    if (!Number.isInteger(version) || version < 1 || !["current", "superseded"].includes(status) || maturity === undefined || !["automatic", "explicit-only"].includes(recallPolicy) || !isConflictState(conflictState)) {
      warnings.push({ code: "INVALID_FIELD", message: `Memory entry '${title}' contains an invalid Version, Status, Maturity, Recall, or Conflict value.`, line });
      return;
    }
    const sourceReferenceIds = commaList(field("Source References"));
    if (sourceReferenceIds.some((reference) => !/^[a-z0-9][a-z0-9_-]{5,79}$/iu.test(reference))) {
      warnings.push({ code: "INVALID_FIELD", message: `Memory entry '${title}' contains a non-opaque source reference.`, line });
      return;
    }
    if (looksProjectSpecific(`${title}\n${field("Applies To")}\n${field("Limitations")}\n${body}`)) {
      warnings.push({ code: "PROJECT_SPECIFIC_CONTENT", message: `Memory entry '${title}' appears to contain Project or transaction-level detail and is excluded from ordinary recall. Move that detail to Project Memory or de-identify it.`, line });
      return;
    }
    ids.add(id);
    entries.push({
      id,
      version,
      status,
      title,
      date,
      tags: commaList(field("Tags")),
      applicability: commaList(field("Applies To")),
      maturity,
      recallPolicy,
      conflictState,
      limitations: field("Limitations"),
      content: body,
      sourceReferenceIds,
      provenanceStatus: sourceReferenceIds.length > 0 ? "traceable" : "user-authored-no-evidence"
    });
  });
  return { entries, warnings };
}

export interface LongTermMemoryRecallQuery {
  readonly mode: "automatic" | "explicit";
  readonly disclosureLevel: "cards" | "full";
  readonly entryIds?: readonly string[];
  readonly query?: string;
}

export interface LongTermMemoryRecallItem {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly applicability: string[];
  readonly maturity: LongTermMemoryMaturity;
  readonly recallPolicy: LongTermMemoryRecallPolicy;
  readonly conflictState: string;
  readonly limitations: string;
  readonly tags: string[];
  readonly content: string;
  readonly provenanceStatus: "traceable" | "user-authored-no-evidence";
  readonly memoryStatus: "user-confirmed-judgment-not-source-evidence";
  readonly matchReason: string;
}

export class LongTermMemoryRecallSource implements RecallSource<LongTermMemoryRecallQuery, LongTermMemoryRecallItem> {
  readonly sourceClass = "memory" as const;
  readonly #store: LongTermMemoryStore;
  readonly #preferredEntryIds: ReadonlySet<string>;
  constructor(store: LongTermMemoryStore, options: { preferredEntryIds?: ReadonlySet<string> } = {}) { this.#store = store; this.#preferredEntryIds = options.preferredEntryIds ?? new Set(); }

  async recall(query: LongTermMemoryRecallQuery, context: RecallContext): Promise<BoundedRecallEnvelope<LongTermMemoryRecallItem>> {
    const index = this.#store.loadIndex();
    const ids = new Set(query.entryIds ?? []);
    const terms = searchTerms(query.query ?? "");
    const indexedEntries = index?.entries ?? [];
    const eligible = indexedEntries.filter((entry) => {
      if (query.mode === "explicit") return true;
      if (entry.recallPolicy !== "automatic") return false;
      return !entry.conflictState.startsWith("unresolved:") || indexedEntries.filter((peer) => peer.conflictState === entry.conflictState).every((peer) => peer.recallPolicy === "automatic");
    });
    const scored = eligible.flatMap((entry) => {
      if (ids.size > 0) return ids.has(entry.id) ? [{ entry, score: 10_000, reason: "selected card id" }] : [];
      const baseScore = relevanceScore(entry, terms);
      const score = baseScore > 0 ? baseScore + (this.#preferredEntryIds.has(entry.id) ? 4 : 0) : 0;
      return score > 0 ? [{ entry, score, reason: matchedReason(entry, terms) }] : [];
    }).sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id));
    const selected = includeConflictPeers(scored, eligible);
    const items: LongTermMemoryRecallItem[] = [];
    let chars = 0;
    for (const candidate of selected) {
      const content = query.disclosureLevel === "cards" ? candidate.entry.content.slice(0, 220) : candidate.entry.content;
      const item = recallItem(candidate.entry, content, candidate.reason);
      const itemChars = JSON.stringify(item).length;
      const conflictPeers = candidate.entry.conflictState.startsWith("unresolved:")
        ? selected.filter((peer) => peer.entry.conflictState === candidate.entry.conflictState && !items.some((item) => item.id === peer.entry.id))
        : [candidate];
      const peerChars = conflictPeers.reduce((total, peer) => total + JSON.stringify(recallItem(peer.entry, query.disclosureLevel === "cards" ? peer.entry.content.slice(0, 220) : peer.entry.content, peer.reason)).length, 0);
      if (items.length + conflictPeers.length > context.maxItems || chars + Math.max(itemChars, peerChars) > context.maxChars) continue;
      for (const peer of conflictPeers) {
        if (items.some((item) => item.id === peer.entry.id)) continue;
        const peerContent = query.disclosureLevel === "cards" ? peer.entry.content.slice(0, 220) : peer.entry.content;
        const peerItem = recallItem(peer.entry, peerContent, peer.reason);
        chars += JSON.stringify(peerItem).length;
        items.push(peerItem);
      }
    }
    const omittedItems = selected.length - items.length;
    const warnings = [
      ...recallWarnings(index?.warnings ?? []),
      ...(terms.length === 0 && ids.size === 0 ? ["Provide a task-grounded query or selected card ids; relevance filtering cannot be bypassed."] : []),
      ...(omittedItems > 0 ? [`${omittedItems} relevant Long-term Memory item(s) omitted by bounds; unresolved conflicts are never split.`] : [])
    ];
    return {
      schemaVersion: 1,
      sourceClass: "memory",
      disclosureLevel: query.disclosureLevel,
      items,
      complete: omittedItems === 0,
      omittedItems,
      warnings,
      contextReference: {
        schemaVersion: 1,
        sourceClass: "memory",
        sourceId: "long-term-memory",
        label: "Long-term Memory (user-confirmed judgment; not source evidence)",
        sourceRange: items.map((item) => item.id).join(",") || "no-matches",
        ...(index ? { contentVersion: index.sourceHash } : {}),
        originatingTool: "memory_recall",
        originatingTurnId: context.turnId,
        retrievedAt: context.retrievedAt,
        status: index ? "active" : "source_unavailable"
      }
    };
  }
}

export function detectExplicitMemoryRecallIntent(text: string): boolean {
  return /(参考|结合|借鉴|调用|使用|回忆|召回).{0,16}(长期记忆|项目记忆|记忆|我的(判断|观点|偏好)|我(以前|过往|此前)的(判断|观点|偏好))|\b(use|recall|consult|draw on|based on)\b.{0,30}\b(my|project|long[- ]term|prior|previous)\b.{0,12}\b(memory|judgment|view|preference)s?\b/iu.test(text);
}

export function detectJudgmentHeavyIntent(text: string): boolean {
  return /(投资判断|项目判断|项目审阅|项目分析|风险评估|投资逻辑|投资观点|尽调问题|行业判断|复盘|反思|IC\s*memo|投资备忘录|是否值得投|investment (?:view|judgment|thesis|memo)|risk assessment|diligence questions?|meeting brief|thesis update|assess (?:this|the) (?:project|company|opportunity)|analy[sz]e (?:this|the) (?:project|company|opportunity)|review (?:this|the) (?:project|company|opportunity)|compare.{0,20}(?:prior|previous) (?:view|conclusion))/iu.test(text);
}

function indexEntry(entry: LongTermMemoryEntry): LongTermMemoryIndexEntry {
  const normalizedTitle = normalize(entry.title);
  const normalizedApplicability = normalize(entry.applicability.join(" "));
  const normalizedSearchText = normalize([entry.title, entry.tags.join(" "), entry.applicability.join(" "), entry.limitations, entry.content].join("\n"));
  return { ...entry, normalizedTitle, normalizedApplicability, normalizedSearchText, searchTerms: searchTerms(normalizedSearchText) };
}

function relevanceScore(entry: LongTermMemoryIndexEntry, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  return terms.reduce((score, term) => score
    + (entry.normalizedTitle.includes(term) ? 8 : 0)
    + (entry.tags.some((tag) => normalize(tag).includes(term)) ? 6 : 0)
    + (entry.normalizedApplicability.includes(term) ? 6 : 0)
    + (entry.normalizedSearchText.includes(term) ? 2 : 0), 0);
}

function matchedReason(entry: LongTermMemoryIndexEntry, terms: readonly string[]): string {
  const structured = terms.filter((term) => entry.normalizedTitle.includes(term) || entry.normalizedApplicability.includes(term) || entry.tags.some((tag) => normalize(tag).includes(term)));
  return structured.length > 0 ? `matched title, tag, or applicability: ${structured.slice(0, 4).join(", ")}` : `matched content: ${terms.filter((term) => entry.normalizedSearchText.includes(term)).slice(0, 4).join(", ")}`;
}

function includeConflictPeers(
  scored: Array<{ entry: LongTermMemoryIndexEntry; score: number; reason: string }>,
  eligible: readonly LongTermMemoryIndexEntry[]
): Array<{ entry: LongTermMemoryIndexEntry; score: number; reason: string }> {
  const byId = new Map(scored.map((item) => [item.entry.id, item]));
  for (const item of scored) {
    if (!item.entry.conflictState.startsWith("unresolved:")) continue;
    for (const peer of eligible.filter((entry) => entry.conflictState === item.entry.conflictState)) {
      if (!byId.has(peer.id)) byId.set(peer.id, { entry: peer, score: item.score, reason: "paired unresolved Memory conflict" });
    }
  }
  return [...byId.values()].sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id));
}

function recallItem(entry: LongTermMemoryIndexEntry, content: string, matchReason: string): LongTermMemoryRecallItem {
  return {
    id: entry.id,
    version: entry.version,
    title: entry.title,
    applicability: entry.applicability,
    maturity: entry.maturity,
    recallPolicy: entry.recallPolicy,
    conflictState: entry.conflictState,
    limitations: entry.limitations,
    tags: entry.tags,
    content,
    provenanceStatus: entry.provenanceStatus,
    memoryStatus: "user-confirmed-judgment-not-source-evidence",
    matchReason
  };
}

function recallWarnings(warnings: readonly LongTermMemoryWarning[]): string[] {
  const messages = new Set<string>();
  for (const warning of warnings) {
    messages.add(warning.code === "PROJECT_SPECIFIC_CONTENT"
      ? "Some Long-term Memory content was excluded because it may contain Project or transaction-level detail."
      : "Some Long-term Memory content was excluded because it could not be parsed safely.");
  }
  return [...messages];
}

function searchTerms(value: string): string[] {
  const normalized = normalize(value);
  const latin = normalized.match(/[a-z0-9][a-z0-9_-]+/gu) ?? [];
  const cjkRuns = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  const cjk = cjkRuns.flatMap((run) => run.length < 2 ? [run] : Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2)));
  const stop = new Set(["the", "and", "with", "from", "this", "that", "memory", "long-term", "long_term", "我的", "记忆", "长期", "结合", "参考", "借鉴", "使用", "分析"]);
  return [...new Set([...latin, ...cjk].filter((term) => !stop.has(term)))];
}

function normalize(value: string): string { return value.normalize("NFKC").toLocaleLowerCase(); }
function commaList(value: string): string[] { return value.split(/[,，]/u).map((item) => item.trim()).filter(Boolean); }
function normalizeMaturity(value: string): LongTermMemoryMaturity | undefined {
  const normalized = value.trim().toLocaleLowerCase().replace(/_/gu, "-");
  return ["user-confirmed", "evidence-backed", "retrospectively-supported"].includes(normalized) ? normalized as LongTermMemoryMaturity : undefined;
}
function isConflictState(value: string): boolean { return value === "none" || /^(?:unresolved|resolved):[a-z0-9][a-z0-9_-]{5,79}$/iu.test(value); }
function looksProjectSpecific(value: string): boolean {
  return /(?:^|\n)\s*(?:company|project|deal|transaction|公司|项目|交易)\s*[:：]|(?:[A-Z]:\\|\\\\|\/Users\/|\/home\/)|\b(?:[A-Z][A-Za-z0-9&.-]*\s+){0,3}[A-Z][A-Za-z0-9&.-]*\s+(?:Inc\.?|Corp\.?|Corporation|Ltd\.?|LLC|Limited)\b|[\p{Script=Han}A-Za-z0-9]{2,30}(?:股份有限公司|有限公司|集团)|(?:pre[- ]?money|post[- ]?money|term sheet|valuation|ARR|MRR|估值|投前|投后|交易条款|收入|营收)\s*[:：]?\s*(?:[$¥￥€£]|\d)/iu.test(value);
}
function summarizeFile(kind: LongTermMemoryFileSummary["kind"], path: string): LongTermMemoryFileSummary {
  const content = readFileSync(path, "utf8");
  const stats = statSync(path);
  return { kind, name: basename(path), path, size: stats.size, updatedAt: stats.mtime.toISOString(), sourceHash: hash(content) };
}
function createIfMissing(path: string, content: string): void {
  try { writeFileSync(path, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!existsSync(path)) throw error; }
}
function hash(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.partial`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}
