import { describe, expect, it } from "vitest";
import { gateExitCode } from "@vc-agent/host-services";

describe("gate command exit policy", () => {
  it("keeps blocked dependency diagnostics non-failing by default", () => {
    expect(gateExitCode("blocked", false)).toBe(0);
    expect(gateExitCode("pass", false)).toBe(0);
    expect(gateExitCode("fail", false)).toBe(1);
  });

  it("fails closed for blocked release gates", () => {
    expect(gateExitCode("blocked", true)).toBe(1);
    expect(gateExitCode("fail", true)).toBe(1);
    expect(gateExitCode("pass", true)).toBe(0);
  });
});
