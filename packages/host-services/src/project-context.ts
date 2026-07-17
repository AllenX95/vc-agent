import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BoundedRecallEnvelope, RecallContext, RecallSource } from "./recall.js";

export const PROJECT_CONTEXT_TEMPLATE = `# Project Context

## Project Snapshot
- Project:
- Company:
- Sector:
- Stage:
- Current Focus:

## Current Working State
- Active Thread:
- Recent Outputs:
- Current Questions:
- Next Actions:

## Materials Summary
- Key Materials:
- Parsed / Reviewed:
- Missing / Needs OCR:

## Operating Rules
- Output Location:
- Source File Modification:
- Web Access:
- MCP / External Tools:

## Context For New Threads
- Always Include:
- Be Careful About:
- Do Not Assume:

## Update Log
- YYYY-MM-DD:
`;

const FIXED_SECTIONS = ["Project Snapshot", "Current Working State", "Materials Summary", "Operating Rules", "Context For New Threads", "Update Log"] as const;

export interface ProjectContextSection {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ProjectContextWarning {
  readonly code: "MISSING_TITLE" | "MISSING_SECTION" | "UNKNOWN_SECTION" | "DUPLICATE_SECTION";
  readonly message: string;
  readonly line?: number;
}

export interface ProjectContextDocument {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly markdownPath: "outputs/system/project-context.md";
  readonly mirrorPath: "outputs/system/project-context.json";
  readonly content: string;
  readonly sourceHash: string;
  readonly updatedAt: string;
  readonly sections: ProjectContextSection[];
  readonly warnings: ProjectContextWarning[];
}

export interface ProjectContextRecallQuery {
  readonly sectionIds?: readonly string[];
  readonly query?: string;
}

export interface ProjectContextRecallItem {
  readonly sectionId: string;
  readonly title: string;
  readonly content: string;
  readonly updatedAt: string;
  readonly sourceRefs: readonly string[];
}

export interface ProjectContextRecallAccess {
  load(): ProjectContextDocument | undefined;
}

export class ProjectContextRecallSource implements RecallSource<ProjectContextRecallQuery, ProjectContextRecallItem> {
  readonly sourceClass = "project_state" as const;
  readonly #access: ProjectContextRecallAccess;

  constructor(access: ProjectContextRecallAccess) { this.#access = access; }

  async recall(query: ProjectContextRecallQuery, context: RecallContext): Promise<BoundedRecallEnvelope<ProjectContextRecallItem>> {
    const document = this.#access.load();
    const requestedIds = new Set(query.sectionIds ?? []);
    const terms = query.query?.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const candidates = document?.sections.filter((section) => requestedIds.size > 0
      ? requestedIds.has(section.id)
      : terms.length > 0 && terms.some((term) => `${section.title}\n${section.content}`.toLocaleLowerCase().includes(term))) ?? [];
    const selected: ProjectContextRecallItem[] = [];
    let usedChars = 0;
    for (const section of candidates) {
      const itemChars = section.title.length + section.content.length;
      if (selected.length >= context.maxItems || usedChars + itemChars > context.maxChars) break;
      usedChars += itemChars;
      selected.push({
        sectionId: section.id,
        title: section.title,
        content: section.content,
        updatedAt: document!.updatedAt,
        sourceRefs: [`project-context:${section.id}@${document!.sourceHash}`]
      });
    }
    const omittedItems = Math.max(0, candidates.length - selected.length);
    const warnings = document === undefined
      ? ["Project Context is unavailable; open the Context panel before recalling it."]
      : [
          ...document.warnings.map((warning) => warning.message),
          ...(requestedIds.size === 0 && terms.length === 0 ? ["Specify sectionIds or a query to retrieve relevant Project Context sections."] : []),
          ...(omittedItems > 0 ? [`${omittedItems} section(s) omitted by the bounded retrieval envelope.`] : [])
        ];
    return {
      schemaVersion: 1,
      sourceClass: "project_state",
      disclosureLevel: "sections",
      items: selected,
      complete: omittedItems === 0,
      omittedItems,
      warnings,
      contextReference: {
        schemaVersion: 1,
        sourceClass: "project_state",
        sourceId: "project-context",
        label: "Project Context",
        sourceRange: selected.map((item) => item.sectionId).join(",") || query.sectionIds?.join(",") || query.query || "none",
        ...(document === undefined ? {} : { contentVersion: document.sourceHash }),
        originatingTool: "project_state_recall",
        originatingTurnId: context.turnId,
        retrievedAt: context.retrievedAt,
        status: document === undefined ? "source_unavailable" : "active"
      }
    };
  }
}

export class ProjectContextStore {
  paths(projectPath: string) {
    return {
      markdown: join(projectPath, "outputs", "system", "project-context.md"),
      mirror: join(projectPath, "outputs", "system", "project-context.json")
    };
  }

  load(projectId: string, projectPath: string, create: boolean): ProjectContextDocument | undefined {
    const paths = this.paths(projectPath);
    if (!existsSync(paths.markdown)) {
      if (!create) return undefined;
      mkdirSync(dirname(paths.markdown), { recursive: true });
      try { writeFileSync(paths.markdown, PROJECT_CONTEXT_TEMPLATE, { encoding: "utf8", flag: "wx" }); }
      catch (error) { if (!existsSync(paths.markdown)) throw error; }
    }
    return this.rebuild(projectId, projectPath);
  }

  save(projectId: string, projectPath: string, content: string, expectedSourceHash: string): ProjectContextDocument {
    const paths = this.paths(projectPath);
    if (!existsSync(paths.markdown)) throw new Error("Project Context is not initialized.");
    const current = readFileSync(paths.markdown, "utf8");
    if (hash(current) !== expectedSourceHash) throw new Error("STALE_PROJECT_CONTEXT_WRITE");
    atomicWrite(paths.markdown, content);
    return this.rebuild(projectId, projectPath);
  }

  rebuildIfExists(projectId: string, projectPath: string): ProjectContextDocument | undefined {
    return existsSync(this.paths(projectPath).markdown) ? this.rebuild(projectId, projectPath) : undefined;
  }

  rebuild(projectId: string, projectPath: string): ProjectContextDocument {
    const paths = this.paths(projectPath);
    const content = readFileSync(paths.markdown, "utf8");
    const parsed = parseProjectContext(content);
    const document: ProjectContextDocument = {
      schemaVersion: 1,
      projectId,
      markdownPath: "outputs/system/project-context.md",
      mirrorPath: "outputs/system/project-context.json",
      content,
      sourceHash: hash(content),
      updatedAt: statSync(paths.markdown).mtime.toISOString(),
      sections: parsed.sections,
      warnings: parsed.warnings
    };
    mkdirSync(dirname(paths.mirror), { recursive: true });
    atomicWrite(paths.mirror, `${JSON.stringify({ ...document, content: undefined }, null, 2)}\n`);
    return document;
  }
}

export function parseProjectContext(content: string): { sections: ProjectContextSection[]; warnings: ProjectContextWarning[] } {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const warnings: ProjectContextWarning[] = [];
  if (lines.find((line) => line.trim().length > 0)?.trim() !== "# Project Context") {
    warnings.push({ code: "MISSING_TITLE", message: "Expected '# Project Context' as the document title." });
  }
  const headings = lines.flatMap((line, index) => {
    const match = /^##\s+(.+?)\s*$/u.exec(line);
    return match?.[1] === undefined ? [] : [{ title: match[1], index }];
  });
  const sections: ProjectContextSection[] = [];
  const seen = new Set<string>();
  headings.forEach((heading, index) => {
    const endIndex = (headings[index + 1]?.index ?? lines.length) - 1;
    if (!FIXED_SECTIONS.includes(heading.title as (typeof FIXED_SECTIONS)[number])) {
      warnings.push({ code: "UNKNOWN_SECTION", message: `Unknown section '${heading.title}' is preserved in Markdown but excluded from the structured mirror.`, line: heading.index + 1 });
      return;
    }
    if (seen.has(heading.title)) {
      warnings.push({ code: "DUPLICATE_SECTION", message: `Duplicate section '${heading.title}' is preserved in Markdown but excluded from the structured mirror.`, line: heading.index + 1 });
      return;
    }
    seen.add(heading.title);
    sections.push({
      id: heading.title.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, ""),
      title: heading.title,
      content: lines.slice(heading.index + 1, endIndex + 1).join("\n").trim(),
      startLine: heading.index + 1,
      endLine: Math.max(heading.index + 1, endIndex + 1)
    });
  });
  for (const title of FIXED_SECTIONS) {
    if (!seen.has(title)) warnings.push({ code: "MISSING_SECTION", message: `Required section '${title}' is missing.` });
  }
  return { sections, warnings };
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.partial`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

function hash(content: string): string { return createHash("sha256").update(content).digest("hex"); }
