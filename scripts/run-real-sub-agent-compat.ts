import { _electron as electron, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

interface HostResponse { readonly event: string; readonly payload?: unknown; }
interface Projection { readonly run: { readonly id: string; readonly status: string }; readonly tasks: Array<{ readonly id: string; readonly role: string; readonly status: string; readonly resolvedProfile: { readonly resolutionSource?: string }; readonly usage: { readonly totalTokens: number }; readonly failure?: { readonly code: string }; readonly handoff?: { readonly outputPath?: string; readonly adoptedByParent: boolean; readonly reviewStatus?: string } }>; readonly attempts: Array<{ readonly status: string; readonly profile: { readonly resolutionSource?: string }; readonly contextHash?: string; readonly usage: { readonly totalTokens: number }; readonly toolEvents: Array<{ readonly capability: string; readonly status: string }> }> }

async function main(): Promise<void> {
  if (process.env.VC_AGENT_REAL_SUB_AGENT !== "1") throw new Error("BLOCKED: set VC_AGENT_REAL_SUB_AGENT=1 to authorize a real Provider call.");
  const evidencePath = process.env.VC_AGENT_REAL_SUB_AGENT_EVIDENCE;
  if (!isExternalPath(evidencePath)) throw new Error("BLOCKED: VC_AGENT_REAL_SUB_AGENT_EVIDENCE must point outside the repository.");
  const root = resolve(process.cwd());
  const userData = process.env.VC_AGENT_REAL_SUB_AGENT_USER_DATA_DIR?.trim();
  const outputRoot = join(tmpdir(), `vc-agent-real-sub-agent-${Date.now()}`);
  mkdirSync(outputRoot, { recursive: true });
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", VC_AGENT_TEST_SUB_AGENT_FIXTURE: undefined, VC_AGENT_REAL_SUB_AGENT: "1", ...(userData === undefined ? {} : { VC_AGENT_USER_DATA_DIR: userData }) };
  const application = await electron.launch({ args: [join(root, "apps/desktop/dist/main/main.js")], cwd: root, env: environment });
  try {
    const window = await application.firstWindow();
    await window.getByTestId("empty-workspace").waitFor({ state: "visible" });
    const profilesResponse = await invoke(window, "profile.list");
    const profiles = (profilesResponse.payload as { profiles?: Array<{ id: string; name: string; provider: string; model: string }> } | undefined)?.profiles ?? [];
    const requestedProfileId = process.env.VC_AGENT_REAL_SUB_AGENT_PROFILE_ID?.trim();
    const profile = profiles.find((item) => item.id === requestedProfileId) ?? profiles[0];
    if (profile === undefined) throw new Error("MODEL_PROFILE_NOT_CONFIGURED");
    const threadResponse = await invoke(window, "thread.create.unscoped", { title: "Real Sub-Agent Compatibility" });
    const parentThreadId = (threadResponse.payload as { thread: { id: string } }).thread.id;
    const selected = await invoke(window, "thread.profile.select", { threadId: parentThreadId, profileId: profile.id });
    if (selected.event !== "thread.profile.selected") throw new Error(`THREAD_PROFILE_SELECTION_FAILED:${selected.event}`);
    const outputPath = join(outputRoot, "provider-output.md");
    const authorized = await invoke(window, "sub_agent.run.authorize", {
      parentThreadId,
      parentTurnId: crypto.randomUUID(),
      explicitIntentEvidence: { source: "user", text: "I explicitly authorize a bounded real Provider Sub-Agent compatibility run for this current task.", confirmed: true, taskLifetime: "current_task" },
      taskLimit: 2,
      sharedTokenBudget: 4_000,
      tasks: [
        { role: "researcher", objective: "Return one concise sentence confirming that this isolated Provider child session is reachable.", profileId: profile.id, contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 2_000 }, capabilitySet: ["read_context"] },
        { role: "writer", objective: "Use the authorized output.write_text capability to write exactly one concise sentence to provider-output.md confirming that this bounded Provider output path is reachable, then return a short confirmation.", profileId: profile.id, contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 2_000, outputRoot }, capabilitySet: ["read_context", "write_output"], outputTarget: outputPath }
      ]
    });
    if (authorized.event !== "sub_agent.run.authorized") throw new Error(`SUB_AGENT_AUTHORIZATION_FAILED:${authorized.event}`);
    const runId = (authorized.payload as { projection: { run: { id: string } } }).projection.run.id;
    const completed = await waitForProjection(window, runId, 120_000);
    if (completed.run.status !== "completed" || completed.tasks.some((task) => task.status !== "completed")) throw new Error("SUB_AGENT_PROVIDER_RUN_INCOMPLETE");
    const writer = completed.tasks.find((task) => task.role === "writer");
    if (writer?.handoff?.outputPath === undefined || !existsSync(outputPath)) throw new Error("SUB_AGENT_PROVIDER_OUTPUT_MISSING");
    const adopted = await invoke(window, "sub_agent.handoff.adopt", { taskId: writer.id });
    if (adopted.event !== "sub_agent.handoff.adopted") throw new Error(`SUB_AGENT_HANDOFF_ADOPTION_FAILED:${adopted.event}`);
    const inspected = await invoke(window, "sub_agent.run.inspect", { runId });
    const projection = (inspected.payload as { projection: Projection }).projection;
    const stopAuthorized = await invoke(window, "sub_agent.run.authorize", {
      parentThreadId,
      parentTurnId: crypto.randomUUID(),
      explicitIntentEvidence: { source: "user", text: "I explicitly authorize a bounded stop/cancel compatibility task for this current task.", confirmed: true, taskLifetime: "current_task" },
      taskLimit: 1,
      sharedTokenBudget: 4_000,
      tasks: [{ role: "researcher", objective: "Wait for the parent to stop this compatibility task before returning a result.", profileId: profile.id, contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 2_000 }, capabilitySet: ["read_context"] }]
    });
    if (stopAuthorized.event !== "sub_agent.run.authorized") throw new Error(`SUB_AGENT_STOP_AUTHORIZATION_FAILED:${stopAuthorized.event}`);
    const stopRunId = (stopAuthorized.payload as { projection: { run: { id: string } } }).projection.run.id;
    const stopRequested = await invoke(window, "sub_agent.run.stop", { runId: stopRunId, reason: "Compatibility stop/cancel verification." });
    if (stopRequested.event !== "sub_agent.run.stopped") throw new Error(`SUB_AGENT_STOP_REQUEST_FAILED:${stopRequested.event}`);
    const stopped = await waitForProjection(window, stopRunId, 120_000);
    const stopCancel = stopped.run.status === "stopped" && stopped.tasks.every((task) => task.status === "stopped");

    const budgetAuthorized = await invoke(window, "sub_agent.run.authorize", {
      parentThreadId,
      parentTurnId: crypto.randomUUID(),
      explicitIntentEvidence: { source: "user", text: "I explicitly authorize a bounded budget compatibility task for this current task.", confirmed: true, taskLifetime: "current_task" },
      taskLimit: 1,
      sharedTokenBudget: 1,
      tasks: [{ role: "researcher", objective: "This objective is deliberately larger than the one-token shared budget and must be rejected before a Provider request.", profileId: profile.id, contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 2_000 }, capabilitySet: ["read_context"] }]
    });
    if (budgetAuthorized.event !== "sub_agent.run.authorized") throw new Error(`SUB_AGENT_BUDGET_AUTHORIZATION_FAILED:${budgetAuthorized.event}`);
    const budgetRunId = (budgetAuthorized.payload as { projection: { run: { id: string } } }).projection.run.id;
    const budget = await waitForProjection(window, budgetRunId, 30_000);
    const budgetExhaustion = budget.run.status === "budget_exhausted" && budget.tasks.every((task) => task.status === "failed" && task.failure?.code === "SUB_AGENT_BUDGET_EXHAUSTED");

    const failureAuthorized = await invoke(window, "sub_agent.run.authorize", {
      parentThreadId,
      parentTurnId: crypto.randomUUID(),
      explicitIntentEvidence: { source: "user", text: "I explicitly authorize a bounded Provider failure compatibility task for this current task.", confirmed: true, taskLifetime: "current_task" },
      taskLimit: 1,
      sharedTokenBudget: 4_000,
      tasks: [{ role: "researcher", objective: "[[VC_AGENT_FORCE_PROVIDER_FAILURE]] Return no content; the compatibility runner is verifying explicit Provider failure handling.", profileId: profile.id, contextBoundary: { scope: "unscoped", sourceReferenceIds: [], maxChars: 2_000 }, capabilitySet: ["read_context"] }]
    });
    if (failureAuthorized.event !== "sub_agent.run.authorized") throw new Error(`SUB_AGENT_FAILURE_AUTHORIZATION_FAILED:${failureAuthorized.event}`);
    const failureRunId = (failureAuthorized.payload as { projection: { run: { id: string } } }).projection.run.id;
    const failed = await waitForProjection(window, failureRunId, 120_000);
    const providerFailure = failed.run.status === "failed" && failed.tasks.some((task) => task.status === "failed" && task.failure?.code.length > 0);
    if (!stopCancel || !budgetExhaustion || !providerFailure) throw new Error(`SUB_AGENT_REAL_WORKFLOW_INCOMPLETE:stop=${stopCancel};budget=${budgetExhaustion};failure=${providerFailure}`);
    const evidence = {
      schemaVersion: 1,
      sanitized: true,
      kind: "sub-agent-compatibility",
      provider: profile.provider,
      model: profile.model,
      adapter: "desktop-agent-worker-provider-v1",
      scope: "unscoped",
      taskCount: projection.tasks.length,
      attemptCount: projection.attempts.length,
      workflows: {
        parallelReadOnly: projection.tasks.some((task) => task.role === "researcher" && task.status === "completed"),
        writeOutput: writer.handoff !== undefined && existsSync(outputPath),
        parentAdoption: projection.tasks.some((task) => task.role === "writer" && task.handoff?.reviewStatus === "adopted"),
        outputCapability: projection.attempts.some((attempt) => attempt.toolEvents.some((event) => event.capability === "output.write_text" && event.status === "completed")),
        stopCancel,
        budgetExhaustion,
        providerFailure
      },
      profileResolutionSources: projection.tasks.map((task) => task.resolvedProfile.resolutionSource ?? "unknown"),
      contextHashes: projection.attempts.flatMap((attempt) => attempt.contextHash === undefined ? [] : [attempt.contextHash]),
      usage: projection.attempts.map((attempt) => ({ status: attempt.status, totalTokens: attempt.usage.totalTokens })),
      secretScan: { passed: !readFileSync(outputPath, "utf8").match(/(?:api[_-]?key|bearer\s+|password\s*[:=])/iu) }
    };
    mkdirSync(resolve(evidencePath, ".."), { recursive: true });
    writeFileSync(resolve(evidencePath), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ decision: "pass", evidencePath: resolve(evidencePath), provider: profile.provider, model: profile.model, taskCount: projection.tasks.length, attemptCount: projection.attempts.length }, null, 2));
  } finally {
    await application.close();
  }
}

async function waitForProjection(window: Page, runId: string, timeoutMs: number): Promise<Projection> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await invoke(window, "sub_agent.run.inspect", { runId });
    if (response.event === "sub_agent.run.inspected") {
      const projection = (response.payload as { projection: Projection }).projection;
      if (!projection.tasks.some((task) => ["created", "queued", "running"].includes(task.status))) return projection;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("SUB_AGENT_PROVIDER_TIMEOUT");
}

async function invoke(window: Page, command: string, payload: Record<string, unknown> = {}): Promise<HostResponse> {
  return window.evaluate(async ({ command: commandName, payload: commandPayload }) => {
    const bridge = (window as unknown as { vcAgent: { invoke(command: unknown): Promise<HostResponse> } }).vcAgent;
    return bridge.invoke({ schemaVersion: 1, command: commandName, commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actor: { actorType: "user", actorId: "real-sub-agent-compat" }, sentAt: new Date().toISOString(), payload: commandPayload });
  }, { command, payload });
}

function isExternalPath(path: string | undefined): path is string {
  if (path === undefined || path.trim() === "") return false;
  const candidate = resolve(path);
  const repository = resolve(process.cwd());
  const relativePath = relative(repository, candidate);
  return isAbsolute(candidate) && (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "REAL_SUB_AGENT_COMPAT_FAILED");
  process.exitCode = 1;
});
