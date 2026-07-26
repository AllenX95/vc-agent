import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export interface SubAgentCompatibilityEvidenceCheck {
  readonly valid: boolean;
  readonly reason: string;
  readonly evidencePath?: string;
}

/** Validates only the redacted metadata contract emitted by sub-agent:compat. */
export function inspectSubAgentCompatibilityEvidence(input: { readonly path?: string; readonly repositoryRoot: string }): SubAgentCompatibilityEvidenceCheck {
  const evidencePath = input.path === undefined ? undefined : resolve(input.path);
  const root = resolve(input.repositoryRoot);
  if (evidencePath === undefined || !existsSync(evidencePath)) return { valid: false, reason: "Sub-Agent compatibility evidence is missing" };
  const relativePath = relative(root, evidencePath);
  if (relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !/^[A-Za-z]:/u.test(relativePath))) return { valid: false, reason: "Sub-Agent compatibility evidence must be outside the repository" };
  let parsed: unknown;
  try {
    const text = readFileSync(evidencePath, "utf8");
    if (Buffer.byteLength(text, "utf8") > 500_000) return { valid: false, reason: "Sub-Agent compatibility evidence exceeds metadata bound" };
    if (/(api[_-]?key|bearer\s+|password\s*[:=]|secret\s*[:=]|token\s*[:=])/iu.test(text)) return { valid: false, reason: "Sub-Agent compatibility evidence contains a secret-shaped value" };
    parsed = JSON.parse(text);
  } catch { return { valid: false, reason: "Sub-Agent compatibility evidence is not valid UTF-8 JSON" }; }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.sanitized !== true || parsed.kind !== "sub-agent-compatibility") return { valid: false, reason: "Sub-Agent compatibility evidence schema or sanitization marker is invalid" };
  if (typeof parsed.provider !== "string" || parsed.provider.length === 0 || typeof parsed.model !== "string" || parsed.model.length === 0 || parsed.adapter !== "desktop-agent-worker-provider-v1") return { valid: false, reason: "Sub-Agent Provider metadata is incomplete" };
  if (typeof parsed.taskCount !== "number" || parsed.taskCount < 2 || typeof parsed.attemptCount !== "number" || parsed.attemptCount < 2) return { valid: false, reason: "Sub-Agent task/attempt coverage is incomplete" };
  const workflows = parsed.workflows;
  if (!isRecord(workflows) || workflows.parallelReadOnly !== true || workflows.writeOutput !== true || workflows.parentAdoption !== true || workflows.outputCapability !== true || workflows.stopCancel !== true || workflows.budgetExhaustion !== true || workflows.providerFailure !== true) return { valid: false, reason: "Sub-Agent Provider workflow coverage is incomplete" };
  const usage = parsed.usage;
  if (!Array.isArray(usage) || usage.length < 2 || usage.some((item) => !isRecord(item) || item.status !== "completed" || typeof item.totalTokens !== "number" || item.totalTokens < 0)) return { valid: false, reason: "Sub-Agent usage evidence is invalid" };
  if (!isRecord(parsed.secretScan) || parsed.secretScan.passed !== true) return { valid: false, reason: "Sub-Agent evidence secret scan did not pass" };
  return { valid: true, reason: "validated sanitized Sub-Agent compatibility evidence", evidencePath: "external/sub-agent/compatibility.json" };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
