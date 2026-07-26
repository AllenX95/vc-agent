import { createHash } from "node:crypto";
import type { SubAgentContextBoundary } from "@vc-agent/contracts";

export interface SubAgentContextResolution {
  readonly source: string;
  readonly content: string;
}

export interface SubAgentContextResolver {
  resolve(input: { readonly referenceId: string; readonly boundary: SubAgentContextBoundary }): Promise<SubAgentContextResolution | undefined>;
}

export interface SubAgentContextEntry {
  readonly referenceId: string;
  readonly source: string;
  readonly content: string;
}

export interface SubAgentContextBundle {
  readonly schemaVersion: 1;
  readonly scope: SubAgentContextBoundary["scope"];
  readonly projectId?: string;
  readonly maxChars: number;
  readonly entries: readonly SubAgentContextEntry[];
  readonly omittedReferenceIds: readonly string[];
  readonly hash: string;
}

/** Compiles only explicitly referenced, bounded source material for a child session. */
export class SubAgentContextCompiler {
  readonly #resolver: SubAgentContextResolver;

  constructor(resolver: SubAgentContextResolver) { this.#resolver = resolver; }

  async compile(boundary: SubAgentContextBoundary): Promise<SubAgentContextBundle> {
    const entries: SubAgentContextEntry[] = [];
    const omittedReferenceIds: string[] = [];
    let usedChars = 0;
    for (const referenceId of boundary.sourceReferenceIds) {
      if (usedChars >= boundary.maxChars) {
        omittedReferenceIds.push(referenceId);
        continue;
      }
      const resolved = await this.#resolver.resolve({ referenceId, boundary });
      if (resolved === undefined) {
        omittedReferenceIds.push(referenceId);
        continue;
      }
      const remaining = boundary.maxChars - usedChars;
      const content = resolved.content.slice(0, remaining);
      if (content.length === 0) {
        omittedReferenceIds.push(referenceId);
        continue;
      }
      entries.push({ referenceId: referenceId.slice(0, 200), source: resolved.source.slice(0, 200), content });
      usedChars += content.length;
      if (content.length < resolved.content.length) omittedReferenceIds.push(referenceId);
    }
    const material = {
      schemaVersion: 1 as const,
      scope: boundary.scope,
      ...(boundary.projectId === undefined ? {} : { projectId: boundary.projectId }),
      maxChars: boundary.maxChars,
      entries,
      omittedReferenceIds
    };
    return { ...material, hash: createHash("sha256").update(JSON.stringify(material)).digest("hex") };
  }
}
