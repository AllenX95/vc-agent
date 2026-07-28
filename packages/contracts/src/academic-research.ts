import { z } from "zod";

export const academicSourceSchema = z.enum(["openalex", "arxiv", "github", "huggingface"]);
export type AcademicSource = z.infer<typeof academicSourceSchema>;

export const academicOperationSchema = z.enum(["search", "resolve", "inspect", "graph", "fetch_content", "link_artifacts"]);
export type AcademicOperation = z.infer<typeof academicOperationSchema>;

export const academicTargetSchema = z.enum(["works", "authors", "repositories", "models", "datasets", "spaces"]);
export type AcademicTarget = z.infer<typeof academicTargetSchema>;

export const academicResearchRequestSchema = z.object({
  operation: academicOperationSchema,
  queries: z.array(z.string().trim().min(1).max(500)).max(6).optional(),
  identifier: z.object({
    kind: z.enum(["title", "doi", "arxiv", "openalex", "url", "github", "huggingface"]),
    value: z.string().trim().min(1).max(2_000)
  }).optional(),
  targets: z.array(academicTargetSchema).max(6).optional(),
  sources: z.array(academicSourceSchema).max(4).optional(),
  filters: z.object({
    dateFrom: z.string().date().optional(),
    dateTo: z.string().date().optional(),
    authors: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
    institutions: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
    categories: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    minStars: z.number().int().nonnegative().max(10_000_000).optional(),
    updatedAfter: z.string().date().optional()
  }).optional(),
  relation: z.enum(["references", "citations", "related", "coauthors", "artifacts"]).optional(),
  contentLevel: z.enum(["metadata", "abstract", "sections"]).optional(),
  sort: z.enum(["relevance", "recent", "citations", "activity", "popularity"]).optional(),
  limit: z.number().int().min(1).max(25).default(10),
  maxChars: z.number().int().min(500).max(15_000).default(8_000)
}).superRefine((request, context) => {
  if (request.operation === "search" && (request.queries === undefined || request.queries.length === 0)) {
    context.addIssue({ code: "custom", message: "search requires at least one query", path: ["queries"] });
  }
  if (request.operation !== "search" && request.identifier === undefined) {
    context.addIssue({ code: "custom", message: `${request.operation} requires an identifier`, path: ["identifier"] });
  }
  if (request.operation === "graph" && request.relation === undefined) {
    context.addIssue({ code: "custom", message: "graph requires a relation", path: ["relation"] });
  }
});
export type AcademicResearchRequest = z.infer<typeof academicResearchRequestSchema>;

export const academicAuthorReferenceSchema = z.object({
  entityId: z.string().min(1),
  displayName: z.string().min(1),
  position: z.number().int().positive().optional()
});
export type AcademicAuthorReference = z.infer<typeof academicAuthorReferenceSchema>;

export const academicInstitutionReferenceSchema = z.object({
  entityId: z.string().min(1),
  displayName: z.string().min(1)
});
export type AcademicInstitutionReference = z.infer<typeof academicInstitutionReferenceSchema>;

export const academicSourceRecordSchema = z.object({
  source: academicSourceSchema,
  sourceId: z.string().min(1),
  sourceUrl: z.string().url(),
  retrievedAt: z.string().datetime(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional()
});
export type AcademicSourceRecord = z.infer<typeof academicSourceRecordSchema>;

export const academicEntitySchema = z.discriminatedUnion("type", [
  z.object({
    entityId: z.string().min(1),
    type: z.literal("work"),
    title: z.string().min(1),
    abstract: z.string().optional(),
    authors: z.array(academicAuthorReferenceSchema),
    institutions: z.array(academicInstitutionReferenceSchema),
    publicationDate: z.string().optional(),
    firstSubmittedDate: z.string().optional(),
    lastUpdatedDate: z.string().optional(),
    identifiers: z.object({
      doi: z.string().optional(),
      arxiv: z.string().optional(),
      openalex: z.string().optional()
    }),
    categories: z.array(z.string()),
    topics: z.array(z.string()),
    citationCount: z.number().int().nonnegative().optional(),
    referenceCount: z.number().int().nonnegative().optional(),
    primaryUrl: z.string().url().optional(),
    pdfUrl: z.string().url().optional(),
    publicationStatus: z.enum(["preprint", "indexed_publication", "unknown"]),
    sourceRecords: z.array(academicSourceRecordSchema)
  }),
  z.object({
    entityId: z.string().min(1),
    type: z.literal("author"),
    displayName: z.string().min(1),
    alternativeNames: z.array(z.string()),
    affiliations: z.array(academicInstitutionReferenceSchema),
    identifiers: z.object({
      openalex: z.string().optional(),
      github: z.string().optional(),
      huggingface: z.string().optional()
    }),
    workIds: z.array(z.string()),
    resolutionStatus: z.enum(["resolved", "candidate", "ambiguous"]),
    sourceRecords: z.array(academicSourceRecordSchema)
  }),
  z.object({
    entityId: z.string().min(1),
    type: z.enum(["github_repository", "hf_model", "hf_dataset", "hf_space"]),
    owner: z.string().min(1),
    name: z.string().min(1),
    url: z.string().url(),
    description: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    license: z.string().optional(),
    tags: z.array(z.string()),
    metrics: z.object({
      stars: z.number().int().nonnegative().optional(),
      forks: z.number().int().nonnegative().optional(),
      downloads: z.number().int().nonnegative().optional(),
      likes: z.number().int().nonnegative().optional(),
      contributors: z.number().int().nonnegative().optional(),
      commitsLast90Days: z.number().int().nonnegative().optional()
    }),
    files: z.array(z.string()),
    linkedWorkIds: z.array(z.string()),
    sourceRecords: z.array(academicSourceRecordSchema)
  })
]);
export type AcademicEntity = z.infer<typeof academicEntitySchema>;

export const academicEvidenceSchema = z.object({
  evidenceId: z.string().min(1),
  source: academicSourceSchema,
  sourceEntityId: z.string().min(1),
  sourceUrl: z.string().url(),
  retrievedAt: z.string().datetime(),
  evidenceType: z.enum([
    "metadata",
    "abstract",
    "paper_text",
    "citation_graph",
    "repository",
    "readme",
    "commit_history",
    "model_card",
    "dataset_card",
    "space_card"
  ]),
  supportedFields: z.array(z.string().min(1)),
  excerpt: z.string().max(8_000).optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  localSnapshotRef: z.string().optional()
});
export type AcademicEvidence = z.infer<typeof academicEvidenceSchema>;

export const academicEdgeSchema = z.object({
  sourceEntityId: z.string().min(1),
  targetEntityId: z.string().min(1),
  relation: z.enum([
    "references",
    "cites",
    "related",
    "coauthor",
    "artifact_of",
    "possible_organization_link",
    "direct_predecessor",
    "follow_up",
    "alternative_route"
  ]),
  confidence: z.enum(["high", "medium", "low"]),
  evidenceIds: z.array(z.string().min(1))
});
export type AcademicEdge = z.infer<typeof academicEdgeSchema>;

export const academicWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1).max(1_000),
  source: academicSourceSchema.optional()
});
export type AcademicWarning = z.infer<typeof academicWarningSchema>;

export const academicSourceStatusSchema = z.object({
  source: academicSourceSchema,
  attempted: z.boolean(),
  status: z.enum(["completed", "partial", "unavailable", "not_applicable"]),
  retrievedAt: z.string().datetime(),
  cacheStatus: z.enum(["hit", "miss", "bypass"]),
  httpStatusClass: z.string().optional(),
  rateLimitReset: z.string().optional(),
  warningCode: z.string().optional()
});
export type AcademicSourceStatus = z.infer<typeof academicSourceStatusSchema>;

export const academicResearchResultSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  operation: academicOperationSchema,
  status: z.enum(["completed", "partial", "unavailable"]),
  entities: z.array(academicEntitySchema).max(25),
  edges: z.array(academicEdgeSchema).max(200),
  evidence: z.array(academicEvidenceSchema).max(100),
  omittedItems: z.number().int().nonnegative(),
  warnings: z.array(academicWarningSchema),
  sourceStatus: z.array(academicSourceStatusSchema),
  contextReference: z.object({
    sourceId: z.string().min(1),
    label: z.string().min(1),
    sourceRange: z.string().min(1),
    contentVersion: z.string().min(1),
    retrievedAt: z.string().datetime()
  })
});
export type AcademicResearchResult = z.infer<typeof academicResearchResultSchema>;
