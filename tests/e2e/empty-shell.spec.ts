import { _electron as electron, expect, test } from "@playwright/test";
import { join, resolve } from "node:path";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { LongTermMemoryStore } from "@vc-agent/host-services";

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
    expect(existsSync(join(userDataDirectory, "skills"))).toBe(false);
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
    expect(existsSync(join(userDataDirectory, "skills"))).toBe(false);
    for (const metric of ["Agent workers", "Pi sessions", "Provider requests", "Execution failures"]) {
      await expect(window.getByText(metric, { exact: true }).locator("..").getByText("0", { exact: true })).toBeVisible();
    }
    await expect(window.getByRole("heading", { name: "Environment Doctor" })).toBeVisible();
    await expect(window.getByRole("heading", { name: "Learning telemetry" })).toBeVisible();
    await expect(window.getByText("Remote content telemetry", { exact: true })).toBeVisible();
    for (const item of ["Pi SDK", "Provider", "Parsers", "Credentials", "Storage", "Migration", "Bundled Extensions"]) await expect(window.getByText(item, { exact: true })).toBeVisible();
    for (const unavailable of ["Dream", "Reflection", "Long-term Memory", "Sub-Agent", "Office", "OCR", "MCP", "Extension Audit"]) await expect(window.getByRole("button", { name: unavailable, exact: true })).toHaveCount(0);

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

test("opens newer local state in visible read-only recovery without changing it", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-newer-state-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  await initializeState(root, userDataDirectory);
  const databasePath = join(userDataDirectory, "state.db");
  const database = new DatabaseSync(databasePath);
  database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (99, ?)").run(new Date().toISOString());
  database.close();
  const before = sqliteBundle(databasePath);
  const application = await launchApplication(root, userDataDirectory);

  try {
    const window = await application.firstWindow();
    await expect(window.getByText("Read-only Recovery", { exact: true })).toBeVisible();
    await expect(window.getByRole("button", { name: "New thread" })).toBeDisabled();
    await window.getByRole("button", { name: "Settings" }).click();
    await expect(window.getByRole("button", { name: "Export raw state" })).toBeVisible();
    await expect(window.getByText("Raw state may contain encrypted credentials", { exact: false })).toBeVisible();
    const bootstrap = await invokeBootstrap(window);
    expect(bootstrap).toMatchObject({
      payload: {
        storageMode: "read_only_recovery",
        migration: { status: "newer_state", storedVersion: 99, supportedVersion: 14, rollbackAvailable: false },
        runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 }
      }
    });
    const rejected = await invokeRaw(window, "thread.create.unscoped", { title: "Blocked" });
    expect(rejected).toMatchObject({ event: "diagnostic.raised", payload: { code: "READ_ONLY_RECOVERY_MODE" } });
  } finally {
    await application.close();
    expect(sqliteBundle(databasePath)).toEqual(before);
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});

test("imports, inspects, activates, and restores a Skill through Settings", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-skills-e2e-"));
  const skillSource = mkdtempSync(join(tmpdir(), "vc-agent-skill-source-e2e-"));
  writeFileSync(join(skillSource, "SKILL.md"), ["---", "name: Fixture Skill", "description: A bounded fixture", "keywords: fixture, document", "---", "# Fixture Skill", "Use the bounded fixture."].join("\n"), "utf8");
  writeFileSync(join(skillSource, "LICENSE"), "fixture license", "utf8");
  const root = resolve(import.meta.dirname, "../..");
  let application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_SKILL_SOURCE: skillSource });
  try {
    let window = await application.firstWindow();
    await window.getByRole("button", { name: "Settings" }).click();
    await expect(window.getByTestId("skills-settings")).toBeVisible();
    await expect(window.getByText("No imported Skill packages", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "Import Skill" }).click();
    const row = window.locator("[data-testid=skills-settings] .profile-row");
    await expect(row).toBeVisible();
    await expect(row).toContainText("copied");
    await row.getByRole("button", { name: "Inspect" }).click();
    await expect(row).toContainText("awaiting_activation");
    await row.getByRole("button", { name: "Activate" }).click();
    await expect(row).toContainText("active");
    expect(existsSync(join(userDataDirectory, "skills", "inventory.json"))).toBe(true);
    await application.close();
    application = await launchApplication(root, userDataDirectory);
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Settings" }).click();
    const restoredRow = window.locator(".profile-row").filter({ hasText: "Fixture Skill" });
    await expect(restoredRow).toContainText("active");
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(skillSource, { recursive: true, force: true });
  }
});

test("exposes lazy Integration status and keeps MCP disconnected after configuration", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-integrations-e2e-"));
  const extensionSource = mkdtempSync(join(tmpdir(), "vc-agent-extension-source-e2e-"));
  writeFileSync(join(extensionSource, "package.json"), JSON.stringify({ name: "fixture-extension", version: "1.0.0", license: "MIT", main: "index.js" }), "utf8");
  writeFileSync(join(extensionSource, "package-lock.json"), "{}", "utf8");
  writeFileSync(join(extensionSource, "index.js"), "module.exports = {};", "utf8");
  const root = resolve(import.meta.dirname, "../..");
  const application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_EXTENSION_SOURCE: extensionSource });
  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "Settings" }).click();
    await expect(window.getByTestId("integrations-settings")).toBeVisible();
    await expect(window.getByRole("heading", { name: "Integrations" })).toBeVisible();
    await expect(window.getByText("Pinned MCP adapter is dormant; no server connection is open.", { exact: true })).toBeVisible();
    const serverId = crypto.randomUUID();
    const saved = await invokeRaw(window, "mcp.server.save", { serverId, name: "Fixture MCP", transport: "fixture", enabled: true, allowedScopes: ["project"] });
    expect(saved).toMatchObject({ event: "integration.state.updated", payload: { state: { mcp: { servers: [{ serverId, connectionStatus: "disconnected" }] } } } });
    expect(existsSync(join(userDataDirectory, "integrations", "mcp", "mcp-servers.json"))).toBe(true);
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(extensionSource, { recursive: true, force: true });
  }
});

test("completes the desktop C1 fixture paths without eager external activation", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-c1-fixtures-e2e-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-c1-project-e2e-"));
  const skillSource = mkdtempSync(join(tmpdir(), "vc-agent-c1-skill-source-e2e-"));
  const extensionSource = mkdtempSync(join(tmpdir(), "vc-agent-c1-extension-source-e2e-"));
  writeFileSync(join(projectDirectory, "fixture.pdf"), "fixture pdf bytes", "utf8");
  writeFileSync(join(projectDirectory, "fixture.docx"), "fixture office source bytes", "utf8");
  writeFileSync(join(skillSource, "SKILL.md"), "---\nname: C1 Office\ndescription: fixture\n---\n# C1 Office\n", "utf8");
  writeFileSync(join(skillSource, "LICENSE"), "fixture", "utf8");
  writeFileSync(join(extensionSource, "package.json"), JSON.stringify({ name: "c1-extension", version: "1.0.0", license: "MIT", main: "index.js" }), "utf8");
  writeFileSync(join(extensionSource, "package-lock.json"), "{}", "utf8");
  writeFileSync(join(extensionSource, "index.js"), "module.exports = {};", "utf8");
  const root = resolve(import.meta.dirname, "../..");
  const application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: projectDirectory, VC_AGENT_TEST_SKILL_SOURCE: skillSource, VC_AGENT_TEST_EXTENSION_SOURCE: extensionSource });
  try {
    const window = await application.firstWindow();
    const opened = await invokeRaw(window, "project.open");
    const projectId = (opened as { payload: { project: { id: string } } }).payload.project.id;
    await window.getByRole("button", { name: `New thread in ${projectDirectory.split(/[\\/]/).at(-1)!}` }).click();
    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByRole("button", { name: "Import Skill" }).click();
    const skillRow = window.locator("[data-testid=skills-settings] .profile-row");
    await skillRow.getByRole("button", { name: "Inspect" }).click();
    await skillRow.getByRole("button", { name: "Activate" }).click();
    const integration = window.getByTestId("integrations-settings");
    const officeCard = integration.locator(".integration-card").filter({ hasText: "Office Skills" });
    await officeCard.getByRole("button", { name: "Prepare Office task" }).click();
    await officeCard.getByRole("button", { name: "Run", exact: true }).click();
    await expect(officeCard.getByRole("button", { name: "Commit copy" })).toBeVisible();
    await officeCard.getByRole("button", { name: "Commit copy" }).click();
    await officeCard.getByRole("button", { name: "Prepare Office edit" }).click();
    await officeCard.getByRole("button", { name: "Run", exact: true }).click();
    await expect(officeCard.getByRole("button", { name: "Request source replacement" })).toBeVisible();
    await officeCard.getByRole("button", { name: "Request source replacement" }).click();
    await officeCard.getByRole("button", { name: "Approve replacement" }).click();
    await integration.getByRole("button", { name: "Create explicit draft" }).click();
    await expect(integration.getByText("desktop-created-skill", { exact: false })).toBeVisible();
    await integration.getByRole("button", { name: "Review" }).click();
    await integration.getByRole("button", { name: "Hand off disabled" }).click();
    const pageRecoveryCard = integration.locator(".integration-card").filter({ hasText: "Page Recovery / OCR" });
    await pageRecoveryCard.getByRole("button", { name: "Run Page Recovery" }).click();
    await expect(pageRecoveryCard).toContainText("completed");
    await expect(pageRecoveryCard).toContainText("Last Parse · per-page retained result");
    await integration.getByLabel("MCP endpoint").fill("Fixture MCP");
    await integration.getByRole("button", { name: "Save config" }).click();
    await expect(integration.getByText("Fixture MCP", { exact: false })).toBeVisible();
    await integration.getByRole("button", { name: "Activate", exact: true }).click();
    await expect(integration.getByRole("button", { name: "Run read" })).toBeVisible();
    await integration.getByRole("button", { name: "Run read" }).click();
    await integration.getByRole("button", { name: "Confirm write" }).click();
    await integration.getByRole("button", { name: "Disconnect", exact: true }).click();
    await integration.getByRole("button", { name: "Stage Extension" }).click();
    const extensionCard = integration.locator(".integration-card").filter({ hasText: "Extension Admission" });
    await extensionCard.getByRole("button", { name: "Inspect" }).click();
    await extensionCard.getByRole("button", { name: "Audit" }).click();
    await extensionCard.getByRole("button", { name: "Approve" }).click();
    await extensionCard.getByRole("button", { name: "Prepare enable" }).click();
    await extensionCard.getByRole("button", { name: "Activate pending revision" }).click();
    await expect(extensionCard).toContainText("1 enabled");
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
    rmSync(skillSource, { recursive: true, force: true });
    rmSync(extensionSource, { recursive: true, force: true });
  }
});

test("executes an explicitly configured Office runner through the Utility Worker", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-office-runner-e2e-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-office-runner-project-e2e-"));
  const skillSource = mkdtempSync(join(tmpdir(), "vc-agent-office-runner-skill-e2e-"));
  writeFileSync(join(projectDirectory, "source.docx"), "source bytes are never passed to a fixture engine", "utf8");
  writeFileSync(join(skillSource, "SKILL.md"), "---\nname: Explicit Office Runner\ndescription: runner contract fixture\n---\n# Explicit Office Runner\n", "utf8");
  const root = resolve(import.meta.dirname, "../..");
  const application = await launchApplication(root, userDataDirectory, {
    VC_AGENT_TEST_PROJECT_PATH: projectDirectory,
    VC_AGENT_TEST_SKILL_SOURCE: skillSource,
    VC_AGENT_REAL_OFFICE: "1",
    VC_AGENT_OFFICE_RUNNER: process.execPath,
    VC_AGENT_OFFICE_RUNNER_ARGS: JSON.stringify([join(root, "tests/fixtures/office-runner.mjs")])
  });
  try {
    const window = await application.firstWindow();
    const opened = await invokeRaw(window, "project.open");
    const projectId = (opened as { payload: { project: { id: string } } }).payload.project.id;
    await window.getByRole("button", { name: `New thread in ${projectDirectory.split(/[\\/]/).at(-1)!}` }).click();
    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByRole("button", { name: "Import Skill" }).click();
    const skillRow = window.locator("[data-testid=skills-settings] .profile-row");
    await skillRow.getByRole("button", { name: "Inspect" }).click();
    await skillRow.getByRole("button", { name: "Activate" }).click();
    const integration = window.getByTestId("integrations-settings");
    const officeCard = integration.locator(".integration-card").filter({ hasText: "Office Skills" });
    await officeCard.getByRole("button", { name: "Prepare Office task" }).click();
    await officeCard.getByRole("button", { name: "Run", exact: true }).click();
    await expect(officeCard.getByRole("button", { name: "Commit copy" })).toBeVisible();
    await officeCard.getByRole("button", { name: "Commit copy" }).click();
    expect(projectId).toBeTruthy();
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
    rmSync(skillSource, { recursive: true, force: true });
  }
});

test("keeps old state active when staged migration fails", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-migration-failure-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  await initializeState(root, userDataDirectory);
  const databasePath = join(userDataDirectory, "state.db");
  const database = new DatabaseSync(databasePath);
  database.prepare("DELETE FROM schema_migrations WHERE version IN (10, 11, 12, 13, 14)").run();
  database.close();
  const before = sqliteBundle(databasePath);
  const application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_MIGRATION_FAIL_AFTER_STAGE: "1" });

  try {
    const window = await application.firstWindow();
    await expect(window.getByText("Read-only Recovery", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "Settings" }).click();
    await expect(window.getByText("migration_failed", { exact: true })).toBeVisible();
    await expect(window.getByText("Available", { exact: true })).toBeVisible();
    const bootstrap = await invokeBootstrap(window);
    expect(bootstrap).toMatchObject({
      payload: {
        storageMode: "read_only_recovery",
        migration: { status: "migration_failed", storedVersion: 9, supportedVersion: 14, rollbackAvailable: true },
        runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 }
      }
    });
  } finally {
    await application.close();
    expect(sqliteBundle(databasePath)).toEqual(before);
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});

test("backs up and mechanically restores Personal Cognition without Project metadata, credentials, or Pi", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-cognition-e2e-"));
  const backupParent = mkdtempSync(join(tmpdir(), "vc-agent-cognition-backup-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  const memory = new LongTermMemoryStore(join(userDataDirectory, "memory", "long-term"));
  memory.load(true);
  let application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_BACKUP_DESTINATION: backupParent });
  try {
    let window = await application.firstWindow();
    await window.getByRole("button", { name: "Settings" }).click();
    await createProfile(window, { name: "Restored profile", provider: "anthropic", model: "model-backup", apiKey: "must-not-export" });
    await window.locator(".settings-tabs").getByRole("tab", { name: "Memory" }).click();
    await window.getByLabel("Long-term Memory").fill(longTermMemoryFixture());
    await window.getByRole("button", { name: "Save Memory" }).click();
    await window.locator(".settings-tabs").getByRole("tab", { name: "General" }).click();
    await window.getByRole("button", { name: "Create backup" }).click();
    await expect(window.getByRole("status")).toContainText("Backup created");
    const bundle = join(backupParent, readdirSync(backupParent)[0]!);
    const manifest = readFileSync(join(bundle, "manifest.json"), "utf8");
    const state = readFileSync(join(bundle, "domains", "personal-state.json"), "utf8");
    expect(manifest).toContain('"credentialsIncluded": false');
    expect(manifest).toContain('"trajectoriesIncluded": false');
    expect(`${manifest}\n${state}`).not.toContain(userDataDirectory);
    expect(`${manifest}\n${state}`).not.toContain("must-not-export");
    expect(state).not.toContain("credentialRef");

    await application.close();
    writeFileSync(memory.markdownPath, "# Long-term Memory\n\nSchema-Version: 1\n\nchanged after backup\n", "utf8");
    application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_RESTORE_SOURCE: bundle, VC_AGENT_TEST_CONFIRM_RESTORE: "1" });
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByRole("button", { name: "Restore backup" }).click();
    await expect.poll(() => readFileSync(memory.markdownPath, "utf8")).toContain("Conservative TAM framing");
    await expect(window.getByText("Restored profile", { exact: true })).toBeVisible();
    const database = new DatabaseSync(join(userDataDirectory, "state.db"), { readOnly: true });
    const credential = database.prepare("SELECT length(encrypted_value) AS length FROM protected_credentials").get() as { length: number };
    database.close();
    expect(credential.length).toBe(0);
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(backupParent, { recursive: true, force: true });
  }
});

test("edits and recalls de-identified Long-term Memory without Project state", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-ltm-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  const memoryRoot = join(userDataDirectory, "memory", "long-term");
  const application = await launchApplication(root, userDataDirectory);

  try {
    const window = await application.firstWindow();
    expect(existsSync(memoryRoot)).toBe(false);
    await window.getByRole("button", { name: "Settings" }).click();
    await window.locator(".settings-tabs").getByRole("tab", { name: "Memory" }).click();
    await expect(window.getByRole("heading", { name: "Long-term Memory" })).toBeVisible();
    for (const file of ["long-term-memory.md", "long-term-memory-condensation-archive.md", "cognitive-evolution-history.md"]) {
      expect(existsSync(join(memoryRoot, file))).toBe(true);
      await expect(window.getByText(file, { exact: true })).toBeVisible();
    }
    await expect(window.getByRole("button", { name: "Open memory folder" })).toBeVisible();
    await window.getByRole("button", { name: "Refresh and re-index" }).click();
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });

    await window.getByLabel("Long-term Memory").fill(longTermMemoryFixture());
    await window.getByRole("button", { name: "Save Memory" }).click();
    await expect(window.getByText("1 current entries", { exact: true })).toBeVisible();
    const externallyEdited = `${longTermMemoryFixture()}\n${explicitOnlyMemoryFixture()}\n## Broken entry\nScope: global\n`;
    writeFileSync(join(memoryRoot, "long-term-memory.md"), externallyEdited, "utf8");
    await expect(window.getByLabel("Long-term Memory")).toHaveValue(externallyEdited, { timeout: 10_000 });
    await expect(window.getByText("2 current entries", { exact: true })).toBeVisible();
    await expect(window.getByText("1 explicit only", { exact: true })).toBeVisible();
    await expect(window.getByText("Memory entry requires a title, YYYY-MM-DD date, metadata block, blank line, and content.", { exact: false })).toBeVisible();
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { entityCounts: { projects: 0 }, runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });

    await invokeRaw(window, "access.mode.set", { mode: "full" });
    await window.getByRole("button", { name: "Prepare patch" }).click();
    const evolutionForm = window.locator(".memory-evolution-form");
    await evolutionForm.getByLabel("Entry ID").fill("ltm-bottom-up-market");
    await evolutionForm.getByLabel("Title").fill("Bottom-up market framing");
    await evolutionForm.getByLabel("Tags").fill("memo, market sizing");
    await evolutionForm.getByLabel("Applies to").fill("pre-revenue hard tech");
    await evolutionForm.getByLabel("Limitations").fill("Less useful after repeatable sales.");
    await evolutionForm.getByLabel("Proposed learning").fill("Prefer bottom-up serviceable-market assumptions before repeatable sales.");
    await evolutionForm.getByLabel("Memory Evolution rationale").fill("Explicitly reviewed reusable framing.");
    await evolutionForm.getByRole("button", { name: "Preview final patch" }).click();
    const preview = window.getByRole("dialog", { name: "Memory patch preview" });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Add ltm-bottom-up-market v1 as current.");
    await expect(preview.getByText("active · changed", { exact: true })).toBeVisible();
    expect(readFileSync(join(memoryRoot, "long-term-memory.md"), "utf8")).not.toContain("Bottom-up market framing");
    await preview.getByRole("button", { name: "Confirm Memory change" }).click();
    await expect(window.getByText("3 current entries", { exact: true })).toBeVisible();
    expect(readFileSync(join(memoryRoot, "long-term-memory.md"), "utf8")).toContain("Bottom-up market framing");
    expect(readFileSync(join(memoryRoot, "long-term-memory.md"), "utf8")).toContain("## Broken entry");

    const stalePreview = await invokeRaw(window, "long_term_memory.patch.prepare", {
      action: "add", targetEntryIds: [], rationale: "Prepare a stale patch fixture.",
      proposed: { id: "ltm-stale-fixture", title: "Stale fixture", date: "2026-07-19", tags: ["fixture"], applicability: ["seed financing"], maturity: "user-confirmed", recallPolicy: "automatic", limitations: "Fixture only.", content: "This proposal must not survive an external target change.", sourceReferenceIds: [] }
    }) as { event: string; payload: { patch: { id: string } } };
    expect(stalePreview.event).toBe("long_term_memory.patch.prepared");
    const agentCommit = await window.evaluate(async (patchId) => {
      return (window as unknown as { vcAgent: { invoke(command: unknown): Promise<unknown> } }).vcAgent.invoke({
        schemaVersion: 1, command: "long_term_memory.patch.commit", commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(),
        actor: { actorType: "agent", actorId: "primary-agent" }, sentAt: new Date().toISOString(), payload: { patchId, confirmed: true }
      });
    }, stalePreview.payload.patch.id);
    expect(agentCommit).toMatchObject({ event: "diagnostic.raised", payload: { message: "Memory changes require explicit User confirmation." } });
    const archivePath = join(memoryRoot, "long-term-memory-condensation-archive.md");
    writeFileSync(archivePath, `${readFileSync(archivePath, "utf8")}\nExternal archive change.\n`, "utf8");
    const staleCommit = await invokeRaw(window, "long_term_memory.patch.commit", { patchId: stalePreview.payload.patch.id, confirmed: true });
    expect(staleCommit).toMatchObject({ event: "diagnostic.raised", payload: { message: "Long-term Memory or its lineage changed after preview. Prepare a new patch before committing." } });
    expect(readFileSync(join(memoryRoot, "long-term-memory.md"), "utf8")).not.toContain("Stale fixture");
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });

    await window.locator(".settings-tabs").getByRole("tab", { name: "General" }).click();
    await createProfile(window, { name: "Memory fixture", provider: "vc-agent-memory-faux", model: "memory-fixture", apiKey: "fixture-key" });
    await window.getByRole("button", { name: "New thread", exact: true }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Memory fixture" });
    await window.getByLabel("Message").fill("Provide an investment judgment on market sizing for an early-stage hard tech opportunity.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(window.getByText("Recalled relevant Long-term Memory as prior judgment, not source evidence.", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(window.locator(".tool-activity").filter({ hasText: "ltm-tam-framing" })).toHaveCount(2);
    await expect(window.locator(".conversation")).not.toContainText("src_ref_alpha");
    await expect(window.locator(".conversation")).not.toContainText("projectId");

    await window.getByRole("button", { name: "Settings" }).click();
    await createProfile(window, { name: "Explicit Memory fixture", provider: "vc-agent-explicit-memory-faux", model: "memory-policy-fixture", apiKey: "fixture-key" });
    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByRole("button", { name: "New thread" }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Explicit Memory fixture" });
    await window.getByLabel("Message").fill("Use my long-term memory about founder reference diligence.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(window.getByText("Completed the Long-term Memory policy fixture.", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(window.locator(".tool-activity").filter({ hasText: "ltm-founder-reference" })).toHaveCount(2);

    await window.getByRole("button", { name: "New thread" }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Explicit Memory fixture" });
    await window.getByLabel("Message").fill("Provide an investment judgment on founder references for seed financing.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(window.getByText("Completed the Long-term Memory policy fixture.", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(window.locator(".tool-activity").filter({ hasText: "ltm-founder-reference" })).toHaveCount(0);

    await window.getByRole("button", { name: "New thread" }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Explicit Memory fixture" });
    await window.getByLabel("Message").fill("Summarize the supplied text neutrally.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(window.getByText("Completed the Long-term Memory policy fixture.", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(window.locator(".tool-activity.failed").filter({ hasText: "requires judgment-heavy work or an explicit User request" })).toHaveCount(2);
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});

test("permits Long-term Memory source drilldown only inside its authorized source Project", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-provenance-e2e-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-provenance-project-"));
  const root = resolve(import.meta.dirname, "../..");
  const application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: projectDirectory });

  try {
    const window = await application.firstWindow();
    const opened = await invokeRaw(window, "project.open") as { payload: { project: { id: string } } };
    const projectId = opened.payload.project.id;
    const created = await invokeRaw(window, "thread.create.project", { projectId, title: "Source verification" }) as { payload: { thread: { id: string } } };
    const threadId = created.payload.thread.id;
    const profile = await invokeRaw(window, "profile.create", { name: "Authorized source profile", provider: "fixture-provider", model: "fixture-model", apiKey: "fixture-key", thinkingLevel: "off" }) as { payload: { profile: { id: string } } };
    await invokeRaw(window, "thread.profile.select", { threadId, profileId: profile.payload.profile.id });
    await invokeRaw(window, "long_term_memory.load");
    const prepared = await invokeRaw(window, "long_term_memory.patch.prepare", {
      action: "add", targetEntryIds: [], rationale: "Approved source-linked learning.",
      proposed: { id: "ltm-source-linked", title: "Source-linked learning", date: "2026-07-19", tags: ["diligence"], applicability: ["seed financing"], maturity: "evidence-backed", recallPolicy: "automatic", limitations: "Confirm applicability case by case.", content: "Use independent customer evidence to test unusually coherent management narratives.", sourceReferenceIds: ["src_ref_project_one"] },
      provenanceRecords: [{ schemaVersion: 1, sourceReferenceId: "src_ref_project_one", projectId, workflowType: "reflection", workflowRunId: "reflection-run-e2e", judgmentRecordId: "judgment-e2e", threadId, evidenceReferences: ["memo.md#page=1"], availability: "active", createdAt: "2026-07-19T08:00:00.000Z" }]
    }) as { payload: { patch: { id: string } } };
    await invokeRaw(window, "long_term_memory.patch.commit", { patchId: prepared.payload.patch.id, confirmed: true });

    const available = await invokeRaw(window, "long_term_memory.provenance.inspect", { threadId, sourceReferenceId: "src_ref_project_one" });
    expect(available).toMatchObject({ event: "long_term_memory.provenance.inspected", payload: { status: "available", record: { projectId, workflowRunId: "reflection-run-e2e" } } });
    const missing = await invokeRaw(window, "long_term_memory.provenance.inspect", { threadId, sourceReferenceId: "src_ref_missing" });
    expect(missing).toMatchObject({ event: "long_term_memory.provenance.inspected", payload: { status: "source_unavailable" } });
    const unscoped = await invokeRaw(window, "thread.create.unscoped", { title: "Wrong scope" }) as { payload: { thread: { id: string } } };
    const rejected = await invokeRaw(window, "long_term_memory.provenance.inspect", { threadId: unscoped.payload.thread.id, sourceReferenceId: "src_ref_project_one" });
    expect(rejected).toMatchObject({ event: "diagnostic.raised", payload: { message: "Source verification requires an authorized Profile inside the source Project." } });
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
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

test("queues editable follow-ups and restores them as unsent drafts after restart", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-r0-queue-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  let application = await launchApplication(root, userDataDirectory, { VC_AGENT_EXECUTION_CAPACITY: "1", VC_AGENT_TEST_FAUX_DELAY_MS: "20000" });

  try {
    let window = await application.firstWindow();
    await window.getByRole("button", { name: "New thread" }).click();
    await window.getByRole("button", { name: "Settings" }).click();
    await createProfile(window, { name: "Queue fixture", provider: "vc-agent-faux", model: "fixture", apiKey: "fixture-key" });
    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Queue fixture" });

    await window.getByLabel("Message").fill("Keep this first Turn active.");
    await window.getByRole("button", { name: "Send", exact: true }).click();
    await expect(window.getByRole("button", { name: "Stop" })).toBeVisible();

    await window.getByLabel("Message").fill("Cancel this queued follow-up.");
    await window.getByRole("button", { name: "Queue follow-up" }).click();
    await expect(window.getByLabel("Execution Queue")).toBeVisible();
    await window.getByLabel("Message", { exact: true }).fill("Preserve this queued follow-up.");
    await window.getByRole("button", { name: "Queue follow-up" }).click();
    await expect(window.locator(".execution-queue-item")).toHaveCount(2);
    await window.locator(".execution-queue-item").first().getByRole("button", { name: "Cancel" }).click();
    await expect(window.locator(".execution-queue-item")).toHaveCount(1);
    await window.getByLabel("Queued message 1").fill("Edited follow-up survives restart.");
    await window.getByLabel("Queued message 1").press("Tab");
    await window.getByRole("button", { name: "Stop" }).click();
    await expect(window.getByText(/^Unsent draft ·/u)).toBeVisible();

    await application.close();
    application = await launchApplication(root, userDataDirectory, { VC_AGENT_EXECUTION_CAPACITY: "1" });
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Thread 1", exact: true }).click();
    await expect(window.getByText(/^Unsent draft ·/u)).toBeVisible();
    await expect(window.getByLabel("Queued message 1")).toHaveValue("Edited follow-up survives restart.");
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });

    await window.locator(".execution-queue-item").getByRole("button", { name: "Send" }).click();
    await expect(window.getByText("Edited follow-up survives restart.", { exact: true })).toBeVisible();
    await expect(window.locator(".execution-queue-item")).toHaveCount(0);
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});

test("admits capacity-blocked work from another Thread after the running Turn stops", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-r0-capacity-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  const application = await launchApplication(root, userDataDirectory, { VC_AGENT_EXECUTION_CAPACITY: "1", VC_AGENT_TEST_FAUX_DELAY_MS: "2000" });

  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "New thread" }).click();
    await window.getByRole("button", { name: "Settings" }).click();
    await createProfile(window, { name: "Capacity fixture", provider: "vc-agent-faux", model: "fixture", apiKey: "fixture-key" });
    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Capacity fixture" });
    await window.getByRole("button", { name: "New thread" }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Capacity fixture" });

    await window.getByRole("button", { name: "Thread 1", exact: true }).click();
    await window.getByLabel("Message", { exact: true }).fill("Occupy the only execution slot.");
    await window.getByRole("button", { name: "Send", exact: true }).click();
    await expect(window.getByRole("button", { name: "Stop" })).toBeVisible();
    await window.getByRole("button", { name: "Thread 2", exact: true }).click();
    await window.getByLabel("Message", { exact: true }).fill("Run after capacity becomes available.");
    await window.getByRole("button", { name: "Send", exact: true }).click();
    await expect(window.getByText(/Waiting for capacity · unscoped · Capacity fixture/u)).toBeVisible();

    await window.getByRole("button", { name: "Thread 1", exact: true }).click();
    await window.getByRole("button", { name: "Stop" }).click();
    await window.getByRole("button", { name: "Thread 2", exact: true }).click();
    await expect(window.getByText("Run after capacity becomes available.", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(window.locator(".execution-queue-item")).toHaveCount(0);
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

test("lazily edits Project Context and deterministically surfaces external Markdown warnings", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-d6-e2e-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-d6-project-"));
  const root = resolve(import.meta.dirname, "../..");
  const application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: projectDirectory });

  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "Open project" }).click();
    const projectName = projectDirectory.split(/[\\/]/).at(-1)!;
    const systemDirectory = join(projectDirectory, "outputs", "system");
    expect(readdirSync(systemDirectory)).toEqual(["project.json"]);
    await window.getByRole("button", { name: `New thread in ${projectName}` }).click();
    expect(readdirSync(systemDirectory)).toEqual(["project.json"]);

    await window.getByRole("tab", { name: "Context" }).click();
    const editor = window.getByLabel("Project Context");
    await expect(editor).toHaveValue(/# Project Context/);
    await expect(editor).toHaveValue(/## Context For New Threads/);
    const contextPath = join(systemDirectory, "project-context.md");
    const mirrorPath = join(systemDirectory, "project-context.json");
    expect(existsSync(contextPath)).toBe(true);
    expect(existsSync(mirrorPath)).toBe(true);

    await editor.fill((await editor.inputValue()).replace("- Company:", "- Company: Acme Ventures"));
    await window.getByRole("button", { name: "Save Context" }).click();
    await expect.poll(() => readFileSync(contextPath, "utf8")).toContain("Acme Ventures");
    const savedMirror = JSON.parse(readFileSync(mirrorPath, "utf8"));
    expect(savedMirror).not.toHaveProperty("content");
    expect(savedMirror.sections).toHaveLength(6);

    const malformed = "# Project Context\n\n## Project Snapshot\n- Company: External Edit\n\n## Unknown Notes\nPreserve me\n";
    writeFileSync(contextPath, malformed, "utf8");
    await expect(window.getByRole("status")).toContainText("Unknown section 'Unknown Notes'", { timeout: 10_000 });
    await expect(editor).toHaveValue(malformed);
    expect(readFileSync(contextPath, "utf8")).toBe(malformed);
    expect(JSON.parse(readFileSync(mirrorPath, "utf8")).warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNKNOWN_SECTION" })]));
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

test("captures a Project Memory candidate and appends it only after explicit confirmation", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-d7-e2e-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-d7-project-"));
  const root = resolve(import.meta.dirname, "../..");
  const application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: projectDirectory });
  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "Open project" }).click();
    const projectName = projectDirectory.split(/[\\/]/).at(-1)!;
    await window.getByRole("button", { name: `New thread in ${projectName}` }).click();
    const memoryPath = join(projectDirectory, "outputs", "system", "project-memory.md");
    expect(existsSync(memoryPath)).toBe(false);

    await window.getByLabel("Message").fill("我认为生产稳定性是这个项目的核心风险");
    await window.getByRole("button", { name: "Send" }).click();
    const candidate = window.locator(".memory-candidate");
    await expect(candidate).toContainText("Memory candidate captured");
    expect(existsSync(memoryPath)).toBe(false);
    await candidate.getByRole("button", { name: "Review" }).click();
    const dialog = window.getByRole("dialog", { name: "Project Memory draft" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Memory title").fill("Production stability is the core risk");
    await dialog.getByLabel("Memory tags").fill("risk, diligence");
    await dialog.getByLabel("Memory judgment").fill("用户确认：生产稳定性是这个项目的核心风险。");
    await dialog.getByRole("button", { name: "Confirm append" }).click();
    await expect(dialog).toBeHidden();
    await expect(candidate).toBeHidden();
    await expect.poll(() => readFileSync(memoryPath, "utf8")).toContain("Source: user-confirmed");
    expect(readFileSync(memoryPath, "utf8")).toContain("Production stability is the core risk");
    const marker = JSON.parse(readFileSync(join(projectDirectory, "outputs", "system", "project.json"), "utf8")) as { projectId: string };
    const index = JSON.parse(readFileSync(join(userDataDirectory, "memory", "project-index", `${marker.projectId}.json`), "utf8"));
    expect(index.entries).toMatchObject([{ maturity: "user_confirmed", provenanceStatus: "traceable" }]);

    const malformed = "# Project Memory\n\n## malformed heading\nPreserve this manual judgment\n";
    writeFileSync(memoryPath, malformed, "utf8");
    await expect(window.getByRole("status")).toContainText("Memory entry heading must use", { timeout: 10_000 });
    await expect(window.getByLabel("Project Memory")).toHaveValue(malformed);
    expect(readFileSync(memoryPath, "utf8")).toBe(malformed);
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

test("lists only registered Project Outputs with format-neutral provenance", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-d8-e2e-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-d8-project-"));
  const root = resolve(import.meta.dirname, "../..");
  const application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: projectDirectory });
  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "Open project" }).click();
    const projectName = projectDirectory.split(/[\\/]/).at(-1)!;
    const marker = JSON.parse(readFileSync(join(projectDirectory, "outputs", "system", "project.json"), "utf8")) as { projectId: string };
    const destination = join(projectDirectory, "outputs", "industry-note.md");
    writeFileSync(destination, "# Industry Note\n\nFact with source.\n\nInference under uncertainty.", "utf8");
    const artifactId = crypto.randomUUID();
    const registryPath = join(projectDirectory, "outputs", "system", "artifacts.jsonl");
    writeFileSync(registryPath, `${JSON.stringify({ schemaVersion: 1, id: crypto.randomUUID(), type: "canonical_parse", path: "outputs/parsed/source/parse.json" })}\n${JSON.stringify({ type: "user_output", schemaVersion: 1, id: artifactId, projectId: marker.projectId, mediaType: "text/markdown", destination, relativePath: "industry-note.md", producer: { type: "agent", id: "primary-agent" }, source: { threadId: "thread-source", turnId: "turn-source", capabilityRequestId: "request-source" }, profile: { id: "profile-source", provider: "anthropic", model: "claude-sonnet" }, capabilityId: "output.write_text", sourceReferences: ["material:source/block:block-1@hash", "https://example.com/source"], warnings: ["Inference is uncertain."], relatedArtifacts: [], createdAt: new Date().toISOString() })}\n`, "utf8");
    await window.getByRole("button", { name: `New thread in ${projectName}` }).click();
    await window.getByRole("tab", { name: "Outputs" }).click();
    const panel = window.locator(".outputs-panel");
    await expect(panel).toContainText("industry-note.md");
    await expect(panel).toContainText("text/markdown");
    await expect(panel).toContainText("anthropic / claude-sonnet");
    await expect(panel).toContainText("2 source reference(s) · 1 warning(s)");
    await expect(panel).not.toContainText("canonical_parse");
    await expect(panel.getByRole("button", { name: "Open industry-note.md" })).toBeVisible();
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

test("completes the daily VC workflow and resumes it after restart", async () => {
  test.setTimeout(90_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-g1-e2e-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-g1-project-"));
  const root = resolve(import.meta.dirname, "../..");
  writeFileSync(join(projectDirectory, "memo.md"), "# Company evidence\nThe company reports repeatable enterprise demand.\n", "utf8");
  let application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: projectDirectory, VC_AGENT_TEST_WEB_FIXTURE: "1" });
  try {
    let window = await application.firstWindow();
    await window.getByRole("button", { name: "Open project" }).click();
    const projectName = projectDirectory.split(/[\\/]/).at(-1)!;
    await window.getByRole("button", { name: `New thread in ${projectName}` }).click();

    const material = window.locator(".material-row").filter({ hasText: "memo.md" });
    await material.getByRole("button", { name: "Parse" }).click();
    await expect(material).toContainText("available", { timeout: 20_000 });

    await window.getByRole("tab", { name: "Context" }).click();
    const context = window.getByLabel("Project Context");
    await context.fill((await context.inputValue()).replace("- Current Focus:", "- Current Focus: Investment judgment and execution risk"));
    await window.getByRole("button", { name: "Save Context" }).click();

    await window.getByRole("tab", { name: "Memory" }).click();
    await window.getByLabel("Project Memory").fill("# Project Memory\n\n## 2026-07-17 - Execution stability is the core risk\nTags: risk, diligence\nSource: user-authored\nScope: project\n\nExecution stability is the core risk.\n\nRelated:\n- Thread:\n- Output:\n");
    await window.getByRole("button", { name: "Save Memory" }).click();
    await expect(window.getByText(/1 entries/)).toBeVisible();

    await window.getByRole("button", { name: "Settings" }).click();
    await createProfile(window, { name: "Dogfood fixture", provider: "vc-agent-faux", model: "vc-agent-faux-model", apiKey: "fixture-only" });
    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Dogfood fixture" });
    await window.getByLabel("Message").fill("Search the current public web, use project materials, Context and Memory, and create an investment memo file with sources and uncertainty.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(window.getByText("Completed the bounded project review and created dogfood-investment-note.md.", { exact: true })).toBeVisible({ timeout: 30_000 });
    for (const capability of ["material_recall", "project_state_recall", "memory_recall", "web_search", "output.write_text"]) {
      await expect(window.locator(".tool-activity").filter({ hasText: capability })).toContainText("completed");
    }
    await expect(window.locator(".usage-row")).toContainText("reserve");
    await expect(window.locator(".usage-row")).toContainText("recall");
    await expect(window.locator(".usage-row")).toContainText("ms");
    await window.getByRole("tab", { name: "Outputs" }).click();
    await expect(window.locator(".outputs-panel")).toContainText("dogfood-investment-note.md");
    expect(readFileSync(join(projectDirectory, "outputs", "dogfood-investment-note.md"), "utf8")).toContain("Inference and uncertainty");

    await application.close();
    application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_WEB_FIXTURE: "1" });
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Thread 1", exact: true }).click();
    await expect(window.getByText("Completed the bounded project review and created dogfood-investment-note.md.", { exact: true })).toBeVisible();
    await window.getByRole("tab", { name: "Outputs" }).click();
    await expect(window.locator(".outputs-panel")).toContainText("dogfood-investment-note.md");
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

test("recovers the complete Dogfood failure path without provider fallback", async () => {
  test.setTimeout(90_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-g1-failure-e2e-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-g1-failure-project-"));
  const root = resolve(import.meta.dirname, "../..");
  writeFileSync(join(projectDirectory, "broken.json"), "{not-json", "utf8");
  let application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: projectDirectory });
  try {
    let window = await application.firstWindow();
    await window.getByRole("button", { name: "Open project" }).click();
    const projectName = projectDirectory.split(/[\\/]/).at(-1)!;
    await window.getByRole("button", { name: `New thread in ${projectName}` }).click();
    const broken = window.locator(".material-row").filter({ hasText: "broken.json" });
    await broken.getByRole("button", { name: "Parse" }).click();
    await expect(broken.locator(".parse-result")).toContainText("PARSER_FAILED", { timeout: 20_000 });

    await window.getByLabel("Message").fill("Assess this project.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(window.getByText("Model Profile not configured")).toBeVisible();
    await window.getByRole("button", { name: "Adjust profile" }).click();
    await createProfile(window, { name: "Unavailable provider", provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "sk-invalid-g1-failure-fixture" });
    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Unavailable provider" });
    await window.locator(".provider-failure").first().getByRole("button", { name: "Retry" }).click();
    await expect(window.locator(".provider-failure")).toHaveCount(2, { timeout: 30_000 });
    await expect(window.locator(".provider-failure").last()).toContainText("anthropic / claude-sonnet-4-5");

    await window.getByLabel("Message").fill("Produce a deliberately slow answer.");
    await window.getByRole("button", { name: "Send" }).click();
    await window.getByRole("button", { name: "Stop" }).click();
    await expect(window.getByText("Interrupted", { exact: true })).toBeVisible({ timeout: 20_000 });
    await application.close();

    application = await launchApplication(root, userDataDirectory);
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Thread 1", exact: true }).click();
    await expect(window.getByText("Model Profile not configured")).toBeVisible();
    await expect(window.locator(".provider-failure").filter({ hasText: "anthropic / claude-sonnet-4-5" })).toBeVisible();
    await expect(window.getByText("Interrupted", { exact: true })).toBeVisible();
    await expect(window.getByLabel("Active Model Profile")).toHaveValue(/.+/);
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

test("runs an explicit isolated Project Reflection and restores its assessment without Pi", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-reflection-e2e-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-reflection-project-"));
  const root = resolve(import.meta.dirname, "../..");
  writeFileSync(join(projectDirectory, "market-notes.md"), "# Market notes\n\nCustomer demand is promising, but retention remains unverified.");
  let application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: projectDirectory });

  try {
    let window = await application.firstWindow();
    await window.getByRole("button", { name: "Open project" }).click();
    writeFileSync(join(projectDirectory, "outputs", "system", "project-memory.md"), projectReflectionMemoryFixture(), "utf8");
    const projectName = projectDirectory.split(/[\\/]/).at(-1)!;
    await window.getByRole("button", { name: `New thread in ${projectName}` }).click();
    await window.getByRole("button", { name: "Reflection", exact: true }).click();
    const launch = window.getByRole("dialog", { name: "Start Investment Reflection" });
    await launch.getByRole("button", { name: "Start Reflection" }).click();
    await expect(window.getByTestId("reflection-workspace")).toContainText("Awaiting profile");
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { entityCounts: { threads: 2, taskAssignments: 0 }, runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });

    await application.close();
    application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: projectDirectory });
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Investment Reflection", exact: true }).click();
    await expect(window.getByTestId("reflection-workspace")).toContainText("Awaiting profile");
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });

    await window.getByRole("button", { name: "Settings" }).click();
    await window.locator(".settings-tabs").getByRole("tab", { name: "Memory" }).click();
    await window.getByLabel("Long-term Memory").fill(reflectionLongTermMemoryFixture());
    await window.getByRole("button", { name: "Save Memory" }).click();
    await window.locator(".settings-tabs").getByRole("tab", { name: "General" }).click();
    await createProfile(window, { name: "Rejected Reflection fixture", provider: "vc-agent-reflection-provider-failure-faux", model: "failure-model", apiKey: "sk-reflection-secret-key" });
    await createProfile(window, { name: "Reflection fixture", provider: "vc-agent-reflection-faux", model: "vc-agent-reflection-faux-model", apiKey: "fixture-key" });
    await createProfile(window, { name: "Critical Reflection fixture", provider: "vc-agent-reflection-memory-faux", model: "vc-agent-reflection-memory-faux-model", apiKey: "fixture-key" });
    await window.getByRole("button", { name: "Settings" }).click();
    const workspace = window.getByTestId("reflection-workspace");
    await workspace.getByLabel("Independent Evidence Profile").selectOption({ label: "Rejected Reflection fixture" });
    await workspace.getByRole("button", { name: "Start evidence pass" }).click();
    await expect(workspace).toContainText("Evidence pass failed", { timeout: 20_000 });
    await expect(workspace).toContainText("FIXTURE_PROVIDER_REJECTED");
    await expect(workspace).toContainText("[REDACTED]");
    await expect(workspace).not.toContainText("sk-reflection-secret-key");
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 1, piSessionsStarted: 0, providerRequests: 0 } } });
    await workspace.getByLabel("Independent Evidence Profile").selectOption({ label: "Reflection fixture" });
    await workspace.getByRole("button", { name: "Retry evidence pass" }).click();
    await expect(workspace).toContainText("Evidence pass complete", { timeout: 30_000 });
    await expect(workspace.getByRole("heading", { name: "Independent Assessment" })).toBeVisible();
    await expect(workspace).toContainText("continued diligence");
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 1, piSessionsStarted: 1, providerRequests: 1 } } });

    const database = new DatabaseSync(join(userDataDirectory, "state.db"), { readOnly: true });
    const run = database.prepare("SELECT status, assessment_json, thread_id FROM reflection_runs").get() as { status: string; assessment_json: string; thread_id: string };
    const physical = Number((database.prepare("SELECT COUNT(*) AS count FROM physical_contexts WHERE thread_id = ?").get(run.thread_id) as { count: number }).count);
    database.close();
    expect(run.status).toBe("independent_completed");
    expect(JSON.parse(run.assessment_json)).toMatchObject({ conclusion: expect.stringContaining("continued diligence") });
    expect(physical).toBe(0);

    await workspace.getByLabel("Memory-Aware Reflection Profile").selectOption({ label: "Critical Reflection fixture" });
    await workspace.getByRole("button", { name: "Start critical dialogue" }).click();
    await expect(workspace).toContainText("Reflection dialogue", { timeout: 30_000 });
    await expect(window.getByText("Which retention result would change your current view?", { exact: false })).toBeVisible();
    await expect(window.locator(".tool-activity").filter({ hasText: "memory_recall" })).toHaveCount(3);
    await expect(window.locator(".tool-activity.completed").filter({ hasText: "reflection_evidence_drilldown" })).toBeVisible();
    await expect(window.getByText("handoff claim is unsupported", { exact: false })).toBeVisible();
    await expect(window.locator(".tool-activity").filter({ hasText: "material_recall" })).toHaveCount(0);
    await expect(window.locator(".conversation")).not.toContainText("src_ref_reflection");
    await expect(window.locator(".conversation")).not.toContainText("projectId");

    const judgmentRoot = join(projectDirectory, "outputs", "system", "judgment-records");
    expect(existsSync(judgmentRoot)).toBe(false);
    await window.getByLabel("Message").fill("I adopt month-six retention above 80% in a representative cohort. Prepare a Judgment Record and reusable learning proposal.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(window.getByText("I prepared a non-authoritative Judgment Record draft", { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(window.locator(".tool-activity.completed").filter({ hasText: "reflection_outcome_propose" })).toBeVisible();
    await expect(workspace.getByTestId("judgment-record-draft")).toContainText("Draft · not authoritative");
    await expect(workspace.getByTestId("learning-proposal-draft")).toContainText("Draft · not in Memory");
    const reflectionTrajectoryPath = join(userDataDirectory, "threads", run.thread_id, "trajectory.jsonl");
    const reflectionTrajectory = readFileSync(reflectionTrajectoryPath, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    const submittedReflectionTurns = reflectionTrajectory.filter((event) => event.event === "turn.submitted");
    expect(submittedReflectionTurns.find((event) => event.payload.text === "Begin Memory-Aware Investment Reflection.")?.payload).not.toHaveProperty("dreamEligibility");
    const adoptedTurn = submittedReflectionTurns.find((event) => event.payload.text.startsWith("I adopt month-six retention"));
    expect(adoptedTurn?.payload.dreamEligibility).toEqual({ sourceKind: "reflection_dialogue", signal: "adoption" });
    await expect.poll(() => readFileSync(reflectionTrajectoryPath, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)).some((event) => event.event === "turn.completed" && event.turnId === adoptedTurn?.turnId)).toBe(true);
    expect(readFileSync(reflectionTrajectoryPath, "utf8")).not.toContain("The current evidence supports continued diligence");
    const reflectionCandidates = readFileSync(join(userDataDirectory, "memory", "candidates.jsonl"), "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line).candidate).filter((candidate) => candidate.threadId === run.thread_id);
    expect(reflectionCandidates).toMatchObject([{ turnId: adoptedTurn.turnId, sourceKind: "reflection_dialogue", signal: "reflection_adoption", status: "active" }]);
    expect(existsSync(judgmentRoot)).toBe(false);
    expect(readFileSync(join(userDataDirectory, "memory", "long-term", "long-term-memory.md"), "utf8")).not.toContain("ltm-representative-retention-threshold");
    await workspace.getByRole("button", { name: "Confirm Judgment Record" }).click();
    await expect(workspace.getByTestId("judgment-record-draft")).toContainText("confirmed");
    expect(existsSync(judgmentRoot)).toBe(true);
    expect(readdirSync(judgmentRoot).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    await workspace.getByRole("button", { name: "Preview Memory Patch" }).click();
    const memoryPatch = window.getByRole("dialog", { name: "Reflection Memory patch preview" });
    await expect(memoryPatch).toContainText("Confirm Long-term Memory change");
    expect(readFileSync(join(userDataDirectory, "memory", "long-term", "long-term-memory.md"), "utf8")).not.toContain("ltm-representative-retention-threshold");
    await memoryPatch.getByRole("button", { name: "Confirm Memory change" }).click();
    await expect(memoryPatch).not.toBeVisible();
    expect(readFileSync(join(userDataDirectory, "memory", "long-term", "long-term-memory.md"), "utf8")).toContain("ltm-representative-retention-threshold");
    const activeDatabase = new DatabaseSync(join(userDataDirectory, "state.db"), { readOnly: true });
    expect(activeDatabase.prepare("SELECT status FROM reflection_runs").get()).toMatchObject({ status: "dialogue_active" });
    expect(Number((activeDatabase.prepare("SELECT COUNT(*) AS count FROM physical_contexts WHERE thread_id = ?").get(run.thread_id) as { count: number }).count)).toBe(1);
    activeDatabase.close();

    await application.close();
    application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: projectDirectory });
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Investment Reflection", exact: true }).click();
    await expect(window.getByTestId("reflection-workspace")).toContainText("Reflection dialogue");
    await expect(window.getByTestId("reflection-workspace")).toContainText("continued diligence");
    await expect(window.getByText("I prepared a non-authoritative Judgment Record draft", { exact: false })).toBeVisible();
    await expect(window.getByTestId("judgment-record-draft")).toContainText("confirmed");
    await expect(window.getByTestId("learning-proposal-draft")).toContainText("adopted");
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });

    await window.getByRole("button", { name: "Settings" }).click();
    await createProfile(window, { name: "Learning Gate recall", provider: "vc-agent-learning-recall-faux", model: "learning-recall", apiKey: "fixture-key" });
    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByRole("button", { name: "New thread", exact: true }).click();
    await window.getByLabel("Active Model Profile").selectOption({ label: "Learning Gate recall" });
    await window.getByLabel("Message").fill("Recall the reviewed representative retention threshold for a new investment decision.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(window.getByText("Recalled the reviewed representative-retention decision rule", { exact: false })).toBeVisible({ timeout: 30_000 });
    const recallDatabase = new DatabaseSync(join(userDataDirectory, "state.db"), { readOnly: true });
    const recallThread = recallDatabase.prepare("SELECT id FROM threads WHERE scope = 'unscoped' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string };
    recallDatabase.close();
    const recallTrajectory = readFileSync(join(userDataDirectory, "threads", recallThread.id, "trajectory.jsonl"), "utf8");
    expect(recallTrajectory).not.toContain(projectDirectory);
    expect(recallTrajectory).not.toContain(projectName);
    await expect(window.locator(".conversation")).not.toContainText(projectDirectory);
    await expect(window.locator(".conversation")).not.toContainText(projectName);
    await expect(window.locator(".usage-row")).toContainText("prompt");
    await expect(window.locator(".usage-row")).toContainText("recall");
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

test("runs an isolated Unscoped Reflection without Project State and writes only to the selected Output Location", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-unscoped-reflection-e2e-"));
  const outputDirectory = mkdtempSync(join(tmpdir(), "vc-agent-unscoped-reflection-output-"));
  const root = resolve(import.meta.dirname, "../..");
  let application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_OUTPUT_LOCATION: outputDirectory, VC_AGENT_TEST_WEB_FIXTURE: "1" });

  try {
    let window = await application.firstWindow();
    await window.getByRole("button", { name: "New thread" }).click();
    await window.getByLabel("Message").fill("Use representative month-six retention above 80% as a decision-changing threshold, but verify cohort construction.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(window.getByText("Model Profile not configured")).toBeVisible();
    await window.getByLabel("Message").fill("Create a memo file for this investment view.");
    await window.getByRole("button", { name: "Send" }).click();
    const outputFailure = window.locator(".provider-failure").filter({ hasText: "OUTPUT_LOCATION_NOT_CONFIGURED" });
    await expect(outputFailure).toBeVisible();
    await outputFailure.getByRole("button", { name: "Choose output location" }).click();
    await expect(window.getByTitle(outputDirectory)).toBeVisible();

    await window.getByRole("button", { name: "Settings" }).click();
    await window.locator(".settings-tabs").getByRole("tab", { name: "Memory" }).click();
    await window.getByLabel("Long-term Memory").fill(reflectionLongTermMemoryFixture());
    await window.getByRole("button", { name: "Save Memory" }).click();
    await window.locator(".settings-tabs").getByRole("tab", { name: "General" }).click();
    await createProfile(window, { name: "Unscoped evidence fixture", provider: "vc-agent-unscoped-evidence-faux", model: "unscoped-evidence", apiKey: "fixture-key" });
    await createProfile(window, { name: "Unscoped dialogue fixture", provider: "vc-agent-unscoped-memory-faux", model: "unscoped-dialogue", apiKey: "fixture-key" });
    await window.getByRole("button", { name: "Settings" }).click();

    await window.getByRole("button", { name: "Reflection", exact: true }).click();
    const launch = window.getByRole("dialog", { name: "Start Investment Reflection" });
    await expect(launch).toContainText("cannot access Project State or Memory");
    await launch.getByLabel("Reflection Model Profile").selectOption({ label: "Unscoped evidence fixture" });
    await launch.getByRole("button", { name: "Start Reflection" }).click();
    const workspace = window.getByTestId("reflection-workspace");
    await expect(workspace).toContainText("Evidence pass complete", { timeout: 30_000 });
    await expect(workspace).toContainText("current Unscoped evidence does not establish a representative cohort");
    await expect(workspace).toContainText("2 inputs");

    const database = new DatabaseSync(join(userDataDirectory, "state.db"), { readOnly: true });
    const run = database.prepare("SELECT scope, project_id, source_thread_id, thread_id FROM reflection_runs").get() as { scope: string; project_id: string | null; source_thread_id: string; thread_id: string };
    expect(run).toMatchObject({ scope: "unscoped", project_id: null });
    expect(run.source_thread_id).not.toBe(run.thread_id);
    expect(Number((database.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count)).toBe(0);
    database.close();

    await workspace.getByLabel("Memory-Aware Reflection Profile").selectOption({ label: "Unscoped dialogue fixture" });
    await workspace.getByRole("button", { name: "Start critical dialogue" }).click();
    await expect(workspace).toContainText("Reflection dialogue", { timeout: 30_000 });
    await expect(window.getByText("Project evidence", { exact: false })).toBeVisible();
    await expect(window.locator(".tool-activity").filter({ hasText: "memory_recall" })).toHaveCount(2);
    await expect(window.locator(".tool-activity").filter({ hasText: /project_state_recall|material_recall/u })).toHaveCount(0);

    await workspace.getByRole("button", { name: "Prepare outcomes" }).click();
    await expect(window.getByText("I prepared Unscoped Reflection outcome drafts", { exact: false })).toBeVisible({ timeout: 30_000 });
    await workspace.getByRole("button", { name: "Confirm Judgment Record" }).click();
    await expect(workspace.getByTestId("judgment-record-draft")).toContainText("confirmed");
    const judgmentFiles = readdirSync(join(outputDirectory, "judgment-records"));
    const judgmentJson = JSON.parse(readFileSync(join(outputDirectory, "judgment-records", judgmentFiles.find((name) => name.endsWith(".json"))!), "utf8"));
    expect(judgmentJson).toMatchObject({ scope: "unscoped", threadId: run.thread_id });
    expect(judgmentJson).not.toHaveProperty("projectId");

    await workspace.getByRole("button", { name: "Preview Memory Patch" }).click();
    const patchPreview = window.getByRole("dialog", { name: "Reflection Memory patch preview" });
    await patchPreview.getByRole("button", { name: "Confirm Memory change" }).click();
    await expect(workspace.getByTestId("learning-proposal-draft")).toContainText("adopted");
    const provenance = readFileSync(join(userDataDirectory, "memory", "local-memory-provenance.jsonl"), "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    expect(provenance.at(-1)).toMatchObject({ scope: "unscoped", workflowType: "reflection", threadId: run.thread_id });
    expect(provenance.at(-1)).not.toHaveProperty("projectId");

    await application.close();
    application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_OUTPUT_LOCATION: outputDirectory, VC_AGENT_TEST_WEB_FIXTURE: "1" });
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Investment Reflection", exact: true }).click();
    await expect(window.getByTestId("reflection-workspace")).toContainText("adopted");
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("marks only unconfirmed Reflection outcomes stale after a recalled Memory target changes", async () => {
  test.setTimeout(90_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-reflection-stale-e2e-"));
  const projectDirectory = mkdtempSync(join(tmpdir(), "vc-agent-reflection-stale-project-"));
  const root = resolve(import.meta.dirname, "../..");
  writeFileSync(join(projectDirectory, "market-notes.md"), "# Market notes\n\nRetention remains unverified.");
  let application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: projectDirectory });

  try {
    let window = await application.firstWindow();
    await window.getByRole("button", { name: "Open project" }).click();
    writeFileSync(join(projectDirectory, "outputs", "system", "project-memory.md"), projectReflectionMemoryFixture(), "utf8");
    const projectName = projectDirectory.split(/[\\/]/u).at(-1)!;
    await window.getByRole("button", { name: `New thread in ${projectName}` }).click();
    await window.getByRole("button", { name: "Settings" }).click();
    await window.locator(".settings-tabs").getByRole("tab", { name: "Memory" }).click();
    await window.getByLabel("Long-term Memory").fill(reflectionLongTermMemoryFixture());
    await window.getByRole("button", { name: "Save Memory" }).click();
    await window.locator(".settings-tabs").getByRole("tab", { name: "General" }).click();
    await createProfile(window, { name: "Stale evidence fixture", provider: "vc-agent-reflection-faux", model: "stale-evidence", apiKey: "fixture-key" });
    await createProfile(window, { name: "Stale dialogue fixture", provider: "vc-agent-reflection-memory-faux", model: "stale-dialogue", apiKey: "fixture-key" });
    await window.getByRole("button", { name: "Settings" }).click();

    await window.getByRole("button", { name: "Reflection", exact: true }).click();
    const launch = window.getByRole("dialog", { name: "Start Investment Reflection" });
    await launch.getByLabel("Reflection Model Profile").selectOption({ label: "Stale evidence fixture" });
    await launch.getByRole("button", { name: "Start Reflection" }).click();
    const workspace = window.getByTestId("reflection-workspace");
    await expect(workspace).toContainText("Evidence pass complete", { timeout: 30_000 });
    await workspace.getByLabel("Memory-Aware Reflection Profile").selectOption({ label: "Stale dialogue fixture" });
    await workspace.getByRole("button", { name: "Start critical dialogue" }).click();
    await expect(workspace).toContainText("Reflection dialogue", { timeout: 30_000 });
    await window.getByLabel("Message").fill("Prepare a Judgment Record and reusable Long-term Learning Proposal from this Reflection.");
    await window.getByRole("button", { name: "Send" }).click();
    await expect(workspace.getByTestId("judgment-record-draft")).toContainText("Draft · not authoritative", { timeout: 30_000 });

    const outcomePath = join(userDataDirectory, "memory", "reflection", "outcomes.jsonl");
    const proposedEvents = readFileSync(outcomePath, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    const proposed = proposedEvents.find((event) => event.event === "judgment.proposed");
    expect(proposed.draft.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "long_term_memory", targetId: "ltm-reflection-pattern" })]));

    await window.getByRole("button", { name: "Settings" }).click();
    await window.locator(".settings-tabs").getByRole("tab", { name: "Memory" }).click();
    const changedMemory = reflectionLongTermMemoryFixture().replace("Version: 1", "Version: 2").replace("Use representative cohort retention", "Require verified representative cohort retention");
    await window.getByLabel("Long-term Memory").fill(changedMemory);
    await window.getByRole("button", { name: "Save Memory" }).click();
    await application.close();

    application = await launchApplication(root, userDataDirectory, { VC_AGENT_TEST_PROJECT_PATH: projectDirectory });
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Investment Reflection", exact: true }).click();
    const restored = window.getByTestId("reflection-workspace");
    await expect(restored.getByText("Stale · review again")).toHaveCount(2);
    await expect(restored.getByText("Relevant long term memory changed", { exact: false })).toHaveCount(2);
    await expect(restored.getByRole("button", { name: "Confirm Judgment Record" })).toHaveCount(0);
    await expect(restored.getByRole("button", { name: "Preview Memory Patch" })).toHaveCount(0);
    expect(existsSync(join(projectDirectory, "outputs", "system", "judgment-records"))).toBe(false);
    const staleEvents = readFileSync(outcomePath, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line)).filter((event) => event.event === "outcome.stale");
    expect(staleEvents).toHaveLength(2);
    expect(staleEvents.every((event) => event.reasons.some((reason: { dependency: { kind: string }; reason: string }) => reason.dependency.kind === "long_term_memory" && reason.reason === "changed"))).toBe(true);
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

test("creates and restores a frozen Dream batch without hidden model work", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-dream-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  let application = await launchApplication(root, userDataDirectory);

  try {
    let window = await application.firstWindow();
    const profileEvent = await invokeRaw(window, "profile.create", { name: "Dream fixture", provider: "fixture", model: "dream-model", apiKey: "fixture-key", thinkingLevel: "medium" }) as { payload: { profile: { id: string; name: string; provider: string; model: string; thinkingLevel: string } } };
    const profile = profileEvent.payload.profile;
    await invokeRaw(window, "task_model_assignment.set", { taskType: "dream", profileId: profile.id });
    const threadEvent = await invokeRaw(window, "thread.create.unscoped", { title: "Dream source" }) as { payload: { thread: { id: string } } };
    const threadId = threadEvent.payload.thread.id;
    await invokeRaw(window, "thread.archive.set", { threadId, archived: true });
    await application.close();

    const threadDirectory = join(userDataDirectory, "threads", threadId);
    mkdirSync(threadDirectory, { recursive: true });
    const firstCompletedAt = "2026-07-18T08:00:02.000Z";
    writeFileSync(join(threadDirectory, "trajectory.jsonl"), dreamTrajectoryFixture(threadId, "turn-1", "My diligence view", "Challenge the view", firstCompletedAt, profile), "utf8");

    application = await launchApplication(root, userDataDirectory);
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Settings" }).click();
    await window.locator(".settings-tabs").getByRole("tab", { name: "Memory" }).click();
    const dream = window.locator(".dream-settings");
    await expect(dream).toContainText("Eligible exchanges");
    await expect(dream).toContainText("1");
    await window.getByRole("button", { name: "New batch" }).click();
    const launch = window.getByRole("dialog", { name: "Start Dream" });
    await expect(launch.getByLabel("Dream Model Profile")).toHaveValue(profile.id);
    await launch.getByRole("button", { name: "Create Dream Batch" }).click();
    await expect(window.getByText("Frozen batch", { exact: true })).toBeVisible();
    await expect(window.getByText("1 exchanges", { exact: false })).toBeVisible();
    await expect(window.getByText("Unscoped Thread", { exact: true })).toBeVisible();
    await expect(window.getByRole("button", { name: "Extract", exact: true })).toBeVisible();

    const statePath = join(userDataDirectory, "memory", "dream", "review-state.json");
    const created = JSON.parse(readFileSync(statePath, "utf8"));
    expect(created.batches).toHaveLength(1);
    expect(created.batches[0]).toMatchObject({ status: "ready", cutoff: firstCompletedAt, promptSnapshot: { hash: expect.stringMatching(/^[a-f0-9]{64}$/) }, profileSnapshot: { id: profile.id }, trajectoryInputs: [{ turnId: "turn-1" }], extractionScopes: [{ id: `unscoped:${threadId}`, status: "pending", threadId }] });
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });
    await application.close();

    const laterCompletedAt = "2026-07-19T08:00:02.000Z";
    writeFileSync(join(threadDirectory, "trajectory.jsonl"), `${readFileSync(join(threadDirectory, "trajectory.jsonl"), "utf8")}${dreamTrajectoryFixture(threadId, "turn-2", "A later view", "A later response", laterCompletedAt, profile, 3)}`, "utf8");
    application = await launchApplication(root, userDataDirectory);
    window = await application.firstWindow();
    await expect(window.getByText("Dream run can resume", { exact: true })).toBeVisible();
    const restored = JSON.parse(readFileSync(statePath, "utf8"));
    expect(restored.batches[0].cutoff).toBe(firstCompletedAt);
    expect(restored.batches[0].trajectoryInputs).toHaveLength(1);
    expect(restored.schedule.latestEligibleCompletedAt).toBe(laterCompletedAt);
    expect(await invokeBootstrap(window)).toMatchObject({ payload: { runtimeActivity: { agentWorkersStarted: 0, piSessionsStarted: 0, providerRequests: 0 } } });

    await window.getByRole("button", { name: "Dream source", exact: true }).click();
    await window.getByRole("button", { name: "Delete thread history" }).click();
    const deletion = window.getByRole("dialog", { name: "Delete thread history" });
    await deletion.getByRole("button", { name: "Delete history" }).click();
    await expect(window.getByText("Ready for a new conversation", { exact: true })).toBeVisible();
    expect(existsSync(join(threadDirectory, "trajectory.jsonl"))).toBe(false);
    expect(readFileSync(statePath, "utf8")).not.toContain("My diligence view");
    expect(JSON.parse(readFileSync(statePath, "utf8")).batches[0].extractionScopes[0]).toMatchObject({ status: "stale", sourceReferences: [] });
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});

test("reviews Global Dream proposals separately from the final atomic Memory commit", async () => {
  test.setTimeout(60_000);
  const userDataDirectory = mkdtempSync(join(tmpdir(), "vc-agent-dream-synthesis-e2e-"));
  const root = resolve(import.meta.dirname, "../..");
  let application = await launchApplication(root, userDataDirectory);
  try {
    let window = await application.firstWindow();
    const profileEvent = await invokeRaw(window, "profile.create", { name: "Dream synthesis fixture", provider: "vc-agent-dream-synthesis-faux", model: "dream-model", apiKey: "fixture-key", thinkingLevel: "medium" }) as { payload: { profile: { id: string; name: string; provider: string; model: string; thinkingLevel: string } } };
    const profile = profileEvent.payload.profile;
    await invokeRaw(window, "task_model_assignment.set", { taskType: "dream", profileId: profile.id });
    const threadEvent = await invokeRaw(window, "thread.create.unscoped", { title: "Dream synthesis source" }) as { payload: { thread: { id: string } } };
    const threadId = threadEvent.payload.thread.id;
    await invokeRaw(window, "thread.archive.set", { threadId, archived: true });
    await application.close();
    const threadDirectory = join(userDataDirectory, "threads", threadId);
    mkdirSync(threadDirectory, { recursive: true });
    writeFileSync(join(threadDirectory, "trajectory.jsonl"), dreamTrajectoryFixture(threadId, "turn-1", "I prefer staged diligence", "Challenge the view", "2026-07-18T08:00:02.000Z", profile), "utf8");

    application = await launchApplication(root, userDataDirectory);
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Settings" }).click();
    await window.locator(".settings-tabs").getByRole("tab", { name: "Memory" }).click();
    await window.getByRole("button", { name: "New batch" }).click();
    await window.getByRole("dialog", { name: "Start Dream" }).getByRole("button", { name: "Create Dream Batch" }).click();
    await application.close();

    const statePath = join(userDataDirectory, "memory", "dream", "review-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const batch = state.batches[0];
    const scope = batch.extractionScopes[0];
    const sourceReference = batch.trajectoryInputs[0].sourceReference;
    scope.status = "approved";
    scope.result = { schemaVersion: 1, scopeKind: "unscoped", deidentified: true, summary: "Staged diligence can expose decision-changing uncertainty early.", uncertainty: "Medium", sourceReferences: [sourceReference], candidates: [{ candidateId: "recovered-staged-diligence", origin: "recovered", sourceKind: "ordinary_user_signal", attributableSignal: "strong_user_judgment", sourceReferences: [sourceReference], uncertainty: "Medium", summary: "Use staged diligence around explicit uncertainty.", proposedDestination: "long_term_memory" }] };
    scope.completedAt = "2026-07-19T00:00:00.000Z";
    scope.reviewedAt = "2026-07-19T00:00:00.000Z";
    const projectA = "33333333-3333-4333-8333-333333333333";
    const projectB = "44444444-4444-4444-8444-444444444444";
    const projectSource = "thread:project-a/turn:turn-project-a";
    const skippedSource = "thread:project-b/turn:turn-project-b";
    batch.trajectoryInputs.push(
      { sourceKind: "ordinary_dialogue", scope: "project", projectId: projectA, threadId: "project-a", turnId: "turn-project-a", completedAt: "2026-07-18T08:00:02.000Z", sourceReference: projectSource, userText: "A de-identified Project judgment", assistantText: "Challenge A" },
      { sourceKind: "ordinary_dialogue", scope: "project", projectId: projectB, threadId: "project-b", turnId: "turn-project-b", completedAt: "2026-07-18T08:00:02.000Z", sourceReference: skippedSource, userText: "A failed Project judgment", assistantText: "Challenge B" }
    );
    batch.extractionScopes.unshift(
      { ...scope, id: `project:${projectA}`, kind: "project", projectId: projectA, threadId: undefined, sourceReferences: [projectSource], status: "approved", result: { ...scope.result, scopeKind: "project", sourceReferences: [projectSource], candidates: [{ ...scope.result.candidates[0], candidateId: "recovered-project-a", sourceReferences: [projectSource], proposedDestination: "long_term_memory" }] } },
      { ...scope, id: `project:${projectB}`, kind: "project", projectId: projectB, threadId: undefined, sourceReferences: [skippedSource], status: "skipped", result: undefined, failure: { kind: "provider", code: "FIXTURE_SCOPE_FAILED", message: "Sanitized scope failure" } }
    );
    batch.partialCoverageScopeIds = [`project:${projectB}`];
    batch.representedProjectIds = [projectA, projectB];
    batch.representedScopeCount = 3;
    state.carryover.push({ id: "55555555-5555-4555-8555-555555555555", sourceBatchId: batch.id, kind: "trajectory_scope", scope: "project", projectId: projectB, sourceReference: skippedSource, reason: "skipped", oldestUnresolvedAt: "2026-07-18T08:00:02.000Z", sourceStatus: "available", sourceText: "A failed Project judgment" });
    state.schedule.carryoverCount = 1;
    batch.status = "synthesis_pending";
    batch.currentStage = "global_synthesis";
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const memory = new LongTermMemoryStore(join(userDataDirectory, "memory", "long-term"));

    application = await launchApplication(root, userDataDirectory);
    window = await application.firstWindow();
    await window.getByRole("button", { name: "Settings" }).click();
    await window.locator(".settings-tabs").getByRole("tab", { name: "Memory" }).click();
    await window.getByRole("button", { name: "Run Global Synthesis" }).click();
    await expect(window.getByText("Global Dream Synthesis", { exact: true })).toBeVisible();
    await expect(window.locator(".dream-synthesis-review")).toContainText("Partial Dream Coverage");
    await expect(window.getByText("Stage diligence around uncertainty", { exact: true })).toBeVisible();
    await window.locator(".dream-proposal-card").getByRole("button", { name: "Approve", exact: true }).click();
    await window.getByRole("button", { name: "Prepare Markdown Patch Preview" }).click();
    await expect(window.getByText("Final Markdown Patch Preview", { exact: true })).toBeVisible();
    expect(readFileSync(memory.markdownPath, "utf8")).not.toContain("Stage diligence around uncertainty");
    await window.getByRole("button", { name: "Confirm Memory Commit" }).click();
    await expect(window.getByText("Latest completed Dream", { exact: true })).toBeVisible();
    expect(readFileSync(memory.markdownPath, "utf8")).toContain("Stage diligence around uncertainty");
    const completed = JSON.parse(readFileSync(statePath, "utf8"));
    expect(completed.batches[0]).toMatchObject({ status: "completed", partialCoverageScopeIds: [`project:${projectB}`], preparedPatch: { status: "committed", partialCoverageScopeReferences: [expect.any(String)] } });
    expect(completed.carryover).toMatchObject([{ projectId: projectB, reason: "skipped" }]);
  } finally {
    await application.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});

function dreamTrajectoryFixture(threadId: string, turnId: string, userText: string, assistantText: string, completedAt: string, profile: { id: string; name: string; provider: string; model: string; thinkingLevel: string }, firstSequence = 1): string {
  const common = { schemaVersion: 1, correlationId: `correlation-${turnId}`, threadId, turnId, actor: { actorType: "user", actorId: "e2e" }, provenance: { producerType: "user", producerId: "e2e" } };
  return [
    { ...common, eventId: `submitted-${turnId}`, sequence: firstSequence, occurredAt: new Date(new Date(completedAt).valueOf() - 1_000).toISOString(), event: "turn.submitted", payload: { text: userText, idempotencyKey: `key-${turnId}` } },
    { ...common, eventId: `completed-${turnId}`, sequence: firstSequence + 1, occurredAt: completedAt, actor: { actorType: "agent", actorId: "primary-agent" }, provenance: { producerType: "agent", producerId: "primary-agent" }, event: "turn.completed", payload: { message: assistantText, profile, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
}

function projectReflectionMemoryFixture(): string {
  return `# Project Memory\n\n## 2026-07-19 - Retention is the core execution risk\nTags: retention, execution, diligence\nSource: user-confirmed\nScope: project\n\nRetention quality matters more than top-line pilot count.\n\nRelated:\n- Thread:\n- Output:\n`;
}

function reflectionLongTermMemoryFixture(): string {
  return `# Long-term Memory\n\nSchema-Version: 1\n\n## 2026-07-19 - Early retention thresholds need representative cohorts\nID: ltm-reflection-pattern\nVersion: 1\nStatus: current\nTags: retention, execution risk\nScope: global\nApplies To: early-stage software, Series A diligence\nMaturity: user-confirmed\nRecall: automatic\nConflict: none\nLimitations: Immature or selected cohorts can mislead.\nSource References: src_ref_reflection\n\nUse representative cohort retention before treating early demand as repeatable.\n`;
}

async function launchApplication(root: string, userDataDirectory: string, extraEnvironment: Record<string, string> = {}) {
  return electron.launch({
    args: [join(root, "apps/desktop/dist/main/main.js"), `--user-data-dir=${userDataDirectory}`],
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", VC_AGENT_USER_DATA_DIR: userDataDirectory, ...extraEnvironment }
  });
}

async function initializeState(root: string, userDataDirectory: string): Promise<void> {
  const application = await launchApplication(root, userDataDirectory);
  await application.firstWindow();
  await application.close();
}

function sqliteBundle(databasePath: string): Record<string, string> {
  return Object.fromEntries(["", "-wal", "-shm"].flatMap((suffix) => {
    const path = `${databasePath}${suffix}`;
    return existsSync(path) ? [[suffix, readFileSync(path).toString("base64")]] : [];
  }));
}

async function invokeRaw(window: import("@playwright/test").Page, command: string, payload?: unknown) {
  return window.evaluate(async ({ command, payload }) => {
    return (window as unknown as { vcAgent: { invoke(command: unknown): Promise<unknown> } }).vcAgent.invoke({
      schemaVersion: 1,
      command,
      commandId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      actor: { actorType: "user", actorId: "e2e" },
      sentAt: new Date().toISOString(),
      ...(payload === undefined ? {} : { payload })
    });
  }, { command, payload });
}

function longTermMemoryFixture(): string {
  return `# Long-term Memory

Schema-Version: 1

## 2026-07-19 - Conservative TAM framing
ID: ltm-tam-framing
Version: 1
Status: current
Tags: memo, market sizing
Source: reflection-approved
Scope: global
Applies To: early-stage hard tech, IC memo
Maturity: evidence-backed
Recall: automatic
Conflict: none
Limitations: Less useful after repeatable sales establish a bottom-up market.
Source References: src_ref_alpha

早期硬科技项目应保守界定可服务市场，不把远期平台市场全部计入 TAM。
`;
}

function explicitOnlyMemoryFixture(): string {
  return `## 2026-07-19 - Founder reference caution
ID: ltm-founder-reference
Version: 1
Status: current
Tags: founder, diligence
Scope: global
Applies To: seed financing, founder diligence
Maturity: user-confirmed
Recall: explicit-only
Conflict: none
Limitations: Use only when references are available.
Source References:

Treat unusually polished references as a prompt for deeper triangulation, not as proof of operating quality.
`;
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
