import type { LongTermMemoryDocument, LongTermMemoryEntry } from "./long-term-memory.js";
import { LongTermMemoryStore } from "./long-term-memory.js";
import { MemoryEvolutionStore, type MemoryPatchRequest, type PreparedMemoryPatch } from "./memory-evolution.js";
import { MemoryCandidateStore, type MemoryCandidate, type ProjectMemoryDocument } from "./project-memory.js";

export type PendingMemoryKind = "candidate" | "dream_proposal" | "reflection_proposal" | "conflict";
export type MemoryWorkspaceView = "pending_review" | "adopted_memory" | "history";

export interface PendingMemoryQuery {
  readonly projectId?: string;
  readonly kind?: PendingMemoryKind;
  readonly limit?: number;
}

export interface PendingMemoryProjection {
  readonly id: string;
  readonly kind: PendingMemoryKind;
  readonly scope: "project" | "unscoped" | "global";
  readonly projectId?: string;
  readonly title: string;
  readonly summary: string;
  readonly sourceReferences: readonly string[];
  readonly provenance: "captured" | "reviewed" | "conflict";
  readonly reviewStatus: "pending" | "unresolved";
}

export interface MemoryChangeRequest extends MemoryPatchRequest {}
export type PreparedMemoryChange = PreparedMemoryPatch;
export type MemoryCommitResult = LongTermMemoryDocument;

export interface MemoryHistoryQuery {
  readonly projectId?: string;
  readonly limit?: number;
}

export interface MemoryHistoryProjection {
  readonly id: string;
  readonly kind: "cognitive_evolution" | "condensation_archive" | "superseded_memory" | "provenance";
  readonly title: string;
  readonly summary: string;
  readonly sourcePath: string;
  readonly sourceReferences: readonly string[];
}

export interface MemoryReviewServiceOptions {
  readonly candidates?: MemoryCandidateStore;
  readonly loadProjectMemory?: (projectId: string) => ProjectMemoryDocument | undefined;
  readonly listDreamProposals?: () => readonly PendingMemoryProjection[];
  readonly listReflectionProposals?: () => readonly PendingMemoryProjection[];
}

/**
 * Application seam for review-oriented Memory navigation.  It projects the
 * separate authoritative stores into three views; it never merges or writes
 * them implicitly.
 */
export class MemoryReviewService {
  readonly #memory: LongTermMemoryStore;
  readonly #evolution: MemoryEvolutionStore;
  readonly #candidates: MemoryCandidateStore | undefined;
  readonly #loadProjectMemory: ((projectId: string) => ProjectMemoryDocument | undefined) | undefined;
  readonly #listDreamProposals: () => readonly PendingMemoryProjection[];
  readonly #listReflectionProposals: () => readonly PendingMemoryProjection[];

  constructor(memory: LongTermMemoryStore, evolution: MemoryEvolutionStore, options: MemoryReviewServiceOptions = {}) {
    this.#memory = memory;
    this.#evolution = evolution;
    this.#candidates = options.candidates;
    this.#loadProjectMemory = options.loadProjectMemory;
    this.#listDreamProposals = options.listDreamProposals ?? (() => []);
    this.#listReflectionProposals = options.listReflectionProposals ?? (() => []);
  }

  listPending(query: PendingMemoryQuery = {}): PendingMemoryProjection[] {
    const candidates = (this.#candidates?.list() ?? [])
      .filter((candidate) => candidate.status === "active")
      .filter((candidate) => query.projectId === undefined || candidate.projectId === query.projectId)
      .map(candidateProjection);
    const conflicts = (this.#memory.load(false)?.entries ?? [])
      .filter((entry) => entry.status === "current" && entry.conflictState.startsWith("unresolved:"))
      .filter((entry) => query.projectId === undefined)
      .map(conflictProjection);
    const result = [...candidates, ...this.#listDreamProposals(), ...this.#listReflectionProposals(), ...conflicts]
      .filter((item) => query.kind === undefined || item.kind === query.kind)
      .sort((left, right) => left.id.localeCompare(right.id));
    return query.limit === undefined ? result : result.slice(0, Math.max(0, query.limit));
  }

  listAdopted(projectIds: readonly string[] = []): { readonly project: ProjectMemoryDocument[]; readonly global: LongTermMemoryEntry[] } {
    const project = projectIds.flatMap((projectId) => {
      const document = this.#loadProjectMemory?.(projectId);
      return document === undefined ? [] : [document];
    });
    const global = (this.#memory.load(false)?.entries ?? []).filter((entry) => entry.status === "current");
    return { project, global };
  }

  prepareChange(request: MemoryChangeRequest): PreparedMemoryChange {
    return this.#evolution.prepare(request);
  }

  commit(changeId: string): MemoryCommitResult {
    return this.#evolution.commit(changeId);
  }

  discard(changeId: string): void {
    if (!this.#evolution.discard(changeId)) throw new Error("MEMORY_CHANGE_NOT_FOUND");
  }

  history(query: MemoryHistoryQuery = {}): MemoryHistoryProjection[] {
    const document = this.#memory.load(false);
    if (document === undefined) return [];
    const currentLimit = query.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, query.limit);
    const superseded = document.entries.filter((entry) => entry.status === "superseded").map((entry) => ({
      id: `superseded:${entry.id}:v${entry.version}`,
      kind: "superseded_memory" as const,
      title: entry.title,
      summary: entry.content.slice(0, 500),
      sourcePath: document.markdownPath,
      sourceReferences: entry.sourceReferenceIds
    }));
    const files = document.files.filter((file) => file.kind !== "active").map((file) => ({
      id: `${file.kind}:${file.sourceHash}`,
      kind: file.kind === "cognitive_evolution_history" ? "cognitive_evolution" as const : "condensation_archive" as const,
      title: file.name,
      summary: "Retained Memory history; excluded from ordinary current recall.",
      sourcePath: file.path,
      sourceReferences: [] as string[]
    }));
    return [...files, ...superseded].slice(0, currentLimit);
  }

  workspace(view: MemoryWorkspaceView, query: PendingMemoryQuery | MemoryHistoryQuery = {}): PendingMemoryProjection[] | MemoryHistoryProjection[] | { readonly project: ProjectMemoryDocument[]; readonly global: LongTermMemoryEntry[] } {
    if (view === "pending_review") return this.listPending(query as PendingMemoryQuery);
    if (view === "history") return this.history(query as MemoryHistoryQuery);
    const projectIds = "projectId" in query && query.projectId !== undefined ? [query.projectId] : [];
    return this.listAdopted(projectIds);
  }
}

function candidateProjection(candidate: MemoryCandidate): PendingMemoryProjection {
  return {
    id: candidate.id,
    kind: "candidate",
    scope: candidate.scope,
    ...(candidate.projectId === undefined ? {} : { projectId: candidate.projectId }),
    title: candidate.signal.replaceAll("_", " "),
    summary: candidate.sourceSnippet,
    sourceReferences: [candidate.sourceReference],
    provenance: "captured",
    reviewStatus: "pending"
  };
}

function conflictProjection(entry: LongTermMemoryEntry): PendingMemoryProjection {
  return {
    id: `conflict:${entry.id}`,
    kind: "conflict",
    scope: "global",
    title: entry.title,
    summary: entry.conflictState,
    sourceReferences: entry.sourceReferenceIds,
    provenance: "conflict",
    reviewStatus: "unresolved"
  };
}
