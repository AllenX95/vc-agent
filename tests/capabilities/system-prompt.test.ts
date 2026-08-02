import { describe, expect, it } from "vitest";
import { SHIPPED_MINIMAL_VC_SYSTEM_PROMPT, estimateTokens } from "@vc-agent/host-services";

describe("Minimal VC System Prompt", () => {
  it("contains exactly the six scope-neutral responsibility classes", () => {
    const lines = SHIPPED_MINIMAL_VC_SYSTEM_PROMPT.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines.map((line) => line.match(/^\d+\. ([^:]+):/)?.[1])).toEqual([
      "VC identity",
      "Independent judgment",
      "Evidence discipline",
      "Memory status",
      "Context discipline",
      "Action boundary"
    ]);
    expect(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT).not.toMatch(/project name|project path|provider configuration|document template/i);
    expect(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT).toMatch(/decision-relevant view/i);
    expect(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT).toMatch(/investment thesis.*strongest counter-case.*falsifiers/i);
    expect(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT).toMatch(/company or management claims/i);
    expect(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT).toMatch(/never invent facts, citations, or false precision/i);
    expect(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT).toMatch(/never claim unread or omitted content was reviewed/i);
    expect(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT).toMatch(/material_recall.*cards.*Project.*file/i);
    expect(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT).toMatch(/do not substitute public web/i);
    expect(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT).toMatch(/file_download.*arxiv\.fulltext.*workspace\.write_batch.*Standard Access.*scoped approval/i);
    expect(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT).toMatch(/edit existing text Outputs via diff-and-confirm/i);
    expect(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT).toMatch(/never to write files.*duplicate available OCR/i);
    expect(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT).toMatch(/Do not take durable or external action beyond explicit User intent/i);
    expect(estimateTokens(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT)).toBeGreaterThan(0);
    expect(estimateTokens(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT)).toBeLessThan(1_000);
  });
});
