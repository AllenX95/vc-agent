import { createHash } from "node:crypto";
import type { MaterialInventoryItem, ReflectionOutcomeDependency, ReflectionOutcomeStaleReason } from "@vc-agent/contracts";
import { parseMaterialBlockReference } from "../reflection-evidence.js";

/** Host-owned values used while converting Reflection evidence into Review dependencies. */
export interface ReflectionDependencyEntry {
  readonly id: string;
  readonly value: unknown;
}

export interface ReflectionDependencyState {
  readonly materials: readonly MaterialInventoryItem[];
  readonly projectMemory?: readonly ReflectionDependencyEntry[] | undefined;
  readonly longTermMemory?: readonly ReflectionDependencyEntry[] | undefined;
}

export interface CaptureReflectionDependenciesInput {
  readonly evidenceReferenceIds: readonly string[];
  readonly projectMemoryEntryIds: readonly string[];
  readonly longTermMemoryEntryIds: readonly string[];
  readonly state: ReflectionDependencyState;
}

/** Narrow dependency resolver seam used by Reflection preparation/commit. */
export interface ReflectionDependencyResolver {
  capture(input: CaptureReflectionDependenciesInput): ReflectionOutcomeDependency[];
  stale(dependencies: readonly ReflectionOutcomeDependency[], state: ReflectionDependencyState): ReflectionOutcomeStaleReason[];
  fingerprint(value: unknown): string;
}

/** Capture exact evidence and recalled Memory identities for a draft. */
export function captureReflectionDependencies(input: CaptureReflectionDependenciesInput): ReflectionOutcomeDependency[] {
  const dependencies: ReflectionOutcomeDependency[] = [];
  for (const referenceId of input.evidenceReferenceIds) {
    const reference = parseMaterialBlockReference(referenceId);
    if (reference === undefined) continue;
    dependencies.push({ kind: "material", referenceId, targetId: reference.materialId, contentVersion: reference.contentVersion });
  }
  for (const entryId of new Set(input.projectMemoryEntryIds)) {
    const entry = input.state.projectMemory?.find((candidate) => candidate.id === entryId);
    if (entry !== undefined) dependencies.push({ kind: "project_memory", referenceId: `project-memory:${entryId}`, targetId: entryId, contentVersion: reflectionDependencyFingerprint(entry.value) });
  }
  for (const entryId of new Set(input.longTermMemoryEntryIds)) {
    const entry = input.state.longTermMemory?.find((candidate) => candidate.id === entryId);
    if (entry !== undefined) dependencies.push({ kind: "long_term_memory", referenceId: `long-term-memory:${entryId}`, targetId: entryId, contentVersion: reflectionDependencyFingerprint(entry.value) });
  }
  return [...new Map(dependencies.map((dependency) => [`${dependency.kind}\0${dependency.referenceId}`, dependency])).values()];
}

/** Return only dependencies whose exact material or Memory value changed. */
export function staleReflectionDependencies(dependencies: readonly ReflectionOutcomeDependency[], state: ReflectionDependencyState): ReflectionOutcomeStaleReason[] {
  const reasons: ReflectionOutcomeStaleReason[] = [];
  for (const dependency of dependencies) {
    if (dependency.kind === "material") {
      const material = state.materials.find((candidate) => candidate.id === dependency.targetId && candidate.availability === "active");
      if (material === undefined) reasons.push({ dependency, reason: "deleted" });
      else if (material.sourceHash !== dependency.contentVersion) reasons.push({ dependency, reason: "changed" });
      continue;
    }
    const entries = dependency.kind === "project_memory" ? state.projectMemory : state.longTermMemory;
    if (entries === undefined) {
      reasons.push({ dependency, reason: "source_unavailable" });
      continue;
    }
    const entry = entries.find((candidate) => candidate.id === dependency.targetId);
    if (entry === undefined) reasons.push({ dependency, reason: "deleted" });
    else if (reflectionDependencyFingerprint(entry.value) !== dependency.contentVersion) reasons.push({ dependency, reason: "changed" });
  }
  return reasons;
}

/** Stable content hash used for Host-captured dependency versions. */
export function reflectionDependencyFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createReflectionDependencyResolver(): ReflectionDependencyResolver {
  return {
    capture: captureReflectionDependencies,
    stale: staleReflectionDependencies,
    fingerprint: reflectionDependencyFingerprint
  };
}
