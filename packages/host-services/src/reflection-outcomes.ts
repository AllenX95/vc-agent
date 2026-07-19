import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  judgmentRecordDraftSchema,
  longTermLearningProposalSchema,
  reflectionOutcomeProposalInputSchema,
  type JudgmentRecordDraft,
  type LongTermLearningProposal,
  type ReflectionOutcomeProposalInput
} from "@vc-agent/contracts";

type OutcomeEvent =
  | { schemaVersion: 1; event: "judgment.proposed"; draft: JudgmentRecordDraft }
  | { schemaVersion: 1; event: "learning.proposed"; draft: LongTermLearningProposal }
  | { schemaVersion: 1; event: "judgment.confirmed"; draftId: string; confirmedAt: string }
  | { schemaVersion: 1; event: "outcome.discarded"; draftId: string }
  | { schemaVersion: 1; event: "learning.patch_prepared"; draftId: string; patchId: string }
  | { schemaVersion: 1; event: "learning.patch_discarded"; draftId: string; patchId: string }
  | { schemaVersion: 1; event: "learning.adopted"; draftId: string; patchId: string };

export interface ReflectionOutcomeStoreOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export interface ReflectionOutcomeList {
  readonly judgments: JudgmentRecordDraft[];
  readonly learningProposals: LongTermLearningProposal[];
}

export class ReflectionOutcomeStore {
  readonly #logPath: string;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(logPath: string, options: ReflectionOutcomeStoreOptions = {}) {
    this.#logPath = logPath;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  propose(runId: string, input: ReflectionOutcomeProposalInput): ReflectionOutcomeList {
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
        status: "draft",
        createdAt
      });
      this.#append({ schemaVersion: 1, event: "judgment.proposed", draft });
      judgments.push(draft);
    }
    for (const proposal of parsed.learningProposals) {
      const draft = longTermLearningProposalSchema.parse({
        schemaVersion: 1,
        id: this.#createId(),
        runId,
        ...proposal,
        status: "draft",
        createdAt
      });
      this.#append({ schemaVersion: 1, event: "learning.proposed", draft });
      learningProposals.push(draft);
    }
    return { judgments, learningProposals };
  }

  list(runId: string): ReflectionOutcomeList {
    const state = this.#load();
    return {
      judgments: [...state.judgments.values()].filter((draft) => draft.runId === runId),
      learningProposals: [...state.learningProposals.values()].filter((draft) => draft.runId === runId)
    };
  }

  getJudgment(id: string): JudgmentRecordDraft | undefined { return this.#load().judgments.get(id); }
  getLearningProposal(id: string): LongTermLearningProposal | undefined { return this.#load().learningProposals.get(id); }
  getLearningProposalByPatch(patchId: string): LongTermLearningProposal | undefined {
    return [...this.#load().learningProposals.values()].find((proposal) => proposal.preparedPatchId === patchId);
  }

  confirmJudgment(id: string, destinationRoot: string, context: { scope: "project"; projectId: string; threadId: string } | { scope: "unscoped"; threadId: string }): JudgmentRecordDraft {
    const draft = this.getJudgment(id);
    if (draft === undefined || draft.status !== "draft") throw new Error("Judgment Record draft is no longer confirmable.");
    const confirmedAt = this.#now().toISOString();
    const confirmed = judgmentRecordDraftSchema.parse({ ...draft, status: "confirmed", confirmedAt });
    const root = context.scope === "project" ? join(destinationRoot, "outputs", "system", "judgment-records") : join(destinationRoot, "judgment-records");
    const jsonPath = join(root, `${id}.json`);
    const markdownPath = join(root, `${id}.md`);
    if (existsSync(jsonPath) || existsSync(markdownPath)) throw new Error("Judgment Record output already exists.");
    mkdirSync(root, { recursive: true });
    const record = { ...confirmed, ...context };
    atomicWrite(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
    try {
      atomicWrite(markdownPath, renderJudgmentRecord(confirmed));
    } catch (error) {
      rmSync(jsonPath, { force: true });
      throw error;
    }
    this.#append({ schemaVersion: 1, event: "judgment.confirmed", draftId: id, confirmedAt });
    return confirmed;
  }

  discard(id: string): void {
    const state = this.#load();
    const judgment = state.judgments.get(id);
    const proposal = state.learningProposals.get(id);
    if ((judgment === undefined || judgment.status !== "draft") && (proposal === undefined || proposal.status !== "draft")) {
      throw new Error("Reflection outcome draft is no longer discardable.");
    }
    this.#append({ schemaVersion: 1, event: "outcome.discarded", draftId: id });
  }

  discardRunDrafts(runId: string): ReflectionOutcomeList {
    const outcomes = this.list(runId);
    for (const draft of [...outcomes.judgments, ...outcomes.learningProposals]) {
      if (draft.status === "draft") this.#append({ schemaVersion: 1, event: "outcome.discarded", draftId: draft.id });
    }
    return this.list(runId);
  }

  markPatchPrepared(id: string, patchId: string): LongTermLearningProposal {
    const proposal = this.getLearningProposal(id);
    if (proposal === undefined || proposal.status !== "draft") throw new Error("Learning Proposal is no longer available for patch preparation.");
    this.#append({ schemaVersion: 1, event: "learning.patch_prepared", draftId: id, patchId });
    return longTermLearningProposalSchema.parse({ ...proposal, status: "patch_prepared", preparedPatchId: patchId });
  }

  markPatchDiscarded(patchId: string): LongTermLearningProposal | undefined {
    const proposal = this.getLearningProposalByPatch(patchId);
    if (proposal === undefined || proposal.status !== "patch_prepared") return undefined;
    this.#append({ schemaVersion: 1, event: "learning.patch_discarded", draftId: proposal.id, patchId });
    return longTermLearningProposalSchema.parse({ ...proposal, status: "draft", preparedPatchId: undefined });
  }

  markPatchCommitted(patchId: string): LongTermLearningProposal | undefined {
    const proposal = this.getLearningProposalByPatch(patchId);
    if (proposal === undefined || proposal.status !== "patch_prepared") return undefined;
    this.#append({ schemaVersion: 1, event: "learning.adopted", draftId: proposal.id, patchId });
    return longTermLearningProposalSchema.parse({ ...proposal, status: "adopted" });
  }

  #append(event: OutcomeEvent): void {
    mkdirSync(dirname(this.#logPath), { recursive: true });
    appendFileSync(this.#logPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  #load(): { judgments: Map<string, JudgmentRecordDraft>; learningProposals: Map<string, LongTermLearningProposal> } {
    const judgments = new Map<string, JudgmentRecordDraft>();
    const learningProposals = new Map<string, LongTermLearningProposal>();
    if (!existsSync(this.#logPath)) return { judgments, learningProposals };
    for (const line of readFileSync(this.#logPath, "utf8").split(/\r?\n/u)) {
      if (line.trim() === "") continue;
      const event = JSON.parse(line) as OutcomeEvent;
      if (event.event === "judgment.proposed") judgments.set(event.draft.id, judgmentRecordDraftSchema.parse(event.draft));
      else if (event.event === "learning.proposed") learningProposals.set(event.draft.id, longTermLearningProposalSchema.parse(event.draft));
      else if (event.event === "judgment.confirmed") {
        const draft = judgments.get(event.draftId);
        if (draft !== undefined) judgments.set(event.draftId, judgmentRecordDraftSchema.parse({ ...draft, status: "confirmed", confirmedAt: event.confirmedAt }));
      } else if (event.event === "outcome.discarded") {
        const judgment = judgments.get(event.draftId);
        if (judgment !== undefined) judgments.set(event.draftId, judgmentRecordDraftSchema.parse({ ...judgment, status: "discarded" }));
        const proposal = learningProposals.get(event.draftId);
        if (proposal !== undefined) learningProposals.set(event.draftId, longTermLearningProposalSchema.parse({ ...proposal, status: "discarded" }));
      } else if (event.event === "learning.patch_prepared") {
        const proposal = learningProposals.get(event.draftId);
        if (proposal !== undefined) learningProposals.set(event.draftId, longTermLearningProposalSchema.parse({ ...proposal, status: "patch_prepared", preparedPatchId: event.patchId }));
      } else if (event.event === "learning.patch_discarded") {
        const proposal = learningProposals.get(event.draftId);
        if (proposal !== undefined && proposal.preparedPatchId === event.patchId) learningProposals.set(event.draftId, longTermLearningProposalSchema.parse({ ...proposal, status: "draft", preparedPatchId: undefined }));
      } else {
        const proposal = learningProposals.get(event.draftId);
        if (proposal !== undefined && proposal.preparedPatchId === event.patchId) learningProposals.set(event.draftId, longTermLearningProposalSchema.parse({ ...proposal, status: "adopted" }));
      }
    }
    return { judgments, learningProposals };
  }
}

function atomicWrite(path: string, content: string): void {
  const staged = `${path}.tmp-${randomUUID()}`;
  writeFileSync(staged, content, "utf8");
  try { renameSync(staged, path); }
  catch (error) { rmSync(staged, { force: true }); throw error; }
}

function renderJudgmentRecord(record: JudgmentRecordDraft): string {
  const list = (items: readonly string[]) => items.length === 0 ? "- None recorded" : items.map((item) => `- ${item}`).join("\n");
  return `# Judgment Record\n\n- Decision: ${record.decisionState}\n- Source availability: ${record.sourceAvailability}\n- Confirmed: ${record.confirmedAt}\n- Source reference: ${record.sourceReferenceId}\n\n## View\n\n${record.view}\n\n## Reasoning\n\n${list(record.reasoning)}\n\n## Uncertainties\n\n${list(record.uncertainties)}\n\n## Counterarguments\n\n${list(record.counterarguments)}\n\n## Evidence References\n\n${list(record.evidenceReferences)}\n`;
}
