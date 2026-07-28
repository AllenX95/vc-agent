import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractAcademicPdf } from "../../apps/utility-worker/src/academic-pdf-extract.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("academic PDF extraction boundary", () => {
  it("rejects a staged file whose bytes do not match the Host hash", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-academic-pdf-"));
    roots.push(root);
    const path = join(root, "paper.pdf");
    const bytes = Buffer.from("%PDF-not-a-real-pdf");
    writeFileSync(path, bytes);
    await expect(extractAcademicPdf({
      schemaVersion: 1,
      command: "academic.pdf.extract",
      jobId: "11111111-1111-4111-8111-111111111111",
      absolutePath: path,
      expectedHash: createHash("sha256").update("different").digest("hex"),
      maxChars: 8_000,
      timeoutMs: 10_000,
      maxOutputBytes: 100_000
    })).rejects.toThrow("ACADEMIC_PDF_HASH_MISMATCH");
  });
});

