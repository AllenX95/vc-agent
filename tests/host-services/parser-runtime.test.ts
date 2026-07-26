import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveParserPython } from "../../apps/utility-worker/src/python-runtime";

describe("parser Python runtime resolution", () => {
  it("prefers an explicit executable over every other source", () => {
    expect(resolveParserPython({ executable: "C:/configured/parser.exe", runtimeRoot: "C:/runtime", environment: { VC_AGENT_PYTHON: "C:/env/parser.exe" }, platform: "win32" })).toBe("C:/configured/parser.exe");
  });

  it("uses VC_AGENT_PYTHON before the deployed runtime", () => {
    expect(resolveParserPython({ runtimeRoot: "C:/runtime", environment: { VC_AGENT_PYTHON: "C:/env/parser.exe" }, platform: "win32" })).toBe("C:/env/parser.exe");
  });

  it("prefers the deployed parser venv when explicit configuration is absent", () => {
    const runtimeRoot = process.env.VC_AGENT_OCR_RUNTIME_ROOT;
    const expected = runtimeRoot === undefined ? undefined : join(runtimeRoot, process.platform === "win32" ? "venv\\Scripts\\python.exe" : "venv/bin/python");
    const resolved = resolveParserPython({ environment: runtimeRoot === undefined ? {} : { VC_AGENT_OCR_RUNTIME_ROOT: runtimeRoot }, platform: process.platform });
    if (expected !== undefined && existsSync(expected)) expect(resolved).toBe(expected);
    else expect(resolved).toBe("python");
  });

  it("falls back to python when no configured runtime exists", () => {
    expect(resolveParserPython({ environment: {}, runtimeRoot: "C:/missing-runtime", platform: "win32" })).toBe("python");
  });
});
