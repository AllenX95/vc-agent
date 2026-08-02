import { describe, expect, it } from "vitest";
import { CitationRegistry } from "@vc-agent/host-services";

describe("turn-scoped citation registry", () => {
  it("annotates bounded web results with Host-owned source IDs", () => {
    const registry = new CitationRegistry();
    const result = registry.annotateCapabilityResult({
      schemaVersion: 1,
      requestId: "request-citation",
      status: "completed",
      content: JSON.stringify({
        sourceClass: "web",
        items: [
          { url: "https://example.com/report", title: "Report", accessedAt: "2026-08-02T00:00:00.000Z", content: "Evidence" }
        ],
        warnings: []
      }),
      retrieval: {
        payloadId: crypto.randomUUID(),
        retention: "turn_scoped",
        bodyBytes: 100,
        contextReference: {
          schemaVersion: 1,
          sourceClass: "web",
          sourceId: "https://example.com/report",
          label: "Report",
          sourceRange: "document",
          originatingTool: "web_fetch",
          originatingTurnId: "turn-citation",
          retrievedAt: "2026-08-02T00:00:00.000Z",
          status: "active"
        }
      }
    }, { capabilityId: "web_fetch", toolCallId: "tool-citation" });

    expect(JSON.parse(result.content).items[0].citationId).toBe("S1");
    expect(registry.manifest).toEqual([expect.objectContaining({ id: "S1", url: "https://example.com/report", title: "Report", originatingTool: "web_fetch", toolCallId: "tool-citation" })]);
  });

  it("links inline source markers and appends a deterministic source list", () => {
    const registry = new CitationRegistry();
    registry.annotateCapabilityResult({
      schemaVersion: 1,
      requestId: "request-citation",
      status: "completed",
      content: JSON.stringify({ items: [{ url: "https://example.com/a", title: "Example A", accessedAt: "2026-08-02T00:00:00.000Z" }] }),
      retrieval: {
        payloadId: crypto.randomUUID(),
        retention: "turn_scoped",
        bodyBytes: 20,
        contextReference: {
          schemaVersion: 1,
          sourceClass: "web",
          sourceId: "https://example.com/a",
          label: "Example A",
          sourceRange: "search-results",
          originatingTool: "web_search",
          originatingTurnId: "turn-citation",
          retrievedAt: "2026-08-02T00:00:00.000Z",
          status: "active"
        }
      }
    }, { capabilityId: "web_search", toolCallId: "tool-citation" });

    const formatted = registry.formatAssistantMessage("The claim is supported [S1] and [S1](<https://fake.example>). [S99](<https://fake.example/unknown>)");
    expect(formatted.message).toContain("[S1](<https://example.com/a>)");
    expect(formatted.message).not.toContain("fake.example");
    expect(formatted.message).toContain("### 参考来源");
    expect(formatted.message).toContain("Example A");
    expect(formatted.message).toContain("https://example.com/a");
    expect(formatted.citations).toHaveLength(1);
  });
});
