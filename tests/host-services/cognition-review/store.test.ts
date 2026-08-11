import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CognitionReviewStore } from "@vc-agent/host-services";

const now = "2026-08-11T00:00:00.000Z";

describe("Cognition Review store", () => {
  it("persists a content-free source index and redacts deleted Thread references", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-cognition-v2-"));
    try {
      const store = new CognitionReviewStore(root, { now: () => new Date(now) });
      store.writeEpoch({ schemaVersion: 1, learningEpochStartedAt: now });
      store.upsertSourceIndex([
        { sourceReference: "thread:deleted/turn:1", sourceKind: "ordinary_exchange", scope: "unscoped", threadId: "deleted", completedAt: now },
        { sourceReference: "thread:kept/turn:1", sourceKind: "ordinary_exchange", scope: "unscoped", threadId: "kept", completedAt: now }
      ]);

      const indexPath = join(root, "cognition-v2", "source-index.jsonl");
      expect(readFileSync(indexPath, "utf8")).not.toContain("userText");
      expect(store.readSourceIndex()).toHaveLength(2);
      expect(store.redactThreadSources("deleted")).toEqual(["thread:deleted/turn:1"]);
      expect(store.readSourceIndex().map((source) => source.sourceReference)).toEqual(["thread:kept/turn:1"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks deleted Thread sources unavailable while retaining provenance pointers", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-cognition-v2-deleted-"));
    try {
      const store = new CognitionReviewStore(root, { now: () => new Date(now) });
      store.upsertSourceIndex([{ sourceReference: "thread:deleted/turn:1", sourceKind: "ordinary_exchange", scope: "unscoped", threadId: "deleted", completedAt: now }]);
      expect(store.markThreadSourcesDeleted("deleted")).toEqual(["thread:deleted/turn:1"]);
      expect(store.readSourceIndex()).toEqual([expect.objectContaining({ sourceReference: "thread:deleted/turn:1", availability: "deleted" })]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the committed cutoff authority is malformed", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-cognition-v2-cutoff-"));
    try {
      const store = new CognitionReviewStore(root);
      const path = store.committedCutoffPath;
      const valid = { schemaVersion: 1, batchId: "batch-1", cutoff: now, updatedAt: now };
      mkdirSync(join(root, "cognition-v2"), { recursive: true });
      writeFileSync(path, JSON.stringify(valid), "utf8");
      expect(store.loadCommittedCutoff()).toEqual(valid);

      writeFileSync(path, JSON.stringify({ ...valid, cutoff: "2026-08-11T08:00:00.000+08:00" }), "utf8");
      expect(store.loadCommittedCutoff()?.cutoff).toBe("2026-08-11T08:00:00.000+08:00");

      writeFileSync(path, JSON.stringify({ ...valid, cutoff: "not-a-date" }), "utf8");
      expect(() => store.loadCommittedCutoff()).toThrow("Invalid Cognition Review committed cutoff.");

      writeFileSync(path, JSON.stringify({ ...valid, batchId: "../outside" }), "utf8");
      expect(() => store.loadCommittedCutoff()).toThrow("Invalid Cognition Review committed cutoff.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
