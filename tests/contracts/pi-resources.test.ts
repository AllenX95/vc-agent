import { describe, expect, it } from "vitest";
import {
  piResourceDiagnosticSchema,
  piResourcesSettingsStateSchema,
  type PiResourcesSettingsState
} from "@vc-agent/contracts";

function stateFixture(): PiResourcesSettingsState {
  return {
    schemaVersion: 1,
    generation: 3,
    reloadPending: false,
    extensions: {
      status: "ready",
      directoryPath: "C:/Users/example/AppData/Local/VC Agent/pi/extensions",
      loadedCount: 2,
      projectResourcesTrusted: false,
      diagnostics: [],
      trustDisclosure: "Extensions are trusted Worker Code with the Agent Worker process authority."
    },
    mcp: {
      status: "attention",
      configPath: "C:/Users/example/AppData/Local/VC Agent/pi/mcp.json",
      serverCount: 1,
      connectedServerCount: 0,
      diagnostics: [{ type: "warning", source: "mcp", message: "Server is disconnected" }],
      trustDisclosure: "Listing a server in this configuration trusts the server as a set."
    },
    skills: {
      status: "ready",
      directoryPath: "C:/Users/example/AppData/Local/VC Agent/pi/skills",
      loadedCount: 4,
      items: [{ id: "fixture/SKILL.md", name: "fixture", description: "Fixture Skill", relativePath: "fixture/SKILL.md", enabled: true }],
      diagnostics: [],
      trustDisclosure: "Skills are loaded from the dedicated VC Agent directory.",
      sourceIsolationDisclosure: "Other Pi, Codex, Claude Code, and project Skill roots are ignored."
    },
    diagnostics: [{ type: "warning", source: "mcp", message: "Server is disconnected" }]
  };
}

describe("Pi resource settings contract", () => {
  it("accepts read-only state without governance fields or secrets", () => {
    const parsed = piResourcesSettingsStateSchema.parse(stateFixture());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.mcp.serverCount).toBe(1);
    expect(JSON.stringify(parsed)).not.toContain("credential");
    expect(JSON.stringify(parsed)).not.toContain("actionClass");
    expect(JSON.stringify(parsed)).not.toContain("revision");
  });

  it("keeps diagnostics bounded and rejects empty messages", () => {
    expect(piResourceDiagnosticSchema.parse({ type: "collision", source: "extension", message: "duplicate tool" })).toMatchObject({
      type: "collision",
      source: "extension"
    });
    expect(() => piResourceDiagnosticSchema.parse({ type: "error", source: "runtime", message: "" })).toThrow();
    expect(() => piResourceDiagnosticSchema.parse({ type: "error", source: "runtime", message: "x".repeat(1_201) })).toThrow();
  });
});
