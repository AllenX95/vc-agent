import { describe, expect, it } from "vitest";
import { capabilitySurfaceSnapshotSchema, type CapabilityMetadata } from "@vc-agent/contracts";
import { createCapabilityBroker, createTurnCapabilitySurface } from "@vc-agent/capabilities";
import { PROJECT_READ_TOOL_METADATA, PROJECT_READ_TOOL_NAMES } from "@vc-agent/pi-adapter";

function metadata(
  id: string,
  allowedScopes: Array<"unscoped" | "project">,
  activationClass: CapabilityMetadata["activationClass"] = "ordinary_task",
  sideEffectClass: CapabilityMetadata["sideEffectClass"] = "local_read"
): CapabilityMetadata {
  return {
    id,
    version: "1.0.0",
    label: id,
    description: `Use ${id} when the task needs this evidence.`,
    activationClass,
    sideEffectClass,
    allowedScopes,
    executor: "host",
    modelCallable: true,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    outputSchema: { type: "object" }
  };
}

const inventory = [
  metadata("capability_request", ["unscoped", "project"], "ordinary_task", "none"),
  metadata("material_recall", ["project"]),
  metadata("project_state_recall", ["project"]),
  metadata("web_search", ["unscoped", "project"], "ordinary_task", "network_read"),
  metadata("web_fetch", ["unscoped", "project"], "ordinary_task", "network_read"),
  metadata("memory_recall", ["unscoped", "project"]),
  metadata("output.write_text", ["unscoped", "project"], "preconditioned_execution", "local_write"),
  metadata("output.edit_text", ["unscoped", "project"], "preconditioned_execution", "local_write"),
  metadata("file_download", ["unscoped", "project"], "preconditioned_execution", "local_write"),
  metadata("workspace.write_batch", ["unscoped", "project"], "preconditioned_execution", "local_write"),
  metadata("arxiv.fulltext", ["unscoped", "project"], "preconditioned_execution", "local_write"),
  metadata("reflection_evidence_drilldown", ["project"])
];

describe("TurnCapabilitySurface", () => {
  it("keeps common read tools available when natural-language preload hints miss", () => {
    const surface = createTurnCapabilitySurface({
      kind: "ordinary",
      scope: "project",
      inventory,
      preloadHints: []
    });

    expect(surface.visibleCapabilityIds).toEqual([
      "capability_request",
      "material_recall",
      "project_state_recall",
      "web_search",
      "web_fetch"
    ]);
    expect(surface.revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(surface.requestableCatalog.map((entry) => entry.id)).toEqual(["memory_recall"]);
    expect(capabilitySurfaceSnapshotSchema.parse(surface)).toMatchObject({ schemaVersion: 1, kind: "ordinary", scope: "project" });
  });

  it("keeps protected text write/edit schemas absent when intent preload misses", () => {
    const surface = createTurnCapabilitySurface({
      kind: "ordinary",
      scope: "project",
      inventory,
      preloadHints: []
    });

    expect(surface.visibleCapabilityIds).not.toEqual(expect.arrayContaining([
      "output.write_text",
      "output.edit_text",
      "workspace.write_batch"
    ]));
    expect(surface.requestableCatalog).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "output.write_text" }),
      expect.objectContaining({ id: "output.edit_text" }),
      expect.objectContaining({ id: "workspace.write_batch" })
    ]));
  });

  it("does not expose Project-only tools in an Unscoped Turn", () => {
    const surface = createTurnCapabilitySurface({
      kind: "ordinary",
      scope: "unscoped",
      inventory
    });

    expect(surface.visibleCapabilityIds).toEqual([
      "capability_request",
      "web_search",
      "web_fetch"
    ]);
    expect(surface.requestableCatalog.map((entry) => entry.id)).toEqual(["memory_recall"]);
  });

  it("does not make unavailable common-read sources requestable", () => {
    const surface = createTurnCapabilitySurface({
      kind: "ordinary",
      scope: "project",
      inventory,
      availability: { materials: false, projectContext: false, publicWeb: false }
    });

    expect(surface.visibleCapabilityIds).toEqual(["capability_request"]);
    expect(surface.requestableCatalog.map((entry) => entry.id)).toEqual(["memory_recall"]);
  });

  it("keeps protected workflow surfaces fixed and broker-free", () => {
    const surface = createTurnCapabilitySurface({
      kind: "reflection_dialogue",
      scope: "project",
      inventory,
      fixedCapabilityIds: ["memory_recall", "reflection_evidence_drilldown"]
    });

    expect(surface.visibleCapabilityIds).toEqual(["memory_recall", "reflection_evidence_drilldown"]);
    expect(surface.requestableCatalog).toEqual([]);
  });

  it("preloads native read-only tools only for an ordinary Project surface", () => {
    const withProjectTools = [...inventory, ...PROJECT_READ_TOOL_METADATA];
    const ordinary = createTurnCapabilitySurface({
      kind: "ordinary",
      scope: "project",
      inventory: withProjectTools,
      preloadHints: PROJECT_READ_TOOL_NAMES
    });
    const unscoped = createTurnCapabilitySurface({
      kind: "ordinary",
      scope: "unscoped",
      inventory: withProjectTools,
      preloadHints: PROJECT_READ_TOOL_NAMES
    });
    const reflection = createTurnCapabilitySurface({
      kind: "reflection_dialogue",
      scope: "project",
      inventory: withProjectTools,
      fixedCapabilityIds: ["memory_recall"]
    });

    expect(ordinary.visibleCapabilityIds).toEqual(expect.arrayContaining(PROJECT_READ_TOOL_NAMES));
    expect(unscoped.visibleCapabilityIds).not.toEqual(expect.arrayContaining(PROJECT_READ_TOOL_NAMES));
    expect(reflection.visibleCapabilityIds).toEqual(["memory_recall"]);
  });

  it("allows explicit output preload without making it ordinary common-read", () => {
    const surface = createTurnCapabilitySurface({
      kind: "ordinary",
      scope: "project",
      inventory,
      outputRequested: true
    });

    expect(surface.visibleCapabilityIds).toContain("output.write_text");
    expect(surface.requestableCatalog).not.toContainEqual(expect.objectContaining({ id: "output.write_text" }));
  });

  it("exposes only the selected text edit schema for edit-only intent", () => {
    const surface = createTurnCapabilitySurface({
      kind: "ordinary",
      scope: "project",
      inventory,
      outputRequested: true,
      outputCreateRequested: false,
      preloadHints: ["output.edit_text"]
    });

    expect(surface.visibleCapabilityIds).toContain("output.edit_text");
    expect(surface.visibleCapabilityIds).not.toContain("output.write_text");
  });

  it("exposes file_download only when the Turn has explicit write intent", () => {
    const surface = createTurnCapabilitySurface({
      kind: "ordinary",
      scope: "project",
      inventory,
      outputRequested: true,
      outputCreateRequested: false,
      preloadHints: ["file_download"]
    });

    expect(surface.visibleCapabilityIds).toContain("file_download");
    expect(surface.requestableCatalog).not.toContainEqual(expect.objectContaining({ id: "file_download" }));
    expect(surface.visibleCapabilityIds).not.toContain("output.write_text");
  });

  it("exposes the ArXiv archive and batch writer on an explicit download intent", () => {
    const surface = createTurnCapabilitySurface({
      kind: "ordinary",
      scope: "project",
      inventory,
      outputRequested: true,
      outputCreateRequested: false,
      preloadHints: ["arxiv.fulltext", "workspace.write_batch"]
    });

    expect(surface.visibleCapabilityIds).toEqual(expect.arrayContaining(["arxiv.fulltext", "workspace.write_batch"]));
    expect(surface.requestableCatalog).not.toContainEqual(expect.objectContaining({ id: "arxiv.fulltext" }));
    expect(surface.requestableCatalog).not.toContainEqual(expect.objectContaining({ id: "workspace.write_batch" }));
  });

  it("supports catalog discovery and multi-capability activation through the broker", async () => {
    const broker = createCapabilityBroker((input) => {
      if ("mode" in input && input.mode === "catalog") {
        return { kind: "catalog", catalogRevision: "a".repeat(64), entries: [{ id: "on_demand_read", label: "Read source", useWhen: "Use for source evidence.", tier: "on_demand", sideEffectClass: "local_read", requiresUserIntent: false }] };
      }
      return { kind: "activation", catalogRevision: "a".repeat(64), activatedCapabilities: ["on_demand_read"], alreadyVisible: [], rejected: [] };
    });
    const context = {
      request: {
        schemaVersion: 1,
        requestId: "request-1",
        correlationId: "correlation-1",
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: "tool-1",
        capabilityId: "capability_request",
        scope: { kind: "project", projectId: "project-1" },
        arguments: {},
        expectedStateVersion: 1,
        actor: { actorType: "agent", actorId: "primary-agent" },
        provenance: { producerType: "agent", producerId: "primary-agent" }
      },
      accessMode: "standard" as const
    };

    const catalog = await broker.execute({ mode: "catalog", need: "Find available read tools" }, context);
    expect(catalog.status).toBe("completed");
    expect(JSON.parse(catalog.content)).toMatchObject({ entries: [{ id: "on_demand_read" }] });

    const activated = await broker.execute({ mode: "activate", need: "Read the source", capabilityIds: ["on_demand_read"], catalogRevision: "a".repeat(64) }, context);
    expect(activated).toMatchObject({ status: "completed", activatedCapabilities: ["on_demand_read"], activation: { alreadyVisible: [], rejected: [] } });
  });
});
