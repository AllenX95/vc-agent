export interface ParserAdapterRegistration {
  readonly id: string;
  readonly version: string;
  readonly extensions: readonly string[];
  readonly pageRecovery: "request_when_needed" | "not_applicable";
}

export const BASELINE_PARSER_ADAPTERS: readonly ParserAdapterRegistration[] = [
  { id: "text", version: "1.0.0", extensions: [".txt", ".md", ".markdown"], pageRecovery: "not_applicable" },
  { id: "json", version: "1.0.0", extensions: [".json"], pageRecovery: "not_applicable" },
  { id: "pyyaml", version: "6.0.2", extensions: [".yaml", ".yml"], pageRecovery: "not_applicable" },
  { id: "xml", version: "1.0.0", extensions: [".xml"], pageRecovery: "not_applicable" },
  { id: "csv", version: "1.0.0", extensions: [".csv"], pageRecovery: "not_applicable" },
  { id: "pymupdf", version: "1.28.0", extensions: [".pdf"], pageRecovery: "request_when_needed" },
  { id: "python-docx", version: "1.2.0", extensions: [".docx"], pageRecovery: "not_applicable" },
  { id: "python-pptx", version: "1.0.2", extensions: [".pptx"], pageRecovery: "not_applicable" },
  { id: "openpyxl", version: "3.1.5", extensions: [".xlsx"], pageRecovery: "not_applicable" }
];

const parserByExtension = new Map(BASELINE_PARSER_ADAPTERS.flatMap((adapter) => adapter.extensions.map((extension) => [extension, adapter] as const)));

export function getParserAdapter(extension: string): ParserAdapterRegistration | undefined {
  return parserByExtension.get(extension.toLowerCase());
}

export function expectedParserIdentity(extension: string): string | undefined {
  const adapter = getParserAdapter(extension);
  return adapter === undefined ? undefined : `${adapter.id}@${adapter.version}`;
}
