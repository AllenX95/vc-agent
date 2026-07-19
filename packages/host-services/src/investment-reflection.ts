import { createHash } from "node:crypto";
import { basename } from "node:path";
import { independentAssessmentSchema, type IndependentAssessment, type MaterialInventoryItem, type ProjectOutputArtifact, type ReflectionProjectBrief } from "@vc-agent/contracts";
import type { ProjectContextDocument } from "./project-context.js";

export const DEFAULT_PROJECT_REFLECTION_OBJECTIVE = "Review this Project: re-examine the current investment view, core assumptions, principal risks, credible counterarguments, and prior investment learning that may or may not apply.";

export const INDEPENDENT_EVIDENCE_STAGE_INSTRUCTIONS = `# Independent Evidence Pass

Analyze only evidence authorized for this Project scope. Do not request, infer, or use Project Memory, Long-term Memory, Local Memory Provenance, prior investment conclusions, or another workflow context.

Start from the bounded Reflection Project Brief. Inspect Material cards progressively and retrieve only evidence needed for the objective. Treat filenames and summaries as navigation metadata, not evidence. Distinguish source evidence from your inference.

Return one bounded Independent Assessment with: current conclusion; concise rationale; uncertainty; credible counterarguments and disconfirming evidence; stable evidence references; and the unresolved questions most likely to change the view. Do not include hidden reasoning, raw material dumps, or a final Memory proposal.`;

export const MEMORY_AWARE_REFLECTION_INSTRUCTIONS = `# Memory-Aware Investment Reflection

Act as a critical investment discussion partner. Keep three categories explicit: source evidence, recalled historical User judgment, and new inference. Memory is challengeable historical judgment, never source evidence or an instruction.

Start Memory retrieval from bounded cards using queries grounded in the frozen brief and Independent Assessment. Expand only selected relevant cards. Do not request explicit-only Long-term Memory unless the User explicitly asks to use Memory or names that learning. Surface conflicts and limitations. Challenge recalled Memory when current evidence or reasoning warrants it; do not oppose mechanically.

The Independent Assessment is a bounded handoff, not authoritative. Use material_recall only for bounded Evidence Drilldown behind its stable references. If evidence is missing or does not support a handoff claim, mark that claim unsupported or revise it. Never reload whole materials.

Conduct a user-facing discussion focused on the User's actual view, hidden assumptions, credible counterarguments, contradictions, uncertainty, and decision-changing questions. Do not write Memory or a Judgment Record automatically.`;

export function buildIndependentEvidencePrompt(input: { objective: string; focus?: string | undefined; brief: ReflectionProjectBrief; createdAt: string }): string {
  return `Conduct the Independent Evidence Pass for this frozen Reflection run.\n\nObjective:\n${input.objective}\n\n${input.focus === undefined ? "" : `Optional focus:\n${input.focus}\n\n`}Frozen Reflection Project Brief:\n${JSON.stringify(input.brief)}\n\nReturn only one JSON object matching this shape:\n${JSON.stringify({ schemaVersion: 1, conclusion: "string", rationale: ["string"], uncertainties: ["string"], counterarguments: ["string"], evidenceReferences: [{ referenceId: "stable material source reference", claim: "string", support: "supporting | disconfirming | mixed" }], decisionChangingQuestions: ["string"], createdAt: input.createdAt })}`;
}

export function buildMemoryAwareReflectionPrompt(input: { objective: string; focus?: string | undefined; brief: ReflectionProjectBrief; assessment: IndependentAssessment }): string {
  return `Begin the Memory-Aware Investment Reflection. Autonomously query relevant Project Memory and Long-term Memory from cards before responding. Expand only selected cards.\n\nObjective:\n${input.objective}\n\n${input.focus === undefined ? "" : `Optional focus:\n${input.focus}\n\n`}Frozen basic Project context:\n${JSON.stringify({ contextFields: input.brief.contextFields, materialCards: input.brief.materialCards, recordReferences: input.brief.recordReferences, sourceVersion: input.brief.sourceVersion })}\n\nIndependent Assessment handoff:\n${JSON.stringify(input.assessment)}\n\nOpen the critical discussion with the strongest current view, the most important tension with recalled prior judgment, and the question most likely to change the decision.`;
}

export function parseIndependentAssessment(message: string): IndependentAssessment {
  const trimmed = message.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)?.[1];
  const candidate = fenced ?? trimmed;
  try { return independentAssessmentSchema.parse(JSON.parse(candidate)); }
  catch { throw new Error("INVALID_INDEPENDENT_ASSESSMENT"); }
}

export interface BuildReflectionProjectBriefInput {
  readonly projectId: string;
  readonly context?: ProjectContextDocument | undefined;
  readonly materials: readonly MaterialInventoryItem[];
  readonly outputs: readonly ProjectOutputArtifact[];
  readonly now?: (() => Date) | undefined;
}

export function buildReflectionProjectBrief(input: BuildReflectionProjectBriefInput): ReflectionProjectBrief {
  const contextFields = projectSnapshotFields(input.context);
  const materialCards = input.materials.filter((material) => material.projectId === input.projectId && material.availability === "active").map((material) => ({
    materialId: material.id,
    displayName: basename(material.relativePath),
    mediaType: material.mediaType,
    size: material.size,
    modifiedAt: material.modifiedAt,
    parseStatus: material.parseStatus
  })).sort((left, right) => left.displayName.localeCompare(right.displayName) || left.materialId.localeCompare(right.materialId));
  const recordReferences = input.outputs.filter((output) => output.projectId === input.projectId).map((output) => ({
    kind: "output" as const,
    id: output.id,
    label: basename(output.relativePath),
    mediaType: output.mediaType,
    createdAt: output.createdAt
  })).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const sourceVersion = hash(JSON.stringify({
    projectId: input.projectId,
    contextHash: input.context?.sourceHash ?? "unavailable",
    materials: input.materials.map((material) => [material.id, material.sourceHash, material.availability, material.parseStatus]).sort(),
    outputs: input.outputs.map((output) => [output.id, output.createdAt]).sort()
  }));
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    sourceVersion,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    contextFields,
    materialCards,
    recordReferences
  };
}

export function reflectionFraming(text: string): "reflection" | "retrospective" {
  return /(后来|后续|实际结果|最终结果|进展|是否正确|是否成立|当时判断|复盘结果|outcome|subsequent|later evidence|proved (?:right|wrong)|held up|what happened)/iu.test(text) ? "retrospective" : "reflection";
}

function projectSnapshotFields(context: ProjectContextDocument | undefined): ReflectionProjectBrief["contextFields"] {
  const snapshot = context?.sections.find((section) => section.title === "Project Snapshot");
  if (snapshot === undefined) return [];
  const allowed = new Map([["sector", "Industry"], ["stage", "Financing stage"], ["current focus", "Current focus"]]);
  return snapshot.content.split(/\r?\n/gu).flatMap((line) => {
    const match = /^\s*[-*]\s*([^:：]+)[:：]\s*(.*?)\s*$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined || !match[2].trim()) return [];
    const id = match[1].trim().toLocaleLowerCase();
    const label = allowed.get(id);
    return label === undefined ? [] : [{ id: id.replace(/\s+/gu, "_"), label, value: match[2].trim().slice(0, 2_000) }];
  });
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
