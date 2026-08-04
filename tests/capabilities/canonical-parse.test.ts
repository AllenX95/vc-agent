import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalParseSchema, type CanonicalParse } from "@vc-agent/contracts";
import { BASELINE_PARSER_ADAPTERS, expectedParserIdentity } from "@vc-agent/host-services";
import { resolveParserPython } from "../../apps/utility-worker/src/python-runtime";

const directories: string[] = [];
const parserPath = resolve("apps/utility-worker/src/parser.py");
const parserPython = resolveParserPython();

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

beforeAll(() => {
  const check = spawnSync(parserPython, ["-c", "import pymupdf, docx, pptx, openpyxl, yaml"], { encoding: "utf8" });
  if (check.status !== 0) throw new Error(`Pinned parser dependencies are unavailable via ${parserPython}: ${check.stderr}`);
});

describe("Canonical Parse adapters", () => {
  it("registers stable identities separately from concrete parser runtimes", () => {
    expect(BASELINE_PARSER_ADAPTERS).toHaveLength(9);
    expect(expectedParserIdentity(".PDF")).toBe("pymupdf@1.28.0");
    expect(BASELINE_PARSER_ADAPTERS.find((adapter) => adapter.id === "pymupdf")?.pageRecovery).toBe("request_when_needed");
  });

  it("normalizes text, OpenXML, spreadsheet, and PDF formats into one contract", () => {
    const directory = mkdtempSync(join(tmpdir(), "vc-agent-parsers-"));
    directories.push(directory);
    const fixtureScript = `
import sys, pymupdf
from docx import Document
from pptx import Presentation
from openpyxl import Workbook
root=sys.argv[1]
d=Document(); d.add_heading('Thesis', 1); d.add_paragraph('Document evidence'); d.add_table(1,2).rows[0].cells[0].text='Metric'; d.save(root+'/memo.docx')
p=Presentation(); s=p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text='Market'; s.placeholders[1].text='Slide evidence'; p.save(root+'/deck.pptx')
w=Workbook(); ws=w.active; ws.title='Metrics'; ws.append(['Year','Revenue']); ws.append([2026,10]); w.save(root+'/model.xlsx')
pdf=pymupdf.open(); page=pdf.new_page(); page.insert_text((72,72),'Native PDF investment evidence'); pdf.new_page(); pdf.save(root+'/report.pdf')
`;
    expect(spawnSync(parserPython, ["-c", fixtureScript, directory], { encoding: "utf8" }).status).toBe(0);
    writeFileSync(join(directory, "memo.md"), "# Thesis\nMarkdown evidence");
    writeFileSync(join(directory, "data.csv"), "Year,Revenue\n2026,10");
    writeFileSync(join(directory, "facts.json"), '{"company":"Acme"}');
    writeFileSync(join(directory, "facts.yaml"), "company: Acme");

    const results = ["memo.md", "data.csv", "facts.json", "facts.yaml", "memo.docx", "deck.pptx", "model.xlsx", "report.pdf"].map((name) => runParser(directory, name));
    for (const result of results) expect(canonicalParseSchema.safeParse(result).success).toBe(true);
    expect(results.map((result) => result.parser.id)).toEqual(["text", "csv", "json", "pyyaml", "python-docx", "python-pptx", "openpyxl", "pymupdf"]);
    const pdf = results.at(-1)!;
    expect(pdf.structure).toMatchObject({ kind: "pages", unitCount: 2 });
    expect(pdf.blocks.some((block) => block.source.locator.geometry !== undefined)).toBe(true);
    expect(pdf.blocks.some((block) => (block.tokens?.length ?? 0) > 0)).toBe(true);
    expect(pdf.recoveryRequests).toMatchObject([{ reason: "missing_text", status: "unavailable" }]);
    expect(pdf.warnings).toMatchObject([{ code: "OCR_UNAVAILABLE" }]);
  }, 20_000);

  it("contains malformed input failure without poisoning a later parse", () => {
    const directory = mkdtempSync(join(tmpdir(), "vc-agent-parser-failure-"));
    directories.push(directory);
    writeFileSync(join(directory, "broken.json"), "{not-json");
    writeFileSync(join(directory, "good.txt"), "Usable evidence");
    expect(() => runParser(directory, "broken.json")).toThrow(/JSONDecodeError/);
    expect(runParser(directory, "good.txt").blocks[0]?.text).toBe("Usable evidence");
  });
});

function runParser(directory: string, name: string): CanonicalParse {
  const absolutePath = join(directory, name);
  const sourceHash = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  const command = { schemaVersion: 1, jobId: crypto.randomUUID(), command: "material.parse", material: { id: crypto.randomUUID(), projectId: crypto.randomUUID(), relativePath: name, mediaType: "application/octet-stream", sourceHash, absolutePath }, stagingDirectory: join(directory, "stage"), timeoutMs: 30_000, maxOutputBytes: 10_000_000 };
  const result = spawnSync(parserPython, [parserPath], { input: JSON.stringify(command), encoding: "utf8", maxBuffer: 10_000_000 });
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return canonicalParseSchema.parse(JSON.parse(result.stdout));
}
