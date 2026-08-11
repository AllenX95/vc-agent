import {
  coverageLedgerSchema,
  coverageSummarySchema,
  sourceDispositionInputSchema,
  type CoverageLedger,
  type CoverageLedgerEntry,
  type CoverageSummary,
  type EligibleLearningSource,
  type SourceDispositionInput
} from "@vc-agent/contracts";

export interface CoverageSourceInput extends Pick<EligibleLearningSource, "sourceReference" | "scope" | "completedAt"> {
  readonly sourceKind?: EligibleLearningSource["sourceKind"];
  readonly projectId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly sourceVersion?: string;
  readonly availability?: "available" | "deleted";
}

export interface CreateCoverageLedgerInput {
  readonly batchId: string;
  readonly cutoff: string;
  readonly sources: readonly CoverageSourceInput[];
  readonly createdAt: string;
}

export interface ApplyCoverageDispositionsOptions {
  readonly proposalIds?: readonly string[];
  readonly updatedAt?: string;
}

/** Create a deterministic, content-free ledger snapshot for one frozen cutoff. */
export function createCoverageLedger(input: CreateCoverageLedgerInput): CoverageLedger {
  if (!input.batchId.trim()) throw new Error("Coverage Ledger batchId is required.");
  const seen = new Set<string>();
  const entries = [...input.sources]
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt) || left.sourceReference.localeCompare(right.sourceReference))
    .map((source): CoverageLedgerEntry => {
      if (seen.has(source.sourceReference)) throw new Error(`Duplicate eligible source: ${source.sourceReference}`);
      seen.add(source.sourceReference);
      return {
        sourceReference: source.sourceReference,
        sourceKind: source.sourceKind ?? "ordinary_exchange",
        scope: source.scope,
        ...(source.projectId === undefined ? {} : { projectId: source.projectId }),
        ...(source.threadId === undefined ? {} : { threadId: source.threadId }),
        ...(source.turnId === undefined ? {} : { turnId: source.turnId }),
        completedAt: source.completedAt,
        status: "pending",
        proposalIds: [],
        availability: source.availability ?? "available",
        updatedAt: input.createdAt
      };
    });
  return coverageLedgerSchema.parse({
    schemaVersion: 1,
    batchId: input.batchId,
    cutoff: input.cutoff,
    entries,
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });
}

/**
 * Apply one extraction result to the ledger.  Unknown, duplicate, terminal,
 * or invalid proposal references are rejected rather than silently changing
 * coverage.  A partial result is allowed; callers use projectCoverageSummary
 * (or assertCoverageComplete) before synthesis/commit.
 */
export function applyCoverageDispositions(
  ledger: CoverageLedger,
  dispositions: readonly CoverageDispositionInput[],
  options: ApplyCoverageDispositionsOptions = {}
): CoverageLedger {
  const parsedLedger = coverageLedgerSchema.parse(ledger);
  const parsedDispositions = dispositions.map((disposition) => sourceDispositionInputSchema.parse(disposition));
  const knownProposalIds = options.proposalIds === undefined ? undefined : new Set(options.proposalIds);
  const seen = new Set<string>();
  const byReference = new Map(parsedLedger.entries.map((entry) => [entry.sourceReference, entry]));
  for (const disposition of parsedDispositions) {
    if (seen.has(disposition.sourceReference)) throw new Error(`Duplicate disposition: ${disposition.sourceReference}`);
    seen.add(disposition.sourceReference);
    const entry = byReference.get(disposition.sourceReference);
    if (entry === undefined) throw new Error(`Disposition references a source outside the frozen ledger: ${disposition.sourceReference}`);
    if (entry.status !== "pending" && entry.status !== "processing") throw new Error(`Source already has a terminal disposition: ${disposition.sourceReference}`);
    const proposalIds = disposition.proposalIds ?? [];
    if (disposition.status === "represented") {
      if (proposalIds.length === 0) throw new Error(`Represented source requires a proposal: ${disposition.sourceReference}`);
      if (knownProposalIds !== undefined && proposalIds.some((proposalId) => !knownProposalIds.has(proposalId))) {
        throw new Error(`Represented source references an unknown proposal: ${disposition.sourceReference}`);
      }
    } else if (proposalIds.length > 0) {
      throw new Error(`Only represented sources may reference proposals: ${disposition.sourceReference}`);
    }
  }
  const updatedAt = options.updatedAt ?? parsedLedger.updatedAt;
  const updates = new Map(parsedDispositions.map((disposition) => [disposition.sourceReference, disposition]));
  const entries = parsedLedger.entries.map((entry) => {
    const disposition = updates.get(entry.sourceReference);
    if (disposition === undefined) return entry;
    return {
      ...entry,
      status: disposition.status,
      proposalIds: disposition.proposalIds ?? [],
      ...(disposition.reason === undefined ? {} : { dispositionReason: disposition.reason }),
      updatedAt
    };
  });
  return coverageLedgerSchema.parse({ ...parsedLedger, entries, updatedAt });
}

export type CoverageDispositionInput = SourceDispositionInput;

export function projectCoverageSummary(ledger: CoverageLedger): CoverageSummary {
  const parsed = coverageLedgerSchema.parse(ledger);
  const summary = {
    eligibleCount: parsed.entries.length,
    noSignalCount: parsed.entries.filter((entry) => entry.status === "no_signal").length,
    representedCount: parsed.entries.filter((entry) => entry.status === "represented").length,
    carriedOverCount: parsed.entries.filter((entry) => entry.status === "carried_over").length,
    pendingCount: parsed.entries.filter((entry) => entry.status === "pending").length,
    processingCount: parsed.entries.filter((entry) => entry.status === "processing").length,
    complete: parsed.entries.every((entry) => ["no_signal", "represented", "carried_over"].includes(entry.status))
  };
  return coverageSummarySchema.parse(summary);
}

export function assertCoverageComplete(ledger: CoverageLedger): CoverageSummary {
  const summary = projectCoverageSummary(ledger);
  if (!summary.complete) throw new Error("Cognition Review coverage is incomplete.");
  return summary;
}

export function terminalCoverageSets(ledger: CoverageLedger): {
  readonly noSignal: ReadonlySet<string>;
  readonly represented: ReadonlySet<string>;
  readonly carriedOver: ReadonlySet<string>;
} {
  const parsed = coverageLedgerSchema.parse(ledger);
  return {
    noSignal: new Set(parsed.entries.filter((entry) => entry.status === "no_signal").map((entry) => entry.sourceReference)),
    represented: new Set(parsed.entries.filter((entry) => entry.status === "represented").map((entry) => entry.sourceReference)),
    carriedOver: new Set(parsed.entries.filter((entry) => entry.status === "carried_over").map((entry) => entry.sourceReference))
  };
}

