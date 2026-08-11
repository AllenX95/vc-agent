import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  judgmentRecordDraftSchema,
  longTermLearningProposalSchema,
  reflectionOutcomeProposalInputSchema,
  type JudgmentRecordDraft,
  type LongTermLearningProposal,
  type ReflectionOutcomeDependency,
  type ReflectionOutcomeProposalInput,
  type ReflectionOutcomeStaleReason
} from "@vc-agent/contracts";

type ReflectionDraftEvent =
  | { schemaVersion: 1; event: "judgment.proposed"; draft: JudgmentRecordDraft }
  | { schemaVersion: 1; event: "learning.proposed"; draft: LongTermLearningProposal }
  | { schemaVersion: 1; event: "outcome.discarded"; draftId: string }
  | { schemaVersion: 1; event: "outcome.stale"; draftId: string; staleAt: string; reasons: ReflectionOutcomeStaleReason[] };

export interface ReflectionDraftStoreOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export interface ReflectionDraftList {
  readonly judgments: JudgmentRecordDraft[];
  readonly learningProposals: LongTermLearningProposal[];
}

/** Narrow Host-facing seam; the event-log implementation remains private. */
export interface ReflectionDrafts {
  propose(runId: string, input: ReflectionOutcomeProposalInput, dependencies?: readonly ReflectionOutcomeDependency[]): ReflectionDraftList;
  list(runId: string): ReflectionDraftList;
  getJudgment(id: string): JudgmentRecordDraft | undefined;
  getLearningProposal(id: string): LongTermLearningProposal | undefined;
  discard(id: string): void;
  discardRunDrafts(runId: string): ReflectionDraftList;
  markStale(id: string, reasons: readonly ReflectionOutcomeStaleReason[]): JudgmentRecordDraft | LongTermLearningProposal;
}

export interface CreateReflectionDraftsOptions extends ReflectionDraftStoreOptions {
  /** Cognition-v2 root; the draft log is stored below this path. */
  readonly root: string;
  readonly logPath?: string;
}

/**
 * Non-authoritative Reflection analysis drafts.  This store only retains
 * proposals until the shared Cognition Review Module is prepared.  It cannot
 * confirm a Judgment Record or prepare/commit a Memory patch.
 */
export class ReflectionDraftStore implements ReflectionDrafts {
  readonly #logPath: string;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(logPath: string, options: ReflectionDraftStoreOptions = {}) {
    this.#logPath = logPath;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  propose(runId: string, input: ReflectionOutcomeProposalInput, dependencies: readonly ReflectionOutcomeDependency[] = []): ReflectionDraftList {
    const parsed = reflectionOutcomeProposalInputSchema.parse(input);
    const createdAt = this.#now().toISOString();
    const judgments: JudgmentRecordDraft[] = [];
    const learningProposals: LongTermLearningProposal[] = [];
    if (parsed.judgmentRecord !== undefined) {
      const id = this.#createId();
      const draft = judgmentRecordDraftSchema.parse({
        schemaVersion: 1,
        id,
        runId,
        sourceReferenceId: `src_ref_${id.replaceAll("-", "")}`,
        ...parsed.judgmentRecord,
        dependencies,
        status: "draft",
        createdAt
      });
      this.#append({ schemaVersion: 1, event: "judgment.proposed", draft });
      judgments.push(draft);
    }
    for (const proposal of parsed.learningProposals) {
      const draft = longTermLearningProposalSchema.parse({ schemaVersion: 1, id: this.#createId(), runId, ...proposal, dependencies, status: "draft", createdAt });
      this.#append({ schemaVersion: 1, event: "learning.proposed", draft });
      learningProposals.push(draft);
    }
    return { judgments, learningProposals };
  }

  list(runId: string): ReflectionDraftList {
    const state = this.#load();
    return {
      judgments: [...state.judgments.values()].filter((draft) => draft.runId === runId),
      learningProposals: [...state.learningProposals.values()].filter((draft) => draft.runId === runId)
    };
  }

  getJudgment(id: string): JudgmentRecordDraft | undefined { return this.#load().judgments.get(id); }
  getLearningProposal(id: string): LongTermLearningProposal | undefined { return this.#load().learningProposals.get(id); }

  discard(id: string): void {
    const state = this.#load();
    const judgment = state.judgments.get(id);
    const proposal = state.learningProposals.get(id);
    if ((judgment === undefined || !["draft", "stale"].includes(judgment.status)) && (proposal === undefined || !["draft", "stale"].includes(proposal.status))) {
      throw new Error("Reflection analysis draft is no longer discardable.");
    }
    this.#append({ schemaVersion: 1, event: "outcome.discarded", draftId: id });
  }

  discardRunDrafts(runId: string): ReflectionDraftList {
    const drafts = this.list(runId);
    for (const draft of [...drafts.judgments, ...drafts.learningProposals]) {
      if (["draft", "stale"].includes(draft.status)) this.#append({ schemaVersion: 1, event: "outcome.discarded", draftId: draft.id });
    }
    return this.list(runId);
  }

  markStale(id: string, reasons: readonly ReflectionOutcomeStaleReason[]): JudgmentRecordDraft | LongTermLearningProposal {
    if (reasons.length === 0) throw new Error("Stale Reflection analysis draft requires at least one changed dependency.");
    const state = this.#load();
    const outcome = state.judgments.get(id) ?? state.learningProposals.get(id);
    if (outcome === undefined || outcome.status !== "draft") throw new Error("Reflection analysis draft is no longer eligible for staleness transition.");
    const staleAt = this.#now().toISOString();
    this.#append({ schemaVersion: 1, event: "outcome.stale", draftId: id, staleAt, reasons: [...reasons] });
    if (state.judgments.has(id)) return judgmentRecordDraftSchema.parse({ ...outcome, status: "stale", staleAt, staleReasons: reasons });
    return longTermLearningProposalSchema.parse({ ...outcome, status: "stale", staleAt, staleReasons: reasons, preparedPatchId: undefined });
  }

  #append(event: ReflectionDraftEvent): void {
    mkdirSync(dirname(this.#logPath), { recursive: true });
    appendFileSync(this.#logPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  #load(): { judgments: Map<string, JudgmentRecordDraft>; learningProposals: Map<string, LongTermLearningProposal> } {
    const judgments = new Map<string, JudgmentRecordDraft>();
    const learningProposals = new Map<string, LongTermLearningProposal>();
    if (!existsSync(this.#logPath)) return { judgments, learningProposals };
    for (const line of readFileSync(this.#logPath, "utf8").split(/\r?\n/u)) {
      if (line.trim() === "") continue;
      const event = JSON.parse(line) as ReflectionDraftEvent;
      if (event.event === "judgment.proposed") judgments.set(event.draft.id, judgmentRecordDraftSchema.parse(event.draft));
      else if (event.event === "learning.proposed") learningProposals.set(event.draft.id, longTermLearningProposalSchema.parse(event.draft));
      else if (event.event === "outcome.discarded") {
        const judgment = judgments.get(event.draftId);
        if (judgment !== undefined) judgments.set(event.draftId, judgmentRecordDraftSchema.parse({ ...judgment, status: "discarded" }));
        const proposal = learningProposals.get(event.draftId);
        if (proposal !== undefined) learningProposals.set(event.draftId, longTermLearningProposalSchema.parse({ ...proposal, status: "discarded" }));
      } else {
        const judgment = judgments.get(event.draftId);
        if (judgment !== undefined && judgment.status === "draft") judgments.set(event.draftId, judgmentRecordDraftSchema.parse({ ...judgment, status: "stale", staleAt: event.staleAt, staleReasons: event.reasons }));
        const proposal = learningProposals.get(event.draftId);
        if (proposal !== undefined && proposal.status === "draft") learningProposals.set(event.draftId, longTermLearningProposalSchema.parse({ ...proposal, status: "stale", staleAt: event.staleAt, staleReasons: event.reasons, preparedPatchId: undefined }));
      }
    }
    return { judgments, learningProposals };
  }
}

/** Composition seam that keeps the concrete event-log store out of callers. */
export function createReflectionDrafts(options: CreateReflectionDraftsOptions): ReflectionDrafts {
  if (!options.root.trim() && options.logPath === undefined) throw new Error("Reflection draft root is required.");
  const logPath = options.logPath ?? join(options.root, "reflection-drafts.jsonl");
  return new ReflectionDraftStore(logPath, options);
}
