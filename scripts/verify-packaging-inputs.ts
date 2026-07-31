import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = process.cwd();
const requiredFiles = [
  "package.json",
  "electron-builder.yml",
  "node_modules/electron/dist/electron.exe",
  "apps/desktop/dist/main/main.js",
  "apps/desktop/dist/preload/preload.js",
  "apps/desktop/dist/renderer/index.html",
  "apps/agent-worker/dist/index.js",
  "apps/agent-worker/package.json",
  "apps/utility-worker/dist/index.js",
  "apps/utility-worker/dist/parser.py",
  "apps/utility-worker/dist/ocr_runtime.py",
  "apps/utility-worker/package.json",
  "skills/academic-research/paper-technical-diligence/SKILL.md",
  "skills/academic-research/founder-academic-diligence/SKILL.md",
  "skills/academic-research/technical-claim-verification/SKILL.md",
  "skills/academic-research/novelty-and-prior-art-map/SKILL.md",
  "skills/academic-research/research-to-company-map/SKILL.md",
  "packaging/parser-runtime/python.exe",
  "packaging/parser-runtime/runtime-manifest.json",
  "packaging/THIRD_PARTY_NOTICES.txt"
] as const;

const missing = requiredFiles.filter((path) => !existsSync(resolve(root, path)));
if (missing.length > 0) throw new Error(`PACKAGING_INPUT_MISSING:${missing.join(",")}`);

const manifest = JSON.parse(readFileSync(resolve(root, "packaging/parser-runtime/runtime-manifest.json"), "utf8").replace(/^\uFEFF/u, "")) as {
  schemaVersion?: unknown;
  kind?: unknown;
  architecture?: unknown;
};
if (manifest.schemaVersion !== 1 || manifest.kind !== "vc-agent-parser-runtime" || manifest.architecture !== "x64") {
  throw new Error("PACKAGING_PARSER_MANIFEST_INVALID");
}

const parserPython = resolve(root, "packaging/parser-runtime/python.exe");
const parserCheck = spawnSync(parserPython, ["-c", "import fitz, docx, pptx, openpyxl, yaml"], {
  windowsHide: true,
  encoding: "utf8",
  timeout: 30_000
});
if (parserCheck.status !== 0) throw new Error(`PACKAGING_PARSER_RUNTIME_INVALID:${sanitize(parserCheck.stderr)}`);

const workerFiles = listFiles(resolve(root, "apps/agent-worker/dist"));
const externalWorkspaceImports = workerFiles
  .filter((path) => path.endsWith(".js"))
  .filter((path) => /(?:from\s+|import\s*\()\s*["']@(?:vc-agent|earendil-works)\//u.test(readFileSync(path, "utf8")));
if (externalWorkspaceImports.length > 0) throw new Error("PACKAGING_AGENT_WORKER_HAS_EXTERNAL_WORKSPACE_IMPORTS");

const sizes = {
  desktopMb: directoryBytes(resolve(root, "apps/desktop/dist")) / 1024 / 1024,
  agentWorkerMb: directoryBytes(resolve(root, "apps/agent-worker/dist")) / 1024 / 1024,
  utilityWorkerMb: directoryBytes(resolve(root, "apps/utility-worker/dist")) / 1024 / 1024,
  parserRuntimeMb: directoryBytes(resolve(root, "packaging/parser-runtime")) / 1024 / 1024
};
console.log(JSON.stringify({
  status: "pass",
  architecture: "x64",
  packagedFiles: requiredFiles.length,
  sizesMb: Object.fromEntries(Object.entries(sizes).map(([key, value]) => [key, Number(value.toFixed(2))]))
}, null, 2));

function listFiles(rootPath: string): string[] {
  return readdirSync(rootPath, { withFileTypes: true }).flatMap((entry) => {
    const path = join(rootPath, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function directoryBytes(rootPath: string): number {
  return listFiles(rootPath).reduce((total, path) => total + statSync(path).size, 0);
}

function sanitize(value: string): string {
  return value.replace(/[A-Za-z]:\\[^\s,;]+/gu, "<local-path>").slice(-1_000);
}
