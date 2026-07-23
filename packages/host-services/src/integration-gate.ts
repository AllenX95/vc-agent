import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

export type DoctorComponent = "piAdapter" | "profiles" | "credentialReferences" | "storage" | "migration" | "scheduler" | "agentRuntime" | "utilityRuntime" | "isolatedRuntime" | "skills" | "office" | "ocr" | "mcp" | "extensionRevision" | "backup";
export type DoctorStatus = "ready" | "attention" | "unavailable";

export interface EnvironmentDoctorEntry {
  readonly status: DoctorStatus;
  readonly message: string;
  readonly activationObserved: false;
}

export type EnvironmentDoctorInventory = Readonly<Record<DoctorComponent, EnvironmentDoctorEntry>>;

export interface EnvironmentDoctorInput {
  readonly [component: string]: { readonly status: DoctorStatus; readonly message: string };
}

export interface GateScenarioResult {
  readonly testId: string;
  readonly scenario: string;
  readonly status: "pass" | "fail" | "blocked";
  readonly durationMs: number;
  readonly evidencePath?: string;
  readonly warning?: string;
}

export interface IntegrationGateReportInput {
  readonly buildIdentity: { readonly applicationVersion: string; readonly buildRevision?: string; readonly stateSchemaVersion: number };
  readonly environmentDoctor: EnvironmentDoctorInventory;
  readonly scenarios: readonly GateScenarioResult[];
  readonly migrationVersions: readonly number[];
  readonly warnings?: readonly string[];
  readonly unavailableDependencies?: readonly string[];
  readonly deferredScope?: readonly string[];
  readonly evidenceRoot?: string;
  readonly secretScanInputs?: readonly string[];
  readonly now?: string;
}

export interface IntegrationGateReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly buildIdentity: { readonly applicationVersion: string; readonly buildRevision?: string; readonly stateSchemaVersion: number };
  readonly stateSchema: { readonly currentVersion: number; readonly migrationVersions: readonly number[] };
  readonly environmentDoctor: EnvironmentDoctorInventory;
  readonly executedTests: readonly GateScenarioResult[];
  readonly evidencePaths: readonly string[];
  readonly zeroSecretScan: { readonly passed: boolean; readonly checkedValues: number };
  readonly warnings: readonly string[];
  readonly unavailableDependencies: readonly string[];
  readonly deferredScope: readonly string[];
  readonly decision: "pass" | "fail" | "blocked";
}

export interface IntegrationGateArtifacts {
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly report: IntegrationGateReport;
}

const DOCTOR_COMPONENTS: readonly DoctorComponent[] = ["piAdapter", "profiles", "credentialReferences", "storage", "migration", "scheduler", "agentRuntime", "utilityRuntime", "isolatedRuntime", "skills", "office", "ocr", "mcp", "extensionRevision", "backup"];

/** Read-only, activation-free Environment Doctor projection for the Integration Gate and Settings surfaces. */
export function inspectEnvironmentDoctor(input: EnvironmentDoctorInput): EnvironmentDoctorInventory {
  return Object.fromEntries(DOCTOR_COMPONENTS.map((component) => {
    const supplied = input[component];
    const status = supplied?.status ?? "unavailable";
    const message = sanitizeDiagnostic(supplied?.message ?? "No local diagnostic was supplied.");
    return [component, { status, message, activationObserved: false as const }];
  })) as EnvironmentDoctorInventory;
}

/** Writes only sanitized, machine-readable evidence and a short human-readable gate summary. */
export function writeIntegrationGateReport(root: string, input: IntegrationGateReportInput): IntegrationGateArtifacts {
  const outputRoot = resolve(root);
  mkdirSync(outputRoot, { recursive: true });
  const scenarios = input.scenarios.map((scenario) => ({
    testId: scenario.testId, scenario: sanitizeDiagnostic(scenario.scenario), status: scenario.status, durationMs: Math.max(0, Math.round(scenario.durationMs)),
    ...(scenario.evidencePath === undefined ? {} : { evidencePath: safeEvidencePath(scenario.evidencePath, input.evidenceRoot) }),
    ...(scenario.warning === undefined ? {} : { warning: sanitizeDiagnostic(scenario.warning) })
  }));
  const rawWarnings = [...(input.warnings ?? []), ...scenarios.filter((scenario) => scenario.warning !== undefined).map((scenario) => scenario.warning!)];
  const rawUnavailableDependencies = [...(input.unavailableDependencies ?? [])];
  const rawDeferredScope = [...(input.deferredScope ?? [])];
  const warnings = rawWarnings.map(sanitizeDiagnostic);
  const unavailableDependencies = rawUnavailableDependencies.map(sanitizeDiagnostic);
  const deferredScope = rawDeferredScope.map(sanitizeDiagnostic);
  const scanValues = [...(input.secretScanInputs ?? []), ...rawWarnings, ...rawUnavailableDependencies, ...rawDeferredScope];
  const zeroSecretScan = { passed: !scanValues.some(containsSecret), checkedValues: scanValues.length };
  const decision = !zeroSecretScan.passed || scenarios.some((scenario) => scenario.status === "fail") ? "fail" : scenarios.some((scenario) => scenario.status === "blocked") ? "blocked" : "pass";
  const report: IntegrationGateReport = {
    schemaVersion: 1, generatedAt: input.now ?? new Date().toISOString(),
    buildIdentity: { ...input.buildIdentity, ...(input.buildIdentity.buildRevision === undefined ? {} : { buildRevision: sanitizeDiagnostic(input.buildIdentity.buildRevision) }) },
    stateSchema: { currentVersion: input.buildIdentity.stateSchemaVersion, migrationVersions: [...new Set(input.migrationVersions)].sort((left, right) => left - right) },
    environmentDoctor: inspectEnvironmentDoctor(input.environmentDoctor), executedTests: scenarios, evidencePaths: [...new Set(scenarios.flatMap((scenario) => scenario.evidencePath === undefined ? [] : [scenario.evidencePath]))], zeroSecretScan,
    warnings, unavailableDependencies, deferredScope, decision
  };
  const jsonPath = resolve(outputRoot, "integration-gate-report.json");
  const markdownPath = resolve(outputRoot, "integration-gate-summary.md");
  atomicWrite(jsonPath, JSON.stringify(report, null, 2) + "\n");
  atomicWrite(markdownPath, markdownSummary(report));
  return { jsonPath, markdownPath, report };
}

export function doctorIsActivationFree(inventory: EnvironmentDoctorInventory): boolean { return Object.values(inventory).every((entry) => entry.activationObserved === false); }

function markdownSummary(report: IntegrationGateReport): string {
  const scenarioRows = report.executedTests.length === 0 ? "| — | — | — |\n|---|---|---|\n" : report.executedTests.map((scenario) => `| ${scenario.testId} | ${scenario.status} | ${scenario.durationMs} ms |`).join("\n") + "\n";
  const doctorRows = Object.entries(report.environmentDoctor).map(([component, entry]) => `| ${component} | ${entry.status} | ${entry.message} |`).join("\n");
  return [
    "# Integration Gate Summary", "", `Decision: **${report.decision}**`, "", `Generated: ${report.generatedAt}`, `Build: ${report.buildIdentity.applicationVersion} · state schema ${report.buildIdentity.stateSchemaVersion}`, "",
    "## Scenarios", "", "| Test | Status | Duration |", "|---|---|---|", scenarioRows.trimEnd(), "", "## Environment Doctor", "", "| Component | Status | Diagnostic |", "|---|---|---|", doctorRows, "",
    "## Security", "", `- Zero-secret scan: ${report.zeroSecretScan.passed ? "passed" : "failed"}`, `- Evidence paths: ${report.evidencePaths.length} sanitized relative path(s).`, `- Unavailable dependencies: ${report.unavailableDependencies.length}`, "",
    "## Warnings / Deferred Scope", "", ...(report.warnings.length === 0 ? ["- None"] : report.warnings.map((warning) => "- " + warning)), ...(report.deferredScope.length === 0 ? ["- No deferred scope recorded"] : report.deferredScope.map((item) => "- Deferred: " + item)), ""
  ].join("\n");
}

function atomicWrite(path: string, content: string): void { const partial = path + ".partial"; writeFileSync(partial, content, "utf8"); renameSync(partial, path); }

function safeEvidencePath(path: string, evidenceRoot: string | undefined): string {
  const candidate = evidenceRoot === undefined ? path : relative(resolve(evidenceRoot), resolve(path));
  const normalized = candidate.replaceAll("\\", "/");
  if (normalized === "" || normalized === "." || normalized === ".." || normalized.startsWith("../") || /^[A-Za-z]:/u.test(normalized) || normalized.startsWith("/")) return "evidence/invalid-path";
  return normalized.slice(0, 240);
}

function sanitizeDiagnostic(value: string): string {
  return value.replace(/[A-Za-z]:\\[^\s,;]+|(?:\\\\|\/)(?:Users|home|tmp|var|private)[^\s,;]*/giu, "<local-path>").replace(/(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*[^\s,;]+/giu, "<redacted>").slice(0, 400);
}

function containsSecret(value: string): boolean { return /(api[_-]?key|bearer\s+|password\s*[:=]|secret\s*[:=]|token\s*[:=])/iu.test(value); }
