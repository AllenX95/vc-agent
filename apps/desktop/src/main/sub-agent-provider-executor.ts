import { randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import type {
  CapabilityExecutionRequest,
  CapabilityExecutionResult,
  ExtensionInventorySnapshot,
  RuntimeResourceSnapshot,
  SubAgentCapability,
  SubAgentContextBoundary,
  SubAgentProfileSnapshot,
  SubAgentUsage,
  WorkerEvent
} from "@vc-agent/contracts";
import { estimateTokens, type SubAgentProviderExecutionInput, type SubAgentProviderExecutionResult, type SubAgentProviderExecutor } from "@vc-agent/host-services";
import type { AgentWorkerSupervisor } from "./agent-worker-supervisor.js";

interface PendingExecution {
  readonly input: SubAgentProviderExecutionInput;
  readonly command: Extract<import("@vc-agent/contracts").WorkerCommand, { command: "turn.execute" }>;
  readonly resolve: (result: SubAgentProviderExecutionResult) => void;
  readonly reject: (error: Error) => void;
  readonly toolEvents: Array<{ capability: string; status: "started" | "completed" | "failed" | "rejected"; summary: string }>;
  outputArtifact?: CapabilityExecutionResult["artifact"];
  settled: boolean;
}

export interface SubAgentCapabilityExecutionContext {
  readonly request: CapabilityExecutionRequest;
  readonly parentThreadId: string;
  readonly parentTurnId: string;
  readonly taskId: string;
  readonly profile: SubAgentProfileSnapshot;
  readonly contextBoundary: SubAgentContextBoundary;
  readonly capabilitySet: readonly SubAgentCapability[];
  readonly outputTarget?: string;
  readonly signal: AbortSignal;
}

export type SubAgentCapabilityResolver = (context: SubAgentCapabilityExecutionContext) => Promise<CapabilityExecutionResult>;

/**
 * Desktop Worker transport for the Host-owned ProviderSubAgentAdapter.  Each
 * Attempt gets a synthetic isolated Thread/session key and is never allowed to
 * reuse a parent Thread's physical context.
 */
export class DesktopSubAgentProviderExecutor implements SubAgentProviderExecutor {
  readonly #supervisor: AgentWorkerSupervisor;
  readonly #root: string;
  readonly #resolveProjectPath: (projectId: string) => string | undefined;
  readonly #resolveCredential: (profileId: string) => string | undefined;
  readonly #resources: () => RuntimeResourceSnapshot;
  readonly #extensions: () => ExtensionInventorySnapshot;
  readonly #resolveCapability: SubAgentCapabilityResolver | undefined;
  readonly #pending = new Map<string, PendingExecution>();

  constructor(input: {
    readonly supervisor: AgentWorkerSupervisor;
    readonly root: string;
    readonly resolveProjectPath?: (projectId: string) => string | undefined;
    readonly resolveCredential: (profileId: string) => string | undefined;
    readonly resources: () => RuntimeResourceSnapshot;
    readonly extensions: () => ExtensionInventorySnapshot;
    readonly resolveCapability?: SubAgentCapabilityResolver;
  }) {
    this.#supervisor = input.supervisor;
    this.#root = input.root;
    this.#resolveProjectPath = input.resolveProjectPath ?? (() => undefined);
    this.#resolveCredential = input.resolveCredential;
    this.#resources = input.resources;
    this.#extensions = input.extensions;
    this.#resolveCapability = input.resolveCapability;
  }

  async execute(input: SubAgentProviderExecutionInput): Promise<SubAgentProviderExecutionResult> {
    const credential = this.#resolveCredential(input.profile.profileId);
    if (credential === undefined) throw new Error("SUB_AGENT_PROVIDER_CREDENTIAL_UNAVAILABLE");
    const threadId = `sub-agent-${input.runId}-${input.taskId}`;
    const turnId = input.attemptId;
    const correlationId = `sub-agent:${input.attemptId}`;
    const resources = this.#resources();
    const prompt = input.prompt;
    // The real compatibility command can deliberately exercise the Provider
    // failure path with a model id that the configured endpoint does not
    // expose. This marker is accepted only for the explicit real-compat run;
    // ordinary product prompts never change the selected Profile.
    const forceProviderFailure = process.env.VC_AGENT_REAL_SUB_AGENT === "1" && prompt.includes("[[VC_AGENT_FORCE_PROVIDER_FAILURE]]");
    const commandProfile = forceProviderFailure ? { ...input.profile, model: `${input.profile.model}-vc-agent-invalid` } : input.profile;
    const command: Extract<import("@vc-agent/contracts").WorkerCommand, { command: "turn.execute" }> = {
      schemaVersion: 1,
      command: "turn.execute",
      commandId: randomUUID(),
      correlationId,
      threadId,
      turnId,
      cwd: input.contextBoundary.scope === "project" ? this.#resolveProjectPath(input.contextBoundary.projectId!) ?? this.#root : this.#root,
      threadDirectory: join(this.#root, "delegation", "sessions", input.runId, input.taskId),
      contextHistory: [],
      estimatedInputTokens: estimateTokens(resources.systemPrompt) + estimateTokens(prompt),
      currentInputTokens: estimateTokens(resources.systemPrompt) + estimateTokens(prompt),
      activeCapabilities: this.#resolveCapability === undefined ? [] : providerCapabilityIds(input.capabilitySet, input.contextBoundary.scope),
      expectedStateVersion: 1,
      executionScope: input.contextBoundary.scope === "project"
        ? { kind: "project", projectId: input.contextBoundary.projectId! }
        : { kind: "unscoped", threadId },
      prompt,
      profile: {
        provider: commandProfile.provider,
        model: commandProfile.model,
        apiKey: credential,
        thinkingLevel: commandProfile.thinkingLevel
      },
      resources,
      extensions: this.#extensions()
    };
    return new Promise<SubAgentProviderExecutionResult>((resolve, reject) => {
      const pending: PendingExecution = { input, command, resolve, reject, toolEvents: [], settled: false };
      this.#pending.set(input.attemptId, pending);
      const abort = () => {
        if (!this.#pending.has(input.attemptId)) return;
        this.#supervisor.stop({ schemaVersion: 1, command: "turn.stop", commandId: randomUUID(), correlationId, threadId, turnId });
      };
      if (input.signal.aborted) abort(); else input.signal.addEventListener("abort", abort, { once: true });
      void this.#supervisor.execute(command).catch((error: unknown) => this.#settleFailure(input.attemptId, error instanceof Error ? error : new Error("SUB_AGENT_WORKER_START_FAILED")));
    });
  }

  terminate(attemptId: string): void {
    const pending = this.#pending.get(attemptId);
    if (pending === undefined) return;
    this.#supervisor.stop({ schemaVersion: 1, command: "turn.stop", commandId: randomUUID(), correlationId: pending.command.correlationId, threadId: pending.command.threadId, turnId: pending.command.turnId });
  }

  /** Returns true when the event belongs to a pending Sub-Agent Attempt. */
  handleEvent(event: WorkerEvent): boolean {
    const pending = this.#pending.get(event.turnId);
    if (pending === undefined) return false;
    if (event.event === "capability.execution.requested") {
      pending.toolEvents.push({ capability: event.request.capabilityId, status: "started", summary: "Capability execution requested." });
      if (this.#resolveCapability === undefined) {
        this.#resolveCapabilityResult(pending, event.request, { schemaVersion: 1, requestId: event.request.requestId, status: "rejected", code: "SUB_AGENT_CAPABILITY_NOT_WIRED", content: "Sub-Agent capability execution is not available for this Attempt." });
        return true;
      }
      void this.#resolveCapability({
        request: event.request,
        parentThreadId: pending.input.parentThreadId,
        parentTurnId: pending.input.parentTurnId,
        taskId: pending.input.taskId,
        profile: pending.input.profile,
        contextBoundary: pending.input.contextBoundary,
        capabilitySet: pending.input.capabilitySet,
        ...(pending.input.outputTarget === undefined ? {} : { outputTarget: pending.input.outputTarget }),
        signal: pending.input.signal
      }).then((result) => this.#resolveCapabilityResult(pending, event.request, result)).catch((error: unknown) => this.#resolveCapabilityResult(pending, event.request, {
        schemaVersion: 1,
        requestId: event.request.requestId,
        status: "failed",
        code: "SUB_AGENT_CAPABILITY_FAILED",
        content: error instanceof Error ? error.message.slice(0, 1_200) : "Sub-Agent capability execution failed."
      }));
      return true;
    }
    if (event.event === "turn.completed") {
      try {
        const outputPath = pending.input.outputTarget === undefined
          ? undefined
          : pending.outputArtifact?.destination
            ?? (this.#resolveCapability === undefined
              ? writeBoundedOutput(pending.input.outputTarget, pending.input.contextBoundary.outputRoot, event.message)
              : (() => { throw new Error("SUB_AGENT_OUTPUT_REGISTRY_REQUIRED"); })());
        const handoff = pending.input.outputTarget === undefined
          ? undefined
          : { outputPath, summary: "Provider-generated Sub-Agent output is ready for parent review.", provenance: pending.input.contextBoundary.sourceReferenceIds.map((referenceId) => ({ referenceId, source: "provider" })), adoptedByParent: false, reviewStatus: "pending_parent_review" as const };
        this.#settle(event.turnId, { assistantMessage: event.message, usage: mapUsage(event.usage), ...(pending.toolEvents.length === 0 ? {} : { toolEvents: pending.toolEvents }), ...(handoff === undefined ? {} : { handoff }) });
      } catch (error) {
        this.#settleFailure(event.turnId, error instanceof Error ? error : new Error("SUB_AGENT_OUTPUT_WRITE_FAILED"));
      }
      this.#supervisor.retire(event.ownerKey ?? pending.command.threadId);
      return true;
    }
    if (event.event === "turn.failed") {
      this.#settleFailure(event.turnId, new Error(`${event.failure.code}: ${event.failure.message}`));
      this.#supervisor.retire(event.ownerKey ?? pending.command.threadId);
      return true;
    }
    if (event.event === "turn.interrupted") {
      this.#settleFailure(event.turnId, new Error(`SUB_AGENT_${event.reason === "user_stop" ? "STOPPED" : "INTERRUPTED"}`));
      this.#supervisor.retire(event.ownerKey ?? pending.command.threadId);
      return true;
    }
    return true;
  }

  #settle(attemptId: string, result: SubAgentProviderExecutionResult): void {
    const pending = this.#pending.get(attemptId);
    if (pending === undefined || pending.settled) return;
    pending.settled = true;
    this.#pending.delete(attemptId);
    pending.resolve(result);
  }

  #settleFailure(attemptId: string, error: Error): void {
    const pending = this.#pending.get(attemptId);
    if (pending === undefined || pending.settled) return;
    pending.settled = true;
    this.#pending.delete(attemptId);
    pending.reject(error);
  }

  #resolveCapabilityResult(pending: PendingExecution, request: CapabilityExecutionRequest, result: CapabilityExecutionResult): void {
    const event = pending.toolEvents.findLast((item) => item.capability === request.capabilityId && item.status === "started");
    if (event !== undefined) {
      event.status = result.status === "completed" ? "completed" : result.status === "rejected" ? "rejected" : "failed";
      event.summary = result.content.slice(0, 1_200);
    }
    if (result.artifact !== undefined && result.status === "completed") pending.outputArtifact = result.artifact;
    this.#supervisor.resolveCapability({
      schemaVersion: 1,
      command: "capability.execution.resolve",
      commandId: randomUUID(),
      correlationId: pending.command.correlationId,
      threadId: pending.command.threadId,
      turnId: pending.command.turnId,
      result
    });
  }
}

function mapUsage(usage: { readonly input: number; readonly output: number; readonly totalTokens: number }): SubAgentUsage {
  return { inputTokens: Math.max(0, usage.input), outputTokens: Math.max(0, usage.output), totalTokens: Math.max(0, usage.totalTokens) };
}

function writeBoundedOutput(target: string, outputRoot: string | undefined, content: string): string {
  if (outputRoot === undefined) throw new Error("SUB_AGENT_OUTPUT_LOCATION_REQUIRED");
  const normalizedRoot = resolve(outputRoot);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) throw new Error("SUB_AGENT_OUTPUT_TARGET_OUTSIDE_SCOPE");
  mkdirSync(dirname(normalizedTarget), { recursive: true });
  const partial = `${normalizedTarget}.partial`;
  writeFileSync(partial, content.slice(0, 200_000), "utf8");
  renameSync(partial, normalizedTarget);
  return normalizedTarget;
}

export function providerCapabilityIds(capabilities: readonly SubAgentCapability[], scope: SubAgentContextBoundary["scope"]): string[] {
  const ids = new Set<string>();
  for (const capability of capabilities) {
    if (capability === "read_context" && scope === "project") ids.add("project_state_recall");
    if (capability === "read_materials") ids.add("material_recall");
    if (capability === "web_research") { ids.add("web_search"); ids.add("web_fetch"); }
    if (capability === "write_output") ids.add("output.write_text");
  }
  return [...ids];
}
