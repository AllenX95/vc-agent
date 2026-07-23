import { describe, expect, it } from "vitest";
import { PageRecoveryPipeline, PageRecoveryError, pageTextBlock, sourceHashForText, type MaterialParseRequest, type PageCandidate } from "@vc-agent/host-services";

function request(): MaterialParseRequest {
  return { parseId: "00000000-0000-4000-8000-000000000001", material: { id: "00000000-0000-4000-8000-000000000002", projectId: "00000000-0000-4000-8000-000000000003", relativePath: "report.pdf", mediaType: "application/pdf", sourceHash: sourceHashForText("report") }, pageCount: 3 };
}

function candidate(input: MaterialParseRequest, pageNumber: number, stage: "native" | "paddle" | "ovis", text: string, quality: Partial<PageCandidate["quality"]> = {}): PageCandidate {
  return pageTextBlock({ request: input, pageNumber, stage, text, quality, adapterId: stage === "native" ? "pymupdf" : stage === "paddle" ? "paddleocr" : "ovisocr2", adapterVersion: "fixture-v1", runtimeRevision: "fixture-runtime" });
}

function availability(status: "ready" | "unavailable" = "ready") {
  return { status, message: status === "ready" ? "fixture ready" : "fixture unavailable" };
}

describe("Page Recovery Pipeline", () => {
  it("retains native pages, routes missing pages to Paddle, and structurally escalates to Ovis", async () => {
    const input = request();
    const paddlePages: number[] = [];
    const ovisPages: number[] = [];
    const pipeline = new PageRecoveryPipeline({
      native: {
        parse: async () => ({ pageCount: 3, pages: [
          candidate(input, 1, "native", "native page with enough reliable extracted text"),
          candidate(input, 2, "native", "", { usable: false, textChars: 0 }),
          candidate(input, 3, "native", "", { usable: false, textChars: 0 })
        ] }),
        inspectAvailability: () => availability()
      },
      paddle: {
        id: "paddleocr", version: "fixture-1", runtimeRevision: "cpu-v1",
        recover: async ({ pageNumber }) => { paddlePages.push(pageNumber); return candidate(input, pageNumber, "paddle", "paddle page " + pageNumber, { structurallyInsufficient: pageNumber === 3 }); },
        inspectAvailability: () => availability()
      },
      ovis: {
        id: "ovisocr2", version: "fixture-1", runtimeRevision: "cpu-v1",
        recover: async ({ pageNumber }) => { ovisPages.push(pageNumber); return candidate(input, pageNumber, "ovis", "ovis complex page"); },
        inspectAvailability: () => availability()
      }
    });
    const result = await pipeline.parse(input);
    expect(paddlePages).toEqual([2, 3]);
    expect(ovisPages).toEqual([3]);
    expect(result.blocks.map((block) => block.text)).toEqual(["native page with enough reliable extracted text", "paddle page 2", "ovis complex page"]);
    expect(result.structure).toMatchObject({ kind: "pages", unitCount: 3 });
    expect(result.provenance.stages.map((stage) => stage.id)).toEqual(["pymupdf", "paddleocr", "paddleocr", "ovisocr2"]);
    expect(pipeline.telemetry()).toMatchObject({ nativePages: 1, paddlePages: 1, ovisPages: 1, pageCount: 3 });
  });

  it("retains an earlier validated candidate when Ovis fails and reports unavailable paths", async () => {
    const input = request();
    const pipeline = new PageRecoveryPipeline({
      native: {
        parse: async () => ({ pageCount: 1, pages: [candidate(input, 1, "native", "", { usable: false, textChars: 0 })] }),
        inspectAvailability: () => availability()
      },
      paddle: {
        id: "paddleocr", version: "fixture-1", runtimeRevision: "cpu-v1",
        recover: async () => candidate(input, 1, "paddle", "paddle fallback", { structurallyInsufficient: true }),
        inspectAvailability: () => availability()
      },
      ovis: {
        id: "ovisocr2", version: "fixture-1", runtimeRevision: "cpu-v1",
        recover: async () => { throw new Error("fixture crash"); },
        inspectAvailability: () => availability()
      }
    });
    const result = await pipeline.parse(input);
    expect(result.blocks[0]?.text).toBe("paddle fallback");
    expect(result.warnings.some((warning) => warning.code === "COMPLEX_PARSE_FAILED")).toBe(true);

    const unavailable = new PageRecoveryPipeline({
      native: {
        parse: async () => ({ pageCount: 1, pages: [candidate(input, 1, "native", "", { usable: false, textChars: 0 })] }),
        inspectAvailability: () => availability()
      },
      paddle: { id: "paddleocr", version: "fixture-1", runtimeRevision: "cpu-v1", recover: async () => candidate(input, 1, "paddle", "unused"), inspectAvailability: () => availability("unavailable") },
      ovis: { id: "ovisocr2", version: "fixture-1", runtimeRevision: "cpu-v1", recover: async () => candidate(input, 1, "ovis", "unused"), inspectAvailability: () => availability("unavailable") }
    });
    const missing = await unavailable.parse({ ...input, pageCount: 1 });
    expect(missing.recoveryRequests).toHaveLength(1);
    expect(missing.warnings.some((warning) => warning.code === "OCR_UNAVAILABLE")).toBe(true);
    expect(missing.warnings.some((warning) => warning.code === "COMPLEX_PARSE_UNAVAILABLE")).toBe(true);
  });

  it("rejects source changes and cancellation without remote inference", async () => {
    const input = request();
    let currentHash = input.material.sourceHash;
    const pipeline = new PageRecoveryPipeline({
      native: {
        parse: async () => ({ pageCount: 1, pages: [candidate(input, 1, "native", "native")] }),
        inspectAvailability: () => availability()
      },
      paddle: { id: "paddleocr", version: "fixture", runtimeRevision: "fixture", recover: async () => candidate(input, 1, "paddle", "unused"), inspectAvailability: () => availability() },
      ovis: { id: "ovisocr2", version: "fixture", runtimeRevision: "fixture", recover: async () => candidate(input, 1, "ovis", "unused"), inspectAvailability: () => availability() }
    });
    currentHash = sourceHashForText("changed");
    await expect(pipeline.parse({ ...input, currentSourceHash: () => currentHash })).rejects.toMatchObject({ code: "SOURCE_CHANGED_DURING_PARSE" } satisfies Partial<PageRecoveryError>);
    expect(pipeline.inspectAvailability().native.status).toBe("ready");
  });
});
