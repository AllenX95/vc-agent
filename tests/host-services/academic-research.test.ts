import { describe, expect, it } from "vitest";
import { createAcademicResearchCapability, createTurnCapabilitySurface } from "@vc-agent/capabilities";
import type { AcademicResearchResult, CapabilityExecutionRequest } from "@vc-agent/contracts";
import {
  AcademicResearchService,
  type AcademicHttpAccess,
  type AcademicSourceAdapter
} from "@vc-agent/host-services";

class FixtureHttp implements AcademicHttpAccess {
  readonly calls: string[] = [];
  async request(input: { readonly url: string }): Promise<{
    url: string;
    status: number;
    headers: Headers;
    body: Uint8Array;
    text(): string;
    json(): unknown;
  }> {
    this.calls.push(input.url);
    const url = new URL(input.url);
    let body: string;
    if (url.hostname === "api.openalex.org") {
      body = JSON.stringify({
        meta: { count: 1 },
        results: [{
          id: "https://openalex.org/W123",
          title: "Memory Native Models",
          publication_date: "2026-01-10",
          doi: "https://doi.org/10.1000/memory",
          ids: { arxiv: "https://arxiv.org/abs/2601.01234" },
          cited_by_count: 7,
          referenced_works: [],
          authorships: [{ author: { id: "https://openalex.org/A1", display_name: "Ada Researcher" }, institutions: [] }],
          topics: [{ display_name: "Artificial intelligence" }],
          primary_location: { landing_page_url: "https://openalex.org/W123" }
        }]
      });
    } else if (url.hostname === "export.arxiv.org") {
      body = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
        <entry>
          <id>https://arxiv.org/abs/2601.01234v2</id>
          <updated>2026-02-01T00:00:00Z</updated>
          <published>2026-01-10T00:00:00Z</published>
          <title>Memory Native Models</title>
          <summary>A memory-native architecture.</summary>
          <author><name>Ada Researcher</name></author>
          <arxiv:doi>10.1000/memory</arxiv:doi>
          <category term="cs.AI"/>
          <link href="https://arxiv.org/pdf/2601.01234" type="application/pdf"/>
        </entry>
      </feed>`;
    } else if (url.hostname === "api.github.com") {
      body = JSON.stringify({
        total_count: 1,
        items: [{
          full_name: "lab/memory-native",
          html_url: "https://github.com/lab/memory-native",
          private: false,
          description: "Official code for arXiv 2601.01234",
          stargazers_count: 100,
          forks_count: 10,
          topics: ["ai"]
        }]
      });
    } else {
      body = JSON.stringify([{
        id: "lab/memory-native",
        private: false,
        gated: false,
        downloads: 500,
        likes: 20,
        tags: ["text-generation"],
        lastModified: "2026-02-10T00:00:00Z"
      }]);
    }
    const bytes = new TextEncoder().encode(body);
    return { url: input.url, status: 200, headers: new Headers({ "content-type": url.hostname === "export.arxiv.org" ? "application/atom+xml" : "application/json" }), body: bytes, text: () => body, json: () => JSON.parse(body) as unknown };
  }
}

describe("AcademicResearchService", () => {
  it("merges OpenAlex and arXiv records by DOI while retaining both source records", async () => {
    const http = new FixtureHttp();
    const service = new AcademicResearchService({ http, arxivMinimumIntervalMs: 0 });
    const result = await service.execute({
      operation: "search",
      queries: ["memory native models"],
      targets: ["works"],
      limit: 10,
      maxChars: 8_000
    }, { turnId: "turn-1", credentials: { openalex: "fixture-key" }, retrievedAt: "2026-07-28T00:00:00.000Z" });

    expect(result.status).toBe("completed");
    expect(result.entities).toHaveLength(1);
    const work = result.entities[0];
    expect(work?.type).toBe("work");
    if (work?.type !== "work") throw new Error("Expected work");
    expect(work.identifiers).toMatchObject({ doi: "10.1000/memory", arxiv: "2601.01234", openalex: "W123" });
    expect(work.sourceRecords.map((record) => record.source).sort()).toEqual(["arxiv", "openalex"]);
    expect(work.publicationStatus).toBe("indexed_publication");
  });

  it("returns partial results when one selected source is unavailable", async () => {
    const service = new AcademicResearchService({ http: new FixtureHttp(), arxivMinimumIntervalMs: 0 });
    const result = await service.execute({
      operation: "search",
      queries: ["memory native models"],
      targets: ["works"],
      sources: ["openalex", "arxiv"],
      limit: 10,
      maxChars: 8_000
    }, { turnId: "turn-1", retrievedAt: "2026-07-28T00:00:00.000Z" });
    expect(result.status).toBe("partial");
    expect(result.entities.some((entity) => entity.type === "work")).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "OPENALEX_CREDENTIAL_REQUIRED")).toBe(true);
  });

  it("searches GitHub and Hugging Face without exposing source-specific raw payloads", async () => {
    const service = new AcademicResearchService({ http: new FixtureHttp(), arxivMinimumIntervalMs: 0 });
    const github = await service.execute({
      operation: "search",
      queries: ["memory native"],
      targets: ["repositories"],
      sources: ["github"],
      limit: 5,
      maxChars: 4_000
    }, { turnId: "turn-1", retrievedAt: "2026-07-28T00:00:00.000Z" });
    const hf = await service.execute({
      operation: "search",
      queries: ["memory native"],
      targets: ["models"],
      sources: ["huggingface"],
      limit: 5,
      maxChars: 4_000
    }, { turnId: "turn-1", retrievedAt: "2026-07-28T00:00:00.000Z" });
    expect(github.entities[0]?.type).toBe("github_repository");
    expect(hf.entities[0]?.type).toBe("hf_model");
    expect(JSON.stringify(github)).not.toContain("stargazers_count");
    expect(JSON.stringify(hf)).not.toContain("lastModified");
  });

  it("links an artifact only when returned evidence contains a paper identifier or title", async () => {
    const service = new AcademicResearchService({ http: new FixtureHttp(), arxivMinimumIntervalMs: 0 });
    const result = await service.execute({
      operation: "link_artifacts",
      identifier: { kind: "title", value: "Memory Native Models" },
      sources: ["openalex", "arxiv", "github"],
      limit: 10,
      maxChars: 8_000
    }, { turnId: "turn-1", credentials: { openalex: "fixture-key" }, retrievedAt: "2026-07-28T00:00:00.000Z" });
    expect(result.edges).toContainEqual(expect.objectContaining({ relation: "artifact_of", confidence: "high" }));
  });

  it("treats an unsupported request as unavailable rather than inventing data", async () => {
    const none: AcademicSourceAdapter = {
      source: "openalex",
      supports: () => false,
      execute: async () => { throw new Error("not called"); }
    };
    const service = new AcademicResearchService({ adapters: [none] });
    const result = await service.execute({
      operation: "inspect",
      identifier: { kind: "github", value: "owner/repo" },
      targets: ["repositories"],
      sources: ["openalex"],
      limit: 5,
      maxChars: 4_000
    }, { turnId: "turn-1", retrievedAt: "2026-07-28T00:00:00.000Z" });
    expect(result.status).toBe("unavailable");
    expect(result.warnings[0]?.code).toBe("ACADEMIC_OPERATION_UNSUPPORTED");
  });
});

describe("academic_research capability", () => {
  it("returns an academic turn-scoped retrieval reference", async () => {
    const fixture: AcademicResearchResult = {
      schemaVersion: 1,
      runId: "11111111-1111-4111-8111-111111111111",
      operation: "search",
      status: "completed",
      entities: [],
      edges: [],
      evidence: [],
      omittedItems: 0,
      warnings: [],
      sourceStatus: [],
      contextReference: {
        sourceId: "academic:fixture",
        label: "Fixture",
        sourceRange: "0 entities",
        contentVersion: "fixture-v1",
        retrievedAt: "2026-07-28T00:00:00.000Z"
      }
    };
    const capability = createAcademicResearchCapability(async () => fixture);
    const request: CapabilityExecutionRequest = {
      schemaVersion: 1,
      requestId: "request-1",
      correlationId: "correlation-1",
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "tool-1",
      capabilityId: "academic_research",
      scope: { kind: "unscoped", threadId: "thread-1" },
      arguments: {},
      expectedStateVersion: 1,
      actor: { actorType: "agent", actorId: "primary" },
      provenance: { producerType: "agent", producerId: "primary" }
    };
    const result = await capability.execute({ operation: "search", queries: ["test"], limit: 10, maxChars: 8_000 }, { request, accessMode: "standard" });
    expect(result.retrieval?.contextReference.sourceClass).toBe("academic");
    expect(result.retrieval?.retention).toBe("turn_scoped");
  });

  it("is requestable on demand and becomes visible when hinted", () => {
    const metadata = createAcademicResearchCapability(async () => { throw new Error("not executed"); }).metadata;
    const hidden = createTurnCapabilitySurface({ kind: "ordinary", scope: "unscoped", inventory: [metadata] });
    const hinted = createTurnCapabilitySurface({ kind: "ordinary", scope: "unscoped", inventory: [metadata], preloadHints: ["academic_research"] });
    expect(hidden.visibleCapabilityIds).not.toContain("academic_research");
    expect(hidden.requestableCatalog.map((entry) => entry.id)).toContain("academic_research");
    expect(hinted.visibleCapabilityIds).toContain("academic_research");
  });
});
