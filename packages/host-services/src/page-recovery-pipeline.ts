import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { canonicalParseBlockSchema, type CanonicalParse, type CanonicalParseBlock, type ParseWarning, type SourceReference } from "@vc-agent/contracts";

export interface PageQualityPolicy {
  readonly revision: string;
  readonly minNativeTextChars: number;
  readonly minPrintableRatio: number;
  readonly minPaddleConfidence: number;
}

export interface PageQualitySignals {
  readonly textChars: number;
  readonly printableRatio: number;
  readonly confidence: number;
  readonly structurallyInsufficient: boolean;
  readonly usable: boolean;
}

export type PageStage = "native" | "paddle" | "ovis";

export interface PageCandidate {
  readonly pageNumber: number;
  readonly stage: PageStage;
  readonly blocks: readonly CanonicalParseBlock[];
  readonly quality: PageQualitySignals;
  readonly warnings?: readonly string[];
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly runtimeRevision: string;
}

export interface MaterialParseRequest {
  readonly parseId?: string;
  readonly material: { readonly id: string; readonly projectId: string; readonly relativePath: string; readonly mediaType: string; readonly sourceHash: string };
  /** Host-resolved local path. Never persisted in Canonical Parse or evidence. */
  readonly absolutePath?: string;
  readonly pageCount?: number;
  readonly currentSourceHash?: () => Promise<string> | string;
  readonly cancellationToken?: AbortSignal;
}

export interface NativePdfAdapter {
  readonly id?: string;
  readonly version?: string;
  parse(request: MaterialParseRequest, signal: AbortSignal): Promise<{ readonly pages: readonly PageCandidate[]; readonly pageCount: number; readonly warnings?: readonly ParseWarning[] }>;
  inspectAvailability(): { readonly status: "ready" | "unavailable"; readonly message: string };
}

export interface PaddleOcrAdapter {
  readonly id: string;
  readonly version: string;
  readonly runtimeRevision: string;
  recover(input: { readonly request: MaterialParseRequest; readonly pageNumber: number; readonly signal: AbortSignal }): Promise<PageCandidate>;
  inspectAvailability(): { readonly status: "ready" | "unavailable"; readonly message: string };
}

export interface OvisOcrAdapter {
  readonly id: string;
  readonly version: string;
  readonly runtimeRevision: string;
  recover(input: { readonly request: MaterialParseRequest; readonly pageNumber: number; readonly paddle?: PageCandidate; readonly signal: AbortSignal }): Promise<PageCandidate>;
  inspectAvailability(): { readonly status: "ready" | "unavailable"; readonly message: string };
}

export interface PageRecoveryAvailability {
  readonly native: { readonly status: "ready" | "unavailable"; readonly message: string };
  readonly paddle: { readonly status: "ready" | "unavailable"; readonly message: string };
  readonly ovis: { readonly status: "ready" | "unavailable"; readonly message: string };
  readonly policyRevision: string;
}

export interface PageRecoveryTelemetry {
  readonly policyRevision: string;
  readonly pageCount: number;
  readonly nativePages: number;
  readonly paddlePages: number;
  readonly ovisPages: number;
  readonly retainedEarlierPages: number;
  readonly failures: number;
  readonly durationMs: number;
  readonly lastStatus: "completed" | "completed_with_warnings" | "failed" | "cancelled";
}

export interface PageRecoveryOptions {
  readonly native: NativePdfAdapter;
  readonly paddle: PaddleOcrAdapter;
  readonly ovis: OvisOcrAdapter;
  readonly policy?: PageQualityPolicy;
  readonly now?: () => number;
}

export class PageRecoveryError extends Error {
  readonly code: "OCR_UNAVAILABLE" | "OCR_FAILED" | "OCR_RESULT_INVALID" | "COMPLEX_PARSE_UNAVAILABLE" | "COMPLEX_PARSE_FAILED" | "COMPLEX_PARSE_INVALID" | "PAGE_RECOVERY_TIMEOUT" | "PAGE_RECOVERY_CANCELLED" | "SOURCE_CHANGED_DURING_PARSE" | "NATIVE_PARSE_FAILED";

  constructor(code: PageRecoveryError["code"], message: string = code) {
    super(message);
    this.name = "PageRecoveryError";
    this.code = code;
  }
}

interface PageSelection {
  readonly pageNumber: number;
  readonly candidate?: PageCandidate;
  readonly reason?: "missing_text" | "unreliable_text" | "complex_structure";
  readonly warningCodes: string[];
}

const DEFAULT_POLICY: PageQualityPolicy = { revision: "page-quality-v1", minNativeTextChars: 20, minPrintableRatio: 0.85, minPaddleConfidence: 0.65 };

/** Fixed local page recovery chain that never exposes a selectable OCR provider. */
export class PageRecoveryPipeline {
  readonly #native: NativePdfAdapter;
  readonly #paddle: PaddleOcrAdapter;
  readonly #ovis: OvisOcrAdapter;
  readonly #policy: PageQualityPolicy;
  readonly #now: () => number;
  readonly #active = new Map<string, AbortController>();
  #lastTelemetry: PageRecoveryTelemetry = { policyRevision: DEFAULT_POLICY.revision, pageCount: 0, nativePages: 0, paddlePages: 0, ovisPages: 0, retainedEarlierPages: 0, failures: 0, durationMs: 0, lastStatus: "failed" };

  constructor(options: PageRecoveryOptions) {
    this.#native = options.native;
    this.#paddle = options.paddle;
    this.#ovis = options.ovis;
    this.#policy = options.policy ?? DEFAULT_POLICY;
    this.#now = options.now ?? Date.now;
    this.#lastTelemetry = { ...this.#lastTelemetry, policyRevision: this.#policy.revision };
  }

  inspectAvailability(): PageRecoveryAvailability {
    return { native: this.#native.inspectAvailability(), paddle: this.#paddle.inspectAvailability(), ovis: this.#ovis.inspectAvailability(), policyRevision: this.#policy.revision };
  }

  telemetry(): PageRecoveryTelemetry { return { ...this.#lastTelemetry }; }

  async cancel(parseId: string): Promise<{ readonly status: "cancelled" | "not_found"; readonly parseId: string }> {
    const controller = this.#active.get(parseId);
    if (controller === undefined) return { status: "not_found", parseId };
    controller.abort();
    return { status: "cancelled", parseId };
  }

  async parse(request: MaterialParseRequest): Promise<CanonicalParse> {
    const parseId = request.parseId ?? randomUUID();
    const controller = new AbortController();
    const removeAbort = linkAbort(request.cancellationToken, controller);
    this.#active.set(parseId, controller);
    const startedAt = this.#now();
    let failures = 0;
    let retainedEarlierPages = 0;
    try {
      const nativeStageStarted = this.#now();
      let nativeResult: { readonly pages: readonly PageCandidate[]; readonly pageCount: number; readonly warnings?: readonly ParseWarning[] };
      try {
        nativeResult = await this.#native.parse({ ...request, parseId }, controller.signal);
      } catch (error) {
        throw new PageRecoveryError("NATIVE_PARSE_FAILED", error instanceof Error ? error.message : "Native PDF parse failed.");
      }
      assertNotCancelled(controller.signal);
      const nativeByPage = new Map(nativeResult.pages.map((candidate) => [candidate.pageNumber, validateCandidate(candidate, request)]));
      const selections: PageSelection[] = [];
      const warnings: ParseWarning[] = [...(nativeResult.warnings ?? [])];
      const stageRecords: { id: string; version: string; durationMs: number; status: "completed" | "warning" | "failed"; warningCodes: string[] }[] = [{
        id: this.#native.id ?? "pymupdf", version: this.#native.version ?? "pinned", durationMs: Math.max(0, this.#now() - nativeStageStarted), status: (nativeResult.warnings?.length ?? 0) > 0 ? "warning" : "completed", warningCodes: (nativeResult.warnings ?? []).map((warning) => warning.code)
      }];
      let nativePages = 0;
      let paddlePages = 0;
      let ovisPages = 0;
      for (let pageNumber = 1; pageNumber <= (request.pageCount ?? nativeResult.pageCount); pageNumber += 1) {
        assertNotCancelled(controller.signal);
        const native = nativeByPage.get(pageNumber);
        if (native !== undefined && isNativeReliable(native, this.#policy)) {
          nativePages += 1;
          selections.push({ pageNumber, candidate: native, warningCodes: [] });
          continue;
        }
        const reason = native === undefined || native.quality.textChars === 0 ? "missing_text" : "unreliable_text";
        const paddle = await this.#recoverPaddle(request, pageNumber, controller, stageRecords);
        if (paddle !== undefined && isPaddleReliable(paddle, this.#policy)) {
          paddlePages += 1;
          selections.push({ pageNumber, candidate: paddle, warningCodes: native === undefined ? [] : ["NATIVE_PARSE_WARNING"] });
          if (native !== undefined) retainedEarlierPages += 1;
          continue;
        }
        const ovis = await this.#recoverOvis(request, pageNumber, paddle, controller, stageRecords);
        if (ovis !== undefined && isOvisReliable(ovis)) {
          ovisPages += 1;
          selections.push({ pageNumber, candidate: ovis, warningCodes: native === undefined ? [] : ["NATIVE_PARSE_WARNING"] });
          if (paddle !== undefined) retainedEarlierPages += 1;
          continue;
        }
        const fallback = paddle !== undefined && validCandidate(paddle) ? paddle : native !== undefined && validCandidate(native) ? native : undefined;
        if (fallback !== undefined) {
          retainedEarlierPages += 1;
          selections.push({ pageNumber, candidate: fallback, reason: paddle === undefined ? reason : "complex_structure", warningCodes: [...(fallback.warnings ?? []), this.#ovis.inspectAvailability().status === "ready" ? "COMPLEX_PARSE_FAILED" : "COMPLEX_PARSE_UNAVAILABLE"] });
        } else {
          selections.push({ pageNumber, reason, warningCodes: ["OCR_UNAVAILABLE", this.#ovis.inspectAvailability().status === "ready" ? "COMPLEX_PARSE_FAILED" : "COMPLEX_PARSE_UNAVAILABLE"] });
        }
        failures += 1;
      }
      for (const selection of selections) {
        for (const code of selection.warningCodes) {
          warnings.push({ code, severity: "warning", message: warningMessage(code), source: pageSource(request, selection.pageNumber) });
        }
      }
      const blocks = selections.flatMap((selection) => selection.candidate?.blocks ?? []);
      const units = selections.map((selection) => ({ index: selection.pageNumber, name: "Page " + selection.pageNumber, blockIds: [...(selection.candidate?.blocks.map((block) => block.id) ?? [])] }));
      const recoveryRequests = selections.filter((selection) => selection.candidate === undefined).map((selection) => ({ source: pageSource(request, selection.pageNumber), reason: selection.reason ?? "missing_text" as const, status: "unavailable" as const }));
      const parse: CanonicalParse = {
        schemaVersion: 1,
        parseId,
        material: request.material,
        parser: { id: "page-recovery", version: this.#policy.revision, runtime: "local-utility-worker" },
        createdAt: new Date().toISOString(),
        structure: { kind: "pages", unitCount: units.length, units },
        blocks,
        warnings,
        recoveryRequests,
        provenance: { localOnly: true, stages: stageRecords }
      };
      const validated = {
        ...parse,
        blocks: parse.blocks.map((block) => canonicalParseBlockSchema.parse(block))
      };
      if (request.currentSourceHash !== undefined && await request.currentSourceHash() !== request.material.sourceHash) throw new PageRecoveryError("SOURCE_CHANGED_DURING_PARSE", "The source changed while page recovery was running.");
      const lastStatus = failures > 0 || warnings.length > 0 ? "completed_with_warnings" as const : "completed" as const;
      this.#lastTelemetry = { policyRevision: this.#policy.revision, pageCount: units.length, nativePages, paddlePages, ovisPages, retainedEarlierPages, failures, durationMs: Math.max(0, this.#now() - startedAt), lastStatus };
      return validated;
    } catch (error) {
      const code = controller.signal.aborted ? "PAGE_RECOVERY_CANCELLED" : error instanceof PageRecoveryError ? error.code : "NATIVE_PARSE_FAILED";
      this.#lastTelemetry = { ...this.#lastTelemetry, durationMs: Math.max(0, this.#now() - startedAt), failures: this.#lastTelemetry.failures + 1, lastStatus: code === "PAGE_RECOVERY_CANCELLED" ? "cancelled" : "failed" };
      if (error instanceof PageRecoveryError) throw error;
      throw new PageRecoveryError(code as PageRecoveryError["code"], error instanceof Error ? error.message : "Page recovery failed.");
    } finally {
      removeAbort();
      this.#active.delete(parseId);
    }
  }

  async #recoverPaddle(request: MaterialParseRequest, pageNumber: number, controller: AbortController, stages: { id: string; version: string; durationMs: number; status: "completed" | "warning" | "failed"; warningCodes: string[] }[]): Promise<PageCandidate | undefined> {
    const started = this.#now();
    if (this.#paddle.inspectAvailability().status !== "ready") {
      stages.push({ id: this.#paddle.id, version: this.#paddle.version, durationMs: 0, status: "warning", warningCodes: ["OCR_UNAVAILABLE"] });
      return undefined;
    }
    try {
      const candidate = validateCandidate(await this.#paddle.recover({ request, pageNumber, signal: controller.signal }), request);
      assertNotCancelled(controller.signal);
      const usable = isPaddleReliable(candidate, this.#policy);
      stages.push({ id: this.#paddle.id, version: this.#paddle.version, durationMs: Math.max(0, this.#now() - started), status: usable ? "completed" : "warning", warningCodes: usable ? [] : ["OCR_FAILED"] });
      return candidate;
    } catch {
      assertNotCancelled(controller.signal);
      stages.push({ id: this.#paddle.id, version: this.#paddle.version, durationMs: Math.max(0, this.#now() - started), status: "failed", warningCodes: ["OCR_FAILED"] });
      return undefined;
    }
  }

  async #recoverOvis(request: MaterialParseRequest, pageNumber: number, paddle: PageCandidate | undefined, controller: AbortController, stages: { id: string; version: string; durationMs: number; status: "completed" | "warning" | "failed"; warningCodes: string[] }[]): Promise<PageCandidate | undefined> {
    const started = this.#now();
    if (this.#ovis.inspectAvailability().status !== "ready") {
      stages.push({ id: this.#ovis.id, version: this.#ovis.version, durationMs: 0, status: "warning", warningCodes: ["COMPLEX_PARSE_UNAVAILABLE"] });
      return undefined;
    }
    try {
      const candidate = validateCandidate(await this.#ovis.recover({ request, pageNumber, ...(paddle === undefined ? {} : { paddle }), signal: controller.signal }), request);
      assertNotCancelled(controller.signal);
      const usable = isOvisReliable(candidate);
      stages.push({ id: this.#ovis.id, version: this.#ovis.version, durationMs: Math.max(0, this.#now() - started), status: usable ? "completed" : "warning", warningCodes: usable ? [] : ["COMPLEX_PARSE_INVALID"] });
      return candidate;
    } catch {
      assertNotCancelled(controller.signal);
      stages.push({ id: this.#ovis.id, version: this.#ovis.version, durationMs: Math.max(0, this.#now() - started), status: "failed", warningCodes: ["COMPLEX_PARSE_FAILED"] });
      return undefined;
    }
  }
}

function linkAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (source === undefined) return () => undefined;
  const abort = () => target.abort();
  if (source.aborted) abort(); else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new PageRecoveryError("PAGE_RECOVERY_CANCELLED", "Page recovery was cancelled.");
}

function validCandidate(candidate: PageCandidate): boolean {
  return candidate.quality.usable && candidate.blocks.every((block) => canonicalParseBlockSchema.safeParse(block).success);
}

function isNativeReliable(candidate: PageCandidate, policy: PageQualityPolicy): boolean {
  return candidate.quality.usable && !candidate.quality.structurallyInsufficient && candidate.quality.textChars >= policy.minNativeTextChars && candidate.quality.printableRatio >= policy.minPrintableRatio;
}

function isPaddleReliable(candidate: PageCandidate, policy: PageQualityPolicy): boolean {
  return candidate.quality.usable && !candidate.quality.structurallyInsufficient && candidate.quality.confidence >= policy.minPaddleConfidence;
}

function isOvisReliable(candidate: PageCandidate): boolean {
  return candidate.quality.usable && !candidate.quality.structurallyInsufficient;
}

function validateCandidate(candidate: PageCandidate, request: MaterialParseRequest): PageCandidate {
  if (!Number.isInteger(candidate.pageNumber) || candidate.pageNumber < 1) throw new PageRecoveryError("OCR_RESULT_INVALID", "Page identity is invalid.");
  if (!candidate.blocks.every((block) => canonicalParseBlockSchema.safeParse(block).success)) throw new PageRecoveryError("OCR_RESULT_INVALID", "A recovery candidate failed Canonical Parse validation.");
  if (candidate.blocks.some((block) => block.source.sourceHash !== request.material.sourceHash)) throw new PageRecoveryError("OCR_RESULT_INVALID", "A candidate references a different source hash.");
  return candidate;
}

function pageSource(request: MaterialParseRequest, pageNumber: number): SourceReference {
  return { relativePath: request.material.relativePath, sourceHash: request.material.sourceHash, locator: { kind: "page", index: pageNumber } };
}

function warningMessage(code: string): string {
  return code === "NATIVE_PARSE_WARNING" ? "Native page extraction was incomplete; recovery result was retained." : code === "OCR_UNAVAILABLE" ? "PaddleOCR or OvisOCR2 is unavailable; earlier validated content was retained." : code === "COMPLEX_PARSE_UNAVAILABLE" ? "Complex page recovery is unavailable; earlier validated content was retained." : "Page recovery produced a warning; the best validated result was retained.";
}

export function pageTextBlock(input: { readonly request: MaterialParseRequest; readonly pageNumber: number; readonly stage: PageStage; readonly text: string; readonly quality?: Partial<PageQualitySignals>; readonly adapterId?: string; readonly adapterVersion?: string; readonly runtimeRevision?: string }): PageCandidate {
  const text = input.text;
  const quality: PageQualitySignals = { textChars: text.length, printableRatio: printableRatio(text), confidence: input.quality?.confidence ?? (input.stage === "native" ? 1 : 0.9), structurallyInsufficient: input.quality?.structurallyInsufficient ?? false, usable: input.quality?.usable ?? text.trim().length > 0 };
  const source = pageSource(input.request, input.pageNumber);
  return {
    pageNumber: input.pageNumber,
    stage: input.stage,
    blocks: [{ id: input.stage + "-page-" + input.pageNumber, type: "paragraph", text, source }],
    quality,
    adapterId: input.adapterId ?? input.stage,
    adapterVersion: input.adapterVersion ?? "fixture",
    runtimeRevision: input.runtimeRevision ?? "fixture"
  };
}

function printableRatio(text: string): number {
  return text.length === 0 ? 0 : [...text].filter((character) => character.trim() !== "" && character.charCodeAt(0) >= 32).length / text.length;
}

export function sourceHashForText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
