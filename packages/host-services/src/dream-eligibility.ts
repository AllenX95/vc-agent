import type { ReflectionDreamEligibility, TrajectoryEvent } from "@vc-agent/contracts";

export interface EligibleReflectionTrajectoryTurn {
  readonly sourceKind: "reflection_dialogue";
  readonly signal: ReflectionDreamEligibility["signal"];
  readonly threadId: string;
  readonly turnId: string;
  readonly completedAt: string;
  readonly sourceReference: string;
  readonly userText: string;
  readonly assistantText: string;
}

export function detectReflectionDreamEligibility(text: string): ReflectionDreamEligibility | undefined {
  const normalized = text.trim();
  if (normalized.length === 0) return undefined;
  if (/(?:^|[，。；;\s])(?:我)?(?:不同意|不认同|纠正|修正|更正|改变|改为|推翻)(?:这个|该|此前|原先|之前|上述|你)?(?:观点|判断|结论|看法|假设|框架)?|\bI\s+(?:disagree|correct|revise|update|change|reject)\b|\bmy\s+(?:view|judg(?:e)?ment|conclusion|decision)\s+(?:has changed|is instead|should instead)\b/iu.test(normalized)) {
    return { sourceKind: "reflection_dialogue", signal: "correction" };
  }
  if (/(?:^|[，。；;\s])(?:我)?(?:同意|认同|采纳|接受|采用)(?:这个|该|上述|你的|这一)?(?:观点|判断|结论|看法|框架|建议)?|\bI\s+(?:adopt|agree|accept|will use|am persuaded by)\b/iu.test(normalized)) {
    return { sourceKind: "reflection_dialogue", signal: "adoption" };
  }
  if (/(?:我确认|确认(?:这个|该|上述)?(?:观点|判断|结论)|我(?:认为|判断|决定|确信)|我的(?:观点|判断|结论|决定)是|核心(?:观点|判断|结论)是)|\bI\s+(?:confirm|conclude|decide|believe|judge|think)\b|\bmy\s+(?:view|judg(?:e)?ment|conclusion|decision)\s+is\b/iu.test(normalized)) {
    return { sourceKind: "reflection_dialogue", signal: "confirmation" };
  }
  return undefined;
}

export function selectEligibleReflectionTrajectory(events: readonly TrajectoryEvent[]): EligibleReflectionTrajectoryTurn[] {
  const completed = new Map(events.filter((event): event is Extract<TrajectoryEvent, { event: "turn.completed" }> => event.event === "turn.completed").map((event) => [event.turnId, event]));
  return events.flatMap((event): EligibleReflectionTrajectoryTurn[] => {
    if (event.event !== "turn.submitted" || event.payload.dreamEligibility === undefined) return [];
    const completion = completed.get(event.turnId);
    if (completion === undefined) return [];
    return [{
      ...event.payload.dreamEligibility,
      threadId: event.threadId,
      turnId: event.turnId,
      completedAt: completion.occurredAt,
      sourceReference: `thread:${event.threadId}/turn:${event.turnId}`,
      userText: event.payload.text,
      assistantText: completion.payload.message
    }];
  });
}
