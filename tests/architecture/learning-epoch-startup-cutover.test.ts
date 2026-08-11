import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const mainSource = () => readFileSync(resolve(process.cwd(), "apps/desktop/src/main/main.ts"), "utf8");

describe("Learning Epoch startup cutover", () => {
  it("runs the reset immediately after State v18 opens and before any runtime constructor", () => {
    const source = mainSource();
    const stateOpen = source.indexOf("stateStore = new HostStateStore");
    const cutover = source.indexOf("runLearningEpochCutover(userDataRoot, statePath, stateStore)");
    expect(stateOpen).toBeGreaterThanOrEqual(0);
    expect(cutover).toBeGreaterThan(stateOpen);
    for (const constructor of ["new AgentWorkerSupervisor", "new DesktopSubAgentProviderExecutor", "new UtilityJobRunner", "new SubAgentRuntime", "new BoundedExecutionScheduler"]) {
      expect(source.indexOf(constructor)).toBeGreaterThan(cutover);
    }
  });

  it("passes exact persisted output roots and restores SQLite on reset failure", () => {
    const source = mainSource();
    expect(source).toContain("projectRoots: openedState.listProjects().map((project) => project.path)");
    expect(source).toContain("thread.outputLocation === undefined ? [] : [thread.outputLocation]");
    expect(source).not.toContain("migrateState:");
    expect(source).toContain("rollbackState: () => restoreStateStorageRollback(statePath)");
    expect(source).toContain("runLearningEpochCutover(userDataRoot, statePath, stateStore)");
  });

  it("returns through a read-only bootstrap branch without constructing execution runtimes", () => {
    const source = mainSource();
    const start = source.indexOf("if (!runLearningEpochCutover(userDataRoot, statePath, stateStore))");
    const end = source.indexOf("loadPiResourceSettings();", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const branch = source.slice(start, end);
    expect(branch).toContain("ipcMain.handle(COMMAND_CHANNEL, handleCommand)");
    expect(branch).toContain("return;");
    expect(branch).not.toContain("new AgentWorkerSupervisor");
    expect(branch).not.toContain("new DesktopSubAgentProviderExecutor");
    expect(branch).not.toContain("new UtilityJobRunner");
    expect(branch).not.toContain("new SubAgentRuntime");
  });

  it("never recreates legacy Dream storage after the active epoch", () => {
    const source = mainSource();
    expect(source).toContain("createReflectionDrafts({ root: join(app.getPath(\"userData\"), \"cognition-v2\") })");
    expect(source).not.toContain("reflection-outcomes.jsonl");
    expect(source).toContain('cognitionRoot: join(app.getPath("userData"), "cognition-v2")');
    expect(source).not.toMatch(/\bdream\b/iu);
    expect(source).not.toContain('new DreamReviewStore(join(app.getPath("userData"), "memory", "dream")');
    expect(source).not.toContain('new DreamCommitStore(join(app.getPath("userData"), "memory", "dream")');
  });
});
