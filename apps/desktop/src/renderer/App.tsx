import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  createBootstrapCommand,
  createCommand,
  hostEventSchema,
  type BootstrapState,
  type DreamDueProposal,
  type DreamBatch,
  type DreamReviewState,
  type ExecutionQueueItem,
  type DreamSynthesisProposal,
  type HostCommand,
  type HostEvent,
  type JudgmentRecordDraft,
  type LongTermLearningProposal,
  type LongTermMemoryDocument,
  type MemoryMaintenanceState,
  type MaterialInventoryItem,
  type MemoryCandidate,
  type ModelProfile,
  type PendingDreamReminder,
  type Project,
  type ProjectContextDocument,
  type ProjectMemoryDocument,
  type ProjectOutputArtifact,
  type PreparedMemoryPatch,
  type PromptContribution,
  type ProviderFailure,
  type ReflectionRun,
  type SystemPromptRevision,
  type SkillCompatibilityReport,
  type SkillInventoryItem,
  type IntegrationState,
  type IntegrationTaskContext,
  type SubAgentProjection,
  type TaskModelAssignment,
  type TaskModelType,
  type TrajectoryProfile,
  type TokenUsage,
  type Thread
} from "@vc-agent/contracts";
import { missingIntegrationContext, resolveIntegrationTaskContext } from "./integration-context";
import {
  Archive,
  ChevronDown,
  ClipboardCheck,
  CircleStop,
  ExternalLink,
  Folder,
  FolderOpen,
  KeyRound,
  MessageSquare,
  Minimize2,
  Moon,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Trash2
} from "lucide-react";

type View = "workspace" | "settings";
const TASK_MODEL_TYPES: Array<{ id: TaskModelType; label: string }> = [
  { id: "ordinary_conversation", label: "Ordinary conversation" }, { id: "web_research", label: "Web research" },
  { id: "document_generation", label: "Document generation" }, { id: "dream", label: "Dream" },
  { id: "independent_evidence", label: "Independent evidence" }, { id: "memory_aware_reflection", label: "Memory-aware reflection" },
  { id: "extension_audit", label: "Extension audit" }, { id: "visual_material_analysis", label: "Visual material analysis" },
  { id: "sub_agent_default", label: "Default Sub-Agent" }, { id: "sub_agent_researcher", label: "Sub-Agent researcher" },
  { id: "sub_agent_critic", label: "Sub-Agent critic" }, { id: "sub_agent_synthesizer", label: "Sub-Agent synthesizer" },
  { id: "sub_agent_writer", label: "Sub-Agent writer" }, { id: "sub_agent_custom", label: "Sub-Agent custom" }
];
type ConversationItem =
  | { id: string; turnId: string; role: "user"; text: string }
  | { id: string; turnId: string; role: "system"; text: string }
  | {
      id: string;
      turnId: string;
      role: "tool";
      requestId: string;
      capabilityId: string;
      status: "started" | "completed" | "rejected" | "failed" | "unknown_outcome";
      text: string;
      artifact?: { id: string; mediaType: string; destination: string };
    }
  | {
      id: string;
      turnId: string;
      role: "assistant";
      text: string;
      status: "queued" | "streaming" | "completed" | "failed" | "interrupted";
      profile?: TrajectoryProfile;
      usage?: TokenUsage;
      latencyMs?: number;
      recalledStateEstimatedTokens?: number;
      prompt?: { revisionId: string; contributions: PromptContribution };
      failure?: ProviderFailure;
      retryText?: string;
    };

function DiagnosticBanner({ event }: { event: HostEvent | null }) {
  if (event?.event !== "diagnostic.raised") return null;
  return (
    <div className="diagnostic" role="alert">
      <strong>{event.payload.code}</strong>
      <span>{event.payload.message}</span>
    </div>
  );
}

function RecoveryBanner({ bootstrap }: { bootstrap: BootstrapState | null }) {
  if (bootstrap?.storageMode !== "read_only_recovery") return null;
  return <div className="recovery-banner" role="status"><strong>Read-only Recovery</strong><span>{bootstrap.migration.diagnosticMessage ?? "Local state is available for inspection, but changes and agent execution are disabled."}</span></div>;
}

export function App() {
  const [view, setView] = useState<View>("workspace");
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [diagnostic, setDiagnostic] = useState<HostEvent | null>(null);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [taskAssignments, setTaskAssignments] = useState<TaskModelAssignment[]>([]);
  const [skillsRoot, setSkillsRoot] = useState<string | null>(null);
  const [skillPackages, setSkillPackages] = useState<SkillInventoryItem[]>([]);
  const [lastSkillReport, setLastSkillReport] = useState<SkillCompatibilityReport | null>(null);
  const [integrationState, setIntegrationState] = useState<IntegrationState | null>(null);
  const [subAgentProjections, setSubAgentProjections] = useState<Record<string, SubAgentProjection>>({});
  const [reflectionRuns, setReflectionRuns] = useState<ReflectionRun[]>([]);
  const [reflectionOutcomes, setReflectionOutcomes] = useState<Record<string, { judgments: JudgmentRecordDraft[]; learningProposals: LongTermLearningProposal[] }>>({});
  const [reflectionLaunch, setReflectionLaunch] = useState<(({ scope: "project"; projectId: string } | { scope: "unscoped"; threadId: string }) & { focus: string; profileId: string }) | null>(null);
  const [promptRevisions, setPromptRevisions] = useState<SystemPromptRevision[]>([]);
  const [activePromptRevisionId, setActivePromptRevisionId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [executionQueue, setExecutionQueue] = useState<ExecutionQueueItem[]>([]);
  const [executionCapacity, setExecutionCapacity] = useState({ running: 0, capacity: 1 });
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Record<string, ConversationItem[]>>({});
  const [prompt, setPrompt] = useState("");
  const [profileFormOpen, setProfileFormOpen] = useState(false);
  const [profileChange, setProfileChange] = useState<Extract<HostEvent, { event: "thread.profile.change.required" }> | null>(null);
  const [confirmations, setConfirmations] = useState<Record<string, Extract<HostEvent, { event: "capability.confirmation.required" }>>>({});
  const [projectCollision, setProjectCollision] = useState<Extract<HostEvent, { event: "project.identity.collision" }> | null>(null);
  const [materialsByProject, setMaterialsByProject] = useState<Record<string, MaterialInventoryItem[]>>({});
  const [parseRefreshChoice, setParseRefreshChoice] = useState<Extract<HostEvent, { event: "material.parse.refresh.choice.required" }> | null>(null);
  const [materialParseState, setMaterialParseState] = useState<Record<string, string>>({});
  const [projectPanelTab, setProjectPanelTab] = useState<"overview" | "outputs" | "context" | "memory">("overview");
  const [contextDocuments, setContextDocuments] = useState<Record<string, ProjectContextDocument>>({});
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({});
  const contextDirty = useRef<Record<string, boolean>>({});
  const [memoryDocuments, setMemoryDocuments] = useState<Record<string, ProjectMemoryDocument>>({});
  const [memoryDrafts, setMemoryDrafts] = useState<Record<string, string>>({});
  const memoryDirty = useRef<Record<string, boolean>>({});
  const [memoryCandidates, setMemoryCandidates] = useState<Record<string, MemoryCandidate>>({});
  const [candidateDraft, setCandidateDraft] = useState<{ candidate: MemoryCandidate; title: string; tags: string; body: string } | null>(null);
  const [outputsByProject, setOutputsByProject] = useState<Record<string, ProjectOutputArtifact[]>>({});
  const [recoveryExport, setRecoveryExport] = useState<string | null>(null);
  const [personalCognitionNotice, setPersonalCognitionNotice] = useState<string | null>(null);
  const [longTermMemoryDocument, setLongTermMemoryDocument] = useState<LongTermMemoryDocument | null>(null);
  const [longTermMemoryDraft, setLongTermMemoryDraft] = useState("");
  const [preparedMemoryPatch, setPreparedMemoryPatch] = useState<PreparedMemoryPatch | null>(null);
  const [memoryMaintenance, setMemoryMaintenance] = useState<MemoryMaintenanceState | null>(null);
  const [dreamState, setDreamState] = useState<DreamReviewState | null>(null);
  const [dreamDueProposal, setDreamDueProposal] = useState<DreamDueProposal | null>(null);
  const [pendingDreamReminder, setPendingDreamReminder] = useState<PendingDreamReminder | null>(null);
  const [dreamLaunchProfileId, setDreamLaunchProfileId] = useState<string | null>(null);
  const [dreamNoticeDismissed, setDreamNoticeDismissed] = useState(false);
  const [deleteHistoryThreadId, setDeleteHistoryThreadId] = useState<string | null>(null);
  const longTermMemoryDirty = useRef(false);
  const activeThreadIdRef = useRef<string | null>(null);
  const pendingProfileSelections = useRef<Record<string, Promise<unknown>>>({});

  activeThreadIdRef.current = activeThreadId;

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const activeProfile = profiles.find((profile) => profile.id === activeThread?.activeProfileId);
  const activeProject = activeThread?.scope === "project" ? projects.find((project) => project.id === activeThread.projectId) : undefined;
  const activeReflection = reflectionRuns.find((run) => run.threadId === activeThreadId);
  const activeReflectionProfile = profiles.find((profile) => profile.id === activeReflection?.memoryAwareProfileId);
  const items = activeThreadId === null ? [] : conversations[activeThreadId] ?? [];
  const latestTurnId = items.at(-1)?.turnId;
  const integrationContext = resolveIntegrationTaskContext({ activeThread, activeProject, activeProfile, latestTurnId, accessMode: bootstrap?.accessMode ?? "standard" });
  const hasActiveTurn = items.some(
    (item) => item.role === "assistant" && (item.status === "queued" || item.status === "streaming")
  );
  const activeTurn = items.find((item) => item.role === "assistant" && (item.status === "queued" || item.status === "streaming"));
  const readOnlyRecovery = bootstrap?.storageMode === "read_only_recovery";
  const learningTelemetry = {
    coveredScopes: dreamState?.batches.flatMap((batch) => batch.extractionScopes).filter((scope) => scope.status === "approved" || scope.status === "skipped").length ?? 0,
    totalScopes: dreamState?.batches.flatMap((batch) => batch.extractionScopes).length ?? 0,
    failureCount: reflectionRuns.filter((run) => run.status.includes("failed")).length
      + (dreamState?.batches.flatMap((batch) => batch.extractionScopes).filter((scope) => scope.status === "failed").length ?? 0)
      + Object.values(conversations).flat().filter((item) => item.role === "assistant" && item.status === "failed").length
  };

  const applyEvent = useCallback((event: HostEvent) => {
    switch (event.event) {
      case "app.bootstrap.completed": setBootstrap(event.payload); break;
      case "state.recovery.export.completed": setRecoveryExport(event.payload.status === "exported" ? event.payload.destination ?? "Export completed" : "Export canceled"); break;
      case "personal_cognition.operation.completed":
        setPersonalCognitionNotice(event.payload.status === "completed" ? `${event.payload.operation === "backup" ? "Backup created" : "Restore completed"}: ${event.payload.path ?? ""}${event.payload.requiresCredentialSetup ? " · Model Profile credentials require fresh setup." : ""}` : `${event.payload.operation === "backup" ? "Backup" : "Restore"} canceled`);
        if (event.payload.operation === "restore" && event.payload.status === "completed") window.setTimeout(() => window.location.reload(), 50);
        break;
      case "long_term_memory.loaded":
      case "long_term_memory.updated":
        if (event.payload.source === "external_edit" && longTermMemoryDirty.current) {
          setDiagnostic(localDiagnostic("Long-term Memory changed outside vc-agent while this view has unsaved edits. Refresh to use the external version."));
          break;
        }
        longTermMemoryDirty.current = false;
        setLongTermMemoryDocument(event.payload.document);
        setLongTermMemoryDraft(event.payload.document.content);
        break;
      case "long_term_memory.folder.opened": break;
      case "long_term_memory.patch.prepared": setPreparedMemoryPatch(event.payload.patch); break;
      case "long_term_memory.patch.committed":
        longTermMemoryDirty.current = false;
        setLongTermMemoryDocument(event.payload.document);
        setLongTermMemoryDraft(event.payload.document.content);
        setPreparedMemoryPatch(null);
        break;
      case "long_term_memory.patch.discarded": setPreparedMemoryPatch(null); break;
      case "long_term_memory.maintenance.loaded":
      case "long_term_memory.maintenance.updated": setMemoryMaintenance(event.payload.state); break;
      case "long_term_memory.provenance.inspected": break;
      case "access.mode.changed": setBootstrap((current) => current === null ? current : { ...current, accessMode: event.payload.mode }); break;
      case "profiles.listed": setProfiles(event.payload.profiles); break;
      case "skills.updated":
        setSkillsRoot(event.payload.root);
        setSkillPackages(event.payload.packages);
        setLastSkillReport(event.payload.report ?? null);
        break;
      case "integration.state.updated": setIntegrationState(event.payload.state); break;
      case "integration.job.updated": setIntegrationState((current) => current === null ? current : { ...current, runtime: { ...current.runtime, runningJobs: event.payload.job.state === "running" ? current.runtime.runningJobs + 1 : current.runtime.runningJobs, queuedJobs: event.payload.job.state === "queued" ? current.runtime.queuedJobs + 1 : current.runtime.queuedJobs }, ...(event.payload.workflow === "office" ? { office: { ...current.office, jobs: [...current.office.jobs.filter((job) => job.id !== event.payload.job.id), event.payload.job] } } : {}), ...(event.payload.workflow === "page_recovery" ? { pageRecovery: { ...current.pageRecovery, parses: [...current.pageRecovery.parses.filter((job) => job.id !== event.payload.job.id), event.payload.job] } } : {}) }); break;
      case "integration.diagnostic": setDiagnostic(localDiagnostic(`${event.payload.workflow}: ${event.payload.code} · ${event.payload.message}`)); break;
      case "sub_agent.runs.listed":
        setSubAgentProjections(Object.fromEntries(event.payload.projections.map((projection) => [projection.run.id, projection])));
        break;
      case "sub_agent.run.authorized":
      case "sub_agent.run.inspected":
      case "sub_agent.run.stopped":
      case "sub_agent.run.completed":
      case "sub_agent.run.interrupted":
      case "sub_agent.task.created":
      case "sub_agent.task.queued":
      case "sub_agent.task.started":
      case "sub_agent.task.updated":
      case "sub_agent.task.completed":
      case "sub_agent.task.failed":
      case "sub_agent.task.retry":
      case "sub_agent.task.skipped":
      case "sub_agent.handoff.adopted":
      case "sub_agent.handoff.rejected":
      case "sub_agent.record.deleted":
      case "sub_agent.attempt.created":
      case "sub_agent.budget.exhausted":
        setSubAgentProjections((current) => ({ ...current, [event.payload.projection.run.id]: event.payload.projection }));
        break;
      case "profile.credential.updated": setProfiles((current) => [...current.filter((item) => item.id !== event.payload.profile.id), event.payload.profile]); break;
      case "task_model_assignments.listed": setTaskAssignments(event.payload.assignments); break;
      case "task_model_assignment.updated": setTaskAssignments((current) => event.payload.assignment === undefined ? current.filter((item) => item.taskType !== event.payload.taskType) : [...current.filter((item) => item.taskType !== event.payload.taskType), event.payload.assignment]); break;
      case "reflection.runs.listed": setReflectionRuns(event.payload.runs); break;
      case "reflection.run.created":
        setReflectionRuns((current) => [event.payload.run, ...current.filter((item) => item.id !== event.payload.run.id)]);
        setThreads((current) => [...current.filter((item) => item.id !== event.payload.thread.id), event.payload.thread]);
        setActiveThreadId(event.payload.thread.id);
        setReflectionLaunch(null);
        setView("workspace");
        break;
      case "reflection.run.updated": setReflectionRuns((current) => [event.payload.run, ...current.filter((item) => item.id !== event.payload.run.id)]); break;
      case "reflection.outcomes.updated": setReflectionOutcomes((current) => ({ ...current, [event.payload.runId]: { judgments: event.payload.judgments, learningProposals: event.payload.learningProposals } })); break;
      case "prompt.revisions.listed": setPromptRevisions(event.payload.revisions); setActivePromptRevisionId(event.payload.activeRevisionId); break;
      case "prompt.revision.created": setPromptRevisions((current) => [event.payload.revision, ...current]); setActivePromptRevisionId(event.payload.activeRevisionId); break;
      case "prompt.revision.activated": setPromptRevisions((current) => [event.payload.revision, ...current.filter((item) => item.id !== event.payload.revision.id)]); setActivePromptRevisionId(event.payload.revision.id); break;
      case "projects.listed": setProjects(event.payload.projects); break;
      case "project.opened":
        setProjects((current) => [...current.filter((project) => project.id !== event.payload.project.id), event.payload.project]);
        setProjectCollision(null);
        break;
      case "project.identity.collision": setProjectCollision(event); break;
      case "project.materials.listed":
      case "project.materials.updated": setMaterialsByProject((current) => ({ ...current, [event.payload.projectId]: event.payload.materials })); break;
      case "project.context.loaded":
      case "project.context.updated": {
        const projectId = event.payload.document.projectId;
        if (event.payload.source === "external_edit" && contextDirty.current[projectId] === true) {
          setDiagnostic(localDiagnostic("Project Context changed outside vc-agent while this panel has unsaved edits. Reload to use the external version, or preserve your draft elsewhere before reloading."));
          break;
        }
        contextDirty.current[projectId] = false;
        setContextDocuments((current) => ({ ...current, [projectId]: event.payload.document }));
        setContextDrafts((current) => ({ ...current, [projectId]: event.payload.document.content }));
        break;
      }
      case "project.memory.loaded":
      case "project.memory.updated": {
        const projectId = event.payload.document.projectId;
        if (event.payload.source === "external_edit" && memoryDirty.current[projectId] === true) {
          setDiagnostic(localDiagnostic("Project Memory changed outside vc-agent while this panel has unsaved edits. Reload before saving or confirming a draft."));
          break;
        }
        memoryDirty.current[projectId] = false;
        setMemoryDocuments((current) => ({ ...current, [projectId]: event.payload.document }));
        setMemoryDrafts((current) => ({ ...current, [projectId]: event.payload.document.content }));
        if (event.payload.source === "confirmed_append") setCandidateDraft(null);
        break;
      }
      case "memory.candidate.captured": setMemoryCandidates((current) => ({ ...current, [event.payload.candidate.id]: event.payload.candidate })); break;
      case "memory.candidate.resolved":
        setMemoryCandidates((current) => ({ ...current, [event.payload.candidate.id]: event.payload.candidate }));
        if (event.payload.candidate.status !== "active") setCandidateDraft((draft) => draft?.candidate.id === event.payload.candidate.id ? null : draft);
        break;
      case "dream.state.updated":
        setDreamState(event.payload.state);
        setDreamDueProposal(event.payload.dueProposal ?? null);
        setPendingDreamReminder(event.payload.reminder ?? null);
        break;
      case "thread.trajectory.deleted":
        setConversations((current) => ({ ...current, [event.payload.threadId]: [] }));
        setMemoryCandidates((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !event.payload.removedCandidateIds.includes(id))));
        setDeleteHistoryThreadId(null);
        break;
      case "thread.archived":
        setThreads((current) => [...current.filter((item) => item.id !== event.payload.thread.id), event.payload.thread]);
        break;
      case "project.outputs.listed":
      case "project.outputs.updated": setOutputsByProject((current) => ({ ...current, [event.payload.projectId]: event.payload.outputs })); break;
      case "project.output.opened": break;
      case "material.parse.refresh.choice.required": setParseRefreshChoice(event); break;
      case "material.parse.refresh.choice.resolved": setParseRefreshChoice(null); break;
      case "material.parse.started": setMaterialParseState((current) => ({ ...current, [event.payload.materialId]: "Parsing..." })); break;
      case "material.parse.completed":
        setMaterialParseState((current) => ({ ...current, [event.payload.material.id]: event.payload.warningCount > 0 ? `Parsed with ${event.payload.warningCount} warning(s)` : event.payload.reused ? "Reused current parse" : "Parsed" }));
        setMaterialsByProject((current) => ({ ...current, [event.payload.material.projectId]: (current[event.payload.material.projectId] ?? []).map((item) => item.id === event.payload.material.id ? event.payload.material : item) }));
        break;
      case "material.parse.failed": setMaterialParseState((current) => ({ ...current, [event.payload.materialId]: `${event.payload.code}: ${event.payload.message}` })); break;
      case "profile.created":
        setProfiles((current) => [...current.filter((item) => item.id !== event.payload.profile.id), event.payload.profile]);
        setBootstrap((current) => current === null ? current : {
          ...current,
          entityCounts: { ...current.entityCounts, modelProfiles: current.entityCounts.modelProfiles + 1 },
          ...(current.environmentDoctor === undefined ? {} : { environmentDoctor: { ...current.environmentDoctor, provider: { status: "ready", message: `${current.entityCounts.modelProfiles + 1} Model Profile reference(s) configured.` } } })
        });
        setProfileFormOpen(false);
        break;
      case "threads.listed": setThreads(event.payload.threads); break;
      case "thread.trajectory.loaded":
        setConversations((current) => ({ ...current, [event.payload.threadId]: projectTrajectory(event.payload.turns, event.payload.activities) }));
        break;
      case "thread.created":
        setThreads((current) => [...current, event.payload.thread]);
        activeThreadIdRef.current = event.payload.thread.id;
        setActiveThreadId(event.payload.thread.id);
        setView("workspace");
        break;
      case "thread.profile.selected":
        setThreads((current) => current.map((item) => item.id === event.payload.thread.id ? event.payload.thread : item));
        break;
      case "thread.profile.change.required": setProfileChange(event); break;
      case "thread.profile.change.resolved":
        setProfileChange(null);
        setThreads((current) => [...current.filter((item) => item.id !== event.payload.thread.id), event.payload.thread]);
        activeThreadIdRef.current = event.payload.thread.id;
        setActiveThreadId(event.payload.thread.id);
        setView("workspace");
        if (event.payload.action === "start_new_thread") {
          setConversations((current) => ({ ...current, [event.payload.thread.id]: [] }));
        }
        break;
      case "thread.output.location.selected":
        setThreads((current) => current.map((item) => item.id === event.payload.thread.id ? event.payload.thread : item));
        break;
      case "turn.queued":
        setExecutionQueue((current) => [...current.filter((item) => item.id !== event.payload.item.id), event.payload.item].sort((a, b) => a.position - b.position));
        setPrompt("");
        break;
      case "execution_queue.updated":
        setExecutionQueue(event.payload.items);
        setExecutionCapacity({ running: event.payload.runningCount, capacity: event.payload.capacity });
        setBootstrap((current) => current === null ? current : { ...current, executionScheduler: event.payload.telemetry });
        break;
      case "turn.accepted":
        setConversations((current) => appendTurn(current, event.payload.threadId, event.payload.turnId, event.payload.text, event.payload.profile, event.payload.prompt));
        setPrompt("");
        break;
      case "turn.started":
        setConversations((current) => updateAssistant(current, event.payload.threadId, event.payload.turnId, (item) => ({ ...item, status: "streaming" })));
        break;
      case "message.delta":
        setConversations((current) => updateAssistant(current, event.payload.threadId, event.payload.turnId, (item) => ({ ...item, text: item.text + event.payload.delta, status: "streaming" })));
        break;
      case "turn.completed":
        setConversations((current) => updateAssistant(current, event.payload.threadId, event.payload.turnId, (item) => ({ ...item, text: event.payload.message, status: "completed", profile: event.payload.profile, usage: event.payload.usage, latencyMs: event.payload.latencyMs, recalledStateEstimatedTokens: event.payload.recalledStateEstimatedTokens })));
        break;
      case "turn.failed":
        setConversations((current) => failTurn(current, event.payload));
        setPrompt("");
        break;
      case "turn.interrupted":
        setConversations((current) => updateAssistant(current, event.payload.threadId, event.payload.turnId, (item) => ({
          ...item,
          text: event.payload.partialMessage,
          status: "interrupted",
          ...(event.payload.profile === undefined ? {} : { profile: event.payload.profile })
        })));
        break;
      case "physical_context.rebuilt":
        setConversations((current) => appendSystemEvent(current, event.payload.threadId, event.payload.turnId, `Physical context rebuilt from ${event.payload.retainedTurnCount} retained turn${event.payload.retainedTurnCount === 1 ? "" : "s"}.`));
        break;
      case "thread.compaction.started":
        setConversations((current) => appendSystemEvent(current, event.payload.threadId, event.payload.turnId, `Thread compaction started (${event.payload.reason}).`));
        break;
      case "thread.compaction.completed":
        setConversations((current) => appendSystemEvent(current, event.payload.threadId, event.payload.turnId, `Thread compaction completed: ${event.payload.tokensBefore ?? 0} -> ${event.payload.estimatedTokensAfter ?? "estimated"} tokens.`));
        break;
      case "thread.compaction.failed":
        setConversations((current) => appendSystemEvent(current, event.payload.threadId, event.payload.turnId, `Thread compaction failed: ${event.payload.failure?.message ?? "Provider failure"}`));
        break;
      case "system_prompt.updated":
        setConversations((current) => appendSystemEvent(current, event.payload.threadId, event.payload.turnId, `System prompt updated: ${event.payload.previousRevisionId.slice(0, 8)} -> ${event.payload.nextRevisionId.slice(0, 8)}`));
        break;
      case "capability.confirmation.required":
        setConfirmations((current) => ({ ...current, [event.payload.requestId]: event }));
        break;
      case "capability.execution.updated":
        setConversations((current) => updateToolActivity(current, event.payload));
        if (event.payload.status !== "started") {
          setConfirmations((current) => {
            const next = { ...current };
            delete next[event.payload.requestId];
            return next;
          });
        }
        break;
      case "turn.stop.requested": break;
      case "diagnostic.raised": setDiagnostic(event); break;
    }
  }, []);

  const invoke = useCallback(async (hostCommand: HostCommand) => {
    const rawEvent = await window.vcAgent.invoke(hostCommand);
    const parsed = hostEventSchema.safeParse(rawEvent);
    if (!parsed.success) {
      setDiagnostic(localDiagnostic("The Host returned an invalid event envelope."));
      return undefined;
    }
    applyEvent(parsed.data);
    return parsed.data;
  }, [applyEvent]);

  useEffect(() => {
    const unsubscribe = window.vcAgent.onEvent((rawEvent) => {
      const parsed = hostEventSchema.safeParse(rawEvent);
      if (parsed.success) applyEvent(parsed.data);
    });
    void invoke(createBootstrapCommand());
    void invoke(createCommand({ command: "profile.list" }));
    void invoke(createCommand({ command: "skills.list" }));
    void invoke(createCommand({ command: "integration.state.load" }));
    void invoke(createCommand({ command: "task_model_assignment.list" }));
    void invoke(createCommand({ command: "reflection.list", payload: {} }));
    void invoke(createCommand({ command: "dream.state.load" }));
    void invoke(createCommand({ command: "prompt.revision.list" }));
    void invoke(createCommand({ command: "project.list" }));
    void invoke(createCommand({ command: "thread.list" }));
    void invoke(createCommand({ command: "execution_queue.list" }));
    void invoke(createCommand({ command: "sub_agent.run.list" }));
    return unsubscribe;
  }, [applyEvent, invoke]);

  useEffect(() => {
    if (activeThread?.scope === "project") void invoke(createCommand({ command: "project.material.list", payload: { projectId: activeThread.projectId } }));
  }, [activeThread?.id, activeThread?.scope === "project" ? activeThread.projectId : null, invoke]);

  useEffect(() => {
    if (activeReflection !== undefined) void invoke(createCommand({ command: "reflection.outcome.list", payload: { runId: activeReflection.id } }));
  }, [activeReflection?.id, invoke]);

  const createThread = () => {
    void invoke(createCommand({ command: "thread.create.unscoped", payload: { title: `Thread ${threads.length + 1}` } }));
  };

  const openProject = () => void invoke(createCommand({ command: "project.open" }));

  const createProjectThread = (projectId: string) => {
    const count = threads.filter((thread) => thread.scope === "project" && thread.projectId === projectId).length;
    void invoke(createCommand({ command: "thread.create.project", payload: { projectId, title: `Thread ${count + 1}` } }));
  };

  const resolveProjectCollision = (action: "moved_project" | "project_copy") => {
    if (projectCollision === null) return;
    void invoke(createCommand({ command: "project.collision.resolve", payload: { collisionId: projectCollision.payload.collisionId, action } }));
  };

  const resolveParseRefresh = (choice: "create_new_version" | "replace_previous" | "cancel") => {
    if (parseRefreshChoice === null) return;
    void invoke(createCommand({ command: "material.parse.refresh.resolve", payload: { materialId: parseRefreshChoice.payload.material.id, choice } }));
  };

  const selectProfile = (profileId: string) => {
    const threadId = activeThreadIdRef.current;
    if (threadId === null || profileId.length === 0) return;
    const selection = invoke(createCommand({ command: "thread.profile.select", payload: { threadId, profileId } }));
    pendingProfileSelections.current[threadId] = selection;
    void selection.then(
      () => { if (pendingProfileSelections.current[threadId] === selection) delete pendingProfileSelections.current[threadId]; },
      () => { if (pendingProfileSelections.current[threadId] === selection) delete pendingProfileSelections.current[threadId]; }
    );
  };

  const selectThread = (threadId: string) => {
    activeThreadIdRef.current = threadId;
    setActiveThreadId(threadId);
    setProjectPanelTab("overview");
    setView("workspace");
    void invoke(createCommand({ command: "thread.trajectory.load", payload: { threadId } }));
  };

  const submit = async (text = prompt, retryOfTurnId?: string) => {
    const threadId = activeThreadIdRef.current;
    if (threadId === null || text.trim().length === 0) return;
    await pendingProfileSelections.current[threadId];
    await invoke(createCommand({
      command: "turn.submit",
      payload: { threadId, text: text.trim(), ...(retryOfTurnId === undefined ? {} : { retryOfTurnId }) }
    }));
  };

  const stop = () => {
    if (activeThreadId === null || activeTurn?.role !== "assistant") return;
    void invoke(createCommand({ command: "turn.stop", payload: { threadId: activeThreadId, turnId: activeTurn.turnId } }));
  };

  const compact = () => {
    if (activeThreadId === null || hasActiveTurn) return;
    void invoke(createCommand({ command: "thread.compact", payload: { threadId: activeThreadId } }));
  };

  const openDreamLaunch = () => {
    setDreamLaunchProfileId(taskAssignments.find((item) => item.taskType === "dream")?.profileId ?? "");
  };

  const launchDream = async () => {
    if (dreamLaunchProfileId === null) return;
    const event = await invoke(createCommand({ command: "dream.launch", payload: { ...(dreamLaunchProfileId === "" ? {} : { profileId: dreamLaunchProfileId }) } }));
    if (event?.event === "dream.state.updated") {
      setDreamLaunchProfileId(null);
      setDreamNoticeDismissed(false);
    }
  };

  const deferDreamNotice = () => {
    const until = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    void invoke(createCommand({ command: "dream.reminder.defer", payload: { until } }));
  };

  const deleteThreadHistory = async () => {
    if (deleteHistoryThreadId === null) return;
    const event = await invoke(createCommand({ command: "thread.trajectory.delete", payload: { threadId: deleteHistoryThreadId, confirmed: true } }));
    if (event?.event === "thread.trajectory.deleted") void invoke(createCommand({ command: "dream.state.load" }));
  };

  const resolveProfileChange = (action: "continue_current_thread" | "start_new_thread") => {
    if (profileChange === null) return;
    void invoke(createCommand({
      command: "thread.profile.change.resolve",
      payload: { threadId: profileChange.payload.threadId, profileId: profileChange.payload.requestedProfile.id, action }
    }));
  };

  const chooseOutputLocation = () => {
    if (activeThreadId === null) return;
    void invoke(createCommand({ command: "thread.output.location.choose", payload: { threadId: activeThreadId } }));
  };

  const resolveConfirmation = (requestId: string, approved: boolean) => {
    void invoke(createCommand({ command: "capability.confirmation.resolve", payload: { requestId, approved } }));
  };

  const openProjectContext = () => {
    if (activeThread?.scope !== "project") return;
    setProjectPanelTab("context");
    if (contextDocuments[activeThread.projectId] === undefined) {
      void invoke(createCommand({ command: "project.context.load", payload: { projectId: activeThread.projectId } }));
    }
  };

  const reloadProjectContext = () => {
    if (activeThread?.scope !== "project") return;
    contextDirty.current[activeThread.projectId] = false;
    void invoke(createCommand({ command: "project.context.load", payload: { projectId: activeThread.projectId } }));
  };

  const saveProjectContext = () => {
    if (activeThread?.scope !== "project") return;
    const document = contextDocuments[activeThread.projectId];
    const content = contextDrafts[activeThread.projectId];
    if (document === undefined || content === undefined) return;
    void invoke(createCommand({ command: "project.context.save", payload: { projectId: activeThread.projectId, content, expectedSourceHash: document.sourceHash } }));
  };

  const openProjectMemory = () => {
    if (activeThread?.scope !== "project") return;
    setProjectPanelTab("memory");
    if (memoryDocuments[activeThread.projectId] === undefined) void invoke(createCommand({ command: "project.memory.load", payload: { projectId: activeThread.projectId } }));
  };

  const openProjectOutputs = () => {
    if (activeThread?.scope !== "project") return;
    setProjectPanelTab("outputs");
    void invoke(createCommand({ command: "project.output.list", payload: { projectId: activeThread.projectId } }));
  };

  const reloadProjectMemory = () => {
    if (activeThread?.scope !== "project") return;
    memoryDirty.current[activeThread.projectId] = false;
    void invoke(createCommand({ command: "project.memory.load", payload: { projectId: activeThread.projectId } }));
  };

  const saveProjectMemory = () => {
    if (activeThread?.scope !== "project") return;
    const document = memoryDocuments[activeThread.projectId];
    const content = memoryDrafts[activeThread.projectId];
    if (document !== undefined && content !== undefined) void invoke(createCommand({ command: "project.memory.save", payload: { projectId: activeThread.projectId, content, expectedSourceHash: document.sourceHash } }));
  };

  const reviewCandidate = (candidate: MemoryCandidate) => {
    if (candidate.scope !== "project" || candidate.projectId === undefined) return;
    setCandidateDraft({ candidate, title: candidate.sourceSnippet.slice(0, 80), tags: "", body: candidate.sourceSnippet });
    setProjectPanelTab("memory");
    if (memoryDocuments[candidate.projectId] === undefined) void invoke(createCommand({ command: "project.memory.load", payload: { projectId: candidate.projectId } }));
  };

  const confirmCandidate = () => {
    const projectId = candidateDraft?.candidate.projectId;
    if (candidateDraft === null || projectId === undefined) return;
    const document = memoryDocuments[projectId];
    if (document === undefined) return;
    void invoke(createCommand({ command: "project.memory.append.confirm", payload: { candidateId: candidateDraft.candidate.id, projectId, title: candidateDraft.title, tags: candidateDraft.tags.split(",").map((tag) => tag.trim()).filter(Boolean), body: candidateDraft.body, expectedSourceHash: document.sourceHash } }));
  };

  const openReflectionLaunch = (projectId: string) => {
    const assigned = taskAssignments.find((item) => item.taskType === "independent_evidence");
    setReflectionLaunch({ scope: "project", projectId, focus: "", profileId: assigned?.profileId ?? "" });
  };

  const openUnscopedReflectionLaunch = (threadId: string) => {
    const assigned = taskAssignments.find((item) => item.taskType === "independent_evidence");
    setReflectionLaunch({ scope: "unscoped", threadId, focus: "", profileId: assigned?.profileId ?? "" });
  };

  const launchReflection = async () => {
    if (reflectionLaunch === null) return;
    const common = { ...(reflectionLaunch.focus.trim() === "" ? {} : { focus: reflectionLaunch.focus.trim() }), ...(reflectionLaunch.profileId === "" ? {} : { profileId: reflectionLaunch.profileId }) };
    const event = await invoke(createCommand(reflectionLaunch.scope === "project"
      ? { command: "reflection.start.project", payload: { projectId: reflectionLaunch.projectId, ...common } }
      : { command: "reflection.start.unscoped", payload: { threadId: reflectionLaunch.threadId, ...common } }));
    if (event?.event === "reflection.run.created" && event.payload.run.status === "ready") {
      await invoke(createCommand({ command: "reflection.independent.start", payload: { runId: event.payload.run.id } }));
    }
  };

  const startOrRetryReflection = (run: ReflectionRun, profileId?: string) => {
    void invoke(createCommand({ command: "reflection.independent.start", payload: { runId: run.id, ...(profileId === undefined || profileId === "" ? {} : { profileId }) } }));
  };

  const startMemoryAwareReflection = (run: ReflectionRun, profileId?: string) => {
    void invoke(createCommand({ command: "reflection.memory_aware.start", payload: { runId: run.id, ...(profileId === undefined || profileId === "" ? {} : { profileId }) } }));
  };

  return (
    <div className={`app-shell ${readOnlyRecovery ? "read-only-recovery" : ""}`}>
      <aside className="left-rail" aria-label="Navigation">
        <div className="brand-row">
          <div className="brand-mark">VC</div><span>vc-agent</span>
          <button className="icon-button" type="button" title="Search" aria-label="Search" disabled><Search size={17} /></button>
        </div>
        <nav className="navigation-groups">
          <section>
            <div className="section-label">
              <MessageSquare size={15} /><span>Unscoped Threads</span>
              <button className="section-action" type="button" title="New thread" aria-label="New thread" onClick={createThread} disabled={readOnlyRecovery}><Plus size={15} /></button>
            </div>
            {threads.filter((thread) => thread.scope === "unscoped" && thread.archivedAt === undefined).length === 0 ? <p className="empty-list">No threads</p> : threads.filter((thread) => thread.scope === "unscoped" && thread.archivedAt === undefined).map((thread) => (
              <button key={thread.id} className={`thread-row ${thread.id === activeThreadId ? "active" : ""}`} type="button" onClick={() => selectThread(thread.id)}>
                <MessageSquare size={14} /><span>{thread.title}</span>
              </button>
            ))}
          </section>
          <section>
            <div className="section-label"><Folder size={15} /><span>Projects</span><button className="section-action" type="button" title="Open project" aria-label="Open project" onClick={openProject} disabled={readOnlyRecovery}><Plus size={15} /></button></div>
            {projects.length === 0 ? <p className="empty-list">No projects</p> : projects.map((project) => <div className="project-group" key={project.id}>
              <div className="project-row"><span title={project.path}>{project.displayName}</span><button className="section-action" type="button" title="New project thread" aria-label={`New thread in ${project.displayName}`} onClick={() => createProjectThread(project.id)} disabled={readOnlyRecovery}><Plus size={14} /></button></div>
              {threads.filter((thread) => thread.scope === "project" && thread.projectId === project.id && thread.archivedAt === undefined).map((thread) => <button key={thread.id} className={`thread-row project-thread ${thread.id === activeThreadId ? "active" : ""}`} type="button" onClick={() => selectThread(thread.id)}><MessageSquare size={14} /><span>{thread.title}</span></button>)}
            </div>)}
          </section>
          {threads.some((thread) => thread.archivedAt !== undefined) && <section><div className="section-label"><Archive size={15} /><span>Archived</span></div>{threads.filter((thread) => thread.archivedAt !== undefined).map((thread) => <div className="archived-thread-row" key={thread.id}><button className={`thread-row ${thread.id === activeThreadId ? "active" : ""}`} type="button" onClick={() => selectThread(thread.id)}><MessageSquare size={14} /><span>{thread.title}</span></button><button className="section-action" type="button" title="Restore thread" aria-label={`Restore ${thread.title}`} onClick={() => void invoke(createCommand({ command: "thread.archive.set", payload: { threadId: thread.id, archived: false } }))}><Archive size={13} /></button></div>)}</section>}
        </nav>
        <button className={`settings-button ${view === "settings" ? "active" : ""}`} type="button" onClick={() => setView(view === "settings" ? "workspace" : "settings")}>
          <Settings size={17} /><span>Settings</span>
        </button>
      </aside>

      <main className={`center-pane ${readOnlyRecovery ? "recovery" : ""}`}>
        <RecoveryBanner bootstrap={bootstrap} />
        <DiagnosticBanner event={diagnostic} />
        {!dreamNoticeDismissed && (dreamDueProposal !== null || pendingDreamReminder !== null) && <div className="dream-notice" role="status"><Moon size={17} /><div><strong>{pendingDreamReminder?.kind === "resumable_run" ? "Dream run can resume" : pendingDreamReminder?.kind === "carryover" ? "Dream has unresolved carryover" : "Dream review is due"}</strong><span>{pendingDreamReminder !== null ? `${pendingDreamReminder.affectedScopeCount} scope(s) · oldest ${new Date(pendingDreamReminder.oldestUnresolvedAt).toLocaleDateString()}` : `${dreamDueProposal?.candidateCount ?? 0} captured candidate(s) · ${dreamDueProposal?.eligibleSessionCount ?? 0} eligible exchange(s)`}</span></div><div>{pendingDreamReminder?.kind === "resumable_run" && pendingDreamReminder.batchId !== undefined ? <button className="primary-button" type="button" onClick={() => void invoke(createCommand({ command: "dream.resume", payload: { batchId: pendingDreamReminder.batchId! } }))}>Resume</button> : <button className="primary-button" type="button" onClick={openDreamLaunch}>Review</button>}<button type="button" onClick={deferDreamNotice}>Tomorrow</button><button type="button" onClick={() => setDreamNoticeDismissed(true)}>Dismiss</button></div></div>}
        {view === "settings" ? (
          <SettingsView bootstrap={bootstrap} profiles={profiles} taskAssignments={taskAssignments} projects={projects} materialsByProject={materialsByProject} skillPackages={skillPackages} skillsRoot={skillsRoot} lastSkillReport={lastSkillReport} integrationState={integrationState} subAgentProjections={subAgentProjections} activeThreadId={activeThreadId} activeThread={activeThread} activeProfile={activeProfile} integrationContext={integrationContext} promptRevisions={promptRevisions} activePromptRevisionId={activePromptRevisionId} formOpen={profileFormOpen} setFormOpen={setProfileFormOpen} invoke={invoke} readOnly={readOnlyRecovery} recoveryExport={recoveryExport} personalCognitionNotice={personalCognitionNotice} learningTelemetry={learningTelemetry} longTermMemoryDocument={longTermMemoryDocument} longTermMemoryDraft={longTermMemoryDraft} preparedMemoryPatch={preparedMemoryPatch} memoryMaintenance={memoryMaintenance} dreamState={dreamState} openDreamLaunch={openDreamLaunch} onLongTermMemoryChange={(content) => { longTermMemoryDirty.current = true; setLongTermMemoryDraft(content); }} onLongTermMemoryRefresh={() => { longTermMemoryDirty.current = false; void invoke(createCommand({ command: "long_term_memory.refresh" })); }} />
        ) : activeThread === undefined ? (
          <div className="empty-workspace" data-testid="empty-workspace"><div className="empty-icon"><MessageSquare size={22} /></div><h1>No active thread</h1><p>Create or select a thread from the navigation.</p></div>
        ) : (
          <section className="conversation" aria-label="Conversation">
            <header className="conversation-header"><div><span className="eyebrow">{activeThread.scope === "project" ? projects.find((project) => project.id === activeThread.projectId)?.displayName ?? "Project Thread" : "Unscoped Thread"}</span><h1>{activeThread.title}</h1></div><div className="conversation-header-actions"><span className="header-model">{activeReflection === undefined ? activeProfile === undefined ? "No profile" : `${activeProfile.provider} / ${activeProfile.model}` : activeReflectionProfile === undefined ? reflectionStatusLabel(activeReflection.status) : `${activeReflectionProfile.provider} / ${activeReflectionProfile.model}`}</span><button className="icon-button" type="button" title={activeThread.archivedAt === undefined ? "Archive thread" : "Restore thread"} aria-label={activeThread.archivedAt === undefined ? "Archive thread" : "Restore thread"} onClick={() => void invoke(createCommand({ command: "thread.archive.set", payload: { threadId: activeThread.id, archived: activeThread.archivedAt === undefined } }))} disabled={hasActiveTurn || readOnlyRecovery}><Archive size={15} /></button><button className="icon-button" type="button" title="Delete thread history" aria-label="Delete thread history" onClick={() => setDeleteHistoryThreadId(activeThread.id)} disabled={hasActiveTurn || readOnlyRecovery}><Trash2 size={15} /></button></div></header>
            <div className="message-list">
              {activeReflection !== undefined && <ReflectionWorkspace run={activeReflection} outputLocation={activeThread.scope === "unscoped" ? activeThread.outputLocation : undefined} outcomes={reflectionOutcomes[activeReflection.id] ?? { judgments: [], learningProposals: [] }} profiles={profiles} taskAssignments={taskAssignments} start={startOrRetryReflection} startMemoryAware={startMemoryAwareReflection} stop={() => void invoke(createCommand({ command: "reflection.independent.stop", payload: { runId: activeReflection.id } }))} discard={() => void invoke(createCommand({ command: "reflection.discard", payload: { runId: activeReflection.id } }))} configure={() => setView("settings")} chooseOutput={chooseOutputLocation} prepareOutcomes={() => submit("Prepare a Judgment Record and one de-identified Long-term Learning Proposal from this Reflection.")} confirmJudgment={(draftId) => void invoke(createCommand({ command: "reflection.judgment.confirm", payload: { draftId } }))} discardOutcome={(draftId) => void invoke(createCommand({ command: "reflection.outcome.discard", payload: { draftId } }))} prepareLearningPatch={(proposalId, judgmentDraftId) => void invoke(createCommand({ command: "reflection.learning.prepare_patch", payload: { proposalId, judgmentDraftId } }))} />}
              {items.length === 0 ? activeReflection === undefined && <div className="thread-empty"><MessageSquare size={20} /><span>Ready for a new conversation</span></div> : items.map((item) => (
                <MessageItem key={item.id} item={item} configure={() => setView("settings")} chooseOutput={chooseOutputLocation} retry={(text, turnId) => submit(text, turnId)} continueInterrupted={() => setPrompt("Continue from the interrupted response.")} />
              ))}
              {Object.values(memoryCandidates).filter((candidate) => candidate.threadId === activeThreadId && candidate.status === "active").map((candidate) => <div className="memory-candidate" key={candidate.id}><div><strong>Memory candidate captured</strong><span>{candidate.sourceSnippet}</span></div><div>{candidate.scope === "project" && <button type="button" onClick={() => reviewCandidate(candidate)}>Review</button>}<button type="button" onClick={() => void invoke(createCommand({ command: "memory.candidate.dismiss", payload: { candidateId: candidate.id } }))}>Dismiss</button></div></div>)}
              {Object.values(confirmations).filter((item) => item.payload.threadId === activeThreadId).map((item) => <div className="action-proposal" role="dialog" aria-label="Capability confirmation" key={item.payload.requestId}>
                <strong>{item.payload.action}</strong><p>{item.payload.target}</p><span>{item.payload.reason} {item.payload.expectedEffect}</span><div><button type="button" onClick={() => resolveConfirmation(item.payload.requestId, true)}>Approve</button><button type="button" onClick={() => resolveConfirmation(item.payload.requestId, false)}>Deny</button></div>
              </div>)}
              {profileChange && <div className="profile-change" role="dialog" aria-label="Cross-Provider continuation">
                <strong>Change Provider for this conversation?</strong>
                <p>{profileChange.payload.currentProfile.provider} / {profileChange.payload.currentProfile.model} to {profileChange.payload.requestedProfile.provider} / {profileChange.payload.requestedProfile.model}</p>
                <span>Continuing retains the visible Thread trajectory. Starting a new Thread retains no conversation context.</span>
                <div><button type="button" onClick={() => resolveProfileChange("continue_current_thread")}>Continue current thread</button><button type="button" onClick={() => resolveProfileChange("start_new_thread")}>Start new thread</button><button type="button" onClick={() => setProfileChange(null)}>Cancel</button></div>
              </div>}
            </div>
          </section>
        )}

        {view === "workspace" && projectCollision && <div className="workspace-dialog" role="dialog" aria-label="Project identity collision">
          <strong>Project Identity Collision</strong><p>{projectCollision.payload.selectedPath}</p><span>This identity is already registered at {projectCollision.payload.existingPath}. Classify the folder explicitly.</span><div><button type="button" onClick={() => resolveProjectCollision("moved_project")}>Moved Project</button><button type="button" onClick={() => resolveProjectCollision("project_copy")}>Project Copy</button><button type="button" onClick={() => setProjectCollision(null)}>Cancel</button></div>
        </div>}
        {view === "workspace" && parseRefreshChoice && <div className="workspace-dialog" role="dialog" aria-label="Parse refresh choice">
          <strong>Material changed</strong><p>{parseRefreshChoice.payload.material.relativePath}</p><span>Previous {parseRefreshChoice.payload.previousSourceHash.slice(0, 12)} · Current {parseRefreshChoice.payload.currentSourceHash.slice(0, 12)} · {parseRefreshChoice.payload.parserId}</span><div><button className="primary-button" type="button" onClick={() => resolveParseRefresh("create_new_version")}>Create New Parse Version</button><button type="button" onClick={() => resolveParseRefresh("replace_previous")}>Replace Previous Parse</button><button type="button" onClick={() => resolveParseRefresh("cancel")}>Cancel</button></div>
        </div>}
        {view === "workspace" && candidateDraft && <div className="workspace-dialog memory-draft-dialog" role="dialog" aria-label="Project Memory draft"><strong>Confirm Project Memory</strong><span>This appends a user-confirmed judgment, not source evidence.</span><label>Title<input aria-label="Memory title" value={candidateDraft.title} onChange={(event) => setCandidateDraft({ ...candidateDraft, title: event.target.value })} /></label><label>Tags<input aria-label="Memory tags" value={candidateDraft.tags} onChange={(event) => setCandidateDraft({ ...candidateDraft, tags: event.target.value })} placeholder="risk, diligence" /></label><label>Judgment<textarea aria-label="Memory judgment" value={candidateDraft.body} onChange={(event) => setCandidateDraft({ ...candidateDraft, body: event.target.value })} /></label><div><button className="primary-button" type="button" onClick={confirmCandidate} disabled={candidateDraft.title.trim() === "" || candidateDraft.body.trim() === "" || candidateDraft.candidate.projectId === undefined || memoryDocuments[candidateDraft.candidate.projectId] === undefined}>Confirm append</button><button type="button" onClick={() => setCandidateDraft(null)}>Cancel</button></div></div>}
        {view === "workspace" && reflectionLaunch && <div className="workspace-dialog reflection-launch" role="dialog" aria-label="Start Investment Reflection"><strong>Start Investment Reflection</strong><span>{reflectionLaunch.scope === "project" ? "The first pass is isolated from Project Memory and Long-term Memory." : "The first pass uses only frozen User inputs and public evidence. It cannot access Project State or Memory."}</span><label>Optional focus<textarea aria-label="Reflection focus" value={reflectionLaunch.focus} onChange={(event) => setReflectionLaunch({ ...reflectionLaunch, focus: event.target.value })} placeholder={reflectionLaunch.scope === "project" ? "Review this Project broadly" : "Review this investment question broadly"} /></label><label>Independent Evidence Profile<select aria-label="Reflection Model Profile" value={reflectionLaunch.profileId} onChange={(event) => setReflectionLaunch({ ...reflectionLaunch, profileId: event.target.value })}><option value="">Not assigned</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><div className="form-actions"><button type="button" onClick={() => setReflectionLaunch(null)}>Cancel</button><button className="primary-button" type="button" onClick={() => void launchReflection()}>Start Reflection</button></div></div>}
        {dreamLaunchProfileId !== null && <div className="workspace-dialog dream-launch" role="dialog" aria-label="Start Dream"><strong>Start Dream</strong><span>This creates one frozen cross-project review batch. It does not authorize any Memory write.</span><label>Dream Model Profile<select aria-label="Dream Model Profile" value={dreamLaunchProfileId} onChange={(event) => setDreamLaunchProfileId(event.target.value)}><option value="">Not assigned</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><div className="form-actions"><button type="button" onClick={() => setDreamLaunchProfileId(null)}>Cancel</button><button className="primary-button" type="button" onClick={() => void launchDream()} disabled={dreamLaunchProfileId === ""}>Create Dream Batch</button></div></div>}
        {deleteHistoryThreadId !== null && <div className="workspace-dialog" role="dialog" aria-label="Delete thread history"><strong>Delete thread history?</strong><span>This removes the retained conversation and physical context. Unapproved candidate and Dream source text from this task will also be removed. Confirmed Memory and Outputs remain.</span><div className="form-actions"><button type="button" onClick={() => setDeleteHistoryThreadId(null)}>Cancel</button><button className="danger-button" type="button" onClick={() => void deleteThreadHistory()}>Delete history</button></div></div>}
        {view === "workspace" && preparedMemoryPatch && <div className="workspace-dialog reflection-memory-patch" role="dialog" aria-label="Reflection Memory patch preview"><strong>Confirm Long-term Memory change</strong><span>This is a separate confirmation after the Judgment Record. Review the lineage and file diffs before committing.</span><p>{preparedMemoryPatch.rationale}</p><pre>{preparedMemoryPatch.lineageDiff}</pre>{preparedMemoryPatch.files.map((file) => <details key={file.kind} open={file.changed}><summary>{file.kind.replaceAll("_", " ")} · {file.changed ? "changed" : "unchanged"}</summary><span title={file.path}>{file.path}</span><pre>{file.diff}</pre></details>)}<div className="form-actions"><button type="button" onClick={() => void invoke(createCommand({ command: "long_term_memory.patch.discard", payload: { patchId: preparedMemoryPatch.id } }))}>Discard</button><button className="primary-button" type="button" onClick={() => void invoke(createCommand({ command: "long_term_memory.patch.commit", payload: { patchId: preparedMemoryPatch.id, confirmed: true } }))}>Confirm Memory change</button></div></div>}

        {view === "workspace" && activeThread !== undefined && (activeReflection === undefined || activeReflection.status === "dialogue_active") && (
          <form className="composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            {executionQueue.filter((item) => item.threadId === activeThread.id).length > 0 && <div className="execution-queue" aria-label="Execution Queue">
              <div className="execution-queue-heading"><strong>Execution Queue</strong><span>{executionCapacity.running} / {executionCapacity.capacity} running</span></div>
              {executionQueue.filter((item) => item.threadId === activeThread.id).map((item, index, items) => <div className="execution-queue-item" key={item.id}>
                <textarea aria-label={`Queued message ${index + 1}`} value={item.text} onChange={(event) => setExecutionQueue((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, text: event.target.value } : candidate))} onBlur={() => item.text.trim() && void invoke(createCommand({ command: "execution_queue.update", payload: { itemId: item.id, text: item.text.trim() } }))} disabled={readOnlyRecovery} />
                <div><span>{item.status === "draft" ? "Unsent draft" : item.reason === "thread_active" ? "Waiting for this task" : "Waiting for capacity"} · {activeThread.scope} · {profiles.find((profile) => profile.id === item.requestedProfileId)?.name ?? "No profile"} · {new Date(item.submittedAt).toLocaleTimeString()}</span>{index > 0 && <button type="button" onClick={() => void invoke(createCommand({ command: "execution_queue.reorder", payload: { itemId: item.id, beforeItemId: items[index - 1]!.id } }))}>Up</button>}{item.status === "draft" && <button type="button" onClick={() => void invoke(createCommand({ command: "execution_queue.activate", payload: { itemId: item.id } }))}>Send</button>}<button type="button" onClick={() => void invoke(createCommand({ command: "execution_queue.cancel", payload: { itemId: item.id } }))}>Cancel</button></div>
              </div>)}
            </div>}
            <textarea aria-label="Message" placeholder={readOnlyRecovery ? "Read-only Recovery" : hasActiveTurn ? "Queue a follow-up" : "Ask vc-agent"} value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={readOnlyRecovery} />
            <div className="composer-footer">
              <select aria-label="Active Model Profile" value={activeThread.activeProfileId ?? ""} onChange={(event) => selectProfile(event.target.value)} disabled={activeReflection !== undefined || hasActiveTurn || profiles.length === 0 || readOnlyRecovery}>
                <option value="">No profile</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
              <span className="output-location" title={activeThread.scope === "unscoped" ? activeThread.outputLocation : projects.find((project) => project.id === activeThread.projectId)?.path}>{activeThread.scope === "unscoped" ? activeThread.outputLocation ?? "No output location" : "Project scoped"}</span>
              {bootstrap?.accessMode === "full" && <span className="full-access-indicator">Full access</span>}
              <button className="compact-thread-button" type="button" title="Compact thread" aria-label="Compact thread" onClick={compact} disabled={activeReflection !== undefined || hasActiveTurn || activeProfile === undefined || items.length === 0 || readOnlyRecovery}><Minimize2 size={15} /></button>
              {hasActiveTurn && <button className="send-button" type="submit" title="Queue follow-up" aria-label="Queue follow-up" disabled={prompt.trim().length === 0 || readOnlyRecovery}><Send size={16} /></button>}
              {hasActiveTurn ? <button className="stop-button" type="button" title="Stop" aria-label="Stop" onClick={stop}><CircleStop size={16} /></button> : <button className="send-button" type="submit" title="Send" aria-label="Send" disabled={prompt.trim().length === 0 || readOnlyRecovery}><Send size={16} /></button>}
            </div>
          </form>
        )}
      </main>

      <aside className="right-panel" aria-label="Project state">
        <div className="panel-tabs" role="tablist" aria-label="Project state views"><button type="button" className={projectPanelTab === "overview" ? "active" : ""} role="tab" aria-selected={projectPanelTab === "overview"} onClick={() => setProjectPanelTab("overview")}>Overview</button><button type="button" className={projectPanelTab === "outputs" ? "active" : ""} role="tab" aria-selected={projectPanelTab === "outputs"} disabled={activeThread?.scope !== "project"} onClick={openProjectOutputs}>Outputs</button><button type="button" className={projectPanelTab === "context" ? "active" : ""} role="tab" aria-selected={projectPanelTab === "context"} disabled={activeThread?.scope !== "project" || readOnlyRecovery} onClick={openProjectContext}>Context</button><button type="button" className={projectPanelTab === "memory" ? "active" : ""} role="tab" aria-selected={projectPanelTab === "memory"} disabled={activeThread?.scope !== "project" || readOnlyRecovery} onClick={openProjectMemory}>Memory</button></div>
        {activeThread?.scope === "project" ? projectPanelTab === "outputs" ? <ProjectOutputsPanel outputs={outputsByProject[activeThread.projectId] ?? []} open={(artifactId) => void invoke(createCommand({ command: "project.output.open", payload: { projectId: activeThread.projectId, artifactId } }))} /> : projectPanelTab === "memory" ? <ProjectMemoryPanel document={memoryDocuments[activeThread.projectId]} draft={memoryDrafts[activeThread.projectId]} onChange={(content) => { memoryDirty.current[activeThread.projectId] = true; setMemoryDrafts((current) => ({ ...current, [activeThread.projectId]: content })); }} onReload={reloadProjectMemory} onSave={saveProjectMemory} /> : projectPanelTab === "context" ? <ProjectContextPanel
          document={contextDocuments[activeThread.projectId]}
          draft={contextDrafts[activeThread.projectId]}
          onChange={(content) => { contextDirty.current[activeThread.projectId] = true; setContextDrafts((current) => ({ ...current, [activeThread.projectId]: content })); }}
          onReload={reloadProjectContext}
          onSave={saveProjectContext}
        /> : <div className="material-inventory"><div className="inventory-heading"><h2>{projects.find((project) => project.id === activeThread.projectId)?.displayName ?? "Project"}</h2><div className="inventory-actions"><button className="compact-button" type="button" onClick={() => openReflectionLaunch(activeThread.projectId)} disabled={readOnlyRecovery}><ClipboardCheck size={14} /> Reflection</button><button className="section-action" type="button" title="Refresh materials" aria-label="Refresh materials" onClick={() => void invoke(createCommand({ command: "project.material.refresh", payload: { projectId: activeThread.projectId } }))}><RefreshCw size={14} /></button></div></div><p>Material metadata only. Content loads on demand.</p>{(materialsByProject[activeThread.projectId] ?? []).filter((material) => material.availability === "active").length === 0 ? <span className="empty-list">No supported materials</span> : (materialsByProject[activeThread.projectId] ?? []).filter((material) => material.availability === "active").map((material) => <div className="material-row" key={material.id}><div><strong title={material.relativePath}>{material.relativePath}</strong><span>{material.extension} · {formatBytes(material.size)} · {material.parseStatus}</span>{materialParseState[material.id] && <span className="parse-result">{materialParseState[material.id]}</span>}</div>{material.parseStatus === "stale" ? <button type="button" onClick={() => void invoke(createCommand({ command: "material.need", payload: { materialId: material.id } }))}>Refresh parse</button> : material.parseStatus === "unparsed" ? <button type="button" onClick={() => void invoke(createCommand({ command: "material.parse.request", payload: { materialId: material.id } }))}>Parse</button> : null}</div>)}</div> : <div className="panel-empty"><PanelRight size={20} /><h2>Unscoped task</h2><p>This task has no Project State.</p>{activeThread !== undefined && activeReflection === undefined && <button className="compact-button" type="button" onClick={() => openUnscopedReflectionLaunch(activeThread.id)} disabled={readOnlyRecovery}><ClipboardCheck size={14} /> Reflection</button>}</div>}
        <div className="status-strip"><span><span className="status-dot" /> {readOnlyRecovery ? "Recovery" : "Host ready"}</span><span>Schema {bootstrap?.stateSchemaVersion ?? "-"}</span></div>
      </aside>
    </div>
  );
}

function ReflectionWorkspace({ run, outputLocation, outcomes, profiles, taskAssignments, start, startMemoryAware, stop, discard, configure, chooseOutput, prepareOutcomes, confirmJudgment, discardOutcome, prepareLearningPatch }: { run: ReflectionRun; outputLocation?: string | undefined; outcomes: { judgments: JudgmentRecordDraft[]; learningProposals: LongTermLearningProposal[] }; profiles: ModelProfile[]; taskAssignments: TaskModelAssignment[]; start(run: ReflectionRun, profileId?: string): void; startMemoryAware(run: ReflectionRun, profileId?: string): void; stop(): void; discard(): void; configure(): void; chooseOutput(): void; prepareOutcomes(): void; confirmJudgment(draftId: string): void; discardOutcome(draftId: string): void; prepareLearningPatch(proposalId: string, judgmentDraftId: string): void }) {
  const evidenceStage = ["awaiting_profile", "ready", "independent_running", "independent_failed", "independent_interrupted"].includes(run.status);
  const assignedMemoryProfile = taskAssignments.find((item) => item.taskType === "memory_aware_reflection")?.profileId;
  const [profileId, setProfileId] = useState(evidenceStage ? run.independentProfileId ?? "" : run.memoryAwareProfileId ?? assignedMemoryProfile ?? "");
  useEffect(() => setProfileId(evidenceStage ? run.independentProfileId ?? "" : run.memoryAwareProfileId ?? assignedMemoryProfile ?? ""), [run.id, run.independentProfileId, run.memoryAwareProfileId, assignedMemoryProfile, evidenceStage]);
  const assessment = run.assessment;
  const confirmedJudgment = [...outcomes.judgments].reverse().find((draft) => draft.status === "confirmed");
  return <article className="reflection-workspace" data-testid="reflection-workspace">
    <div className="reflection-summary"><div><span className={`reflection-status ${run.status}`}>{reflectionStatusLabel(run.status)}</span><h2>{run.framing === "retrospective" ? "Investment Retrospective" : "Investment Reflection"}</h2><p>{run.objective}</p>{run.focus && <p><strong>Focus:</strong> {run.focus}</p>}</div><dl><div><dt>Brief</dt><dd>{run.brief.scope === "project" ? `${run.brief.materialCards.length} materials` : `${run.brief.userInputs.length} inputs`} · {run.brief.recordReferences.length} records</dd></div><div><dt>Prompt</dt><dd>{run.promptSnapshot.hash.slice(0, 12)}</dd></div><div><dt>Frozen</dt><dd>{new Date(run.createdAt).toLocaleString()}</dd></div></dl></div>
    {assessment !== undefined && <section className="assessment"><h3>Independent Assessment</h3><p className="assessment-conclusion">{assessment.conclusion}</p><AssessmentList title="Rationale" items={assessment.rationale} /><AssessmentList title="Uncertainties" items={assessment.uncertainties} /><AssessmentList title="Counterarguments" items={assessment.counterarguments} /><AssessmentList title="Decision-changing questions" items={assessment.decisionChangingQuestions} />{assessment.evidenceReferences.length > 0 && <div><h4>Evidence references</h4>{assessment.evidenceReferences.map((reference) => <p className="evidence-reference" key={`${reference.referenceId}-${reference.claim}`}><strong>{reference.support}</strong> {reference.claim}<span>{reference.referenceId}</span></p>)}</div>}</section>}
    {run.failure !== undefined && <div className="reflection-failure" role="alert"><strong>{run.failure.code}</strong><p>{run.failure.message}</p>{run.failure.requestId && <span>Request {run.failure.requestId}</span>}</div>}
    {outcomes.judgments.map((draft) => <section className="reflection-outcome" data-testid="judgment-record-draft" key={draft.id}><div><span>{draft.status === "draft" ? "Draft · not authoritative" : draft.status === "stale" ? "Stale · review again" : draft.status}</span><h3>Judgment Record</h3></div><p>{draft.view}</p><dl><div><dt>Decision</dt><dd>{draft.decisionState}</dd></div><div><dt>Sources</dt><dd>{draft.sourceAvailability}</dd></div></dl>{draft.status === "stale" && <p className="outcome-stale-reason">{staleOutcomeSummary(draft.staleReasons)}</p>}{["draft", "stale"].includes(draft.status) && run.status === "dialogue_active" && <div className="form-actions"><button type="button" onClick={() => discardOutcome(draft.id)}>Discard</button>{draft.status === "draft" && (run.scope === "unscoped" && outputLocation === undefined ? <button className="primary-button" type="button" onClick={chooseOutput}>Choose Output Location</button> : <button className="primary-button" type="button" onClick={() => confirmJudgment(draft.id)}>Confirm Judgment Record</button>)}</div>}</section>)}
    {outcomes.learningProposals.map((proposal) => <section className="reflection-outcome learning-proposal" data-testid="learning-proposal-draft" key={proposal.id}><div><span>{proposal.status === "draft" ? "Draft · not in Memory" : proposal.status === "stale" ? "Stale · review again" : proposal.status.replace("_", " ")}</span><h3>Long-term Learning Proposal</h3></div><strong>{proposal.proposed.title}</strong><p>{proposal.proposed.content}</p><p>{proposal.comparisonSummary}</p>{proposal.status === "stale" && <p className="outcome-stale-reason">{staleOutcomeSummary(proposal.staleReasons)}</p>}{["draft", "stale"].includes(proposal.status) && run.status === "dialogue_active" && <div className="form-actions"><button type="button" onClick={() => discardOutcome(proposal.id)}>Discard</button>{proposal.status === "draft" && <button className="primary-button" type="button" disabled={confirmedJudgment === undefined} onClick={() => confirmedJudgment && prepareLearningPatch(proposal.id, confirmedJudgment.id)}>Preview Memory Patch</button>}</div>}</section>)}
    {run.status !== "dialogue_active" && run.status !== "discarded" && <div className="reflection-controls"><select aria-label={evidenceStage ? "Independent Evidence Profile" : "Memory-Aware Reflection Profile"} value={profileId} onChange={(event) => setProfileId(event.target.value)} disabled={run.status === "independent_running" || run.status === "memory_aware_running"}><option value="">Not assigned</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select>{profiles.length === 0 ? <button type="button" onClick={configure}>Configure profiles</button> : run.status === "independent_running" ? <button type="button" onClick={stop}>Stop</button> : evidenceStage ? <button className="primary-button" type="button" onClick={() => start(run, profileId)} disabled={profileId === ""}>{run.status === "ready" || run.status === "awaiting_profile" ? "Start evidence pass" : "Retry evidence pass"}</button> : run.status === "memory_aware_running" ? <span>Starting dialogue...</span> : <><button type="button" onClick={discard}>Discard</button><button className="primary-button" type="button" onClick={() => startMemoryAware(run, profileId)} disabled={profileId === ""}>{run.status === "independent_completed" ? "Start critical dialogue" : "Retry critical dialogue"}</button></>}</div>}
    {run.status === "dialogue_active" && <div className="reflection-dialogue-boundary"><span>Memory recalls and evidence drilldowns remain visible in this task.</span><div><button type="button" onClick={prepareOutcomes} disabled={outcomes.judgments.some((draft) => draft.status === "draft") || outcomes.learningProposals.some((draft) => draft.status === "draft")}>Prepare outcomes</button><button type="button" onClick={discard}>Discard Reflection</button></div></div>}
  </article>;
}

function AssessmentList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return <div><h4>{title}</h4><ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul></div>;
}

function staleOutcomeSummary(reasons: Array<{ dependency: { kind: string; targetId: string }; reason: string }>): string {
  if (reasons.length === 0) return "A relevant source changed. Continue the Reflection before preparing a replacement.";
  const kinds = [...new Set(reasons.map((item) => item.dependency.kind.replaceAll("_", " ")))];
  return `Relevant ${kinds.join(" and ")} ${reasons.some((item) => item.reason === "changed") ? "changed" : "became unavailable"}. Continue the Reflection before preparing a replacement.`;
}

function SkillsSettings({ packages, root, lastReport, invoke }: {
  packages: SkillInventoryItem[];
  root: string | null;
  lastReport: SkillCompatibilityReport | null;
  invoke(command: HostCommand): Promise<unknown>;
}) {
  return <div className="settings-section skills-settings" data-testid="skills-settings">
    <div className="settings-section-header"><div><h2>Skills Directory</h2><p>Complete packages are copied into an app-owned directory and remain disabled until explicit activation.</p></div><button className="compact-button" type="button" onClick={() => void invoke(createCommand({ command: "skills.import" }))}>Import Skill</button></div>
    <dl><div><dt>Location</dt><dd title={root ?? undefined}>{root ?? "Not initialized"}</dd></div><div><dt>Packages</dt><dd>{packages.length}</dd></div><div><dt>Active</dt><dd>{packages.filter((item) => item.enabled && item.state === "active").length}</dd></div></dl>
    {packages.length === 0 ? <p className="empty-setting">No imported Skill packages</p> : <div className="profile-list">{packages.map((item) => <div className="profile-row" key={item.revisionId}>
      <div><strong>{item.metadata.name ?? item.packageId}</strong><span>{item.packageId} · {item.compatibility} · {item.state}</span><span>{item.declaredDependencies.length === 0 ? "No declared dependencies" : item.declaredDependencies.join(", ")}</span>{item.findings.length > 0 && <span role="status">{item.findings.length} diagnostic(s)</span>}</div>
      <div className="form-actions"><button type="button" onClick={() => void invoke(createCommand({ command: "skills.inspect", payload: { revisionId: item.revisionId } }))}>Inspect</button>{item.enabled ? <button type="button" onClick={() => void invoke(createCommand({ command: "skills.disable", payload: { packageId: item.packageId } }))}>Disable</button> : <button className="primary-button" type="button" onClick={() => void invoke(createCommand({ command: "skills.activate", payload: { revisionId: item.revisionId } }))} disabled={item.compatibility !== "compatible" || !["awaiting_activation", "disabled", "invalidated"].includes(item.state)}>Activate</button>}</div>
    </div>)}</div>}
    {lastReport !== null && <details className="skill-report" open><summary>Latest compatibility report · {lastReport.status}</summary><span>{lastReport.files.length} file(s) · {lastReport.missingReferences.length} missing reference(s) · {lastReport.undeclaredExecutables.length} undeclared executable(s)</span>{lastReport.findings.map((finding, index) => <p key={`${finding.code}-${index}`}><strong>{finding.severity}</strong> {finding.message}</p>)}</details>}
  </div>;
}

function DelegationSettings({ projections, activeThread, activeProfile, invoke, readOnly }: { projections: Record<string, SubAgentProjection>; activeThread: Thread | undefined; activeProfile: ModelProfile | undefined; invoke(command: HostCommand): Promise<unknown>; readOnly: boolean }) {
  const [objective, setObjective] = useState("Find independent evidence for the current bounded question.");
  const [role, setRole] = useState<"researcher" | "critic" | "synthesizer" | "writer">("researcher");
  const runs = Object.values(projections).sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
  const authorize = () => {
    const parentThread = activeThread;
    const profile = activeProfile;
    if (parentThread === undefined || profile === undefined) return;
    const parentThreadId = parentThread.id;
    void invoke(createCommand({ command: "sub_agent.run.authorize", payload: {
      parentThreadId, parentTurnId: crypto.randomUUID(),
      explicitIntentEvidence: { source: "user", text: "I explicitly authorize a bounded Sub-Agent task for this current task.", confirmed: true, taskLifetime: "current_task" },
      taskLimit: 4, sharedTokenBudget: 2_000,
      tasks: [{ role, objective: objective.trim(), contextBoundary: { scope: parentThread.scope, ...(parentThread.scope === "project" ? { projectId: parentThread.projectId } : {}), sourceReferenceIds: [], maxChars: 5_000 }, capabilitySet: role === "writer" ? ["read_context", "write_output"] : ["read_context"] }]
    } }));
  };
  return <div className="settings-section delegation-settings" data-testid="delegation-settings">
    <div className="settings-section-header"><div><span className="eyebrow">D1 explicit runtime</span><h2>Sub-Agent Delegation</h2><p>Only this confirmed User action creates a flat, bounded, auditable child task. Ordinary Turns never create hidden children.</p></div><button className="compact-button" type="button" onClick={() => void invoke(createCommand({ command: "sub_agent.run.list" }))}>Refresh runs</button></div>
    <div className="delegation-form"><label>Role<select value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="researcher">Researcher</option><option value="critic">Critic</option><option value="synthesizer">Synthesizer</option><option value="writer">Writer</option></select></label><label>Bounded objective<textarea value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={20_000} /></label>{activeThread === undefined && <span className="delegation-help">Select a parent Thread before authorizing delegation.</span>}{activeThread !== undefined && activeProfile === undefined && <span className="delegation-help">Select an Active Model Profile before authorizing delegation.</span>}{activeThread !== undefined && <span className="delegation-help">Scope: {activeThread.scope}{activeThread.scope === "project" ? ` · ${activeThread.projectId}` : ""} · Profile: {activeProfile?.name ?? "not selected"}</span>}<button className="primary-button" type="button" disabled={readOnly || activeThread === undefined || activeProfile === undefined || !objective.trim()} onClick={authorize}>Authorize current-task delegation</button></div>
    {runs.length === 0 ? <p className="empty-setting">No explicit Sub-Agent runs.</p> : runs.map((projection) => <div className="delegation-run" key={projection.run.id}><header><div><strong>{projection.run.status}</strong><span>{projection.run.id.slice(0, 8)} · parent {projection.run.parentThreadId}</span></div><div className="form-actions">{!readOnly && ["authorized", "queued", "running"].includes(projection.run.status) && <button type="button" onClick={() => void invoke(createCommand({ command: "sub_agent.run.stop", payload: { runId: projection.run.id } }))}>Stop run</button>}{!readOnly && <button type="button" onClick={() => void invoke(createCommand({ command: "sub_agent.record.delete", payload: { runId: projection.run.id, confirmed: true } }))}>Delete record</button>}</div></header><span>Budget {projection.run.usage.totalTokens}{projection.run.sharedTokenBudget === undefined ? "" : ` / ${projection.run.sharedTokenBudget}`} tokens · {projection.tasks.length} task(s)</span>{projection.tasks.map((task) => <div className="delegation-task" key={task.id}><div><strong>{task.role}</strong><span>{task.status} · {task.resolvedProfile.provider}/{task.resolvedProfile.model}</span><span title={task.objective}>{task.objective}</span><small>{task.capabilitySet.join(", ")} · {task.usage.totalTokens} tokens</small></div><div className="form-actions">{!readOnly && ["failed", "interrupted", "stopped"].includes(task.status) && <button type="button" onClick={() => void invoke(createCommand({ command: "sub_agent.task.retry", payload: { taskId: task.id } }))}>Retry</button>}{!readOnly && ["created", "queued", "failed", "interrupted", "stopped"].includes(task.status) && <button type="button" onClick={() => void invoke(createCommand({ command: "sub_agent.task.skip", payload: { taskId: task.id } }))}>Skip</button>}{!readOnly && task.handoff !== undefined && task.handoff.reviewStatus === undefined && <><button type="button" onClick={() => void invoke(createCommand({ command: "sub_agent.handoff.adopt", payload: { taskId: task.id } }))}>Adopt handoff</button><button type="button" onClick={() => void invoke(createCommand({ command: "sub_agent.handoff.reject", payload: { taskId: task.id } }))}>Reject handoff</button></>}</div>{task.handoff !== undefined && <span role="status">Handoff {task.handoff.reviewStatus === "adopted" ? "adopted" : task.handoff.reviewStatus === "rejected" ? "rejected" : "awaiting parent adoption"} · {task.handoff.provenance.map((item) => item.referenceId).join(", ")}</span>}</div>)}</div>)}
  </div>;
}

function IntegrationsSettings({ state, invoke, readOnly, profiles, projects, materialsByProject, skillPackages, activeThread, activeProfile, integrationContext }: { state: IntegrationState | null; invoke(command: HostCommand): Promise<unknown>; readOnly: boolean; profiles: ModelProfile[]; projects: Project[]; materialsByProject: Record<string, MaterialInventoryItem[]>; skillPackages: SkillInventoryItem[]; activeThread: Thread | undefined; activeProfile: ModelProfile | undefined; integrationContext: IntegrationTaskContext }) {
  const project = activeThread?.scope === "project" ? projects.find((item) => item.id === activeThread.projectId) : undefined;
  const profile = activeProfile;
  const [mcpName, setMcpName] = useState("");
  const [officeSourcePath, setOfficeSourcePath] = useState("");
  const [officeKind, setOfficeKind] = useState<"create" | "edit" | "review">("create");
  const [officeFormat, setOfficeFormat] = useState<"docx" | "pptx" | "xlsx" | "pdf">("docx");
  const [officeOutputName, setOfficeOutputName] = useState("");
  const [officeSkillRevisionId, setOfficeSkillRevisionId] = useState("");
  const [officeReplacementConfirmations, setOfficeReplacementConfirmations] = useState<Record<string, boolean>>({});
  const [skillPackageId, setSkillPackageId] = useState("");
  const [skillOperation, setSkillOperation] = useState<"create" | "update">("create");
  const [skillTargetRevisionId, setSkillTargetRevisionId] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillObjective, setSkillObjective] = useState("");
  const [skillConstraints, setSkillConstraints] = useState("");
  const [skillDependencies, setSkillDependencies] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"stdio" | "http">("stdio");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpArguments, setMcpArguments] = useState("");
  const [mcpWorkingDirectory, setMcpWorkingDirectory] = useState("");
  const [mcpEndpoint, setMcpEndpoint] = useState("");
  const [mcpCredentialRef, setMcpCredentialRef] = useState("");
  const [mcpToolArguments, setMcpToolArguments] = useState("{}");
  const [mcpNotice, setMcpNotice] = useState<string | null>(null);
  const activeOfficeSkills = skillPackages.filter((item) => item.enabled && item.state === "active" && item.compatibility === "compatible");
  const activeSkill = activeOfficeSkills.find((item) => item.revisionId === officeSkillRevisionId);
  const officeSource = officeSourcePath;
  const officeNeedsSource = officeKind !== "create";
  const material = project === undefined ? undefined : materialsByProject[project.id]?.find((item) => item.mediaType === "application/pdf");
  const officeMissing = missingIntegrationContext(integrationContext, ["projectId", "threadId", "turnId", "profileId"]);
  const refresh = () => void invoke(createCommand({ command: "integration.state.load" }));
  const chooseOfficeSource = async () => {
    const result = await invoke(createCommand({ command: "office.source.choose", payload: { format: officeFormat } }));
    if (typeof result === "object" && result !== null && "event" in result && (result as { event?: unknown }).event === "office.source.selected") {
      const path = (result as { payload?: { path?: unknown } }).payload?.path;
      if (typeof path === "string") setOfficeSourcePath(path);
    }
  };
  const prepareOffice = () => {
    if (activeSkill === undefined || project === undefined || activeThread === undefined || profile === undefined || integrationContext.turnId === undefined || (officeNeedsSource && officeSource === "")) return;
    void invoke(createCommand({ command: "office.task.prepare", payload: {
      kind: officeKind,
      format: officeFormat,
      projectId: project.id,
      projectPath: project.path,
      threadId: activeThread.id,
      turnId: integrationContext.turnId,
      profile: { id: profile.id, provider: profile.provider, model: profile.model },
      skillRevisionId: activeSkill.revisionId,
      outputDirectory: `${project.path}/outputs`,
      ...(officeOutputName.trim() === "" ? {} : { outputFileName: officeOutputName.trim() }),
      ...(officeNeedsSource ? { sourcePath: officeSource, sourceReferences: ["settings:office-source"], renderPreview: true } : {}),
      explicitIntent: true
    } }));
  };
  const createDraft = () => {
    if (skillPackageId.trim() === "" || skillName.trim() === "" || skillDescription.trim() === "" || skillObjective.trim() === "" || (skillOperation === "update" && skillTargetRevisionId === "")) return;
    void invoke(createCommand({ command: "skill_creator.prepare", payload: { operation: skillOperation, explicitIntent: true, packageId: skillPackageId.trim(), ...(profile === undefined ? {} : { profileId: profile.id }), ...(skillOperation === "update" ? { targetRevisionId: skillTargetRevisionId } : {}), files: { "SKILL.md": `---\nname: ${skillName.trim()}\ndescription: ${skillDescription.trim()}\n---\n# ${skillName.trim()}\n\n## Objective\n${skillObjective.trim()}\n\n## Constraints\n${skillConstraints.trim() || "None specified."}\n`, "LICENSE": "User review required." }, ...(skillDependencies.trim() === "" ? {} : { dependencies: skillDependencies.split(",").map((item) => item.trim()).filter(Boolean) }) } }));
  };
  const runParse = () => { if (project === undefined || material === undefined) return; void invoke(createCommand({ command: "page_recovery.run", payload: { materialId: material.id, projectId: project.id, relativePath: material.relativePath, mediaType: material.mediaType, sourceHash: material.sourceHash } })); };
  const saveMcp = () => {
    const name = mcpName.trim();
    if (name === "") return;
    const args = mcpArguments.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
    void invoke(createCommand({ command: "mcp.server.save", payload: { serverId: crypto.randomUUID(), name, transport: mcpTransport, ...(mcpTransport === "stdio" && mcpCommand.trim() === "" ? {} : mcpTransport === "stdio" ? { command: mcpCommand.trim(), ...(args.length === 0 ? {} : { args }) } : {}), ...(mcpWorkingDirectory.trim() === "" ? {} : { workingDirectory: mcpWorkingDirectory.trim() }), ...(mcpTransport === "http" && mcpEndpoint.trim() === "" ? {} : mcpTransport === "http" ? { endpoint: mcpEndpoint.trim() } : {}), ...(mcpCredentialRef.trim() === "" ? {} : { credentialRef: mcpCredentialRef.trim() }), enabled: true, allowedScopes: ["project", "unscoped"] } }));
  };
  const runMcpTool = async (serverId: string, toolName: string, accessMode: "standard" | "full", confirmed?: boolean) => {
    const activation = state?.mcp.activeActivation;
    if (activation === undefined || activation.serverId !== serverId) return;
    if (integrationContext.threadId === undefined || integrationContext.turnId === undefined) {
      setMcpNotice("Select a Thread with a parent Turn before executing an MCP tool.");
      return;
    }
    let arguments_: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(mcpToolArguments);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MCP arguments must be a JSON object.");
      arguments_ = parsed as Record<string, unknown>;
    } catch (error) {
      setMcpNotice(error instanceof Error ? error.message : "MCP arguments must be valid JSON.");
      return;
    }
    const result = await invoke(createCommand({ command: "mcp.permission.resolve", payload: { activationId: activation.activationId, serverId, toolName, arguments: arguments_, threadId: integrationContext.threadId, turnId: integrationContext.turnId, scope: activation.scope, accessMode, ...(confirmed === undefined ? {} : { confirmed }), expectedSchemaRevision: activation.schemaRevision } }));
    if (typeof result === "object" && result !== null && "event" in result && (result as { event?: unknown }).event === "integration.job.updated") setMcpNotice(((result as { payload?: { job?: { message?: string } } }).payload?.job?.message) ?? "MCP action completed.");
  };
  return <div className="settings-section integrations-settings" data-testid="integrations-settings">
    <div className="settings-section-header"><div><span className="eyebrow">C1 / C2 integration surface</span><h2>Integrations</h2><p>Every integration is lazy, Host-authorized, restart-safe, and explicit about unavailable dependencies.</p></div><button className="compact-button" type="button" onClick={refresh}>Refresh status</button></div>
    <div className="integration-task-context" data-testid="integration-task-context" role="status"><strong>Selected task context</strong><span>Project: {project?.displayName ?? "Not selected"}</span><span>Thread: {activeThread?.title ?? "Not selected"}</span><span>Parent Turn: {integrationContext.turnId ?? "Not available"}</span><span>Profile: {profile === undefined ? "Not selected" : `${profile.provider} / ${profile.model}`}</span><span>Access: {integrationContext.accessMode}</span></div>
    {state === null ? <p>Loading Integration state...</p> : <>
      <div className="integration-grid">
        <IntegrationCard title="Office Skills" status={state.office.status} message={state.office.status.message} className="office-integration-card">
          <span>{state.office.activeSkillCount} active Skill package(s) · {state.office.supportedFormats.join(", ")}</span>
          <span>{state.office.jobs.length} task record(s)</span>
          {officeMissing.length > 0 && <span role="status">Office actions require: {officeMissing.join(", ")}.</span>}
          {activeOfficeSkills.length === 0 && <span role="status">Import and activate a compatible Office Skill revision.</span>}
          <div className="integration-form-grid">
            <label>Office operation<select aria-label="Office operation" value={officeKind} onChange={(event) => { const kind = event.target.value as typeof officeKind; setOfficeKind(kind); if (kind === "create") setOfficeSourcePath(""); }}><option value="create">Create</option><option value="edit">Edit</option><option value="review">Review</option></select></label>
            <label>Office format<select aria-label="Office format" value={officeFormat} onChange={(event) => { setOfficeFormat(event.target.value as typeof officeFormat); setOfficeSourcePath(""); }}><option value="docx">DOCX</option><option value="pptx">PPTX</option><option value="xlsx">XLSX</option><option value="pdf">PDF</option></select></label>
            <label>Office Skill revision<select aria-label="Office Skill revision" value={officeSkillRevisionId} onChange={(event) => setOfficeSkillRevisionId(event.target.value)}><option value="">Select active revision</option>{activeOfficeSkills.map((item) => <option key={item.revisionId} value={item.revisionId}>{item.packageId} · {item.revisionId.slice(0, 8)}</option>)}</select></label>
            <label>Output name<input aria-label="Office output name" value={officeOutputName} onChange={(event) => setOfficeOutputName(event.target.value)} placeholder={officeKind === "create" ? "generated-output" : officeKind === "review" ? "reviewed-copy" : "edited-copy"} /></label>
          </div>
          <span title={project === undefined ? undefined : `${project.path}/outputs`}>Output location: {project === undefined ? "Select a Project" : "Project outputs/"}</span>
          {officeNeedsSource && <div className="integration-inline-row"><input aria-label="Office source path" value={officeSource} readOnly placeholder={`Choose an existing ${officeFormat.toUpperCase()} source`} /><button type="button" onClick={() => void chooseOfficeSource()} disabled={readOnly}>Choose source</button></div>}
          <button className="primary-button" type="button" onClick={prepareOffice} disabled={readOnly || activeSkill === undefined || officeMissing.length > 0 || (officeNeedsSource && officeSource === "")}>Prepare Office task</button>
          {state.office.jobs.map((job) => <div className="integration-office-job" key={job.id}>
            <div className="integration-inline-row"><span>{job.kind} · {job.format ?? "unknown"} · {job.state}</span><span>{job.message}</span></div>
            {job.skillRevisionId !== undefined && <span>Skill revision {job.skillRevisionId.slice(0, 8)} · provenance retained</span>}
            {job.sourcePath !== undefined && <span title={job.sourcePath}>Source: {basenameForUi(job.sourcePath)}</span>}
            {job.stagedOutputPath !== undefined && <div className="integration-inline-row"><span title={job.stagedOutputPath}>Staged copy: {basenameForUi(job.stagedOutputPath)}</span>{job.resultId !== undefined && <button type="button" onClick={() => void invoke(createCommand({ command: "office.artifact.open", payload: { resultId: job.resultId!, artifact: "staged_output" } }))}>Open staged copy</button>}</div>}
            {job.changeSummaryPath !== undefined && <div className="integration-inline-row"><span>Change summary/diff ready</span>{job.resultId !== undefined && <button type="button" onClick={() => void invoke(createCommand({ command: "office.artifact.open", payload: { resultId: job.resultId!, artifact: "change_summary" } }))}>Open change summary</button>}</div>}
            {job.previewPaths !== undefined && <div className="integration-inline-row"><span>Render/preview: {job.previewPaths.length > 0 ? "ready" : "not produced"}</span>{job.resultId !== undefined && job.previewPaths.length > 0 && <button type="button" onClick={() => void invoke(createCommand({ command: "office.artifact.open", payload: { resultId: job.resultId!, artifact: "preview", previewIndex: 0 } }))}>Open preview</button>}</div>}
            {job.committedRelativePath !== undefined && <span>Committed: {job.committedRelativePath}</span>}
            <div className="form-actions">
              {job.state === "pending" && job.resultId === undefined && <button type="button" onClick={() => void invoke(createCommand({ command: "office.task.run", payload: { planId: job.id } }))}>Run</button>}
              {job.state === "running" && <button type="button" onClick={() => void invoke(createCommand({ command: "office.task.cancel", payload: { jobId: job.id } }))}>Cancel</button>}
              {job.resultId !== undefined && job.state === "completed" && job.committedRelativePath === undefined && <button type="button" onClick={() => void invoke(createCommand({ command: "office.result.commit", payload: { resultId: job.resultId! } }))}>Commit copy</button>}
              {job.kind === "office:edit" && job.resultId !== undefined && job.sourcePath !== undefined && job.sourceHash !== undefined && ["completed", "pending"].includes(job.state) && integrationContext.accessMode === "standard" && !officeReplacementConfirmations[job.resultId] && <button type="button" onClick={() => { void invoke(createCommand({ command: "office.source.replace", payload: { resultId: job.resultId!, sourcePath: job.sourcePath!, expectedSourceHash: job.sourceHash!, accessMode: "standard", confirmed: false } })); setOfficeReplacementConfirmations((current) => ({ ...current, [job.resultId!]: true })); }}>Request source replacement</button>}
              {job.kind === "office:edit" && job.resultId !== undefined && job.sourcePath !== undefined && job.sourceHash !== undefined && ["completed", "pending"].includes(job.state) && integrationContext.accessMode === "standard" && officeReplacementConfirmations[job.resultId] && <button type="button" onClick={() => void invoke(createCommand({ command: "office.source.replace", payload: { resultId: job.resultId!, sourcePath: job.sourcePath!, expectedSourceHash: job.sourceHash!, accessMode: "standard", confirmed: true } }))}>Confirm replacement</button>}
              {job.kind === "office:edit" && job.resultId !== undefined && job.sourcePath !== undefined && job.sourceHash !== undefined && ["completed", "pending"].includes(job.state) && integrationContext.accessMode === "full" && <button type="button" onClick={() => void invoke(createCommand({ command: "office.source.replace", payload: { resultId: job.resultId!, sourcePath: job.sourcePath!, expectedSourceHash: job.sourceHash!, accessMode: "full", confirmed: true } }))}>Replace original</button>}
            </div>
          </div>)}
        </IntegrationCard>
        <IntegrationCard title="Skill Creator" status={state.skillCreator.status} message={state.skillCreator.status.message}><span>{state.skillCreator.drafts.length} draft(s)</span><span>Creator Profile: {profile === undefined ? "Not selected" : `${profile.provider} / ${profile.model}`}</span><div className="integration-form-grid"><select aria-label="Skill operation" value={skillOperation} onChange={(event) => setSkillOperation(event.target.value as "create" | "update")}><option value="create">Create</option><option value="update">Update</option></select>{skillOperation === "update" && <select aria-label="Skill target revision" value={skillTargetRevisionId} onChange={(event) => { const revisionId = event.target.value; setSkillTargetRevisionId(revisionId); const target = skillPackages.find((item) => item.revisionId === revisionId); if (target !== undefined) setSkillPackageId(target.packageId); }}><option value="">Select target Skill</option>{skillPackages.filter((item) => item.enabled && item.state === "active").map((item) => <option key={item.revisionId} value={item.revisionId}>{item.packageId} · {item.revisionId.slice(0, 8)}</option>)}</select>}<input aria-label="Skill package id" value={skillPackageId} onChange={(event) => setSkillPackageId(event.target.value)} placeholder="Package id" /><input aria-label="Skill name" value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder="Name" /><input aria-label="Skill description" value={skillDescription} onChange={(event) => setSkillDescription(event.target.value)} placeholder="Description" /><textarea aria-label="Skill objective" value={skillObjective} onChange={(event) => setSkillObjective(event.target.value)} placeholder="Objective" /><textarea aria-label="Skill constraints" value={skillConstraints} onChange={(event) => setSkillConstraints(event.target.value)} placeholder="Constraints" /><input aria-label="Skill dependencies" value={skillDependencies} onChange={(event) => setSkillDependencies(event.target.value)} placeholder="Dependencies, comma separated" /></div>{!readOnly && <button type="button" onClick={createDraft} disabled={profile === undefined || !skillPackageId.trim() || !skillName.trim() || !skillDescription.trim() || !skillObjective.trim() || (skillOperation === "update" && !skillTargetRevisionId)}>Create explicit draft</button>}{state.skillCreator.drafts.map((draft) => <div className="integration-inline-row" key={draft.draftId}><span>{draft.packageId} · {draft.operation} · {draft.state}</span>{draft.state === "draft_ready" && <button type="button" onClick={() => void invoke(createCommand({ command: "skill_creator.review", payload: { draftId: draft.draftId } }))}>Review</button>}{!readOnly && ["draft_ready", "reviewed"].includes(draft.state) && <button type="button" onClick={() => void invoke(createCommand({ command: "skill_creator.handoff", payload: { draftId: draft.draftId, confirmed: true, accessMode: integrationContext.accessMode } }))}>Hand off disabled</button>}</div>)}</IntegrationCard>
        <IntegrationCard title="Page Recovery / OCR" status={state.pageRecovery.status} message={state.pageRecovery.status.message}><span>Native: {state.pageRecovery.availability.native.status} · Paddle: {state.pageRecovery.availability.paddle.status} · Ovis: {state.pageRecovery.availability.ovis.status}</span><span>Policy {state.pageRecovery.availability.policyRevision} · {state.pageRecovery.telemetry.lastStatus}</span><div className="integration-inline-row"><button type="button" onClick={() => void invoke(createCommand({ command: "page_recovery.inspect" }))}>Inspect availability</button><button type="button" onClick={runParse} disabled={readOnly || project === undefined || material === undefined}>Run Page Recovery</button></div>{state.pageRecovery.lastParse !== undefined && <div className="integration-page-results" role="status"><strong>Last Parse · per-page retained result</strong>{state.pageRecovery.lastParse.pages.map((page) => <span key={page.pageNumber}>Page {page.pageNumber}: {page.selectedStage}{page.retainedEarlier ? " · retained earlier result" : ""}{page.warningCodes.length === 0 ? "" : ` · ${page.warningCodes.join(", ")}`}</span>)}</div>}{state.pageRecovery.parses.map((job) => <div className="integration-inline-row" key={job.id}><span>{job.kind} · {job.state} · {job.message}</span>{job.state === "running" && <button type="button" onClick={() => void invoke(createCommand({ command: "page_recovery.cancel", payload: { parseId: job.id } }))}>Cancel Parse</button>}</div>)}</IntegrationCard>
        <IntegrationCard title="Connected Tools / MCP" status={state.mcp.status} message={state.mcp.status.message}><span>{state.mcp.servers.length} configured server(s) · {state.mcp.connectedServers} connected</span><span>{state.mcp.adapterVersion} · {state.mcp.activeTools} active tool(s)</span><div className="integration-form-grid"><input aria-label="MCP config identifier" value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="Server name" /><select aria-label="MCP transport" value={mcpTransport} onChange={(event) => setMcpTransport(event.target.value as "stdio" | "http")}><option value="stdio">stdio</option><option value="http">HTTP</option></select>{mcpTransport === "stdio" ? <><input aria-label="MCP command" value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} placeholder="Command" /><textarea aria-label="MCP arguments" value={mcpArguments} onChange={(event) => setMcpArguments(event.target.value)} placeholder="One argument per line" /><input aria-label="MCP working directory" value={mcpWorkingDirectory} onChange={(event) => setMcpWorkingDirectory(event.target.value)} placeholder="Working directory" /></> : <input aria-label="MCP endpoint" value={mcpEndpoint} onChange={(event) => setMcpEndpoint(event.target.value)} placeholder="HTTPS endpoint" />}<input aria-label="MCP credential reference" value={mcpCredentialRef} onChange={(event) => setMcpCredentialRef(event.target.value)} placeholder="Optional protected credential ref" /><button type="button" onClick={saveMcp} disabled={readOnly || !mcpName.trim() || (mcpTransport === "stdio" ? !mcpCommand.trim() : !mcpEndpoint.trim())}>Save config</button></div><label>MCP tool arguments (JSON)<textarea aria-label="MCP tool arguments" value={mcpToolArguments} onChange={(event) => setMcpToolArguments(event.target.value)} /></label><button type="button" onClick={() => void invoke(createCommand({ command: "mcp.server.list" }))}>Load servers</button>{state.mcp.activeActivation !== undefined && <span role="status">Task activation {state.mcp.activeActivation.schemaRevision} · {state.mcp.activeActivation.toolIds.join(", ") || "no tools"} · scope {state.mcp.activeActivation.scope}</span>}{mcpNotice !== null && <span role="status">{mcpNotice}</span>}{state.mcp.servers.map((server) => <div className="integration-mcp-server" key={server.serverId}><div className="integration-inline-row"><span>{server.name} · {server.connectionStatus} · schemas {server.schemaRevision}</span>{!readOnly && <><button type="button" onClick={() => void invoke(createCommand({ command: "mcp.server.test", payload: { serverId: server.serverId } }))}>Test Connection</button>{server.connectionStatus === "disconnected" && <button type="button" disabled={activeThread === undefined} onClick={() => void invoke(createCommand({ command: "mcp.activate", payload: { serverId: server.serverId, toolIds: [], scope: activeThread?.scope ?? "project" } }))}>Activate</button>}{server.connectionStatus === "connected" && <button type="button" onClick={() => void invoke(createCommand({ command: "mcp.disconnect", payload: { serverId: server.serverId } }))}>Disconnect</button>}</>}</div>{server.toolSchemas.length === 0 ? <span>No cached tool schemas. Test Connection to discover them.</span> : <div className="integration-tool-list">{server.toolSchemas.map((schema) => <div className="integration-inline-row" key={`${server.serverId}:${schema.name}`}><span title={schema.description}>{schema.name} · {schema.actionClass} · {schema.inputBytes}/{schema.outputBytes} bytes · {schema.allowedScopes.join(", ")}</span>{state.mcp.activeActivation?.serverId === server.serverId && state.mcp.activeActivation.toolIds.includes(schema.name) && <button type="button" onClick={() => void runMcpTool(server.serverId, schema.name, integrationContext.accessMode, schema.actionClass === "read" ? undefined : true)}>{schema.actionClass === "read" ? "Run read" : "Confirm action"}</button>}</div>)}</div>}</div>)}</IntegrationCard>
        <IntegrationCard title="Extension Admission" status={state.extensions.status} message={state.extensions.status.message}><span>{state.extensions.stagedCount} staged · {state.extensions.approvedCount} approved · {state.extensions.enabledCount} enabled</span><span>Revision {state.extensions.effectiveRevisionId.slice(0, 12)}</span>{!readOnly && <button type="button" onClick={() => void invoke(createCommand({ command: "extension.stage" }))}>Stage Extension</button>}{state.extensions.staged.map((item) => <div className="integration-inline-row" key={item.stagedRevisionId}><span>{item.name || item.extensionId} · {item.state}</span><button type="button" onClick={() => void invoke(createCommand({ command: "extension.inspect", payload: { stagedRevisionId: item.stagedRevisionId } }))}>Inspect</button></div>)}{state.extensions.reports.map((report) => <div className="integration-inline-row" key={report.reportId}><span>Inspection · {report.status}</span>{!readOnly && report.status === "reviewable" && <><button type="button" disabled={profile === undefined} onClick={() => void invoke(createCommand({ command: "extension.audit", payload: { stagedRevisionId: report.stagedRevisionId, ...(profile === undefined ? {} : { profileId: profile.id }) } }))}>Audit</button><button type="button" onClick={() => void invoke(createCommand({ command: "extension.approve", payload: { stagedRevisionId: report.stagedRevisionId, reportId: report.reportId, expectedArtifactHash: report.artifactHash, acceptedFindingIds: [], userConfirmed: true } }))}>Approve</button></>}</div>)}{state.extensions.approved.map((item) => <div className="integration-inline-row" key={item.approvedRevisionId}><span>{item.extensionId} · {item.enabled ? "enabled" : item.invalidated ? "invalidated" : "approved / disabled"}</span>{!readOnly && !item.enabled && !item.invalidated && <button type="button" onClick={() => void invoke(createCommand({ command: "extension.revision.prepare", payload: { action: "enable", extensionId: item.extensionId, approvedRevisionId: item.approvedRevisionId } }))}>Prepare enable</button>}{!readOnly && item.enabled && <button type="button" onClick={() => void invoke(createCommand({ command: "extension.rollback", payload: { approvedRevisionId: item.approvedRevisionId } }))}>Rollback</button>}</div>)}{state.extensions.pendingRevisionId !== undefined && !readOnly && <button className="primary-button" type="button" onClick={() => void invoke(createCommand({ command: "extension.revision.activate", payload: { revisionId: state.extensions.pendingRevisionId!, mode: "idle" } }))}>Activate pending revision</button>}</IntegrationCard>
      </div>
      {state.runtime.runningJobs > 0 && <p className="integration-runtime-status" role="status">{state.runtime.runningJobs} integration job(s) active · {state.runtime.queuedJobs} queued · {state.runtime.failures} failure(s) retained.</p>}
      <details className="integration-job-list"><summary>Recent workflow states</summary>{[...state.office.jobs, ...state.pageRecovery.parses].length === 0 ? <p className="empty-setting">No integration jobs have run.</p> : [...state.office.jobs, ...state.pageRecovery.parses].map((job) => <div className="profile-row" key={job.id}><div><strong>{job.kind}</strong><span>{job.state} · {job.message}</span></div><span>{new Date(job.updatedAt).toLocaleString()}</span></div>)}</details>
    </>}
  </div>;
}

function basenameForUi(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path;
}

function IntegrationCard({ title, status, message, children, className = "" }: { title: string; status: { status: "ready" | "attention" | "unavailable" }; message: string; children: React.ReactNode; className?: string }) {
  return <section className={`integration-card ${className}`.trim()}><header><h3>{title}</h3><span className={`doctor-status ${status.status}`}>{status.status}</span></header><p>{message}</p><div>{children}</div></section>;
}

function reflectionStatusLabel(status: ReflectionRun["status"]): string {
  return ({ awaiting_profile: "Awaiting profile", ready: "Ready", independent_running: "Analyzing evidence", independent_completed: "Evidence pass complete", independent_failed: "Evidence pass failed", independent_interrupted: "Evidence pass interrupted", memory_aware_running: "Recalling prior judgment", dialogue_active: "Reflection dialogue", memory_aware_failed: "Reflection start failed", memory_aware_interrupted: "Reflection start interrupted", discarded: "Discarded" })[status];
}

function ProjectContextPanel({ document, draft, onChange, onReload, onSave }: {
  document: ProjectContextDocument | undefined;
  draft: string | undefined;
  onChange(content: string): void;
  onReload(): void;
  onSave(): void;
}) {
  if (document === undefined || draft === undefined) return <div className="context-panel"><p>Loading Project Context...</p></div>;
  return <div className="context-panel">
    <div className="context-heading"><div><h2>Project Context</h2><span>{new Date(document.updatedAt).toLocaleString()}</span></div><button className="section-action" type="button" title="Reload context" aria-label="Reload context" onClick={onReload}><RefreshCw size={14} /></button></div>
    {document.warnings.length > 0 && <div className="context-warnings" role="status">{document.warnings.map((warning, index) => <span key={`${warning.code}-${index}`}>{warning.message}</span>)}</div>}
    <textarea aria-label="Project Context" value={draft} onChange={(event) => onChange(event.target.value)} spellCheck="false" />
    <button className="primary-button context-save" type="button" onClick={onSave}>Save Context</button>
  </div>;
}

function ProjectOutputsPanel({ outputs, open }: { outputs: ProjectOutputArtifact[]; open(artifactId: string): void }) {
  return <div className="outputs-panel"><div className="inventory-heading"><h2>Outputs</h2><span>{outputs.length}</span></div>{outputs.length === 0 ? <p className="empty-list">No generated outputs</p> : outputs.map((output) => <div className="output-row" key={output.id}><div><strong title={output.relativePath}>{output.relativePath}</strong><span>{output.mediaType}</span><span>{output.profile.provider} / {output.profile.model} · {output.capabilityId}</span><span>{output.sourceReferences.length} source reference(s) · {output.warnings.length} warning(s)</span></div><button className="section-action" type="button" title="Open output" aria-label={`Open ${output.relativePath}`} onClick={() => open(output.id)}><ExternalLink size={14} /></button></div>)}</div>;
}

function ProjectMemoryPanel({ document, draft, onChange, onReload, onSave }: {
  document: ProjectMemoryDocument | undefined;
  draft: string | undefined;
  onChange(content: string): void;
  onReload(): void;
  onSave(): void;
}) {
  if (document === undefined || draft === undefined) return <div className="context-panel"><p>Loading Project Memory...</p></div>;
  return <div className="context-panel memory-panel">
    <div className="context-heading"><div><h2>Project Memory</h2><span>User-confirmed judgment · {document.entries.length} entries</span></div><button className="section-action" type="button" title="Reload memory" aria-label="Reload memory" onClick={onReload}><RefreshCw size={14} /></button></div>
    {document.warnings.length > 0 && <div className="context-warnings" role="status">{document.warnings.map((warning, index) => <span key={`${warning.code}-${index}`}>{warning.message}</span>)}</div>}
    <textarea aria-label="Project Memory" value={draft} onChange={(event) => onChange(event.target.value)} spellCheck="false" />
    <button className="primary-button context-save" type="button" onClick={onSave}>Save Memory</button>
  </div>;
}

function SettingsView({ bootstrap, profiles, taskAssignments, projects, materialsByProject, skillPackages, skillsRoot, lastSkillReport, integrationState, subAgentProjections, activeThreadId, activeThread, activeProfile, integrationContext, promptRevisions, activePromptRevisionId, formOpen, setFormOpen, invoke, readOnly, recoveryExport, personalCognitionNotice, learningTelemetry, longTermMemoryDocument, longTermMemoryDraft, preparedMemoryPatch, memoryMaintenance, dreamState, openDreamLaunch, onLongTermMemoryChange, onLongTermMemoryRefresh }: {
  bootstrap: BootstrapState | null;
  profiles: ModelProfile[];
  taskAssignments: TaskModelAssignment[];
  projects: Project[];
  materialsByProject: Record<string, MaterialInventoryItem[]>;
  skillPackages: SkillInventoryItem[];
  skillsRoot: string | null;
  lastSkillReport: SkillCompatibilityReport | null;
  integrationState: IntegrationState | null;
  subAgentProjections: Record<string, SubAgentProjection>;
  activeThreadId: string | null;
  activeThread: Thread | undefined;
  activeProfile: ModelProfile | undefined;
  integrationContext: IntegrationTaskContext;
  promptRevisions: SystemPromptRevision[];
  activePromptRevisionId: string | null;
  formOpen: boolean;
  setFormOpen(value: boolean): void;
  invoke(command: HostCommand): Promise<unknown>;
  readOnly: boolean;
  recoveryExport: string | null;
  personalCognitionNotice: string | null;
  learningTelemetry: { coveredScopes: number; totalScopes: number; failureCount: number };
  longTermMemoryDocument: LongTermMemoryDocument | null;
  longTermMemoryDraft: string;
  preparedMemoryPatch: PreparedMemoryPatch | null;
  memoryMaintenance: MemoryMaintenanceState | null;
  dreamState: DreamReviewState | null;
  openDreamLaunch(): void;
  onLongTermMemoryChange(content: string): void;
  onLongTermMemoryRefresh(): void;
}) {
  const [tab, setTab] = useState<"general" | "memory">("general");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ModelProfile["thinkingLevel"]>("off");
  const [credentialProfileId, setCredentialProfileId] = useState<string | null>(null);
  const [replacementCredential, setReplacementCredential] = useState("");
  const valid = name.trim() && provider.trim() && model.trim() && apiKey;
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    void invoke(createCommand({ command: "profile.create", payload: { name, provider, model, apiKey, thinkingLevel } })).then(() => {
      setName(""); setProvider(""); setModel(""); setApiKey(""); setThinkingLevel("off");
    });
  };
  const openMemory = () => {
    setTab("memory");
    if (longTermMemoryDocument === null) void invoke(createCommand({ command: "long_term_memory.load" }));
    if (memoryMaintenance === null) void invoke(createCommand({ command: "long_term_memory.maintenance.load" }));
  };
  const saveLongTermMemory = () => {
    if (longTermMemoryDocument === null) return;
    void invoke(createCommand({ command: "long_term_memory.save", payload: { content: longTermMemoryDraft, expectedSourceHash: longTermMemoryDocument.sourceHash } }));
  };
  return (
    <section className="settings-view" aria-labelledby="settings-title">
      <header><div><span className="eyebrow">Application</span><h1 id="settings-title">Settings</h1></div><SlidersHorizontal size={20} /></header>
      <div className="settings-tabs" role="tablist" aria-label="Settings views"><button type="button" role="tab" aria-selected={tab === "general"} className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>General</button><button type="button" role="tab" aria-selected={tab === "memory"} className={tab === "memory" ? "active" : ""} onClick={openMemory} disabled={readOnly}>Memory</button></div>
      {tab === "memory" ? <div className="memory-settings-stack"><DreamSettings state={dreamState} invoke={invoke} launch={openDreamLaunch} /><LongTermMemorySettings document={longTermMemoryDocument} draft={longTermMemoryDraft} patch={preparedMemoryPatch} maintenance={memoryMaintenance} invoke={invoke} onChange={onLongTermMemoryChange} onRefresh={onLongTermMemoryRefresh} onSave={saveLongTermMemory} openFolder={() => void invoke(createCommand({ command: "long_term_memory.open_folder" }))} /></div> : <>
      {readOnly && <div className="settings-section recovery-export"><h2>Recovery export</h2><p>Raw state may contain encrypted credentials and sensitive local metadata. Its destination determines its security.</p><button className="compact-button" type="button" onClick={() => void invoke(createCommand({ command: "state.recovery.export" }))}>Export raw state</button>{recoveryExport && <span title={recoveryExport}>{recoveryExport}</span>}</div>}
      <fieldset className="settings-write-controls" disabled={readOnly}>
      <div className="settings-section personal-cognition-settings"><div className="settings-section-header"><div><h2>Personal Cognition Backup</h2><p>Portable, checksummed cognition only. Projects, workflow state, trajectories, and credentials are excluded.</p></div></div><div className="form-actions"><button type="button" onClick={() => void invoke(createCommand({ command: "personal_cognition.restore" }))}>Restore backup</button><button className="primary-button" type="button" onClick={() => void invoke(createCommand({ command: "personal_cognition.backup.create" }))}>Create backup</button></div>{personalCognitionNotice && <span role="status" title={personalCognitionNotice}>{personalCognitionNotice}</span>}</div>
      <SkillsSettings packages={skillPackages} root={skillsRoot} lastReport={lastSkillReport} invoke={invoke} />
      <div className="settings-section profile-settings">
        <div className="settings-section-header"><div><h2>Model Profiles</h2><p>Credentials are protected by Windows and stored only by reference.</p></div><button className="compact-button" type="button" onClick={() => setFormOpen(!formOpen)}><Plus size={15} /> New profile</button></div>
        {formOpen && <form className="profile-form" onSubmit={save}>
          <label>Name<input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
          <label>Provider<input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="anthropic" /></label>
          <label>Model<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="model id" /></label>
          <label>API key<span className="secret-input"><KeyRound size={14} /><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" /></span></label>
          <label>Reasoning<select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value as ModelProfile["thinkingLevel"])}><option value="off">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          <div className="form-actions"><button type="button" onClick={() => setFormOpen(false)}>Cancel</button><button className="primary-button" type="submit" disabled={!valid}>Save profile</button></div>
        </form>}
        <div className="profile-list">{profiles.length === 0 ? <p className="empty-setting">No model profiles</p> : profiles.map((profile) => <div className="profile-row" key={profile.id}><div><strong>{profile.name}</strong><span>{profile.provider} / {profile.model}</span>{profile.credentialRef.startsWith("setup-required-") && <><span>Credential setup required after restore</span>{credentialProfileId === profile.id ? <span className="secret-input"><KeyRound size={14} /><input aria-label={`Credential for ${profile.name}`} type="password" value={replacementCredential} onChange={(event) => setReplacementCredential(event.target.value)} autoComplete="off" /><button type="button" disabled={!replacementCredential} onClick={() => void invoke(createCommand({ command: "profile.credential.set", payload: { profileId: profile.id, apiKey: replacementCredential } })).then(() => { setCredentialProfileId(null); setReplacementCredential(""); })}>Save credential</button></span> : <button type="button" onClick={() => setCredentialProfileId(profile.id)}>Set credential</button>}</>}</div><span>{profile.thinkingLevel}</span></div>)}</div>
      </div>
      <div className="settings-section task-assignment-settings"><div className="settings-section-header"><div><h2>Task Model Assignments</h2><p>Workflow defaults; launch-time selection remains available.</p></div></div>{TASK_MODEL_TYPES.map((task) => <label key={task.id}><span>{task.label}</span><select aria-label={`${task.label} Profile`} value={taskAssignments.find((item) => item.taskType === task.id)?.profileId ?? ""} onChange={(event) => void invoke(createCommand(event.target.value === "" ? { command: "task_model_assignment.clear", payload: { taskType: task.id } } : { command: "task_model_assignment.set", payload: { taskType: task.id, profileId: event.target.value } }))}><option value="">Not assigned</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.provider}/{profile.model}</option>)}</select></label>)}</div>
      <PromptSettings revisions={promptRevisions} activeRevisionId={activePromptRevisionId} invoke={invoke} />
      <div className="settings-section"><h2>Access Mode</h2><div className="access-mode-control" role="group" aria-label="Access Mode"><button type="button" className={bootstrap?.accessMode === "standard" ? "active" : ""} onClick={() => void invoke(createCommand({ command: "access.mode.set", payload: { mode: "standard" } }))}>Standard</button><button type="button" className={bootstrap?.accessMode === "full" ? "active full" : ""} onClick={() => void invoke(createCommand({ command: "access.mode.set", payload: { mode: "full" } }))}>Full Access</button></div></div>
      </fieldset>
       <IntegrationsSettings state={integrationState} invoke={invoke} readOnly={readOnly} profiles={profiles} projects={projects} materialsByProject={materialsByProject} skillPackages={skillPackages} activeThread={activeThread} activeProfile={activeProfile} integrationContext={integrationContext} />
      <DelegationSettings projections={subAgentProjections} activeThread={activeThread} activeProfile={activeProfile} invoke={invoke} readOnly={readOnly} />
      <div className="settings-section"><h2>Local state</h2><dl><div><dt>Application version</dt><dd>{bootstrap?.applicationVersion ?? "Loading"}</dd></div><div><dt>Storage mode</dt><dd>{bootstrap?.storageMode ?? "Loading"}</dd></div><div><dt>State schema</dt><dd>{bootstrap?.stateSchemaVersion ?? "Loading"}</dd></div><div><dt>Supported schema</dt><dd>{bootstrap?.migration.supportedVersion ?? "Loading"}</dd></div><div><dt>Migration status</dt><dd>{bootstrap?.migration.status ?? "Loading"}</dd></div><div><dt>Rollback</dt><dd>{bootstrap?.migration.rollbackAvailable ? "Available" : "Unavailable"}</dd></div><div><dt>Projects</dt><dd>{bootstrap?.entityCounts.projects ?? 0}</dd></div><div><dt>Threads</dt><dd>{bootstrap?.entityCounts.threads ?? 0}</dd></div></dl></div>
      <div className="settings-section"><h2>Runtime</h2><dl><div><dt>Agent workers</dt><dd>{bootstrap?.runtimeActivity.agentWorkersStarted ?? 0}</dd></div><div><dt>Pi sessions</dt><dd>{bootstrap?.runtimeActivity.piSessionsStarted ?? 0}</dd></div><div><dt>Provider requests</dt><dd>{bootstrap?.runtimeActivity.providerRequests ?? 0}</dd></div><div><dt>Execution capacity</dt><dd>{bootstrap === null ? "-" : `${bootstrap.executionScheduler.runningCount} / ${bootstrap.executionScheduler.capacity}`}</dd></div><div><dt>Queued / drafts</dt><dd>{bootstrap === null ? "-" : `${bootstrap.executionScheduler.queuedCount} / ${bootstrap.executionScheduler.draftCount}`}</dd></div><div><dt>Average queue delay</dt><dd>{bootstrap?.executionScheduler.averageQueueDelayMs ?? 0} ms</dd></div><div><dt>Longest running</dt><dd>{bootstrap?.executionScheduler.longestRunningMs ?? 0} ms</dd></div><div><dt>Execution failures</dt><dd>{bootstrap?.executionScheduler.failureCount ?? 0}</dd></div></dl></div>
      <div className="settings-section learning-telemetry"><h2>Learning telemetry</h2><p>Turn details expose prompt, tools, retained context, recall, output reserve, token contribution, and latency.</p><dl><div><dt>Dream scope coverage</dt><dd>{learningTelemetry.coveredScopes} / {learningTelemetry.totalScopes}</dd></div><div><dt>Visible workflow failures</dt><dd>{learningTelemetry.failureCount}</dd></div><div><dt>Remote content telemetry</dt><dd>Disabled</dd></div></dl></div>
      <div className="settings-section"><h2>Environment Doctor</h2><dl>{bootstrap?.environmentDoctor === undefined ? <div><dt>Status</dt><dd>Loading</dd></div> : Object.entries(bootstrap.environmentDoctor).map(([name, diagnostic]) => <div key={name}><dt>{doctorLabel(name)}</dt><dd><span className={`doctor-status ${diagnostic.status}`}>{diagnostic.status}</span> {diagnostic.message}</dd></div>)}</dl></div>
      </>}
    </section>
  );
}

function DreamSettings({ state, invoke, launch }: { state: DreamReviewState | null; invoke(command: HostCommand): Promise<unknown>; launch(): void }) {
  const [interval, setInterval] = useState(state?.schedule.reviewIntervalDays ?? 7);
  useEffect(() => { if (state !== null) setInterval(state.schedule.reviewIntervalDays); }, [state?.schedule.reviewIntervalDays]);
  const active = state?.batches.find((batch) => batch.id === state.schedule.activeBatchId);
  const latestCompleted = state?.batches.filter((batch) => batch.status === "completed").at(-1);
  return <section className="settings-section dream-settings" aria-labelledby="dream-settings-title">
    <div className="settings-section-header"><div><span className="eyebrow">Cognitive review</span><h2 id="dream-settings-title">Dream</h2><p>Scope extraction, synthesis review, and final Memory confirmation remain separate User actions.</p></div><button className="compact-button" type="button" onClick={launch}><Moon size={15} /> New batch</button></div>
    {state === null ? <p>Loading Dream state...</p> : <>
      <dl><div><dt>Captured candidates</dt><dd>{state.schedule.pendingCandidateCount}</dd></div><div><dt>Eligible exchanges</dt><dd>{state.schedule.eligibleSessionCount}</dd></div><div><dt>Carryover</dt><dd>{state.schedule.carryoverCount}</dd></div><div><dt>Committed cutoff</dt><dd>{state.schedule.lastCommittedCutoff === undefined ? "None" : new Date(state.schedule.lastCommittedCutoff).toLocaleString()}</dd></div></dl>
      <div className="dream-interval"><label>Review interval<input aria-label="Dream review interval" type="number" min="1" max="365" value={interval} onChange={(event) => setInterval(Number(event.target.value))} /></label><span>days</span><button type="button" onClick={() => void invoke(createCommand({ command: "dream.interval.set", payload: { reviewIntervalDays: interval } }))} disabled={!Number.isInteger(interval) || interval < 1 || interval > 365}>Save</button></div>
      {active !== undefined && <DreamActiveBatch batch={active} invoke={invoke} />}
      {latestCompleted !== undefined && active === undefined && <div className="dream-completed-record"><strong>Latest completed Dream</strong><span>Cutoff {new Date(latestCompleted.cutoff).toLocaleString()} · {latestCompleted.preparedPatch?.proposalIds.length ?? 0} committed proposal(s)</span><span>{latestCompleted.partialCoverageScopeIds.length > 0 ? `Partial Dream Coverage · ${latestCompleted.partialCoverageScopeIds.length} skipped scope(s)` : "Complete scope coverage"}</span></div>}
    </>}
  </section>;
}

function DreamActiveBatch({ batch, invoke }: { batch: DreamBatch; invoke(command: HostCommand): Promise<unknown> }) {
  const scopesCovered = batch.extractionScopes.every((scope) => scope.status === "approved" || scope.status === "skipped");
  return <><div className="dream-batch-summary"><div><strong>Frozen batch</strong><span>{batch.status.replace("_", " ")} · cutoff {new Date(batch.cutoff).toLocaleString()}</span><span>{batch.trajectoryInputs.length} exchanges · {batch.candidateInputs.length} candidates · {batch.carryoverInputs.length} carryover</span><span>{batch.profileSnapshot.name} · prompt {batch.promptSnapshot.hash.slice(0, 12)}</span></div><div>{batch.status === "resumable" && batch.currentStage !== "global_synthesis" && <button className="primary-button" type="button" onClick={() => void invoke(createCommand({ command: "dream.resume", payload: { batchId: batch.id } }))}>Resume</button>}<button type="button" onClick={() => void invoke(createCommand({ command: "dream.discard", payload: { batchId: batch.id } }))}>Discard</button></div></div>
    {batch.partialCoverageScopeIds.length > 0 && <p className="dream-partial-coverage" role="status">Partial Dream Coverage: {batch.partialCoverageScopeIds.length} scope(s) explicitly skipped and retained as Carryover.</p>}
    <div className="dream-scope-list">{batch.extractionScopes.map((scope) => <article className="dream-scope-card" key={scope.id}><header><div><strong>{scope.kind === "project" ? "Project scope" : "Unscoped Thread"}</strong><span>{scope.kind === "project" ? scope.projectId?.slice(0, 8) : scope.threadId} · {scope.status.replace("_", " ")} · attempt {scope.attemptCount}</span></div><div>{(["pending", "stale"] as string[]).includes(scope.status) && <button className="primary-button" type="button" onClick={() => void invoke(createCommand({ command: "dream.scope.start", payload: { batchId: batch.id, scopeId: scope.id } }))}>Extract</button>}{scope.status === "failed" && <><button className="primary-button" type="button" onClick={() => void invoke(createCommand({ command: "dream.scope.start", payload: { batchId: batch.id, scopeId: scope.id } }))}>Retry</button><button type="button" onClick={() => void invoke(createCommand({ command: "dream.scope.review", payload: { batchId: batch.id, scopeId: scope.id, decision: "skip" } }))}>Skip</button></>}{scope.status === "succeeded" && <><button className="primary-button" type="button" onClick={() => void invoke(createCommand({ command: "dream.scope.review", payload: { batchId: batch.id, scopeId: scope.id, decision: "approve" } }))}>Approve</button><button type="button" onClick={() => void invoke(createCommand({ command: "dream.scope.start", payload: { batchId: batch.id, scopeId: scope.id } }))}>Retry</button><button type="button" onClick={() => void invoke(createCommand({ command: "dream.scope.review", payload: { batchId: batch.id, scopeId: scope.id, decision: "keep_pending" } }))}>Keep Pending</button><button type="button" onClick={() => void invoke(createCommand({ command: "dream.scope.review", payload: { batchId: batch.id, scopeId: scope.id, decision: "skip" } }))}>Skip</button></>}</div></header>{scope.failure !== undefined && <p className="dream-scope-failure"><strong>{scope.failure.code}</strong> {scope.failure.message}</p>}{scope.result !== undefined && <div className="dream-scope-result"><p>{scope.result.summary}</p><span>Uncertainty: {scope.result.uncertainty || "Not stated"}</span><span>{scope.result.candidates.length} candidate(s) · {scope.result.sourceReferences.length} opaque source reference(s) · de-identified</span></div>}</article>)}</div>
    {scopesCovered && (batch.synthesis === undefined || batch.synthesis.status === "stale") && <div className="dream-synthesis-action"><button className="primary-button" type="button" onClick={() => void invoke(createCommand({ command: "dream.synthesis.start", payload: { batchId: batch.id } }))}>{batch.synthesis?.status === "stale" ? "Regenerate Global Synthesis" : "Run Global Synthesis"}</button><span>Only approved de-identified summaries and bounded Long-term Memory cards will be sent.</span></div>}
    {batch.synthesisFailure !== undefined && <p className="dream-scope-failure"><strong>{batch.synthesisFailure.code}</strong> {batch.synthesisFailure.message} <button type="button" onClick={() => void invoke(createCommand({ command: "dream.synthesis.start", payload: { batchId: batch.id } }))}>Retry synthesis</button></p>}
    {batch.synthesis !== undefined && batch.synthesis.status !== "stale" && <DreamSynthesisReview batch={batch} invoke={invoke} />}
  </>;
}

function DreamSynthesisReview({ batch, invoke }: { batch: DreamBatch; invoke(command: HostCommand): Promise<unknown> }) {
  const synthesis = batch.synthesis!;
  return <section className="dream-synthesis-review"><header><div><strong>Global Dream Synthesis</strong><span>{synthesis.status.replace("_", " ")} · {synthesis.partialCoverageScopeReferences.length > 0 ? "Partial Dream Coverage" : "Complete coverage"}</span></div>{synthesis.status === "review_pending" && <div><button type="button" onClick={() => void invoke(createCommand({ command: "dream.proposal.review_all", payload: { batchId: batch.id, decision: "reject" } }))}>Reject all</button><button className="primary-button" type="button" onClick={() => void invoke(createCommand({ command: "dream.proposal.review_all", payload: { batchId: batch.id, decision: "approve" } }))}>Approve all</button></div>}</header><p>{synthesis.summary}</p><span>Uncertainty: {synthesis.uncertainty || "Not stated"}</span>
    <div className="dream-proposal-list">{synthesis.proposals.map((proposal) => <DreamProposalCard key={proposal.id} batch={batch} proposal={proposal} invoke={invoke} />)}</div>
    {synthesis.status === "reviewed" && batch.preparedPatch?.status !== "prepared" && <button className="primary-button dream-prepare-patch" type="button" onClick={() => void invoke(createCommand({ command: "dream.patch.prepare", payload: { batchId: batch.id } }))}>Prepare Markdown Patch Preview</button>}
    {batch.preparedPatch?.status === "prepared" && <div className="dream-patch-preview"><header><div><strong>Final Markdown Patch Preview</strong><span>{batch.preparedPatch.partialCoverageScopeReferences.length > 0 ? "Partial Dream Coverage" : "Complete coverage"} · confirmation required</span></div><div><button type="button" onClick={() => void invoke(createCommand({ command: "dream.patch.discard", payload: { batchId: batch.id, patchId: batch.preparedPatch!.id } }))}>Discard preview</button><button className="primary-button" type="button" onClick={() => void invoke(createCommand({ command: "dream.patch.commit", payload: { batchId: batch.id, patchId: batch.preparedPatch!.id } }))}>Confirm Memory Commit</button></div></header>{batch.preparedPatch.files.filter((file) => file.changed && ["project_memory", "long_term_memory", "condensation_archive", "cognitive_evolution_history"].includes(file.kind)).map((file) => <details key={`${file.kind}-${file.path}`}><summary>{file.kind.replaceAll("_", " ")} · {file.path}</summary><pre>{file.diff}</pre></details>)}</div>}
  </section>;
}

function DreamProposalCard({ batch, proposal, invoke }: { batch: DreamBatch; proposal: DreamSynthesisProposal; invoke(command: HostCommand): Promise<unknown> }) {
  const [destination, setDestination] = useState(proposal.destination);
  useEffect(() => setDestination(proposal.destination), [proposal.destination]);
  const sourceScopeIds = proposal.sourceScopeReferences.map((reference) => batch.synthesis!.scopeMap.find((item) => item.scopeReference === reference)?.scopeId);
  const projectEligible = sourceScopeIds.length === 1 && batch.extractionScopes.find((scope) => scope.id === sourceScopeIds[0])?.kind === "project";
  return <article className="dream-proposal-card"><header><div><strong>{proposal.learning?.title ?? proposal.id}</strong><span>{proposal.status} · origin {proposal.candidateOrigins.join(", ")}</span></div><label>Destination<select value={destination} onChange={(event) => setDestination(event.target.value as DreamSynthesisProposal["destination"])}><option value="long_term_memory">Long-term Memory</option>{projectEligible && <option value="project_memory">Project Memory</option>}<option value="keep_pending">Keep Pending</option><option value="discard">Discard</option>{proposal.targetEntryIds.length >= 2 && <option value="merge_condense">Merge / Condense</option>}</select></label></header><p>{proposal.learning?.content ?? proposal.rationale}</p><span>Uncertainty: {proposal.uncertainty || "Not stated"}</span><span>Comparison: {proposal.comparisonSummary || "Not applicable"}</span><span>{proposal.sourceReferences.length} opaque source reference(s)</span>{proposal.status === "pending" && <div><button type="button" onClick={() => void invoke(createCommand({ command: "dream.proposal.review", payload: { batchId: batch.id, proposalId: proposal.id, decision: "reject", destination } }))}>Reject</button><button className="primary-button" type="button" onClick={() => void invoke(createCommand({ command: "dream.proposal.review", payload: { batchId: batch.id, proposalId: proposal.id, decision: "approve", destination } }))}>Approve</button></div>}</article>;
}

function LongTermMemorySettings({ document, draft, patch, maintenance, invoke, onChange, onRefresh, onSave, openFolder }: {
  document: LongTermMemoryDocument | null;
  draft: string;
  patch: PreparedMemoryPatch | null;
  maintenance: MemoryMaintenanceState | null;
  invoke(command: HostCommand): Promise<unknown>;
  onChange(content: string): void;
  onRefresh(): void;
  onSave(): void;
  openFolder(): void;
}) {
  const [proposalOpen, setProposalOpen] = useState(false);
  const [action, setAction] = useState<PreparedMemoryPatch["action"]>("add");
  const [targetEntryIds, setTargetEntryIds] = useState<string[]>([]);
  const [entryId, setEntryId] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [applicability, setApplicability] = useState("");
  const [maturity, setMaturity] = useState<"user-confirmed" | "evidence-backed" | "retrospectively-supported">("user-confirmed");
  const [recallPolicy, setRecallPolicy] = useState<"automatic" | "explicit-only">("automatic");
  const [limitations, setLimitations] = useState("");
  const [content, setContent] = useState("");
  const [rationale, setRationale] = useState("");
  const [resolutionType, setResolutionType] = useState<"user_correction" | "approved_reflection" | "approved_retrospective">("approved_reflection");
  const [resolutionReference, setResolutionReference] = useState("");
  if (document === null) return <div className="memory-settings-loading">Loading Long-term Memory...</div>;
  const currentEntries = document.entries.filter((entry) => entry.status === "current");
  const preparePatch = () => {
    const proposed = {
      ...(entryId.trim() ? { id: entryId.trim() } : {}), title: title.trim(), date: new Date().toISOString().slice(0, 10),
      tags: commaValues(tags), applicability: commaValues(applicability), maturity, recallPolicy, limitations: limitations.trim(), content: content.trim(), sourceReferenceIds: []
    };
    void invoke(createCommand({ command: "long_term_memory.patch.prepare", payload: {
      action, targetEntryIds: action === "add" ? [] : targetEntryIds, proposed, rationale: rationale.trim(),
      ...((action === "narrow" || action === "revise") ? { resolutionSignal: { type: resolutionType, referenceId: resolutionReference.trim() } } : {})
    } }));
  };
  const selectTargets = (event: React.ChangeEvent<HTMLSelectElement>) => setTargetEntryIds([...event.target.selectedOptions].map((option) => option.value));
  return <div className="long-term-memory-settings">
    <div className="memory-settings-heading"><div><span className="eyebrow">Personal cognition</span><h2>Long-term Memory</h2><p title={document.rootPath}>{document.rootPath}</p></div><div><button className="icon-button" type="button" title="Open memory folder" aria-label="Open memory folder" onClick={openFolder}><FolderOpen size={16} /></button><button className="icon-button" type="button" title="Refresh and re-index" aria-label="Refresh and re-index" onClick={onRefresh}><RefreshCw size={16} /></button></div></div>
    <div className="memory-summary"><span><strong>{currentEntries.length}</strong> current entries</span><span><strong>{currentEntries.filter((entry) => entry.recallPolicy === "explicit-only").length}</strong> explicit only</span><span><strong>{currentEntries.filter((entry) => entry.conflictState.startsWith("unresolved:")).length}</strong> unresolved views</span><span>Updated {new Date(document.updatedAt).toLocaleString()}</span></div>
    <div className="memory-file-list">{document.files.map((file) => <div key={file.kind}><div><strong>{file.name}</strong><span>{formatBytes(file.size)}</span></div><time dateTime={file.updatedAt}>{new Date(file.updatedAt).toLocaleString()}</time></div>)}</div>
    {document.warnings.length > 0 && <div className="context-warnings" role="status">{document.warnings.map((warning, index) => <span key={`${warning.code}-${index}`}>{warning.line ? `Line ${warning.line}: ` : ""}{warning.message}</span>)}</div>}
    <label className="memory-editor">Active memory<textarea aria-label="Long-term Memory" value={draft} onChange={(event) => onChange(event.target.value)} spellCheck="false" /></label>
    <div className="memory-editor-actions"><span>{document.sourceHash.slice(0, 12)}</span><button className="primary-button" type="button" onClick={onSave}>Save Memory</button></div>
    <section className="memory-evolution-section">
      <div className="settings-section-header"><div><h2>Memory Evolution</h2><p>Reviewed changes preserve lineage across all cognition files.</p></div><button className="compact-button" type="button" onClick={() => setProposalOpen((open) => !open)}>{proposalOpen ? "Close" : "Prepare patch"}</button></div>
      {proposalOpen && <div className="memory-evolution-form">
        <label>Action<select aria-label="Memory Evolution action" value={action} onChange={(event) => { setAction(event.target.value as PreparedMemoryPatch["action"]); setTargetEntryIds([]); }}><option value="add">Add</option><option value="reinforce">Reinforce</option><option value="narrow">Narrow</option><option value="revise">Revise</option><option value="contradict">Contradict</option><option value="merge_condense">Merge / Condense</option></select></label>
        {action !== "add" && <label>Current entries<select aria-label="Memory Evolution targets" multiple={action === "merge_condense"} value={targetEntryIds} onChange={selectTargets}>{currentEntries.map((entry) => <option key={entry.id} value={entry.id}>{entry.title} · v{entry.version}</option>)}</select></label>}
        <label>Entry ID<input value={entryId} onChange={(event) => setEntryId(event.target.value)} placeholder="Optional stable opaque id" /></label>
        <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Tags<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="memo, diligence" /></label>
        <label>Applies to<input value={applicability} onChange={(event) => setApplicability(event.target.value)} /></label>
        <div className="memory-evolution-row"><label>Maturity<select value={maturity} onChange={(event) => setMaturity(event.target.value as typeof maturity)}><option value="user-confirmed">User confirmed</option><option value="evidence-backed">Evidence backed</option><option value="retrospectively-supported">Retrospectively supported</option></select></label><label>Recall<select value={recallPolicy} onChange={(event) => setRecallPolicy(event.target.value as typeof recallPolicy)}><option value="automatic">Automatic</option><option value="explicit-only">Explicit only</option></select></label></div>
        <label>Limitations<textarea value={limitations} onChange={(event) => setLimitations(event.target.value)} /></label>
        <label>Learning<textarea aria-label="Proposed learning" value={content} onChange={(event) => setContent(event.target.value)} /></label>
        <label>Rationale<textarea aria-label="Memory Evolution rationale" value={rationale} onChange={(event) => setRationale(event.target.value)} /></label>
        {(action === "narrow" || action === "revise") && <div className="memory-evolution-row"><label>Resolution signal<select value={resolutionType} onChange={(event) => setResolutionType(event.target.value as typeof resolutionType)}><option value="approved_reflection">Approved Reflection</option><option value="approved_retrospective">Approved Retrospective</option><option value="user_correction">User correction</option></select></label><label>Reference<input aria-label="Resolution reference" value={resolutionReference} onChange={(event) => setResolutionReference(event.target.value)} /></label></div>}
        <button className="primary-button" type="button" disabled={!title.trim() || !content.trim() || !rationale.trim() || (action !== "add" && targetEntryIds.length === 0) || (action === "merge_condense" && targetEntryIds.length < 2) || ((action === "narrow" || action === "revise") && !resolutionReference.trim())} onClick={preparePatch}>Preview final patch</button>
      </div>}
      {patch && <div className="memory-patch-preview" role="dialog" aria-label="Memory patch preview"><div><strong>{patch.action.replace("_", " / ")}</strong><span>{patch.id} · {new Date(patch.createdAt).toLocaleString()}</span></div><p>{patch.rationale}</p><pre>{patch.lineageDiff}</pre>{patch.files.map((file) => <details key={file.kind} open={file.changed}><summary>{file.kind.replaceAll("_", " ")} · {file.changed ? "changed" : "unchanged"}</summary><span title={file.path}>{file.path}</span><pre>{file.diff}</pre></details>)}<div className="form-actions"><button type="button" onClick={() => void invoke(createCommand({ command: "long_term_memory.patch.discard", payload: { patchId: patch.id } }))}>Discard</button><button className="primary-button" type="button" onClick={() => void invoke(createCommand({ command: "long_term_memory.patch.commit", payload: { patchId: patch.id, confirmed: true } }))}>Confirm Memory change</button></div></div>}
    </section>
    {maintenance && <section className="memory-maintenance-section"><div className="settings-section-header"><div><h2>Condensation Archive</h2><p>Cognitive Evolution History is permanent and excluded from this policy.</p></div><span>{maintenance.archiveItems.length} items</span></div><div className="memory-maintenance-controls"><label>Retention<select value={maintenance.retention} onChange={(event) => void invoke(createCommand({ command: "long_term_memory.maintenance.save", payload: { retention: event.target.value === "permanent" ? "permanent" : Number(event.target.value) as 30 | 90 | 180 | 365, automaticDeletion: maintenance.automaticDeletion } }))}><option value={30}>30 days</option><option value={90}>90 days</option><option value={180}>180 days</option><option value={365}>365 days</option><option value="permanent">Permanent</option></select></label><label className="checkbox-setting"><input type="checkbox" checked={maintenance.automaticDeletion} onChange={(event) => void invoke(createCommand({ command: "long_term_memory.maintenance.save", payload: { retention: maintenance.retention, automaticDeletion: event.target.checked } }))} /> Automatic cleanup</label></div>{maintenance.archiveItems.map((item) => <div className="archive-row" key={item.archiveId}><div><strong>{item.replacement || item.archiveId}</strong><span>{item.reason} · {item.eligibleForCleanup ? "Eligible for cleanup" : item.kept ? "Kept" : item.expiresAt ? `Expires ${new Date(item.expiresAt).toLocaleDateString()}` : "Permanent"}</span></div><div>{!item.kept && <button type="button" onClick={() => void invoke(createCommand({ command: "long_term_memory.archive.update", payload: { archiveId: item.archiveId, action: "keep" } }))}>Keep</button>}<button type="button" onClick={() => void invoke(createCommand({ command: "long_term_memory.archive.update", payload: { archiveId: item.archiveId, action: "refresh" } }))}>Re-archive</button>{item.eligibleForCleanup && <button type="button" onClick={() => void invoke(createCommand({ command: "long_term_memory.archive.cleanup", payload: { archiveIds: [item.archiveId] } }))}>Delete</button>}</div></div>)}</section>}
  </div>;
}

function PromptSettings({ revisions, activeRevisionId, invoke }: {
  revisions: SystemPromptRevision[];
  activeRevisionId: string | null;
  invoke(command: HostCommand): Promise<unknown>;
}) {
  const active = revisions.find((revision) => revision.id === activeRevisionId);
  const [content, setContent] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => setContent(active?.content ?? ""), [active?.id]);
  const save = () => {
    void invoke(createCommand({ command: "prompt.revision.create", payload: { content, ...(note.trim() ? { changeNote: note.trim() } : {}) } }));
    setNote("");
  };
  return <div className="settings-section prompt-settings">
    <div className="settings-section-header"><div><h2>Minimal VC System Prompt</h2><p>Edits apply at the next Prompt Load Boundary.</p></div><span className="revision-id">{active?.id.slice(0, 8) ?? "Loading"}</span></div>
    <label>Prompt<textarea aria-label="Minimal VC System Prompt" value={content} onChange={(event) => setContent(event.target.value)} /></label>
    <label>Change note<input aria-label="System Prompt change note" value={note} onChange={(event) => setNote(event.target.value)} /></label>
    <div className="form-actions"><button type="button" onClick={() => void invoke(createCommand({ command: "prompt.restore_default", payload: { changeNote: "Restore shipped default" } }))}>Restore default</button><button className="primary-button" type="button" onClick={save}>Save revision</button></div>
    <div className="prompt-history">{revisions.map((revision) => <details key={revision.id}>
      <summary><span>{revision.id.slice(0, 8)} · {revision.source}</span><span>{revision.id === activeRevisionId ? "Active" : new Date(revision.createdAt).toLocaleString()}</span></summary>
      {revision.changeNote && <p>{revision.changeNote}</p>}<pre>{revision.diff}</pre>
      {revision.id !== activeRevisionId && <button type="button" onClick={() => void invoke(createCommand({ command: "prompt.revision.activate", payload: { revisionId: revision.id } }))}>Activate</button>}
    </details>)}</div>
  </div>;
}

function MessageItem({ item, configure, chooseOutput, retry, continueInterrupted }: { item: ConversationItem; configure(): void; chooseOutput(): void; retry(text: string, turnId: string): void; continueInterrupted(): void }) {
  if (item.role === "user") return <article className="message user-message"><div>{item.text}</div></article>;
  if (item.role === "system") return <div className="system-event">{item.text}</div>;
  if (item.role === "tool") return <div className={`tool-activity ${item.status}`}><div><strong>{item.capabilityId}</strong><span>{item.status.replace("_", " ")}</span></div>{item.capabilityId === "web_search" || item.capabilityId === "web_fetch" ? <WebSourceResult text={item.text} /> : <p>{item.text}</p>}{item.artifact && <a href={`#artifact-${item.artifact.id}`} title={item.artifact.destination}>{item.artifact.mediaType} · {item.artifact.destination}</a>}</div>;
  return <article className={`message assistant-message ${item.status}`}>
    <div className="message-meta"><span>vc-agent</span>{item.profile && <span>{item.profile.provider} / {item.profile.model}</span>}</div>
    {item.text && <div className="message-content">{item.text}</div>}
    {(item.status === "queued" || item.status === "streaming") && !item.text && <div className="streaming-label">Working</div>}
    {item.failure && <div className="provider-failure" role="alert"><strong>{item.failure.message}</strong><span>{item.failure.code}{item.failure.provider ? ` · ${item.failure.provider} / ${item.failure.model}` : ""}</span><div>{item.failure.code === "OUTPUT_LOCATION_NOT_CONFIGURED" && <button type="button" onClick={chooseOutput}>Choose output location</button>}<button type="button" onClick={() => item.retryText && retry(item.retryText, item.turnId)} disabled={!item.retryText}>Retry</button>{item.failure.code !== "OUTPUT_LOCATION_NOT_CONFIGURED" && <button type="button" onClick={configure}>Adjust profile</button>}</div></div>}
    {item.status === "interrupted" && <div className="interrupted-state"><strong>Interrupted</strong><span>The previous request will not resume automatically.</span><button type="button" onClick={continueInterrupted}>Continue</button></div>}
    {item.usage && <div className="usage-row">Completed · {item.usage.input} input · {item.usage.output} output tokens{item.prompt ? ` · prompt ${item.prompt.revisionId.slice(0, 8)} (${item.prompt.contributions.promptEstimatedTokens} prompt + ${item.prompt.contributions.toolSchemaEstimatedTokens} tools + ${item.prompt.contributions.contextEstimatedTokens} retained + ${item.prompt.contributions.outputReserveEstimatedTokens} reserve est.)` : ""}{item.recalledStateEstimatedTokens === undefined ? "" : ` · recall ${item.recalledStateEstimatedTokens} est.`}{item.latencyMs === undefined ? "" : ` · ${item.latencyMs} ms`}</div>}
  </article>;
}

function WebSourceResult({ text }: { text: string }) {
  const result = parseWebSourceResult(text);
  if (result === null) return <p>{text}</p>;
  return <div className="web-source-result">
    {result.sources.map((source, index) => <div className="web-source" key={`${source.url}:${index}`}>
      <strong>{source.title || source.url}</strong>
      <span className="web-source-url">{source.url}</span>
      {source.accessedAt && <span>Accessed {new Date(source.accessedAt).toLocaleString()}</span>}
      {source.content && <p>{source.content}</p>}
    </div>)}
    {result.warnings.map((warning, index) => <p className="web-warning" key={`${warning}:${index}`}>{warning}</p>)}
  </div>;
}

function parseWebSourceResult(text: string): { sources: Array<{ url: string; title: string; accessedAt: string; content: string }>; warnings: string[] } | null {
  try {
    const parsed = JSON.parse(text) as {
      items?: Array<{ url?: unknown; title?: unknown; accessedAt?: unknown; content?: unknown }>;
      citations?: Array<{ url?: unknown; title?: unknown; accessedAt?: unknown }>;
      warnings?: unknown[];
    };
    const rawSources = parsed.items ?? parsed.citations ?? [];
    const sources = rawSources.flatMap((source) => typeof source.url !== "string" ? [] : [{
      url: source.url,
      title: typeof source.title === "string" ? source.title : "",
      accessedAt: typeof source.accessedAt === "string" ? source.accessedAt : "",
      content: "content" in source && typeof source.content === "string" ? source.content : ""
    }]);
    const warnings = (parsed.warnings ?? []).filter((warning): warning is string => typeof warning === "string");
    return { sources, warnings };
  } catch { return null; }
}

function projectTrajectory(
  turns: Extract<HostEvent, { event: "thread.trajectory.loaded" }>["payload"]["turns"],
  activities: Extract<HostEvent, { event: "thread.trajectory.loaded" }>["payload"]["activities"]
): ConversationItem[] {
  const messages = turns.flatMap((turn) => {
    const assistant: Extract<ConversationItem, { role: "assistant" }> = {
      id: `${turn.turnId}:assistant`,
      turnId: turn.turnId,
      role: "assistant",
      text: turn.assistantText,
      status: turn.status === "active" || turn.status === "submitted" ? "interrupted" : turn.status,
      ...(turn.profile === undefined ? {} : { profile: turn.profile }),
      ...(turn.usage === undefined ? {} : { usage: turn.usage }),
      ...(turn.latencyMs === undefined ? {} : { latencyMs: turn.latencyMs }),
      ...(turn.recalledStateEstimatedTokens === undefined ? {} : { recalledStateEstimatedTokens: turn.recalledStateEstimatedTokens }),
      ...(turn.prompt === undefined ? {} : { prompt: { revisionId: turn.prompt.revisionId, contributions: turn.prompt.contributions } }),
      ...(turn.failure === undefined ? {} : { failure: turn.failure, retryText: turn.text })
    };
    return [
      { order: turn.submittedSequence, item: { id: `${turn.turnId}:user`, turnId: turn.turnId, role: "user" as const, text: turn.text } },
      { order: turn.lastSequence, item: assistant }
    ];
  });
  const projectedActivities = activities.map((activity) => {
    const item: ConversationItem = activity.kind === "context"
      ? { id: activity.id, turnId: activity.turnId, role: "system", text: `${activity.label}. ${activity.content}` }
      : {
          id: activity.id,
          turnId: activity.turnId,
          role: "tool",
          requestId: activity.id,
          capabilityId: activity.label,
          status: activity.status,
          text: activity.content,
          ...(activity.artifact === undefined ? {} : { artifact: activity.artifact })
        };
    return { order: activity.sequence, item };
  });
  return [...messages, ...projectedActivities].sort((a, b) => a.order - b.order).map(({ item }) => item);
}

function appendSystemEvent(current: Record<string, ConversationItem[]>, threadId: string, turnId: string, text: string) {
  const item: ConversationItem = { id: `${turnId}:context-rebuilt`, turnId, role: "system", text };
  return { ...current, [threadId]: [...(current[threadId] ?? []), item] };
}

function updateToolActivity(current: Record<string, ConversationItem[]>, payload: Extract<HostEvent, { event: "capability.execution.updated" }>["payload"]) {
  const items = current[payload.threadId] ?? [];
  const tool: Extract<ConversationItem, { role: "tool" }> = {
    id: `capability:${payload.requestId}`,
    turnId: payload.turnId,
    role: "tool",
    requestId: payload.requestId,
    capabilityId: payload.capabilityId,
    status: payload.status,
    text: payload.content,
    ...(payload.artifact === undefined ? {} : { artifact: payload.artifact })
  };
  const exists = items.some((item) => item.id === tool.id);
  return { ...current, [payload.threadId]: exists ? items.map((item) => item.id === tool.id ? tool : item) : [...items, tool] };
}

function appendTurn(current: Record<string, ConversationItem[]>, threadId: string, turnId: string, text: string, profile: ModelProfile, prompt: { revisionId: string; contributions: PromptContribution }) {
  return { ...current, [threadId]: [...(current[threadId] ?? []), { id: `${turnId}:user`, turnId, role: "user", text }, { id: `${turnId}:assistant`, turnId, role: "assistant", text: "", status: "queued", profile, retryText: text, prompt }] } satisfies Record<string, ConversationItem[]>;
}

function updateAssistant(current: Record<string, ConversationItem[]>, threadId: string, turnId: string, update: (item: Extract<ConversationItem, { role: "assistant" }>) => Extract<ConversationItem, { role: "assistant" }>) {
  return { ...current, [threadId]: (current[threadId] ?? []).map((item) => item.role === "assistant" && item.turnId === turnId ? update(item) : item) };
}

function failTurn(current: Record<string, ConversationItem[]>, payload: Extract<HostEvent, { event: "turn.failed" }>["payload"]) {
  const existing = (current[payload.threadId] ?? []).some((item) => item.turnId === payload.turnId);
  if (!existing) {
    return { ...current, [payload.threadId]: [...(current[payload.threadId] ?? []), { id: `${payload.turnId}:user`, turnId: payload.turnId, role: "user", text: payload.text }, { id: `${payload.turnId}:assistant`, turnId: payload.turnId, role: "assistant", text: "", status: "failed", failure: payload.failure, ...(payload.profile === undefined ? {} : { profile: payload.profile }), retryText: payload.text }] } satisfies Record<string, ConversationItem[]>;
  }
  return updateAssistant(current, payload.threadId, payload.turnId, (item) => ({ ...item, status: "failed", failure: payload.failure, retryText: payload.text }));
}

function localDiagnostic(message: string): Extract<HostEvent, { event: "diagnostic.raised" }> {
  return { schemaVersion: 1, eventId: crypto.randomUUID(), correlationId: crypto.randomUUID(), sequence: 0, actor: { actorType: "host", actorId: "renderer-validation" }, provenance: { producerType: "host", producerId: "renderer-validation" }, occurredAt: new Date().toISOString(), event: "diagnostic.raised", payload: { code: "INVALID_COMMAND", message, recoverable: true } };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function commaValues(value: string): string[] {
  return value.split(/[,，]/u).map((item) => item.trim()).filter(Boolean);
}

function doctorLabel(name: string): string {
  return ({ pi: "Pi SDK", provider: "Provider", parser: "Parsers", credentialReference: "Credentials", storage: "Storage", migration: "Migration", bundledExtensions: "Bundled Extensions", scheduler: "Scheduler", agentRuntime: "Agent runtime", utilityRuntime: "Utility runtime", isolatedRuntime: "Isolated jobs", skills: "Skills", office: "Office Skills", ocr: "Page recovery", mcp: "Connected tools", extensionRevision: "Extension revision", backup: "Backup" } as Record<string, string>)[name] ?? name;
}
