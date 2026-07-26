import { describe, expect, it } from "vitest";
import { SubAgentContextCompiler } from "@vc-agent/host-services";

describe("SubAgentContextCompiler", () => {
  it("hydrates only explicitly referenced sources and freezes a bounded hash", async () => {
    const compiler = new SubAgentContextCompiler({
      resolve: async ({ referenceId }) => referenceId === "material:1" ? { source: "material", content: "A bounded fact." } : undefined
    });
    const bundle = await compiler.compile({ scope: "project", projectId: "11111111-1111-4111-8111-111111111111", sourceReferenceIds: ["material:1", "material:missing"], maxChars: 100 });
    expect(bundle.entries).toEqual([{ referenceId: "material:1", source: "material", content: "A bounded fact." }]);
    expect(bundle.omittedReferenceIds).toEqual(["material:missing"]);
    expect(bundle.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not allow a resolver to exceed the boundary character budget", async () => {
    const compiler = new SubAgentContextCompiler({ resolve: async () => ({ source: "fixture", content: "1234567890" }) });
    const bundle = await compiler.compile({ scope: "unscoped", sourceReferenceIds: ["one", "two"], maxChars: 7 });
    expect(bundle.entries[0]?.content).toBe("1234567");
    expect(bundle.omittedReferenceIds).toEqual(["one", "two"]);
    expect(bundle.entries.reduce((sum, entry) => sum + entry.content.length, 0)).toBe(7);
  });
});
