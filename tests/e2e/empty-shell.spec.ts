import { _electron as electron, expect, test } from "@playwright/test";
import { join, resolve } from "node:path";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

test("launches the empty shell without activating execution resources", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  const application = await electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", VC_AGENT_USER_DATA_DIR: userDataDirectory }
  });

  try {
    const window = await application.firstWindow();
    await expect(window).toHaveTitle("vc-agent");
    await expect(window.getByLabel("Navigation")).toBeVisible();
    await expect(window.getByTestId("empty-workspace")).toBeVisible();
    await expect(window.getByRole("complementary", { name: "Project state" })).toBeVisible();
    await expect(window.getByText("No threads", { exact: true })).toBeVisible();
    await expect(window.getByText("No projects", { exact: true })).toBeVisible();

    const bootstrap = await window.evaluate(async () => {
      const bridge = (window as unknown as {
        vcAgent: { invoke(command: unknown): Promise<{ event: string; payload: unknown }> };
      }).vcAgent;
      return bridge.invoke({
        schemaVersion: 1,
        command: "app.bootstrap",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        actor: { actorType: "user", actorId: "e2e" },
        sentAt: new Date().toISOString()
      });
    });
    expect(bootstrap).toMatchObject({
      event: "app.bootstrap.completed",
      payload: {
        entityCounts: { projects: 0, threads: 0, modelProfiles: 0, taskAssignments: 0 },
        runtimeActivity: {
          agentWorkersStarted: 0,
          piSessionsStarted: 0,
          providerRequests: 0,
          externalNetworkRequests: 0
        }
      }
    });

    await window.getByRole("button", { name: "Settings" }).click();
    await expect(window.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(window.getByText("Agent workers")).toBeVisible();
    await expect(window.locator("dl").nth(1).getByText("0", { exact: true })).toHaveCount(3);

    await window.evaluate(async () => {
      await (window as unknown as { vcAgent: { invoke(command: unknown): Promise<unknown> } }).vcAgent.invoke({
        schemaVersion: 999,
        command: "app.bootstrap",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        actor: { actorType: "user", actorId: "e2e" },
        sentAt: new Date().toISOString()
      });
    });
    await expect(window.getByRole("alert")).toContainText("UNSUPPORTED_SCHEMA_VERSION");
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});

test("retains a missing-Profile turn and runs Pi only after manual Profile selection and retry", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-f2-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  const apiKey = "sk-invalid-vc-agent-e2e-secret";
  const application = await electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", VC_AGENT_USER_DATA_DIR: userDataDirectory }
  });

  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "New thread" }).click();
    await expect(window.getByRole("heading", { name: "Thread 1" })).toBeVisible();
    await window.getByLabel("Message").fill("Reply with one short sentence.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(window.getByText("Model Profile not configured")).toBeVisible();

    const beforeProfile = await invokeBootstrap(window);
    expect(beforeProfile).toMatchObject({
      payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } }
    });

    await window.getByRole("button", { name: "Adjust profile" }).click();
    await window.getByRole("button", { name: "New profile" }).click();
    await window.getByLabel("Name").fill("Invalid key fixture");
    await window.getByLabel("Provider").fill("anthropic");
    await window.getByLabel("Model").fill("claude-sonnet-4-5");
    await window.getByLabel("API key").fill(apiKey);
    await window.getByRole("button", { name: "Save profile" }).click();
    await expect(window.getByText("Invalid key fixture", { exact: true })).toBeVisible();

    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Invalid key fixture" });
    await expect(window.getByText("anthropic / claude-sonnet-4-5", { exact: true }).first()).toBeVisible();
    await window.getByRole("button", { name: "Retry" }).click();

    await expect(window.locator(".provider-failure")).toHaveCount(2, { timeout: 30_000 });
    const providerFailure = window.locator(".provider-failure").last();
    await expect(providerFailure).not.toContainText(apiKey);
    await expect(providerFailure).toContainText("anthropic / claude-sonnet-4-5");

    const afterRetry = await invokeBootstrap(window);
    expect(afterRetry).toMatchObject({
      payload: { runtimeActivity: { agentWorkersStarted: 1, piSessionsStarted: 1, providerRequests: 1 } }
    });

    const database = new DatabaseSync(join(userDataDirectory, "state.db"), { readOnly: true });
    const credential = database.prepare("SELECT encrypted_value FROM protected_credentials").get() as { encrypted_value: Uint8Array };
    const profileColumns = database.prepare("PRAGMA table_info(model_profiles)").all().map((row) => String(row.name));
    database.close();
    expect(Buffer.from(credential.encrypted_value).toString("utf8")).not.toContain(apiKey);
    expect(profileColumns).not.toContain("api_key");
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});

test("persists an interrupted trajectory, requires cross-Provider authorization, and reopens without Pi", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-f3-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  const anthropicKey = "sk-invalid-f3-anthropic-secret";
  const openaiKey = "sk-invalid-f3-openai-secret";
  let application = await launchApplication(root, userDataDirectory);

  try {
    let window = await application.firstWindow();
    await window.getByRole("button", { name: "New thread" }).click();
    await window.getByRole("button", { name: "Settings" }).click();
    await createProfile(window, { name: "Provider A", provider: "anthropic", model: "claude-sonnet-4-5", apiKey: anthropicKey });
    await createProfile(window, { name: "Provider B", provider: "openai", model: "gpt-4.1", apiKey: openaiKey });
    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Provider A" });

    await window.getByLabel("Message").fill("Produce a deliberately slow answer.");
    await window.getByRole("button", { name: "Send" }).click();
    await window.getByRole("button", { name: "Stop" }).click();
    await expect(window.getByText("Interrupted", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(window.getByText("The previous request will not resume automatically.")).toBeVisible();

    await window.getByLabel("Active Model Profile").selectOption({ label: "Provider B" });
    const choice = window.getByRole("dialog", { name: "Cross-Provider continuation" });
    await expect(choice).toContainText("visible Thread trajectory");
    await expect(choice.getByRole("button", { name: "Start new thread" })).toBeVisible();
    await choice.getByRole("button", { name: "Continue current thread" }).click();
    await expect(window.getByText("openai / gpt-4.1", { exact: true }).first()).toBeVisible();

    await application.close();
    const threadId = readdirSync(join(userDataDirectory, "threads"))[0]!;
    const trajectoryPath = join(userDataDirectory, "threads", threadId, "trajectory.jsonl");
    const trajectory = readFileSync(trajectoryPath, "utf8");
    expect(trajectory).toContain('"event":"turn.interrupted"');
    expect(trajectory).toContain('"action":"continue_current_thread"');
    expect(trajectory).not.toContain(anthropicKey);
    expect(trajectory).not.toContain(openaiKey);
    const inflightDirectory = join(userDataDirectory, "threads", threadId, "inflight");
    expect(existsSync(inflightDirectory) ? readdirSync(inflightDirectory) : []).toEqual([]);

    application = await launchApplication(root, userDataDirectory);
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Thread 1", exact: true }).click();
    await expect(window.getByText("Produce a deliberately slow answer.", { exact: true })).toBeVisible();
    await expect(window.getByText("Interrupted", { exact: true })).toBeVisible();
    await expect(window.getByText("openai / gpt-4.1", { exact: true }).first()).toBeVisible();
    const bootstrap = await invokeBootstrap(window);
    expect(bootstrap).toMatchObject({
      payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } }
    });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});

test("gates text Outputs on explicit intent and a selected Unscoped Output Location", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-f4-e2e-"));
  const outputDirectory = mkdtempSync(join(tmpdir(), "vc-agent-f4-output-"));
  const root = resolve(import.meta.dirname, "../..");
  let application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_OUTPUT_LOCATION: outputDirectory });

  try {
    let window = await application.firstWindow();
    await window.getByRole("button", { name: "New thread" }).click();
    await window.getByLabel("Message").fill("Analyze the company and discuss the risks.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(window.getByText("Model Profile not configured")).toBeVisible();
    expect(readdirSync(outputDirectory)).toEqual([]);

    await window.getByLabel("Message").fill("Create a memo file for this investment view.");
    await window.getByRole("button", { name: "Send" }).click();
    const outputFailure = window.locator(".provider-failure").filter({ hasText: "OUTPUT_LOCATION_NOT_CONFIGURED" });
    await expect(outputFailure).toBeVisible();
    await outputFailure.getByRole("button", { name: "Choose output location" }).click();
    await expect(window.getByTitle(outputDirectory)).toBeVisible();
    expect(readdirSync(outputDirectory)).toEqual([]);

    await outputFailure.getByRole("button", { name: "Retry" }).click();
    await expect(window.getByText("Model Profile not configured")).toHaveCount(2);
    const bootstrapBeforeProfile = await invokeBootstrap(window);
    expect(bootstrapBeforeProfile).toMatchObject({
      payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } }
    });
    expect(readdirSync(outputDirectory)).toEqual([]);

    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByRole("button", { name: "Full Access" }).click();
    await application.close();

    application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_OUTPUT_LOCATION: outputDirectory });
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Thread 1", exact: true }).click();
    await expect(window.getByText("Full access", { exact: true })).toBeVisible();
    const bootstrapAfterRestart = await invokeBootstrap(window);
    expect(bootstrapAfterRestart).toMatchObject({
      payload: { accessMode: "full", runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } }
    });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("opens a stable Project, isolates Project Threads, and resolves moved or copied identities", async () => {
  test.setTimeout(90_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-f5-e2e-"));
  const originalProject = mkdtempSync(join(tmpdir(), "vc-agent-f5-project-"));
  const movedProject = `${originalProject}-moved`;
  const copiedProject = `${originalProject}-copy`;
  const root = resolve(import.meta.dirname, "../..");
  const apiKey = "sk-invalid-f5-project-secret";
  writeFileSync(join(originalProject, "company-notes.txt"), "Confidential fixture material");
  let application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: originalProject });

  try {
    let window = await application.firstWindow();
    await window.getByRole("button", { name: "Open project" }).click();
    const projectName = originalProject.split(/[\\/]/).at(-1)!;
    await expect(window.getByText(projectName, { exact: true })).toBeVisible();
    const markerPath = join(originalProject, "outputs", "system", "project.json");
    const firstMarker = JSON.parse(readFileSync(markerPath, "utf8")) as { projectId: string };
    expect(Object.keys(JSON.parse(readFileSync(markerPath, "utf8"))).sort()).toEqual(["createdAt", "projectId", "schemaVersion"]);
    expect(readdirSync(join(originalProject, "outputs", "system"))).toEqual(["project.json"]);
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { entityCounts: { projects: 1 }, runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });

    await window.getByRole("button", { name: `New thread in ${projectName}` }).click();
    await expect(window.getByRole("heading", { name: "Thread 1" })).toBeVisible();
    await window.getByRole("button", { name: "Settings" }).click();
    await createProfile(window, { name: "Project Provider", provider: "anthropic", model: "claude-sonnet-4-5", apiKey });
    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Project Provider" });

    const databaseBeforeWork = new DatabaseSync(join(userDataDirectory, "state.db"), { readOnly: true });
    const authorizationCount = Number((databaseBeforeWork.prepare("SELECT COUNT(*) AS count FROM project_provider_authorizations").get() as { count: number }).count);
    databaseBeforeWork.close();
    expect(authorizationCount).toBe(1);
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });

    await window.getByLabel("Message").fill("Discuss this project without loading local materials.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(window.locator(".provider-failure")).toHaveCount(1, { timeout: 30_000 });

    await window.getByRole("button", { name: `New thread in ${projectName}` }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Project Provider" });
    await window.getByLabel("Message").fill("Start an independent project discussion.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(window.locator(".provider-failure")).toHaveCount(1, { timeout: 30_000 });

    const databaseAfterWork = new DatabaseSync(join(userDataDirectory, "state.db"), { readOnly: true });
    const projectThreads = databaseAfterWork.prepare("SELECT id FROM threads WHERE scope = 'project' ORDER BY created_at").all() as Array<{ id: string }>;
    const contexts = databaseAfterWork.prepare("SELECT thread_id, session_file FROM physical_contexts ORDER BY thread_id").all() as Array<{ thread_id: string; session_file: string }>;
    databaseAfterWork.close();
    expect(projectThreads).toHaveLength(2);
    expect(new Set(contexts.map((context) => context.thread_id))).toEqual(new Set(projectThreads.map((thread) => thread.id)));
    expect(new Set(contexts.map((context) => context.session_file)).size).toBe(2);

    await application.close();
    renameSync(originalProject, movedProject);
    application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: movedProject });
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Open project" }).click();
    const movedDialog = window.getByRole("dialog", { name: "Project identity collision" });
    await expect(movedDialog).toBeVisible();
    await movedDialog.getByRole("button", { name: "Moved Project" }).click();
    await expect(window.getByText(movedProject.split(/[\\/]/).at(-1)!, { exact: true })).toBeVisible();
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });

    await application.close();
    cpSync(movedProject, copiedProject, { recursive: true });
    application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: copiedProject });
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Open project" }).click();
    const copyDialog = window.getByRole("dialog", { name: "Project identity collision" });
    await expect(copyDialog).toBeVisible();
    await copyDialog.getByRole("button", { name: "Project Copy" }).click();
    await expect(window.getByText(copiedProject.split(/[\\/]/).at(-1)!, { exact: true })).toBeVisible();
    const copiedMarker = JSON.parse(readFileSync(join(copiedProject, "outputs", "system", "project.json"), "utf8")) as { projectId: string };
    expect(copiedMarker.projectId).not.toBe(firstMarker.projectId);
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { entityCounts: { projects: 2, threads: 2 }, runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(originalProject, { recursive: true, force: true });
    rmSync(movedProject, { recursive: true, force: true });
    rmSync(copiedProject, { recursive: true, force: true });
  }
});

test("inventories Project Materials and requires explicit stale parse refresh choices", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-d2-e2e-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-d2-project-"));
  const root = resolve(import.meta.dirname, "../..");
  const memoPath = join(projectDirectory, "memo.md");
  mkdirSync(join(projectDirectory, "outputs"), { recursive: true });
  mkdirSync(join(projectDirectory, ".cache"), { recursive: true });
  writeFileSync(memoPath, "Initial investment thesis");
  writeFileSync(join(projectDirectory, "outputs", "generated.md"), "Generated output must not be inventoried");
  writeFileSync(join(projectDirectory, ".cache", "cached.txt"), "Reserved cache content");
  let application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: projectDirectory });

  try {
    let window = await application.firstWindow();
    await window.getByRole("button", { name: "Open project" }).click();
    const projectName = projectDirectory.split(/[\\/]/).at(-1)!;
    await window.getByRole("button", { name: `New thread in ${projectName}` }).click();
    const inventory = window.locator(".material-inventory");
    await expect(inventory.getByText("memo.md", { exact: true })).toBeVisible();
    await expect(inventory).toContainText("metadata only");
    await expect(inventory).not.toContainText("Initial investment thesis");
    await expect(inventory).not.toContainText("generated.md");
    await expect(inventory).not.toContainText("cached.txt");
    expect(await invokeBootstrap(window)).toMatchObject({
      payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0, externalNetworkRequests: 0 } }
    });

    await application.close();
    const databasePath = join(userDataDirectory, "state.db");
    const database = new DatabaseSync(databasePath);
    const material = database.prepare("SELECT id, source_hash FROM materials WHERE relative_path = 'memo.md'").get() as { id: string; source_hash: string };
    const priorParseId = crypto.randomUUID();
    database.prepare(`
      INSERT INTO parsed_material_versions(id, material_id, source_hash, parser_id, artifact_path, status, created_at)
      VALUES (?, ?, ?, 'markdown@1', 'outputs/parsed/memo/parse.json', 'active', ?)
    `).run(priorParseId, material.id, material.source_hash, new Date().toISOString());
    database.close();

    application = await launchApplication(root, userDataDirectory);
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Thread 1", exact: true }).click();
    await expect(window.locator(".material-row").filter({ hasText: "memo.md" })).toContainText("available");
    writeFileSync(memoPath, "Externally revised investment thesis with a changed source hash");
    const materialRow = window.locator(".material-row").filter({ hasText: "memo.md" });
    await expect(materialRow).toContainText("stale", { timeout: 10_000 });

    await materialRow.getByRole("button", { name: "Refresh parse" }).click();
    let choice = window.getByRole("dialog", { name: "Parse refresh choice" });
    await expect(choice.getByRole("button", { name: "Create New Parse Version" })).toBeVisible();
    await expect(choice.getByRole("button", { name: "Replace Previous Parse" })).toBeVisible();
    await choice.getByRole("button", { name: "Cancel" }).click();
    await expect(choice).toBeHidden();

    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByRole("button", { name: "Full Access" }).click();
    await window.getByRole("button", { name: "Settings" }).click();
    await materialRow.getByRole("button", { name: "Refresh parse" }).click();
    choice = window.getByRole("dialog", { name: "Parse refresh choice" });
    await choice.getByRole("button", { name: "Replace Previous Parse" }).click();
    await expect(choice).toBeHidden();
    await expect(materialRow).toContainText("available", { timeout: 20_000 });

    const persisted = new DatabaseSync(databasePath, { readOnly: true });
    const requests = persisted.prepare("SELECT choice, status FROM parse_refresh_requests ORDER BY created_at, rowid").all();
    const priorParse = persisted.prepare("SELECT status FROM parsed_material_versions WHERE id = ?").get(priorParseId);
    persisted.close();
    expect(requests).toMatchObject([{ choice: "cancel", status: "cancelled" }, { choice: "replace_previous", status: "completed" }]);
    expect(priorParse).toMatchObject({ status: "source_unavailable" });
    expect(await invokeBootstrap(window)).toMatchObject({
      payload: { accessMode: "full", runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0, externalNetworkRequests: 0 } }
    });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

test("produces and reuses a local Canonical Parse without starting Pi", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-d3-e2e-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-d3-project-"));
  const root = resolve(import.meta.dirname, "../..");
  writeFileSync(join(projectDirectory, "memo.md"), "# Investment thesis\nCanonical source evidence");
  writeFileSync(join(projectDirectory, "broken.json"), "{not-json");
  const application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: projectDirectory });

  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "Open project" }).click();
    const projectName = projectDirectory.split(/[\\/]/).at(-1)!;
    await window.getByRole("button", { name: `New thread in ${projectName}` }).click();
    const brokenRow = window.locator(".material-row").filter({ hasText: "broken.json" });
    await brokenRow.getByRole("button", { name: "Parse" }).click();
    await expect(brokenRow.locator(".parse-result")).toContainText("PARSER_FAILED", { timeout: 20_000 });
    await expect(brokenRow).toContainText("unparsed");
    const row = window.locator(".material-row").filter({ hasText: "memo.md" });
    await row.getByRole("button", { name: "Parse" }).click();
    await expect(row).toContainText("available", { timeout: 20_000 });
    await expect(row.locator(".parse-result")).toHaveText("Parsed");

    const database = new DatabaseSync(join(userDataDirectory, "state.db"), { readOnly: true });
    const parsed = database.prepare(`
      SELECT m.id AS material_id, p.id AS parse_id, p.parser_id, p.artifact_path
      FROM materials m JOIN parsed_material_versions p ON p.material_id = m.id WHERE m.relative_path = 'memo.md' AND p.status = 'active'
    `).get() as { material_id: string; parse_id: string; parser_id: string; artifact_path: string };
    database.close();
    expect(parsed.parser_id).toBe("text@1.0.0");
    const artifact = JSON.parse(readFileSync(join(projectDirectory, parsed.artifact_path), "utf8"));
    expect(artifact).toMatchObject({ parseId: parsed.parse_id, material: { relativePath: "memo.md" }, parser: { id: "text", version: "1.0.0" }, provenance: { localOnly: true } });
    expect(artifact.blocks[0]).toMatchObject({ type: "heading", text: "Investment thesis", source: { locator: { kind: "line", index: 1 } } });
    const registry = readFileSync(join(projectDirectory, "outputs", "system", "artifacts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(registry).toMatchObject([{ id: parsed.parse_id, type: "canonical_parse", path: parsed.artifact_path, source: { relativePath: "memo.md" }, parserId: "text@1.0.0", producer: "utility-worker" }]);

    const reused = await window.evaluate(async (materialId) => {
      return (window as unknown as { vcAgent: { invoke(command: unknown): Promise<unknown> } }).vcAgent.invoke({
        schemaVersion: 1, command: "material.parse.request", commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(),
        actor: { actorType: "user", actorId: "e2e" }, sentAt: new Date().toISOString(), payload: { materialId }
      });
    }, parsed.material_id);
    expect(reused).toMatchObject({ event: "material.parse.completed", payload: { parseId: parsed.parse_id, reused: true } });
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0, externalNetworkRequests: 0 } } });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

test("freezes a System Prompt revision until the next Prompt Load Boundary", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-d1-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  let application = await launchApplication(root, userDataDirectory);

  try {
    let window = await application.firstWindow();
    await window.getByRole("button", { name: "New thread" }).click();
    await window.getByRole("button", { name: "Settings" }).click();
    await expect(window.getByLabel("Minimal VC System Prompt")).toHaveValue(/1\. VC identity:/);
    await expect(window.getByLabel("Minimal VC System Prompt")).toHaveValue(/6\. Action boundary:/);
    await createProfile(window, { name: "Prompt Boundary Provider", provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "sk-invalid-d1-secret" });
    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Prompt Boundary Provider" });
    await window.getByLabel("Message").fill("Establish the first physical context.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(window.locator(".provider-failure")).toHaveCount(1, { timeout: 30_000 });

    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByLabel("Minimal VC System Prompt").fill("CUSTOM ACTIVE PROMPT REVISION");
    await window.getByLabel("System Prompt change note").fill("Boundary test");
    await window.getByRole("button", { name: "Save revision" }).click();
    await expect(window.locator(".prompt-history details")).toHaveCount(2);
    const newest = window.locator(".prompt-history details").first();
    await newest.locator("summary").click();
    await newest.getByRole("button", { name: "Activate" }).click();
    await expect(newest.locator("summary")).toContainText("Active");

    await window.getByRole("button", { name: "Settings" }).click();
    await window.locator(".provider-failure").last().getByRole("button", { name: "Retry" }).click();
    await expect(window.getByText("Establish the first physical context.", { exact: true })).toHaveCount(2);

    const threadId = readdirSync(join(userDataDirectory, "threads"))[0]!;
    const trajectoryPath = join(userDataDirectory, "threads", threadId, "trajectory.jsonl");
    let submitted = readFileSync(trajectoryPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.event === "turn.submitted");
    expect(submitted).toHaveLength(2);
    expect(submitted[0].payload.prompt.revisionId).toBe(submitted[1].payload.prompt.revisionId);
    expect(submitted[0].payload.prompt.contributions.toolSchemaEstimatedTokens).toBeGreaterThan(0);
    expect(submitted[0].payload.prompt.contributions).toMatchObject({ contextEstimatedTokens: 0, materialEstimatedTokens: 0 });

    await application.close();
    application = await launchApplication(root, userDataDirectory);
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Thread 1", exact: true }).click();
    await window.locator(".provider-failure").last().getByRole("button", { name: "Retry" }).click();
    await expect(window.getByText("Establish the first physical context.", { exact: true })).toHaveCount(3);
    await expect(window.getByText(/System prompt updated:/)).toBeVisible();

    submitted = readFileSync(trajectoryPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.event === "turn.submitted");
    expect(submitted).toHaveLength(3);
    expect(submitted[2].payload.prompt.revisionId).not.toBe(submitted[1].payload.prompt.revisionId);
    const database = new DatabaseSync(join(userDataDirectory, "state.db"), { readOnly: true });
    const revisions = database.prepare("SELECT hash, diff, change_note FROM system_prompt_revisions ORDER BY created_at").all() as Array<{ hash: string; diff: string; change_note: string | null }>;
    database.close();
    expect(revisions).toHaveLength(2);
    expect(revisions[1]).toMatchObject({ change_note: "Boundary test" });
    expect(revisions[1]!.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(revisions[1]!.diff).toContain("CUSTOM ACTIVE PROMPT REVISION");
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});

async function launchApplication(root: string, userDataDirectory: string, extraEnvironment: Record<string, string> = {}) {
  return electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", VC_AGENT_USER_DATA_DIR: userDataDirectory, ...extraEnvironment }
  });
}

async function createProfile(window: import("@playwright/test").Page, input: { name: string; provider: string; model: string; apiKey: string }) {
  await window.getByRole("button", { name: "New profile" }).click();
  await window.getByLabel("Name").fill(input.name);
  await window.getByLabel("Provider").fill(input.provider);
  await window.getByLabel("Model").fill(input.model);
  await window.getByLabel("API key").fill(input.apiKey);
  await window.getByRole("button", { name: "Save profile" }).click();
  await expect(window.getByText(input.name, { exact: true })).toBeVisible();
}

async function invokeBootstrap(window: { evaluate<T>(fn: () => Promise<T>): Promise<T> }) {
  return window.evaluate(async () => {
    return (window as unknown as { vcAgent: { invoke(command: unknown): Promise<unknown> } }).vcAgent.invoke({
      schemaVersion: 1,
      command: "app.bootstrap",
      commandId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      actor: { actorType: "user", actorId: "e2e" },
      sentAt: new Date().toISOString()
    });
  });
}
