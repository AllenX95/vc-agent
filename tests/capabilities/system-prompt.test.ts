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
    expect(estimateTokens(SHIPPED_MINIMAL_VC_SYSTEM_PROMPT)).toBeGreaterThan(0);
  });
});
