import { _electron as electron, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
