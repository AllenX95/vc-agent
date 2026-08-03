import { createHash } from "node:crypto";
import type { CapabilityMetadata } from "@vc-agent/contracts";

export type TurnCapabilityScope = "unscoped" | "project";

export type TurnKind =
  | "ordinary"
  | "reflection_independent"
  | "reflection_dialogue"
  | "dream"
  | "extension_audit"
  | "sub_agent"
  | "compaction";

export type CapabilityTier = "bootstrap" | "common_read" | "on_demand" | "preconditioned" | "protected_workflow" | "host_only";

export interface CapabilityCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly useWhen: string;
  readonly tier: CapabilityTier;
  readonly sideEffectClass: CapabilityMetadata["sideEffectClass"];
  readonly requiresUserIntent: boolean;
}

export interface TurnCapabilityAvailability {
  readonly materials: boolean;
  readonly projectContext: boolean;
  readonly publicWeb: boolean;
  readonly directAttachments: boolean;
}

export interface TurnCapabilitySurfaceInput {
  readonly kind: TurnKind;
  readonly scope: TurnCapabilityScope;
  readonly inventory: readonly CapabilityMetadata[];
  readonly preloadHints?: readonly string[];
  readonly fixedCapabilityIds?: readonly string[];
  readonly outputRequested?: boolean;
  /** Separates new-Output creation from an edit-only Output intent. Defaults to outputRequested for compatibility. */
  readonly outputCreateRequested?: boolean;
  readonly explicitMemoryRecall?: boolean;
  readonly availability?: Partial<TurnCapabilityAvailability>;
  readonly schemaTokenBudget?: number;
}

export interface TurnCapabilitySurfaceSnapshot {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly kind: TurnKind;
  readonly scope: TurnCapabilityScope;
  readonly visibleCapabilityIds: readonly string[];
  readonly executableCapabilityIds: readonly string[];
  readonly requestableCatalog: readonly CapabilityCatalogEntry[];
  readonly initialToolSchemaEstimatedTokens: number;
}

const DEFAULT_AVAILABILITY: TurnCapabilityAvailability = {
  materials: true,
  projectContext: true,
  publicWeb: true,
  directAttachments: false
};

const NEVER_ORDINARY_REQUESTABLE = new Set(["reflection_evidence_drilldown", "reflection_outcome_propose"]);

// Keep the Host-mediated text write/edit surface stable across ordinary Turns.
// Visibility is not authorization: Standard Access turns a call into a
// scoped approval, while Full Access still requires Host-confirmed Output
// Intent before any local write.
const ORDINARY_TEXT_WRITE_CAPABILITIES = [
  "output.write_text",
  "output.edit_text",
  "workspace.write_batch"
] as const;

/**
 * Builds the model-facing capability surface for one Turn. This is deliberately
 * pure: StateStore and Gateway policy are supplied as snapshots by the Host,
 * while execution remains behind the existing Gateway seam.
 */
export function createTurnCapabilitySurface(input: TurnCapabilitySurfaceInput): TurnCapabilitySurfaceSnapshot {
  const byId = new Map(input.inventory.map((metadata) => [metadata.id, metadata]));
  const availability = { ...DEFAULT_AVAILABILITY, ...input.availability };
  const visible = input.kind === "ordinary"
    ? ordinaryVisibleIds(input, byId, availability)
    : fixedVisibleIds(input, byId);
  const executable = visible.filter((id) => {
    const metadata = byId.get(id);
    return metadata !== undefined && metadata.modelCallable && metadata.allowedScopes.includes(input.scope);
  });
  const requestableCatalog = input.kind === "ordinary"
    ? buildRequestableCatalog(input, byId, new Set(visible), availability)
    : [];
  const initialToolSchemaEstimatedTokens = estimateSchemaTokens(visible, byId);
  const budget = input.schemaTokenBudget ?? Number.POSITIVE_INFINITY;
  const boundedVisible = initialToolSchemaEstimatedTokens <= budget
    ? visible
    : boundVisibleToBudget(visible, byId, budget);
  const boundedExecutable = executable.filter((id) => boundedVisible.includes(id));
  const revision = surfaceRevision(input, boundedVisible, requestableCatalog, byId);
  return {
    schemaVersion: 1,
    revision,
    kind: input.kind,
    scope: input.scope,
    visibleCapabilityIds: boundedVisible,
    executableCapabilityIds: boundedExecutable,
    requestableCatalog,
    initialToolSchemaEstimatedTokens: estimateSchemaTokens(boundedVisible, byId)
  };
}

function ordinaryVisibleIds(
  input: TurnCapabilitySurfaceInput,
  byId: ReadonlyMap<string, CapabilityMetadata>,
  availability: TurnCapabilityAvailability
): string[] {
  const ids: string[] = [];
  addIfAllowed(ids, "capability_request", input, byId);
  if (input.scope === "project" && availability.materials) addIfAllowed(ids, "material_recall", input, byId);
  if (input.scope === "project" && availability.projectContext) addIfAllowed(ids, "project_state_recall", input, byId);
  if (availability.publicWeb) {
    addIfAllowed(ids, "web_search", input, byId);
    addIfAllowed(ids, "web_fetch", input, byId);
  }
  if (input.scope === "unscoped" && availability.directAttachments) addIfAllowed(ids, "material_recall", input, byId);
  for (const id of ORDINARY_TEXT_WRITE_CAPABILITIES) addIfAllowed(ids, id, input, byId);
  for (const hint of input.preloadHints ?? []) {
    const metadata = byId.get(hint);
    if (metadata === undefined || !metadata.modelCallable || !metadata.allowedScopes.includes(input.scope)) continue;
    if (!availableForOrdinaryCapability(hint, input, availability)) continue;
    if (metadata.activationClass === "preconditioned_execution" && input.outputRequested !== true) continue;
    if (metadata.activationClass === "protected_workflow" || metadata.activationClass === "host_only") continue;
    if (!ids.includes(hint)) ids.push(hint);
  }
  if ((input.outputCreateRequested ?? input.outputRequested) === true) addIfAllowed(ids, "output.write_text", input, byId);
  if (input.explicitMemoryRecall === true) addIfAllowed(ids, "memory_recall", input, byId);
  return ids;
}

function fixedVisibleIds(input: TurnCapabilitySurfaceInput, byId: ReadonlyMap<string, CapabilityMetadata>): string[] {
  const ids: string[] = [];
  for (const id of input.fixedCapabilityIds ?? []) addIfAllowed(ids, id, input, byId);
  return ids;
}

function addIfAllowed(ids: string[], id: string, input: TurnCapabilitySurfaceInput, byId: ReadonlyMap<string, CapabilityMetadata>): void {
  const metadata = byId.get(id);
  if (metadata === undefined || !metadata.modelCallable || !metadata.allowedScopes.includes(input.scope)) return;
  if (!ids.includes(id)) ids.push(id);
}

function buildRequestableCatalog(
  input: TurnCapabilitySurfaceInput,
  byId: ReadonlyMap<string, CapabilityMetadata>,
  visible: ReadonlySet<string>,
  availability: TurnCapabilityAvailability
): CapabilityCatalogEntry[] {
  return [...byId.values()]
    .filter((metadata) => metadata.modelCallable && metadata.allowedScopes.includes(input.scope))
    .filter((metadata) => availableForOrdinaryCapability(metadata.id, input, availability))
    .filter((metadata) => !visible.has(metadata.id))
    .filter((metadata) => !NEVER_ORDINARY_REQUESTABLE.has(metadata.id))
    .filter((metadata) => metadata.activationClass === "ordinary_task" || (metadata.activationClass === "preconditioned_execution" && input.outputRequested === true))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((metadata) => ({
      id: metadata.id,
      label: metadata.label,
      useWhen: sanitizeCatalogText(metadata.useWhen ?? metadata.description),
      tier: metadata.tier ?? (metadata.activationClass === "preconditioned_execution" ? "preconditioned" : "on_demand"),
      sideEffectClass: metadata.sideEffectClass,
      requiresUserIntent: metadata.activationClass === "preconditioned_execution"
    }));
}

function availableForOrdinaryCapability(id: string, input: TurnCapabilitySurfaceInput, availability: TurnCapabilityAvailability): boolean {
  if (id === "material_recall") return input.scope === "project" ? availability.materials : availability.directAttachments;
  if (id === "project_state_recall") return input.scope === "project" && availability.projectContext;
  if (id === "web_search" || id === "web_fetch" || id === "source_check") return availability.publicWeb;
  if (id === "output.write_text") return (input.outputCreateRequested ?? input.outputRequested) === true;
  return true;
}

function sanitizeCatalogText(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 500);
  return normalized.length === 0 ? "Use only when the task requires this capability." : normalized;
}

function boundVisibleToBudget(ids: readonly string[], byId: ReadonlyMap<string, CapabilityMetadata>, budget: number): string[] {
  const result: string[] = [];
  let used = 0;
  for (const id of ids) {
    const cost = estimateSchemaTokens([id], byId);
    if (result.length === 0 || used + cost <= budget) {
      result.push(id);
      used += cost;
    }
  }
  return result;
}

function estimateSchemaTokens(ids: readonly string[], byId: ReadonlyMap<string, CapabilityMetadata>): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(ids.map((id) => byId.get(id)?.inputSchema ?? {})), "utf8") / 4);
}

function surfaceRevision(
  input: TurnCapabilitySurfaceInput,
  visible: readonly string[],
  catalog: readonly CapabilityCatalogEntry[],
  byId: ReadonlyMap<string, CapabilityMetadata>
): string {
  const payload = {
    kind: input.kind,
    scope: input.scope,
    visible: visible.map((id) => [id, byId.get(id)?.version ?? "unknown"]),
    catalog: catalog.map((entry) => [entry.id, byId.get(entry.id)?.version ?? "unknown", entry.tier, entry.useWhen])
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
