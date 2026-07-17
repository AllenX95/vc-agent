import { describe, expect, it, vi } from "vitest";
import { PublicWebRecallSource, detectWebResearchIntent, retrievalTrajectorySummary, type PublicWebAccess } from "@vc-agent/host-services";
import { CapabilityGateway } from "@vc-agent/host-services";
import { CapabilityRegistry, createWebFetchCapability } from "@vc-agent/capabilities";

const context = { turnId: "turn-web", maxItems: 1, maxChars: 1_000, retrievedAt: "2026-07-17T08:00:00.000Z" };

function access(fetchImplementation: PublicWebAccess["fetch"], addresses: readonly string[] = ["93.184.216.34"]): PublicWebAccess {
  return { fetch: fetchImplementation, resolve: async () => addresses };
}

describe("public web recall", () => {
  it("preactivates only clear current-web intent", () => {
    expect(detectWebResearchIntent("Search the latest market news")).toBe(true);
    expect(detectWebResearchIntent("请联网查找最新行业资料")).toBe(true);
    expect(detectWebResearchIntent("Read https://example.com/report")).toBe(true);
    expect(detectWebResearchIntent("Analyze the supplied company materials")).toBe(false);
  });

  it("returns bounded search results with visible source metadata and omissions", async () => {
    const fetchMock = vi.fn<PublicWebAccess["fetch"]>(async (_input, init) => new Response(`
      <li class="b_algo"><h2><a href="https://example.com/a">Result A</a></h2><div class="b_caption"><p>Current evidence A</p></div></li>
      <li class="b_algo"><h2><a href="https://example.com/b">Result B</a></h2><div class="b_caption"><p>Current evidence B</p></div></li>
    `, { headers: { "content-type": "text/html" } }));
    const source = new PublicWebRecallSource(access(fetchMock));
    const result = await source.recall({ kind: "search", query: "market" }, context);

    expect(result.items[0]).toMatchObject({ url: "https://example.com/a", title: "Result A", accessedAt: context.retrievedAt, content: "Current evidence A" });
    expect(result.complete).toBe(false);
    expect(result.omittedItems).toBe(1);
    expect(result.contextReference).toMatchObject({ sourceClass: "web", originatingTool: "web_search", originatingTurnId: context.turnId });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
  });

  it("extracts public HTML without scripts, forms, or browser state", async () => {
    const source = new PublicWebRecallSource(access(async () => new Response(`
      <html><head><title>Company Update</title><script>secret()</script></head><body><nav>Menu</nav><main>Revenue increased. <form>Submit private data</form></main></body></html>
    `, { headers: { "content-type": "text/html; charset=utf-8" } })));
    const result = await source.recall({ kind: "fetch", url: "https://example.com/update" }, context);

    expect(result.items[0]).toMatchObject({ url: "https://example.com/update", title: "Company Update", accessedAt: context.retrievedAt, content: "Revenue increased." });
    expect(JSON.stringify(result)).not.toContain("secret()");
    expect(JSON.stringify(result)).not.toContain("Submit private data");
  });

  it("extracts bounded text from a public PDF in memory", async () => {
    const source = new PublicWebRecallSource(access(async () => new Response(minimalPdf("Public PDF evidence"), { headers: { "content-type": "application/pdf" } })));
    const result = await source.recall({ kind: "fetch", url: "https://example.com/report.pdf" }, context);
    expect(result.items[0]?.content).toContain("Public PDF evidence");
    expect(result.contextReference.sourceRange).toBe("pages 1-1");
  });

  it("blocks private destinations and private redirect targets before content access", async () => {
    const directFetch = vi.fn<PublicWebAccess["fetch"]>();
    const direct = new PublicWebRecallSource(access(directFetch, ["127.0.0.1"]));
    const blocked = await direct.recall({ kind: "fetch", url: "http://localhost/admin" }, context);
    expect(blocked.items).toEqual([]);
    expect(blocked.warnings[0]).toContain("non-public");
    expect(directFetch).not.toHaveBeenCalled();

    const redirectFetch = vi.fn<PublicWebAccess["fetch"]>(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    const redirectAccess: PublicWebAccess = {
      fetch: redirectFetch,
      resolve: async (hostname) => hostname === "example.com" ? ["93.184.216.34"] : ["127.0.0.1"]
    };
    const redirected = await new PublicWebRecallSource(redirectAccess).recall({ kind: "fetch", url: "https://example.com/redirect" }, context);
    expect(redirected.items).toEqual([]);
    expect(redirectFetch).toHaveBeenCalledTimes(1);
  });

  it("never retains credentials embedded in a rejected URL", async () => {
    const source = new PublicWebRecallSource(access(vi.fn<PublicWebAccess["fetch"]>()));
    const result = await source.recall({ kind: "fetch", url: "https://user:secret@example.com/private" }, context);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.contextReference.sourceId).toMatch(/^search:/u);
  });

  it("runs a registered public network read in Standard Access without confirmation", async () => {
    const registry = new CapabilityRegistry();
    registry.register(createWebFetchCapability(async (_input, capabilityContext) => ({
      body: "bounded public body",
      retrieval: {
        payloadId: crypto.randomUUID(),
        retention: "turn_scoped",
        bodyBytes: 19,
        contextReference: {
          schemaVersion: 1,
          sourceClass: "web",
          sourceId: "https://example.com/",
          label: "Example",
          sourceRange: "document",
          originatingTool: "web_fetch",
          originatingTurnId: capabilityContext.request.turnId,
          retrievedAt: context.retrievedAt,
          status: "active"
        }
      }
    })));
    const gateway = new CapabilityGateway(registry);
    const decision = await gateway.request({
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      threadId: "thread-web",
      turnId: context.turnId,
      toolCallId: "tool-web",
      capabilityId: "web_fetch",
      scope: { kind: "unscoped", threadId: "thread-web" },
      arguments: { url: "https://example.com/" },
      expectedStateVersion: 1,
      actor: { actorType: "agent", actorId: "primary-agent" },
      provenance: { producerType: "agent", producerId: "primary-agent" }
    }, {
      accessMode: "standard",
      scope: "unscoped",
      stateVersion: 1,
      activeCapabilityIds: ["web_fetch"],
      outputIntent: false
    });
    expect(decision).toMatchObject({ type: "result", result: { status: "completed", retrieval: { retention: "turn_scoped" } } });
  });

  it("persists citation metadata but not fetched web body", () => {
    const content = JSON.stringify({
      items: [{ url: "https://example.com/", title: "Example", accessedAt: context.retrievedAt, content: "NON_DURABLE_WEB_BODY" }],
      warnings: ["bounded"]
    });
    const summary = retrievalTrajectorySummary({
      schemaVersion: 1,
      requestId: "web-summary",
      status: "completed",
      content,
      retrieval: {
        payloadId: crypto.randomUUID(),
        retention: "turn_scoped",
        bodyBytes: content.length,
        contextReference: {
          schemaVersion: 1,
          sourceClass: "web",
          sourceId: "https://example.com/",
          label: "Example",
          sourceRange: "document",
          originatingTool: "web_fetch",
          originatingTurnId: context.turnId,
          retrievedAt: context.retrievedAt,
          status: "active"
        }
      }
    });
    expect(summary).toContain("https://example.com/");
    expect(summary).toContain("bounded");
    expect(summary).not.toContain("NON_DURABLE_WEB_BODY");
  });
});

function minimalPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(new TextEncoder().encode(pdf).byteLength);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = new TextEncoder().encode(pdf).byteLength;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}
