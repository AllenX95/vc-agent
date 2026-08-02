import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactRecord } from "@vc-agent/contracts";
import { ProjectOutputRegistry } from "@vc-agent/host-services";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("Project Output Registry", () => {
  it("records format-neutral provenance beside existing parser records and lists only user Outputs", () => {
    const projectPath = mkdtempSync(join(tmpdir(), "vc-agent-project-output-")); directories.push(projectPath);
    const registry = new ProjectOutputRegistry();
    const projectId = crypto.randomUUID();
    const destination = join(projectPath, "outputs", "memo.md");
    const artifact: ArtifactRecord = { schemaVersion: 1, id: crypto.randomUUID(), mediaType: "text/markdown", producer: { type: "agent", id: "primary-agent" }, destination, source: { threadId: "thread-1", turnId: "turn-1", capabilityRequestId: "request-1" }, createdAt: "2026-07-17T00:00:00.000Z" };
    mkdirSync(join(projectPath, "outputs", "system"), { recursive: true });
    writeFileSync(destination, "# Memo", { encoding: "utf8", flag: "wx" });
    writeFileSync(registry.path(projectPath), `${JSON.stringify({ type: "canonical_parse", id: crypto.randomUUID() })}\n`, "utf8");
    registry.record({ projectId, projectPath, artifact, profile: { id: "profile-1", provider: "anthropic", model: "claude" }, capabilityId: "output.write_text", sourceReferences: ["material:one/block:one@hash"], warnings: ["Inference remains uncertain."], relatedArtifacts: [] });
    const valid = JSON.parse(readFileSync(registry.path(projectPath), "utf8").trim().split("\n").at(-1)!);
    writeFileSync(registry.path(projectPath), `${JSON.stringify({ ...valid, id: crypto.randomUUID(), destination: join(projectPath, "outside.md"), relativePath: "outside.md" })}\n`, { encoding: "utf8", flag: "a" });
    expect(registry.list(projectId, projectPath)).toMatchObject([{ id: artifact.id, relativePath: "memo.md", mediaType: "text/markdown", capabilityId: "output.write_text", profile: { provider: "anthropic" }, sourceReferences: ["material:one/block:one@hash"], warnings: ["Inference remains uncertain."] }]);
    expect(readFileSync(registry.path(projectPath), "utf8")).toContain("canonical_parse");
  });

  it("rejects an artifact outside the determined Project Output Location", () => {
    const projectPath = mkdtempSync(join(tmpdir(), "vc-agent-project-output-")); directories.push(projectPath);
    const registry = new ProjectOutputRegistry();
    const artifact: ArtifactRecord = { schemaVersion: 1, id: crypto.randomUUID(), mediaType: "text/plain", producer: { type: "agent", id: "primary-agent" }, destination: join(projectPath, "original.txt"), source: { threadId: "thread-1", turnId: "turn-1", capabilityRequestId: "request-1" }, createdAt: "2026-07-17T00:00:00.000Z" };
    expect(() => registry.record({ projectId: crypto.randomUUID(), projectPath, artifact, profile: { id: "profile-1", provider: "openai", model: "gpt" }, capabilityId: "output.write_text", sourceReferences: [], warnings: [], relatedArtifacts: [] })).toThrow("outside the determined Output Location");
  });

  it("lists only the current artifact when an Output path is replaced", () => {
    const projectPath = mkdtempSync(join(tmpdir(), "vc-agent-project-output-")); directories.push(projectPath);
    const registry = new ProjectOutputRegistry();
    const projectId = crypto.randomUUID();
    const destination = join(projectPath, "outputs", "memo.md");
    const first: ArtifactRecord = { schemaVersion: 1, id: crypto.randomUUID(), mediaType: "text/markdown", producer: { type: "agent", id: "primary-agent" }, destination, source: { threadId: "thread-1", turnId: "turn-1", capabilityRequestId: "request-1" }, createdAt: "2026-07-17T00:00:00.000Z" };
    const second: ArtifactRecord = { ...first, id: crypto.randomUUID(), source: { ...first.source, turnId: "turn-2", capabilityRequestId: "request-2" }, createdAt: "2026-07-17T01:00:00.000Z" };

    registry.record({ projectId, projectPath, artifact: first, profile: { id: "profile-1", provider: "anthropic", model: "claude" }, capabilityId: "output.write_text", sourceReferences: [], warnings: [], relatedArtifacts: [] });
    registry.record({ projectId, projectPath, artifact: second, profile: { id: "profile-1", provider: "anthropic", model: "claude" }, capabilityId: "output.edit_text", sourceReferences: [], warnings: [], relatedArtifacts: [] });

    expect(registry.list(projectId, projectPath)).toMatchObject([{ id: second.id, relativePath: "memo.md", capabilityId: "output.edit_text" }]);
  });
});
