import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  PINNED_PI_MCP_ADAPTER_VERSION,
  pageTextBlock,
  type ExtensionAuditAdapter,
  type McpAdapterConnection,
  type McpServerRecord,
  type McpToolSchema,
  type NativePdfAdapter,
  type OvisOcrAdapter,
  type OfficeExecutionPlan,
  type OfficeSkillJobAdapter,
  type PaddleOcrAdapter,
  type PageCandidate,
  type MaterialParseRequest,
  type PinnedPiMcpAdapter
} from "@vc-agent/host-services";
import { createPiMcpAdapter, PI_MCP_ADAPTER_VERSION, type PiMcpServerConfig } from "@vc-agent/pi-adapter/mcp";
import type { LocalOcrDevice, OfficeSkillJobCommand, UtilityJobEvent } from "@vc-agent/contracts";
import type { UtilityJobRunner } from "./utility-job-runner.js";

/**
 * Electron only owns adapter construction. Adapters stay dormant until their
 * owning workflow calls them; Environment Doctor only consumes availability.
 */
export interface DesktopOfficeAdapterOptions {
  /** Utility Worker used for real, user-supplied Skill execution. */
  readonly runner?: UtilityJobRunner;
  /** Explicit runner executable; defaults to VC_AGENT_OFFICE_RUNNER. */
  readonly runnerCommand?: string;
  /** JSON-free injection seam for tests and packaged launchers. */
  readonly runnerArgs?: readonly string[];
  /** Fixture execution is opt-in outside NODE_ENV=test and never a production default. */
  readonly fixture?: boolean;
}

export function createDesktopOfficeAdapter(options: DesktopOfficeAdapterOptions = {}): OfficeSkillJobAdapter {
  const fixture = options.fixture ?? (process.env.NODE_ENV === "test" && process.env.VC_AGENT_REAL_OFFICE !== "1");
  if (fixture) return createFixtureOfficeAdapter();
  const runnerSpec = readOfficeRunnerSpec(options);
  const utilityJobIds = new Map<string, string>();
  return {
    async run({ plan, signal }: { readonly plan: OfficeExecutionPlan; readonly signal: AbortSignal }) {
      if (signal.aborted) throw new Error("OFFICE_JOB_CANCELLED");
      if (process.env.VC_AGENT_TEST_OFFICE_FAILURE === "1") throw new Error("OFFICE_DEPENDENCY_UNAVAILABLE");
      if (options.runner === undefined || runnerSpec === undefined) throw new Error("OFFICE_DEPENDENCY_MISSING");
      const previewPath = plan.task.renderPreview === true ? plan.stagedOutputPath + ".preview" : undefined;
      const command: OfficeSkillJobCommand = {
        schemaVersion: 1,
        jobId: plan.planId,
        command: "office.skill",
        kind: plan.task.kind,
        format: plan.task.format,
        skillRevisionId: plan.task.skillRevisionId,
        skillRoot: plan.skillRoot,
        runner: runnerSpec,
        inputPaths: [...plan.job.inputPaths],
        stagingDirectory: plan.job.stagingDirectory,
        outputPath: plan.stagedOutputPath,
        ...(previewPath === undefined ? {} : { previewPath }),
        logPath: join(plan.job.stagingDirectory, "runner.log"),
        cancellationToken: plan.job.cancellationToken ?? plan.planId,
        timeoutMs: plan.job.timeoutMs,
        maxOutputBytes: plan.job.maxOutputBytes
      };
      utilityJobIds.set(plan.job.jobId, command.jobId);
      try {
        const event = await options.runner.run(command);
        if (signal.aborted) throw new Error("OFFICE_JOB_CANCELLED");
        if (event.event === "office.skill.failed") throw new Error(event.code);
        return { outputPath: event.outputPath, outputBytes: event.outputBytes, ...(event.previewPath === undefined ? {} : { previewPath: event.previewPath }), warnings: event.warnings };
      } finally {
        utilityJobIds.delete(plan.job.jobId);
      }
    },
    terminate(jobId: string) {
      const utilityJobId = utilityJobIds.get(jobId);
      return utilityJobId === undefined ? undefined : options.runner?.terminate(utilityJobId);
    }
  };
}

function createFixtureOfficeAdapter(): OfficeSkillJobAdapter {
  return {
    async run({ plan, signal }: { readonly plan: OfficeExecutionPlan; readonly signal: AbortSignal }) {
      if (signal.aborted) throw new Error("OFFICE_JOB_CANCELLED");
      if (process.env.VC_AGENT_TEST_OFFICE_FAILURE === "1") throw new Error("OFFICE_DEPENDENCY_UNAVAILABLE");
      mkdirSync(plan.job.stagingDirectory, { recursive: true });
      if (plan.task.kind === "edit" && plan.task.sourcePath !== undefined && existsSync(plan.task.sourcePath)) copyFileSync(plan.task.sourcePath, plan.stagedOutputPath);
      else writeFileSync(plan.stagedOutputPath, `vc-agent Office fixture\nformat=${plan.task.format}\ncreated=${new Date().toISOString()}\n`, "utf8");
      const previewPath = plan.task.renderPreview === true ? plan.stagedOutputPath + ".preview" : undefined;
      if (previewPath !== undefined) writeFileSync(previewPath, `Preview for ${basename(plan.stagedOutputPath)}\n`, "utf8");
      return { outputPath: plan.stagedOutputPath, ...(previewPath === undefined ? {} : { previewPath }) };
    }
  };
}

function readOfficeRunnerSpec(options: DesktopOfficeAdapterOptions): OfficeSkillJobCommand["runner"] | undefined {
  const executable = (options.runnerCommand ?? process.env.VC_AGENT_OFFICE_RUNNER)?.trim();
  if (executable === undefined || executable === "") return undefined;
  if (options.runnerArgs !== undefined) return { executable, args: [...options.runnerArgs] };
  const encoded = process.env.VC_AGENT_OFFICE_RUNNER_ARGS;
  if (encoded === undefined || encoded.trim() === "") return { executable, args: [] };
  try {
    const args = JSON.parse(encoded) as unknown;
    if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) return undefined;
    return { executable, args };
  } catch { return undefined; }
}

interface LocalOcrAdapterOptions {
  readonly runner: UtilityJobRunner;
  readonly runtimeRoot: string;
  readonly stagingRoot: string;
  readonly device?: LocalOcrDevice;
}

export function createDesktopNativePdfAdapter(options?: LocalOcrAdapterOptions): NativePdfAdapter {
  if (options !== undefined) return createUtilityNativePdfAdapter(options);
  return {
    id: "native-fixture-pdf",
    version: "fixture-v1",
    inspectAvailability: () => ({ status: "ready", message: "Native local page extraction is available." }),
    async parse(request: MaterialParseRequest) {
      const pageCount = request.pageCount ?? 2;
      const pages = Array.from({ length: pageCount }, (_, index) => pageTextBlock({ request, pageNumber: index + 1, stage: "native", text: index === 1 ? "" : `Native page ${index + 1} fixture text with sufficient structure.` }));
      return { pages, pageCount };
    }
  };
}

export function createDesktopPaddleAdapter(options?: LocalOcrAdapterOptions): PaddleOcrAdapter {
  if (options !== undefined) return createUtilityOcrAdapter("paddle", options);
  return {
    id: "paddleocr-local",
    version: "configured-local",
    runtimeRevision: "paddle-local-v1",
    inspectAvailability: () => process.env.VC_AGENT_TEST_OCR_PADDLE === "1" ? { status: "ready", message: "Configured PaddleOCR local runtime is available." } : { status: "unavailable", message: "PaddleOCR local runtime is not configured." },
    async recover({ request, pageNumber }) {
      return pageTextBlock({ request, pageNumber, stage: "paddle", text: `PaddleOCR recovered page ${pageNumber} fixture text with confidence.`, quality: { confidence: 0.92 }, adapterId: "paddleocr-local", adapterVersion: "configured-local", runtimeRevision: "paddle-local-v1" });
    }
  };
}

export function createDesktopOvisAdapter(options?: LocalOcrAdapterOptions): OvisOcrAdapter {
  if (options !== undefined) return createUtilityOcrAdapter("ovis", options);
  return {
    id: "ovisocr2-local",
    version: "configured-local",
    runtimeRevision: "ovisocr2-local-v1",
    inspectAvailability: () => process.env.VC_AGENT_TEST_OCR_OVIS === "1" ? { status: "ready", message: "Configured OvisOCR2 local runtime is available." } : { status: "unavailable", message: "OvisOCR2 local runtime is not configured." },
    async recover({ request, pageNumber }) {
      if (process.env.VC_AGENT_TEST_OCR_OVIS_FAILURE === "1") throw new Error("OVIS_TIMEOUT");
      return pageTextBlock({ request, pageNumber, stage: "ovis", text: `OvisOCR2 recovered complex page ${pageNumber} fixture structure.`, quality: { confidence: 0.95, structurallyInsufficient: false }, adapterId: "ovisocr2-local", adapterVersion: "configured-local", runtimeRevision: "ovisocr2-local-v1" });
    }
  };
}

function createUtilityNativePdfAdapter(options: LocalOcrAdapterOptions): NativePdfAdapter {
  return {
    id: "pymupdf",
    version: "1.28.0",
    inspectAvailability: () => ({ status: "ready", message: "PyMuPDF native page extraction is available through the local Utility Worker." }),
    async parse(request, signal) {
      if (request.absolutePath === undefined || !existsSync(request.absolutePath)) throw new Error("PAGE_SOURCE_UNAVAILABLE");
      if (signal.aborted) throw new Error("PAGE_RECOVERY_CANCELLED");
      const jobId = randomUUID();
      const stagingDirectory = join(options.stagingRoot, jobId);
      const event = await options.runner.run({ schemaVersion: 1, jobId, command: "material.parse", material: { ...request.material, absolutePath: request.absolutePath }, stagingDirectory, timeoutMs: 300_000, maxOutputBytes: 100_000_000 });
      try {
        if (event.event !== "material.parse.completed") throw new Error(event.message);
        const pages = event.parse.structure.units.map((unit) => {
          const unitBlocks = event.parse.blocks.filter((block) => unit.blockIds.includes(block.id)).map((block) => ({ ...block, id: `native-${block.id}` }));
          // Image xref placeholders are useful provenance, but they are not
          // readable page text and must not suppress the OCR fallback chain.
          const text = unitBlocks.filter((block) => block.type !== "image").map((block) => block.text ?? block.rows?.flat().join(" ") ?? "").join("\n");
          return {
            pageNumber: unit.index,
            stage: "native" as const,
            blocks: unitBlocks,
            quality: { textChars: text.length, printableRatio: localPrintableRatio(text), confidence: 1, structurallyInsufficient: false, usable: text.trim().length > 0 },
            warnings: event.parse.warnings.filter((warning) => warning.source?.locator.index === unit.index).map((warning) => warning.code),
            adapterId: event.parse.parser.id,
            adapterVersion: event.parse.parser.version,
            runtimeRevision: event.parse.parser.runtime
          } satisfies PageCandidate;
        });
        return { pages, pageCount: event.parse.structure.unitCount, warnings: event.parse.warnings };
      } finally {
        rmSync(stagingDirectory, { recursive: true, force: true });
      }
    }
  };
}

function createUtilityOcrAdapter(stage: "paddle", options: LocalOcrAdapterOptions): PaddleOcrAdapter;
function createUtilityOcrAdapter(stage: "ovis", options: LocalOcrAdapterOptions): OvisOcrAdapter;
function createUtilityOcrAdapter(stage: "paddle" | "ovis", options: LocalOcrAdapterOptions): PaddleOcrAdapter | OvisOcrAdapter {
  const manifest = readOcrManifest(options.runtimeRoot);
  const configuredDevice = options.device ?? configuredOcrDevice();
  const component = manifest?.components[stage];
  const availability = (): { status: "ready" | "unavailable"; message: string } => {
    if (manifest === undefined || component === undefined) return { status: "unavailable", message: `${stage === "paddle" ? "PaddleOCR" : "OvisOCR2"} runtime manifest is missing.` };
    const acceptable = configuredDevice === "auto" ? manifest.validatedDevices.length > 0 : manifest.validatedDevices.includes(configuredDevice);
    return acceptable ? { status: "ready", message: `${component.name} ${component.version} is validated for ${configuredDevice === "auto" ? manifest.validatedDevices.join("/") : configuredDevice} local execution.` } : { status: "unavailable", message: `${component.name} is not validated for ${configuredDevice}.` };
  };
  const recover = async ({ request, pageNumber, signal }: { readonly request: MaterialParseRequest; readonly pageNumber: number; readonly signal: AbortSignal }): Promise<PageCandidate> => {
    if (request.absolutePath === undefined || !existsSync(request.absolutePath)) throw new Error("PAGE_SOURCE_UNAVAILABLE");
    if (signal.aborted) throw new Error("PAGE_RECOVERY_CANCELLED");
    const event = await options.runner.run({ schemaVersion: 1, jobId: randomUUID(), command: "page_recovery.ocr", stage, absolutePath: request.absolutePath, pageNumber, device: configuredDevice, runtimeRoot: options.runtimeRoot, timeoutMs: stage === "paddle" ? 300_000 : 1_200_000, maxOutputBytes: 50_000_000 });
    if (event.event !== "page_recovery.ocr.completed") throw new Error(event.message);
    const candidate = pageTextBlock({ request, pageNumber, stage, text: event.text, quality: { confidence: event.confidence, structurallyInsufficient: event.structurallyInsufficient }, adapterId: event.adapterId, adapterVersion: event.adapterVersion, runtimeRevision: `${event.runtimeRevision}:${event.device}` });
    return { ...candidate, warnings: event.warnings };
  };
  return { id: component?.id ?? `${stage}-local`, version: component?.version ?? "unavailable", runtimeRevision: manifest?.revision ?? "unavailable", inspectAvailability: availability, recover } as PaddleOcrAdapter | OvisOcrAdapter;
}

interface OcrRuntimeManifest {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly validatedDevices: readonly ("cpu" | "cuda")[];
  readonly components: Readonly<Record<"paddle" | "ovis", { readonly id: string; readonly name: string; readonly version: string }>>;
}

function readOcrManifest(runtimeRoot: string): OcrRuntimeManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(runtimeRoot, "runtime-manifest.json"), "utf8")) as OcrRuntimeManifest;
    return parsed.schemaVersion === 1 && Array.isArray(parsed.validatedDevices) ? parsed : undefined;
  } catch { return undefined; }
}

function configuredOcrDevice(): LocalOcrDevice {
  const value = process.env.VC_AGENT_OCR_DEVICE?.toLowerCase();
  return value === "cpu" || value === "cuda" ? value : "auto";
}

function localPrintableRatio(text: string): number {
  return text.length === 0 ? 0 : [...text].filter((character) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(character)).length / [...text].length;
}

export function createDesktopMcpAdapter(): PinnedPiMcpAdapter {
  const realAdapter = createPiMcpAdapter();
  return {
    version: PINNED_PI_MCP_ADAPTER_VERSION,
    async connect(config: McpServerRecord, credentialValue: string | undefined, signal?: AbortSignal): Promise<McpAdapterConnection> {
      if (config.transport === "fixture") return createFixtureMcpConnection(config);
      if (PI_MCP_ADAPTER_VERSION !== PINNED_PI_MCP_ADAPTER_VERSION.slice("pi-mcp-adapter@".length)) throw new Error("MCP_ADAPTER_UNAVAILABLE");
      const connection = await realAdapter.connect(toPiMcpServerConfig(config, credentialValue), signal);
      return {
        async listTools() {
          const tools = await connection.listTools();
          return tools.map((tool) => normalizeMcpTool(tool, config));
        },
        call: (toolName, arguments_, callSignal) => connection.call(toolName, arguments_, callSignal),
        close: () => connection.close()
      };
    }
  };
}

function createFixtureMcpConnection(config: McpServerRecord): McpAdapterConnection {
  let closed = false;
  const schemas = config.cachedToolSchemas.length > 0 ? config.cachedToolSchemas : defaultMcpSchemas();
  return {
    async listTools() {
      if (closed) throw new Error("MCP_DISCONNECTED");
      return schemas;
    },
    async call(toolName: string, arguments_: Readonly<Record<string, unknown>>) {
      if (closed) throw new Error("MCP_DISCONNECTED");
      if (process.env.VC_AGENT_TEST_MCP_FAILURE === "1") throw new Error("MCP_CONNECTION_FAILED");
      return { fixture: true, toolName, arguments: arguments_, observedAt: new Date().toISOString() };
    },
    async close() { closed = true; }
  };
}

function toPiMcpServerConfig(config: McpServerRecord, credentialValue: string | undefined): PiMcpServerConfig {
  return {
    serverKey: config.serverId,
    transport: config.transport === "http" ? "http" : "stdio",
    ...(config.command === undefined ? {} : { command: config.command }),
    ...(config.args.length === 0 ? {} : { args: config.args }),
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(credentialValue === undefined ? {} : { credentialValue })
  };
}

function normalizeMcpTool(tool: { readonly name: string; readonly description?: string; readonly inputSchema?: unknown }, config: McpServerRecord): McpToolSchema {
  const cached = config.cachedToolSchemas.find((schema) => schema.name === tool.name);
  if (cached !== undefined) {
    // Keep Host-reviewed policy metadata, but always recompute the protocol
    // schema identity from the live tool definition so a changed server cannot
    // hide behind a stale cached hash.
    return {
      ...cached,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      schemaHash: schemaHash(tool.inputSchema)
    };
  }
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    actionClass: /(?:write|update|delete|create|submit|send|upload)/iu.test(tool.name) ? "write" : "read",
    allowedScopes: config.allowedScopes,
    inputBytes: 4_000,
    outputBytes: 20_000,
    schemaHash: schemaHash(tool.inputSchema)
  };
}

function schemaHash(schema: unknown): string {
  const canonical = JSON.stringify(schema ?? null);
  let hash = 2166136261;
  for (const character of canonical) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `mcp-schema-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function createDesktopExtensionAuditAdapter(): ExtensionAuditAdapter {
  return {
    async review(input) {
      if (process.env.VC_AGENT_TEST_EXTENSION_AUDIT_FAILURE === "1") throw new Error("EXTENSION_AUDIT_PROVIDER_FAILED");
      return { summary: `Deterministic fixture audit completed for ${input.stagedRevisionId}.`, findings: [], residualRisk: ["Trusted Worker Code remains outside Standard Access mediation."], limitations: ["Fixture audit does not claim semantic correctness of third-party code."] };
    }
  };
}

function defaultMcpSchemas(): McpToolSchema[] {
  return [
    { name: "fixture.search", description: "Bounded fixture read", actionClass: "read", allowedScopes: ["project", "unscoped"], inputBytes: 4_000, outputBytes: 20_000, schemaHash: "fixture-search-v1" },
    { name: "fixture.write", description: "Explicitly confirmed fixture write", actionClass: "write", allowedScopes: ["project"], inputBytes: 4_000, outputBytes: 20_000, schemaHash: "fixture-write-v1" }
  ];
}
