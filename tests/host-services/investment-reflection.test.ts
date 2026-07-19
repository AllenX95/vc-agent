import { describe, expect, it } from "vitest";
import { MEMORY_AWARE_REFLECTION_INSTRUCTIONS, buildIndependentEvidencePrompt, buildMemoryAwareReflectionPrompt, buildReflectionProjectBrief, buildReflectionUnscopedBrief, parseIndependentAssessment, reflectionFraming } from "@vc-agent/host-services";

describe("Reflection Project Brief", () => {
  it("contains bounded navigation metadata without paths, Memory, material bodies, or prior conclusions", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const brief = buildReflectionProjectBrief({
      projectId,
      now: () => new Date("2026-07-19T08:00:00.000Z"),
      context: {
        schemaVersion: 1, projectId, markdownPath: "outputs/system/project-context.md", mirrorPath: "outputs/system/project-context.json", sourceHash: "a".repeat(64), updatedAt: "2026-07-19T07:00:00.000Z", warnings: [], content: "Company: Secret Co\nPrior conclusion: invest",
        sections: [{ id: "project-snapshot", title: "Project Snapshot", content: "- Project: Secret Project\n- Company: Secret Co\n- Sector: Industrial software\n- Stage: Series A\n- Current Focus: Validate customer retention", startLine: 1, endLine: 6 }]
      },
      materials: [{ id: "22222222-2222-4222-8222-222222222222", projectId, relativePath: "confidential/data-room/secret-memo.pdf", extension: ".pdf", mediaType: "application/pdf", size: 42, modifiedAt: "2026-07-18T08:00:00.000Z", sourceHash: "b".repeat(64), parseStatus: "unparsed", parsedVersionCount: 0, availability: "active" }],
      outputs: [{ schemaVersion: 1, id: "output-1", projectId, mediaType: "text/markdown", destination: "C:\\project\\outputs\\analysis\\memo.md", relativePath: "analysis/memo.md", producer: { type: "agent", id: "primary-agent" }, source: { threadId: "thread-1", turnId: "turn-1", capabilityRequestId: "request-1" }, profile: { id: "profile-1", provider: "fixture", model: "fixture" }, capabilityId: "output.write", sourceReferences: [], warnings: [], relatedArtifacts: [], createdAt: "2026-07-19T07:30:00.000Z" }]
    });
    expect(brief.contextFields).toEqual([
      { id: "sector", label: "Industry", value: "Industrial software" },
      { id: "stage", label: "Financing stage", value: "Series A" },
      { id: "current_focus", label: "Current focus", value: "Validate customer retention" }
    ]);
    expect(brief.materialCards).toMatchObject([{ displayName: "secret-memo.pdf", parseStatus: "unparsed" }]);
    expect(brief.recordReferences).toMatchObject([{ kind: "output", id: "output-1", label: "memo.md" }]);
    const payload = JSON.stringify(brief);
    expect(payload).not.toContain("confidential/data-room");
    expect(payload).not.toContain("C:\\project");
    expect(payload).not.toContain("Secret Co");
    expect(payload).not.toContain("Prior conclusion");
    expect(payload).not.toMatch(/Project Memory|Long-term Memory|sourceReferences|destination|relativePath/u);
  });

  it("classifies retrospective framing only from later evidence or outcomes", () => {
    expect(reflectionFraming("Review this Project")).toBe("reflection");
    expect(reflectionFraming("复盘这个项目当前的投资判断")).toBe("reflection");
    expect(reflectionFraming("结合后续进展复盘当时判断是否成立")).toBe("retrospective");
    expect(reflectionFraming("Did the original thesis hold up after later evidence?")).toBe("retrospective");
  });

  it("builds an Unscoped brief from bounded User inputs without Project identity", () => {
    const brief = buildReflectionUnscopedBrief({
      sourceThreadId: "source-thread",
      now: () => new Date("2026-07-19T08:00:00.000Z"),
      userInputs: Array.from({ length: 14 }, (_, index) => ({ turnId: `turn-${index}`, text: `Investment claim ${index}` }))
    });
    expect(brief).toMatchObject({ scope: "unscoped", sourceThreadId: "source-thread" });
    expect(brief.userInputs[0]).toEqual({ turnId: "turn-2", text: "Investment claim 2" });
    expect(brief.userInputs).toHaveLength(12);
    expect(JSON.stringify(brief)).not.toMatch(/projectId|Project Context|Project Memory|path/iu);
    const prompt = buildMemoryAwareReflectionPrompt({
      objective: "Review this question",
      brief,
      assessment: { schemaVersion: 1, conclusion: "Unresolved", rationale: [], uncertainties: [], counterarguments: [], evidenceReferences: [], decisionChangingQuestions: [], createdAt: "2026-07-19T09:00:00.000Z" }
    });
    expect(prompt).toContain("Project Memory and Project State are forbidden");
    expect(prompt).not.toContain("projectId");
  });

  it("builds a bounded stage prompt and accepts only the structured assessment contract", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const brief = { schemaVersion: 1 as const, scope: "project" as const, projectId, sourceVersion: "a".repeat(64), createdAt: "2026-07-19T08:00:00.000Z", contextFields: [], materialCards: [], recordReferences: [] };
    const prompt = buildIndependentEvidencePrompt({ objective: "Review this Project", brief, createdAt: "2026-07-19T09:00:00.000Z" });
    expect(prompt).toContain("Frozen Reflection Project Brief");
    expect(prompt).not.toMatch(/Project Memory|Long-term Memory|local-memory-provenance/iu);
    const assessment = { schemaVersion: 1, conclusion: "Continue diligence.", rationale: ["Evidence is bounded."], uncertainties: [], counterarguments: [], evidenceReferences: [], decisionChangingQuestions: ["Does retention hold?"], createdAt: "2026-07-19T09:00:00.000Z" };
    expect(parseIndependentAssessment(`\`\`\`json\n${JSON.stringify(assessment)}\n\`\`\``)).toEqual(assessment);
    expect(() => parseIndependentAssessment("Continue diligence, probably.")).toThrow("INVALID_INDEPENDENT_ASSESSMENT");
  });

  it("hands only the bounded assessment and basic brief into the critical dialogue", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const prompt = buildMemoryAwareReflectionPrompt({
      objective: "Review this Project",
      brief: { schemaVersion: 1, scope: "project", projectId, sourceVersion: "d".repeat(64), createdAt: new Date().toISOString(), contextFields: [{ id: "stage", label: "Financing stage", value: "Series A" }], materialCards: [], recordReferences: [] },
      assessment: { schemaVersion: 1, conclusion: "Retention is uncertain.", rationale: ["Cohorts are immature."], uncertainties: ["Selection bias"], counterarguments: ["Expansion may offset churn."], evidenceReferences: [], decisionChangingQuestions: ["Does month-six retention hold?"], createdAt: new Date().toISOString() }
    });
    expect(prompt).toContain("Independent Assessment handoff");
    expect(prompt).toContain("Series A");
    expect(prompt).not.toMatch(/material body|first-stage transcript|hidden reasoning/iu);
    expect(MEMORY_AWARE_REFLECTION_INSTRUCTIONS).toContain("Memory is challengeable historical judgment");
    expect(MEMORY_AWARE_REFLECTION_INSTRUCTIONS).toContain("reflection_evidence_drilldown");
    expect(MEMORY_AWARE_REFLECTION_INSTRUCTIONS).toContain("exact referenced source block and content version");
    expect(MEMORY_AWARE_REFLECTION_INSTRUCTIONS).toContain("cannot browse a Material");
  });
});
