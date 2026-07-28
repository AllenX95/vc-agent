import type {
  AcademicEdge,
  AcademicEntity,
  AcademicEvidence,
  AcademicResearchRequest,
  AcademicSource,
  AcademicWarning
} from "@vc-agent/contracts";

export interface AcademicSourceExecutionContext {
  readonly retrievedAt: string;
  readonly signal?: AbortSignal | undefined;
  readonly credentials: Readonly<Partial<Record<AcademicSource, string>>>;
}

export interface AcademicSourceResult {
  readonly source: AcademicSource;
  readonly entities: readonly AcademicEntity[];
  readonly edges: readonly AcademicEdge[];
  readonly evidence: readonly AcademicEvidence[];
  readonly warnings: readonly AcademicWarning[];
  readonly omittedItems: number;
  readonly status: "completed" | "partial" | "unavailable";
  readonly httpStatusClass?: string;
  readonly rateLimitReset?: string;
}

export interface AcademicSourceAdapter {
  readonly source: AcademicSource;
  supports(request: AcademicResearchRequest): boolean;
  execute(request: AcademicResearchRequest, context: AcademicSourceExecutionContext): Promise<AcademicSourceResult>;
}

export interface AcademicPdfSection {
  readonly name: string;
  readonly pageFrom: number;
  readonly pageTo: number;
  readonly text: string;
}

export interface AcademicPdfExtraction {
  readonly contentHash: string;
  readonly pageCount: number;
  readonly sections: readonly AcademicPdfSection[];
  readonly warnings: readonly string[];
}

export type AcademicPdfExtractor = (input: {
  readonly url: string;
  readonly arxivId: string;
  readonly maxChars: number;
  readonly signal?: AbortSignal | undefined;
}) => Promise<AcademicPdfExtraction>;
