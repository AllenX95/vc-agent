import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BoundedRecallEnvelope, RecallContext, RecallSource } from "./recall.js";

export const PROJECT_MEMORY_HEADER = "# Project Memory\n";

export interface ProjectMemoryEntry {
  readonly id: string;
  readonly title: string;
  readonly date: string;
  readonly tags: string[];
  readonly source: string;
  readonly scope: "project";
  readonly body: string;
  readonly relatedThread?: string;
  readonly relatedOutput?: string;
  readonly maturity: "user_confirmed";
  readonly provenanceStatus: "traceable" | "user_authored_no_evidence";
}

export interface ProjectMemoryWarning {
  readonly code: "MISSING_TITLE" | "MALFORMED_ENTRY" | "INVALID_SCOPE";
  readonly message: string;
  readonly line?: number;
}

export interface ProjectMemoryDocument {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly markdownPath: "outputs/system/project-memory.md";
  readonly content: string;
  readonly sourceHash: string;
  readonly updatedAt: string;
  readonly entries: ProjectMemoryEntry[];
  readonly warnings: ProjectMemoryWarning[];
}

export interface ProjectMemoryDraft {
  readonly title: string;
  readonly tags: readonly string[];
  readonly body: string;
  readonly threadId?: string;
  readonly outputPath?: string;
}

export class ProjectMemoryStore {
  readonly #indexRoot: string;
  constructor(indexRoot: string) { this.#indexRoot = indexRoot; }

  markdownPath(projectPath: string): string { return join(projectPath, "outputs", "system", "project-memory.md"); }
  indexPath(projectId: string): string { return join(this.#indexRoot, `${projectId}.json`); }

  load(projectId: string, projectPath: string, create: boolean): ProjectMemoryDocument | undefined {
    const path = this.markdownPath(projectPath);
    if (!existsSync(path)) {
      if (!create) return undefined;
      mkdirSync(dirname(path), { recursive: true });
      try { writeFileSync(path, PROJECT_MEMORY_HEADER, { encoding: "utf8", flag: "wx" }); }
      catch (error) { if (!existsSync(path)) throw error; }
    }
    return this.rebuild(projectId, projectPath);
  }

  save(projectId: string, projectPath: string, content: string, expectedSourceHash: string): ProjectMemoryDocument {
    const path = this.markdownPath(projectPath);
    if (!existsSync(path)) throw new Error("Project Memory is not initialized.");
    if (hash(readFileSync(path, "utf8")) !== expectedSourceHash) throw new Error("STALE_PROJECT_MEMORY_WRITE");
    atomicWrite(path, content);
    return this.rebuild(projectId, projectPath);
  }

  append(projectId: string, projectPath: string, draft: ProjectMemoryDraft, expectedSourceHash: string): ProjectMemoryDocument {
    const current = this.load(projectId, projectPath, true)!;
    if (current.sourceHash !== expectedSourceHash) throw new Error("STALE_PROJECT_MEMORY_WRITE");
    const date = new Date().toISOString().slice(0, 10);
    const entry = `\n## ${date} - ${draft.title.trim()}\nTags: ${draft.tags.map((tag) => tag.trim()).filter(Boolean).join(", ")}\nSource: user-confirmed\nScope: project\n\n${draft.body.trim()}\n\nRelated:\n- Thread: ${draft.threadId ?? ""}\n- Output: ${draft.outputPath ?? ""}\n`;
    return this.save(projectId, projectPath, `${current.content.trimEnd()}\n${entry}`, expectedSourceHash);
  }

  rebuildIfExists(projectId: string, projectPath: string): ProjectMemoryDocument | undefined {
    if (existsSync(this.markdownPath(projectPath))) return this.rebuild(projectId, projectPath);
    rmSync(this.indexPath(projectId), { force: true });
    return undefined;
  }

  rebuild(projectId: string, projectPath: string): ProjectMemoryDocument {
    const path = this.markdownPath(projectPath);
    const content = readFileSync(path, "utf8");
    const parsed = parseProjectMemory(content);
    const document: ProjectMemoryDocument = {
      schemaVersion: 1, projectId, markdownPath: "outputs/system/project-memory.md", content,
      sourceHash: hash(content), updatedAt: statSync(path).mtime.toISOString(), entries: parsed.entries, warnings: parsed.warnings
    };
    mkdirSync(this.#indexRoot, { recursive: true });
    atomicWrite(this.indexPath(projectId), `${JSON.stringify({ schemaVersion: 1, projectId, sourceHash: document.sourceHash, updatedAt: document.updatedAt, entries: document.entries, warnings: document.warnings }, null, 2)}\n`);
    return document;
  }
}

export function parseProjectMemory(content: string): { entries: ProjectMemoryEntry[]; warnings: ProjectMemoryWarning[] } {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const warnings: ProjectMemoryWarning[] = [];
  if (lines.find((line) => line.trim())?.trim() !== "# Project Memory") warnings.push({ code: "MISSING_TITLE", message: "Expected '# Project Memory' as the document title." });
  const headings = lines.flatMap((line, index) => {
    const match = /^##\s+(\d{4}-\d{2}-\d{2})\s+-\s+(.+?)\s*$/u.exec(line);
    return line.startsWith("## ") ? [{ index, date: match?.[1], title: match?.[2] }] : [];
  });
  const entries: ProjectMemoryEntry[] = [];
  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.index ?? lines.length;
    if (heading.date === undefined || heading.title === undefined) {
      warnings.push({ code: "MALFORMED_ENTRY", message: "Memory entry heading must use '## YYYY-MM-DD - Title'.", line: heading.index + 1 });
      return;
    }
    const bodyLines = lines.slice(heading.index + 1, end);
    const field = (name: string) => bodyLines.find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? "";
    const scope = field("Scope");
    if (scope !== "project") {
      warnings.push({ code: "INVALID_SCOPE", message: `Memory entry '${heading.title}' must declare Scope: project.`, line: heading.index + 1 });
      return;
    }
    const relatedIndex = bodyLines.findIndex((line) => line.trim() === "Related:");
    const metadataEnd = bodyLines.findIndex((line) => line.trim() === "");
    const body = bodyLines.slice(metadataEnd < 0 ? 0 : metadataEnd + 1, relatedIndex < 0 ? bodyLines.length : relatedIndex).join("\n").trim();
    const relatedThread = field("- Thread");
    const relatedOutput = field("- Output");
    const source = field("Source") || "user-authored";
    entries.push({
      id: createHash("sha256").update(`${heading.date}\n${heading.title}\n${body}`).digest("hex").slice(0, 24),
      title: heading.title, date: heading.date, tags: field("Tags").split(",").map((tag) => tag.trim()).filter(Boolean), source, scope: "project", body,
      ...(relatedThread ? { relatedThread } : {}), ...(relatedOutput ? { relatedOutput } : {}),
      maturity: "user_confirmed", provenanceStatus: relatedThread || relatedOutput ? "traceable" : "user_authored_no_evidence"
    });
  });
  return { entries, warnings };
}

export interface ProjectMemoryRecallQuery { readonly disclosureLevel: "cards" | "full"; readonly entryIds?: readonly string[]; readonly query?: string; }
export interface ProjectMemoryRecallItem extends ProjectMemoryEntry { readonly matchReason: string; readonly sourceRefs: readonly string[]; }

export class ProjectMemoryRecallSource implements RecallSource<ProjectMemoryRecallQuery, ProjectMemoryRecallItem> {
  readonly sourceClass = "memory" as const;
  readonly #load: () => ProjectMemoryDocument | undefined;
  constructor(load: () => ProjectMemoryDocument | undefined) { this.#load = load; }
  async recall(query: ProjectMemoryRecallQuery, context: RecallContext): Promise<BoundedRecallEnvelope<ProjectMemoryRecallItem>> {
    const document = this.#load();
    const ids = new Set(query.entryIds ?? []);
    const terms = query.query?.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const candidates = document?.entries.filter((entry) => ids.size > 0 ? ids.has(entry.id) : terms.some((term) => `${entry.title} ${entry.tags.join(" ")} ${entry.body}`.toLocaleLowerCase().includes(term))) ?? [];
    const items: ProjectMemoryRecallItem[] = [];
    let chars = 0;
    for (const entry of candidates) {
      const content = query.disclosureLevel === "cards" ? entry.body.slice(0, 240) : entry.body;
      if (items.length >= context.maxItems || chars + content.length > context.maxChars) break;
      chars += content.length;
      items.push({ ...entry, body: content, matchReason: ids.has(entry.id) ? "explicit entry id" : `matched query: ${query.query}`, sourceRefs: [`project-memory:${entry.id}@${document!.sourceHash}`] });
    }
    const omittedItems = candidates.length - items.length;
    return { schemaVersion: 1, sourceClass: "memory", disclosureLevel: query.disclosureLevel, items, complete: omittedItems === 0, omittedItems,
      warnings: document === undefined ? ["Project Memory is unavailable."] : [...document.warnings.map((warning) => warning.message), ...(omittedItems ? [`${omittedItems} memory item(s) omitted by bounds.`] : [])],
      contextReference: { schemaVersion: 1, sourceClass: "memory", sourceId: "project-memory", label: "Project Memory (user-confirmed judgment)", sourceRange: items.map((item) => item.id).join(",") || query.query || "none", ...(document ? { contentVersion: document.sourceHash } : {}), originatingTool: "memory_recall", originatingTurnId: context.turnId, retrievedAt: context.retrievedAt, status: document ? "active" : "source_unavailable" }
    };
  }
}

export function memoryCandidateId(): string { return randomUUID(); }
export interface MemoryCandidate {
  readonly id: string;
  readonly scope: "project" | "unscoped";
  readonly projectId?: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly capturedAt: string;
  readonly sourceSnippet: string;
  readonly signal: "explicit_remember" | "strong_user_judgment";
  readonly status: "active" | "dismissed" | "promoted";
}

export class MemoryCandidateStore {
  readonly #path: string;
  constructor(path: string) { this.#path = path; }
  capture(candidate: Omit<MemoryCandidate, "id" | "capturedAt" | "status">): MemoryCandidate {
    const record: MemoryCandidate = { ...candidate, id: randomUUID(), capturedAt: new Date().toISOString(), status: "active" };
    this.#append({ operation: "capture", candidate: record });
    return record;
  }
  resolve(id: string, status: "dismissed" | "promoted"): MemoryCandidate | undefined {
    const current = this.list().find((candidate) => candidate.id === id);
    if (current === undefined || current.status !== "active") return undefined;
    const resolved = { ...current, status };
    this.#append({ operation: "resolve", candidate: resolved });
    return resolved;
  }
  list(): MemoryCandidate[] {
    if (!existsSync(this.#path)) return [];
    const latest = new Map<string, MemoryCandidate>();
    for (const line of readFileSync(this.#path, "utf8").split("\n").filter(Boolean)) {
      try { const event = JSON.parse(line) as { candidate: MemoryCandidate }; latest.set(event.candidate.id, event.candidate); } catch { /* Preserve later valid records. */ }
    }
    return [...latest.values()];
  }
  #append(event: { operation: "capture" | "resolve"; candidate: MemoryCandidate }): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    appendFileSync(this.#path, `${JSON.stringify({ schemaVersion: 1, ...event, occurredAt: new Date().toISOString() })}\n`, "utf8");
  }
}

export function detectMemoryCandidateSignal(text: string): MemoryCandidate["signal"] | undefined {
  if (/(记住|记下来|remember (this|that)|keep this in memory)/iu.test(text)) return "explicit_remember";
  if (/(我(认为|判断|确定|决定|不同意|更看重)|我的(判断|观点|偏好)|核心(风险|判断|结论)是|the key (risk|judgment|conclusion) is|I (believe|think|decide|disagree))/iu.test(text)) return "strong_user_judgment";
  return undefined;
}
function hash(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function atomicWrite(path: string, content: string): void { const temporary = `${path}.${process.pid}.${Date.now()}.partial`; writeFileSync(temporary, content, "utf8"); renameSync(temporary, path); }
