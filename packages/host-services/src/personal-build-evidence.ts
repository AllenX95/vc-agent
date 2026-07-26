import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export interface PackagedLifecycleEvidenceCheck {
  readonly valid: boolean;
  readonly reason: string;
  readonly evidencePath?: string;
}

/**
 * Validates the bounded metadata contract emitted by the packaged H1 runner.
 * The Personal Build Gate consumes only this redacted summary; it never reads
 * Playwright traces, screenshots, project paths, or test output bodies.
 */
export function inspectPackagedLifecycleEvidence(input: { readonly path?: string; readonly repositoryRoot: string }): PackagedLifecycleEvidenceCheck {
  const evidencePath = input.path === undefined ? undefined : resolve(input.path);
  const root = resolve(input.repositoryRoot);
  if (evidencePath === undefined || !existsSync(evidencePath)) return { valid: false, reason: "packaged lifecycle evidence is missing" };
  const relativePath = relative(root, evidencePath);
  if (relativePath === "" || (!relativePath.startsWith(".." + sep) && relativePath !== ".." && !/^[A-Za-z]:/u.test(relativePath))) return { valid: false, reason: "packaged lifecycle evidence must be outside the repository" };
  let parsed: unknown;
  try {
    const text = readFileSync(evidencePath, "utf8");
    if (Buffer.byteLength(text, "utf8") > 500_000) return { valid: false, reason: "packaged lifecycle evidence exceeds metadata bound" };
    if (/(api[_-]?key|bearer\s+|password\s*[:=]|secret\s*[:=]|token\s*[:=])/iu.test(text)) return { valid: false, reason: "packaged lifecycle evidence contains a secret-shaped value" };
    parsed = JSON.parse(text);
  } catch { return { valid: false, reason: "packaged lifecycle evidence is not valid UTF-8 JSON" }; }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.sanitized !== true || parsed.kind !== "h1-packaged-compatibility") return { valid: false, reason: "packaged lifecycle evidence schema or sanitization marker is invalid" };
  if (!isRecord(parsed.buildIdentity) || typeof parsed.buildIdentity.applicationVersion !== "string" || parsed.buildIdentity.applicationVersion.length === 0 || typeof parsed.buildIdentity.stateSchemaVersion !== "number" || !Number.isInteger(parsed.buildIdentity.stateSchemaVersion) || parsed.buildIdentity.stateSchemaVersion < 1) return { valid: false, reason: "packaged lifecycle build identity is invalid" };
  if (!isRecord(parsed.runner) || parsed.runner.mode !== "playwright-electron" || parsed.runner.status !== "ready") return { valid: false, reason: "packaged lifecycle runner marker is invalid" };
  const workflows = parsed.workflows;
  if (!Array.isArray(workflows) || !["process-tree", "external-edit", "backup-restore", "single-instance"].every((item) => workflows.includes(item))) return { valid: false, reason: "packaged lifecycle workflow coverage is incomplete" };
  const results = parsed.results;
  if (!Array.isArray(results) || results.length < 4 || ["process-tree", "external-edit", "backup-restore", "single-instance"].some((workflow) => !results.some((item) => isRecord(item) && item.workflow === workflow && item.status === "passed"))) return { valid: false, reason: "packaged lifecycle results are incomplete" };
  if (typeof parsed.testCount !== "number" || !Number.isInteger(parsed.testCount) || parsed.testCount < 4) return { valid: false, reason: "packaged lifecycle test count is invalid" };
  return { valid: true, reason: "validated packaged lifecycle evidence", evidencePath: "external/h1/packaged-lifecycle.json" };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
