import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFauxPiSession,
  fauxAssistantMessage,
  fauxThinking
} from "@vc-agent/pi-adapter/testing";
import type { PiSessionEvent, PiSessionHandle, RuntimeResourceSnapshot } from "@vc-agent/pi-adapter";

const temporaryDirectories: string[] = [];
const resources: RuntimeResourceSnapshot = {
  schemaVersion: 1,
  revisionId: "pi-session-regressions",
  systemPrompt: "You are vc-agent.",
  appendSystemPrompt: []
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PiSessionHandle behavioral regressions", () => {
  it("opens and continues a session fixture produced by Pi 0.80.8", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-pi-0808-session-"));
    temporaryDirectories.push(cwd);
    const sessionDirectory = join(cwd, "pi");
    const sessionFile = join(sessionDirectory, "pi-0.80.8-session.jsonl");
    mkdirSync(sessionDirectory);
    copyFileSync(
      resolve(import.meta.dirname, "../fixtures/pi-session-0.80.8.jsonl"),
      sessionFile
    );
    const events: PiSessionEvent[] = [];
    const handle = await createFauxPiSession({
      config: {
        cwd,
        threadDirectory: cwd,
        previousSessionFile: sessionFile,
        hostHighWater: { eventId: "legacy-turn-1", sequence: 2 },
        contextHistory: [],
        resources,
        extensions: undefined
      },
      responses: [fauxAssistantMessage("Continued by Pi 0.84.1.")],
      onEvent: (event) => events.push(event)
    });

    expect(handle.reconciliation).toBe("resumed");
    expect(handle.sessionFile).toBe(sessionFile);
    await handle.submit("Continue the legacy session.");
    expect(events.find((event) => event.type === "completed")).toMatchObject({
      message: "Continued by Pi 0.84.1."
    });
    const persisted = readFileSync(sessionFile, "utf8");
    expect(persisted).toContain("Persisted by Pi 0.80.8.");
    expect(persisted).toContain("Continued by Pi 0.84.1.");
    if (handle.disposeAsync !== undefined) await handle.disposeAsync();
    else handle.dispose();
  });

  it("aggregates text and thinking deltas exactly once and treats the terminal message as authoritative", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-pi-delta-regression-"));
    temporaryDirectories.push(cwd);
    const thinking = "Inspect the evidence before answering.";
    const visible = "The terminal assistant message is authoritative.";
    const events: PiSessionEvent[] = [];
    const handle = await createFauxPiSession({
      config: {
        cwd,
        threadDirectory: cwd,
        contextHistory: [],
        resources,
        extensions: undefined
      },
      responses: [fauxAssistantMessage([
        fauxThinking(thinking),
        { type: "text", text: visible }
      ], { responseId: "delta-regression-1" })],
      onEvent: (event) => events.push(event)
    });

    await handle.submit("Review this evidence.");

    const thinkingDeltas = events
      .filter((event): event is Extract<PiSessionEvent, { type: "thinking_delta" }> => event.type === "thinking_delta")
      .map((event) => event.delta);
    const textDeltas = events
      .filter((event): event is Extract<PiSessionEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map((event) => event.delta);
    const completed = events.filter((event): event is Extract<PiSessionEvent, { type: "completed" }> => event.type === "completed");

    expect(thinkingDeltas.join(""), "thinking deltas must reconstruct the thinking block once").toBe(thinking);
    expect(textDeltas.join(""), "text deltas must reconstruct the visible block once").toBe(visible);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      message: visible,
      responseId: "delta-regression-1"
    });
    expect(events.at(-1)?.type).toBe("completed");
    handle.dispose();
  });

  it("resumes a persisted session at an acknowledged high-water mark and can continue on the same file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-pi-persisted-regression-"));
    temporaryDirectories.push(cwd);
    const first = await createFauxPiSession({
      config: {
        cwd,
        threadDirectory: cwd,
        contextHistory: [],
        resources,
        extensions: undefined
      },
      responses: [fauxAssistantMessage("The first persisted answer.")],
      onEvent: () => {}
    });

    await first.submit("Create the persisted context.");
    const firstSessionFile = first.sessionFile;
    expect(firstSessionFile).not.toBe("");
    expect(existsSync(firstSessionFile)).toBe(true);
    const firstBytes = readFileSync(firstSessionFile, "utf8");
    expect(firstBytes).toContain("The first persisted answer.");
    first.acknowledge("turn-persisted-1", 1);
    if (first.disposeAsync !== undefined) await first.disposeAsync();
    else first.dispose();

    const resumedEvents: PiSessionEvent[] = [];
    const resumed = await createFauxPiSession({
      config: {
        cwd,
        threadDirectory: cwd,
        previousSessionFile: firstSessionFile,
        hostHighWater: { eventId: "turn-persisted-1", sequence: 1 },
        contextHistory: [],
        resources,
        extensions: undefined
      },
      responses: [fauxAssistantMessage("The resumed answer.")],
      onEvent: (event) => resumedEvents.push(event)
    });

    expect(resumed.reconciliation).toBe("resumed");
    expect(resumed.sessionFile).toBe(firstSessionFile);
    await resumed.submit("Continue from the persisted context.");
    expect(resumedEvents.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(resumedEvents.find((event) => event.type === "completed")).toMatchObject({ message: "The resumed answer." });
    expect(readFileSync(firstSessionFile, "utf8")).toContain("The resumed answer.");
    if (resumed.disposeAsync !== undefined) await resumed.disposeAsync();
    else resumed.dispose();
  });

  it("does not report a completed turn after abort and remains usable for the next turn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vc-agent-pi-abort-regression-"));
    temporaryDirectories.push(cwd);
    const events: PiSessionEvent[] = [];
    let handle!: PiSessionHandle;
    let abortPromise: Promise<void> | undefined;
    // The faux provider streams in small chunks. The first delta gives us a
    // deterministic external synchronization point before aborting the turn.
    handle = await createFauxPiSession({
      config: {
        cwd,
        threadDirectory: cwd,
        contextHistory: [],
        resources,
        extensions: undefined
      },
      responses: [
        fauxAssistantMessage("x".repeat(20_000)),
        fauxAssistantMessage("The follow-up turn completed.")
      ],
      onEvent: (event) => {
        events.push(event);
        if (event.type === "text_delta" && abortPromise === undefined) {
          abortPromise = handle.abort();
        }
      }
    });

    let submitError: unknown;
    try {
      await handle.submit("Start a turn that will be aborted.");
    } catch (error) {
      submitError = error;
    }
    expect(abortPromise).toBeDefined();
    await abortPromise;

    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(events.filter((event) => event.type === "completed")).toHaveLength(0);
    expect(submitError !== undefined || events.some((event) => event.type === "failed")).toBe(true);

    await handle.submit("Continue after abort.");
    const completed = events.filter((event): event is Extract<PiSessionEvent, { type: "completed" }> => event.type === "completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].message).toBe("The follow-up turn completed.");
    expect(events.at(-1)?.type).toBe("completed");
    handle.dispose();
  });
});
