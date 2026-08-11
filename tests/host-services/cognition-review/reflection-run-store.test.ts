import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectThread, ReflectionBrief, SystemPromptRevision, Thread, UnscopedThread } from "@vc-agent/contracts";
import { ReflectionRunStore, type ReflectionRunThreadAdapter } from "../../../packages/host-services/src/cognition-review/reflection-run-store.js";

const prompt: SystemPromptRevision = {
  id: "11111111-1111-4111-8111-111111111111",
  content: "VC",
  hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  diff: "",
  source: "shipped_default",
  createdAt: "2026-08-11T00:00:00.000Z"
};

const projectBrief: Extract<ReflectionBrief, { scope: "project" }> = {
  schemaVersion: 1,
  scope: "project",
  projectId: "22222222-2222-4222-8222-222222222222",
  sourceVersion: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  createdAt: "2026-08-11T00:00:00.000Z",
  contextFields: [],
  materialCards: [],
  recordReferences: []
};

function threadAdapter(): ReflectionRunThreadAdapter {
  const threads = new Map<string, Thread>();
  return {
    createProjectThread(projectId, title): ProjectThread {
      const thread: ProjectThread = { id: `project-${threads.size + 1}`, title, scope: "project", projectId, stateVersion: 1, createdAt: "2026-08-11T00:00:00.000Z" };
      threads.set(thread.id, thread);
      return thread;
    },
    createUnscopedThread(title): UnscopedThread {
      const thread: UnscopedThread = { id: `unscoped-${threads.size + 1}`, title, scope: "unscoped", stateVersion: 1, createdAt: "2026-08-11T00:00:00.000Z" };
      threads.set(thread.id, thread);
      return thread;
    },
    getThread: (threadId) => threads.get(threadId),
    selectThreadProfile: (threadId, profileId) => {
      const current = threads.get(threadId);
      if (current === undefined) throw new Error("THREAD_NOT_FOUND");
      const updated = { ...current, activeProfileId: profileId, stateVersion: current.stateVersion + 1 } as Thread;
      threads.set(threadId, updated);
      return updated;
    },
    setThreadOutputLocation: (threadId, outputLocation) => {
      const current = threads.get(threadId);
      if (current?.scope !== "unscoped") throw new Error("THREAD_NOT_FOUND");
      const updated = { ...current, outputLocation, stateVersion: current.stateVersion + 1 };
      threads.set(threadId, updated);
      return updated;
    }
  };
}

describe("ReflectionRunStore", () => {
  it("persists Reflection lifecycle outside HostStateStore reflection_runs", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-reflection-run-store-"));
    try {
      const threads = threadAdapter();
      const path = join(root, "cognition-v2", "reflection-runs.json");
      const store = new ReflectionRunStore(path, threads, { now: () => new Date("2026-08-11T00:00:00.000Z") });
      const run = store.create({
        scope: "project",
        projectId: projectBrief.projectId,
        framing: "reflection",
        objective: "Review",
        brief: projectBrief,
        promptRevision: prompt,
        independentProfileId: "profile-reflection"
      });

      expect(store.get(run.id)).toMatchObject({ id: run.id, status: "ready", independentProfileId: "profile-reflection" });
      expect(new ReflectionRunStore(path, threads).get(run.id)?.threadId).toBe(run.threadId);

      store.markIndependentRunning(run.id);
      store.completeIndependent(run.id, {
        schemaVersion: 1,
        conclusion: "Hold",
        rationale: ["Evidence is mixed."],
        uncertainties: [],
        counterarguments: [],
        evidenceReferences: [],
        decisionChangingQuestions: [],
        createdAt: "2026-08-11T00:00:00.000Z"
      });
      expect(store.get(run.id)?.status).toBe("independent_completed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers active runs as interrupted without relying on a SQLite table", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-reflection-run-store-"));
    try {
      const threads = threadAdapter();
      const store = new ReflectionRunStore(join(root, "runs.json"), threads, { now: () => new Date("2026-08-11T00:00:00.000Z") });
      const run = store.create({ scope: "project", projectId: projectBrief.projectId, framing: "reflection", objective: "Review", brief: projectBrief, promptRevision: prompt, independentProfileId: "profile-reflection" });
      store.markIndependentRunning(run.id);
      expect(store.recoverInterrupted().map((item) => item.id)).toEqual([run.id]);
      expect(store.get(run.id)?.status).toBe("independent_interrupted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("only enters the terminal completed state through shared review commit confirmation", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-agent-reflection-run-store-"));
    try {
      const threads = threadAdapter();
      const store = new ReflectionRunStore(join(root, "runs.json"), threads, { now: () => new Date("2026-08-11T00:00:00.000Z") });
      const run = store.create({ scope: "project", projectId: projectBrief.projectId, framing: "reflection", objective: "Review", brief: projectBrief, promptRevision: prompt, independentProfileId: "profile-reflection" });
      expect(() => store.complete(run.id)).toThrow("REFLECTION_NOT_COMPLETABLE");
      store.markIndependentRunning(run.id);
      store.completeIndependent(run.id, { schemaVersion: 1, conclusion: "Hold", rationale: ["Evidence."], uncertainties: [], counterarguments: [], evidenceReferences: [], decisionChangingQuestions: [], createdAt: "2026-08-11T00:00:00.000Z" });
      store.startMemoryAware(run.id, "profile-reflection", "turn-1");
      store.activateDialogue(run.id);
      expect(store.complete(run.id).status).toBe("completed");
      expect(() => store.complete(run.id)).toThrow("REFLECTION_NOT_COMPLETABLE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
