import { randomUUID } from "node:crypto";
import {
  academicResearchRequestSchema,
  type AcademicResearchRequest,
  type AcademicResearchResult,
  type CapabilityExecutionResult
} from "@vc-agent/contracts";
import type { CapabilityDefinition } from "./index.js";

export type AcademicResearchExecutor = (
  input: AcademicResearchRequest,
  context: Parameters<CapabilityDefinition["execute"]>[1]
) => Promise<AcademicResearchResult>;

export function createAcademicResearchCapability(executeResearch: AcademicResearchExecutor): CapabilityDefinition<AcademicResearchRequest> {
  return {
    metadata: {
      id: "academic_research",
      version: "1.0.0",
      label: "Research academic evidence",
      description: "Search and inspect AI papers, authors, citation relationships, GitHub repositories, and Hugging Face models, datasets, or Spaces through OpenAlex, arXiv, GitHub, and Hugging Face. Results distinguish indexed metadata, preprints, publisher claims, evidence links, partial-source failures, and uncertain artifact relationships. This cannot prove conference acceptance, employment, financing, patents, or commercial adoption.",
      useWhen: "Use for AI papers, authors, citations, prior work, open-source repositories, models, datasets, demos, technical claims, or research-to-company signals.",
      tier: "on_demand",
      activationClass: "ordinary_task",
      sideEffectClass: "network_read",
      allowedScopes: ["unscoped", "project"],
      executor: "host",
      modelCallable: true,
      inputSchema: {
        type: "object",
        properties: {
          operation: { enum: ["search", "resolve", "inspect", "graph", "fetch_content", "link_artifacts"] },
          queries: { type: "array", maxItems: 6, items: { type: "string", maxLength: 500 } },
          identifier: {
            type: "object",
            properties: {
              kind: { enum: ["title", "doi", "arxiv", "openalex", "url", "github", "huggingface"] },
              value: { type: "string", maxLength: 2_000 }
            },
            required: ["kind", "value"]
          },
          targets: { type: "array", maxItems: 6, items: { enum: ["works", "authors", "repositories", "models", "datasets", "spaces"] } },
          sources: { type: "array", maxItems: 4, items: { enum: ["openalex", "arxiv", "github", "huggingface"] } },
          filters: { type: "object" },
          relation: { enum: ["references", "citations", "related", "coauthors", "artifacts"] },
          contentLevel: { enum: ["metadata", "abstract", "sections"] },
          sort: { enum: ["relevance", "recent", "citations", "activity", "popularity"] },
          limit: { type: "integer", minimum: 1, maximum: 25 },
          maxChars: { type: "integer", minimum: 500, maximum: 15_000 }
        },
        required: ["operation"]
      },
      outputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          status: { enum: ["completed", "partial", "unavailable"] },
          entities: { type: "array" },
          edges: { type: "array" },
          evidence: { type: "array" },
          warnings: { type: "array" },
          sourceStatus: { type: "array" },
          contextReference: { type: "object" }
        },
        required: ["runId", "status", "entities", "edges", "evidence", "warnings", "sourceStatus", "contextReference"]
      }
    },
    inputSchema: academicResearchRequestSchema,
    inspect() {
      return undefined;
    },
    async execute(input, context): Promise<CapabilityExecutionResult> {
      const result = await executeResearch(input, context);
      const content = boundedAcademicResult(result);
      return {
        schemaVersion: 1,
        requestId: context.request.requestId,
        status: result.status === "unavailable" ? "failed" : "completed",
        ...(result.status === "unavailable" ? { code: "ACADEMIC_SOURCES_UNAVAILABLE" } : {}),
        content,
        retrieval: {
          payloadId: randomUUID(),
          retention: "turn_scoped",
          bodyBytes: Buffer.byteLength(content, "utf8"),
          contextReference: {
            schemaVersion: 1,
            sourceClass: "academic",
            sourceId: result.contextReference.sourceId,
            label: result.contextReference.label,
            sourceRange: result.contextReference.sourceRange,
            contentVersion: result.contextReference.contentVersion,
            originatingTool: "academic_research",
            originatingTurnId: context.request.turnId,
            retrievedAt: result.contextReference.retrievedAt,
            status: result.status === "unavailable" ? "source_unavailable" : "active"
          }
        }
      };
    }
  };
}

function boundedAcademicResult(result: AcademicResearchResult): string {
  const project = (excerptChars: number, entityCount: number, evidenceCount: number) => JSON.stringify({
    ...result,
    entities: result.entities.slice(0, entityCount),
    evidence: result.evidence.slice(0, evidenceCount).map((item) => item.excerpt === undefined ? item : { ...item, excerpt: item.excerpt.slice(0, excerptChars) }),
    edges: result.edges.slice(0, 100)
  });
  for (const [excerptChars, entityCount, evidenceCount] of [[2_000, 25, 100], [800, 15, 50], [0, 10, 30]] as const) {
    const serialized = project(excerptChars, entityCount, evidenceCount);
    if (serialized.length <= 19_500) return serialized;
  }
  return JSON.stringify({
    schemaVersion: result.schemaVersion,
    runId: result.runId,
    operation: result.operation,
    status: result.status,
    entities: result.entities.slice(0, 5).map((entity) => entity.type === "work"
      ? { entityId: entity.entityId, type: entity.type, title: entity.title, authors: entity.authors.slice(0, 10), identifiers: entity.identifiers, publicationStatus: entity.publicationStatus, primaryUrl: entity.primaryUrl }
      : entity.type === "author"
        ? { entityId: entity.entityId, type: entity.type, displayName: entity.displayName, affiliations: entity.affiliations.slice(0, 5), identifiers: entity.identifiers, resolutionStatus: entity.resolutionStatus }
        : { entityId: entity.entityId, type: entity.type, owner: entity.owner, name: entity.name, url: entity.url, updatedAt: entity.updatedAt, license: entity.license, metrics: entity.metrics }),
    edges: result.edges.slice(0, 20),
    evidence: result.evidence.slice(0, 20).map(({ excerpt: _excerpt, ...item }) => item),
    omittedItems: result.omittedItems,
    warnings: [...result.warnings, { code: "ACADEMIC_TOOL_OUTPUT_TRUNCATED", message: "Additional result detail was omitted by the Worker IPC limit." }],
    sourceStatus: result.sourceStatus,
    contextReference: result.contextReference
  });
}
