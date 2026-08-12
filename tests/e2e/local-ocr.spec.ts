import { _electron as electron, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MaterialRecallSource } from "@vc-agent/host-services";
import { testEnvironment } from "./test-environment";

const runtimeRoot = process.env.VC_AGENT_OCR_RUNTIME_ROOT;

test("@real calls the validated PaddleOCR and OvisOCR2 runtimes through vc-agent", async () => {
  test.skip(runtimeRoot === undefined || !existsSync(join(runtimeRoot, "runtime-manifest.json")), "A validated local OCR runtime is required.");
  test.setTimeout(240_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-real-ocr-user-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-real-ocr-project-"));
  const root = resolve(import.meta.dirname, "../..");
  const python = join(runtimeRoot!, "paddle-venv", "Scripts", "python.exe");
  const pdfPath = join(projectDirectory, "complex-table.pdf");
  execFileSync(python, ["-c", createScannedPdfScript, pdfPath], { cwd: root, timeout: 30_000 });
  const application = await electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: testEnvironment({ VC_AGENT_REAL_OCR: "1", VC_AGENT_OCR_RUNTIME_ROOT: runtimeRoot!, VC_AGENT_OCR_DEVICE: "auto", VC_AGENT_USER_DATA_DIR: userDataDirectory, VC_AGENT_TEST_PROJECT_PATH: projectDirectory })
  });
  try {
    const window = await application.firstWindow();
    const opened = await invoke(window, "project.open") as { payload: { project: { id: string } } };
    await window.getByRole("button", { name: "Settings" }).click();
    const card = window.getByTestId("integrations-settings").locator(".integration-card").filter({ hasText: "Page Recovery / OCR" });
    await card.getByRole("button", { name: "Inspect availability" }).click();
    await expect(card).toContainText("Native: ready · Paddle: ready · Ovis: ready");
    const sourceHash = createHash("sha256").update(readFileSync(pdfPath)).digest("hex");
    const result = await invoke(window, "page_recovery.run", { materialId: randomUUID(), projectId: opened.payload.project.id, relativePath: "complex-table.pdf", mediaType: "application/pdf", sourceHash });
    expect(result).toMatchObject({ event: "integration.state.updated" });
    expect(result).toMatchObject({ payload: { state: { pageRecovery: { telemetry: { paddlePages: 0, ovisPages: 1, failures: 0, lastStatus: "completed_with_warnings" }, lastParse: { pages: [{ pageNumber: 1, selectedStage: "ovis" }] } } } } });
    await expect(card).toContainText("completed", { timeout: 30_000 });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

test("@real persists native PDF text for Agent recall without invoking OCR", async () => {
  test.skip(runtimeRoot === undefined || !existsSync(join(runtimeRoot, "runtime-manifest.json")), "A validated local OCR runtime is required.");
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-native-pdf-user-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-native-pdf-project-"));
  const root = resolve(import.meta.dirname, "../..");
  const python = join(runtimeRoot!, "paddle-venv", "Scripts", "python.exe");
  const pdfPath = join(projectDirectory, "native-agent-source.pdf");
  execFileSync(python, ["-c", "import sys,pymupdf; d=pymupdf.open(); p=d.new_page(); p.insert_text((72,72),'Native agent evidence THETA-2048'); d.save(sys.argv[1]); d.close()", pdfPath], { cwd: root, timeout: 30_000 });
  const application = await electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`], cwd: root,
    env: testEnvironment({ VC_AGENT_REAL_OCR: "1", VC_AGENT_OCR_RUNTIME_ROOT: runtimeRoot!, VC_AGENT_OCR_DEVICE: "auto", VC_AGENT_USER_DATA_DIR: userDataDirectory, VC_AGENT_TEST_PROJECT_PATH: projectDirectory })
  });
  try {
    const window = await application.firstWindow();
    const opened = await invoke(window, "project.open") as { payload: { project: { id: string } } };
    await invoke(window, "project.material.refresh", { projectId: opened.payload.project.id });
    const databasePath = join(userDataDirectory, "state.db");
    const before = new DatabaseSync(databasePath, { readOnly: true });
    const material = before.prepare("SELECT id FROM materials WHERE relative_path = 'native-agent-source.pdf'").get() as { id: string };
    before.close();
    await invoke(window, "material.parse.request", { materialId: material.id });
    const after = new DatabaseSync(databasePath, { readOnly: true });
    const record = after.prepare("SELECT parser_id, artifact_path FROM parsed_material_versions WHERE material_id = ? AND status = 'active'").get(material.id) as { parser_id: string; artifact_path: string };
    after.close();
    const artifact = JSON.parse(readFileSync(join(projectDirectory, record.artifact_path), "utf8")) as { blocks: { text?: string }[]; provenance: { stages: { id: string }[] } };
    expect(record.parser_id).toBe("page-recovery@page-quality-v1");
    expect(artifact.blocks.map((block) => block.text ?? "").join("\n")).toContain("THETA-2048");
    expect(artifact.provenance.stages.map((stage) => stage.id)).toEqual(["pymupdf"]);
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

test("@real persists Ovis recovery for Agent material recall when native text and Paddle fail", async () => {
  test.skip(runtimeRoot === undefined || !existsSync(join(runtimeRoot, "runtime-manifest.json")), "A validated local OCR runtime is required.");
  test.setTimeout(240_000);
  const root = resolve(import.meta.dirname, "../..");
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-agent-ocr-user-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-agent-ocr-project-"));
  const injectedRuntime = mkdtempSync(join(tmpdir(), "vc-agent-paddle-failure-runtime-"));
  const pdfPath = join(projectDirectory, "agent-scanned-table.pdf");
  const parserPython = join(runtimeRoot!, "paddle-venv", "Scripts", "python.exe");

  symlinkSync(join(runtimeRoot!, "ovis-venv"), join(injectedRuntime, "ovis-venv"), "junction");
  // Manifest inspection remains ready, but the Paddle stage executes in an
  // environment without paddle so this exercises the real runtime-failure path.
  symlinkSync(join(runtimeRoot!, "ovis-venv"), join(injectedRuntime, "paddle-venv"), "junction");
  symlinkSync(join(runtimeRoot!, "models"), join(injectedRuntime, "models"), "junction");
  writeFileSync(join(injectedRuntime, "runtime-manifest.json"), readFileSync(join(runtimeRoot!, "runtime-manifest.json")));
  execFileSync(parserPython, ["-c", createScannedPdfScript, pdfPath], { cwd: root, timeout: 30_000 });

  const application = await electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: testEnvironment({ VC_AGENT_REAL_OCR: "1", VC_AGENT_OCR_RUNTIME_ROOT: injectedRuntime, VC_AGENT_PYTHON: join(runtimeRoot!, "venv", "Scripts", "python.exe"), VC_AGENT_OCR_DEVICE: "auto", VC_AGENT_USER_DATA_DIR: userDataDirectory, VC_AGENT_TEST_PROJECT_PATH: projectDirectory })
  });
  try {
    const window = await application.firstWindow();
    const opened = await invoke(window, "project.open") as { payload: { project: { id: string } } };
    await invoke(window, "project.material.refresh", { projectId: opened.payload.project.id });
    const databasePath = join(userDataDirectory, "state.db");
    const before = new DatabaseSync(databasePath, { readOnly: true });
    const material = before.prepare("SELECT id FROM materials WHERE relative_path = 'agent-scanned-table.pdf'").get() as { id: string };
    before.close();

    const parsed = await invoke(window, "material.parse.request", { materialId: material.id });
    expect(parsed).toMatchObject({ event: "material.parse.completed", payload: { parserId: "page-recovery@page-quality-v1" } });

    const after = new DatabaseSync(databasePath, { readOnly: true });
    const record = after.prepare("SELECT parser_id, artifact_path FROM parsed_material_versions WHERE material_id = ? AND status = 'active'").get(material.id) as { parser_id: string; artifact_path: string };
    after.close();
    expect(record.parser_id).toBe("page-recovery@page-quality-v1");
    const artifact = JSON.parse(readFileSync(join(projectDirectory, record.artifact_path), "utf8")) as { blocks: { text?: string }[]; provenance: { stages: { id: string; status: string }[] } };
    expect(artifact.blocks.map((block) => block.text ?? "").join("\n")).toContain("VC Agent Portfolio Review");
    expect(artifact.provenance.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "paddleocr-local", status: "failed" }),
      expect.objectContaining({ id: "ovisocr2-local", status: "completed" })
    ]));
    const inventory = await invoke(window, "project.material.list", { projectId: opened.payload.project.id }) as { payload: { materials: unknown[] } };
    const recalled = await new MaterialRecallSource({
      listMaterials: () => inventory.payload.materials as never[],
      loadParse: async () => artifact as never
    }).recall({ disclosureLevel: "full", materialId: material.id }, { turnId: randomUUID(), maxItems: 20, maxChars: 20_000, retrievedAt: new Date().toISOString() });
    expect(recalled.items.map((item) => item.content).join("\n")).toContain("VC Agent Portfolio Review");
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
    rmSync(injectedRuntime, { recursive: true, force: true });
  }
});

async function invoke(window: import("@playwright/test").Page, command: string, payload?: unknown): Promise<unknown> {
  return window.evaluate(async ({ name, payload }) => (window as unknown as { vcAgent: { invoke(command: unknown): Promise<unknown> } }).vcAgent.invoke({
    schemaVersion: 1, command: name, commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actor: { actorType: "user", actorId: "real-ocr-e2e" }, sentAt: new Date().toISOString(), ...(payload === undefined ? {} : { payload })
  }), { name: command, payload });
}

const createScannedPdfScript = `
import io, sys
import pymupdf
from PIL import Image, ImageDraw, ImageFont
image = Image.new("RGB", (1200, 1600), "white")
draw = ImageDraw.Draw(image)
font = ImageFont.load_default(size=30)
draw.text((80, 70), "VC Agent Portfolio Review", fill="black", font=font)
left, top, width, height = 80, 180, 1040, 480
for row in range(5):
    y = top + row * height // 4
    draw.line((left, y, left + width, y), fill="black", width=3)
for col in range(5):
    x = left + col * width // 4
    draw.line((x, top, x, top + height), fill="black", width=3)
values = [["Company", "2024", "2025", "2026"], ["Alpha", "100", "125", "150"], ["Beta", "80", "110", "140"], ["Gamma", "60", "90", "130"]]
for row, values_row in enumerate(values):
    for col, value in enumerate(values_row):
        draw.text((left + col * width // 4 + 22, top + row * height // 4 + 38), value, fill="black", font=font)
buffer = io.BytesIO()
image.save(buffer, format="PNG")
document = pymupdf.open()
page = document.new_page(width=600, height=800)
page.insert_image(page.rect, stream=buffer.getvalue())
document.save(sys.argv[1])
document.close()
`;
