import { describe, expect, it } from "vitest";
import { testEnvironment } from "../e2e/test-environment";

describe("desktop E2E environment", () => {
  it("does not inherit VC_AGENT settings unless a test explicitly opts in", () => {
    const original = process.env.VC_AGENT_REAL_OCR;
    process.env.VC_AGENT_REAL_OCR = "1";
    try {
      const environment = testEnvironment({ VC_AGENT_TEST_PROJECT_PATH: "C:/fixture-project" });
      expect(environment.VC_AGENT_REAL_OCR).toBeUndefined();
      expect(environment.VC_AGENT_PYTHON).toBeDefined();
      expect(environment.VC_AGENT_TEST_PROJECT_PATH).toBe("C:/fixture-project");
      expect(environment.NODE_ENV).toBe("test");
    } finally {
      if (original === undefined) delete process.env.VC_AGENT_REAL_OCR;
      else process.env.VC_AGENT_REAL_OCR = original;
    }
  });
});
