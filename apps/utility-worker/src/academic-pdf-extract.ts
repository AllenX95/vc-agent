import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { UtilityJobCommand, UtilityJobEvent } from "@vc-agent/contracts";

type AcademicPdfCommand = Extract<UtilityJobCommand, { command: "academic.pdf.extract" }>;
type AcademicPdfCompleted = Extract<UtilityJobEvent, { event: "academic.pdf.extract.completed" }>;

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const HEADING = /^(abstract|introduction|background|related work|method(?:ology)?|approach|experiments?|evaluation|results?|discussion|limitations?|conclusion|references)\b/iu;

export async function extractAcademicPdf(command: AcademicPdfCommand): Promise<Omit<AcademicPdfCompleted, "schemaVersion" | "jobId" | "event">> {
  const stat = statSync(command.absolutePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PDF_BYTES) throw new Error("ACADEMIC_PDF_SIZE_REJECTED");
  const bytes = readFileSync(command.absolutePath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== command.expectedHash) throw new Error("ACADEMIC_PDF_HASH_MISMATCH");
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("ACADEMIC_PDF_INVALID");

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false });
    const document = await task.promise;
    const pageCount = document.numPages;
  const pages: Array<{ page: number; text: string }> = [];
  let usedChars = 0;
  const warnings: string[] = [];
  try {
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = normalizeText(content.items.map((item) => "str" in item ? item.str : "").join(" "));
      const remaining = command.maxChars - usedChars;
      if (remaining <= 0) {
        warnings.push("Additional PDF pages were omitted by the extraction character limit.");
        break;
      }
      const bounded = text.slice(0, remaining);
      pages.push({ page: pageNumber, text: bounded });
      usedChars += bounded.length;
      if (bounded.length < text.length) {
        warnings.push(`Page ${pageNumber} was truncated by the extraction character limit.`);
        break;
      }
    }
  } finally {
    await task.destroy();
  }

  return {
    contentHash: hash,
      pageCount,
    sections: sectionize(pages),
    warnings
  };
}

function sectionize(pages: readonly { page: number; text: string }[]): Array<{ name: string; pageFrom: number; pageTo: number; text: string }> {
  const sections: Array<{ name: string; pageFrom: number; pageTo: number; text: string }> = [];
  let current: { name: string; pageFrom: number; pageTo: number; chunks: string[] } | undefined;
  for (const page of pages) {
    const heading = detectHeading(page.text);
    if (current === undefined || heading !== undefined) {
      if (current !== undefined) sections.push({ name: current.name, pageFrom: current.pageFrom, pageTo: current.pageTo, text: current.chunks.join("\n") });
      current = { name: heading ?? (page.page === 1 ? "Paper beginning" : `Pages ${page.page}`), pageFrom: page.page, pageTo: page.page, chunks: [page.text] };
    } else {
      current.pageTo = page.page;
      current.chunks.push(page.text);
    }
  }
  if (current !== undefined) sections.push({ name: current.name, pageFrom: current.pageFrom, pageTo: current.pageTo, text: current.chunks.join("\n") });
  return sections.slice(0, 50);
}

function detectHeading(text: string): string | undefined {
  const beginning = text.slice(0, 160).replace(/^\d+(?:\.\d+)*\s*/u, "").trim();
  const match = HEADING.exec(beginning);
  return match?.[1] === undefined ? undefined : titleCase(match[1]);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}
