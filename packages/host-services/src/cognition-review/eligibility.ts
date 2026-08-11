import {
  eligibleLearningSourceSchema,
  learningEpochSchema,
  type EligibleLearningSource,
  type EligibleLearningSourceKind,
  type LearningEpoch,
  type TrajectoryEvent
} from "@vc-agent/contracts";

export interface EligibilityScope {
  readonly kind: "project" | "unscoped";
  readonly projectId?: string;
  readonly threadId?: string;
}

export interface ConfirmedCognitionArtifactInput {
  readonly sourceReference: string;
  readonly completedAt: string;
  readonly scope: "project" | "unscoped";
  readonly projectId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly sourceVersion?: string;
  readonly availability?: "available" | "deleted";
}

export interface EligibilitySelectionInput {
  readonly learningEpochStartedAt: string | LearningEpoch;
  readonly events?: readonly TrajectoryEvent[];
  readonly eventsByThread?: ReadonlyMap<string, readonly TrajectoryEvent[]>;
  readonly scope?: EligibilityScope;
  readonly scopesByThread?: ReadonlyMap<string, EligibilityScope>;
  readonly threads?: readonly { readonly id: string; readonly scope: "project" | "unscoped"; readonly projectId?: string }[];
  readonly confirmedJudgments?: readonly ConfirmedCognitionArtifactInput[];
  readonly explicitMemoryActions?: readonly ConfirmedCognitionArtifactInput[];
  readonly cutoff?: string;
  readonly excludedThreadIds?: ReadonlySet<string>;
}

/**
 * Select content-free, user-attributable sources from completed trajectory
 * events and confirmed artifacts.  This function intentionally does not copy
 * user or assistant text into the result.
 */
export function selectEligibleLearningSources(input: EligibilitySelectionInput): EligibleLearningSource[];
export function selectEligibleLearningSources(
  events: readonly TrajectoryEvent[],
  learningEpochStartedAt: string | LearningEpoch,
  options?: Omit<EligibilitySelectionInput, "events" | "learningEpochStartedAt">
): EligibleLearningSource[];
export function selectEligibleLearningSources(
  inputOrEvents: EligibilitySelectionInput | readonly TrajectoryEvent[],
  epochArgument?: string | LearningEpoch,
  options: Omit<EligibilitySelectionInput, "events" | "learningEpochStartedAt"> = {}
): EligibleLearningSource[] {
  const input: EligibilitySelectionInput = Array.isArray(inputOrEvents)
    ? { ...options, events: inputOrEvents as readonly TrajectoryEvent[], learningEpochStartedAt: epochArgument ?? new Date(0).toISOString() }
    : inputOrEvents as EligibilitySelectionInput;
  const epoch = parseEpoch(input.learningEpochStartedAt);
  const events = input.events ?? flattenEvents(input.eventsByThread);
  const scopes = resolveScopes(input);
  const excluded = input.excludedThreadIds ?? new Set<string>();
  const selected = new Map<string, EligibleLearningSource>();

  const grouped = new Map<string, TrajectoryEvent[]>();
  for (const event of events) {
    const bucket = grouped.get(event.threadId) ?? [];
    bucket.push(event);
    grouped.set(event.threadId, bucket);
  }
  for (const [threadId, threadEvents] of grouped) {
    if (excluded.has(threadId)) continue;
    const scope = scopes.get(threadId) ?? input.scope ?? { kind: "unscoped", threadId };
    const submitted = new Map<string, Extract<TrajectoryEvent, { event: "turn.submitted" }>>();
    const terminal = new Map<string, "completed" | "failed" | "interrupted">();
    const completed = new Map<string, Extract<TrajectoryEvent, { event: "turn.completed" }>>();
    for (const event of threadEvents) {
      if (event.event === "turn.submitted") submitted.set(event.turnId, event);
      if (event.event === "turn.completed") {
        terminal.set(event.turnId, "completed");
        completed.set(event.turnId, event);
      }
      if (event.event === "turn.failed") terminal.set(event.turnId, "failed");
      if (event.event === "turn.interrupted") terminal.set(event.turnId, "interrupted");
    }
    for (const [turnId, completion] of completed) {
      const submission = submitted.get(turnId);
      if (submission === undefined || terminal.get(turnId) !== "completed") continue;
      if (isBeforeOrAtEpoch(completion.occurredAt, epoch.learningEpochStartedAt) || !atOrBeforeCutoff(completion.occurredAt, input.cutoff)) continue;
      if (isExcludedSession(submission, completion)) continue;
      const payload = submission.payload as unknown as Record<string, unknown>;
      const sourceKind: EligibleLearningSourceKind = inferSourceKind(payload) ?? "ordinary_exchange";
      const sourceReference = `thread:${completion.threadId}/turn:${turnId}`;
      const source = sourceRecord({
        sourceReference,
        sourceKind,
        scope,
        threadId: completion.threadId,
        turnId,
        completedAt: completion.occurredAt
      });
      selected.set(sourceReference, source);
    }
  }

  for (const artifact of [...(input.confirmedJudgments ?? []), ...(input.explicitMemoryActions ?? [])]) {
    if (isBeforeOrAtEpoch(artifact.completedAt, epoch.learningEpochStartedAt) || !atOrBeforeCutoff(artifact.completedAt, input.cutoff)) continue;
    const sourceKind: EligibleLearningSourceKind = input.explicitMemoryActions?.includes(artifact) ? "explicit_memory_action" : "confirmed_judgment";
    const source = sourceRecord({ ...artifact, sourceKind });
    selected.set(source.sourceReference, source);
  }

  return [...selected.values()].sort((left, right) => left.completedAt.localeCompare(right.completedAt) || left.sourceReference.localeCompare(right.sourceReference));
}

export const selectEligibleSources = selectEligibleLearningSources;
export const collectEligibleLearningSources = selectEligibleLearningSources;

function parseEpoch(value: string | LearningEpoch): LearningEpoch {
  if (typeof value === "string") return learningEpochSchema.parse({ schemaVersion: 1, learningEpochStartedAt: value });
  return learningEpochSchema.parse(value);
}

function flattenEvents(eventsByThread: ReadonlyMap<string, readonly TrajectoryEvent[]> | undefined): TrajectoryEvent[] {
  if (eventsByThread === undefined) return [];
  return [...eventsByThread.values()].flatMap((events) => events);
}

function resolveScopes(input: EligibilitySelectionInput): Map<string, EligibilityScope> {
  const scopes = new Map(input.scopesByThread ?? []);
  for (const thread of input.threads ?? []) {
    scopes.set(thread.id, { kind: thread.scope, ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }), threadId: thread.id });
  }
  if (input.scope?.threadId !== undefined) scopes.set(input.scope.threadId, input.scope);
  return scopes;
}

function isBeforeOrAtEpoch(value: string, epoch: string): boolean {
  return new Date(value).valueOf() <= new Date(epoch).valueOf();
}

function atOrBeforeCutoff(value: string, cutoff: string | undefined): boolean {
  return cutoff === undefined || new Date(value).valueOf() <= new Date(cutoff).valueOf();
}

function isExcludedSession(
  submission: Extract<TrajectoryEvent, { event: "turn.submitted" }>,
  completion: Extract<TrajectoryEvent, { event: "turn.completed" }>
): boolean {
  if (submission.actor.actorType === "sub_agent" || submission.provenance.producerType === "sub_agent") return true;
  if (completion.actor.actorType === "sub_agent" || completion.provenance.producerType === "sub_agent") return true;
  const submissionPayload = submission.payload as unknown as Record<string, unknown>;
  const completionPayload = completion.payload as unknown as Record<string, unknown>;
  return [submissionPayload, completionPayload].some((payload) => {
    const markers = ["workflowKind", "executionKind", "taskKind", "sessionKind", "sourceKind", "cognitionSourceKind"]
      .map((key) => payload[key]).filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase());
    return markers.some((value) => value.includes("sub_agent") || value.includes("sub-agent") || value.includes("independent_evidence") || value.includes("memory_review") || value.includes("tool_only") || value.includes("tool-only") || value === "evidence_pass");
  });
}

function inferSourceKind(payload: Record<string, unknown>): EligibleLearningSourceKind | undefined {
  const markers = [payload.learningSourceKind, payload.cognitionSourceKind, payload.sourceKind]
    .filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase());
  if (markers.some((value) => value.includes("judgment") && (value.includes("confirmed") || value.includes("record")))) return "confirmed_judgment";
  if (markers.some((value) => value.includes("memory") && value.includes("action"))) return "explicit_memory_action";
  if (markers.some((value) => value.includes("ordinary"))) return "ordinary_exchange";
  if (markers.some((value) => value.includes("reflection"))) return "reflection_exchange";
  return "ordinary_exchange";
}

function sourceRecord(input: {
  readonly sourceReference: string;
  readonly sourceKind: EligibleLearningSourceKind;
  readonly completedAt: string;
  readonly scope: EligibilityScope | "project" | "unscoped";
  readonly projectId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly sourceVersion?: string;
  readonly availability?: "available" | "deleted";
}): EligibleLearningSource {
  const scopeKind = typeof input.scope === "string" ? input.scope : input.scope.kind;
  const projectId = input.projectId ?? (typeof input.scope === "string" ? undefined : input.scope.projectId);
  const threadId = input.threadId ?? (typeof input.scope === "string" ? undefined : input.scope.threadId);
  return eligibleLearningSourceSchema.parse({
    sourceReference: input.sourceReference,
    sourceKind: input.sourceKind,
    scope: scopeKind,
    ...(projectId === undefined ? {} : { projectId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    completedAt: input.completedAt,
    ...(input.sourceVersion === undefined ? {} : { sourceVersion: input.sourceVersion }),
    availability: input.availability ?? "available"
  });
}
