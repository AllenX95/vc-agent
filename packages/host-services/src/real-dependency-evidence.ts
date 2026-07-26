import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type RealDependencyKind = "office" | "ocr" | "mcp";

export interface RealDependencyEvidenceCheck {
  readonly kind: RealDependencyKind;
  readonly valid: boolean;
  readonly reason: string;
  readonly evidencePath?: string;
}

/**
 * Validates the small, sanitized evidence contract consumed by G3-T-011.
 * The gate intentionally reads metadata only; it never imports a Skill, starts
 * an OCR model, connects MCP, or executes an Office task.
 */
export function inspectRealDependencyEvidence(input: { readonly kind: RealDependencyKind; readonly path?: string; readonly repositoryRoot: string }): RealDependencyEvidenceCheck {
  const evidencePath = input.path === undefined ? undefined : resolve(input.path);
  const root = resolve(input.repositoryRoot);
  if (evidencePath === undefined || !existsSync(evidencePath)) return { kind: input.kind, valid: false, reason: "evidence file is missing" };
  if (evidencePath === root || evidencePath.startsWith(root + "\\") || evidencePath.startsWith(root + "/")) return { kind: input.kind, valid: false, reason: "evidence must be outside the repository" };
  let parsed: unknown;
  try {
    const text = readFileSync(evidencePath, "utf8");
    if (Buffer.byteLength(text, "utf8") > 2_000_000) return { kind: input.kind, valid: false, reason: "evidence exceeds metadata bound" };
    if (/(api[_-]?key|bearer\s+|password\s*[:=]|secret\s*[:=]|token\s*[:=])/iu.test(text)) return { kind: input.kind, valid: false, reason: "evidence contains a secret-shaped value" };
    parsed = JSON.parse(text);
  } catch { return { kind: input.kind, valid: false, reason: "evidence is not valid UTF-8 JSON" }; }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.sanitized !== true || parsed.kind !== `${input.kind}-compatibility`) return { kind: input.kind, valid: false, reason: "evidence schema or sanitization marker is invalid" };
  const valid = input.kind === "ocr" ? validOcrEvidence(parsed) : input.kind === "office" ? validOfficeEvidence(parsed) : validMcpEvidence(parsed);
  return valid ? { kind: input.kind, valid: true, reason: "validated sanitized compatibility evidence", evidencePath: `external/${input.kind}/compatibility.json` } : { kind: input.kind, valid: false, reason: `${input.kind} compatibility evidence is incomplete` };
}

function validOcrEvidence(value: Record<string, unknown>): boolean {
  const devices = value.validatedDevices;
  if (!Array.isArray(devices) || !devices.includes("cpu") || !devices.includes("cuda")) return false;
  for (const stage of ["paddle", "ovis"]) {
    const report = value[stage];
    if (!isRecord(report) || !Array.isArray(report.results)) return false;
    const results = report.results.filter(isRecord);
    if (results.length < 4 || !devices.every((device) => results.filter((item) => item.device === device).length >= 2)) return false;
    if (results.some((item) => typeof item.textChars !== "number" || item.textChars <= 0 || typeof item.durationMs !== "number" || item.durationMs < 0 || !Array.isArray(item.warnings))) return false;
  }
  return typeof value.runtimeRevision === "string" && value.runtimeRevision.length > 0;
}

function validOfficeEvidence(value: Record<string, unknown>): boolean {
  if (typeof value.sourceRevision !== "string" || value.sourceRevision.length === 0 || !hasWorkflowSet(value.workflows, ["create", "edit", "replace"])) return false;
  const packageIds = value.packageIds;
  const formats = value.formats;
  const runner = value.runner;
  const provider = value.provider;
  const results = value.results;
  if (!Array.isArray(packageIds) || packageIds.length === 0 || packageIds.some((item) => typeof item !== "string" || item.length === 0)) return false;
  if (!Array.isArray(formats) || formats.length === 0 || formats.some((item) => !["docx", "pptx", "xlsx", "pdf"].includes(String(item)))) return false;
  if (!isRecord(runner) || runner.mode !== "external-stdin-manifest" || runner.status !== "ready") return false;
  if (!isRecord(provider) || provider.kind !== "microsoft-office" || provider.application !== "word" || typeof provider.version !== "string" || !/^\d+(?:\.\d+){0,3}$/u.test(provider.version)) return false;
  if (!Array.isArray(results)) return false;
  return ["create", "edit", "replace"].every((workflow) => results.some((item) => isRecord(item) && item.workflow === workflow && ((workflow === "replace" && item.status === "replaced") || (workflow !== "replace" && item.status === "validated"))));
}

function validMcpEvidence(value: Record<string, unknown>): boolean {
  return typeof value.adapterVersion === "string" && value.adapterVersion.length > 0 && typeof value.packageRevision === "string" && value.packageRevision.length > 0 && hasWorkflowSet(value.workflows, ["lazy-read", "confirmed-write", "restart"]);
}

function hasWorkflowSet(value: unknown, required: readonly string[]): boolean {
  return Array.isArray(value) && required.every((item) => value.includes(item));
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
