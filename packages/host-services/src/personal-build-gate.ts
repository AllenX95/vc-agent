import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type PersonalBuildGateStatus = "pass" | "fail" | "blocked";
export type PersonalBuildExecutionMode = "deterministic" | "real_dependency" | "unavailable" | "migration_recovery" | "crash_cancellation";

export interface PersonalBuildScenarioResult {
  readonly testId: string;
  readonly suite: string;
  readonly mode: PersonalBuildExecutionMode;
  readonly status: PersonalBuildGateStatus;
  readonly durationMs: number;
  readonly evidencePaths?: readonly string[];
  readonly warning?: string;
}

export interface PersonalBuildAcceptanceCriterion {
  readonly criterionId: string;
  readonly requirement: string;
  readonly status: PersonalBuildGateStatus;
  readonly evidence: readonly string[];
  readonly note?: string;
}

export interface PersonalBuildDependency {
  readonly name: string;
  readonly status: "ready" | "attention" | "unavailable";
  readonly version?: string;
  readonly evidence?: string;
}

export interface PersonalBuildGateInput {
  readonly buildIdentity: { readonly applicationVersion: string; readonly buildRevision?: string; readonly stateSchemaVersion: number };
  readonly migrationVersions: readonly number[];
  readonly dependencyInventory: readonly PersonalBuildDependency[];
  readonly environmentDoctor: Readonly<Record<string, { readonly status: "ready" | "attention" | "unavailable"; readonly message: string; readonly activationObserved?: false }>>;
  readonly scenarios: readonly PersonalBuildScenarioResult[];
  readonly executionModes: Readonly<Record<PersonalBuildExecutionMode, { readonly status: PersonalBuildGateStatus; readonly scenarioIds: readonly string[]; readonly note?: string }>>;
  readonly acceptanceMatrix: readonly PersonalBuildAcceptanceCriterion[];
  readonly warnings?: readonly string[];
  readonly unavailableDependencies?: readonly string[];
  readonly deferredScope?: readonly string[];
  readonly evidenceRoot?: string;
  readonly secretScanInputs?: readonly string[];
  readonly now?: string;
}

export interface PersonalBuildGateReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly buildIdentity: PersonalBuildGateInput["buildIdentity"];
  readonly stateSchema: { readonly currentVersion: number; readonly migrationVersions: readonly number[] };
  readonly dependencyInventory: readonly PersonalBuildDependency[];
  readonly environmentDoctor: Readonly<Record<string, { readonly status: "ready" | "attention" | "unavailable"; readonly message: string; readonly activationObserved: false }>>;
  readonly executedTests: readonly PersonalBuildScenarioResult[];
  readonly executionModes: PersonalBuildGateInput["executionModes"];
  readonly acceptanceMatrix: readonly PersonalBuildAcceptanceCriterion[];
  readonly evidencePaths: readonly string[];
  readonly zeroSecretScan: { readonly passed: boolean; readonly checkedValues: number };
  readonly warnings: readonly string[];
  readonly unavailableDependencies: readonly string[];
  readonly deferredScope: readonly string[];
  readonly decision: PersonalBuildGateStatus;
}

export interface PersonalBuildGateArtifacts { readonly jsonPath: string; readonly markdownPath: string; readonly report: PersonalBuildGateReport; }

export function writePersonalBuildGateReport(root: string, input: PersonalBuildGateInput): PersonalBuildGateArtifacts {
  const outputRoot = resolve(root);
  mkdirSync(outputRoot, { recursive: true });
  const scenarios = input.scenarios.map((scenario) => ({
    testId: scenario.testId, suite: sanitize(scenario.suite), mode: scenario.mode, status: scenario.status, durationMs: Math.max(0, Math.round(scenario.durationMs)),
    ...(scenario.evidencePaths === undefined ? {} : { evidencePaths: scenario.evidencePaths.map((path) => safeEvidencePath(path, input.evidenceRoot)) }),
    ...(scenario.warning === undefined ? {} : { warning: sanitize(scenario.warning) })
  }));
  const matrix = input.acceptanceMatrix.map((criterion) => ({ criterionId: criterion.criterionId, requirement: sanitize(criterion.requirement), status: criterion.status, evidence: criterion.evidence.map(sanitize), ...(criterion.note === undefined ? {} : { note: sanitize(criterion.note) }) }));
  const dependencies = input.dependencyInventory.map((dependency) => ({ name: sanitize(dependency.name), status: dependency.status, ...(dependency.version === undefined ? {} : { version: sanitize(dependency.version) }), ...(dependency.evidence === undefined ? {} : { evidence: sanitize(dependency.evidence) }) }));
  const warnings = [...(input.warnings ?? []), ...scenarios.flatMap((scenario) => scenario.warning === undefined ? [] : [scenario.warning])].map(sanitize);
  const unavailableDependencies = (input.unavailableDependencies ?? []).map(sanitize);
  const deferredScope = (input.deferredScope ?? []).map(sanitize);
  const scanValues = [...(input.secretScanInputs ?? []), ...warnings, ...unavailableDependencies, ...deferredScope, ...dependencies.flatMap((item) => [item.name, item.version ?? "", item.evidence ?? ""]), ...matrix.flatMap((item) => item.evidence)];
  const zeroSecretScan = { passed: !scanValues.some(containsSecret), checkedValues: scanValues.length };
  const matrixBlocked = matrix.some((item) => item.status === "blocked");
  const matrixFailed = matrix.some((item) => item.status === "fail");
  const decision: PersonalBuildGateStatus = !zeroSecretScan.passed || matrixFailed || scenarios.some((item) => item.status === "fail") ? "fail" : matrixBlocked || scenarios.some((item) => item.status === "blocked") ? "blocked" : "pass";
  const doctor = Object.fromEntries(Object.entries(input.environmentDoctor).map(([name, entry]) => [sanitize(name), { status: entry.status, message: sanitize(entry.message), activationObserved: false as const }])) as PersonalBuildGateReport["environmentDoctor"];
  const report: PersonalBuildGateReport = {
    schemaVersion: 1, generatedAt: input.now ?? new Date().toISOString(),
    buildIdentity: { ...input.buildIdentity, ...(input.buildIdentity.buildRevision === undefined ? {} : { buildRevision: sanitize(input.buildIdentity.buildRevision) }) },
    stateSchema: { currentVersion: input.buildIdentity.stateSchemaVersion, migrationVersions: [...new Set(input.migrationVersions)].sort((a, b) => a - b) },
    dependencyInventory: dependencies, environmentDoctor: doctor, executedTests: scenarios,
    executionModes: Object.fromEntries(Object.entries(input.executionModes).map(([mode, value]) => [mode, { status: value.status, scenarioIds: [...value.scenarioIds], ...(value.note === undefined ? {} : { note: sanitize(value.note) }) }])) as unknown as PersonalBuildGateInput["executionModes"],
    acceptanceMatrix: matrix, evidencePaths: [...new Set(scenarios.flatMap((item) => item.evidencePaths ?? []))], zeroSecretScan, warnings, unavailableDependencies, deferredScope, decision
  };
  const jsonPath = resolve(outputRoot, "personal-build-gate-report.json");
  const markdownPath = resolve(outputRoot, "personal-build-gate-summary.md");
  atomicWrite(jsonPath, JSON.stringify(report, null, 2) + "\n");
  atomicWrite(markdownPath, markdownSummary(report));
  return { jsonPath, markdownPath, report };
}

function markdownSummary(report: PersonalBuildGateReport): string {
  const modeRows = Object.entries(report.executionModes).map(([mode, value]) => `| ${mode} | ${value.status} | ${value.scenarioIds.join(", ") || "—"} |`).join("\n");
  const scenarioRows = report.executedTests.map((item) => `| ${item.testId} | ${item.suite} | ${item.mode} | ${item.status} | ${item.durationMs} ms |`).join("\n");
  const matrixRows = report.acceptanceMatrix.map((item) => `| ${item.criterionId} | ${item.status} | ${item.evidence.join(", ") || "—"} |`).join("\n");
  const doctorRows = Object.entries(report.environmentDoctor).map(([name, entry]) => `| ${name} | ${entry.status} | ${entry.message} |`).join("\n");
  return ["# Personal Build Gate Summary", "", `Decision: **${report.decision}**`, "", `Generated: ${report.generatedAt}`, `Build: ${report.buildIdentity.applicationVersion} · state schema ${report.buildIdentity.stateSchemaVersion}`, "", "## Execution modes", "", "| Mode | Status | Suites |", "|---|---|---|", modeRows || "| — | — | — |", "", "## Suites", "", "| Test | Suite | Mode | Status | Duration |", "|---|---|---|---|---|", scenarioRows || "| — | — | — | — | — |", "", "## Acceptance traceability", "", "| Requirement | Status | Evidence |", "|---|---|---|", matrixRows || "| — | — | — |", "", "## Environment Doctor", "", "| Component | Status | Diagnostic |", "|---|---|---|", doctorRows || "| — | — | — |", "", "## Security", "", `- Zero-secret scan: ${report.zeroSecretScan.passed ? "passed" : "failed"}`, `- Evidence paths: ${report.evidencePaths.length} sanitized relative path(s).`, `- Dependencies unavailable: ${report.unavailableDependencies.length}`, "", "## Deferred scope", "", ...(report.deferredScope.length === 0 ? ["- None"] : report.deferredScope.map((item) => `- ${item}`)), ""].join("\n");
}

function atomicWrite(path: string, content: string): void { const partial = `${path}.partial`; writeFileSync(partial, content, "utf8"); renameSync(partial, path); }
function safeEvidencePath(path: string, root: string | undefined): string { const value = (root === undefined ? path : path.replace(resolve(root), "")).replaceAll("\\", "/").replace(/^\/+/, ""); return value === "" || value === "." || value === ".." || value.startsWith("../") || /^[A-Za-z]:/u.test(value) ? "evidence/invalid-path" : value.slice(0, 240); }
function sanitize(value: string): string { return value.replace(/[A-Za-z]:\\[^\s,;]+|(?:\\\\|\/)(?:Users|home|tmp|var|private)[^\s,;]*/giu, "<local-path>").replace(/(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*[^\s,;]+/giu, "<redacted>").slice(0, 400); }
function containsSecret(value: string): boolean { return /(api[_-]?key|bearer\s+|password\s*[:=]|secret\s*[:=]|token\s*[:=])/iu.test(value); }
