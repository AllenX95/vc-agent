import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { projectOutputArtifactSchema, type ArtifactRecord, type ProjectOutputArtifact } from "@vc-agent/contracts";

export class ProjectOutputRegistry {
  record(input: {
    projectId: string;
    projectPath: string;
    artifact: ArtifactRecord;
    profile: { id: string; provider: string; model: string };
    capabilityId: string;
    skillId?: string;
    sourceReferences: readonly string[];
    warnings: readonly string[];
    relatedArtifacts: readonly ProjectOutputArtifact["relatedArtifacts"][number][];
  }): ProjectOutputArtifact {
    const destination = resolve(input.artifact.destination);
    const outputRoot = resolve(input.projectPath, "outputs");
    if (!destination.startsWith(`${outputRoot}${sep}`)) throw new Error("Project Output is outside the determined Output Location.");
    const record: ProjectOutputArtifact = {
      schemaVersion: 1, id: input.artifact.id, projectId: input.projectId, mediaType: input.artifact.mediaType, destination,
      relativePath: relative(outputRoot, destination).replace(/\\/gu, "/"), producer: input.artifact.producer, source: input.artifact.source,
      profile: input.profile, capabilityId: input.capabilityId, ...(input.skillId === undefined ? {} : { skillId: input.skillId }), sourceReferences: [...input.sourceReferences], warnings: [...input.warnings], relatedArtifacts: [...input.relatedArtifacts], createdAt: input.artifact.createdAt
    };
    const path = this.path(input.projectPath);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ type: "user_output", ...record })}\n`, "utf8");
    return record;
  }

  list(projectId: string, projectPath: string): ProjectOutputArtifact[] {
    const path = this.path(projectPath);
    if (!existsSync(path)) return [];
    const outputRoot = resolve(projectPath, "outputs");
    const records = readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try {
        const raw = JSON.parse(line) as { type?: unknown };
        if (raw.type !== "user_output") return [];
        const parsed = projectOutputArtifactSchema.safeParse(raw);
        if (!parsed.success || parsed.data.projectId !== projectId) return [];
        const destination = resolve(parsed.data.destination);
        const relativePath = relative(outputRoot, destination).replace(/\\/gu, "/");
        if (!destination.startsWith(`${outputRoot}${sep}`) || relativePath !== parsed.data.relativePath) return [];
        return [{ ...parsed.data, destination }];
      } catch { return []; }
    });

    // The registry is append-only so it can retain provenance across replacements,
    // but the Project Outputs view represents the current file at each destination.
    // Read from the end so a later write/edit supersedes earlier records for the
    // same path without changing the on-disk audit trail.
    const currentByDestination = new Map<string, ProjectOutputArtifact>();
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]!;
      const key = process.platform === "win32" ? record.destination.toLowerCase() : record.destination;
      if (!currentByDestination.has(key)) currentByDestination.set(key, record);
    }
    return [...currentByDestination.values()].reverse();
  }

  path(projectPath: string): string { return join(projectPath, "outputs", "system", "artifacts.jsonl"); }
}
