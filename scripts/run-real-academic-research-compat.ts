import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AcademicResearchService } from "@vc-agent/host-services";
import type { AcademicResearchRequest, AcademicSource } from "@vc-agent/contracts";

interface Scenario {
  readonly id: string;
  readonly source: AcademicSource;
  readonly request: AcademicResearchRequest;
  readonly credential?: string;
}

const scenarios: Scenario[] = [
  {
    id: "arxiv-search",
    source: "arxiv",
    request: { operation: "search", queries: ["transformer architecture"], targets: ["works"], sources: ["arxiv"], sort: "recent", limit: 3, maxChars: 4_000 }
  },
  {
    id: "github-search",
    source: "github",
    request: { operation: "search", queries: ["transformer architecture"], targets: ["repositories"], sources: ["github"], sort: "popularity", limit: 3, maxChars: 4_000 },
    credential: process.env.GITHUB_TOKEN
  },
  {
    id: "huggingface-search",
    source: "huggingface",
    request: { operation: "search", queries: ["transformer"], targets: ["models"], sources: ["huggingface"], sort: "popularity", limit: 3, maxChars: 4_000 },
    credential: process.env.HF_TOKEN
  },
  ...(process.env.OPENALEX_API_KEY === undefined ? [] : [{
    id: "openalex-search",
    source: "openalex" as const,
    request: { operation: "search" as const, queries: ["transformer architecture"], targets: ["works" as const], sources: ["openalex" as const], sort: "citations" as const, limit: 3, maxChars: 4_000 },
    credential: process.env.OPENALEX_API_KEY
  }])
];

async function main(): Promise<void> {
  const service = new AcademicResearchService();
  const results = [];
  for (const scenario of scenarios) {
    const startedAt = Date.now();
    const result = await service.execute(scenario.request, {
      turnId: `compat-${scenario.id}`,
      ...(scenario.credential === undefined ? {} : { credentials: { [scenario.source]: scenario.credential } })
    });
    results.push({
      id: scenario.id,
      source: scenario.source,
      status: result.status,
      entityCount: result.entities.length,
      edgeCount: result.edges.length,
      evidenceCount: result.evidence.length,
      warningCodes: result.warnings.map((warning) => warning.code),
      sourceStatus: result.sourceStatus,
      durationMs: Date.now() - startedAt
    });
  }

  const outputRoot = resolve(process.env.VC_AGENT_COMPAT_OUTPUT_DIR ?? join(process.env.LOCALAPPDATA ?? tmpdir(), "vc-agent", "compatibility"));
  mkdirSync(outputRoot, { recursive: true });
  const outputPath = join(outputRoot, `academic-research-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    credentials: {
      openalex: process.env.OPENALEX_API_KEY === undefined ? "not_configured" : "configured",
      github: process.env.GITHUB_TOKEN === undefined ? "not_configured" : "configured",
      huggingface: process.env.HF_TOKEN === undefined ? "not_configured" : "configured"
    },
    results
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: results.some((result) => result.status !== "unavailable") ? "pass" : "fail", outputPath, results }, null, 2)}\n`);
  if (results.every((result) => result.status === "unavailable")) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
