import { z } from "zod";

export const sourceReferenceSchema = z.object({
  relativePath: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  locator: z.object({
    kind: z.enum(["document", "page", "slide", "sheet", "path", "line"]),
    index: z.number().int().positive().optional(),
    name: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
    geometry: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional()
  })
});
export type SourceReference = z.infer<typeof sourceReferenceSchema>;

export const canonicalParseBlockSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["heading", "paragraph", "table", "note", "image"]),
  text: z.string().optional(),
  level: z.number().int().min(1).max(6).optional(),
  rows: z.array(z.array(z.string())).optional(),
  tokens: z.array(z.object({ text: z.string(), geometry: z.tuple([z.number(), z.number(), z.number(), z.number()]) })).optional(),
  source: sourceReferenceSchema
}).refine((block) => block.text !== undefined || block.rows !== undefined, "A block requires text or rows");
export type CanonicalParseBlock = z.infer<typeof canonicalParseBlockSchema>;

export const parseWarningSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string().min(1),
  source: sourceReferenceSchema.optional()
});
export type ParseWarning = z.infer<typeof parseWarningSchema>;

export const canonicalParseSchema = z.object({
  schemaVersion: z.literal(1),
  parseId: z.string().uuid(),
  material: z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    relativePath: z.string().min(1),
    mediaType: z.string().min(1),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/)
  }),
  parser: z.object({ id: z.string().min(1), version: z.string().min(1), runtime: z.string().min(1) }),
  createdAt: z.string().datetime(),
  structure: z.object({
    kind: z.enum(["document", "pages", "slides", "workbook", "table", "structured_text"]),
    unitCount: z.number().int().nonnegative(),
    units: z.array(z.object({ index: z.number().int().positive(), name: z.string().optional(), blockIds: z.array(z.string().min(1)) }))
  }),
  blocks: z.array(canonicalParseBlockSchema),
  warnings: z.array(parseWarningSchema),
  recoveryRequests: z.array(z.object({
    source: sourceReferenceSchema,
    reason: z.enum(["missing_text", "unreliable_text", "complex_structure"]),
    status: z.literal("unavailable")
  })),
  provenance: z.object({
    localOnly: z.literal(true),
    stages: z.array(z.object({
      id: z.string().min(1), version: z.string().min(1), durationMs: z.number().int().nonnegative(),
      status: z.enum(["completed", "warning", "failed"]), warningCodes: z.array(z.string().min(1))
    }))
  })
});
export type CanonicalParse = z.infer<typeof canonicalParseSchema>;

const utilityJobBaseSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: z.string().uuid()
});

const materialParseJobCommandSchema = utilityJobBaseSchema.extend({
  command: z.literal("material.parse"),
  material: z.object({
    id: z.string().uuid(), projectId: z.string().uuid(), relativePath: z.string().min(1),
    mediaType: z.string().min(1), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), absolutePath: z.string().min(1)
  }),
  stagingDirectory: z.string().min(1),
  timeoutMs: z.number().int().min(1_000).max(300_000),
  maxOutputBytes: z.number().int().min(1_024).max(100_000_000)
});

export const localOcrDeviceSchema = z.enum(["auto", "cpu", "cuda"]);
export type LocalOcrDevice = z.infer<typeof localOcrDeviceSchema>;

const pageRecoveryOcrJobCommandSchema = utilityJobBaseSchema.extend({
  command: z.literal("page_recovery.ocr"),
  stage: z.enum(["paddle", "ovis"]),
  absolutePath: z.string().min(1),
  pageNumber: z.number().int().positive(),
  device: localOcrDeviceSchema,
  runtimeRoot: z.string().min(1),
  timeoutMs: z.number().int().min(1_000).max(1_800_000),
  maxOutputBytes: z.number().int().min(1_024).max(100_000_000)
});

const officeSkillJobCommandSchema = utilityJobBaseSchema.extend({
  command: z.literal("office.skill"),
  kind: z.enum(["create", "edit", "review"]),
  format: z.enum(["docx", "pptx", "xlsx", "pdf"]),
  skillRevisionId: z.string().min(1),
  skillRoot: z.string().min(1),
  runner: z.object({
    executable: z.string().min(1),
    args: z.array(z.string().max(2_000)).max(64)
  }),
  inputPaths: z.array(z.string().min(1)).max(8),
  stagingDirectory: z.string().min(1),
  outputPath: z.string().min(1),
  previewPath: z.string().min(1).optional(),
  logPath: z.string().min(1),
  cancellationToken: z.string().min(1),
  timeoutMs: z.number().int().min(1_000).max(1_800_000),
  maxOutputBytes: z.number().int().min(1_024).max(100_000_000)
});

export const utilityJobCommandSchema = z.discriminatedUnion("command", [materialParseJobCommandSchema, pageRecoveryOcrJobCommandSchema, officeSkillJobCommandSchema]);
export type UtilityJobCommand = z.infer<typeof utilityJobCommandSchema>;
export type OfficeSkillJobCommand = z.infer<typeof officeSkillJobCommandSchema>;

export const utilityJobEventSchema = z.discriminatedUnion("event", [
  utilityJobBaseSchema.extend({ event: z.literal("material.parse.completed"), artifactPath: z.string().min(1), parse: canonicalParseSchema }),
  utilityJobBaseSchema.extend({ event: z.literal("material.parse.failed"), code: z.string().min(1), message: z.string().min(1), stderr: z.string().max(20_000) }),
  utilityJobBaseSchema.extend({
    event: z.literal("page_recovery.ocr.completed"),
    stage: z.enum(["paddle", "ovis"]),
    text: z.string(),
    confidence: z.number().min(0).max(1),
    structurallyInsufficient: z.boolean(),
    adapterId: z.string().min(1),
    adapterVersion: z.string().min(1),
    runtimeRevision: z.string().min(1),
    device: z.enum(["cpu", "cuda"]),
    warnings: z.array(z.string().min(1)).default([])
  }),
  utilityJobBaseSchema.extend({ event: z.literal("page_recovery.ocr.failed"), stage: z.enum(["paddle", "ovis"]), code: z.string().min(1), message: z.string().min(1), stderr: z.string().max(20_000) }),
  utilityJobBaseSchema.extend({ event: z.literal("office.skill.completed"), outputPath: z.string().min(1), outputBytes: z.number().int().nonnegative(), previewPath: z.string().min(1).optional(), warnings: z.array(z.string().min(1)).default([]) }),
  utilityJobBaseSchema.extend({ event: z.literal("office.skill.failed"), code: z.string().min(1), message: z.string().min(1), stderr: z.string().max(20_000) })
]);
export type UtilityJobEvent = z.infer<typeof utilityJobEventSchema>;
