import { describe, expect, it } from "vitest";
import { academicWorkflowPrototype } from "@vc-agent/host-services";

describe("academic Prompt-first workflow prototypes", () => {
  it.each([
    ["请对这篇论文做一次论文技术尽调", "paper-technical-diligence"],
    ["评价创始人的学术能力和研究独立性", "founder-academic-diligence"],
    ["核验公司全球首个和 SOTA 的技术宣称", "technical-claim-verification"],
    ["生成该技术的原创性和前序工作图谱", "novelty-and-prior-art-map"],
    ["从这篇论文寻找疑似产业化主体和公司", "research-to-company-map"]
  ] as const)("selects %s", (prompt, expected) => {
    const workflow = academicWorkflowPrototype(prompt);
    expect(workflow?.id).toBe(expected);
    expect(workflow?.instructions).toContain("academic_research");
    expect(workflow?.instructions).toContain("arXiv");
  });

  it("does not impose a workflow on an ordinary paper search", () => {
    expect(academicWorkflowPrototype("搜索 memory native model 论文")).toBeUndefined();
  });
});

