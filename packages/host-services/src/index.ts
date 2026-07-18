import type {
  AccessMode,
  ActionProposal,
  CapabilityExecutionRequest,
  CapabilityExecutionResult
} from "@vc-agent/contracts";
import {
  CapabilityRegistry,
  UnknownOutcomeError,
  type CapabilityDefinition,
  type CapabilityExecutionContext
} from "@vc-agent/capabilities";
export { ProjectIdentityStore, type ProjectIdentityMarker } from "./project-identity.js";
export { SHIPPED_MINIMAL_VC_SYSTEM_PROMPT, estimateTokens } from "./system-prompt.js";
export { inventoryProjectFiles, type MaterialInventoryRecord, type PreviousMaterialFingerprint } from "./material-inventory.js";
export { BASELINE_PARSER_ADAPTERS, expectedParserIdentity, getParserAdapter, type ParserAdapterRegistration } from "./parser-identity.js";
export { MaterialRecallSource, retrievalMetadata, retrievalTrajectorySummary, type BoundedRecallEnvelope, type MaterialRecallAccess, type MaterialRecallItem, type MaterialRecallQuery, type RecallContext, type RecallSource } from "./recall.js";
export { PublicWebRecallSource, detectWebResearchIntent, type PublicWebAccess, type PublicWebItem, type PublicWebQuery } from "./public-web.js";
export { PROJECT_CONTEXT_TEMPLATE, ProjectContextRecallSource, ProjectContextStore, parseProjectContext, type ProjectContextDocument, type ProjectContextRecallAccess, type ProjectContextRecallItem, type ProjectContextRecallQuery, type ProjectContextSection, type ProjectContextWarning } from "./project-context.js";
export { PROJECT_MEMORY_HEADER, MemoryCandidateStore, ProjectMemoryRecallSource, ProjectMemoryStore, detectMemoryCandidateSignal, memoryCandidateId, parseProjectMemory, type MemoryCandidate, type ProjectMemoryDocument, type ProjectMemoryDraft, type ProjectMemoryEntry, type ProjectMemoryRecallItem, type ProjectMemoryRecallQuery, type ProjectMemoryWarning } from "./project-memory.js";
export { COGNITIVE_EVOLUTION_HISTORY_HEADER, LONG_TERM_MEMORY_ARCHIVE_HEADER, LONG_TERM_MEMORY_HEADER, LongTermMemoryRecallSource, LongTermMemoryStore, createLongTermMemoryIndexContent, detectExplicitMemoryRecallIntent, detectJudgmentHeavyIntent, parseLongTermMemory, type LongTermMemoryDocument, type LongTermMemoryEntry, type LongTermMemoryFileSummary, type LongTermMemoryMaturity, type LongTermMemoryRecallItem, type LongTermMemoryRecallPolicy, type LongTermMemoryRecallQuery, type LongTermMemoryStatus, type LongTermMemoryWarning } from "./long-term-memory.js";
export { MemoryEvolutionStore, type CondensationArchiveItem, type CondensationRetention, type LocalMemoryProvenanceInspection, type LocalMemoryProvenanceRecord, type MemoryEvolutionAction, type MemoryEvolutionStoreOptions, type MemoryLearningDraft, type MemoryMaintenanceState, type MemoryPatchFileDiff, type MemoryPatchRequest, type PreparedMemoryPatch } from "./memory-evolution.js";
export { ProjectOutputRegistry } from "./project-output-registry.js";

export interface CapabilityAuthorizationSnapshot {
  readonly accessMode: AccessMode;
  readonly scope: "unscoped" | "project";
  readonly stateVersion: number;
  readonly activeCapabilityIds: readonly string[];
  readonly outputIntent: boolean;
  readonly outputLocation?: string;
}

export type GatewayDecision =
  | { readonly type: "result"; readonly result: CapabilityExecutionResult }
  | { readonly type: "confirmation_required"; readonly proposal: ActionProposal };

interface PendingExecution {
  readonly request: CapabilityExecutionRequest;
  readonly definition: CapabilityDefinition;
  readonly input: Record<string, unknown>;
  readonly authorization: CapabilityAuthorizationSnapshot;
}

export class CapabilityGateway {
  readonly #registry: CapabilityRegistry;
  readonly #pending = new Map<string, PendingExecution>();

  constructor(registry: CapabilityRegistry) {
    this.#registry = registry;
  }

  async request(request: CapabilityExecutionRequest, authorization: CapabilityAuthorizationSnapshot): Promise<GatewayDecision> {
    const prepared = this.#prepare(request, authorization);
    if ("result" in prepared) return { type: "result", result: prepared.result };
    let sensitive: ReturnType<CapabilityDefinition["inspect"]>;
    try {
      sensitive = prepared.definition.inspect(prepared.input, prepared.context);
    } catch (error) {
      return {
        type: "result",
        result: failure(request.requestId, "CAPABILITY_PRECONDITION_FAILED", error instanceof Error ? error.message : "Capability precondition failed.")
      };
    }
    if (
      sensitive === undefined &&
      authorization.accessMode === "standard" &&
      (prepared.definition.metadata.sideEffectClass === "external_write" || prepared.definition.metadata.sideEffectClass === "destructive")
    ) {
      return {
        type: "result",
        result: failure(request.requestId, "SENSITIVE_ACTION_PROPOSAL_REQUIRED", "Sensitive capability did not provide a scoped Action Proposal.")
      };
    }
    if (sensitive !== undefined && authorization.accessMode === "standard") {
      const proposal: ActionProposal = { requestId: request.requestId, capabilityId: request.capabilityId, ...sensitive };
      this.#pending.set(request.requestId, {
        request,
        definition: prepared.definition,
        input: prepared.input,
        authorization
      });
      return { type: "confirmation_required", proposal };
    }
    return { type: "result", result: await this.#execute(prepared.definition, prepared.input, prepared.context) };
  }

  async resolve(
    requestId: string,
    approved: boolean,
    currentAuthorization: CapabilityAuthorizationSnapshot
  ): Promise<CapabilityExecutionResult> {
    const pending = this.#pending.get(requestId);
    this.#pending.delete(requestId);
    if (pending === undefined) return failure(requestId, "CONFIRMATION_NOT_FOUND", "The scoped confirmation is no longer active.");
    if (!approved) return failure(requestId, "USER_REJECTED", "The User rejected this capability action.", "rejected");
    const prepared = this.#prepare(pending.request, currentAuthorization);
    if ("result" in prepared) return prepared.result;
    return this.#execute(prepared.definition, prepared.input, { ...prepared.context, sensitiveActionApproved: true });
  }

  cancel(requestId: string): CapabilityExecutionResult | undefined {
    if (!this.#pending.delete(requestId)) return undefined;
    return failure(requestId, "TURN_INTERRUPTED", "Capability execution was interrupted.", "rejected");
  }

  #prepare(request: CapabilityExecutionRequest, authorization: CapabilityAuthorizationSnapshot):
    | { result: CapabilityExecutionResult }
    | { definition: CapabilityDefinition; input: Record<string, unknown>; context: CapabilityExecutionContext } {
    const definition = this.#registry.get(request.capabilityId);
    if (definition === undefined || !definition.metadata.modelCallable) return { result: failure(request.requestId, "CAPABILITY_UNAVAILABLE", "Capability is unavailable.") };
    if (!authorization.activeCapabilityIds.includes(request.capabilityId)) return { result: failure(request.requestId, "CAPABILITY_INACTIVE", "Capability is not active for this Turn.") };
    if (request.scope.kind !== authorization.scope || !definition.metadata.allowedScopes.includes(authorization.scope)) return { result: failure(request.requestId, "SCOPE_REJECTED", "Capability is outside the authorized scope.") };
    if (request.scope.kind === "unscoped" && request.scope.threadId !== request.threadId) return { result: failure(request.requestId, "SCOPE_REJECTED", "Unscoped capability Thread does not match.") };
    if (request.expectedStateVersion !== authorization.stateVersion) return { result: failure(request.requestId, "STALE_CAPABILITY_STATE", "Capability state changed before execution.") };
    if (definition.metadata.activationClass === "preconditioned_execution" && !authorization.outputIntent) return { result: failure(request.requestId, "OUTPUT_INTENT_REQUIRED", "Output Intent is required for this capability.") };
    const parsed = definition.inputSchema.safeParse(request.arguments);
    if (!parsed.success) return { result: failure(request.requestId, "INVALID_CAPABILITY_ARGUMENTS", "Capability arguments are invalid.") };
    const context: CapabilityExecutionContext = {
      request,
      accessMode: authorization.accessMode,
      ...(authorization.outputLocation === undefined ? {} : { outputLocation: authorization.outputLocation })
    };
    return { definition, input: parsed.data, context };
  }

  async #execute(
    definition: CapabilityDefinition,
    input: Record<string, unknown>,
    context: CapabilityExecutionContext
  ): Promise<CapabilityExecutionResult> {
    try {
      return await definition.execute(input, context);
    } catch (error) {
      if (error instanceof UnknownOutcomeError) return failure(context.request.requestId, "UNKNOWN_TOOL_OUTCOME", error.message, "unknown_outcome");
      return failure(context.request.requestId, "CAPABILITY_EXECUTION_FAILED", error instanceof Error ? error.message : "Capability execution failed.");
    }
  }
}

export function detectOutputIntent(text: string): boolean {
  const englishAction = /\b(save|create|write|generate|export|produce|draft)\b/iu.test(text);
  const englishObject = /\b(file|document|memo|report|output|markdown|text)\b/iu.test(text);
  const chineseAction = /(保存|创建|生成|写入|导出|制作|输出)/u.test(text);
  const chineseObject = /(文件|文档|报告|备忘录|输出|文本|memo)/iu.test(text);
  return (englishAction && englishObject) || (chineseAction && chineseObject);
}

function failure(
  requestId: string,
  code: string,
  content: string,
  status: "failed" | "rejected" | "unknown_outcome" = "failed"
): CapabilityExecutionResult {
  return { schemaVersion: 1, requestId, status, content: content.slice(0, 20_000), code };
}
